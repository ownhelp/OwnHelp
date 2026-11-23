"""Protects the conversation export: grouping, summary numbers, JSON indent and CSV shape. Offline, no database."""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.analytics.conversation_export import CSV_COLUMNS, summarize, to_conversations, write_csv, write_json  # noqa: E402

TURNS = [
    {
        "conversation_id": "CONV-A", "created_at": "2026-11-23T05:30:00.000Z", "question": "Second?", "answer": "B",
        "action": "escalate", "confidence": 0.4, "cited_sources": [], "retrieved": [], "latency_ms": 900,
        "settings": {"temperature": 0.2, "max_context_chunks": 4, "similarity_threshold": 0.7, "custom_core_policy": False},
        "policy_version": "v1", "model": "m",
    },
    {
        "conversation_id": "CONV-A", "created_at": "2026-11-23T05:29:00.000Z", "question": "First?", "answer": "A",
        "action": "answer", "confidence": 0.9, "cited_sources": ["DOC"],
        "retrieved": [{"doc_id": "DOC", "section": "S", "score": 0.8}, {"doc_id": "OTHER", "section": "T", "score": 0.6}],
        "latency_ms": 500,
        "settings": {"temperature": 0.2, "max_context_chunks": 4, "similarity_threshold": 0.7, "custom_core_policy": False},
        "policy_version": "v1", "model": "m",
    },
    {
        "conversation_id": "CONV-B", "created_at": "2026-11-23T06:00:00.000Z", "question": "Solo?", "answer": "C",
        "action": "answer", "confidence": 0.8, "cited_sources": ["DOC"], "retrieved": [{"doc_id": "DOC", "section": "S", "score": 0.7}],
        "latency_ms": 700, "settings": {}, "policy_version": "v1", "model": "m",
    },
]


class ConversationExportTests(unittest.TestCase):
    def test_turns_are_grouped_by_conversation_in_time_order(self):
        conversations = to_conversations(TURNS)
        self.assertEqual([c["conversation_id"] for c in conversations], ["CONV-A", "CONV-B"])
        first = conversations[0]
        self.assertEqual([t["question"] for t in first["turns"]], ["First?", "Second?"])
        self.assertEqual(first["turn_count"], 2)
        self.assertTrue(first["escalated"])
        self.assertFalse(conversations[1]["escalated"])

    def test_summary_numbers(self):
        ordered = sorted(TURNS, key=lambda t: t["created_at"])
        summary = summarize(ordered)
        self.assertEqual(summary["turns"], 3)
        self.assertEqual(summary["conversations"], 2)
        self.assertEqual((summary["answered"], summary["escalated"]), (2, 1))
        self.assertEqual(summary["escalation_rate"], 0.3333)
        self.assertEqual(summary["turns_with_no_retrieved_documents"], 1)
        self.assertEqual(summary["mean_confidence"], 0.7)
        self.assertEqual(summary["median_latency_ms"], 700)
        self.assertEqual(summarize([])["escalation_rate"], None)

    def test_json_is_four_space_indented_and_csv_has_one_row_per_turn(self):
        with tempfile.TemporaryDirectory() as folder:
            json_path, csv_path = Path(folder) / "out.json", Path(folder) / "out.csv"
            write_json(json_path, TURNS)
            text = json_path.read_text(encoding="utf-8")
            self.assertIn('\n    "summary": {', text)
            self.assertEqual(len(json.loads(text)["conversations"]), 2)
            write_csv(csv_path, TURNS)
            with open(csv_path, newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(list(rows[0].keys()), CSV_COLUMNS)
            self.assertEqual(len(rows), 3)
            first = next(r for r in rows if r["question"] == "First?")
            self.assertEqual(first["retrieved_doc_ids"], "DOC;OTHER")
            self.assertEqual(first["top_retrieval_score"], "0.8")


if __name__ == "__main__":
    unittest.main()
