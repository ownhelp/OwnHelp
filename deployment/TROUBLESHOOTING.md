# Troubleshooting the standard stack

Covers `compose.yaml` (Ollama, model-init, chat-service, gateway, dashboard) against your own MongoDB Atlas cluster. Setup details are in [README.md](README.md); the gateway API is in [../gateway/README.md](../gateway/README.md). In every command below, `<...>` is a placeholder; never paste real secrets into logs or issues. `docker compose config` prints the Atlas URI, so do not share its output.

First look at state and logs:

```bash
docker compose ps
docker compose logs --tail 100 <service>
curl -s http://127.0.0.1:4002/api/health
```

`/api/health` always returns HTTP 200; read its fields: `database_ready`, `vector_index_ready`, `ollama_ready` (the gateway is healthy only when all three are true and `app_mode` is `standard`).

## Compose refuses to start

**Symptom:** `Set MONGODB_URI to your Atlas connection string`, `Set MODEL_GGUF_DIR`, `Set CHAT_BACKEND_TOKEN`, etc.
**Cause:** these variables use `${VAR:?message}`, so Compose stops when one is missing. Usually the `.env` file next to `compose.yaml` is missing, incomplete, or is an old development file (host-run tools now read `.env.dev`, and Compose reads `.env`).
**Fix:** if `.env` does not exist, create it with `python scripts/setup_stack.py --model-dir <dir> --model-sha256 <digest>`. It never overwrites an existing file, so if `.env` is an old development file, rename it to `.env.dev` first; to regenerate otherwise, pass a new `--output` or add the missing line by hand. Run Compose from the repository root so it finds `.env`.

**Symptom:** `setup_stack.py` fails with "Percent-encode special characters" or "still contains a <placeholder>".
**Cause:** the Atlas URI contains `$`, a quote or a backslash in the credentials, or still has the `<password>` placeholder from the Atlas UI.
**Fix:** percent-encode the username/password (for example `@` as `%40`, `$` as `%24`) and paste the real connection string.

## Docker and GPU

**Symptom:** `ollama` fails to start with a device or driver error (for example "could not select device driver nvidia").
**Cause:** `compose.yaml` reserves all NVIDIA GPUs for `ollama`; hosts without the NVIDIA driver and NVIDIA Container Toolkit cannot satisfy it.
**Fix:** confirm host `nvidia-smi` works, install and configure the toolkit (steps in README.md, "NVIDIA Container Toolkit on Ubuntu"), then check container access:

```bash
docker compose -f compose.yaml run --rm --no-deps --entrypoint nvidia-smi ollama
```

On a CPU-only host, remove the `deploy.resources.reservations` block from the `ollama` service in a local copy of the file (much slower inference).

**Symptom:** the model answers slowly even though `ollama` is up.
**Fix:** after a real chat reply, run `docker compose exec ollama ollama ps` and check it reports GPU use. The first reply after startup or idle can take tens of seconds (model load).

**Symptom:** `chat-service` fails with an image-not-found error.
**Cause:** it uses `ownhelp-runtime:local` with `pull_policy: never`; that image is built by the `gateway` service.
**Fix:** run `docker compose build` (or `up`) on the same host.

## Model import (model-init)

**Symptom:** `model-init` exits non-zero with "GGUF checksum mismatch; model import stopped."
**Cause:** the file in `MODEL_GGUF_DIR` is not the one whose digest is in `MODEL_GGUF_SHA256` (wrong, swapped or corrupted download). The stack never falls back to another model.
**Fix:** `sha256sum $MODEL_GGUF_DIR/Llama-3.2-3B-Instruct.Q4_K_M.gguf`, compare with the published digest, and either re-download the file or correct `MODEL_GGUF_SHA256`. Then run `docker compose up -d --wait`.

**Symptom:** `model-init` fails because the GGUF is missing, or Compose errors on the bind mount.
**Cause:** the GGUF is bind-mounted read-only from `${MODEL_GGUF_DIR}/Llama-3.2-3B-Instruct.Q4_K_M.gguf` with `create_host_path: false`, so the path and exact filename must exist on the host.
**Fix:** set `MODEL_GGUF_DIR` to the absolute directory containing that exact filename. The host file is never modified.

**Symptom:** `chat-service` never starts.
**Cause:** it waits for `model-init` to complete successfully. Check `docker compose logs model-init`.

## Atlas and the vector index

**Symptom:** `gateway` stays `unhealthy` / `up --wait` times out.
**Cause and fix, in order of likelihood** (check `docker compose logs gateway` and the `/api/health` fields):

- `database_ready: false`: Atlas is not reachable. Add this machine's public IP to the Atlas Network Access list, check the database user and password, and check DNS for `mongodb+srv://` URIs. Credentials with special characters must be percent-encoded. The services wait only 5 seconds for Atlas server selection.
- `vector_index_ready: false` on a new database: the gateway creates `vector_index` itself, but Atlas builds it asynchronously and the health check keeps failing until it is queryable. Wait a minute or two. Chunks ingested right after creation also take a short time to become searchable.
- `vector_index_ready: false` and it never clears: the Atlas database user may not be allowed to create search indexes. Create it by hand in the Atlas UI (Atlas Search, Create Search Index, JSON editor, index `vector_index`, collection `doc_vectors`) with the definition in README.md ("The Atlas database"): a 384-dimension cosine `embedding` vector plus `tenant_id` and `doc_id` filters.
- `ollama_ready: false`: the model tag is not registered yet or `OLLAMA_MODEL` does not match what `model-init` created; check `model-init` logs and `docker compose exec ollama ollama list`.

## Dashboard and browser access

**Symptom:** the dashboard loads but cannot reach the gateway (login fails, network errors).
**Cause:** `NEXT_PUBLIC_GATEWAY_URL` is baked into the dashboard image at build time (default `http://localhost:4002`) and must be the gateway address as seen from the browser. Changing it in the env file alone has no effect on an already built image.
**Fix:** set it, then rebuild: `docker compose build dashboard && docker compose up -d --wait`.

**Symptom:** dashboard requests are rejected with 403 or blocked by CORS.
**Cause:** the gateway only accepts the dashboard origins it is configured with. In compose, `ALLOWED_ORIGINS` defaults to `http://localhost:3002,http://127.0.0.1:3002`.
**Fix:** set `ALLOWED_ORIGINS` to the exact URL(s) you open the dashboard from (scheme, host and port), then `up -d` to recreate the gateway.

**Symptom:** behind a reverse proxy or Cloudflare Tunnel, rate limits trip for everyone or login throttling affects all users.
**Cause:** without `TRUST_PROXY` the gateway sees the proxy's address, not the visitor's.
**Fix:** set `TRUST_PROXY=1` in `.env` for a single proxy hop (compose passes it through; empty leaves it off), then recreate the gateway. The host ports are bound to `127.0.0.1`, so the proxy must run on the same host or forward to it.

## Widget

**Symptom:** the storefront widget gets `403` with `origin_not_allowed`.
**Cause:** the browser `Origin` of the storefront is not in the business's allowed origins. With no list for the tenant and no `WIDGET_DEFAULT_ALLOWED_ORIGINS`, every browser origin is rejected. Requests without an `Origin` header (curl) skip this check, so curl working does not prove the widget will.
**Fix:** in the dashboard, add the storefront's exact origin (for example `https://shop.example.com`: scheme and host, no path, no wildcard) to that business's allowed origins, which is saved as `widget_config.allowed_origins`.

## Resetting

`docker compose down` keeps the `ollama_models` and `hf_cache` volumes; `down -v` deletes only those (the model is re-imported on the next `up`). Documents, vectors and tickets live in Atlas and are not affected.
