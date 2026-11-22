# Contributing

## Environment setup

Requires Python 3.14+, [uv](https://docs.astral.sh/uv/), Node.js/npm and Ollama. From the repository root:

```bash
uv sync
cp .env.example .env
npm install --prefix gateway
npm install --prefix dashboard
npm install --prefix widget
npm run build --prefix widget
```

Edit `.env` using the comments in `.env.example`. Secrets and targets (`MONGODB_URI`, `MONGODB_DB_NAME`, `HF_TOKEN` and so on) come from the environment or `.env`, never from code. Never commit `.env`, `.env.compose.local` or any credential. See [Running the services without Docker](#running-the-services-without-docker) below.

## Running the services without Docker

Run each process in its own terminal from the repository root:

```bash
ollama serve
.venv/bin/python scripts/run_chat_service.py --port 8100
npm run dev --prefix gateway
npm run dev --prefix dashboard
```

The dashboard is at [localhost:3000](http://localhost:3000) and the gateway defaults to port 4000. Set the gateway's `CHAT_BACKEND_URL` to the Python service, and give both processes the same `CHAT_BACKEND_TOKEN` when the service is reachable from another host. Restart processes after changing their environment. Use `APP_MODE=standard` for business onboarding; preset development mode needs a separate `MONGODB_TRAINING_DB_NAME` (see the [gateway guide](gateway/README.md)).

To run the stock model, `ollama pull llama3.2:3b`. To import the fine-tuned GGUF, see [GGUF import and checksum verification](deployment/README.md#gguf-import-and-checksum-verification).

## Development databases

The database is chosen entirely by environment variables, never hardcoded.

| Database | Use |
| :--- | :--- |
| `capstone_dev` | Development, training and evaluation across the five mock tenants: `cinder_and_salt`, `harbor_view`, `iron_and_oak`, `kettle_and_loom`, `northstar_auto` |
| `rag_knowledge_base` | The demo database, holding only the held-out demo business. This is also the default when `MONGODB_DB_NAME` is unset. |

Set `MONGODB_URI` and `MONGODB_DB_NAME` in `.env`. Both databases use the same collections (`businesses`, `doc_vectors`) and the same `vector_index` (384 dimensions, cosine, filters on `tenant_id` and `doc_id`), with `BAAI/bge-small-en-v1.5` embeddings.

## Document ingestion from the command line

Dashboard uploads run `scripts/ingest_uploaded_document.py` and show real progress (parsing, embedding, writing). For explicit administration, the bulk CLI inspects without writing anything:

```bash
.venv/bin/python scripts/ingest_rag_docs.py --document-parser structured --inspect-only
```

Inspection performs no database writes or embedding jobs. Actual ingestion needs `--execute` and replaces that tenant's vectors (the new chunks are inserted before the old ones are removed), so review the inspection output first. All arguments are in the [scripts guide](scripts/README.md).

## Repository map

| Path | Purpose | Docs |
| :--- | :--- | :--- |
| `gateway/` | Express API: auth, tenant config, documents, chunk editing, tickets, widget script, chat proxy | [gateway/README.md](gateway/README.md) |
| `dashboard/` | Next.js admin interface: uploads, chunk explorer and editor, runtime config, tickets | [dashboard/README.md](dashboard/README.md) |
| `widget/` | Embeddable script and React chat component (`@ownhelp/widget`) | [widget/README.md](widget/README.md), [API contract](widget/API_CONTRACT.md) |
| `src/` | Shared Python library: retrieval, ingestion, chat service, inference client | [src/README.md](src/README.md) |
| `scripts/` | CLI runners that import from `src/` | [scripts/README.md](scripts/README.md) |
| `deployment/`, `compose.yaml` | Docker packaging, Ollama model recipe, dependency lock, troubleshooting | [deployment/README.md](deployment/README.md) |
| `examples/client-training/` | Optional self-contained Docker sandbox with synthetic tenants and a local MongoDB | [examples/client-training/README.md](examples/client-training/README.md) |
| `data/` | The five mock tenants' source documents and fixtures | [data/README.md](data/README.md) |
| `tests/` | Python tests | [tests/README.md](tests/README.md) |

The client-training sandbox is a separate Docker setup with the dashboard, gateway, chat service, a local MongoDB and five seeded businesses, for training and demos. It does not start with the standard stack and uses its own Compose project, ports and volumes. Its README is the single reference for setup, configuration and reset.

## Where code goes

- **Reusable logic lives in `src/`** as modules and classes (for example `src/rag/retriever.py` or `src/chat/`). See the [package map](src/README.md).
- **CLI runners live in `scripts/`** and must import from `src/`. Do not put core logic in a script. See the [scripts guide](scripts/README.md).
- **No tenant-specific code.** Every business, including the final demo business, uses the same document schema. Never branch on a tenant name.
- **The gateway is the only entry point for the widget.** The widget and dashboard must never talk to MongoDB or hold database secrets.
- **Retrieval must pre-filter by tenant.** Use `$vectorSearch` with `tenant_id` in `filter`. Never retrieve first and filter afterward.

## Style

- All JSON files and JSON output use 4-space indentation.
- Comments explain why, not what. Every module has a header docstring or comment (purpose, inputs, outputs, callers), and every public function or class has a short docstring.
- Keep documentation current in the same change as the code. Commands, env var names, ports and routes in a README must match the code.

## Checks

Run all of these before opening a pull request:

```bash
.venv/bin/python -m unittest discover -s tests
npm test --prefix gateway
npm test --prefix dashboard
npm run lint --prefix dashboard
npm test --prefix widget
```

These suites are offline and mocked. Tests that use local stub HTTP servers need permission to bind loopback sockets. They do not replace a full Docker integration test or a model-quality evaluation. Which tests need a database or model, if any, is listed in the [tests guide](tests/README.md). If you changed Compose files, also run `docker compose --env-file .env.compose.example config -q`.

## Things not to change

- The frozen 100-question `harbor_view` benchmark, which is kept in a separate research workspace outside this repository. It is excluded from training and hyperparameter selection, and ground-truth-context and live-RAG evaluations stay separate.
- The sample business documents under `data/<tenant>/`. They are the retrieval corpus and the training and evaluation data, not project documentation. See the [data guide](data/README.md).

## Open work

Every open item is marked in the code or here with a greppable tag. List them all with `grep -rnE "TODO\(" --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.next .`.

In the code:

- `TODO(gateway-cleanup)`: the bare `dotenv.config()` call in `gateway/src/db/mongo.js` is the only thing that loads a `.env` from the process working directory. Make `config/env.js` search `process.cwd()` first, then drop both `dotenv` calls in `mongo.js` (`tests/env_loading.test.js` covers the behavior).

Not tied to one place in the code:

- `TODO(live-verification)`: three checks still need a logged-in dashboard session and are listed as a manual checklist in [`deployment/README.md`](deployment/README.md): a real dashboard document upload (the real subprocess path for upload progress, `defaultPythonIngestionRunner`, is only unit-tested with fakes), the first-ingest delay on a fresh vector index, and the one-time model re-import. Also try a real chunk edit against Atlas, since `scripts/reembed_chunk.py` has only been tested with fakes.
- `TODO(repo-cleanup)`: delete obsolete branches on the OwnHelp repository (for example `backup-post-project-cleanup` and the old data branches) once they are no longer needed.

## Commits

Stage only the files you changed. Do not use `git commit -a`.
