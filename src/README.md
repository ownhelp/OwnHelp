# src/ - shared Python library

Reusable logic for retrieval, ingestion, chat orchestration, local inference and deployment setup. Command-line runners live in [`../scripts/`](../scripts/README.md) and only import from here. The Node gateway, dashboard and widget are separate packages that call into this code over HTTP or by spawning the ingestion scripts.

## Package map

| Package | Purpose | Key modules |
| --- | --- | --- |
| `rag/` | Chunk and embed documents, manage the Atlas vector index, retrieve tenant-scoped context. | `ingestor.py` (writes `doc_vectors`), `retriever.py` (`$vectorSearch`), `vector_index.py` (index definition and readiness), `table_parser.py` (table linearization), `db_config.py` (training database name) |
| `chat/` | Internal HTTP service and the logic for one visitor turn. | `server.py` (`POST /v1/chat`, `GET /health`), `orchestrator.py` (retrieve, prompt, generate, validate), `answer_stream.py` (incremental JSON answer extractor, currently exercised only by tests) |
| `inference/` | Talk to Ollama and define what a model reply must look like. | `client.py` (Ollama chat calls), `schema.py` (`SupportResponse`), `policy.py` and `system_policy.json` (core system prompt, handoff safeguard), `serving_metadata.py` (model digest and settings capture) |
| `documents/` | Structured, lossless parsing of `.md`, `.txt` and `.json` sources into whole blocks with locators. | `parser.py`, `integration.py` (chunks with provenance fields) |
| `deployment/` | Create the private env file for the Docker Compose stack. | `config.py` (used by `scripts/setup_stack.py`) |
| `demo_setup/` | Seed an isolated local MongoDB with preset demo tenants, tickets and vectors. | `seeder.py` (target allow-list, idempotent seeding, index readiness) |

## Data flow for one chat turn

```text
widget  --POST /api/chat-->  gateway (Node)  --POST /v1/chat-->  chat/server.py
                                                                      |
                                                       chat/orchestrator.py
                                                                      |
   1. rag/retriever.py: embed query, $vectorSearch filtered by tenant_id  --> MongoDB doc_vectors
   2. drop chunks below the tenant's similarity_threshold
   3. inference/client.py + policy.py: build system prompt and user prompt
   4. Ollama generates JSON constrained to inference/schema.py (SupportResponse)
   5. validate JSON, run the handoff safeguard, emit events
                                                                      |
   NDJSON events: sources, progress, token (the whole answer), done (action, confidence, cited_sources)
                                                                      |
gateway converts events to SSE or JSON for the widget, opens a human-review ticket when action is "escalate"
```

Only the `answer` text reaches the visitor. `action`, `confidence` and `cited_sources` are internal and the gateway does not forward them. The answer is buffered until validation completes, so a single `token` event carries the whole reply rather than word-by-word tokens.

## Where tenant filtering is enforced

Tenant isolation happens at several layers, so a failure in one does not leak data:

1. **Gateway**: validates `tenant_id` (plain string, known business) before calling this service and loads that tenant's `agent_config`.
2. **Request model** (`chat/orchestrator.py`, `ChatServiceRequest`): `tenant_id` must match `^[a-z0-9][a-z0-9_-]*$`.
3. **Query** (`rag/retriever.py`, `RAGRetriever.retrieve`): `$vectorSearch` has `filter: {"tenant_id": {"$eq": tenant_id}}`, a pre-filter, so other tenants' vectors are never scored. This requires `tenant_id` to be a filter field in the index (`rag/vector_index.py`). An empty `tenant_id` raises `ValueError`.
4. **Post-check** (`retriever.py`): results whose `tenant_id` differs are dropped before reranking.
5. **Fail closed** (`chat/orchestrator.py`, `_retrieve`): any chunk from another tenant aborts the turn with a `retrieval_failed` error.
6. **Ingestion** (`rag/ingestor.py`): every chunk is stored with its `tenant_id`, and re-ingestion deletes only that tenant's chunks.

## Configuration

All settings come from the environment or the repository `.env` (never committed): `MONGODB_URI`, `MONGODB_DB_NAME` (live database, default `rag_knowledge_base`), `MONGODB_TRAINING_DB_NAME` (development, training and evaluation only), `MONGODB_COLLECTION_NAME`, `MONGODB_VECTOR_INDEX_NAME`, `EMBEDDING_MODEL_NAME`, `HF_TOKEN`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `CHAT_BACKEND_TOKEN`. See the [repository README](../README.md) for the full setup.

## Ingestion writes

`RAGDocumentIngestor.replace_chunks(scope, documents)` swaps the stored chunks for a tenant (or a tenant and `doc_id`). It inserts the new chunks with pre-generated `_id` values, then deletes the old ones with `_id: {"$nin": new_ids}`. A failed insert never leaves the scope empty. For one round trip old and new chunks coexist, which is acceptable because the duplicated text is equivalent. `ingest_tenant_directory(tenant_id, tenant_dir, progress_callback=None)` calls the callback with `"parsing"`, `"embedding"` and `"writing"` as each stage begins; the upload script turns these into the real progress the dashboard shows.

## Known gaps

- Streaming limits: replies stream token by token. `chat/orchestrator.py` feeds model chunks through `GuardedAnswerStream` (`chat/answer_stream.py`), which sends the `answer` text as it is generated but holds back the last 100 characters until the full JSON is validated and the handoff safeguard has run on the whole answer. Answers shorter than that arrive in one burst. If the model server dies or the JSON turns out invalid mid-reply, the visitor may already have seen the earlier part of the answer, followed by an error event. If a handoff promise is caught, any text already shown stays and `SAFE_FOLLOWUP_ANSWER` follows it as a new paragraph. The hold-back assumes a promise phrase (about 60 characters at most) is shorter than 100 characters with no huge whitespace runs inside it; the final check on the complete answer still decides `action`.

## Tests

See [`../tests/README.md`](../tests/README.md).
