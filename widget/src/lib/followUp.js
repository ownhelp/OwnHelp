// Email follow-up helpers. The gateway sends optional `follow_up` metadata after a human
// escalation is saved; everything here treats it as untrusted input and never builds HTML or
// accepts URI schemes from it, because contact links are rendered as <a href>.

/** Parse only number punctuation and an optional trailing extension; never URI input. */
function publicPhone(value) {
    if (typeof value !== "string" || value.length > 50) return undefined;
    const display = value.trim();
    const parts = /^(\+?[0-9 ().-]+?)(?:\s*[xX#]\s*(\d+))?$/.exec(display);
    if (!parts || !/\d/.test(parts[1])) return undefined;
    const number = parts[1].replace(/[^+0-9]/g, "");
    return { display, uri: `tel:${number}${parts[2] ? `;ext=${parts[2]}` : ""}` };
}

/**
 * Validates the wire `follow_up` object. Returns `{available: true, token, contactEmail?,
 * contactPhone?}` or `undefined` when follow-up must not be offered (needs `available === true`
 * and a non-empty token; malformed email/phone are dropped, unknown fields are discarded).
 */
export function normalizeFollowUp(value) {
    if (!value || value.available !== true || typeof value.token !== "string" || !value.token.trim()) return undefined;
    const result = { available: true, token: value.token };
    if (typeof value.contact_email === "string" && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value.contact_email)) {
        result.contactEmail = value.contact_email;
    }
    const phone = publicPhone(value.contact_phone);
    if (phone) result.contactPhone = phone.display;
    return result;
}

/** Builds `mailto:`/`tel:` hrefs from a normalized follow-up; each is undefined when invalid. */
export function contactLinks(followUp) {
    // Revalidate at the point where links are rendered, even for external callers.
    const safe = normalizeFollowUp({ available: true, token: followUp?.token,
        contact_email: followUp?.contactEmail, contact_phone: followUp?.contactPhone });
    return {
        email: safe?.contactEmail ? `mailto:${encodeURIComponent(safe.contactEmail)}` : undefined,
        phone: publicPhone(safe?.contactPhone)?.uri,
    };
}

/**
 * Tracks in-flight requests of one conversation. `begin()` returns an abortable handle whose
 * `isCurrent()` turns false after `reset()`; callers check it before touching state, so a late
 * reply from before "New chat" can never appear in the new conversation, even if the underlying
 * fetch ignores the abort signal.
 */
export function createConversationScope() {
    let epoch = 0;
    const controllers = new Set();
    return {
        begin() {
            const current = epoch;
            const controller = new AbortController();
            controllers.add(controller);
            return { signal: controller.signal, abort: () => controller.abort(),
                isCurrent: () => current === epoch,
                finish: () => controllers.delete(controller) };
        },
        reset() {
            epoch += 1;
            for (const controller of controllers) controller.abort();
            controllers.clear();
        },
    };
}
