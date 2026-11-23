# Orchestration Gateway (`gateway/`)

The Express service between the browser and everything else. It owns authentication, tenant
isolation and the public chat endpoint; it never runs the model or computes embeddings itself.

```
Dashboard (Next.js)  --cookie session-->  Gateway  --> MongoDB (businesses, doc_vectors, ticket_logs,
                                             |                   admin_users, admin_sessions)
Storefront widget    --anonymous POST-->     |      --> Python chat service (retrieval + Ollama)
                                             +--------> Python ingestion worker (document uploads)
```

What it does, with the entry point in [src/server.js](src/server.js):

- **Auth**: signup, login, logout and server-side sessions for dashboard administrators.
- **Tenants**: read and edit a business's profile, agent configuration and widget allowed origins.
- **Documents**: upload, list and inspect documents and vector chunks (ingestion is delegated to
  `scripts/ingest_uploaded_document.py`).
- **Tickets**: the human-review queue, including tickets created by chat escalations.
- **Widget and chat proxying**: serves `/widget.js` and `POST /api/chat`, which validates the
  request, checks the tenant's origin allowlist and rate limits, then streams the reply from the
  internal Python chat service. Contract: [widget/API_CONTRACT.md](../widget/API_CONTRACT.md).

Source layout: `src/config` (env, mode, presets), `src/db` (Mongo, vector index setup),
`src/middleware` (auth, rate limiter), `src/routes` (one file per area), `src/chat` (backend client,
origins, history, escalation, follow-up). Every file starts with a header comment explaining its
role.

## Server modes and database isolation

`APP_MODE` selects one of two mutually exclusive modes. It is set by the operator, never by a
request.

| | `standard` (default) | `preset_training` |
| :--- | :--- | :--- |
| Purpose | A real business | Synthetic development and demo of the five preset tenants |
| Database | `MONGODB_DB_NAME` (default `rag_knowledge_base`) | `MONGODB_TRAINING_DB_NAME` (required, must differ from `MONGODB_DB_NAME`) |
| Seeding | None | Idempotently seeds the preset businesses and sample tickets from `data/fixtures/demo_manifest.json` |
| Sign in | `POST /api/auth/signup` and `/login` (email + password) | `POST /api/auth/demo-login` (passwordless, one preset tenant) |
| Preset tenant ids | Hidden and rejected everywhere, even if old preset records exist | The only tenants served |

Startup fails closed: an unknown `APP_MODE`, an empty `MONGODB_DB_NAME`, a training database equal to
the standard one, or `preset_training` without `MONGODB_TRAINING_DB_NAME` stops the process before it
connects. Sessions record the mode they were created in and are rejected after a mode change, so a
demo session can never act on a real database.

## Configuration

Settings are read from the process environment, then `<repo root>/.env.dev`, then `gateway/.env.dev` (the root `.env` is the Docker stack's file; inside Docker nothing is read from a file). A file
never overrides an existing variable. At startup the gateway logs which files were loaded (names
only, never values). Restart after editing `.env.dev`. Chat settings are re-read on every request.

| Variable | Default | Meaning |
| :--- | :--- | :--- |
| `PORT` | `4000` | Listen port. |
| `APP_MODE` | `standard` | `standard` or `preset_training` (see above). |
| `MONGODB_URI` | none, required | MongoDB connection string. Placeholder values are rejected. |
| `MONGODB_DB_NAME` | `rag_knowledge_base` | Database used in `standard` mode. |
| `MONGODB_TRAINING_DB_NAME` | none | Database used in `preset_training` mode. Required there. |
| `MONGODB_COLLECTION_NAME` | `doc_vectors` | Vector chunk collection name. |
| `MONGODB_VECTOR_INDEX_NAME` | `vector_index` | Atlas Vector Search index name. |
| `VECTOR_INDEX_AUTO_SETUP` | `true` | Create the collections and index on boot. `false`, `0`, `no` or `off` disables it. |
| `VECTOR_INDEX_DIMENSIONS` | `384` | Expected embedding dimensions (1 to 4096). |
| `VECTOR_INDEX_POLL_MS` / `VECTOR_INDEX_POLL_MAX` | `10000` / `90` | Poll interval and count while Atlas builds the index. |
| `SESSION_COOKIE_NAME` | `ownhelp_session` | Session cookie name (3 to 64 letters, digits, `_`, `-`). Set a different name to run two gateways on one host without cookie collisions. |
| `ALLOWED_ORIGINS` | none | Extra comma-separated dashboard origins, added to the built-in `http://localhost:3000` and `http://127.0.0.1:3000` (admin CORS and CSRF check). |
| `LOGIN_RATE_LIMIT_MAX` | `8` | Failed logins per IP and email within 15 minutes before `429`. |
| `NODE_ENV` | none | `production` always sets the `Secure` flag on the session cookie. |
| `TRUST_PROXY` | unset | Express `trust proxy` value (for example `1`) so `req.ip` is the real client behind a reverse proxy. Needed for correct rate limiting there. |
| `UPLOAD_STAGING_DIR` | `/tmp/uploads` | Where uploads are staged before ingestion. Files are deleted after each request. |
| `PYTHON_EXECUTABLE` | unset | Interpreter for the ingestion worker. Otherwise `.venv/bin/python`, then `uv run`. |
| `CHAT_BACKEND_URL` | `http://127.0.0.1:8100` | Internal Python chat service. |
| `CHAT_BACKEND_TOKEN` | empty | Shared secret sent as `X-Chat-Backend-Token`; set the same value on the chat service. Required whenever that service is reachable from another host. |
| `CHAT_FOLLOW_UP_SECRET` | random per process | Key for follow-up capability tokens. Set a strong value, identical across replicas, to keep forms valid across restarts. |
| `WIDGET_DEFAULT_ALLOWED_ORIGINS` | unset (reject all) | Comma-separated origins for tenants without their own list. |
| `WIDGET_DIST_PATH` | `widget/dist/widget.js` | Bundle served at `/widget.js`. |
| `CHAT_RATE_LIMIT_PER_IP` | `30` | Chat requests per IP per window. |
| `CHAT_RATE_LIMIT_PER_SESSION` | `10` | Chat (and contact) requests per tenant session per window. |
| `CHAT_RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window length. |
| `CHAT_MAX_DURATION_MS` | `120000` | Hard cap on one reply; ends with a `timeout` error event. |
| `CHAT_HEARTBEAT_MS` | `10000` | SSE `: ping` interval while a slow model reads the prompt. |
| `CHAT_PRE_STREAM_WAIT_MS` | `3000` | How long to wait for the first token before committing to a `200` stream. A backend that fails inside this window gets a real `503`. `0` commits immediately. |
| `CHAT_HISTORY_MAX_MESSAGES` | `8` | Turns remembered per tenant session, at most 12. |
| `OLLAMA_HOST` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `llama3.2:3b` | Only used by `/api/health` to report whether the model server is reachable and has the model. |

Invalid numeric chat values fall back to their defaults instead of failing.

## Routes

"Session" means a valid session cookie scoped to the tenant in the URL, plus the CSRF origin check
for state-changing methods. Rate limits apply only where listed; the admin routes have none beyond
login throttling.

| Method and path | Auth | Rate limit | Purpose |
| :--- | :--- | :--- | :--- |
| `GET /api/health` | none | none | Readiness flags: database, vector index, Ollama. Always `200`. |
| `GET /api/auth/config` | none | none | Server mode and, in `preset_training`, the preset tenants. |
| `POST /api/auth/signup` | none, `standard` only | none | Create an admin and its tenant, start a session. |
| `POST /api/auth/login` | none, `standard` only | failed attempts per IP and email | Email and password sign in. |
| `POST /api/auth/demo-login` | none, `preset_training` only | none | Passwordless session for one preset tenant. |
| `GET /api/auth/session` | session | none | Current user and tenant. |
| `POST /api/auth/logout` | session | none | Revoke the session and clear the cookie. |
| `GET /api/tenants` | session | none | The session's own tenant only. |
| `GET /api/tenants/:tenantId/config` | session | none | Tenant document plus the default `assistant_policy` (read-only; sending it in a `PUT` is rejected). |
| `PUT /api/tenants/:tenantId/config` | session | none | Partial update of profile, `agent_config`, `widget_config.allowed_origins`, contact fields and `record_conversations` (boolean, opt-in recording). `agent_config.core_policy` (a string of up to 8000 characters) replaces the default core policy for this business; `null` or `""` removes it so the default applies again. |
| `POST /api/documents/upload` | session | none | Upload `.md` or `.json` (10 MB) and ingest it. Returns the JSON summary, or an NDJSON stage stream when the request sends `Accept: application/x-ndjson` (see below). Re-ingesting a `doc_id` inserts the new chunks before deleting the old ones, so a failed insert never leaves the document empty. |
| `GET /api/tenants/:tenantId/documents` | session | none | Documents with chunk counts. |
| `GET /api/tenants/:tenantId/documents/:docId` | session | none | One document's text and chunks. |
| `GET /api/tenants/:tenantId/chunks` | session | none | Paginated vector chunks (embedding vectors omitted). |
| `PUT /api/tenants/:tenantId/chunks/:docId/:chunkIndex` | session | at most 2 edits at once, then `429` | Replace one chunk's text (1 to 8000 characters, body `{ "text": "..." }`). Re-embeds it with the ingestion model in `scripts/reembed_chunk.py` and updates text and embedding in one write; any failure leaves the chunk unchanged. `404` if the chunk is not the session tenant's, `400` for invalid input or text over the embedding token limit. |
| `GET /api/tenants/:tenantId/tickets` | session | none | Tickets, optional `status` and `search`. |
| `POST /api/tickets`, `POST /api/tenants/:tenantId/tickets` | session | none | Create a ticket. |
| `PATCH /api/tickets/:ticketId` | session | none | Update status, notes, contact or summary. |
| `GET /widget.js` | none | none | The embeddable widget bundle. |
| `GET /api/chat?tenant_id=` | none (anonymous, origin checked) | per IP | `{ "record_conversations": boolean }`, so the widget knows whether to show its recording notice. |
| `POST /api/chat` | none (anonymous) | per IP, per session | Grounded reply as SSE, or one JSON body without `Accept: text/event-stream`. 16 KB body cap. |
| `POST /api/chat/contact` | follow-up token | per IP, per session | Save a visitor's name and email on an escalated ticket. 8 KB body cap. |

### Streaming upload progress

`POST /api/documents/upload` with `Accept: application/x-ndjson` answers `200` with
`Content-Type: application/x-ndjson` and one JSON object per line:

```
{"event":"stage","stage":"uploading"}
{"event":"stage","stage":"parsing"}
{"event":"stage","stage":"embedding"}
{"event":"stage","stage":"writing"}
{"event":"done","status":"success","tenant_id":"...","doc_id":"...","chunks_created":3}
```

Stages are real: the ingestion worker prints one `{"event":"stage",...}` line per stage on stdout and
the gateway relays it. The final line is `done` (the same summary the JSON mode returns) or
`{"event":"error","error":"<CODE>","message":"..."}`. Errors never carry stack traces, file paths or
raw process output. Failures that happen before streaming starts (no session, wrong tenant, missing
file, bad `doc_id`) are still ordinary `4xx` JSON. Without that `Accept` header the route behaves
exactly as before. Tests inject a fake worker with `setIngestionRunner(fn)`; `fn` receives
`{ filePath, tenantId, overwrite, docId, dbName, onStage }` (`onStage` only in streaming mode).

`/widget.js` and `/api/chat` are mounted before the admin CORS policy, CSRF check and
authentication on purpose: they are public and credential-free, so they carry their own origin
allowlist and limits instead. Everything under `/api` registered after `requireAuth` in
`server.js` needs a session.

## Widget origins and CORS

Two separate policies:

- **Admin API**: CORS allows only the dashboard origins (`http://localhost:3000`,
  `http://127.0.0.1:3000`, plus `ALLOWED_ORIGINS`) with credentials. State-changing requests whose
  `Origin` (or `Referer`) is outside that set, or that the browser marks cross-site, get `403`.
- **Public chat**: no credentials. The `Origin` header is checked against the tenant's own list in
  `businesses.widget_config.allowed_origins` (exact `http(s)` origins, no wildcards or paths, at most
  50), set through `PUT /api/tenants/:tenantId/config`. A tenant without that field uses
  `WIDGET_DEFAULT_ALLOWED_ORIGINS`, which has no built-in value, so with neither set every browser
  origin gets `403 origin_not_allowed`. A tenant's own list wins over the fallback, and an explicit
  empty array allows no browser origin. Requests with no `Origin` (curl, servers) skip the list but
  still hit the rate limits. Preflights are answered without a tenant, so the list is enforced on the
  `POST` itself.

Embed snippet:

```html
<script src="https://GATEWAY_HOST/widget.js"
        data-tenant-id="your_tenant_id"
        data-api-url="https://GATEWAY_HOST"
        defer></script>
```

## Chat flow and human escalation

```
widget -> POST /api/chat    validate, rate limit, load tenant, check origin
       -> POST /v1/chat     internal Python chat service: $vectorSearch filtered by tenant_id, Ollama
       <- NDJSON events     gateway forwards token / done / error to the visitor as SSE
```

The visitor never receives document sources, scores, chunk text, the raw action or confidence. When
the model answers with `action: "escalate"`, the gateway saves the conversation as one ticket per
tenant and session in `ticket_logs` (`status: pending_review`, reason `not_in_docs` or
`docs_require_human`, up to the last 40 messages, source ids and scores only). A repeated escalation
updates the same ticket and keeps admin notes. Ordinary answered conversations are not stored,
unless the business turned on `record_conversations` and the widget confirmed it showed the
recording notice; then each turn is written, with contact details redacted, to `conversation_logs`.

The final `done` waits up to five seconds for the acknowledged ticket save. If it fails, no
`follow_up` is offered and a fixed notice tells the visitor the form is unavailable.

### Asynchronous follow-up contract

After a saved escalation, `done` (or the JSON body) can include
`follow_up: { available: true, token, contact_email?, contact_phone? }`. Contact values come only
from the tenant's public `contact_email` and optional `contact_phone`, never an admin account.

`POST /api/chat/contact` takes `{ tenant_id, session_id, follow_up_token, name, email }`
(name up to 100 characters, email up to 254), applies the same origin allowlist and limits as chat,
and updates only the ticket the token is bound to.

| Status | Meaning |
| :--- | :--- |
| `200 { "status": "saved" }` | The database acknowledged the write. No email is sent; staff follow up from the dashboard. |
| `400` | Invalid input. |
| `403` | Disallowed origin, or invalid or expired token. |
| `404` | Unknown tenant. |
| `409` | Different contact details were already submitted. An identical retry succeeds. |
| `429` | Rate limited. |
| `503` | Save failed or timed out. |

Tokens are AES-GCM authenticated, bound to tenant, session and ticket, and expire after 24 hours.
Without `CHAT_FOLLOW_UP_SECRET` the key is random per process, so forms expire on restart and do not
work across replicas.

Other behavior: `session_id` must be 16 to 128 characters of letters, digits, `_`, `-`, `.`, `:`.
Optional `contact_phone` must be a valid international number with a country code; emails use
`validator` syntax checks. These validate format, not reachability. Tenant `system_prompt` and
`agent_tone` are appended after the base support prompt; that combination has not been evaluated on
the held-out benchmark. Behind nginx or another proxy, disable buffering and compression for
`/api/chat` (the route sends `X-Accel-Buffering: no`).

## Running

```bash
# Gateway (reads the repo-root .env.dev; copy .env.dev.example first)
cd gateway
npm install
npm run dev        # or: npm start

# Dashboard
cd dashboard && npm run dev      # http://localhost:3000

# Widget bundle (needed for /widget.js; once, and after widget changes)
cd widget && npm install && npm run build:embed

# Internal chat service (needs a vector index and Ollama with the model)
uv run python scripts/run_chat_service.py --port 8100
```

For `standard` mode open `http://localhost:3000/signup` or `/login`. For `preset_training`, set
`APP_MODE=preset_training` and `MONGODB_TRAINING_DB_NAME=<dev database>` in `.env.dev`; the login page
then shows one-click demo buttons for the preset tenants.

Docker: the full containerised stack is documented in [deployment/README.md](../deployment/README.md),
and the isolated client-training sandbox in
[examples/client-training/README.md](../examples/client-training/README.md). This README does not
repeat them.

## Tests

```bash
cd gateway
npm test      # node --test tests/*.test.js
```

The suite runs against an in-memory MongoDB fake, a mocked ingestion runner, a scripted chat backend
and a stub HTTP chat service, so it needs no database, model, network or credentials. The Python
chat service has its own offline tests: `uv run python -m unittest tests.test_chat_service` from the
repository root.

## Security notes

- **Tenant isolation**: the tenant comes from the server-side session. Any tenant id in the path,
  body, query or `X-Tenant-Id` is only compared against it; conflicting values are refused. Ticket,
  document and chunk queries are always filtered by that tenant. Public chat loads the tenant by id,
  rejects tenants of the wrong mode, and the retriever pre-filters `$vectorSearch` by `tenant_id`.
- **Sessions**: random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS or
  in production). Only a SHA-256 hash is stored, sessions expire after 12 hours, are checked against
  the database on every request and can be revoked.
- **Login**: constant-time comparison even for unknown emails, one error message for all failures,
  and throttling on failed attempts.
- **Rate limiting**: in-memory sliding windows with a bounded key count, per process. Use a shared
  store before running several replicas, and set `TRUST_PROXY` behind a proxy.
- **No secrets to the browser**: the widget and dashboard never see `MONGODB_URI`, the backend
  token, the follow-up secret or retrieval details. The widget talks only to `/api/chat`; error
  bodies and `/api/health` contain no driver errors, hostnames or connection strings.
- **Uploads**: allowlisted extensions, 10 MB cap, sanitized names, staged files always deleted,
  tenant and document ids validated against strict patterns before use in paths or queries.
