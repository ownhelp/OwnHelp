"""Structured-output contract for model replies.

``SupportResponse.model_json_schema()`` is passed to Ollama as ``format=`` so decoding is
constrained to valid JSON of this shape; the same class then validates the result. Used by
``src/inference/client.py`` and ``src/chat/orchestrator.py``. ``cited_sources``, ``confidence`` and
``action`` are internal signals for escalation review and are never shown to visitors.
"""

from typing import List, Literal
from pydantic import BaseModel, Field

class SupportResponse(BaseModel):
    """One model reply: visitor-facing ``answer`` plus internal routing fields."""

    answer: str = Field(description="Direct, grounded answer to the customer inquiry")
    cited_sources: List[str] = Field(default_factory=list, description="List of source file names cited")
    confidence: float = Field(ge=0.0, le=1.0, description="Confidence score between 0.0 and 1.0")
    action: Literal["answer", "escalate"] = Field(description="Action decision: answer or escalate")
