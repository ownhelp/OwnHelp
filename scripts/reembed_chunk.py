"""CLI runner that edits one stored chunk: re-embeds the new text and saves text and vector together.

Usage:
    python -m scripts.reembed_chunk --tenant TENANT_ID --doc-id DOC_ID --chunk-index N [--db-name DB]
    The new chunk text is read from STDIN as JSON: {"text": "..."} (never from argv, so it cannot
    leak into process listings or hit argument-length limits).

Environment (process environment first, then .env.dev in the project root):
    MONGODB_URI (required), MONGODB_DB_NAME, MONGODB_COLLECTION_NAME (default doc_vectors),
    EMBEDDING_MODEL_NAME (default BAAI/bge-small-en-v1.5, the model used at ingestion).

Output: ONE final JSON object as the last stdout line: {"status": "success", ...} or
{"status": "error", "code": VALIDATION_ERROR|NOT_FOUND|EDIT_ERROR, "error": "..."}. Exit codes:
0 success, 1 rejected or failed (nothing is written on failure). The Orchestration Gateway
(gateway/src/routes/documents.js) invokes this script; the tenant comes from the gateway session.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.rag.reembed import ChunkEditError, reembed_chunk  # noqa: E402


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Re-embed one edited doc_vectors chunk (text read as JSON from stdin).",
    )
    parser.add_argument("--tenant", required=True, help="tenant_id that owns the chunk.")
    parser.add_argument("--doc-id", required=True, help="doc_id of the chunk.")
    parser.add_argument("--chunk-index", required=True, type=int, help="chunk_index within the doc.")
    parser.add_argument("--db-name", default=None, help="Database selected by the gateway.")
    return parser


def edit_chunk(tenant_id: str, doc_id: str, chunk_index: int, text: str, db_name: str | None = None) -> dict:
    """Loads the ingestion embedder (same model as uploads) and applies the edit."""
    from src.rag.ingestor import RAGDocumentIngestor

    # Keep library prints off stdout: the last stdout line must be the JSON result.
    with contextlib.redirect_stdout(sys.stderr):
        ingestor = RAGDocumentIngestor(
            db_name=(db_name or os.environ.get("MONGODB_DB_NAME") or None),
            env_file=PROJECT_ROOT / ".env.dev",
        )
        try:
            stored = reembed_chunk(ingestor.collection, ingestor.model, tenant_id, doc_id, chunk_index, text)
        finally:
            ingestor.client.close()
    return {
        "status": "success",
        "tenant_id": tenant_id,
        "doc_id": doc_id,
        "chunk_index": chunk_index,
        **stored,
    }


def main() -> None:
    args = build_arg_parser().parse_args()
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        text = payload.get("text") if isinstance(payload, dict) else None
        result = edit_chunk(args.tenant, args.doc_id, args.chunk_index, text, args.db_name)
        print(json.dumps(result))
    except ChunkEditError as exc:
        print(json.dumps({"status": "error", "code": exc.code, "error": str(exc)}))
        sys.exit(1)
    except json.JSONDecodeError:
        print(json.dumps({"status": "error", "code": "VALIDATION_ERROR", "error": "Request body was not valid JSON."}))
        sys.exit(1)
    except Exception as exc:
        # Type only: driver and model exception text can contain connection details.
        print(json.dumps({"status": "error", "code": "EDIT_ERROR", "error": f"Chunk edit failed ({type(exc).__name__}); nothing was changed."}))
        sys.exit(1)


if __name__ == "__main__":
    main()
