# Client training sandbox

An optional, self-contained Docker sandbox for learning the product without touching real
data: document upload, tenant configuration, tickets, the chunk explorer, and the chat
widget, using five synthetic businesses (`cinder_and_salt`, `harbor_view`, `iron_and_oak`,
`kettle_and_loom`, `northstar_auto`). The standard application never starts it, and it needs
no MongoDB Atlas account.

This is a training sandbox, not the standard Docker deployment (see
[`deployment/README.md`](../../deployment/README.md)) or a production install. One difference
matters: the standard OwnHelp stack has no database container and stores its data in your own
MongoDB Atlas cluster, while this sandbox deliberately keeps its own local MongoDB container
(`mongodb-demo`). It works offline, holds only synthetic data, and is completely separate from
the standard stack and from any Atlas cluster.

## What runs

Everything lives in the Compose project `ownhelp_client_training`
([`compose.yaml`](compose.yaml)). Host ports bind to `127.0.0.1` only.

| Service | Purpose | Host port |
| --- | --- | --- |
| `mongodb-demo` | Local MongoDB Atlas (`mongodb/mongodb-atlas-local:8.0`) with `$vectorSearch` | `27018` |
| `demo-seed` | One-shot, idempotent seeding of presets, sample tickets, documents, and vectors, then exits | none |
| `gateway-demo` | Orchestration gateway in `preset_training` mode (also serves `/widget.js`) | `4001` |
| `chat-service-demo` | Internal retrieval and generation service the gateway calls; not published | none |
| `dashboard-demo` | Management dashboard with one-click preset login | `3001` |
| `ollama-demo` | Optional bundled Ollama (profile `ollama`, only with `--with-ollama`) | `11435` |

Startup order: `mongodb-demo` healthy, `demo-seed` completes, `gateway-demo` healthy, then
`chat-service-demo` and `dashboard-demo`.

Images (`ownhelp-client-training-*`), volumes, network, session cookie
(`ownhelp_demo_session`), database (`capstone_demo`), and settings are separate from the
standard installation, so both can run side by side.

## Prerequisites

Docker with the Compose plugin, `curl`, and `python3` on the host (the launcher uses them
for health checks and the status summary). The first build downloads base images and the
embedding model (`BAAI/bge-small-en-v1.5`), so it needs network access and some disk space.
If `~/.cache/huggingface` already holds the model, the seed job reuses it.

## Start

Run everything from the repository root. The action comes first and options after it.

```bash
# Build, start, seed, and wait until healthy. Chat uses Ollama on the host.
bash examples/client-training/scripts/setup.sh

# Fully self-contained: run Ollama inside the project, then download a model into it.
bash examples/client-training/scripts/setup.sh setup --with-ollama
bash examples/client-training/scripts/setup.sh pull-model
```

Options may come before or after the action, so `setup.sh --with-ollama` also works.
Pass `--with-ollama` to `start` as well when you restart a bundled-Ollama stack.

On a machine with an NVIDIA GPU, use `--with-ollama-gpu` instead (it implies `--with-ollama`):

```bash
bash examples/client-training/scripts/setup.sh setup --with-ollama-gpu
```

This requires the NVIDIA driver and the NVIDIA Container Toolkit; on hosts without them the
bundled Ollama fails to start, so use plain `--with-ollama` there. Pass the flag on `start`
too when restarting a GPU stack.

Open the dashboard at <http://localhost:3001/login> and the gateway health endpoint at
<http://localhost:4001/api/health>. The script prints these and a seed summary when ready.

| Command | Effect |
| --- | --- |
| `setup.sh` or `setup.sh setup` | Build images, start the stack, run the seeder, wait for readiness |
| `setup.sh start` | Start without rebuilding |
| `setup.sh stop` | Stop containers; data volumes are kept |
| `setup.sh restart` | Restart gateway and dashboard only; data is kept |
| `setup.sh status` | Show containers, seed summary, and gateway health |
| `setup.sh logs [service]` | Show this project's logs |
| `setup.sh pull-model` | Pull `OLLAMA_MODEL` into the bundled Ollama container (it must be running) |
| `setup.sh reset [--rebuild]` | **Deletes this project's volumes**, including all training data and uploads |

Never use `reset` as a routine restart. It only affects this project, never the standard
stack or the repository root `.env`.

## Host Ollama or bundled Ollama

- **Host Ollama (default).** The containers call `OLLAMA_HOST=http://host.docker.internal:11434`,
  so Ollama on the host (and its GPU, if any) is used. Run `ollama serve` and
  `ollama pull llama3.2:3b` on the host yourself. On Linux, Ollama listens only on
  `127.0.0.1` by default, and containers reach the host through Docker's bridge address, so
  chat fails with `service_unavailable` and `/api/health` shows `"ollama_reachable": false`.
  Make Ollama listen on an address the containers can reach: set `OLLAMA_HOST=0.0.0.0:11434`
  for the Ollama service (for a systemd install, `sudo systemctl edit ollama`, add
  `[Service]` and `Environment="OLLAMA_HOST=0.0.0.0:11434"`, then
  `sudo systemctl restart ollama`). If you start Ollama by hand, stop it and run
  `OLLAMA_HOST=0.0.0.0:11434 ollama serve` instead. This exposes the unauthenticated Ollama API to your
  network, so firewall port 11434 or use the bundled Ollama below instead. To check, run
  `docker exec ownhelp_client_training-chat-service-demo-1 node -e 'fetch("http://host.docker.internal:11434/api/tags").then(r=>console.log(r.status))'`
  and expect `200`.
- **Bundled Ollama.** `--with-ollama` starts `ollama-demo` and points the containers at
  `http://ollama-demo:11434` for that invocation. It is CPU-only unless you pass
  `--with-ollama-gpu`, which layers `compose.gpu.yaml` (an NVIDIA GPU reservation). Models are stored in the `demo_ollama_models`
  volume.

Set `OLLAMA_MODEL` in `.env.local` to choose the model tag. The dashboard, login, tickets,
chunk explorer, uploads, and `$vectorSearch` all work with no model; only live answer
generation needs one. To use a locally fine-tuned model, see the model import steps in
[`deployment/README.md`](../../deployment/README.md).

## Configuration

On first run the launcher creates `examples/client-training/.env.local` (gitignored) with a
random local database password. [`.env.example`](.env.example) lists and explains every
setting, marking each as required or optional. The repository root `.env` is never read, so
real Atlas credentials cannot leak into the sandbox. Edit `.env.local` and rerun
`setup.sh setup` to apply changes; changing `NEXT_PUBLIC_GATEWAY_URL` needs that rebuild, and
changing the MongoDB password needs `reset` because the volume keeps the old one.

Also gitignored in this folder: `.docker-client/` (a minimal Docker config the launcher
creates only when your `~/.docker/config.json` references a missing `desktop` credential
helper) and `logs/` (holds `seed_summary.json`).

## How the pieces fit

The sandbox is isolated at runtime but is not a standalone copy of the code. Its images
are built from the repository root (`Dockerfile.gateway` and `Dockerfile.dashboard` here)
and reuse code from the rest of the repository:

- [`gateway/`](../../gateway/README.md) is the gateway, including `preset_training` mode.
- `dashboard/` and `widget/` are the dashboard and embeddable widget.
- [`src/`](../../src/README.md) holds the reusable logic: `src/demo_setup/seeder.py` (safety
  validation, fixture hashing, embedding, vector index creation) and the retrieval code
  behind `chat-service-demo`.
- [`scripts/`](../../scripts/README.md) holds `scripts/run_chat_service.py`, which
  `chat-service-demo` runs. [`scripts/seed.py`](scripts/seed.py) in this folder is only the
  seeder CLI runner.
- Fixtures stay under `data/` (`data/fixtures/demo_manifest.json` and the five tenant
  folders) because the gateway's `preset_training` mode also reads them.

The seeder refuses any target that is not a local `mongodb://` host and an allow-listed demo
database (`capstone_demo` or `capstone_local_demo`), so it cannot write to Atlas,
`rag_knowledge_base`, or `capstone_dev`. Seeding is idempotent: rerunning leaves unchanged
records alone and does not overwrite administrator edits. Use
`seed.py --execute --refresh-changed` to apply changed fixtures.

## Verify without databases or models

```bash
# Validate configuration and fixture hashes; prints the plan as JSON.
.venv/bin/python examples/client-training/scripts/seed.py --dry-run
.venv/bin/python examples/client-training/scripts/seed.py --help

# Check the launcher script and the Compose file without starting anything.
bash -n examples/client-training/scripts/setup.sh   # the script needs bash; plain sh rejects it
docker compose -f examples/client-training/compose.yaml config -q

# Seeder unit tests (mocked, no MongoDB needed).
.venv/bin/python -m unittest tests.test_demo_setup
```

`--dry-run` never connects to MongoDB or loads a model, and falls back to `.env.example` when
`.env.local` does not exist yet. The full image build, startup, and `--with-ollama` path are
not covered by these checks; run the Start commands above to exercise them. Legacy demo
containers and volumes from before this folder existed are neither migrated nor deleted.
