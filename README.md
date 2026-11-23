# OwnHelp

OwnHelp is a private customer support assistant for your website. You give it your own documentation (return policy, shipping, FAQs, product guides), and visitors get answers grounded in those documents from a chat widget on your site.

It is self-hosted. A fine-tuned open-source model (`Llama-3.2-3B-Instruct`) runs on a server or computer you control, so there is no per-question cloud cost and your customers' questions are not sent to an AI provider. Your documents and their embeddings are stored in a MongoDB Atlas cluster that you own (see [privacy](deployment/README.md#privacy-trade-off)). One installation can serve several businesses, each isolated from the others.

## How it works

```text
[Storefront chat widget]
        |  POST /api/chat
        v
[Gateway (Express)] ----> [Chat service (Python)] ----> [Ollama: local GGUF model]
        |                          |
        |                          v  $vectorSearch, pre-filtered by tenant_id
        |                    [MongoDB Atlas: doc_vectors, businesses]
        v
[Management dashboard (Next.js)]
```

- The widget talks only to the gateway. It never reaches MongoDB and holds no secrets.
- The gateway handles authentication, tenants, document uploads, tickets and public chat. It proxies chat turns to the internal Python chat service.
- The chat service embeds the question, retrieves chunks with `$vectorSearch` filtered by `tenant_id`, assembles the prompt, and generates the answer with Ollama.
- A tenant never retrieves another tenant's documents. See [where filtering is enforced](src/README.md#where-tenant-filtering-is-enforced).

## Set up OwnHelp for your business

**What you need**

- A computer or server with an NVIDIA GPU, Docker with the Compose plugin, and the NVIDIA Container Toolkit.
- A MongoDB Atlas cluster with Vector Search and a database user.
- The fine-tuned model file (GGUF) in a folder outside this repository. The project does not download model weights.
- A domain name, if you want the assistant on a public website (step 2).

Full prerequisites and GPU setup are in the [deployment guide](deployment/README.md).

### 1. Install and start

```bash
python3 scripts/setup_stack.py \
  --model-dir /absolute/path/to/model-dir \
  --model-sha256 YOUR_VERIFIED_64_CHARACTER_SHA256
docker compose up -d --wait --wait-timeout 900
```

`setup_stack.py` verifies the checksum, asks for your Atlas connection string at a hidden prompt (or reads `MONGODB_URI` from the environment), and writes `.env` once, which Docker Compose reads automatically (no `--env-file` flag). It never overwrites an existing file, so if you have an older development `.env`, rename it to `.env.dev` first. Keep that file private. You can instead copy [`.env.example`](.env.example) and fill in every placeholder.

The first start can take a few minutes longer on a new database while Atlas builds the vector index; see [the Atlas database](deployment/README.md#the-atlas-database).

### 2. Connect it to your website

Your website's chat widget needs a safe way to reach the machine running OwnHelp. See [Put the assistant on your website](#put-the-assistant-on-your-website) below.

### 3. Create your business and add documents

Open the dashboard at the admin address from step 2 (for example `https://admin.example.com`), or at [localhost:3002/signup](http://localhost:3002/signup) on the machine itself before you have a public address. Create your business, then upload your documents (Markdown or JSON). The dashboard shows each document's progress as it is split into chunks and embedded, and the chunk explorer lets you review and edit how each document was split. You can also set the assistant's tone, instructions and similarity threshold there.

### 4. Add the widget to your website

Paste this into your website's HTML, using your own chat address and business id:

```html
<script src="https://chat.example.com/widget.js"
        data-tenant-id="your_business_id"
        data-api-url="https://chat.example.com"
        defer></script>
```

Then list your website's exact origin (for example `https://www.example.com`, with no trailing slash) as an allowed origin in the dashboard's profile page. Chat from any other website is refused. Using React? See the [widget guide](widget/README.md) for the `@ownhelp/widget` package.

## Put the assistant on your website

OwnHelp runs on your own server or computer, so your website's chat widget needs a safe way to reach it. Pick one of these options. You do not need to open your router or give anyone access to your computer.

| Option | Good for | What you need | Notes |
| :--- | :--- | :--- | :--- |
| **Cloudflare Tunnel** (recommended) | Most businesses | A domain name and a free Cloudflare account | The setup this project was built and tested with. No router changes, and your home or office address stays hidden. |
| **Tailscale Funnel** | No domain name | A free Tailscale account | Gives the machine a public HTTPS address. Not tested with this project. |
| **A rented server with a reverse proxy** (Caddy or nginx) | A machine that is always on | A server with a public address and a GPU, plus a domain name | You run the whole stack there. Not tested with this project. |
| Router port forwarding | Not recommended | Router access | Exposes your network directly. Use one of the options above instead. |

Whichever you pick, the rule is the same: only the chat widget script and chat messages should be public, and the admin dashboard should stay behind a login that only you can pass.

Guides for the recommended option (these cover Cloudflare's own screens, so this project does not repeat them step by step): [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/) (to lock the dashboard) and [rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) (to stop abuse). For the other options: [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) and [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy).

<details>
<summary>The exact Cloudflare Tunnel settings for this project</summary>

Create a remotely managed tunnel in Cloudflare Zero Trust and run `cloudflared` on the machine as a service (the Cloudflare screen shows the install command; its token is a credential, so keep it out of the repository). Cloudflare handles the HTTPS connection, so it can see the traffic in plaintext; say so in your privacy statement. Publish three routes, with `example.com` standing in for your domain:

| Hostname | Path | Service |
| :--- | :--- | :--- |
| `chat.example.com` | `^/(api/chat(/contact)?\|widget\.js)$` | `http://localhost:4002` |
| `api-admin.example.com` | none | `http://localhost:4002` |
| `admin.example.com` | none | `http://localhost:3002` |

- **Public chat address.** The path restriction exposes only the widget script and the two chat endpoints. Everything else, including the admin API, answers `404` there. The gateway serves the admin API on the same port, so do not skip the restriction.
- **Admin addresses.** Put `admin.` and `api-admin.` in one Cloudflare Access application with an Allow policy limited to your own email (not "Everyone"). Turn on **Bypass options requests to origin** in the application's CORS settings, otherwise Access redirects the dashboard's cross-origin preflight requests. Open `https://api-admin.example.com/api/health` once in your browser and sign in, because Access issues a separate login cookie per hostname.
- **`.env`.** Set `TRUST_PROXY=1` (so rate limits see the real visitor address), `ALLOWED_ORIGINS` to `https://admin.example.com` (comma-separate extra origins, no spaces) and `NEXT_PUBLIC_GATEWAY_URL=https://api-admin.example.com`. The last one is baked in at build time: run `docker compose build dashboard`, then `up -d --wait`.
- **Rate limit.** Add a Cloudflare rate-limiting rule for `chat.example.com` on `/api/chat` (for example 20 requests per minute per IP). The gateway's own limits are per process and in memory, and requests without an `Origin` header (such as curl) are not stopped by the origin check.

Check from outside: `https://chat.example.com/api/auth/config` and `/api/health` should return `404`, and `https://admin.example.com` should redirect to the Cloudflare login.

</details>

## Tune the assistant and review conversations

All of this is on the dashboard's Profile page. Changes apply on Save, and the Save bar stays on screen while you edit.

- **Business instructions, tone, temperature, context chunks and similarity threshold.** Described in the [dashboard guide](dashboard/README.md).
- **Core assistant policy.** The default policy (grounded answers only, escalate when unsure) is written for a small business. If it does not fit your site, click **Edit policy** and confirm the warning to replace it for your business only; **Reset to default** restores the original. The model was fine-tuned on the default wording, and a heavily rewritten policy can make a small model less reliable. Replies are still returned in the required JSON format, and promises to transfer or email on your behalf are still blocked.
- **Set to defaults.** Resets every agent setting (instructions, policy, tone and the three numbers) to what a new business starts with. It never touches your name, contact details, origins or documents, and nothing is stored until you Save.
- **Conversation recording (off by default).** Turn it on to keep every chat turn, not just escalated ones, for review or research. While it is on, the widget shows "This conversation is recorded to improve the assistant." A message is stored only if the business turned recording on and the widget confirmed it showed that notice, so an older cached widget is never recorded. Per message it stores the question (with e-mail addresses and phone-like numbers replaced), the answer, action, confidence, cited and retrieved document ids with scores, response time, and the settings and policy version in force, in the `conversation_logs` collection of your Atlas database. It does not store IP addresses, browser details, the visitor's session id, document text, or contact details left in the follow-up form. Records are kept until you delete them. Tell your visitors you are recording, and check whether your organization needs consent for the people you collect from.
- **Export recorded conversations.** Read-only, from the repository root:

  ```bash
  .venv/bin/python -m scripts.export_conversations --tenant your_business_id --out ~/exports/chats.json
  ```

  Use `--format csv` (or a `.csv` name) for one row per turn, and `--since` / `--until` (UTC dates) to limit the range. The JSON holds a summary (turns, answered vs escalated, mean confidence, median latency) plus conversations grouped by session. It needs `MONGODB_URI` from `.env.dev` or your environment. Write the file outside the repository, because it contains visitors' messages. Details: [scripts/README.md](scripts/README.md).

## Your database

OwnHelp stores documents, embeddings, businesses and support tickets in your own MongoDB Atlas cluster. Set `MONGODB_URI` (your connection string, which is a credential) and optionally `MONGODB_DB_NAME` (default `rag_knowledge_base`); the setup script in step 1 handles both. The stack creates the `vector_index` on first start if your database user may create search indexes, or you can create it by hand in the Atlas UI; see [the Atlas database](deployment/README.md#the-atlas-database). The embedding model (`BAAI/bge-small-en-v1.5`, 384 dimensions) and the index must agree.

## Privacy and security

The model runs on your hardware, but your documents, embeddings and tickets (and, only if you turn on [conversation recording](#tune-the-assistant-and-review-conversations), recorded chat turns) live in your Atlas cluster, and Cloudflare (if you use it) can see traffic passing through its tunnel. [The privacy trade-off](deployment/README.md#privacy-trade-off) explains what stays where, and [SECURITY.md](SECURITY.md) covers tenant isolation, secrets and how to report a problem.

## More documentation

- [Deployment guide](deployment/README.md): prerequisites, GPU setup, environment variables, model import.
- [Troubleshooting](deployment/TROUBLESHOOTING.md) and an [architecture diagram](deployment/architecture.svg).
- [Gateway](gateway/README.md), [dashboard](dashboard/README.md) and [widget](widget/README.md) guides, and the widget [API contract](widget/API_CONTRACT.md).
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, tests, the repository map and open work.

## License

MIT. See [LICENSE](LICENSE).
