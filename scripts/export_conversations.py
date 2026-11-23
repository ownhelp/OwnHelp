"""CLI runner that exports a tenant's recorded chat conversations for analysis.

Usage:
    .venv/bin/python -m scripts.export_conversations --tenant TENANT_ID --out conversations.json
    .venv/bin/python -m scripts.export_conversations --tenant TENANT_ID --out turns.csv --format csv \
        [--since 2026-11-01] [--until 2026-12-01] [--db-name DB]

Read-only. Environment (process environment first, then .env.dev in the project root): MONGODB_URI
(required), MONGODB_DB_NAME (default rag_knowledge_base). JSON output is 4-space indented and holds
a summary plus conversations grouped by conversation_id; CSV is one row per turn.
Recording itself is switched on per business in the dashboard (Profile > Conversation Recording).
The export is written wherever --out points: keep it outside the repository, since it contains
visitors' messages. Prints the summary to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from src.analytics.conversation_export import fetch_turns, summarize, write_csv, write_json  # noqa: E402


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export recorded chat conversations for one tenant.")
    parser.add_argument("--tenant", required=True, help="tenant_id to export.")
    parser.add_argument("--out", required=True, type=Path, help="Output file path.")
    parser.add_argument("--format", choices=["json", "csv"], default=None, help="Default: inferred from --out.")
    parser.add_argument("--since", default=None, help="Only turns at or after this UTC date/time (ISO, e.g. 2026-11-01).")
    parser.add_argument("--until", default=None, help="Only turns before this UTC date/time (ISO).")
    parser.add_argument("--db-name", default=None, help="Database name (default: MONGODB_DB_NAME).")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    fmt = args.format or ("csv" if args.out.suffix.lower() == ".csv" else "json")
    try:
        turns = fetch_turns(
            args.tenant,
            db_name=args.db_name,
            since=args.since,
            until=args.until,
            env_file=PROJECT_ROOT / ".env.dev",
        )
    except ValueError as error:
        print(json.dumps({"status": "error", "error": str(error)}, indent=4), file=sys.stderr)
        return 1
    if not turns:
        print(json.dumps({"status": "empty", "tenant_id": args.tenant, "turns": 0}, indent=4))
        return 0
    (write_csv if fmt == "csv" else write_json)(args.out, turns)
    print(json.dumps({"status": "success", "tenant_id": args.tenant, "file": str(args.out), "format": fmt, **summarize(turns)}, indent=4))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
