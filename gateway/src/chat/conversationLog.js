/**
 * Optional research log of public chat turns (collection `conversation_logs`).
 *
 * Off by default. A turn is recorded only when BOTH hold: the business turned on
 * `record_conversations` in its config, and the widget confirmed it showed the visitor the
 * recording notice (`recording_notice: true` in the request). A widget that never displayed the
 * notice, including an older cached copy, is therefore never recorded.
 *
 * What is stored per turn: the visitor's question (e-mail addresses and phone-like numbers
 * replaced), the answer, the model's action/confidence/cited sources, which documents retrieval
 * returned (id, section, score only; never chunk text), latency, and the settings and policy
 * version in force. Not stored: IP address, user agent, the raw session id (a one-way hash groups
 * turns of a conversation) or any contact details a visitor leaves in the follow-up form.
 *
 * Saving never affects the chat: failures are logged by name only and swallowed.
 * Callers: routes/chat.js (persistTurn). Export for analysis: scripts/export_conversations.py.
 */
const crypto = require("crypto");
const { getConversationLogsCollection } = require("../db/mongo");
const { withTimeout, SAVE_TIMEOUT_MS } = require("./escalation");
const { version: POLICY_VERSION } = require("../../../src/inference/system_policy.json");

const MAX_TEXT_LENGTH = 8000;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_PATTERN = /(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g;

/** Replaces e-mail addresses and phone-like numbers (9+ digits) in a visitor's message. */
function redactContactDetails(text) {
    return String(text)
        .replace(EMAIL_PATTERN, "[email]")
        .replace(PHONE_PATTERN, (match) => (match.replace(/\D/g, "").length >= 9 ? "[phone]" : match));
}

/** True only when the business opted in and the widget confirmed it displayed the notice. */
function shouldRecordConversation(tenant, body) {
    return Boolean(tenant) && tenant.record_conversations === true && Boolean(body) && body.recording_notice === true;
}

/** One-way id grouping the turns of a conversation without storing the visitor's session id. */
function buildConversationId(tenantId, sessionId) {
    const digest = crypto.createHash("sha256").update(`conversation\u0000${tenantId}\u0000${sessionId}`).digest("hex");
    return `CONV-${digest.slice(0, 16).toUpperCase()}`;
}

function clip(text) {
    const value = String(text ?? "");
    return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}

/**
 * Builds the stored document. `done` is the backend's done event (may be null), `sources` the
 * sanitized { doc_id, section, score } entries and `agentConfig` the normalized config used.
 */
function buildConversationLogEntry({
    tenantId,
    sessionId,
    message,
    answer,
    done,
    sources,
    agentConfig,
    latencyMs,
    model = process.env.OLLAMA_MODEL || null,
    now = new Date(),
}) {
    const doneEvent = done && typeof done === "object" ? done : {};
    return {
        tenant_id: tenantId,
        conversation_id: buildConversationId(tenantId, sessionId),
        created_at: now.toISOString(),
        question: clip(redactContactDetails(message)),
        answer: clip(answer),
        action: doneEvent.action === "escalate" ? "escalate" : "answer",
        confidence: typeof doneEvent.confidence === "number" ? doneEvent.confidence : null,
        cited_sources: Array.isArray(doneEvent.cited_sources)
            ? doneEvent.cited_sources.slice(0, 20).map((source) => String(source))
            : [],
        retrieved: Array.isArray(sources) ? sources : [],
        latency_ms: Number.isFinite(latencyMs) ? Math.round(latencyMs) : null,
        settings: {
            temperature: agentConfig.temperature,
            max_context_chunks: agentConfig.max_context_chunks,
            similarity_threshold: agentConfig.similarity_threshold,
            custom_core_policy: Boolean(agentConfig.core_policy),
        },
        policy_version: POLICY_VERSION,
        model,
    };
}

/** Inserts one entry. Never throws; resolves true only when the database acknowledged the write. */
async function saveConversationLog(entry, { timeoutMs = SAVE_TIMEOUT_MS } = {}) {
    try {
        const result = await withTimeout(
            (async () => {
                const collection = await getConversationLogsCollection();
                return collection.insertOne(entry, { maxTimeMS: timeoutMs });
            })(),
            timeoutMs
        );
        return Boolean(result && result.acknowledged === true);
    } catch (error) {
        console.error("[POST /api/chat] Could not save conversation log:", error && error.name);
        return false;
    }
}

module.exports = {
    redactContactDetails,
    shouldRecordConversation,
    buildConversationId,
    buildConversationLogEntry,
    saveConversationLog,
};
