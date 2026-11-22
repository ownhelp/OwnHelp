/**
 * Gateway client for manual chunk editing. Same conventions as lib/api.js (credentials included,
 * X-Requested-With header, errors thrown with status and code); kept in its own module so the
 * edit call can be added without touching the shared client. The tenant id goes in the URL only to
 * name the resource: the gateway authorizes it against the session and takes the tenant from there.
 */

const GATEWAY_BASE_URL =
    process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:4000";

/**
 * Saves new text for one chunk. The gateway re-embeds it and answers with the stored chunk, which
 * callers should display instead of what they sent.
 * Returns the chunk object ({ doc_id, chunk_index, section, text, char_count, ... }).
 */
export async function updateTenantChunk(tenantId, docId, chunkIndex, text) {
    if (!tenantId || !docId || !Number.isInteger(chunkIndex)) {
        throw new Error("tenantId, docId and chunkIndex are required");
    }

    const response = await fetch(
        `${GATEWAY_BASE_URL}/api/tenants/${encodeURIComponent(tenantId)}/chunks/${encodeURIComponent(docId)}/${chunkIndex}`,
        {
            method: "PUT",
            headers: {
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/json",
            },
            credentials: "include",
            body: JSON.stringify({ text }),
        }
    );

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(
            body.error || `Failed to save chunk (HTTP ${response.status})`
        );
        error.status = response.status;
        throw error;
    }
    return body.chunk;
}
