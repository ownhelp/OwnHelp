// HTTP client for the gateway: `streamChat` (POST /api/chat, SSE with a JSON fallback) and
// `submitContact` (POST /api/chat/contact). Framework-free so it can be used without the React UI.
// The wire format is specified in widget/API_CONTRACT.md.
import { normalizeFollowUp } from "./followUp.js";
import { createSseParser } from "./sse.js";

/**
 * Error thrown by this module. `code` is a stable gateway code (e.g. `rate_limited`,
 * `origin_not_allowed`) or a client-side one: `network_error`, `timeout`, `aborted`,
 * `stream_interrupted`, `stream_error`, `invalid_response`, or `http_<status>` when the error
 * body had no code. `message` is for developers; show visitors `visitorMessage(error)` instead.
 */
export class ChatError extends Error {
    constructor(code, message, status, retryAfterSec) {
        super(message);
        this.name = "ChatError";
        this.code = code;
        this.status = status;
        // Seconds from the Retry-After header of a 429, when the gateway sent one.
        this.retryAfterSec = retryAfterSec;
    }
}

/** Abort if no bytes arrive for this long. The gateway's `: ping` heartbeats keep slow models alive. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30000;

function chatUrl(apiUrl) {
    return `${String(apiUrl).replace(/\/+$/, "")}/api/chat`;
}

// Builds a ChatError from a non-2xx response using the contract's `{error: {code, message}}`
// body; tolerates non-JSON bodies (e.g. a proxy's HTML error page) by falling back to `http_<status>`.
async function readHttpError(response) {
    let code = `http_${response.status}`;
    let message = `Request failed (${response.status})`;
    try {
        const body = await response.json();
        if (body && body.error) {
            code = body.error.code || code;
            message = body.error.message || message;
        }
    } catch {
        // non-JSON error body
    }
    const retryAfter = Number(response.headers && response.headers.get && response.headers.get("retry-after"));
    return new ChatError(code, message, response.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}

/**
 * Sends one visitor message to the gateway and streams the reply.
 *
 * Supports the SSE response described in widget/API_CONTRACT.md and falls back to a
 * single JSON body when the gateway (or a buffering proxy) does not stream.
 *
 * Resolves with `{ answer, sessionId, followUp? }`; rejects with `ChatError`
 * (`code === "aborted"` when the caller cancels).
 *
 * @param {object} options
 * @param {string} options.apiUrl Gateway base URL (a trailing slash is ignored).
 * @param {string} options.tenantId Tenant to chat with.
 * @param {string} options.message Visitor message (the gateway allows at most 2000 characters).
 * @param {string} options.sessionId Visitor session id, see `getSessionId`.
 * @param {boolean} [options.recordingNotice=false] Set only when the recording notice is on screen;
 *   the gateway records a turn only when this is true and the business opted in.
 * @param {AbortSignal} [options.signal] Cancels the request (rejects with code `aborted`).
 * @param {(text: string) => void} [options.onToken] Called with each text delta as it arrives.
 * @param {number} [options.idleTimeoutMs=30000] Max silence before rejecting with `timeout`; 0 disables.
 * @param {typeof fetch} [options.fetchImpl] Replacement for `fetch`.
 * @returns {Promise<{answer: string, sessionId: string, followUp?: object}>}
 */
export async function streamChat({
    apiUrl,
    tenantId,
    message,
    sessionId,
    recordingNotice = false,
    signal,
    onToken = () => {},
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    fetchImpl = (...args) => fetch(...args),
}) {
    const controller = new AbortController();
    let timedOut = false;
    let timer = null;

    // Idle (not total) timeout: re-armed on every received chunk, so a long reply that keeps
    // streaming is fine but a stalled connection is cut. `timedOut` lets `translate` tell this
    // abort apart from a caller abort, since both surface as the same AbortError.
    const armTimer = () => {
        if (!idleTimeoutMs) {
            return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, idleTimeoutMs);
    };

    const onCallerAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) {
            throw new ChatError("aborted", "Request cancelled");
        }
        signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const translate = (error) => {
        if (error instanceof ChatError) {
            return error;
        }
        if (timedOut) {
            return new ChatError("timeout", "The assistant took too long to respond");
        }
        if (controller.signal.aborted) {
            return new ChatError("aborted", "Request cancelled");
        }
        return new ChatError("network_error", "Could not reach the support service");
    };

    try {
        armTimer();
        const response = await fetchImpl(chatUrl(apiUrl), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream, application/json",
            },
            body: JSON.stringify({
                tenant_id: tenantId,
                message,
                session_id: sessionId,
                ...(recordingNotice === true ? { recording_notice: true } : {}),
            }),
            signal: controller.signal,
        });

        if (!response.ok) {
            throw await readHttpError(response);
        }

        const contentType = response.headers.get("content-type") || "";

        // Non-streaming fallback: one JSON body.
        if (!contentType.includes("text/event-stream") || !response.body) {
            const body = await response.json();
            const answer = String(body.answer ?? "");
            if (answer) {
                onToken(answer);
            }
            const followUp = normalizeFollowUp(body.follow_up);
            return { answer, sessionId: body.session_id ?? sessionId, ...(followUp ? { followUp } : {}) };
        }

        let answer = "";
        let finished = false;
        let followUp;
        let streamError = null;

        // Unknown events (e.g. a legacy `sources` event) are ignored on purpose so older or newer
        // gateways stay compatible. `done` is mandatory: a stream that just closes is an error.
        const parser = createSseParser(({ event, data }) => {
            let payload = {};
            try {
                payload = data ? JSON.parse(data) : {};
            } catch {
                return; // ignore malformed events rather than failing the whole reply
            }
            if (event === "token") {
                const text = String(payload.text ?? "");
                answer += text;
                onToken(text);
            } else if (event === "error") {
                streamError = new ChatError(
                    payload.code || "stream_error",
                    payload.message || "The assistant ran into a problem"
                );
            } else if (event === "done") {
                finished = true;
                followUp = normalizeFollowUp(payload.follow_up);
            }
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            armTimer();
            parser.push(decoder.decode(value, { stream: true }));
            if (streamError) {
                await reader.cancel().catch(() => {});
                throw streamError;
            }
            if (finished) {
                await reader.cancel().catch(() => {});
                break;
            }
        }
        parser.push(decoder.decode());
        parser.flush();

        if (streamError) {
            throw streamError;
        }
        if (!finished) {
            throw new ChatError("stream_interrupted", "The response ended unexpectedly");
        }
        return { answer, sessionId, ...(followUp ? { followUp } : {}) };
    } catch (error) {
        throw translate(error);
    } finally {
        clearTimeout(timer);
        if (signal) {
            signal.removeEventListener("abort", onCallerAbort);
        }
    }
}

/**
 * Asks the gateway whether this business records conversations (`GET {apiUrl}/api/chat?tenant_id=`).
 * Resolves true only on an explicit `record_conversations: true`; any failure resolves false, so a
 * lookup problem never shows a notice that is not backed by the gateway (and, because the notice
 * flag is then not sent, nothing is recorded).
 *
 * @param {object} options
 * @param {string} options.apiUrl Gateway base URL.
 * @param {string} options.tenantId Tenant the widget is configured for.
 * @param {AbortSignal} [options.signal] Cancels the request.
 * @param {typeof fetch} [options.fetchImpl] Replacement for `fetch`.
 * @returns {Promise<boolean>}
 */
export async function fetchRecordingNotice({ apiUrl, tenantId, signal, fetchImpl = (...args) => fetch(...args) }) {
    try {
        const response = await fetchImpl(`${chatUrl(apiUrl)}?tenant_id=${encodeURIComponent(tenantId)}`, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal,
        });
        if (!response.ok) return false;
        const body = await response.json();
        return body?.record_conversations === true;
    } catch {
        return false;
    }
}

/**
 * Saves visitor contact details for staff follow-up via `POST {apiUrl}/api/chat/contact`;
 * success means persisted, never an email delivery. Needs the `followUp.token` returned by
 * `streamChat`. Resolves `{ status: "saved" }`; rejects with `ChatError` (`aborted`,
 * `network_error`, `invalid_response`, or the gateway's error code).
 *
 * @param {object} options
 * @param {string} options.apiUrl Gateway base URL.
 * @param {string} options.tenantId Tenant the conversation belongs to.
 * @param {string} options.sessionId Session id used for the conversation.
 * @param {string} options.followUpToken `followUp.token` from the reply.
 * @param {string} options.name Visitor name (trimmed before sending).
 * @param {string} options.email Visitor email (trimmed before sending).
 * @param {AbortSignal} [options.signal] Cancels the request.
 * @param {typeof fetch} [options.fetchImpl] Replacement for `fetch`.
 * @returns {Promise<{status: "saved"}>}
 */
export async function submitContact({ apiUrl, tenantId, sessionId, followUpToken, name, email, signal,
    fetchImpl = (...args) => fetch(...args) }) {
    try {
        if (signal?.aborted) throw new ChatError("aborted", "Request cancelled");
        const response = await fetchImpl(`${chatUrl(apiUrl)}/contact`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ tenant_id: tenantId, session_id: sessionId,
                follow_up_token: followUpToken, name: name.trim(), email: email.trim() }),
            signal,
        });
        if (!response.ok) throw await readHttpError(response);
        const body = await response.json();
        if (body.status !== "saved") throw new ChatError("invalid_response", "Could not confirm save");
        return { status: "saved" };
    } catch (error) {
        if (signal?.aborted) throw new ChatError("aborted", "Request cancelled");
        if (error instanceof ChatError) throw error;
        throw new ChatError("network_error", "Could not save contact details");
    }
}
