# Chat API Contract: `POST /api/chat`

This is the contract between the embeddable widget (`widget/`) and the Orchestration Gateway.
The real implementation is `gateway/src/routes/chat.js`. `widget/mock/mock_gateway.js` is an
executable reference mock (no retrieval, no generation, no database), and
`widget/tests/mock_gateway.test.js` checks the widget client against it. The mock does not
enforce every gateway rule (session id format, per-tenant origins, body size); the real gateway does.

## Request

```
POST /api/chat
Content-Type: application/json
Accept: text/event-stream, application/json
```

```json
{
    "tenant_id": "example_tenant",
    "message": "What is your return policy?",
    "session_id": "6f1c0c5e-6a34-4f0a-9d53-1b0d2f2b7a10"
}
```

| Field | Type | Rules |
| :--- | :--- | :--- |
| `tenant_id` | string | Required. Must match a `businesses.tenant_id`. Used as the `$vectorSearch` pre-filter. |
| `message` | string | Required, non-empty, at most 2000 characters. |
| `session_id` | string | Required. 16 to 128 characters from `A-Za-z0-9_.:-` (a UUID qualifies). Generated and stored by the widget (`localStorage`, per tenant). Not a credential; the gateway keys conversation history on it. |

The body is limited to 16 KB. The request carries **no cookies and no `Authorization` header**. It is a
public, anonymous endpoint. The gateway answers CORS itself (`POST, OPTIONS`, `Content-Type` only, no
credentials) and checks the request `Origin` against the tenant's allowed origins.

## Success response: streaming (preferred)

`200 OK`, `Content-Type: text/event-stream`. Events, in this order:

| Order | Event | `data` payload | Notes |
| :--- | :--- | :--- | :--- |
| 1 | `token` | `{"text": "Items "}` | Zero or more. Text deltas; the widget concatenates them. |
| 2 | `done` | `{}` | Terminates a successful reply. May include `follow_up` after a saved escalation. |
| any | `error` | `{"code": "generation_failed", "message": "..."}` | Terminal. Used when a failure happens after the `200` has been sent. No `done` follows. Codes: `generation_failed` (the model failed or produced unusable output), `stream_interrupted` (the connection to the backend was cut mid-reply, or it ended without finishing), `timeout` (the overall time limit passed). |

If a human escalation could not be saved as a ticket, the gateway appends one last `token` event with a
short notice (to contact the business directly) before `done`, and `done` carries no `follow_up`.

The `message` text is for developers. The widget never shows it: it shows a fixed, safe sentence per `code`
(see `src/lib/messages.js`) and offers Retry only when resending can help.

The visitor receives the model's reply and, when available, public follow-up options. There is no `sources` event and the stream carries no
document ids, sections, scores, chunk text, confidence or action (see "What visitors never receive" below).
A widget that sees an unknown event, such as a legacy `sources` event from an older gateway, ignores it.

Wire example:

```
event: token
data: {"text":"Items returned "}

event: token
data: {"text":"within 30 days..."}

event: done
data: {}

```

Required response headers: `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`
(so nginx and similar proxies do not buffer the stream). Heartbeat comment lines (`: ping`) are allowed.

The widget treats a stream that closes **without** `done` or `error` as an interrupted reply and offers Retry.
If the gateway goes silent for 30 seconds the widget aborts with a timeout.

## Success response: non-streaming fallback

If the request does not accept `text/event-stream`, the gateway returns one JSON body (the widget always
asks for SSE first). The widget handles either based on the response `Content-Type`. Because nothing has
been streamed, a generation failure or timeout in this mode is a plain `503 service_unavailable`
instead of an in-stream `error` event. The body may also carry `follow_up` (see below).

```json
{
    "answer": "Items returned within 30 days are eligible for a full refund.",
    "session_id": "6f1c0c5e-6a34-4f0a-9d53-1b0d2f2b7a10"
}
```

## What visitors never receive

Retrieval details and the model's decision stay on the server. Neither the streaming nor the JSON response
includes: document ids, sections or scores, chunk text, embeddings, the model's confidence or cited sources,
or the raw action field. Follow-up availability is exposed only after a ticket is saved.

### Human escalation and email follow-up

When the model decides a question needs a person (`action: "escalate"`), the gateway saves the conversation
as a ticket in `ticket_logs`, in the schema the dashboard's review queue already reads:

- `status: "pending_review"`, `channel: "widget"`, `escalation_reason` (`not_in_docs` when no relevant
  document was found, otherwise `docs_require_human`), and a `ticket_summary` digest.
- `messages[]`: the whole retained conversation (`customer` / `agent` roles with timestamps), including turns
  that were answered normally.
- For the reviewer only: `retrieved_chunks` (`doc_id`, `section`, `score`; never chunk text),
  `similarity_score`, `confidence` and `cited_sources`.

The visitor gets the normal reply. When the ticket save succeeds, the gateway can offer email follow-up. One ticket exists per
conversation: a further escalation updates it (and re-opens it if it was resolved) and keeps the admin's notes
and contact details. Ordinary answered conversations are not written to the database. If saving the ticket
fails, the visitor's reply is unaffected and the failure is logged.

## Error responses (before streaming starts)

JSON body, always this shape:

```json
{
    "error": {
        "code": "rate_limited",
        "message": "Too many messages. Please wait a moment."
    }
}
```

| Status | `code` | When |
| :--- | :--- | :--- |
| 400 | `invalid_request` | Missing or wrongly typed field, bad `session_id`, or a body that is not valid JSON or is too large. |
| 400 | `message_too_long` | `message` over 2000 characters. |
| 403 | `origin_not_allowed` | Request `Origin` is not on the tenant's allowed list. |
| 404 | `unknown_tenant` | `tenant_id` does not exist (or is not served by this deployment mode). |
| 405 | `method_not_allowed` | Not `POST` or `OPTIONS` (`Allow` header set). |
| 429 | `rate_limited` | Per-IP or per-session limit hit. Includes `Retry-After` (seconds). |
| 500 | `internal_error` | Unexpected gateway failure. |
| 503 | `service_unavailable` | Inference engine or vector store unreachable, or the backend failed before producing a reply. |
| 504 | `timeout` | The overall time limit passed before the first token. |

The gateway may start streaming (`200`) as soon as retrieval is done, before the first token; failures after
that point arrive as an `error` event instead. The widget displays fixed safe messages and never renders the
server error message.

## Conversation memory

The widget sends one `message` and a `session_id` per request. Multi-turn context is the gateway's job:
it keeps a bounded history keyed by tenant and `session_id`. The tenant's `agent_config` is applied
server-side; the widget never sends or sees it.

## Optional follow-up metadata and contact submission

Both SSE `done` data and JSON fallback may include:

```json
{
    "follow_up": {
        "available": true,
        "token": "opaque-scoped-capability",
        "contact_email": "support@example.test",
        "contact_phone": "+1 555 123 4567"
    }
}
```

Omit metadata for ordinary answers or when ticket persistence fails. The client requires
`available: true` and a non-empty token, returns it as `followUp`, and keeps the capability
in memory only. It never puts capabilities or visitor contact details in localStorage.
Phone/email links use validated configured data; they are not extracted from model prose.
The panel warns that email follow-up is not immediate and never promises a live transfer.

`POST /api/chat/contact` uses the same anonymous tenant-origin policy as chat:

```json
{
    "tenant_id": "example_tenant",
    "session_id": "visitor-session-id",
    "follow_up_token": "opaque-scoped-capability",
    "name": "Visitor",
    "email": "visitor@example.test"
}
```

Return HTTP 200 with `{"status":"saved"}` only after details are persisted to the
existing ticket. This means saved for staff review; no email delivery or response time
is promised. First submission wins; resubmitting identical name and email is idempotent (`saved` again). Errors use the standard envelope:

| Status | `code` | When |
| :--- | :--- | :--- |
| 400 | `invalid_request` | Invalid conversation id, tenant, name (1 to 100 characters, no control characters) or email. |
| 403 | `origin_not_allowed` | `Origin` not on the tenant's allowed list. |
| 403 | `invalid_follow_up` | Capability token expired, invalid, or for another tenant or session. |
| 404 | `unknown_tenant` | Tenant does not exist. |
| 409 | `contact_already_submitted` | Different details were already saved, or the ticket is missing. |
| 429 | `rate_limited` | Limit hit; includes `Retry-After`. |
| 503 | `service_unavailable` | Persistence failed or timed out. |

The widget keeps the form available on errors and shows fixed visitor-safe wording.

New chat aborts outstanding replies and contact saves, ignores stale callbacks, clears
local messages and form data, and persists a new per-tenant session ID. Existing server
history and admin tickets are untouched. Changing tenant or gateway also invalidates
outstanding callbacks and clears the visible conversation.
