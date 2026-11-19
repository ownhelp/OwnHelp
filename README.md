# OwnHelp

A self-hosted, multi-tenant customer support system. A business uploads its own documentation, and a fine-tuned local `Llama-3.2-3B-Instruct` answers visitor questions grounded in that documentation. Inference runs on your own machine with no per-token cloud cost. Documents and embeddings are stored in a MongoDB Atlas cluster that you own (see [privacy](deployment/README.md#privacy-trade-off)).

## How it works

```text
[Storefront chat widget]
        |  POST /api/chat
        v
[Gateway (Express)] ----> [Chat service (Python)] ----> [Ollama: local GGUF model]
        |                          |
        |                          v  $vectorSearch, pre-filtered by tenant_id
        |                    [MongoDB Atlas: doc_vectors, businesses]
        v
[Management dashboard (Next.js)]
```

- The widget talks only to the gateway. It never reaches MongoDB and holds no secrets.
- The gateway handles authentication, tenants, document uploads, tickets and public chat. It proxies chat turns to the internal Python chat service.
- The chat service embeds the question, retrieves chunks with `$vectorSearch` filtered by `tenant_id`, assembles the prompt, and generates the answer with Ollama.
- A tenant never retrieves another tenant's documents. See [where filtering is enforced](src/README.md#where-tenant-filtering-is-enforced).

## Component map

| Path | Purpose | Docs |
| :--- | :--- | :--- |
| `gateway/` | Express API: auth, tenant config, documents, tickets, widget script, chat proxy | [gateway/README.md](gateway/README.md) |
| `dashboard/` | Next.js admin interface: uploads, chunk explorer, runtime config, tickets | [dashboard/README.md](dashboard/README.md) |
| `widget/` | Embeddable script and React chat component (`@ownhelp/widget`) | [widget/README.md](widget/README.md), [API contract](widget/API_CONTRACT.md) |
| `src/` | Shared Python library: retrieval, ingestion, chat service, inference client | [src/README.md](src/README.md) |
| `scripts/` | CLI runners that import from `src/` | [scripts/README.md](scripts/README.md) |
| `deployment/`, `compose.yaml` | Docker packaging, Ollama model recipe, dependency lock | [deployment/README.md](deployment/README.md) |
| `examples/client-training/` | Optional self-contained Docker sandbox with synthetic tenants and a local MongoDB | [examples/client-training/README.md](examples/client-training/README.md) |
| `data/` | The five mock tenants' source documents and fixtures | [data/README.md](data/README.md) |
| `tests/` | Python tests | [tests/README.md](tests/README.md) |

## Quick start (Docker)

Prerequisites: Docker with the Compose plugin, an NVIDIA GPU with the NVIDIA Container Toolkit, a MongoDB Atlas cluster with Vector Search and a database user, and the fine-tuned GGUF in a directory outside this repository. The project does not download model weights. Full prerequisites and GPU setup are in the [deployment guide](deployment/README.md).

```bash
python3 scripts/setup_stack.py \
  --model-dir /absolute/path/to/model-dir \
  --model-sha256 YOUR_VERIFIED_64_CHARACTER_SHA256
docker compose --env-file .env.compose.local up -d --wait --wait-timeout 900
```

`setup_stack.py` verifies the checksum, asks for your Atlas connection string at a hidden prompt (or reads `MONGODB_URI` from the environment), and writes `.env.compose.local` once. It never overwrites an existing file. Keep that file private. You can instead copy [`.env.compose.example`](.env.compose.example) and fill in every placeholder.

Open the dashboard at [localhost:3002/signup](http://localhost:3002/signup) to create a business, then list the exact origin of your storefront as an allowed origin before embedding `http://localhost:4002/widget.js`. The first start can take a few minutes longer on a new database while Atlas builds the vector index; see [the Atlas database](deployment/README.md#the-atlas-database).

## Databases

The database is chosen entirely by environment variables, never hardcoded.

| Database | Use |
| :--- | :--- |
| `capstone_dev` | Development, training and evaluation across the five mock tenants: `cinder_and_salt`, `harbor_view`, `iron_and_oak`, `kettle_and_loom`, `northstar_auto` |
| `rag_knowledge_base` | The demo database, holding only the held-out demo business. This is also the default when `MONGODB_DB_NAME` is unset. |

Set `MONGODB_URI` and `MONGODB_DB_NAME` in `.env`. Both databases use the same collections (`businesses`, `doc_vectors`) and the same `vector_index` (384 dimensions, cosine, filters on `tenant_id` and `doc_id`), with `BAAI/bge-small-en-v1.5` embeddings. The embedding model and the index must agree.

## Local development without Docker

Requires Python 3.14+, [uv](https://docs.astral.sh/uv/), Node.js/npm and Ollama.

```bash
uv sync
cp .env.example .env          # then edit; see the comments in the file
npm install --prefix gateway
npm install --prefix dashboard
npm install --prefix widget
npm run build --prefix widget
```

Run each process in its own terminal from the repository root:

```bash
ollama serve
.venv/bin/python scripts/run_chat_service.py --port 8100
npm run dev --prefix gateway
npm run dev --prefix dashboard
```

The dashboard is at [localhost:3000](http://localhost:3000) and the gateway defaults to port 4000. Set the gateway's `CHAT_BACKEND_URL` to the Python service, and give both processes the same `CHAT_BACKEND_TOKEN` when the service is reachable from another host. Restart processes after changing their environment. Use `APP_MODE=standard` for business onboarding; preset development mode needs a separate `MONGODB_TRAINING_DB_NAME` (see the [gateway guide](gateway/README.md)).

To run the stock model, `ollama pull llama3.2:3b`. To import the fine-tuned GGUF, see [GGUF import and checksum verification](deployment/README.md#gguf-import-and-checksum-verification).

## Document ingestion

Dashboard uploads run `scripts/ingest_uploaded_document.py` and show real progress (parsing, embedding, writing). For explicit administration, the bulk CLI inspects without writing anything:

```bash
.venv/bin/python scripts/ingest_rag_docs.py --document-parser structured --inspect-only
```

Inspection performs no database writes or embedding jobs. Actual ingestion needs `--execute` and replaces that tenant's vectors (the new chunks are inserted before the old ones are removed), so review the inspection output first. All arguments are in the [scripts guide](scripts/README.md).

## Tests

With dependencies installed, run the offline, mocked suites:

```bash
.venv/bin/python -m unittest discover -s tests
npm test --prefix gateway
npm test --prefix dashboard
npm run lint --prefix dashboard
npm test --prefix widget
```

Tests that use local stub HTTP servers need permission to bind loopback sockets. These checks do not replace a full Docker integration test or a model-quality evaluation. See the [tests guide](tests/README.md).

## Optional client-training sandbox

[`examples/client-training/`](examples/client-training/README.md) is a separate Docker sandbox with the dashboard, gateway, chat service, a local MongoDB and five seeded businesses, for training and demos. It does not start with the standard stack and uses its own Compose project, ports and volumes. Its README is the single reference for setup, configuration and reset.

## License

MIT. See [LICENSE](LICENSE).
