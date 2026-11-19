// Visitor session ids, one per tenant. The id is not a credential: it only lets the gateway
// group a visitor's messages into one conversation. It is kept in localStorage so a reload
// continues the conversation, and mirrored in memory so blocked storage (private windows,
// disabled cookies) still gives a stable id for the page's lifetime.
const memoryStore = new Map();

function generateId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function defaultStorage() {
    // Merely reading `localStorage` can throw (e.g. sandboxed iframes), hence the try/catch.
    try {
        return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
        return null;
    }
}

/**
 * Returns a stable per-tenant visitor session id. Uses localStorage when it is
 * available and falls back to in-memory storage (private windows, blocked storage).
 *
 * @param {string} tenantId Tenant the session belongs to.
 * @param {Pick<Storage, "getItem"|"setItem">|null} [storage] Storage to use (default: localStorage).
 * @returns {string} The session id (a UUID where `crypto.randomUUID` exists).
 */
export function getSessionId(tenantId, storage = defaultStorage()) {
    const key = `support_widget_session:${tenantId}`;
    if (memoryStore.has(key)) return memoryStore.get(key);
    try {
        const existing = storage ? storage.getItem(key) : null;
        if (existing) {
            memoryStore.set(key, existing);
            return existing;
        }
    } catch {
        // fall through to memory
    }
    if (memoryStore.has(key)) {
        return memoryStore.get(key);
    }
    const id = generateId();
    memoryStore.set(key, id);
    try {
        if (storage) {
            storage.setItem(key, id);
        }
    } catch {
        // memory copy is enough
    }
    return id;
}

/** Test helper: clears the in-memory fallback. */
export function resetSessionMemory() {
    memoryStore.clear();
}

/**
 * Starts and persists a fresh conversation id for the tenant ("New chat"); existing server
 * history is untouched.
 *
 * @param {string} tenantId Tenant the session belongs to.
 * @param {Pick<Storage, "getItem"|"setItem">|null} [storage] Storage to use (default: localStorage).
 * @returns {string} The new session id.
 */
export function newSessionId(tenantId, storage = defaultStorage()) {
    const key = `support_widget_session:${tenantId}`;
    const id = generateId();
    memoryStore.set(key, id);
    try { storage?.setItem(key, id); } catch { /* private-window fallback */ }
    return id;
}
