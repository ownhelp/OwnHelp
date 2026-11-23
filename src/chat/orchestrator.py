"""Retrieval and validated generation for one visitor message.

``ChatOrchestrator.stream`` is a generator of plain event dicts consumed by the Node gateway
(see ``src/chat/server.py``). It reuses ``RAGRetriever`` (tenant pre-filtered ``$vectorSearch``)
and the Ollama client from ``SupportInferenceClient``. Answer text streams as the model writes it,
except the last ``GuardedAnswerStream.HOLD_BACK`` characters, which wait until schema validation and
the live product-capability safeguard complete (streamed text cannot be retracted).

Event sequence for a successful reply::

    {"type": "sources", "sources": [{"doc_id", "section", "score"}, ...]}
    {"type": "progress"}                       (content-free cancellation heartbeat)
    {"type": "token", "text": "..."}            (repeated; the last one follows validation)
    {"type": "done", "action": "answer" | "escalate", "confidence": 0.9, "cited_sources": [...]}

``action``, ``confidence`` and ``cited_sources`` are consumed by the gateway to open a human-review
ticket on escalation; they are never shown to the visitor.

A failure is reported as ``{"type": "error", "code": ..., "message": ...}`` and ends the stream.

One turn, in order: (1) retrieve tenant-scoped chunks and drop those below the tenant's
``similarity_threshold``; (2) assemble the prompt: policy + tenant tone as the system message, then
the question, recent history, retrieved context and verified business contact as the user message;
(3) generate with Ollama under the ``SupportResponse`` JSON schema, streaming the ``answer`` field
through ``GuardedAnswerStream``; (4) validate the full JSON and run the handoff-promise safeguard,
which rewrites unsupported "someone will contact you" answers into an escalation (appended after any
harmless text already shown); (5) emit the held-back tail and the internal action. Escalation itself (opening a
ticket) is done by the gateway from the ``done`` event, not here.
Callers: ``src/chat/server.py`` (``orchestrator.stream``). Inputs: ``ChatServiceRequest``.
"""

import json
import logging
import threading
import time
from typing import Iterator, Literal

from pydantic import BaseModel, Field, ValidationError

from src.chat.answer_stream import GuardedAnswerStream
from src.inference.client import SupportInferenceClient
from src.inference.schema import SupportResponse
from src.inference.policy import build_policy_prompt, requires_handoff_safeguard, SAFE_FOLLOWUP_ANSWER

logger = logging.getLogger(__name__)

MAX_HISTORY_TURNS = 12


class AgentConfig(BaseModel):
    """Per-tenant runtime configuration (businesses.agent_config)."""

    system_prompt: str = Field(default="", max_length=4000)
    # Optional replacement for the default core policy; blank uses the shipped default.
    core_policy: str = Field(default="", max_length=8000)
    agent_tone: str = Field(default="", max_length=200)
    temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    max_context_chunks: int = Field(default=4, ge=1, le=8)
    similarity_threshold: float = Field(default=0.70, ge=0.0, le=1.0)


class ChatTurn(BaseModel):
    """One earlier message in the visitor conversation (history is capped at MAX_HISTORY_TURNS)."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class BusinessContact(BaseModel):
    """Public contact data supplied by the trusted gateway, never the visitor."""

    email: str = Field(default="", max_length=254, pattern=r"^[^\r\n]*$")
    phone: str = Field(default="", max_length=80, pattern=r"^[^\r\n]*$")


class ChatServiceRequest(BaseModel):
    """Body of POST /v1/chat. The gateway checks tenant_id against its businesses collection and
    fills agent_config and business_contact from that record; the strict tenant_id pattern also
    rejects odd characters before they reach a query."""

    tenant_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    query: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=MAX_HISTORY_TURNS)
    agent_config: AgentConfig = Field(default_factory=AgentConfig)
    business_contact: BusinessContact = Field(default_factory=BusinessContact)


def build_system_prompt(config: AgentConfig) -> str:
    """Tenant instructions extend the core policy; a tenant may also replace the core itself."""
    return build_policy_prompt(config.system_prompt, config.agent_tone, config.core_policy)


class ChatOrchestrator:
    """Runs one visitor turn: retrieve, build the prompt, generate, validate and emit events."""

    def __init__(self, retriever, client: SupportInferenceClient):
        # Locks serialize use of the shared embedding model and the single local model server;
        # the HTTP server is threaded, so concurrent visitors would otherwise interleave on them.
        self.retriever = retriever
        self.client = client
        self._retriever_lock = threading.Lock()
        self._model_lock = threading.Lock()

    def _retrieve(self, request: ChatServiceRequest):
        """Returns this tenant's chunks that clear the similarity threshold (possibly none).

        Follow-up questions such as "what about returns?" embed poorly alone, so the last two user
        questions are prepended to the retrieval query only (not to the prompt).
        """
        config = request.agent_config
        previous_queries = [turn.content for turn in request.history if turn.role == "user"][-2:]
        retrieval_query = request.query
        if previous_queries:
            retrieval_query = (
                "Previous customer questions:\n" + "\n".join(previous_queries)
                + "\nCurrent question:\n" + request.query
            )
        with self._retriever_lock:
            chunks = self.retriever.retrieve(
                query=retrieval_query, tenant_id=request.tenant_id, top_k=config.max_context_chunks
            )
        # Fail closed: a chunk from any other tenant means retrieval is not trustworthy.
        if any(chunk.get("tenant_id") != request.tenant_id for chunk in chunks):
            raise RuntimeError("Cross-tenant retrieval was rejected.")
        return [
            chunk for chunk in chunks
            if isinstance(chunk.get("score"), (int, float)) and chunk["score"] >= config.similarity_threshold
        ]

    def stream(self, request: ChatServiceRequest) -> Iterator[dict]:
        """Yields the event dicts described in the module docstring for one visitor message."""
        config = request.agent_config
        try:
            chunks = self._retrieve(request)
            context = self.retriever.format_context(chunks)
        except Exception as exc:
            # Driver exception text can contain connection details; keep it out of responses.
            logger.error("Retrieval failed (%s)", type(exc).__name__)
            yield {"type": "error", "code": "retrieval_failed", "message": "Retrieval failed."}
            return

        yield {
            "type": "sources",
            "sources": [
                {"doc_id": chunk.get("doc_id", "unknown"), "section": chunk.get("section", ""), "score": chunk["score"]}
                for chunk in chunks
            ],
        }

        history = [turn.model_dump() for turn in request.history]
        contact = request.business_contact
        contact_text = ""
        if contact.email or contact.phone:
            # Gateway metadata is distinct from retrieved documents and conversation history.
            contact_text = "\n\nVerified business contact information:\n" + json.dumps(
                contact.model_dump(exclude_defaults=True), ensure_ascii=False, indent=4
            )
        messages = [
            {"role": "system", "content": build_system_prompt(config)},
            {"role": "user", "content": self.client.build_user_prompt(request.query, context, history) + contact_text},
        ]
        raw = []
        guard = GuardedAnswerStream(requires_handoff_safeguard)
        stream = None
        last_progress = 0.0
        try:
            with self._model_lock:
                stream = self.client.client.chat(
                    model=self.client.model,
                    messages=messages,
                    format=SupportResponse.model_json_schema(),
                    options={"temperature": config.temperature},
                    stream=True,
                )
                for part in stream:
                    piece = part.message.content or ""
                    if not piece:
                        continue
                    raw.append(piece)
                    released = guard.feed(piece)
                    now = time.monotonic()
                    if released:
                        yield {"type": "token", "text": released}
                        last_progress = now
                    elif now - last_progress >= 0.5:
                        # No answer text yet: writes let the HTTP server detect an aborted visitor
                        # and close this generator/Ollama stream while the model is still working.
                        yield {"type": "progress"}
                        last_progress = now
            response = SupportResponse.model_validate_json("".join(raw))
            raw_action = response.action
            reason = "none"
            # Everything but the guard's held-back tail may already be on the visitor's screen and
            # cannot be retracted; the tail is sent (or replaced) only after this authoritative check.
            if requires_handoff_safeguard(response.answer):
                reason = "unsupported_handoff_promise"
                response = SupportResponse(
                    answer=SAFE_FOLLOWUP_ANSWER, action="escalate", confidence=0.0, cited_sources=[]
                )
                # Text already shown is harmless by construction (it precedes any matched promise);
                # the safe answer follows it as a new paragraph.
                remaining = ("\n\n" if guard.released_text else "") + SAFE_FOLLOWUP_ANSWER
            else:
                remaining = guard.remainder(response.answer)
            log_result = logger.warning if reason != "none" else logger.info
            log_result("Support response raw_action=%s effective_action=%s safeguard=%s",
                       raw_action, response.action, reason)
            if remaining:
                yield {"type": "token", "text": remaining}
            # action / confidence / cited_sources are for the gateway only (human escalation review);
            # the gateway never forwards them to the visitor.
            yield {
                "type": "done",
                "action": response.action,
                "confidence": response.confidence,
                "cited_sources": response.cited_sources,
            }
        except GeneratorExit:
            raise
        except (ValidationError, ValueError) as exc:
            logger.error("Model returned an invalid response (%s)", type(exc).__name__)
            yield {"type": "error", "code": "generation_failed", "message": "The assistant ran into a problem."}
        except Exception as exc:
            logger.error("Generation failed (%s)", type(exc).__name__)
            # A model server that cannot be reached is reported separately so operators (and the
            # gateway's log) can tell "Ollama is down" from "the model produced bad output".
            code = "model_unavailable" if isinstance(exc, ConnectionError) or "Connect" in type(exc).__name__ else "generation_failed"
            yield {"type": "error", "code": code, "message": "The assistant ran into a problem."}
        finally:
            # Closing the Ollama stream disconnects from the server, which stops generation.
            close = getattr(stream, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
