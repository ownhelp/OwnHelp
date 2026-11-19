# Scripts

Command-line runners. Reusable logic lives in `src/`; these files only parse arguments and call it. Run them from the repository root. Every runner supports `--help` except `import_model.sh`, which takes no arguments.

Environment variables are read from the process environment and the project `.env` (template: `.env.example`). Never put credentials on a command line.

## setup_stack.py

Creates `.env.compose.local` for the Docker Compose stack after verifying the model file and the Atlas connection string format.

- Arguments: `--model-dir DIR` (required, directory holding `Llama-3.2-3B-Instruct.Q4_K_M.gguf`), `--model-sha256 HEX` (required, 64 hex characters), `--output PATH` (default `.env.compose.local`). The Atlas URI is deliberately not an argument.
- Env vars: `MONGODB_URI` (your Atlas connection string, `mongodb+srv://` or `mongodb://`). If unset, the script asks for it with a hidden prompt.
- Effects: hashes the GGUF, writes the file with mode 0600, the Atlas URI and fresh random secrets, refuses to overwrite an existing file, makes no network calls, starts nothing. The URI is never printed.
- Example: `python scripts/setup_stack.py --model-dir /models/hardneg_full01 --model-sha256 <digest>`, then paste the URI at the hidden prompt (this keeps it out of shell history; setting `MONGODB_URI` inline would not).

## import_model.sh

Runs inside the `model-init` Compose service, not on the host. Verifies the GGUF SHA-256 and imports it into Ollama from `deployment/ollama/Modelfile`; skips the work when nothing changed.

- Arguments: none.
- Env vars: `OLLAMA_MODEL` and `MODEL_GGUF_SHA256` (required), `OLLAMA_HOST`, `MODEL_IMPORT_DIR`, `MODEL_IMPORT_STATE_DIR` (optional).
- Effects: modifies only the Ollama model store of the container. Exit 1 on a missing file, checksum mismatch or failed import.
- Example: started automatically by `docker compose --env-file .env.compose.local up -d --wait`. See `deployment/README.md`.

## run_chat_service.py

Starts the internal chat service the gateway calls for `POST /api/chat` (tenant-filtered retrieval, prompt assembly, Ollama generation).

- Arguments: `--host` (default `127.0.0.1`), `--port` (default `8100`).
- Env vars: `MONGODB_URI`, `MONGODB_DB_NAME`, `OLLAMA_HOST`, `OLLAMA_MODEL` (required); `EMBEDDING_MODEL_NAME`, `CHAT_BACKEND_TOKEN` (optional).
- Effects: long-running server; reads MongoDB and Ollama, writes nothing.
- Example: `uv run python scripts/run_chat_service.py --port 8100`

## ingest_rag_docs.py

Bulk ingestion of tenant documentation directories. Inspection is offline; writing needs an explicit flag.

- Arguments: `--document-parser {structured,legacy}` (default `structured`, the same parser dashboard uploads use), `--tenant-dir TENANT=PATH` (repeatable; default is the five development tenants under `data/`), `--inspect-only` (needs `structured`), `--execute`.
- Env vars: `MONGODB_URI` (required with `--execute`); `MONGODB_TRAINING_DB_NAME` (default `capstone_dev`, for the default tenants), `MONGODB_DB_NAME` (default `rag_knowledge_base`, for `--tenant-dir`), `MONGODB_COLLECTION_NAME`, `EMBEDDING_MODEL_NAME`.
- Effects of `--execute`: creates the vector index if missing and replaces every vector chunk of each listed tenant. `--inspect-only` makes no network calls and no writes.
- Examples:
  - `python scripts/ingest_rag_docs.py --inspect-only --document-parser structured`
  - `python scripts/ingest_rag_docs.py --execute --tenant-dir demo_tenant=data/demo_tenant`

## ingest_uploaded_document.py

Ingests one `.md` or `.json` document for one tenant. The gateway calls it for dashboard uploads; it can also be run by hand.

- Arguments: `--file PATH` and `--tenant ID` (required), `--doc-id ID` (default file stem), `--overwrite true|false` (default true), `--db-name DB` (default `MONGODB_DB_NAME`, else `rag_knowledge_base`).
- Env vars: `MONGODB_URI` (required), `MONGODB_DB_NAME`, `MONGODB_COLLECTION_NAME`, `EMBEDDING_MODEL_NAME`.
- Output: one progress line per stage on stdout before the final result: `{"event": "stage", "stage": "parsing"}`, then `"embedding"`, then `"writing"`. The final JSON summary (status success or error) is always the LAST stdout line, so consumers that read only the last line are unaffected. Warnings go to stderr. Exit code 0 success, 1 error, 2 document exists with `--overwrite false`.
- Effects: creates the collection and vector index if missing. When overwriting, the new chunks are inserted first and the earlier chunks of the same `doc_id` are deleted afterwards, so a failed insert leaves the previous chunks in place.
- Example: `python scripts/ingest_uploaded_document.py --file returns_policy.md --tenant iron_and_oak`
