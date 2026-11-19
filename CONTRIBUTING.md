# Contributing

## Environment setup

Requires Python 3.14+, [uv](https://docs.astral.sh/uv/), Node.js/npm and Ollama. From the repository root:

```bash
uv sync
cp .env.example .env
npm install --prefix gateway
npm install --prefix dashboard
npm install --prefix widget
npm run build --prefix widget
```

Edit `.env` using the comments in `.env.example`. Secrets and targets (`MONGODB_URI`, `MONGODB_DB_NAME`, `HF_TOKEN` and so on) come from the environment or `.env`, never from code. Never commit `.env`, `.env.compose.local` or any credential. See the [README](README.md#local-development-without-docker) for running the services.

## Where code goes

- **Reusable logic lives in `src/`** as modules and classes (for example `src/rag/retriever.py` or `src/chat/`). See the [package map](src/README.md).
- **CLI runners live in `scripts/`** and must import from `src/`. Do not put core logic in a script. See the [scripts guide](scripts/README.md).
- **No tenant-specific code.** Every business, including the final demo business, uses the same document schema. Never branch on a tenant name.
- **The gateway is the only entry point for the widget.** The widget and dashboard must never talk to MongoDB or hold database secrets.
- **Retrieval must pre-filter by tenant.** Use `$vectorSearch` with `tenant_id` in `filter`. Never retrieve first and filter afterward.

## Style

- All JSON files and JSON output use 4-space indentation.
- Comments explain why, not what. Every module has a header docstring or comment (purpose, inputs, outputs, callers), and every public function or class has a short docstring.
- Keep documentation current in the same change as the code. Commands, env var names, ports and routes in a README must match the code.

## Checks

Run all of these before opening a pull request:

```bash
.venv/bin/python -m unittest discover -s tests
npm test --prefix gateway
npm test --prefix dashboard
npm run lint --prefix dashboard
npm test --prefix widget
```

These suites are offline and mocked. Which tests need a database or model, if any, is listed in the [tests guide](tests/README.md). If you changed Compose files, also run `docker compose --env-file .env.compose.example config -q`.

## Things not to change

- The frozen 100-question `harbor_view` benchmark, which is kept in a separate research workspace outside this repository. It is excluded from training and hyperparameter selection, and ground-truth-context and live-RAG evaluations stay separate.
- The sample business documents under `data/<tenant>/`. They are the retrieval corpus and the training and evaluation data, not project documentation. See the [data guide](data/README.md).

## Open work

Every open item is marked in the code or here with a greppable tag. List them all with `grep -rnE "TODO\(" --exclude-dir=node_modules --exclude-dir=.venv --exclude-dir=.next .`.

In the code:

- `TODO(streaming)`: token-by-token streaming of replies in the Python chat service. Required before the sprint ends. Markers are in `src/chat/orchestrator.py`, `src/chat/answer_stream.py` and `src/README.md`.
- `TODO(chunk-editing)`: manual chunk editing in the dashboard and the gateway (`dashboard/src/components/ChunkExplorer.jsx`, `gateway/src/routes/documents.js`).
- `TODO(setup-args)`: `setup.sh --with-ollama` is rejected (`examples/client-training/scripts/setup.sh`).
- `TODO(sandbox-gpu)`: an opt-in `--with-ollama-gpu` flag so the sandbox's bundled Ollama can use an NVIDIA GPU (`examples/client-training/compose.yaml`, `scripts/setup.sh`).
- `TODO(seeder-replace)`: the demo seeder still deletes before inserting (`src/demo_setup/seeder.py`).
- `TODO(gateway-cleanup)`: a misspelled function name, a duplicate `dotenv` load, a duplicate `json spaces` setting and a duplicate require (`gateway/src/routes/auth.js`, `db/mongo.js`, `server.js`, `routes/chat.js`).
- `TODO(login-rate-limit-proxy)`: login throttling behind a reverse proxy (`gateway/src/routes/auth.js`).
- `TODO(widget-contact-errors)`: specific visitor messages for contact-form errors (`widget/src/components/ChatWidget.jsx`).
- `TODO(mock-gateway)`: the widget's mock gateway does not enforce the real gateway's rules (`widget/mock/mock_gateway.js`).

Not tied to one place in the code:

- `TODO(live-verification)`: run the standard stack end to end against a real Atlas cluster (Atlas index auto-create, first-ingest delay, one-time model re-import), then update the "Verification status" section of [`deployment/README.md`](deployment/README.md). The real subprocess path for upload progress (`defaultPythonIngestionRunner`) is only unit-tested with fakes, so include one real dashboard upload.
- `TODO(widget-publish)`: publish `@ownhelp/widget` to npm, then check that the CDN snippet in `widget/README.md` loads.
- `TODO(npm-audit)`: run `npm audit` for `gateway/` and `widget/` (only the dashboard's production dependencies have been audited).
- `TODO(repo-cleanup)`: delete obsolete branches on the OwnHelp repository (for example `backup-post-project-cleanup` and the old data branches) once they are no longer needed.
- `TODO(stretch-docs)`: optional, deferred by choice: a short troubleshooting guide for Docker, GPU and Atlas index problems, an architecture diagram image, and a `CHANGELOG.md`.

## Commits

Stage only the files you changed. Do not use `git commit -a`.
