"""Protects safe re-ingestion (insert new chunks before deleting old) and ingestion progress stages, offline with fakes."""

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.rag.ingestor import RAGDocumentIngestor  # noqa: E402


class FakeCollection:
    """In-memory collection supporting equality, $in and $nin on the fields the ingestor filters by."""

    def __init__(self, rows=None, fail_insert_after=None):
        self.rows = list(rows or [])
        self.fail_insert_after = fail_insert_after
        self.calls = []

    @staticmethod
    def _matches(row, query):
        for key, cond in query.items():
            if isinstance(cond, dict):
                if "$in" in cond and row.get(key) not in cond["$in"]:
                    return False
                if "$nin" in cond and row.get(key) in cond["$nin"]:
                    return False
            elif row.get(key) != cond:
                return False
        return True

    def insert_many(self, docs):
        self.calls.append("insert_many")
        for index, doc in enumerate(docs):
            if self.fail_insert_after is not None and index >= self.fail_insert_after:
                raise RuntimeError("insert failed")
            self.rows.append(dict(doc))

    def delete_many(self, query):
        self.calls.append("delete_many")
        self.rows = [row for row in self.rows if not self._matches(row, query)]


def make_ingestor(collection):
    ingestor = object.__new__(RAGDocumentIngestor)
    ingestor.document_parser, ingestor.chunk_size, ingestor.chunk_overlap = "legacy", 500, 75
    ingestor.model = Mock()
    ingestor.model.encode.side_effect = lambda texts, **kw: [Mock(tolist=lambda: [0.1, 0.2]) for _ in texts]
    ingestor.collection = collection
    return ingestor


def old_rows():
    return [
        {"_id": f"old{i}", "tenant_id": "t1", "doc_id": "a", "text": "old"} for i in range(2)
    ] + [{"_id": "other", "tenant_id": "t2", "doc_id": "a", "text": "other tenant"}]


class ReplaceChunksTests(unittest.TestCase):
    def test_success_inserts_first_then_removes_only_old_rows_in_scope(self):
        collection = FakeCollection(old_rows())
        ingestor = make_ingestor(collection)
        docs = [{"tenant_id": "t1", "doc_id": "a", "text": "new"}]
        self.assertEqual(ingestor.replace_chunks({"tenant_id": "t1"}, docs), 1)
        self.assertEqual(collection.calls, ["insert_many", "delete_many"])
        texts = sorted(row["text"] for row in collection.rows)
        self.assertEqual(texts, ["new", "other tenant"])

    def test_failed_insert_keeps_old_data_and_cleans_partial_new_rows(self):
        collection = FakeCollection(old_rows(), fail_insert_after=1)
        ingestor = make_ingestor(collection)
        docs = [{"tenant_id": "t1", "doc_id": "a", "text": f"new{i}"} for i in range(3)]
        with self.assertRaises(RuntimeError):
            ingestor.replace_chunks({"tenant_id": "t1"}, docs)
        self.assertEqual(sorted(row["_id"] for row in collection.rows), ["old0", "old1", "other"])

    def test_cleanup_failure_does_not_mask_the_insert_error(self):
        collection = Mock()
        collection.insert_many.side_effect = RuntimeError("insert failed")
        collection.delete_many.side_effect = ValueError("cleanup failed")
        ingestor = make_ingestor(collection)
        with self.assertRaisesRegex(RuntimeError, "insert failed"):
            ingestor.replace_chunks({"tenant_id": "t1"}, [{"text": "x"}])

    def test_document_scope_leaves_other_documents_of_the_tenant(self):
        rows = old_rows() + [{"_id": "b0", "tenant_id": "t1", "doc_id": "b", "text": "keep"}]
        collection = FakeCollection(rows)
        ingestor = make_ingestor(collection)
        ingestor.replace_chunks({"tenant_id": "t1", "doc_id": "a"}, [{"tenant_id": "t1", "doc_id": "a", "text": "new"}])
        self.assertEqual(sorted(row["text"] for row in collection.rows), ["keep", "new", "other tenant"])

    def test_schema_gains_no_fields_beyond_object_id(self):
        collection = FakeCollection()
        ingestor = make_ingestor(collection)
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "faq.md").write_text("# Returns\n\nThirty days.\n", encoding="utf-8")
            ingestor.ingest_tenant_directory("t1", Path(tmp))
        self.assertEqual(
            set(collection.rows[0]),
            {"_id", "tenant_id", "doc_id", "section", "chunk_index", "text", "embedding", "created_at"},
        )


class ProgressTests(unittest.TestCase):
    def test_ingest_tenant_directory_reports_stages_in_order(self):
        ingestor = make_ingestor(FakeCollection())
        stages = []
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "faq.md").write_text("# Returns\n\nThirty days.\n", encoding="utf-8")
            ingestor.ingest_tenant_directory("t1", Path(tmp), progress_callback=stages.append)
        self.assertEqual(stages, ["parsing", "embedding", "writing"])

    def test_no_callback_is_the_default(self):
        ingestor = make_ingestor(FakeCollection())
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "faq.md").write_text("# Returns\n\nThirty days.\n", encoding="utf-8")
            self.assertEqual(ingestor.ingest_tenant_directory("t1", Path(tmp)), 1)

    def test_stage_emitter_writes_one_json_line_per_stage(self):
        from scripts.ingest_uploaded_document import make_stage_emitter

        stream = io.StringIO()
        emit = make_stage_emitter(stream)
        emit("parsing")
        emit("embedding")
        lines = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(lines, [
            {"event": "stage", "stage": "parsing"},
            {"event": "stage", "stage": "embedding"},
        ])


if __name__ == "__main__":
    unittest.main()
