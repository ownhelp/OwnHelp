"""Reads recorded chat turns (``conversation_logs``) and turns them into export files and summary numbers.

The gateway writes one document per answered turn, only for tenants that opted in and only when the
widget showed its recording notice. This module is read-only: it never writes to the database.

Outputs:
    * ``to_conversations``: turns grouped by ``conversation_id`` (oldest first), each with its turns.
    * ``summarize``: counts and averages useful for a write-up (answer/escalate split, confidence,
      latency, how often retrieval returned documents).
    * ``write_json`` / ``write_csv``: JSON uses 4-space indentation, per the project standard.
Callers: ``scripts/export_conversations.py``.
"""

from __future__ import annotations

import csv
import json
import os
from collections import defaultdict
from pathlib import Path
from statistics import mean, median
from typing import Any, Iterable

CSV_COLUMNS = [
    "created_at",
    "conversation_id",
    "question",
    "answer",
    "action",
    "confidence",
    "cited_sources",
    "retrieved_doc_ids",
    "top_retrieval_score",
    "latency_ms",
    "temperature",
    "max_context_chunks",
    "similarity_threshold",
    "custom_core_policy",
    "policy_version",
    "model",
]


def fetch_turns(
    tenant_id: str,
    *,
    mongo_uri: str | None = None,
    db_name: str | None = None,
    since: str | None = None,
    until: str | None = None,
    env_file: Path | None = None,
) -> list[dict[str, Any]]:
    """Loads one tenant's recorded turns, oldest first. ``since``/``until`` are UTC ISO strings."""
    from dotenv import load_dotenv
    from pymongo import MongoClient

    if env_file is not None and Path(env_file).exists():
        load_dotenv(dotenv_path=env_file, override=False)
    uri = mongo_uri or os.getenv("MONGODB_URI")
    if not uri:
        raise ValueError("MONGODB_URI is not set. Put it in .env.dev or the environment.")
    name = db_name or os.getenv("MONGODB_DB_NAME") or "rag_knowledge_base"

    query: dict[str, Any] = {"tenant_id": tenant_id}
    window: dict[str, str] = {}
    if since:
        window["$gte"] = since
    if until:
        window["$lt"] = until
    if window:
        query["created_at"] = window

    client = MongoClient(uri, serverSelectionTimeoutMS=8000)
    try:
        cursor = client[name]["conversation_logs"].find(query, {"_id": 0}).sort("created_at", 1)
        return list(cursor)
    finally:
        client.close()


def to_conversations(turns: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Groups turns by conversation, keeping each conversation's turns in time order."""
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for turn in sorted(turns, key=lambda item: item.get("created_at", "")):
        grouped[turn.get("conversation_id", "unknown")].append(turn)
    conversations = []
    for conversation_id, items in grouped.items():
        conversations.append(
            {
                "conversation_id": conversation_id,
                "started_at": items[0].get("created_at"),
                "turn_count": len(items),
                "escalated": any(item.get("action") == "escalate" for item in items),
                "turns": items,
            }
        )
    conversations.sort(key=lambda item: item["started_at"] or "")
    return conversations


def summarize(turns: list[dict[str, Any]]) -> dict[str, Any]:
    """Headline numbers for the recorded turns (all fields tolerate missing values)."""
    total = len(turns)
    confidences = [t["confidence"] for t in turns if isinstance(t.get("confidence"), (int, float))]
    latencies = [t["latency_ms"] for t in turns if isinstance(t.get("latency_ms"), (int, float))]
    escalated = sum(1 for t in turns if t.get("action") == "escalate")
    no_retrieval = sum(1 for t in turns if not t.get("retrieved"))
    return {
        "turns": total,
        "conversations": len({t.get("conversation_id") for t in turns}),
        "answered": total - escalated,
        "escalated": escalated,
        "escalation_rate": round(escalated / total, 4) if total else None,
        "turns_with_no_retrieved_documents": no_retrieval,
        "mean_confidence": round(mean(confidences), 4) if confidences else None,
        "median_latency_ms": round(median(latencies)) if latencies else None,
        "first_turn_at": turns[0].get("created_at") if turns else None,
        "last_turn_at": turns[-1].get("created_at") if turns else None,
    }


def write_json(path: Path, turns: list[dict[str, Any]]) -> None:
    """Writes summary, grouped conversations and flat turns as one JSON file (4-space indent)."""
    payload = {
        "summary": summarize(turns),
        "conversations": to_conversations(turns),
    }
    Path(path).write_text(json.dumps(payload, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")


def _csv_row(turn: dict[str, Any]) -> dict[str, Any]:
    retrieved = turn.get("retrieved") or []
    settings = turn.get("settings") or {}
    scores = [r.get("score") for r in retrieved if isinstance(r.get("score"), (int, float))]
    return {
        "created_at": turn.get("created_at"),
        "conversation_id": turn.get("conversation_id"),
        "question": turn.get("question"),
        "answer": turn.get("answer"),
        "action": turn.get("action"),
        "confidence": turn.get("confidence"),
        "cited_sources": ";".join(turn.get("cited_sources") or []),
        "retrieved_doc_ids": ";".join(str(r.get("doc_id", "")) for r in retrieved),
        "top_retrieval_score": max(scores) if scores else None,
        "latency_ms": turn.get("latency_ms"),
        "temperature": settings.get("temperature"),
        "max_context_chunks": settings.get("max_context_chunks"),
        "similarity_threshold": settings.get("similarity_threshold"),
        "custom_core_policy": settings.get("custom_core_policy"),
        "policy_version": turn.get("policy_version"),
        "model": turn.get("model"),
    }


def write_csv(path: Path, turns: list[dict[str, Any]]) -> None:
    """One row per turn, for spreadsheets and charting."""
    with open(path, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for turn in turns:
            writer.writerow(_csv_row(turn))
