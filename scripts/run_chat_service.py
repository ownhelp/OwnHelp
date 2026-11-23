"""Run the internal chat service used by the Orchestration Gateway's POST /api/chat.

Usage:
    uv run python scripts/run_chat_service.py [--host 127.0.0.1] [--port 8100]

Arguments:
    --host  Bind address. Default 127.0.0.1 (loopback only); use 0.0.0.0 inside a container.
    --port  TCP port. Default 8100 (the gateway's default CHAT_BACKEND_URL).

Environment (process environment, or .env.dev in the project root):
    MONGODB_URI, MONGODB_DB_NAME   Vector store for tenant-filtered retrieval (required).
    OLLAMA_HOST, OLLAMA_MODEL      Local inference server and model tag (required).
    EMBEDDING_MODEL_NAME           Embedding model (default BAAI/bge-small-en-v1.5).
    CHAT_BACKEND_TOKEN             If set, callers must present it as a shared secret.

Side effects: starts a long-running HTTP server, loads the embedding model, and reads from
MongoDB and Ollama. It writes nothing to the database.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.chat.server import serve  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="Env: MONGODB_URI, MONGODB_DB_NAME, OLLAMA_HOST, OLLAMA_MODEL, EMBEDDING_MODEL_NAME (optional), "
        "CHAT_BACKEND_TOKEN (optional shared secret). Read from the environment or .env.dev.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: loopback only).")
    parser.add_argument("--port", type=int, default=8100, help="TCP port (default: 8100).")
    args = parser.parse_args()
    serve(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
