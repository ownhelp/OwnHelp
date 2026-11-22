"""Re-embeds one edited chunk and stores its text and vector in a single atomic update.

Purpose: manual chunk editing in the dashboard. The gateway cannot embed (the model lives on the
Python side), so it hands the edit to scripts/reembed_chunk.py, which calls reembed_chunk() with the
same model the ingestor loads (BAAI/bge-small-en-v1.5 by default), so edited chunks stay comparable
with every other vector in the index.

Safety: the text and embedding are written by ONE update_one, so they cannot diverge. The embedding is
computed first; if it fails (or the text exceeds the model's token limit, which would silently
truncate the vector's input) nothing is written. The chunk is addressed by
(tenant_id, doc_id, chunk_index) and the tenant filter is part of the update, so another tenant's
chunk can never be touched. No field is added to the doc_vectors schema: only ``text`` and
``embedding`` are replaced.
"""

from __future__ import annotations

from typing import Any

# Upper bound on an edited chunk, in characters. Mirrored by the gateway route.
MAX_CHUNK_CHARS = 8000


class ChunkEditError(Exception):
    """A chunk edit was rejected. ``code`` is VALIDATION_ERROR or NOT_FOUND."""

    def __init__(self, message: str, code: str = "VALIDATION_ERROR"):
        super().__init__(message)
        self.code = code


def validate_chunk_text(text: Any) -> str:
    """Returns the text stripped of surrounding whitespace, or raises ChunkEditError."""
    if not isinstance(text, str):
        raise ChunkEditError("Chunk text must be a string.")
    cleaned = text.strip()
    if not cleaned:
        raise ChunkEditError("Chunk text must not be empty.")
    if len(cleaned) > MAX_CHUNK_CHARS:
        raise ChunkEditError(f"Chunk text must be at most {MAX_CHUNK_CHARS} characters.")
    return cleaned


def _check_token_limit(model: Any, text: str) -> None:
    tokenizer = getattr(model, "tokenizer", None)
    limit = getattr(model, "max_seq_length", None)
    if tokenizer is None or type(limit) is not int or limit < 1:
        raise ChunkEditError("The embedding model's token limit is unknown; chunk not changed.")
    token_ids = tokenizer(text, truncation=False, add_special_tokens=True)["input_ids"]
    if len(token_ids) > limit:
        raise ChunkEditError(
            f"Chunk is about {len(token_ids)} tokens; the embedding model accepts at most {limit}. "
            "Shorten the text."
        )


def reembed_chunk(
    collection: Any,
    model: Any,
    tenant_id: str,
    doc_id: str,
    chunk_index: int,
    text: str,
) -> dict:
    """Embeds ``text`` and replaces the chunk's text and embedding together.

    Returns ``{"text", "section", "char_count"}`` for the stored chunk. Raises ChunkEditError
    (VALIDATION_ERROR for bad text or over-long input, NOT_FOUND for an unknown chunk); any other
    exception (model or database failure) propagates with nothing written.
    """
    if not tenant_id or not doc_id or type(chunk_index) is not int or chunk_index < 0:
        raise ChunkEditError("tenant_id, doc_id and a non-negative chunk_index are required.")
    cleaned = validate_chunk_text(text)
    scope = {"tenant_id": tenant_id, "doc_id": doc_id, "chunk_index": chunk_index}

    existing = collection.find_one(scope, {"section": 1})
    if existing is None:
        raise ChunkEditError("Chunk not found.", code="NOT_FOUND")

    _check_token_limit(model, cleaned)
    vector = model.encode([cleaned], batch_size=1, show_progress_bar=False)[0]
    embedding = [float(value) for value in vector.tolist()] if hasattr(vector, "tolist") else [float(v) for v in vector]

    result = collection.update_one(scope, {"$set": {"text": cleaned, "embedding": embedding}})
    if getattr(result, "matched_count", 1) == 0:
        raise ChunkEditError("Chunk not found.", code="NOT_FOUND")
    return {
        "text": cleaned,
        "section": existing.get("section") or "Overview",
        "char_count": len(cleaned),
    }
