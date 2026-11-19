"""Inference package: Ollama client, structured-output schema, support policy and serving metadata."""

from src.inference.client import SupportInferenceClient, GenerationResult
from src.inference.schema import SupportResponse

__all__ = [
    "SupportInferenceClient",
    "GenerationResult",
    "SupportResponse",
]
