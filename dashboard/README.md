# Admin Management Dashboard

A Next.js 16 (App Router) admin console for a business running the self-hosted support assistant. Administrators use it to manage documentation, inspect stored vector chunks, tune the agent's runtime settings, review tickets, and set the origins allowed to embed the chat widget.

The dashboard is one part of the stack, alongside the Express gateway (`gateway/`), the local inference service and the embeddable widget. It is a pure client of the gateway: it never connects to MongoDB and holds no database credentials.

---

## Features

* **Overview and document ingestion (`/`)**
  * Metric cards for the active tenant, a drag-and-drop uploader for Markdown (`.md`) and JSON (`.json`) documents, and a document table.
  * Uploading sends the file to the gateway, which chunks and embeds it. The upload progress is real: the dashboard asks for the gateway's NDJSON stream (`Accept: application/x-ndjson`) and shows the stage the ingestion worker reports (uploading, parsing, embedding, writing, then ready). Against a gateway that does not stream, it shows a generic "Processing..." label instead. Re-uploading a document with the same `doc_id` replaces it (the row action and the viewer's replace button both do this).
  * A read-only viewer shows the raw stored content of a document.
* **Chunk and embedding explorer (`/`)**
  * Paged list (50 per page) of the tenant's stored chunks, filterable by document and by text/section search.
  * Each chunk shows an estimated token count against the 512-token embedding limit. Manual chunk editing is not implemented.
* **Runtime configuration (`/profile`)**
  * Agent tone (presets or free text), Business Instructions (the tenant's `system_prompt`), and sliders for temperature, max context chunks and similarity threshold.
  * The application-managed core assistant policy is displayed read-only; the dashboard never writes it back.
* **Profile and widget origins (`/profile`)**
  * Business name, industry, team name, public support email and phone (country picker plus optional extension, validated and stored in E.164).
  * "Allowed Origins" for the chat widget, one per line. It is only sent on save when changed, so an untouched empty box cannot turn the gateway's default into "allow no site".
* **Tickets (`/tickets`)**
  * Queue of logged interactions with status filters (all, resolved, pending review, flagged) and search.
  * The detail modal shows the conversation, the model's answer and rationale, retrieved chunks with similarity score, and lets an admin add notes and change the ticket status.
  * When a visitor left contact details after an escalation, the modal offers a prefilled `mailto:` link. Follow-up is by email; the widget does not connect visitors to a live agent.
* **Authentication and onboarding (`/login`, `/signup`)**
  * Email/password login and signup. Signup collects admin and business details and previews the generated `tenant_id` slug and a default system prompt; the gateway creates the account and business.
  * In `preset_training` mode the login page offers one-click preset-tenant buttons and signup is disabled.
* **Gateway health**
  * The sidebar polls `/api/health` and shows the vector index state (every 5 seconds while not ready or unreachable, every 60 seconds once ready).

---

## Architecture

```text
[Admin browser]
      |
      v  Next.js app (port 3000)  -- dashboard/
      |
      v  fetch with session cookie, only through src/lib/api.js
[Express gateway (gateway/)]  -- default http://localhost:4000
      |
      v
[MongoDB Atlas and the Python ingestion engine, behind the gateway]
```

Every request is made by `src/lib/api.js`. Components and pages never call `fetch` themselves, and nothing in `dashboard/` imports a MongoDB driver.

---

## Page and component map

```text
dashboard/
├── src/
│   ├── app/
│   │   ├── layout.js            # Root layout: fonts, AuthProvider > TenantProvider > AppShell
│   │   ├── globals.css          # Tailwind CSS entry and theme variables
│   │   ├── page.js              # "/" overview, ingestion hub, chunk explorer
│   │   ├── login/page.jsx       # "/login" email/password or preset demo login
│   │   ├── signup/page.jsx      # "/signup" onboarding (admin + business)
│   │   ├── profile/page.jsx     # "/profile" identity, contact, origins, agent config
│   │   └── tickets/page.jsx     # "/tickets" ticket review queue
│   ├── components/
│   │   ├── AppShell.jsx         # Auth route guard and page frame
│   │   ├── Sidebar.jsx          # Navigation, workspace selector, health badge, logout
│   │   ├── FileDropzone.jsx     # Document uploader
│   │   ├── DocumentTable.jsx    # Document list with view/replace actions
│   │   ├── DocumentViewerModal.jsx
│   │   ├── ChunkExplorer.jsx    # Paged chunk browser
│   │   ├── ConfigSlider.jsx     # Range slider for numeric agent settings
│   │   ├── BusinessPhoneInput.jsx
│   │   ├── MetricCard.jsx
│   │   ├── TicketTable.jsx      # Ticket list and status/score badge helpers
│   │   └── TicketDetailModal.jsx
│   ├── context/
│   │   ├── AuthContext.jsx      # Session, login/signup/logout, app mode
│   │   └── TenantContext.jsx    # Authorized tenants and the active tenant
│   └── lib/
│       ├── api.js               # The only gateway client
│       ├── contactValidation.mjs  # Email and phone validation (pure)
│       ├── health.mjs           # Vector index status and poll timing (pure)
│       ├── origins.mjs          # Allowed-origins parsing and payload rule (pure)
│       └── profile.mjs          # Profile form to save payload (pure)
├── tests/                       # node:test unit tests for the pure lib modules
├── Dockerfile.standard          # Production image used by the Docker stack
└── next.config.mjs
```

The `.mjs` modules are dependency-light plain JavaScript so they can be tested with `node --test` without a browser.

---

## Environment configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://localhost:4000` | Base URL of the gateway (the code appends `/api/...`) |

Set it in `dashboard/.env.local` for local development. It is a `NEXT_PUBLIC_` variable, so Next.js inlines it at build time: change it, then rebuild. `Dockerfile.standard` takes it as a build argument (default `http://localhost:4002`). The gateway must list the dashboard's origin as an allowed CORS origin, because the browser sends credentialed cross-origin requests. No secrets belong in the dashboard.

---

## Development and build

Requires Node.js 22 (the Docker image uses `node:22`) and a running gateway (see `gateway/README.md`).

```bash
cd dashboard
npm install            # uses package-lock.json
npm run dev            # dev server on http://localhost:3000
npm run build          # production build
npm run start          # serve the production build
npm test               # node --test tests/*.test.mjs
npm run lint           # eslint
```

For the standard Docker stack, see the root `README.md`.

To try the dashboard with the five preset training businesses in an isolated sandbox, see [examples/client-training/README.md](../examples/client-training/README.md).

---

## Authentication and tenant isolation

* **Session cookie, no tokens in the browser.** Login, signup and demo login return a session that the gateway stores in a cookie. `api.js` sends every request with `credentials: "include"`. `AuthContext` mirrors the session by calling `/api/auth/config` and `/api/auth/session` on load.
* **Route guard.** `AppShell` redirects unauthenticated visitors to `/login` and signed-in visitors away from `/login` and `/signup`. This is a convenience; the gateway enforces authentication on each API call, and any 401 from a protected call clears the local session state.
* **Tenant list comes from the gateway.** `TenantContext` loads `GET /api/tenants` (and the session's authorized tenants), so the active tenant can only be one the session may access. The last choice is remembered in `localStorage`, under a separate key for `preset_training` mode.
* **Tenant-scoped requests.** Documents, chunks, config and tickets are requested with the active `tenant_id` in the URL (uploads send it as form data). The gateway validates it against the session, and vector search is pre-filtered by `tenant_id` there; the dashboard performs no retrieval itself.
* **Server-owned fields.** The core assistant policy and `tenant_id` are displayed but excluded from the save payload (`src/lib/profile.mjs`).
