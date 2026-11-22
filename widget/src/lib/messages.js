/**
 * What a visitor reads when something goes wrong.
 *
 * The gateway's error codes are stable; its message text is for developers and is never shown as is.
 * Every message here is specific enough to act on and says nothing about servers, databases or
 * models. `retryable` decides whether the widget offers a Retry button: resending the same text
 * only helps when the problem can go away by itself.
 */

const SERVICE_UNAVAILABLE = "The support assistant is temporarily unavailable. Please try again shortly.";
const GENERIC = "Something went wrong. Please try again.";

const BY_CODE = {
    network_error: {
        message: "We couldn't reach the support service. Please check your connection and try again.",
        retryable: true,
    },
    timeout: { message: "The assistant took too long to respond. Please try again.", retryable: true },
    stream_interrupted: {
        message: "The connection was interrupted before the reply finished. Please try again.",
        retryable: true,
    },
    generation_failed: { message: "The assistant ran into a problem. Please try again.", retryable: true },
    stream_error: { message: "The assistant ran into a problem. Please try again.", retryable: true },
    service_unavailable: { message: SERVICE_UNAVAILABLE, retryable: true },
    message_too_long: {
        message: "That message is too long. Please shorten it (2000 characters at most) and send it again.",
        retryable: false,
    },
    invalid_request: { message: "That message couldn't be sent. Please edit it and try again.", retryable: false },
    unknown_tenant: { message: "The support chat isn't available on this site.", retryable: false },
    origin_not_allowed: { message: "The support chat isn't available on this site.", retryable: false },
};

function waitText(error) {
    const seconds = Number(error && error.retryAfterSec);
    if (!Number.isFinite(seconds) || seconds <= 0) {
        return "a moment";
    }
    return seconds > 90 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.ceil(seconds)} seconds`;
}

// Maps a ChatError to { message, retryable }. Unknown codes fall back on the HTTP status
// (5xx retryable, 4xx not), and `rate_limited` builds its wait time from `Retry-After`.
function describe(error) {
    const code = error && error.code;
    if (code === "rate_limited") {
        return {
            message: `You're sending messages too quickly. Please wait ${waitText(error)} and try again.`,
            retryable: true,
        };
    }
    if (code && BY_CODE[code]) {
        return BY_CODE[code];
    }
    const status = Number(error && error.status);
    if (status >= 500) {
        return { message: SERVICE_UNAVAILABLE, retryable: true };
    }
    if (status >= 400) {
        return { message: GENERIC, retryable: false };
    }
    return { message: GENERIC, retryable: true };
}

const CONTACT_FALLBACK = "Your details could not be saved. Please try again or contact the business directly.";
const CONTACT_DIRECT = "contact the business directly";

const CONTACT_BY_CODE = {
    invalid_request: "Please check your name and email address and try again.",
    origin_not_allowed: `Email follow-up isn't available on this site. Please ${CONTACT_DIRECT}.`,
    unknown_tenant: `Email follow-up isn't available on this site. Please ${CONTACT_DIRECT}.`,
    invalid_follow_up: `This follow-up form has expired. Please send your message again to get a new one, or ${CONTACT_DIRECT}.`,
    contact_already_submitted: `Different contact details were already saved for this conversation. Please ${CONTACT_DIRECT} to change them.`,
    service_unavailable: "We couldn't save your details right now. Please try again shortly or contact the business directly.",
    network_error: "We couldn't reach the support service. Please check your connection and try again.",
    timeout: "Saving your details took too long. Please try again.",
};

/**
 * Safe, visitor-facing text for a failed contact-form save (POST /api/chat/contact). Never echoes
 * server text. `aborted` is treated as a timeout because the widget only aborts a save on its
 * own 30 second limit (a visitor-initiated reset ignores the result before it is shown).
 */
export function contactMessage(error) {
    const code = error && error.code === "aborted" ? "timeout" : error && error.code;
    if (code === "rate_limited") {
        return `Too many attempts. Please wait ${waitText(error)} and try again.`;
    }
    if (code && Object.hasOwn(CONTACT_BY_CODE, code)) {
        return CONTACT_BY_CODE[code];
    }
    const status = Number(error && error.status);
    if (status >= 500) {
        return CONTACT_BY_CODE.service_unavailable;
    }
    return CONTACT_FALLBACK;
}

/** Safe, visitor-facing text for any failure. */
export function visitorMessage(error) {
    return describe(error).message;
}

/** Whether resending the same message can succeed. */
export function isRetryable(error) {
    return describe(error).retryable;
}
