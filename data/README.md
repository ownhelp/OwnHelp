# data/

Source documents for the five mock tenants, plus the fixture that describes them. These files are the retrieval corpus and the training and evaluation data. They are not project documentation, so do not reword them.

## Layout

| Path | Contents |
| :--- | :--- |
| `cinder_and_salt/` | A bakery: 4 Markdown policy documents, `faq_support_knowledgebase.json`, `daily_bake_matrix.json` |
| `harbor_view/` | A veterinary clinic: 4 Markdown documents, `faq_support_knowledgebase.json`, `preventive_care_matrix.json` |
| `iron_and_oak/` | A provisions and goods store: 4 Markdown documents, `faq_support_knowledgebase.json`, `sizing_specs.json` |
| `kettle_and_loom/` | A cleaning and remediation service: 4 Markdown documents, `faq_support_knowledgebase.json`, `service_scope_matrix.json` |
| `northstar_auto/` | An auto shop: 4 Markdown documents, `faq_support_knowledgebase.json`, `service_intervals_matrix.json` |
| `fixtures/demo_manifest.json` | Describes the preset tenants, their `source_dir` and `source_documents`, sample tickets and embedding model. Read by `src/demo_setup/seeder.py` |

The `tenant_id` of each business equals its directory name.

## Shared document schema

Every tenant, including the secret demo business, is ingested into the same structure by `src/rag/ingestor.py`. There is no tenant-specific code. Each chunk in `doc_vectors` has:

```json
{
    "tenant_id": "harbor_view",
    "doc_id": "POST_OP_CARE_GUIDE",
    "section": "1. Incision Site Monitoring & Protection",
    "chunk_index": 0,
    "text": "...",
    "embedding": [0.012, -0.045, 0.089],
    "created_at": "2026-10-18T00:00:00Z"
}
```

- `doc_id` is the file name without its extension.
- For Markdown, `section` is the nearest H1 to H3 heading above the chunk.
- For JSON, each top-level key or list item becomes its own section.
- `embedding` has 384 dimensions (`BAAI/bge-small-en-v1.5`).

See the [`src/` guide](../src/README.md) for the chunking and retrieval details.

## Adding a new business

1. Put its documents in `data/<tenant_id>/` using Markdown headings (H1 to H3) to mark sections.
2. Inspect first. It writes nothing: `.venv/bin/python scripts/ingest_rag_docs.py --document-parser structured --inspect-only`.
3. Ingest with `--execute` after reviewing the output. This replaces that tenant's vectors. Arguments are in the [scripts guide](../scripts/README.md).
4. Create the matching `businesses` record. In the standard stack, signing up in the dashboard does this, and later document uploads use `scripts/ingest_uploaded_document.py`.

To add a preset demo tenant, add an entry to `fixtures/demo_manifest.json` as well. No code change is needed.

## Frozen benchmark

The frozen 100-question `harbor_view` benchmark is not in this directory. It lives in a separate research workspace and must stay unchanged. It is never used for training or hyperparameter selection, and ground-truth-context and live-RAG evaluations are kept separate.
