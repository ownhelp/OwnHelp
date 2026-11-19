"""Create a private configuration for the standard OwnHelp Compose stack.

Inputs: the directory holding the GGUF model, its expected SHA-256, the MongoDB Atlas connection
string and an output path. Output: a new mode-0600 env file with the Atlas URI, freshly generated
secrets (chat backend token, follow-up secret) and fixed stack settings (ports, model tag, allowed
origins). The checksum and the URI scheme are verified first so a corrupted model or a malformed
URI is rejected before any file is written.
Callers: ``scripts/setup_stack.py``; the resulting file is read by the Docker Compose stack.
Secrets are generated here, never hard-coded, and the function refuses to overwrite an existing
file so credentials already in use are not rotated by accident. The Atlas URI is a credential:
it is never logged, returned or accepted as a command-line argument.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from typing import Callable, Mapping, Optional

GGUF_FILENAME = "Llama-3.2-3B-Instruct.Q4_K_M.gguf"
URI_SCHEMES = ("mongodb+srv://", "mongodb://")


def validate_mongodb_uri(uri: str) -> str:
    """Return the stripped URI, or raise ValueError (without echoing it) if it is unusable."""
    uri = uri.strip()
    if not uri.startswith(URI_SCHEMES):
        raise ValueError("The MongoDB URI must start with mongodb+srv:// or mongodb://.")
    if any(char in uri for char in "\r\n\x00") or any(char.isspace() for char in uri):
        raise ValueError("The MongoDB URI must not contain whitespace or line breaks.")
    if "$" in uri or '"' in uri or "\\" in uri:
        raise ValueError("Percent-encode special characters ($, quote, backslash) in the URI credentials.")
    if "<" in uri or ">" in uri:
        raise ValueError("The MongoDB URI still contains a <placeholder>; use the real connection string.")
    return uri


def obtain_mongodb_uri(
    environ: Optional[Mapping[str, str]] = None,
    prompt: Optional[Callable[[str], str]] = None,
) -> str:
    """Read the Atlas URI from MONGODB_URI, else from a hidden prompt; never from argv.

    ``prompt`` defaults to ``getpass.getpass`` (no echo). The value is validated but never printed.
    """
    environ = os.environ if environ is None else environ
    uri = environ.get("MONGODB_URI", "").strip()
    if not uri:
        if prompt is None:
            from getpass import getpass
            prompt = getpass
        uri = prompt("MongoDB Atlas connection string (input hidden): ")
    return validate_mongodb_uri(uri)


def file_sha256(path: Path) -> str:
    """Streams the file in 1 MiB reads so a multi-GB GGUF is hashed without loading it into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configure_stack(model_dir: Path, expected_sha256: str, output: Path, mongodb_uri: str) -> Path:
    """Verify the source artifact and URI, then create, never replace, a mode-0600 env file.

    Existing .env files and source model files are never modified, and configuration values
    (including the Atlas URI) are not returned for logging.
    """
    mongodb_uri = validate_mongodb_uri(mongodb_uri)
    if output.exists():
        raise FileExistsError("Configuration already exists; keep it to preserve credentials and follow-up tokens.")
    directory = model_dir.expanduser().resolve(strict=True)
    if any(char in str(directory) for char in "\r\n"):
        raise ValueError("The model directory must not contain line breaks.")
    expected_sha256 = expected_sha256.strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Provide a complete SHA256 digest.")
    source = directory / GGUF_FILENAME
    if not source.is_file():
        raise ValueError(f"The model directory must contain {GGUF_FILENAME}.")
    if file_sha256(source) != expected_sha256:
        raise ValueError("The GGUF checksum does not match; no configuration was written.")
    values = {
        "MONGODB_URI": mongodb_uri,
        "MONGODB_DB_NAME": "rag_knowledge_base",
        "CHAT_BACKEND_TOKEN": secrets.token_hex(32),
        "CHAT_FOLLOW_UP_SECRET": secrets.token_hex(32),
        "MODEL_GGUF_DIR": str(directory),
        "MODEL_GGUF_SHA256": expected_sha256,
        "OLLAMA_MODEL": "llama3.2:3b-qlora-hardneg-full01-q4",
        "OLLAMA_IMAGE": "ollama/ollama:0.40.16",
        "GATEWAY_PORT": "4002",
        "DASHBOARD_PORT": "3002",
        "NEXT_PUBLIC_GATEWAY_URL": "http://localhost:4002",
        "ALLOWED_ORIGINS": "http://localhost:3002,http://127.0.0.1:3002",
        "SESSION_COOKIE_NAME": "ownhelp_session",
    }
    content = "# Private local Compose configuration. Preserve this file across restarts.\n"
    content += "\n".join(f"{key}={json.dumps(value, ensure_ascii=False)}" for key, value in values.items()) + "\n"
    # O_EXCL + mode 0600 at creation: the file is never world-readable, even briefly, and a
    # concurrent run cannot overwrite it.
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as handle:
        handle.write(content)
    return output
