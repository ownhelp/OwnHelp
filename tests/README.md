# tests/ - Python tests

Tests for `src/`. Run every command from the repository root.

## Running the Python tests

```bash
.venv/bin/python -m unittest discover -s tests          # the project's documented command
.venv/bin/python -m unittest tests.test_chat_service    # one file
```

The suite takes a few seconds and needs no database, model or network.

`pytest` is not a project dependency and is not installed in `.venv`; use `unittest`. `tests/test_table_parser.py` contains plain functions rather than `TestCase` classes, but its `load_tests` hook wraps them in `FunctionTestCase`, so discovery still runs them (5 tests).

## What needs a database, model or Docker

None of the Python tests need MongoDB, Ollama, an embedding model download, network access or credentials. MongoDB, `SentenceTransformer` and Ollama are mocked or replaced with in-memory fakes. The one environmental dependency is in `test_deployment.py`: a Compose-validation test is skipped when the `docker` CLI is not installed (it does not start containers).

| File | Protects |
| --- | --- |
| `test_assistant_policy.py` | Core system policy wiring and the unsupported-handoff safeguard |
| `test_chat_service.py` | Internal chat service: event stream, token auth, cross-tenant rejection, env handling |
| `test_demo_setup.py` | Demo seeder target allow-list, idempotency, drift detection |
| `test_deployment.py` | `src/deployment/config.py` and Compose file contracts |
| `test_document_parser.py` | Structured document parser |
| `test_document_pipeline_integration.py` | Parser to chunk provenance pipeline |
| `test_rag_auth.py` | HF token passed to embedding model loading |
| `test_retriever_rerank.py` | Query prefix, reranking, per-tenant filtering |
| `test_table_parser.py` | Markdown table linearization (plain functions, wrapped by `load_tests`) |
| `test_vector_index.py` | Vector index definition, creation and status |

## Other test suites

| Package | Command | Notes |
| --- | --- | --- |
| Gateway | `npm test --prefix gateway` | `node --test`; uses an in-memory MongoDB mock and stub chat service. |
| Dashboard | `npm test --prefix dashboard` | `node --test` on the pure lib modules. Also run `npm run lint --prefix dashboard`. |
| Widget | `npm test --prefix widget` | `node --test`. |

These need `npm install --prefix <package>` first.

## Live checks are separate

The held-out benchmark and live-RAG evaluations are not part of this suite; they run through scripts and need a real database and model. Keep ground-truth-context and live-RAG results separate.
