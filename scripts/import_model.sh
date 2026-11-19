#!/bin/sh
# One-shot Ollama initialization; only local container storage is modified.
#
# Runs inside the compose.yaml `model-init` service (entrypoint), not on the host. Takes no
# arguments; everything comes from the environment:
#   OLLAMA_MODEL             required  tag to register, e.g. llama3.2:3b-qlora-hardneg-full01-q4
#   MODEL_GGUF_SHA256        required  expected SHA-256 of the GGUF
#   OLLAMA_HOST              set by Compose to the ollama service
#   MODEL_IMPORT_DIR         optional  directory with the GGUF and Modelfile (default /model-import)
#   MODEL_IMPORT_STATE_DIR   optional  fingerprint store (default /root/.ollama/ownhelp-imports)
#
# Steps: (1) fail if the GGUF or Modelfile is missing; (2) fail unless the GGUF SHA-256 matches;
# (3) skip the import when a fingerprint (GGUF hash, Modelfile hash, installed Modelfile hash)
# from a previous run still matches; (4) otherwise `ollama create`, then record the fingerprint.
# Exit 0 on success or skip, 1 on any failure. The mounted source files are never modified.
set -eu

: "${OLLAMA_MODEL:?Set OLLAMA_MODEL}"
: "${MODEL_GGUF_SHA256:?Set MODEL_GGUF_SHA256}"
import_dir="${MODEL_IMPORT_DIR:-/model-import}"
state_dir="${MODEL_IMPORT_STATE_DIR:-/root/.ollama/ownhelp-imports}"
gguf="$import_dir/Llama-3.2-3B-Instruct.Q4_K_M.gguf"
recipe="$import_dir/Modelfile"

if [ ! -f "$gguf" ] || [ ! -f "$recipe" ]; then
    echo "Missing GGUF or import recipe; refusing to use a fallback model." >&2
    exit 1
fi
actual_sha=$(sha256sum "$gguf" | cut -d ' ' -f 1)
if [ "$actual_sha" != "$MODEL_GGUF_SHA256" ]; then
    echo "GGUF checksum mismatch; model import stopped." >&2
    exit 1
fi
recipe_sha=$(sha256sum "$recipe" | cut -d ' ' -f 1)
key=$(printf '%s' "$OLLAMA_MODEL" | sha256sum | cut -d ' ' -f 1)
mkdir -p "$state_dir"
state="$state_dir/$key"
installed=$(ollama show "$OLLAMA_MODEL" --modelfile 2>/dev/null || true)
installed_sha=$(printf '%s' "$installed" | sha256sum | cut -d ' ' -f 1)
fingerprint=$(printf '%s\n%s\n%s' "$actual_sha" "$recipe_sha" "$installed_sha")
if [ -n "$installed" ] && [ -f "$state" ] && [ "$(cat "$state")" = "$fingerprint" ]; then
    echo "Verified model already imported; retaining its persistent state."
    exit 0
fi
ollama create "$OLLAMA_MODEL" -f "$recipe"
installed=$(ollama show "$OLLAMA_MODEL" --modelfile)
if [ -z "$installed" ]; then
    echo "Imported model could not be verified." >&2
    exit 1
fi
installed_sha=$(printf '%s' "$installed" | sha256sum | cut -d ' ' -f 1)
printf '%s\n%s\n%s\n' "$actual_sha" "$recipe_sha" "$installed_sha" > "$state.tmp"
mv "$state.tmp" "$state"
echo "Verified and imported the selected GGUF into containerized Ollama."
