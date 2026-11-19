#!/usr/bin/env bash
# Launcher for the optional client-training sandbox (Compose project
# "ownhelp_client_training"). It is never started by the standard application.
#
# Usage (from the repository root):
#   bash examples/client-training/scripts/setup.sh [ACTION] [--with-ollama] [extra compose args]
#
# ACTION is the first argument and defaults to "setup" only when no arguments are given.
# Options come after it, so write `setup.sh setup --with-ollama`, not `setup.sh --with-ollama`
# (a leading option is read as an unknown action and prints the usage line).
#
# ACTION:
#   setup       Build the gateway and dashboard images, start the stack, wait until
#               healthy, print endpoints and the seed summary.
#   start       Start without rebuilding, then wait and print the summary.
#   stop        Stop containers. Volumes (demo data) are kept.
#   restart     Restart gateway-demo and dashboard-demo only. Data is kept.
#   status      Show `compose ps`, the seed summary and gateway health.
#   logs        Pass through to `compose logs` (e.g. `logs gateway-demo`).
#   pull-model  `ollama pull $OLLAMA_MODEL` inside the bundled ollama-demo container
#               (the stack must already be running with --with-ollama).
#   reset       DELETES this project's containers and volumes (`down -v`) and the
#               seed summary file. Add --rebuild to rebuild and start afterwards.
#
# Options:
#   --with-ollama  Use the bundled ollama-demo container instead of host Ollama:
#                  sets OLLAMA_HOST=http://ollama-demo:11434 and enables the "ollama"
#                  Compose profile. Pass it on every invocation that should include it.
#                  The profile is always enabled for stop/reset/status/logs/pull-model so
#                  a bundled Ollama is never left running by accident.
#
# Environment and files:
#   Reads/creates examples/client-training/.env.local (gitignored). On first run it is
#   generated with a random local MongoDB password; see .env.example for every variable.
#   The repository root .env is never read. HOST_HF_CACHE_DIR is exported (host
#   ~/.cache/huggingface if present, else an empty directory) so the seed job can reuse
#   an already-downloaded embedding model. Requires docker with the compose plugin, curl,
#   and python3 (used for the summary output and as an openssl fallback).
#
# Side effects: creates examples/client-training/logs/ and, only when the user's Docker
# config references a missing "desktop" credential helper, .docker-client/config.json
# (used via DOCKER_CONFIG for this run). Builds local images and Docker volumes; never
# touches the standard stack's databases or volumes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DEMO_ROOT="${PROJECT_ROOT}/examples/client-training"
COMPOSE_FILE="${DEMO_ROOT}/compose.yaml"
COMPOSE_PROJECT="ownhelp_client_training"
ENV_FILE="${DEMO_ROOT}/.env.local"
SUMMARY_FILE="${DEMO_ROOT}/logs/seed_summary.json"

cd "${PROJECT_ROOT}"

ensure_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        echo "[Demo Setup] ERROR: 'docker' CLI not found. Please install Docker Engine / Desktop first." >&2
        exit 1
    fi
    if ! docker compose version >/dev/null 2>&1; then
        echo "[Demo Setup] ERROR: 'docker compose' plugin not available." >&2
        exit 1
    fi

    # Work around stale credsStore: "desktop" in ~/.docker/config.json when docker-credential-desktop is not in PATH
    local user_docker_cfg="${HOME}/.docker/config.json"
    if [ -f "${user_docker_cfg}" ] && grep -q '"credsStore"[[:space:]]*:[[:space:]]*"desktop"' "${user_docker_cfg}" 2>/dev/null; then
        if ! command -v docker-credential-desktop >/dev/null 2>&1; then
            mkdir -p "${DEMO_ROOT}/.docker-client"
            printf '{\n    "auths": {}\n}\n' > "${DEMO_ROOT}/.docker-client/config.json"
            export DOCKER_CONFIG="${DEMO_ROOT}/.docker-client"
        fi
    fi
}

ensure_env_file() {
    mkdir -p "${DEMO_ROOT}/logs/.hf_cache_empty"
    if [ -d "${HOME}/.cache/huggingface" ]; then
        export HOST_HF_CACHE_DIR="${HOME}/.cache/huggingface"
    else
        export HOST_HF_CACHE_DIR="${DEMO_ROOT}/logs/.hf_cache_empty"
    fi

    # First run only: write .env.local with a random database password so no shared default
    # password is used on the user's machine. The values mirror .env.example.
    if [ ! -f "${ENV_FILE}" ]; then
        local rand_pass
        if command -v openssl >/dev/null 2>&1; then
            rand_pass="demo_$(openssl rand -hex 12)"
        else
            rand_pass="demo_$(python3 -c 'import secrets; print(secrets.token_hex(12))')"
        fi

        cat > "${ENV_FILE}" <<EOF
# Auto-generated local demo configuration (gitignored).
# Safe to delete and regenerate via: bash examples/client-training/scripts/setup.sh reset
APP_MODE="preset_training"
MONGODB_DB_NAME="rag_knowledge_base"
MONGODB_TRAINING_DB_NAME="capstone_demo"
MONGODB_COLLECTION_NAME="doc_vectors"

DEMO_MONGO_USER="demo_admin"
DEMO_MONGO_PASSWORD="${rand_pass}"
DEMO_MONGO_PORT="27018"

MONGODB_URI="mongodb://demo_admin:${rand_pass}@mongodb-demo:27017/?directConnection=true&authSource=admin"

DEMO_GATEWAY_PORT="4001"
DEMO_DASHBOARD_PORT="3001"
SESSION_COOKIE_NAME="ownhelp_demo_session"
UPLOAD_STAGING_DIR="/tmp/ownhelp_demo_uploads"
ALLOWED_ORIGINS="http://localhost:3001,http://127.0.0.1:3001"
NEXT_PUBLIC_GATEWAY_URL="http://localhost:4001"

EMBEDDING_MODEL_NAME="BAAI/bge-small-en-v1.5"
OLLAMA_HOST="http://host.docker.internal:11434"
OLLAMA_MODEL="llama3.2:3b"
EOF
        echo "[Demo Setup] Generated isolated client-training settings at examples/client-training/.env.local"
    fi

    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
}

compose_cmd() {
    docker compose --env-file "${ENV_FILE}" -p "${COMPOSE_PROJECT}" -f "${COMPOSE_FILE}" "$@"
}

# Poll until the gateway reports vector_index_ready and the dashboard login page answers.
# The demo-seed one-shot is checked each pass so a seeding failure aborts immediately with
# its logs instead of waiting out the full timeout.
wait_for_ready() {
    local gateway_port="${DEMO_GATEWAY_PORT:-4001}"
    local dashboard_port="${DEMO_DASHBOARD_PORT:-3001}"
    local max_wait=240
    local elapsed=0

    echo "[Demo Setup] Waiting for MongoDB Atlas Local, seed job, gateway, and dashboard to become healthy..."
    while [ "${elapsed}" -lt "${max_wait}" ]; do
        local seed_status
        local seed_id
        seed_id="$(compose_cmd ps -a -q demo-seed)"
        seed_status="$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "${seed_id}" 2>/dev/null || echo 'missing')"
        if [[ "${seed_status}" == exited:* ]] && [[ "${seed_status}" != "exited:0" ]]; then
            echo "[Demo Setup] ERROR: demo-seed container failed (${seed_status}). Logs:" >&2
            compose_cmd logs demo-seed >&2
            exit 1
        fi

        if curl -fsS "http://127.0.0.1:${gateway_port}/api/health" 2>/dev/null | grep -Eq '"vector_index_ready":[[:space:]]*true' && \
           curl -fsS "http://127.0.0.1:${dashboard_port}/login" >/dev/null 2>&1; then
            return 0
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done

    echo "[Demo Setup] ERROR: Timed out after ${max_wait}s waiting for stack readiness." >&2
    compose_cmd ps >&2
    exit 1
}

print_status_summary() {
    local gateway_port="${DEMO_GATEWAY_PORT:-4001}"
    local dashboard_port="${DEMO_DASHBOARD_PORT:-3001}"
    local mongo_port="${DEMO_MONGO_PORT:-27018}"

    echo ""
    echo "======================================================================"
    echo "  OWNHELP CLIENT-TRAINING SANDBOX — STATUS & ENDPOINTS"
    echo "======================================================================"
    echo "  Dashboard UI (One-Click Demo Login): http://localhost:${dashboard_port}/login"
    echo "  Orchestration Gateway API:           http://localhost:${gateway_port}"
    echo "  Gateway Health & Readiness:          http://localhost:${gateway_port}/api/health"
    echo "  Local MongoDB Atlas (Vector Search): 127.0.0.1:${mongo_port} (DB: ${MONGODB_TRAINING_DB_NAME:-capstone_demo})"
    echo "----------------------------------------------------------------------"
    if [ -f "${SUMMARY_FILE}" ]; then
        python3 - "${SUMMARY_FILE}" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
counts = data.get("counts", {})
biz = counts.get("businesses", {})
tix = counts.get("tickets", {})
docs = counts.get("documents_and_vectors", {})
mi = data.get("model_and_index", {})
smoke = mi.get("vector_search_smoke_query", {})
print(f"  Seed Version:       {data.get('seed_version')} (status: {data.get('status')}, {data.get('duration_seconds')}s)")
print(f"  Preset Businesses:  inserted={biz.get('inserted', 0)}, unchanged={biz.get('unchanged', 0)}, skipped_modified={biz.get('skipped_user_modified', 0)}")
print(f"  Sample Tickets:     inserted={tix.get('inserted', 0)}, unchanged={tix.get('unchanged', 0)}, skipped_modified={tix.get('skipped_user_modified', 0)}")
print(f"  Source Documents:   indexed={docs.get('documents_indexed', 0)} across {docs.get('tenants_ingested', 0)} ingested / {docs.get('tenants_unchanged', 0)} unchanged tenants")
print(f"  Vector Chunks:      inserted={docs.get('chunks_inserted', 0)}, existing={docs.get('chunks_existing', 0)} (index '{mi.get('vector_index_name')}': ready={mi.get('index_ready')})")
print(f"  $vectorSearch Test: verified={smoke.get('verified')} (tenant={smoke.get('tenant_id')}, top_doc={smoke.get('top_doc_id')}, hits={smoke.get('result_count')}, score={smoke.get('top_score'):.4f})" if isinstance(smoke.get("top_score"), (int, float)) else f"  $vectorSearch Test: verified={smoke.get('verified')}")
PY
    fi

    local health_json
    if health_json="$(curl -fsS "http://127.0.0.1:${gateway_port}/api/health" 2>/dev/null)"; then
        python3 - "${health_json}" <<'PY'
import json, sys
h = json.loads(sys.argv[1])
print("----------------------------------------------------------------------")
print(f"  Gateway Mode:       {h.get('app_mode')}")
print(f"  Database Ready:     {h.get('database_ready')}")
print(f"  Vector Index Ready: {h.get('vector_index_ready')}")
print(f"  Ollama Reachable:   {h.get('ollama_reachable')} (model '{h.get('model_requested')}' ready: {h.get('ollama_ready')})")
if not h.get("ollama_ready"):
    print("  [Note] Management dashboard, auth, ticket queue, chunk explorer,upload,")
    print("         and $vectorSearch work immediately without Ollama.")
    print(f"         For live LLM generation, run on host: ollama serve && ollama pull {h.get('model_requested')}")
PY
    fi
    echo "======================================================================"
}

# TODO(setup-args): the first argument is always taken as the action, so `setup.sh --with-ollama`
# fails with the usage line (it must be `setup.sh setup --with-ollama`). Fix: if $1 starts with
# "--", treat the action as "setup" and keep $1 in the argument list.
ACTION="${1:-setup}"
shift || true

ensure_docker
ensure_env_file

# --with-ollama runs a bundled, project-scoped Ollama container instead of the host Ollama,
# so the whole sandbox lives inside the ownhelp_client_training project.
WITH_OLLAMA=0
REMAINING_ARGS=()
for arg in "$@"; do
    if [ "${arg}" = "--with-ollama" ]; then
        WITH_OLLAMA=1
    else
        REMAINING_ARGS+=("${arg}")
    fi
done
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"

if [ "${WITH_OLLAMA}" -eq 1 ]; then
    export OLLAMA_HOST="http://ollama-demo:11434"
fi
# The profile is always enabled for stop/reset/status/logs so a bundled Ollama is never orphaned.
if [ "${WITH_OLLAMA}" -eq 1 ] || [[ "${ACTION}" =~ ^(stop|reset|status|logs|pull-model)$ ]]; then
    export COMPOSE_PROFILES="ollama"
fi

case "${ACTION}" in
    setup)
        echo "[Demo Setup] Building and starting isolated local demo stack (${COMPOSE_PROJECT})..."
        compose_cmd build dashboard-demo
        compose_cmd build gateway-demo
        compose_cmd up -d "$@"
        wait_for_ready
        print_status_summary
        ;;
    start)
        echo "[Demo Setup] Starting local demo stack (${COMPOSE_PROJECT})..."
        compose_cmd up -d "$@"
        wait_for_ready
        print_status_summary
        ;;
    stop)
        echo "[Demo Setup] Stopping local demo containers (preserving demo volumes)..."
        compose_cmd stop "$@"
        ;;
    restart)
        echo "[Demo Setup] Restarting local demo gateway and dashboard (preserving demo data)..."
        compose_cmd restart gateway-demo dashboard-demo "$@"
        wait_for_ready
        print_status_summary
        ;;
    status)
        compose_cmd ps
        print_status_summary
        ;;
    logs)
        compose_cmd logs "$@"
        ;;
    pull-model)
        # Downloads OLLAMA_MODEL into the bundled Ollama container (requires a prior setup/start --with-ollama).
        echo "[Demo Setup] Pulling '${OLLAMA_MODEL:-llama3.2:3b}' into the bundled Ollama container..."
        compose_cmd exec ollama-demo ollama pull "${OLLAMA_MODEL:-llama3.2:3b}"
        ;;
    reset)
        echo "[Demo Setup] Resetting ONLY local demo containers and volumes for project '${COMPOSE_PROJECT}'..."
        compose_cmd down -v --remove-orphans
        rm -f "${SUMMARY_FILE}"
        echo "[Demo Setup] Demo volumes removed cleanly. Standard databases and root .env were not touched."
        if [[ "${1:-}" == "--rebuild" ]]; then
            shift
            compose_cmd build dashboard-demo
            compose_cmd build gateway-demo
            compose_cmd up -d "$@"
            wait_for_ready
            print_status_summary
        fi
        ;;
    *)
        echo "Usage: bash examples/client-training/scripts/setup.sh [setup|start|stop|restart|status|logs|pull-model|reset [--rebuild]] [--with-ollama]" >&2
        exit 1
        ;;
esac

