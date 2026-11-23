/**
 * POST /api/chat: public, anonymous endpoint used by the embeddable widget.
 * Contract: widget/API_CONTRACT.md.
 *
 * This router is mounted BEFORE the admin CORS / CSRF / requireAuth middleware (see server.js).
 * It therefore does its own: CORS (POST/OPTIONS, Content-Type only, no credentials), per-tenant
 * origin allowlist, rate limiting, body cap and input validation. Visitors never reach MongoDB or
 * the model directly; this route loads the tenant, then hands retrieval and generation to the
 * chat backend, which scopes every $vectorSearch by tenant_id.
 *
 * Routes (all anonymous; no cookie is read or set):
 *   OPTIONS /api/chat, /api/chat/contact  204 preflight
 *   GET     /api/chat?tenant_id=  { record_conversations } so the widget can show its recording notice
 *   POST    /api/chat          SSE stream (Accept: text/event-stream) or one JSON body; 16 KB cap
 *   POST    /api/chat/contact  saves a visitor name/email on an escalated ticket; 8 KB cap
 *
 * Inputs: widget JSON bodies, tenant document, CHAT_* env settings (chat/config.js).
 * Outputs: token/done/error events or JSON { error: { code, message } }. The widget embeds these
 * in third-party pages, which is why the error shape is stable and carries no internals.
 * Callers: widget/ bundle served from routes/widget.js; any HTTP client.
 */
const express = require("express");
const { getBusinessesCollection } = require("../db/mongo");
const { getAppMode } = require("../config/mode");
const { isPresetTenantId, isValidTenantId } = require("../config/presets");
const { getChatConfig } = require("../chat/config");
const { resolveAllowedOrigins, isOriginAllowed } = require("../chat/origins");
const { getChatBackend } = require("../chat/backend");
const {
    buildEscalationTicket,
    isEscalation,
    saveEscalationTicket,
    withTimeout,
    SAVE_TIMEOUT_MS,
} = require("../chat/escalation");
const { shouldRecordConversation, buildConversationLogEntry, saveConversationLog } = require("../chat/conversationLog");
const { SessionHistory } = require("../chat/sessionHistory");
const { SlidingWindowLimiter } = require("../middleware/rateLimit");

const { issueToken, readToken, validEmail, businessContact, saveContact } = require("../chat/followUp");

const MAX_MESSAGE_LENGTH = 2000;
const MAX_SOURCES = 20;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{16,128}$/;

const ipLimiter = new SlidingWindowLimiter();
const sessionLimiter = new SlidingWindowLimiter();
const sessionHistory = new SessionHistory();

/** Test hook: clears limiter and conversation state. */
function resetChatState() {
    ipLimiter.reset();
    sessionLimiter.reset();
    sessionHistory.reset();
}

function sendError(res, status, code, message) {
    return res.status(status).json({ error: { code, message } });
}

function applyCorsHeaders(req, res, next) {
    // No credentials are ever allowed. The Origin is echoed so the widget can read error bodies,
    // including a 403 origin_not_allowed; the per-tenant allowlist is enforced on the POST itself
    // because a preflight carries no tenant_id.
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }
    res.append("Vary", "Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
}

function handlePreflight(req, res) {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    return res.status(204).end();
}

function clientIp(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimited(res, retryAfterSec) {
    res.setHeader("Retry-After", String(retryAfterSec));
    return sendError(res, 429, "rate_limited", "Too many messages. Please wait a moment.");
}

// IP limit runs before body parsing and any database work, so a flood is cheap to reject. It uses
// req.ip, which only reflects the real client when TRUST_PROXY is set behind a reverse proxy.
function limitByIp(req, res, next) {
    const config = getChatConfig(process.env);
    const result = ipLimiter.hit(`ip:${clientIp(req)}`, config.rateLimitPerIp, config.rateLimitWindowMs);
    if (!result.allowed) return rateLimited(res, result.retryAfterSec);
    return next();
}

// Clamps an admin-edited setting into [min, max]; a missing or non-numeric value takes `fallback`.
function numberOr(value, fallback, min, max) {
    const number = Number(value);
    if (value === undefined || value === null || Number.isNaN(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

/** Normalizes businesses.agent_config for the backend; missing values take the documented defaults. */
function buildAgentConfig(raw) {
    const config = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
    return {
        system_prompt: text(config.system_prompt, 4000),
        core_policy: text(config.core_policy, 8000),
        agent_tone: text(config.agent_tone, 200),
        temperature: numberOr(config.temperature, 0.2, 0, 1),
        max_context_chunks: Math.round(numberOr(config.max_context_chunks, 4, 1, 8)),
        similarity_threshold: numberOr(config.similarity_threshold, 0.7, 0, 1),
    };
}

/**
 * Loads a tenant the same way the admin API scopes them: standard mode never serves the preset
 * (synthetic training) tenants, preset_training mode serves only them.
 */
async function loadTenant(tenantId) {
    if (!isValidTenantId(tenantId)) return null;
    const presetOnly = getAppMode(process.env) === "preset_training";
    if (isPresetTenantId(tenantId) !== presetOnly) return null;
    const businesses = await getBusinessesCollection();
    return businesses.findOne(
        { tenant_id: tenantId },
        {
            projection: {
                _id: 0,
                tenant_id: 1,
                agent_config: 1,
                widget_config: 1,
                contact_email: 1,
                contact_phone: 1,
                record_conversations: 1,
            },
        }
    );
}

/**
 * Retrieval details are never sent to the visitor. They are kept only to fill the human-review ticket
 * when the model escalates, and even there only as doc_id, section and score: never chunk text or
 * embeddings.
 */
function sanitizeSources(sources) {
    if (!Array.isArray(sources)) return [];
    return sources
        .filter((source) => source && typeof source === "object")
        .slice(0, MAX_SOURCES)
        .map((source) => ({
            doc_id: String(source.doc_id ?? "unknown"),
            section: String(source.section ?? ""),
            score: typeof source.score === "number" && Number.isFinite(source.score) ? source.score : 0,
        }));
}

const UNAVAILABLE_MESSAGE = "The support assistant is temporarily unavailable. Please try again shortly.";
const GENERATION_FAILED_MESSAGE = "The assistant ran into a problem.";
const INTERRUPTED_MESSAGE = "The connection was interrupted before the reply finished.";

// Sentinel for the pre-stream grace-window race in handleChat: distinguishes "timer fired" from a real iterator result.
const STILL_WAITING = Symbol("still waiting for the first token");

// Appended to the reply when an escalation ticket could not be saved, so no follow-up form is offered.
const FOLLOW_UP_UNAVAILABLE = "The email follow-up form is temporarily unavailable. Please contact the business directly.";

// Stored in history when the model escalated with an empty answer, so the turn is still remembered.
const ESCALATED_WITHOUT_REPLY = "(The assistant escalated without a reply.)";

/**
 * Remembers a finished exchange for follow-up questions and, when the model escalated it, saves the
 * conversation as a human-review ticket. Returns its id only after an acknowledged save.
 * A save failure leaves the generated answer intact but never offers a follow-up capability.
 */
async function recordTurn({ tenantId, sessionId, message, answer, done, sources, historyMaxMessages }) {
    const escalated = isEscalation(done);
    const text = answer.trim() ? answer : escalated ? ESCALATED_WITHOUT_REPLY : "";
    if (!text) return;
    const rememberedReply = sessionHistory.add(tenantId, sessionId, message, text, historyMaxMessages);
    if (!escalated) return;
    try {
        const ticket = buildEscalationTicket({
            tenantId,
            sessionId,
            message,
            answer: text,
            done,
            sources,
            transcript: sessionHistory.getTranscript(tenantId, sessionId),
        });
        await saveEscalationTicket(ticket);
        return ticket.ticket_id;
    } catch (error) {
        console.error("[POST /api/chat] Could not save escalation ticket:", error && error.name);
        // The visitor was shown FOLLOW_UP_UNAVAILABLE, so keep the remembered reply consistent with
        // it (capped at the 2000-character history limit) for the model's next turn.
        rememberedReply.content = `${text.slice(0, 2000 - FOLLOW_UP_UNAVAILABLE.length - 2)}\n\n${FOLLOW_UP_UNAVAILABLE}`;
    }
}

/**
 * Drives the backend iterator. Returns { completed } (true only after a `done` event) and reports
 * through `sink`; the caller decides whether a failure was caused by the deadline (`timedOut`).
 * `first` is the already-pulled first iterator result (used to decide HTTP status before streaming).
 */
async function consumeEvents(iterator, first, sink, isGone) {
    let current = await first; // may be a promise for a result that is still pending
    while (true) {
        if (isGone()) return { completed: false };
        if (current.done) {
            // The backend closed the stream without a done event: the connection was cut short.
            sink.onError("stream_interrupted", INTERRUPTED_MESSAGE);
            return { completed: false };
        }
        const event = current.value || {};
        if (event.type === "sources") {
            sink.onSources(sanitizeSources(event.sources));
        } else if (event.type === "token" && typeof event.text === "string") {
            sink.onToken(event.text);
        } else if (event.type === "done") {
            sink.onDone(event);
            return { completed: true };
        } else if (event.type === "error") {
            sink.onError("generation_failed", GENERATION_FAILED_MESSAGE);
            return { completed: false };
        }
        current = await iterator.next();
    }
}

/**
 * POST /api/chat. Auth: none. Order matters: validate input, per-session rate limit, load tenant
 * (404 unknown_tenant, also for a tenant of the wrong mode so existence is not leaked), check
 * the tenant's origin allowlist (403 origin_not_allowed), then stream. The tenant id sent to the
 * backend is the stored one, never the raw request value.
 * Responses: 200 SSE token/done/error or JSON { answer, follow_up? }; 400 invalid_request /
 * message_too_long; 403; 404; 429 rate_limited (+ Retry-After); 503 service_unavailable when the
 * backend fails before the first token (see CHAT_PRE_STREAM_WAIT_MS).
 */
async function handleChat(req, res) {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendError(res, 400, "invalid_request", "Request body must be a JSON object.");
    }
    const { tenant_id: rawTenantId, message: rawMessage, session_id: sessionId } = body;

    // Only plain strings are accepted, so a tenant_id such as {"$ne": null} can never reach a query.
    if (typeof rawTenantId !== "string" || !rawTenantId.trim()) {
        return sendError(res, 400, "invalid_request", "tenant_id is required");
    }
    if (typeof rawMessage !== "string" || !rawMessage.trim()) {
        return sendError(res, 400, "invalid_request", "message is required");
    }
    if (rawMessage.length > MAX_MESSAGE_LENGTH) {
        return sendError(res, 400, "message_too_long", `message exceeds ${MAX_MESSAGE_LENGTH} characters`);
    }
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        return sendError(
            res,
            400,
            "invalid_request",
            "session_id is required (16-128 characters: letters, digits, '_', '-', '.', ':')"
        );
    }

    const config = getChatConfig(process.env);
    const tenantId = rawTenantId.trim();
    const message = rawMessage.trim();

    const sessionResult = sessionLimiter.hit(
        `session:${tenantId}:${sessionId}`,
        config.rateLimitPerSession,
        config.rateLimitWindowMs
    );
    if (!sessionResult.allowed) return rateLimited(res, sessionResult.retryAfterSec);

    let tenant;
    try {
        tenant = await loadTenant(tenantId);
    } catch (error) {
        console.error("[POST /api/chat] Tenant lookup failed:", error.name);
        return sendError(res, 503, "service_unavailable", UNAVAILABLE_MESSAGE);
    }
    if (!tenant) {
        return sendError(res, 404, "unknown_tenant", "No support assistant is configured for this site.");
    }

    const allowedOrigins = resolveAllowedOrigins(tenant, config.defaultAllowedOrigins);
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
        return sendError(res, 403, "origin_not_allowed", "This site is not allowed to use this support assistant.");
    }

    const wantsStream = String(req.get("accept") || "").includes("text/event-stream");
    const startedAt = Date.now();
    const recordThisTurn = shouldRecordConversation(tenant, body);
    const payload = {
        tenant_id: tenant.tenant_id,
        query: message,
        history: sessionHistory.get(tenant.tenant_id, sessionId),
        agent_config: buildAgentConfig(tenant.agent_config),
        business_contact: businessContact(tenant),
    };

    // Abort generation as soon as the visitor goes away or the overall deadline passes.
    const controller = new AbortController();
    let finished = false;
    let timedOut = false;
    res.on("close", () => {
        if (!finished) controller.abort();
    });
    const deadline = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, config.maxDurationMs);
    const isGone = () => controller.signal.aborted && !timedOut;
    // A stream that ends or fails because the deadline passed is reported as a timeout.
    const failure = (code, text) =>
        timedOut ? { code: "timeout", message: "The assistant took too long to respond." } : { code, message: text };

    // Retrieval details are never sent to the visitor. They are kept only to fill the human-review
    // ticket when the model escalates, and even there only as doc_id, section and score.
    let sources = [];
    let pendingFirst = null; // set when the model is still working after the grace window
    let iterator = null;
    let heartbeat = null;
    const cleanup = async () => {
        clearTimeout(deadline);
        if (heartbeat) clearInterval(heartbeat);
        finished = true;
        if (iterator && typeof iterator.return === "function") {
            try {
                await iterator.return();
            } catch {
                // the backend stream is already closed
            }
        }
    };

    try {
        let first;
        try {
            iterator = getChatBackend(process.env).chat(payload, { signal: controller.signal })[Symbol.asyncIterator]();
            first = await iterator.next();
            // The backend reports retrieval first. Read past it, but only briefly: a model that cannot
            // be reached fails within the grace window and gets a real HTTP status, while a slow model
            // is not held back (the stream starts early and heartbeats keep it alive).
            while (!first.done && first.value && first.value.type === "sources") {
                sources = sanitizeSources(first.value.sources);
                const nextResult = iterator.next();
                let waitTimer;
                const raced = await Promise.race([
                    nextResult,
                    new Promise((resolve) => {
                        waitTimer = setTimeout(() => resolve(STILL_WAITING), config.preStreamWaitMs);
                    }),
                ]);
                clearTimeout(waitTimer);
                if (raced === STILL_WAITING) {
                    pendingFirst = nextResult;
                    break;
                }
                first = raced;
            }
        } catch (error) {
            if (isGone()) return undefined;
            if (timedOut) return sendError(res, 504, "timeout", "The assistant took too long to respond.");
            // Name and message only (the backend's own messages carry no secrets), so an operator can
            // tell a wrong token from an unreachable service.
            console.error("[POST /api/chat] Backend unavailable:", error.name, "-", error.message);
            return sendError(res, 503, "service_unavailable", UNAVAILABLE_MESSAGE);
        }
        if (isGone()) return undefined;
        if (timedOut) return sendError(res, 504, "timeout", "The assistant took too long to respond.");
        if (!pendingFirst && (first.done || (first.value && first.value.type === "error"))) {
            // Nothing has been streamed yet, so a real HTTP status can still be returned.
            const code = first.value && first.value.code ? ` (${String(first.value.code).slice(0, 40)})` : "";
            console.error(`[POST /api/chat] Backend reported a failure before any reply${code}.`);
            return sendError(res, 503, "service_unavailable", UNAVAILABLE_MESSAGE);
        }

        let answer = "";
        let outcome;
        let doneEvent = null;
        const turn = () => ({
            tenantId: tenant.tenant_id,
            sessionId,
            message,
            answer,
            done: doneEvent,
            sources,
            historyMaxMessages: config.historyMaxMessages,
        });

        const persistTurn = async (onNotice = () => {}) => {
            if (recordThisTurn) {
                // Opt-in research log: awaited with its own timeout, never throws, and records the
                // model's answer before any follow-up notice is appended to it.
                await saveConversationLog(
                    buildConversationLogEntry({
                        tenantId: tenant.tenant_id,
                        sessionId,
                        message,
                        answer,
                        done: doneEvent,
                        sources,
                        agentConfig: payload.agent_config,
                        latencyMs: Date.now() - startedAt,
                    })
                );
            }
            const ticketId = await recordTurn(turn());
            if (!ticketId) {
                if (isEscalation(doneEvent)) {
                    const notice = `\n\n${FOLLOW_UP_UNAVAILABLE}`;
                    answer += notice;
                    onNotice(notice);
                }
                return {};
            }
            const contact = businessContact(tenant);
            return { follow_up: {
                available: true,
                token: issueToken(tenant.tenant_id, sessionId, ticketId),
                ...(contact.email ? { contact_email: contact.email } : {}),
                ...(contact.phone ? { contact_phone: contact.phone } : {}),
            } };
        };

        if (!wantsStream) {
            let errorEvent = null;
            outcome = await consumeEvents(
                iterator,
                pendingFirst || first,
                {
                    onSources: (items) => {
                        sources = items;
                    },
                    onToken: (text) => {
                        answer += text;
                    },
                    onDone: (event) => {
                        doneEvent = event;
                    },
                    onError: (code, text) => {
                        errorEvent = { code, text };
                    },
                },
                isGone
            ).catch((error) => {
                if (!isGone()) console.error("[POST /api/chat] Generation failed:", error.name);
                errorEvent = timedOut
                    ? { code: "timeout", text: "The assistant took too long to respond." }
                    : { code: "generation_failed", text: GENERATION_FAILED_MESSAGE };
                return { completed: false };
            });
            if (isGone()) return undefined;
            if (errorEvent || !outcome.completed) {
                return sendError(res, 503, "service_unavailable", UNAVAILABLE_MESSAGE);
            }
            const metadata = await persistTurn();
            return res.json({ answer, session_id: sessionId, ...metadata });
        }

        res.status(200);
        res.set({
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        res.flushHeaders();
        if (res.socket && typeof res.socket.setNoDelay === "function") res.socket.setNoDelay(true);

        const write = (chunk) => {
            if (!res.writableEnded && !res.destroyed) res.write(chunk);
        };
        const sendEvent = (name, data) => write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        // Keeps proxies and the widget's idle timer alive while a slow local model reads the prompt.
        heartbeat = setInterval(() => write(": ping\n\n"), config.heartbeatMs);
        if (typeof heartbeat.unref === "function") heartbeat.unref();

        try {
            outcome = await consumeEvents(
                iterator,
                pendingFirst || first,
                {
                    onSources: (items) => {
                        sources = items;
                    },
                    onToken: (text) => {
                        answer += text;
                        sendEvent("token", { text });
                    },
                    onDone: (event) => {
                        // The `done` event is sent after persistTurn(), once the follow-up outcome is known.
                        doneEvent = event;
                    },
                    onError: (code, text) => sendEvent("error", failure(code, text)),
                },
                isGone
            );
        } catch (error) {
            if (!isGone()) {
                console.error("[POST /api/chat] Generation failed:", error.name);
                // A transport failure mid-reply (for example the chat service went away), not bad model output.
                sendEvent("error", failure("stream_interrupted", INTERRUPTED_MESSAGE));
            }
            outcome = { completed: false };
        }
        if (outcome.completed) {
            const metadata = await persistTurn((text) => {
                if (!isGone()) sendEvent("token", { text });
            });
            if (!isGone()) sendEvent("done", metadata);
        }
        finished = true;
        if (!res.writableEnded) res.end();
        return undefined;
    } finally {
        await cleanup();
    }
}

/**
 * POST /api/chat/contact. Auth: the capability token (follow_up_token) issued with an escalation,
 * not a cookie; it is bound to tenant + session + ticket, so it cannot write to another ticket.
 * Responses: 200 { status: "saved" }; 400 invalid_request; 403 origin_not_allowed /
 * invalid_follow_up; 404 unknown_tenant; 409 contact_already_submitted; 429; 503.
 * "saved" means the database acknowledged the write; no email is sent.
 */
async function handleContact(req, res) {
    const body = req.body || {};
    const { tenant_id: tenantId, session_id: sessionId, follow_up_token: token } = body;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (typeof tenantId !== "string" || !isValidTenantId(tenantId) ||
        typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId) ||
        !name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name) || !validEmail(email)) {
        return sendError(res, 400, "invalid_request", "A valid conversation, name, and email are required.");
    }
    const config = getChatConfig(process.env);
    const limited = sessionLimiter.hit(`contact:${tenantId}:${sessionId}`, config.rateLimitPerSession, config.rateLimitWindowMs);
    if (!limited.allowed) return rateLimited(res, limited.retryAfterSec);
    try {
        const tenant = await withTimeout(loadTenant(tenantId), SAVE_TIMEOUT_MS);
        if (!tenant) return sendError(res, 404, "unknown_tenant", "No support assistant is configured for this site.");
        if (!isOriginAllowed(req.headers.origin, resolveAllowedOrigins(tenant, config.defaultAllowedOrigins))) {
            return sendError(res, 403, "origin_not_allowed", "This site is not allowed to use this support assistant.");
        }
        const claims = readToken(token, tenantId, sessionId);
        if (!claims) return sendError(res, 403, "invalid_follow_up", "This follow-up form has expired or is invalid.");
        if (!await saveContact(claims, { name, email })) {
            return sendError(res, 409, "contact_already_submitted", "Contact details have already been submitted or this request is unavailable.");
        }
        return res.json({ status: "saved" });
    } catch (error) {
        console.error("[POST /api/chat/contact] Save failed:", error.name);
        return sendError(res, 503, "service_unavailable", "Unable to save your request. Please try again.");
    }
}

/**
 * GET /api/chat?tenant_id=... Auth: none. Tells the widget whether this business records chats, so
 * it can show the notice before the first message. Same tenant lookup, mode rules and origin check
 * as POST. Response 200 { record_conversations: boolean }; 400 invalid_request; 403
 * origin_not_allowed; 404 unknown_tenant. Lives on /api/chat because that path is already public
 * on the tunnel (no extra route to expose).
 */
async function handleChatSettings(req, res) {
    const tenantId = req.query.tenant_id;
    if (typeof tenantId !== "string" || !tenantId.trim()) {
        return sendError(res, 400, "invalid_request", "tenant_id is required");
    }
    let tenant;
    try {
        tenant = await loadTenant(tenantId.trim());
    } catch (error) {
        console.error("[GET /api/chat] Tenant lookup failed:", error.name);
        return sendError(res, 503, "service_unavailable", UNAVAILABLE_MESSAGE);
    }
    if (!tenant) {
        return sendError(res, 404, "unknown_tenant", "No support assistant is configured for this site.");
    }
    const config = getChatConfig(process.env);
    if (!isOriginAllowed(req.headers.origin, resolveAllowedOrigins(tenant, config.defaultAllowedOrigins))) {
        return sendError(res, 403, "origin_not_allowed", "This site is not allowed to use this support assistant.");
    }
    return res.json({ record_conversations: tenant.record_conversations === true });
}

// Per-route body parsers (small caps) are attached here instead of globally because this router is
// mounted before server.js's 2 MB express.json, and anonymous callers must get the smaller limit.
const router = express.Router();
router.use(applyCorsHeaders);
router.options("/", handlePreflight);
router.options("/contact", handlePreflight);
router.post("/contact", limitByIp, express.json({ limit: "8kb" }), (req, res, next) => {
    handleContact(req, res).catch(next);
});
router.post("/", limitByIp, express.json({ limit: "16kb" }), (req, res, next) => {
    handleChat(req, res).catch(next);
});
router.get("/", limitByIp, (req, res, next) => {
    handleChatSettings(req, res).catch(next);
});
router.all("/", (req, res) => {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return sendError(res, 405, "method_not_allowed", "Use POST or GET /api/chat.");
});
router.use((req, res) => sendError(res, 404, "not_found", "Not found."));
// eslint-disable-next-line no-unused-vars
router.use((error, req, res, next) => {
    if (res.headersSent) {
        return res.end();
    }
    if (error && (error.type === "entity.parse.failed" || error.type === "entity.too.large")) {
        return sendError(res, 400, "invalid_request", "Request body is not valid JSON or is too large.");
    }
    console.error("[POST /api/chat] Unexpected error:", error && error.name);
    return sendError(res, 500, "internal_error", "Something went wrong.");
});

module.exports = { router, resetChatState, buildAgentConfig };
