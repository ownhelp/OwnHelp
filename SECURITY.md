# Security

How the system isolates tenants and handles secrets, what a widget visitor can and cannot see, and what the system does not protect against. The authoritative details are in the [gateway guide](gateway/README.md#security-notes) and the [widget API contract](widget/API_CONTRACT.md).

## Reporting a problem

Please do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [github.com/ownhelp/OwnHelp/security/advisories/new](https://github.com/ownhelp/OwnHelp/security/advisories/new). Include the affected component (gateway, dashboard, widget, chat service or deployment files), the steps to reproduce, and what an attacker could reach. This project has no response-time guarantee.

## Tenant isolation

- The tenant comes from the server-side session. A tenant id supplied in a path, body, query or `X-Tenant-Id` header is only compared with the session's tenant, and conflicting values are refused.
- Ticket, document and chunk queries are always filtered by that tenant.
- Public chat loads the tenant by id and rejects tenants that belong to the other server mode.
- Retrieval uses `$vectorSearch` with `tenant_id` as a pre-filter (`filter: {"tenant_id": {"$eq": ...}}`), so another tenant's vectors are never scored. This requires `tenant_id` to be a `filter` field in `vector_index`. See [where filtering is enforced](src/README.md#where-tenant-filtering-is-enforced).
- `APP_MODE` is set by the operator, never by a request. `standard` and `preset_training` use different databases, sessions are rejected after a mode change, and startup fails closed on a misconfiguration.

## Secrets

- `MONGODB_URI` (the Atlas connection string is a credential), `HF_TOKEN`, `CHAT_BACKEND_TOKEN` and `CHAT_FOLLOW_UP_SECRET` are read from the environment or from `.env` files. `.env` files and `*.local` files are git-ignored; only `.env.example` and `.env.compose.example` are committed, and they contain placeholders.
- The browser never receives the database URI, the backend token, the follow-up secret or retrieval details. The widget and dashboard talk only to the gateway, never to MongoDB.
- Health and error responses contain no driver errors, hostnames or connection strings.
- `docker compose config` prints the values from `.env.compose.local`. Do not share its output.
- `scripts/setup_stack.py` writes `.env.compose.local` with mode 0600 and never overwrites it. It takes the Atlas URI from the environment or a hidden prompt, never as a command-line argument, so it stays out of shell history.

## What the widget visitor can and cannot see

A visitor receives the answer text, the escalation payload when a human is needed, and the follow-up form metadata. A visitor never receives retrieved chunk text, similarity scores, document ids, or system prompts. Browser chat is accepted only from the origins listed for that business. The origin check applies to browsers. A request with no `Origin` header, such as curl or a server-side client, is not blocked by it, so it is not an authentication mechanism.

## Sessions and abuse controls

- Dashboard sessions are random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS or in production). Only a SHA-256 hash is stored, and sessions expire after 12 hours.
- Failed logins are throttled and give one error message for every failure.
- Rate limits are in memory and per process. Use a shared store before running several replicas, and set `TRUST_PROXY` when running behind a proxy, otherwise all clients behind it share one IP.
- Uploads are limited to allowlisted extensions and 10 MB, file names are sanitized, and staged files are always deleted.

## Threat model and limits

In scope: one business's data being exposed to another tenant, secrets reaching the browser, and cross-origin use of a business's chat.

Out of scope or not provided:

- Prompt injection. Retrieved text and visitor messages are passed to a small local model, and the model's behavior cannot be guaranteed. Answers are grounded in retrieved context, but that is not a security boundary.
- Email delivery. Saved contact details are stored for follow-up, and nothing sends an email or connects a live agent.
- Replica-safe rate limiting and conversation memory, which are per process.
- Hosting of the data. Documents, embeddings, tickets and contact details live in the operator's own MongoDB Atlas cluster, so Atlas access rules, the database user's privileges and the cluster region are the operator's responsibility. Inference is local; storage is not. See the [privacy trade-off](deployment/README.md#privacy-trade-off).
- Network exposure. The Compose stack binds the gateway and dashboard to `127.0.0.1`. Putting them on a public interface needs TLS and a reverse proxy that you configure.
