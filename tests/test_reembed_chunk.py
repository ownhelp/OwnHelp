"""Protects manual chunk editing: text and embedding change together, nothing is written on failure, tenants are isolated. Offline with fakes."""

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.rag.reembed import MAX_CHUNK_CHARS, ChunkEditError, reembed_chunk  # noqa: E402


class FakeVector(list):
    def tolist(self):
        return list(self)


class FakeModel:
    max_seq_length = 10

    def __init__(self, fail=False):
        self.fail = fail
        self.encoded = []

    def tokenizer(self, text, truncation=False, add_special_tokens=True):
        return {"input_ids": text.split()}

    def encode(self, texts, **kwargs):
        if self.fail:
            raise RuntimeError("model down")
        self.encoded.extend(texts)
        return [FakeVector([0.5, 0.25]) for _ in texts]


class FakeCollection:
    def __init__(self, rows):
        self.rows = rows
        self.updates = []

    def _find(self, scope):
        return next((r for r in self.rows if all(r.get(k) == v for k, v in scope.items())), None)

    def find_one(self, scope, projection=None):
        return self._find(scope)

    def update_one(self, scope, update):
        row = self._find(scope)
        self.updates.append((scope, update))
        if row is None:
            return SimpleNamespace(matched_count=0)
        row.update(update["$set"])
        return SimpleNamespace(matched_count=1)


def rows():
    return [
        {"tenant_id": "a", "doc_id": "D", "chunk_index": 0, "section": "S", "text": "old", "embedding": [1, 1], "created_at": "t"},
        {"tenant_id": "b", "doc_id": "D", "chunk_index": 0, "section": "S", "text": "other", "embedding": [9, 9], "created_at": "t"},
    ]


class ReembedChunkTests(unittest.TestCase):
    def test_updates_text_and_embedding_together_and_adds_no_fields(self):
        collection, model = FakeCollection(rows()), FakeModel()
        result = reembed_chunk(collection, model, "a", "D", 0, "  new text  ")
        self.assertEqual(result, {"text": "new text", "section": "S", "char_count": 8})
        self.assertEqual(len(collection.updates), 1)
        self.assertEqual(set(collection.updates[0][1]["$set"]), {"text", "embedding"})
        self.assertEqual(collection.rows[0]["text"], "new text")
        self.assertEqual(collection.rows[0]["embedding"], [0.5, 0.25])
        self.assertEqual(model.encoded, ["new text"])
        self.assertEqual(set(collection.rows[0]), {"tenant_id", "doc_id", "chunk_index", "section", "text", "embedding", "created_at"})

    def test_other_tenant_chunk_is_never_touched(self):
        collection = FakeCollection(rows())
        with self.assertRaises(ChunkEditError) as ctx:
            reembed_chunk(collection, FakeModel(), "a", "D", 5, "x")
        self.assertEqual(ctx.exception.code, "NOT_FOUND")
        self.assertEqual(collection.rows[1]["text"], "other")
        self.assertEqual(collection.updates, [])
        # tenant c owns nothing even though doc D / index 0 exists for others
        with self.assertRaises(ChunkEditError):
            reembed_chunk(collection, FakeModel(), "c", "D", 0, "x")
        self.assertEqual(collection.updates, [])

    def test_embedding_failure_writes_nothing(self):
        collection = FakeCollection(rows())
        with self.assertRaises(RuntimeError):
            reembed_chunk(collection, FakeModel(fail=True), "a", "D", 0, "new")
        self.assertEqual(collection.updates, [])
        self.assertEqual(collection.rows[0]["text"], "old")
        self.assertEqual(collection.rows[0]["embedding"], [1, 1])

    def test_over_token_limit_is_rejected_not_truncated(self):
        collection = FakeCollection(rows())
        with self.assertRaises(ChunkEditError) as ctx:
            reembed_chunk(collection, FakeModel(), "a", "D", 0, " ".join(["w"] * 11))
        self.assertEqual(ctx.exception.code, "VALIDATION_ERROR")
        self.assertEqual(collection.updates, [])

    def test_rejects_bad_text_and_indexes(self):
        collection = FakeCollection(rows())
        for bad in ["", "   ", None, 5, "x" * (MAX_CHUNK_CHARS + 1)]:
            with self.assertRaises(ChunkEditError):
                reembed_chunk(collection, FakeModel(), "a", "D", 0, bad)
        for bad_index in [-1, "0", True, None]:
            with self.assertRaises(ChunkEditError):
                reembed_chunk(collection, FakeModel(), "a", "D", bad_index, "ok")
        self.assertEqual(collection.updates, [])


if __name__ == "__main__":
    unittest.main()
