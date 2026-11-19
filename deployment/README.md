# Deployment

How the OwnHelp stack is packaged and started with Docker Compose: the Ollama model recipe, the hashed CPU dependency lock, the Compose file, the environment variables, and how the fine-tuned GGUF is imported and verified.

## Privacy trade-off

Inference runs locally: the model, the prompts and the generated answers stay on the machine that runs this stack. The database does not. The standard stack has no database container; it uses a MongoDB Atlas cluster that you own. Documents, embeddings, tickets, saved contact details and business records are stored in that cluster, and the chat service reads retrieved chunks from it on every question. You control the cluster, its region and its access rules, but that data is hosted by MongoDB Atlas, not on your server. This keeps a database (and its storage) off the client's server; an offline, all-local variant exists only as a separate sandbox, `examples/client-training/`, which uses synthetic data.

Files covered here:

| Path | Purpose |
|---|---|
| `compose.yaml` | The stack: Ollama, model import, chat service, gateway, dashboard. The database is your Atlas cluster. |
| `.env.compose.example` | Template for the private `.env.compose.local`. |
| `deployment/ollama/Modelfile` | Ollama import recipe for the GGUF. |
| `deployment/requirements.cpu.lock` | Hashed, CPU-only Python dependency lock used by the images. |
| `scripts/setup_stack.py` | Verifies the GGUF and writes `.env.compose.local`. |
| `scripts/import_model.sh` | Runs inside the `model-init` service to verify and import the GGUF. |

## Prerequisites

- Docker Engine with the Compose plugin (`docker compose`).
- An NVIDIA GPU, the NVIDIA driver, and the NVIDIA Container Toolkit. `compose.yaml` reserves all GPUs for the `ollama` service (`driver: nvidia`, `capabilities: [gpu]`); on a host without them the service cannot start. To confirm the toolkit works before starting, run `docker run --rm --gpus all <any CUDA or ollama image> nvidia-smi`. On a CPU-only host, remove the `deploy.resources.reservations` block from the `ollama` service in a local copy of the file. Inference is much slower without a GPU.
- The fine-tuned GGUF `Llama-3.2-3B-Instruct.Q4_K_M.gguf` in a host directory outside the repository, and its SHA-256.
- Free host ports for the gateway (default 4002) and dashboard (default 3002). Both are bound to `127.0.0.1` only.
- A MongoDB Atlas cluster (a free M0 cluster works for small installations), a database user with read/write access, and a network access rule that allows this machine. The cluster must support Atlas Vector Search.

## Quick start

```bash
sha256sum /path/to/model-dir/Llama-3.2-3B-Instruct.Q4_K_M.gguf     # note the digest
python scripts/setup_stack.py --model-dir /path/to/model-dir --model-sha256 <digest>
docker compose --env-file .env.compose.local up -d --wait
```

`setup_stack.py` asks for your Atlas connection string at a hidden prompt (or reads it from the `MONGODB_URI` environment variable). It is never accepted as a command-line argument, so it stays out of shell history, and it is never printed. The script checks that it starts with `mongodb+srv://` or `mongodb://`; it does not contact Atlas. It writes `.env.compose.local` once (mode 0600) and never overwrites it, so the URI, credentials and follow-up secrets survive restarts. It starts no services. Keep the file private and out of version control. The first `up` builds the gateway and dashboard images, which takes several minutes.

Then open the dashboard at `http://localhost:3002`. Stop with `docker compose --env-file .env.compose.local down`. The `ollama_models` and `hf_cache` volumes keep the imported model and embedding cache; `down -v` deletes only those. Your data lives in Atlas and is not touched by `down -v`.

## The Atlas database

The stack has no database service. `MONGODB_URI` is required: Compose stops with a clear error if it is missing.

- Database: `MONGODB_DB_NAME` (default `rag_knowledge_base`), collections such as `doc_vectors` and `businesses` are created on first use.
- Vector index: an Atlas Vector Search index named `vector_index` on `doc_vectors`:

```json
{
    "fields": [
        {"type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine"},
        {"type": "filter", "path": "tenant_id"},
        {"type": "filter", "path": "doc_id"}
    ]
}
```

- The gateway creates this index automatically when the Atlas database user may create search indexes. If it may not, create the index above by hand in the Atlas UI (Atlas Search, Create Search Index, JSON editor, `vector_index`, collection `doc_vectors`).
- First start delay: Atlas builds a new index asynchronously. On a new database the gateway health check (`/api/health` must report `vector_index_ready`) keeps failing until the index is queryable, so `docker compose up -d --wait` can take a minute or two longer. Chunks ingested right after the index is created also take a short time to become searchable, so the first uploaded document may not be retrievable immediately.
- The Atlas URI is a credential. Do not share the output of `docker compose config`, which prints it.

## Services in `compose.yaml`

| Service | Role | Host port | Volumes | Health check |
|---|---|---|---|---|
| `ollama` | Local inference engine, GPU | none | `ollama_models` | `ollama list` |
| `model-init` | One-shot GGUF verification and import | none | `ollama_models`, plus read-only binds for the GGUF, Modelfile and import script | exits 0 on success |
| `chat-service` | Retrieval, prompt assembly, generation (`scripts/run_chat_service.py`, port 8100) | none | `hf_cache` | `GET /health` |
| `gateway` | Orchestration Gateway: `POST /api/chat`, widget script, dashboard API | `127.0.0.1:${GATEWAY_PORT}` to 4000 | `hf_cache` | `/api/health` reports database, vector index and Ollama ready |
| `dashboard` | Management dashboard (Next.js) | `127.0.0.1:${DASHBOARD_PORT}` to 3000 | none | `/login` responds |

Startup order: `ollama` becomes healthy, `model-init` imports the model and exits, then `chat-service`, `gateway`, and `dashboard` start in that order. `chat-service` uses the image built by the `gateway` service (`pull_policy: never`), so images must be built on the same host, which `up` does.

## Environment variables

Compose reads `.env.compose.local` (see `.env.compose.example`). Required variables use `${VAR:?message}`, so Compose fails fast with a clear message when one is missing.

| Variable | Required | Meaning |
|---|---|---|
| `MONGODB_URI` | yes | Your Atlas connection string. A credential; supplied to `setup_stack.py` by environment variable or hidden prompt. |
| `MONGODB_DB_NAME` | no (default `rag_knowledge_base`) | Database used by the gateway and chat service. |
| `CHAT_BACKEND_TOKEN` | yes | Shared secret between gateway and chat service. Generated. |
| `CHAT_FOLLOW_UP_SECRET` | yes | Stable secret for widget follow-up forms. Generated. |
| `MODEL_GGUF_DIR` | yes | Absolute host directory containing the GGUF. |
| `MODEL_GGUF_SHA256` | yes | Expected SHA-256 of the GGUF. |
| `OLLAMA_MODEL` | no | Tag the model is registered under; the chat service requests it. |
| `OLLAMA_IMAGE` | no | Pinned Ollama image tag. |
| `GATEWAY_PORT`, `DASHBOARD_PORT` | no | Host ports (defaults 4002 and 3002). |
| `NEXT_PUBLIC_GATEWAY_URL` | no | Gateway URL as seen by the browser; baked into the dashboard image at build time, so changing it requires a rebuild. |
| `ALLOWED_ORIGINS` | no | Comma-separated origins the gateway accepts for the dashboard. Must include the dashboard URL. |
| `SESSION_COOKIE_NAME` | no (default `ownhelp_session`) | Dashboard session cookie name. |

Values that Compose fixes for the runtime (not user settings): `MONGODB_COLLECTION_NAME=doc_vectors`, `MONGODB_VECTOR_INDEX_NAME=vector_index`, `EMBEDDING_MODEL_NAME=BAAI/bge-small-en-v1.5`, `OLLAMA_HOST=http://ollama:11434`.

Running the gateway and scripts directly on the host (not in Docker) uses a different file, `.env`; see `.env.example`.

## Ollama Modelfile

`deployment/ollama/Modelfile` registers the GGUF with Ollama:

- `FROM ./Llama-3.2-3B-Instruct.Q4_K_M.gguf` points at the weights next to the Modelfile (both are mounted into `/model-import` in `model-init`).
- `TEMPLATE` is the text-only branch of the Llama 3 chat template: a system header with the fixed "Cutting Knowledge Date / Today Date" lines, followed by user and assistant turns, each ended by `<|eot_id|>`. The GGUF already adds the BOS token, so the template does not add a second one. No `SYSTEM` line is set, so the prompt sent by the chat service (tenant system prompt and retrieved context) is used as is.
- `PARAMETER stop` lists the Llama 3 end and header markers (`<|eot_id|>`, `<|end_of_text|>`, `<|eom_id|>`, `<|start_header_id|>`, `<|end_header_id|>`) so generation ends at the turn boundary and never leaks header tokens.
- `num_ctx 4096` is the context window; `temperature 0.2` is a default that the chat service overrides per request from the tenant configuration.

If you change the Modelfile, `import_model.sh` detects it (the fingerprint includes its hash) and re-creates the model on the next `up`.

## GGUF import and checksum verification

The GGUF is never baked into an image and never copied into the repository. The check happens twice:

1. `scripts/setup_stack.py` hashes `$MODEL_GGUF_DIR/Llama-3.2-3B-Instruct.Q4_K_M.gguf` and refuses to write `.env.compose.local` when it differs from `--model-sha256`.
2. `scripts/import_model.sh` runs in `model-init`, recomputes the SHA-256 of the mounted file, and exits non-zero on mismatch, so a swapped or corrupted file can never reach Ollama. It never falls back to another model.

On success it runs `ollama create "$OLLAMA_MODEL" -f /model-import/Modelfile` and stores a fingerprint (GGUF hash, Modelfile hash, installed Modelfile hash) in `/root/.ollama/ownhelp-imports` on the `ollama_models` volume. A later `up` with the same inputs skips the import. Because `chat-service` requires `model-init` to complete successfully, the stack does not start with an unverified model.

To verify a file manually: `sha256sum Llama-3.2-3B-Instruct.Q4_K_M.gguf` and compare with the published digest.

## Hashed CPU dependency lock

`deployment/requirements.cpu.lock` pins every Python dependency of the gateway and chat-service images with SHA-256 hashes, for Linux x86_64 and CPython 3.14, using the official CPU-only PyTorch index (no CUDA wheels, which keeps the images small; inference runs in Ollama, not in PyTorch). It is resolved by `uv` from `pyproject.toml` using the versions already in `uv.lock`. The images install it with hash checking, so a tampered or substituted package fails the build.

Regenerate it after changing `pyproject.toml` dependencies, keeping the CPU index and hashes. Local development (`uv sync`) continues to use `uv.lock`.

## NVIDIA Container Toolkit on Ubuntu

Host `nvidia-smi` must work first. Then install and configure the toolkit following [NVIDIA's installation guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). These commands need interactive `sudo`. Finish any running image builds before restarting Docker, because restarting the daemon interrupts them.

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg2
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

After the `ollama` image is pulled, check container GPU access before starting the whole stack:

```bash
docker compose --env-file .env.compose.local -f compose.yaml run --rm --no-deps --entrypoint nvidia-smi ollama
```

A passing `nvidia-smi` does not prove the model runs on the GPU. After a real chat reply, run `docker compose --env-file .env.compose.local exec ollama ollama ps` and confirm it reports 100% GPU.

## Operating notes

Observed on one machine (Ubuntu, RTX 4060 with 8 GB VRAM):

- The first reply after startup, or after the model has been idle, took about 40 seconds. Later replies took 2 to 5 seconds. This is cold-start cost from loading the model onto the GPU and from the first embedding use; the split was not measured. Ollama's default 5-minute keep-alive is not overridden, so an idle model unloads and the next visitor pays the cold start again.
- The gateway keeps conversation history and rate limits in memory, so they reset when it is recreated. Business records, documents, vectors, tickets, saved contact details and the imported model persist. A follow-up form opened before a recreation still works because `CHAT_FOLLOW_UP_SECRET` is stable.
- A missing GGUF directory or a checksum mismatch stops `model-init` with a nonzero exit. The stack never falls back to the base model.
- Browser chat is rejected from any origin not listed for the business. The check applies to browsers only; requests without an `Origin` header (curl, server-side clients) are not blocked by it.
- Use a different Compose project name (`-p`), ports and `MONGODB_DB_NAME` for independent installations.
- `docker compose config` prints secrets from `.env.compose.local`, including the Atlas URI. Do not share its output as a log.
- Atlas must be reachable from the machine (network access rule, DNS for `mongodb+srv://`); the chat service waits up to 5 seconds for server selection per request.

If Docker Engine references an unavailable `docker-credential-desktop` helper, public image pulls can use an isolated client configuration without touching your saved one:

```bash
export DOCKER_CONFIG="$(mktemp -d)"
printf '{"auths": {}}\n' > "$DOCKER_CONFIG/config.json"
```

That configuration has no registry login. Use it only for the public images in this stack.

## Verification status

Verified on the development machine (Ubuntu, RTX 4060 with 8 GB VRAM) with the current Atlas-only stack against a live Atlas cluster: `setup_stack.py` with an environment-supplied URI (the hidden-prompt path is covered by mocked tests only); image builds from the hashed CPU lock; `up -d --wait` reaching healthy with `vector_index_ready`; GGUF checksum verification and import, and `model-init` skipping the import on the next start; 100% GPU inference in the `ollama` container (`ollama ps`); signup of a new business, a document upload, and chat through the widget; the `ownhelp_session` cookie; and `down` followed by `up -d --wait` with the model, volumes and health intact.

Verified only on an earlier revision that used a bundled MongoDB container, and not repeated on the Atlas-only stack: tenant isolation in both directions, safe escalation, contact capture, ticket review, New chat, and single-service outages with recovery.

Not verified: automatic creation of the vector index (the index already existed on the cluster used), a measured first-ingest index delay (the delay described above is expected behavior), a different machine or a cold Docker cache, GPUs other than the RTX 4060, other browsers, and sustained or concurrent load.

## Troubleshooting

- `Set MODEL_GGUF_DIR` or similar: `.env.compose.local` is missing or incomplete; pass `--env-file .env.compose.local`.
- `model-init` fails with "GGUF checksum mismatch": the file in `MODEL_GGUF_DIR` is not the one whose digest you configured.
- `Set MONGODB_URI to your Atlas connection string`: the variable is missing from `.env.compose.local`; rerun `setup_stack.py` with a new `--output` or add the line by hand.
- Gateway stays unhealthy: check `docker compose logs gateway`. Usual causes are an Atlas network access rule that excludes this machine, wrong credentials, or a vector index that is still building (first start) or missing because the Atlas user may not create search indexes.
- `ollama` fails to start with a device error: the NVIDIA Container Toolkit is not installed or not configured for Docker.
- Dashboard cannot reach the gateway: `NEXT_PUBLIC_GATEWAY_URL` and `ALLOWED_ORIGINS` must match the addresses used in the browser; rebuild the dashboard after changing the former.
