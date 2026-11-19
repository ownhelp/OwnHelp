"""Generate .env.compose.local for the OwnHelp Docker stack without modifying the existing .env.

Usage:
    python scripts/setup_stack.py --model-dir DIR --model-sha256 HEX64 [--output PATH]

Arguments:
    --model-dir     Directory containing Llama-3.2-3B-Instruct.Q4_K_M.gguf (required).
    --model-sha256  Expected SHA-256 of that file, 64 hex characters (required).
    --output        File to create (default: .env.compose.local in the project root).

Environment: MONGODB_URI, your MongoDB Atlas connection string (mongodb+srv:// or mongodb://).
If it is not set, you are asked for it with a hidden prompt. It is deliberately NOT a command-line
argument, so it never lands in your shell history or the process list.

Side effects: hashes the GGUF (read-only), then creates --output with mode 0600 containing the
Atlas URI and fresh random secrets (CHAT_BACKEND_TOKEN, CHAT_FOLLOW_UP_SECRET). Refuses to
overwrite an existing file and writes nothing if the checksum does not match or the URI is
malformed. Makes no network calls and starts no services. Secret values are never printed.
"""

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src.deployment.config import configure_stack, obtain_mongodb_uri


def main():
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog=(
            "Set MONGODB_URI in the environment or enter it at the hidden prompt; it is never a "
            "command-line argument. Creates the file with mode 0600, never overwrites an existing "
            "one, makes no network calls and starts no services."
        ),
    )
    parser.add_argument("--model-dir", required=True, type=Path,
                        help="Directory containing Llama-3.2-3B-Instruct.Q4_K_M.gguf.")
    parser.add_argument("--model-sha256", required=True,
                        help="Expected SHA-256 of the GGUF (64 hex characters); setup stops on mismatch.")
    parser.add_argument("--output", type=Path, default=ROOT / ".env.compose.local",
                        help="Configuration file to create (default: .env.compose.local).")
    args = parser.parse_args()
    if args.output.exists():
        parser.exit(1, "Setup failed: Configuration already exists; keep it to preserve credentials and follow-up tokens.\n")
    try:
        uri = obtain_mongodb_uri()
        path = configure_stack(args.model_dir, args.model_sha256, args.output, uri)
    except (OSError, ValueError, EOFError) as exc:
        parser.exit(1, f"Setup failed: {exc}\n")
    print(f"Verified the GGUF and created {path.name} with private permissions. No services started.")


if __name__ == "__main__":
    main()
