/**
 * Session authentication, CSRF origin checks and tenant authorization for the admin API.
 *
 * Security model (why it looks like this):
 * - Sessions are opaque random tokens in an HttpOnly cookie. Only the SHA-256 hash is stored in
 *   `admin_sessions`, so a database leak does not yield usable cookies.
 * - Every request re-reads the session, so logout and revocation take effect immediately.
 * - A session is bound to the APP_MODE it was created in. After a mode switch old cookies are
 *   rejected, which stops a demo_preset session working against a real-business database.
 * - Tenant scope comes only from the server-side session. Any tenant id the client supplies
 *   (path, body, query, X-Tenant-Id) is merely checked against it; conflicting values are refused
 *   rather than trusting one of them.
 *
 * Inputs: Express req/res plus the session and admin_users collections.
 * Outputs: req.auth = { userId, principalType, tenantId, authorizedTenantIds, appMode, user }.
 * Callers: server.js (validateCsrfOrigin, requireAuth, CORS origin set), routes/*.js
 * (authorizeTenantAccess, session helpers).
 */
const crypto = require("crypto");
const {
    getAdminSessionsCollection,
    getAdminUsersCollection,
} = require("../db/mongo");
const { getAppMode } = require("../config/mode");
const {
    isPresetTenantId,
    getPresetTenantById,
    isValidTenantId,
} = require("../config/presets");

const SESSION_COOKIE_NAME = "ownhelp_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const TOKEN_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const COOKIE_NAME_PATTERN = /^[a-zA-Z0-9_-]{3,64}$/;

function getSessionCookieName(env = process.env) {
    const custom = String(env.SESSION_COOKIE_NAME || "").trim();
    if (custom && COOKIE_NAME_PATTERN.test(custom)) {
        return custom;
    }
    return SESSION_COOKIE_NAME;
}

// Origins of the admin dashboard (browser app that uses the session cookie). Not the same list as
// the per-tenant widget origins in chat/origins.js. ALLOWED_ORIGINS extends it for other hosts.
const DEFAULT_ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
];

function getAllowedOrigins(env = process.env) {
    const extra = (env.ALLOWED_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== "string") {
        return cookies;
    }
    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx === -1) continue;
        const key = pair.slice(0, eqIdx).trim();
        const rawVal = pair.slice(eqIdx + 1).trim();
        if (!key) continue;
        try {
            cookies[key] = decodeURIComponent(rawVal);
        } catch {
            cookies[key] = rawVal;
        }
    }
    return cookies;
}

function hashSessionToken(rawToken) {
    return crypto
        .createHash("sha256")
        .update(String(rawToken))
        .digest("hex");
}

function generateRawSessionToken() {
    return crypto.randomBytes(32).toString("hex");
}

// The Secure flag is added in production or when a TLS-terminating proxy says the request was
// https; forcing it on plain-http local development would make the browser drop the cookie.
function isSecureRequest(req) {
    if (process.env.NODE_ENV === "production") return true;
    if (req && req.secure) return true;
    const proto = req?.headers?.["x-forwarded-proto"];
    if (typeof proto === "string" && proto.toLowerCase().includes("https")) {
        return true;
    }
    return false;
}

function setSessionCookie(
    res,
    req,
    rawToken,
    ttlMs = DEFAULT_SESSION_TTL_MS
) {
    const cookieName = getSessionCookieName(process.env);
    const maxAgeSec = Math.max(1, Math.floor(ttlMs / 1000));
    // HttpOnly keeps the token away from page scripts (XSS); SameSite=Lax is the first CSRF
    // layer, validateCsrfOrigin is the second.
    const parts = [
        `${cookieName}=${encodeURIComponent(rawToken)}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAgeSec}`,
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res, req) {
    const cookieName = getSessionCookieName(process.env);
    const parts = [
        `${cookieName}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
        "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ];
    if (isSecureRequest(req)) {
        parts.push("Secure");
    }
    res.setHeader("Set-Cookie", parts.join("; "));
}

function getRawSessionTokenFromRequest(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    const cookieName = getSessionCookieName(process.env);
    return cookies[cookieName] || null;
}

async function createSession({
    userId,
    principalType,
    tenantId,
    appMode,
    ttlMs = DEFAULT_SESSION_TTL_MS,
}) {
    const rawToken = generateRawSessionToken();
    const sessionIdHash = hashSessionToken(rawToken);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const expiresIso = new Date(now + ttlMs).toISOString();

    const sessionDoc = {
        session_id_hash: sessionIdHash,
        user_id: userId,
        principal_type: principalType,
        tenant_id: tenantId,
        authorized_tenant_ids: [tenantId],
        app_mode: appMode,
        created_at: nowIso,
        expires_at: expiresIso,
        revoked_at: null,
    };

    const sessions = await getAdminSessionsCollection();
    await sessions.insertOne(sessionDoc);

    return {
        rawToken,
        session: sessionDoc,
        ttlMs,
    };
}

async function revokeSessionByRawToken(rawToken) {
    if (
        !rawToken ||
        typeof rawToken !== "string" ||
        !TOKEN_HEX_PATTERN.test(rawToken)
    ) {
        return false;
    }
    const sessionIdHash = hashSessionToken(rawToken);
    const sessions = await getAdminSessionsCollection();
    const nowIso = new Date().toISOString();
    const result = await sessions.updateOne(
        { session_id_hash: sessionIdHash, revoked_at: null },
        { $set: { revoked_at: nowIso } }
    );
    return Boolean(result && result.modifiedCount > 0);
}

/**
 * CSRF / Allowed Origin validation for cookie-authenticated state-changing requests.
 *
 * Safe methods pass. For the rest, a cross-site Sec-Fetch-Site or an Origin (else Referer) outside
 * the allowlist is refused with 403. A request with neither header (curl, server-side) passes:
 * without a browser there is no ambient cookie to ride, and the session check still applies.
 */
function validateCsrfOrigin(req, res, next) {
    const method = (req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
        return next();
    }

    const secFetchSite = (req.headers["sec-fetch-site"] || "")
        .trim()
        .toLowerCase();
    if (secFetchSite === "cross-site") {
        return res.status(403).json({
            error: "Cross-site state-changing request blocked by CSRF policy.",
        });
    }

    const allowedOrigins = getAllowedOrigins(process.env);
    const originHeader = (req.headers.origin || "").trim();
    if (originHeader) {
        if (!allowedOrigins.has(originHeader)) {
            return res.status(403).json({
                error: `Origin '${originHeader}' is not permitted.`,
            });
        }
        return next();
    }

    const refererHeader = (req.headers.referer || "").trim();
    if (refererHeader) {
        let refererOrigin = "";
        try {
            refererOrigin = new URL(refererHeader).origin;
        } catch {
            return res.status(403).json({
                error: "Malformed Referer header.",
            });
        }
        if (!allowedOrigins.has(refererOrigin)) {
            return res.status(403).json({
                error: `Referer origin '${refererOrigin}' is not permitted.`,
            });
        }
    }

    return next();
}

/**
 * Authentication middleware verifying server-side session, expiration, revocation,
 * principal type, and server APP_MODE binding.
 *
 * Responds 401 (and clears the cookie) for every bad-session case with a distinct message but no
 * detail about other users; 500 only if the session store itself fails. In standard mode the
 * session must also match a live admin_users row and never a preset tenant, so a deleted or
 * tampered account loses access at once.
 */
async function requireAuth(req, res, next) {
    try {
        const rawToken = getRawSessionTokenFromRequest(req);
        if (
            !rawToken ||
            typeof rawToken !== "string" ||
            !TOKEN_HEX_PATTERN.test(rawToken)
        ) {
            return res.status(401).json({
                error: "Authentication required. Valid session cookie missing.",
            });
        }

        const currentMode = getAppMode(process.env);
        const sessionIdHash = hashSessionToken(rawToken);
        const sessions = await getAdminSessionsCollection();
        const session = await sessions.findOne({
            session_id_hash: sessionIdHash,
        });

        if (!session) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Invalid or unknown session.",
            });
        }

        if (session.revoked_at) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Session has been revoked.",
            });
        }

        const expiresMs = new Date(session.expires_at).getTime();
        if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Session has expired.",
            });
        }

        if (session.app_mode !== currentMode) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Session mode mismatch. Please sign in again.",
            });
        }

        const sessionTenantId = session.tenant_id;
        if (!isValidTenantId(sessionTenantId)) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Invalid session tenant binding.",
            });
        }

        if (currentMode === "standard") {
            if (
                session.principal_type !== "admin" ||
                isPresetTenantId(sessionTenantId)
            ) {
                clearSessionCookie(res, req);
                return res.status(401).json({
                    error: "Session principal is not authorized in standard mode.",
                });
            }

            const adminUsers = await getAdminUsersCollection();
            const userDoc = await adminUsers.findOne(
                { user_id: session.user_id },
                { projection: { _id: 0, password_hash: 0 } }
            );

            if (
                !userDoc ||
                userDoc.principal_type !== "admin" ||
                userDoc.tenant_id !== sessionTenantId ||
                isPresetTenantId(userDoc.tenant_id)
            ) {
                clearSessionCookie(res, req);
                return res.status(401).json({
                    error: "Associated administrator account is invalid.",
                });
            }

            req.auth = {
                sessionIdHash,
                userId: userDoc.user_id,
                principalType: "admin",
                tenantId: sessionTenantId,
                authorizedTenantIds: [sessionTenantId],
                appMode: currentMode,
                user: {
                    user_id: userDoc.user_id,
                    name: userDoc.name,
                    email: userDoc.email,
                    principal_type: "admin",
                    tenant_id: userDoc.tenant_id,
                },
            };
            return next();
        }

        // currentMode === "preset_training"
        if (
            session.principal_type !== "demo_preset" ||
            !isPresetTenantId(sessionTenantId)
        ) {
            clearSessionCookie(res, req);
            return res.status(401).json({
                error: "Session principal is not authorized in preset_training mode.",
            });
        }

        const presetFixture = getPresetTenantById(sessionTenantId);
        req.auth = {
            sessionIdHash,
            userId: session.user_id,
            principalType: "demo_preset",
            tenantId: sessionTenantId,
            authorizedTenantIds: [sessionTenantId],
            appMode: currentMode,
            user: {
                user_id: session.user_id,
                name: presetFixture
                    ? `${presetFixture.name} (Demo Admin)`
                    : `Demo Admin (${sessionTenantId})`,
                email: null,
                principal_type: "demo_preset",
                tenant_id: sessionTenantId,
            },
        };
        return next();
    } catch (error) {
        console.error("[Auth Middleware] Error:", error.message);
        return res.status(500).json({
            error: "Authentication check failed.",
        });
    }
}

/**
 * Validates all caller-supplied tenant selectors (params, body, query, headers)
 * against the server-verified session's authorized tenant and active APP_MODE.
 * Returns the authorized tenant_id string if valid, or sends an HTTP 401/403 response and returns null.
 *
 * Why every selector is collected and compared: a handler that read only one of them could be
 * tricked by a second, different value elsewhere in the request (an IDOR / confused-deputy bug).
 * Callers must stop when this returns null and must use the returned id, never the raw input.
 */
function authorizeTenantAccess(req, res, explicitTenantId = null) {
    if (!req.auth || !req.auth.tenantId) {
        res.status(401).json({
            error: "Authentication required.",
        });
        return null;
    }

    const currentMode = getAppMode(process.env);
    const authorizedSet = new Set(req.auth.authorizedTenantIds || []);

    const rawSelectors = [];
    if (explicitTenantId !== null && explicitTenantId !== undefined && String(explicitTenantId).trim() !== "") {
        rawSelectors.push({ source: "path", value: String(explicitTenantId).trim() });
    }
    if (
        req.params?.tenantId !== undefined &&
        String(req.params.tenantId).trim() !== ""
    ) {
        rawSelectors.push({
            source: "params.tenantId",
            value: String(req.params.tenantId).trim(),
        });
    }
    if (
        req.body &&
        typeof req.body === "object" &&
        req.body.tenant_id !== undefined &&
        String(req.body.tenant_id).trim() !== ""
    ) {
        rawSelectors.push({
            source: "body.tenant_id",
            value: String(req.body.tenant_id).trim(),
        });
    }
    if (
        req.query &&
        req.query.tenant_id !== undefined &&
        String(req.query.tenant_id).trim() !== ""
    ) {
        rawSelectors.push({
            source: "query.tenant_id",
            value: String(req.query.tenant_id).trim(),
        });
    }
    if (
        req.headers &&
        req.headers["x-tenant-id"] !== undefined &&
        String(req.headers["x-tenant-id"]).trim() !== ""
    ) {
        rawSelectors.push({
            source: "header.x-tenant-id",
            value: String(req.headers["x-tenant-id"]).trim(),
        });
    }

    for (const sel of rawSelectors) {
        if (!isValidTenantId(sel.value)) {
            res.status(403).json({
                error: `Invalid or forbidden tenant identifier in ${sel.source}.`,
            });
            return null;
        }
    }

    const uniqueSelectors = Array.from(new Set(rawSelectors.map((s) => s.value)));
    if (uniqueSelectors.length > 1) {
        res.status(403).json({
            error: "Conflicting tenant_id selectors supplied across request path, body, or query.",
        });
        return null;
    }

    const targetTenantId =
        uniqueSelectors.length === 1 ? uniqueSelectors[0] : req.auth.tenantId;

    if (currentMode === "standard" && isPresetTenantId(targetTenantId)) {
        res.status(403).json({
            error: "Preset training tenants are forbidden in standard mode.",
        });
        return null;
    }

    if (currentMode === "preset_training" && !isPresetTenantId(targetTenantId)) {
        res.status(403).json({
            error: "Standard tenants are forbidden in preset_training mode.",
        });
        return null;
    }

    if (!authorizedSet.has(targetTenantId)) {
        res.status(403).json({
            error: `Forbidden: Session is not authorized for tenant '${targetTenantId}'.`,
        });
        return null;
    }

    return targetTenantId;
}

module.exports = {
    SESSION_COOKIE_NAME,
    DEFAULT_SESSION_TTL_MS,
    getSessionCookieName,
    getAllowedOrigins,
    parseCookies,
    hashSessionToken,
    generateRawSessionToken,
    setSessionCookie,
    clearSessionCookie,
    getRawSessionTokenFromRequest,
    createSession,
    revokeSessionByRawToken,
    validateCsrfOrigin,
    requireAuth,
    authorizeTenantAccess,
};

