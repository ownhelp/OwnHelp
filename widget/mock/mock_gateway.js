/**
 * Mock Orchestration Gateway implementing chat and contact submission as specified in
 * widget/API_CONTRACT.md. It exists so the widget can be developed and tested without
 * MongoDB, llama.cpp or the real gateway. It performs no retrieval and no generation.
 * Like the real gateway, it sends reply text without document sources or retrieval metadata.
 * It does not implement GET /api/chat (the recording-notice lookup), so the widget sees no notice.
 *
 * It mirrors the real gateway's input rules (gateway/src/routes/chat.js) so widget tests cannot
 * pass against requests the real gateway rejects: session_id must be 16 to 128 characters of
 * A-Za-z0-9_.:-, message is required and at most 2000 characters, bodies are capped at 16 KB
 * (/api/chat) and 8 KB (/api/chat/contact) and answer 400 invalid_request, and a request whose
 * Origin header is not allowed gets 403 origin_not_allowed on the POST (no Origin header, as from
 * curl, is allowed, exactly like the real gateway; preflights are always answered).
 *
 * Allowed origins: the `allowedOrigins` option, else MOCK_ALLOWED_ORIGINS (comma separated), else
 * the Vite dev and preview servers (http://localhost:5173, http://127.0.0.1:5173,
 * http://localhost:4173, http://127.0.0.1:4173). Serve the host page from one of those or set
 * MOCK_ALLOWED_ORIGINS.
 *
 * Run:  npm run mock            (listens on MOCK_PORT, default 4100)
 *
 * Magic words in the visitor message switch behaviors:
 *   "ratelimit" -> HTTP 429 JSON error with Retry-After (also a contact name containing it)
 *   "unknown"   -> HTTP 404 (unknown tenant; also a tenant_id containing it)
 *   "error"     -> SSE stream that fails mid-way with an `error` event
 *   "cutoff"    -> SSE stream that closes without a `done` event
 *   "nostream"  -> single JSON body instead of SSE
 *   "slow"      -> slower token cadence
 *   "human"     -> escalation reply that also issues a follow_up capability (token + contact details)
 */
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";

export const MAX_MESSAGE_LENGTH = 2000;
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;
export const CHAT_BODY_LIMIT = "16kb";
export const CONTACT_BODY_LIMIT = "8kb";
export const RETRY_AFTER_SEC = 30;
export const DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
];

function errorBody(code, message) {
    return { error: { code, message } };
}

function normalizeOrigin(value) {
    try {
        const url = new URL(String(value).trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin.toLowerCase() : null;
    } catch {
        return null;
    }
}

// Same rule as gateway/src/chat/origins.js: no Origin header is allowed; a browser Origin must match.
function originAllowed(header, allowed) {
    if (header === undefined || header === null || header === "") return true;
    const origin = normalizeOrigin(header);
    return origin !== null && allowed.has(origin);
}

function envOrigins() {
    const raw = process.env.MOCK_ALLOWED_ORIGINS;
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
}

function tokenize(text) {
    return text.match(/\S+\s*/g) || [];
}

function buildAnswer(message) {
    return (
        `This is a mocked answer to: "${message}". ` +
        "Items returned within 30 days are eligible for a full refund."
    );
}

function sseEvent(event, payload) {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function createMockApp({ tokenDelayMs = 25, allowedOrigins } = {}) {
    const app = express();
    const allowed = new Set(
        (allowedOrigins || envOrigins() || DEFAULT_ALLOWED_ORIGINS).map(normalizeOrigin).filter(Boolean)
    );
    const notAllowed = (res) =>
        res.status(403).json(errorBody("origin_not_allowed", "This site is not allowed to use this support assistant."));
    const unknownTenant = (res) =>
        res.status(404).json(errorBody("unknown_tenant", "No support assistant is configured for this site."));
    const rateLimited = (res) => {
        res.set("Retry-After", String(RETRY_AFTER_SEC));
        return res.status(429).json(errorBody("rate_limited", "Too many messages. Please wait a moment."));
    };

    // The real gateway must NOT reuse the admin CORS policy: the widget is embedded on
    // arbitrary storefront origins and sends no cookies (see API_CONTRACT.md). Like the real one,
    // it echoes the Origin (so the widget can read a 403 body) and enforces the allowlist on the POST.
    app.use(cors({ origin: true, methods: ["POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
    app.set("json spaces", 4);

    // Demo-only capability store (in memory, never expires): maps a follow_up token to its
    // tenant + session so the contact route can enforce scoping and first-submission-wins.
    const capabilities = new Map();
    app.post("/api/chat/contact", express.json({ limit: CONTACT_BODY_LIMIT }), (req, res) => {
        const body = req.body || {};
        const { tenant_id: tenantId, session_id: sessionId, follow_up_token: token } = body;
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim() : "";
        if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId.trim()) ||
            typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId) ||
            !name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name) ||
            email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json(errorBody("invalid_request", "A valid conversation, name, and email are required."));
        }
        if (name.toLowerCase().includes("ratelimit")) return rateLimited(res);
        if (tenantId.includes("unknown")) return unknownTenant(res);
        if (!originAllowed(req.headers.origin, allowed)) return notAllowed(res);
        const scope = typeof token === "string" ? capabilities.get(token) : undefined;
        if (!scope || scope.tenantId !== tenantId || scope.sessionId !== sessionId) {
            return res.status(403).json(errorBody("invalid_follow_up", "This follow-up form has expired or is invalid."));
        }
        if (scope.saved && (scope.saved.name !== name || scope.saved.email !== email)) {
            return res.status(409).json(errorBody("contact_already_submitted",
                "Contact details have already been submitted or this request is unavailable."));
        }
        scope.saved = { name, email };
        return res.json({ status: "saved" });
    });

    app.post("/api/chat", express.json({ limit: CHAT_BODY_LIMIT }), (req, res) => {
        const body = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return res.status(400).json(errorBody("invalid_request", "Request body must be a JSON object."));
        }
        const { tenant_id: rawTenantId, message: rawMessage, session_id: sessionId } = body;

        if (typeof rawTenantId !== "string" || !rawTenantId.trim()) {
            return res.status(400).json(errorBody("invalid_request", "tenant_id is required"));
        }
        if (typeof rawMessage !== "string" || !rawMessage.trim()) {
            return res.status(400).json(errorBody("invalid_request", "message is required"));
        }
        if (rawMessage.length > MAX_MESSAGE_LENGTH) {
            return res
                .status(400)
                .json(errorBody("message_too_long", `message exceeds ${MAX_MESSAGE_LENGTH} characters`));
        }
        if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
            return res.status(400).json(errorBody("invalid_request",
                "session_id is required (16-128 characters: letters, digits, '_', '-', '.', ':')"));
        }
        const tenantId = rawTenantId.trim();
        const message = rawMessage.trim();

        const lower = message.toLowerCase();
        if (lower.includes("ratelimit")) return rateLimited(res);
        if (lower.includes("unknown") || tenantId.includes("unknown") || !TENANT_ID_PATTERN.test(tenantId)) {
            return unknownTenant(res);
        }
        if (!originAllowed(req.headers.origin, allowed)) return notAllowed(res);

        const answer = lower.includes("human") ? "A staff member will need to help with that request. You can request email follow-up below." : buildAnswer(message);
        let followUp;
        if (lower.includes("human")) {
            const token = crypto.randomUUID();
            capabilities.set(token, { tenantId, sessionId });
            followUp = { available: true, token, contact_email: "support@example.test", contact_phone: "+1 555 123 4567" };
        }
        const wantsStream = String(req.get("accept") || "").includes("text/event-stream");

        if (lower.includes("nostream") || !wantsStream) {
            return res.json({ answer, session_id: sessionId, ...(followUp ? { follow_up: followUp } : {}) });
        }

        res.status(200).set({
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders();

        const delay = lower.includes("slow") ? tokenDelayMs * 12 : tokenDelayMs;
        const tokens = tokenize(answer);
        const failAt = lower.includes("error") ? Math.floor(tokens.length / 2) : -1;
        const cutAt = lower.includes("cutoff") ? Math.floor(tokens.length / 2) : -1;
        let index = 0;

        const timer = setInterval(() => {
            if (index === failAt) {
                res.write(sseEvent("error", { code: "generation_failed", message: "The assistant ran into a problem." }));
                clearInterval(timer);
                return res.end();
            }
            if (index === cutAt) {
                clearInterval(timer);
                return res.end();
            }
            if (index < tokens.length) {
                res.write(sseEvent("token", { text: tokens[index] }));
                index += 1;
                return;
            }
            res.write(sseEvent("done", followUp ? { follow_up: followUp } : {}));
            clearInterval(timer);
            res.end();
        }, delay);

        // Visitor closed the panel / hit Stop: stop generating.
        res.on("close", () => clearInterval(timer));
    });

    app.all("/api/chat", (req, res) => {
        res.set("Allow", "POST, OPTIONS");
        return res.status(405).json(errorBody("method_not_allowed", "Use POST /api/chat."));
    });
    app.use((req, res) => res.status(404).json(errorBody("not_found", "Not found.")));
    // Malformed or oversized JSON bodies get the same 400 envelope as the real gateway.
    // eslint-disable-next-line no-unused-vars
    app.use((error, req, res, next) => {
        if (error && (error.type === "entity.parse.failed" || error.type === "entity.too.large")) {
            return res.status(400).json(errorBody("invalid_request", "Request body is not valid JSON or is too large."));
        }
        return res.status(500).json(errorBody("internal_error", "Something went wrong."));
    });

    return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    const port = Number(process.env.MOCK_PORT || 4100);
    createMockApp().listen(port, () => {
        console.log(`Mock gateway (POST /api/chat) listening on http://localhost:${port}`);
    });
}
