# @ownhelp/widget

An embeddable chat widget for a self-hosted, multi-tenant support gateway. It talks only to
`POST {apiUrl}/api/chat` (and `/api/chat/contact`): it never touches a database and holds no secrets.
Visitors see the assistant's reply, never retrieved chunks or scores.

## Install: script tag

```html
<script src="https://support.example.com/widget.js"
        data-tenant-id="your_tenant"
        data-api-url="https://support.example.com"
        data-title="Example Support"
        data-greeting="Hi! Ask me anything."
        data-position="right"
        data-accent-color="#0b6e4f"
        defer></script>
```

The script can come from your gateway (`/widget.js`) or a CDN. Pin an exact version on a CDN:

```html
<script src="https://cdn.jsdelivr.net/npm/@ownhelp/widget@0.1.0/dist/widget.js"
        data-tenant-id="your_tenant"
        data-api-url="https://support.example.com"
        defer></script>
```

`data-api-url` is required unless the gateway itself serves the script: when omitted, the widget
uses the origin the script was loaded from.

| Attribute | Required | Default | Notes |
| :--- | :--- | :--- | :--- |
| `data-tenant-id` | yes | | Tenant to chat with. |
| `data-api-url` | when not served by the gateway | script origin | Gateway base URL. |
| `data-title` | no | `Support` | Header text. |
| `data-greeting` | no | `Hi! How can I help you today?` | First message. |
| `data-position` | no | `right` | `left` or `right`. |
| `data-accent-color` | no | `#1f6feb` | Any CSS colour. |

The widget renders inside a shadow root, so your page's CSS cannot affect it.

## Install: React component

```bash
npm install @ownhelp/widget
```

```jsx
import { ChatWidget } from "@ownhelp/widget";

export default function App() {
    return <ChatWidget apiUrl="https://support.example.com" tenantId="your_tenant" accentColor="#0b6e4f" />;
}
```

Props: `apiUrl` and `tenantId` (required), `title`, `greeting`, `position` (`"left"` or `"right"`),
`accentColor`, `defaultOpen` (start with the panel open) and `fetchImpl` (replace `fetch`, for tests
or a custom proxy). React 18+ is a peer dependency; styles are injected, so there is no CSS import.
The package also exports `streamChat`, `submitContact`, `ChatError`, `getSessionId` and
`newSessionId` for building your own UI, with TypeScript types included.

## Gateway requirement: allowed origins

The gateway only answers browsers whose origin is in that tenant's `widget_config.allowed_origins`
(exact origins, no wildcards), whichever host served the script. Otherwise it returns
`403 origin_not_allowed`. Add your site's origin (for example `https://shop.example.com`) to the
tenant before going live.

## Theming and behavior

- **Theming:** set `accentColor`, or override the `--cw-*` custom properties on `.cw-root`
  (`--cw-accent`, `--cw-bg`, `--cw-surface`, `--cw-text`, `--cw-muted`, `--cw-border`, `--cw-error`).
  A dark palette applies automatically with `prefers-color-scheme: dark`.
- **Session persistence:** each tenant gets a random session id in `localStorage` so a reload continues
  the conversation on the server side. If storage is blocked (private window) it falls back to memory.
  The id is not a credential.
- **Email follow-up:** after a human escalation is saved, the gateway can include `follow_up`
  metadata. The widget then shows optional public contact links and a name and email form, sent to
  `/api/chat/contact`. The UI confirms details were saved for staff review, not that an email went out.
  The follow-up token is kept in memory only.
- **Start again:** the header's **New chat** button aborts in-flight requests, clears the form and
  follow-up state, and stores a new session id. Server history and admin tickets are untouched.
- Stop and Retry buttons, and fixed visitor-safe error messages, are built in.

## Local development

```bash
npm install
npm run mock    # mock gateway on :4100 (MOCK_PORT to change), see API_CONTRACT.md
npm run dev     # Vite dev page on :5173
npm test        # node --test tests/*.test.js
npm run build   # dist/widget.js (script tag) and dist/lib/index.js (React import)
```

In the mock, a message containing `human` returns follow-up metadata, `nostream` the JSON fallback,
and `ratelimit`, `unknown`, `error`, `cutoff` and `slow` exercise failures (see the header of
`mock/mock_gateway.js`). The mock saves nothing; use fictional data.

## Publish checklist

1. Bump `version` in `package.json` and update the pinned CDN version above.
2. `npm test && npm run build` (also run by `prepublishOnly`).
3. `npm pack --dry-run`: only `dist`, `types`, `README.md`, `LICENSE` and `API_CONTRACT.md` should ship.
4. `npm publish --access public` (scoped packages are private by default, so the flag is required on
   the first publish; `publishConfig` in `package.json` also sets it).

## Reference

- [API_CONTRACT.md](API_CONTRACT.md): the `POST /api/chat` request, SSE events, errors and follow-up.
- [LICENSE](LICENSE): MIT.
