// Protects: PUT /api/tenants/:tenantId/chunks/:docId/:chunkIndex (manual chunk edit): auth, CSRF, tenant isolation, input validation, runner failure leaving the chunk unchanged.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownhelp-chunk-edit-"));
process.env.UPLOAD_STAGING_DIR = stagingDir;
process.on("exit", () => fs.rmSync(stagingDir, { recursive: true, force: true }));

const { createApp } = require("../src/server");
const {
    connectToDatabase,
    setDatabaseAdapter,
    resetDatabaseAdapter,
} = require("../src/db/mongo");
const { resetLoginRateLimiter } = require("../src/routes/auth");
const {
    setChunkEditRunner,
    resetChunkEditRunner,
} = require("../src/routes/documents");

function matches(doc, query) {
    return Object.entries(query).every(([k, v]) =>
        typeof v === "object" && v !== null && "$exists" in v
            ? (doc[k] !== undefined) === Boolean(v.$exists)
            : doc[k] === v
    );
}

// In-memory database: signup/session support plus doc_vectors findOne for the route.
function buildMockDb(dbDocs) {
    return {
        databaseName: "chunk_edit_test_db",
        collection: (name) => ({
            createIndex: async () => "ok",
            countDocuments: async () => (dbDocs[name] || []).length,
            findOne: async (query = {}, options = {}) => {
                const doc = (dbDocs[name] || []).find((d) => matches(d, query));
                if (!doc) return null;
                const copy = { ...doc };
                const projection = options.projection || {};
                for (const [key, flag] of Object.entries(projection)) {
                    if (flag === 0) delete copy[key];
                }
                return copy;
            },
            find: () => {
                const cursor = {
                    sort: () => cursor,
                    skip: () => cursor,
                    limit: () => cursor,
                    toArray: async () => [],
                };
                return cursor;
            },
            insertOne: async (doc) => {
                const copy = { ...doc, _id: `id_${Math.random()}` };
                dbDocs[name].push(copy);
                return { insertedId: copy._id };
            },
            updateOne: async (filter, update) => {
                const doc = (dbDocs[name] || []).find((d) => matches(d, filter));
                if (!doc) return { modifiedCount: 0 };
                if (update.$set) Object.assign(doc, update.$set);
                return { modifiedCount: 1 };
            },
            updateMany: async () => ({ modifiedCount: 0 }),
            deleteOne: async () => ({ deletedCount: 0 }),
        }),
    };
}

describe("Manual chunk editing route", () => {
    let server;
    let baseUrl;
    let cookie;
    let tenantId;
    let dbDocs;
    const savedEnv = { ...process.env };

    function put(pathSuffix, body, headers = {}, { withCookie = true } = {}) {
        return fetch(`${baseUrl}/api/tenants/${pathSuffix}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                ...(withCookie ? { Cookie: cookie } : {}),
                ...headers,
            },
            body: JSON.stringify(body),
        });
    }

    // A runner that behaves like the worker: stores text and embedding together.
    function installWorkingRunner(calls) {
        setChunkEditRunner(async (params) => {
            calls.push(params);
            const row = dbDocs.doc_vectors.find(
                (d) =>
                    d.tenant_id === params.tenantId &&
                    d.doc_id === params.docId &&
                    d.chunk_index === params.chunkIndex
            );
            Object.assign(row, { text: params.text, embedding: [0.9, 0.9] });
            return { status: "success" };
        });
    }

    beforeEach(async () => {
        process.env.APP_MODE = "standard";
        process.env.MONGODB_DB_NAME = "chunk_edit_test_db";
        process.env.MONGODB_TRAINING_DB_NAME = "chunk_edit_training_db";
        resetLoginRateLimiter();
        dbDocs = {
            businesses: [],
            admin_users: [],
            admin_sessions: [],
            doc_vectors: [],
            ticket_logs: [],
        };
        setDatabaseAdapter(buildMockDb(dbDocs));
        await connectToDatabase(process.env);
        const app = createApp();
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", () => {
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
        const signup = await fetch(`${baseUrl}/api/auth/signup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                admin_name: "Edie Edit",
                email: "edie@edit.example",
                password: "EditPassword1!",
                business_name: "Edit Gear",
                industry: "Outdoor",
                contact_email: "support@edit.example",
            }),
        });
        assert.equal(signup.status, 201);
        cookie = (signup.headers.get("set-cookie") || "").split(";")[0];
        const session = await fetch(`${baseUrl}/api/auth/session`, {
            headers: { Cookie: cookie },
        });
        tenantId = (await session.json()).tenant.tenant_id;
        assert.ok(tenantId);
        dbDocs.doc_vectors.push(
            {
                tenant_id: tenantId,
                doc_id: "RETURNS",
                chunk_index: 0,
                section: "Window",
                text: "old text",
                embedding: [0.1, 0.1],
                created_at: "2026-01-01T00:00:00Z",
            },
            {
                tenant_id: "someone_else",
                doc_id: "RETURNS",
                chunk_index: 0,
                section: "Window",
                text: "other tenant text",
                embedding: [0.2, 0.2],
                created_at: "2026-01-01T00:00:00Z",
            }
        );
    });

    afterEach(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
            server = null;
        }
        resetDatabaseAdapter();
        resetChunkEditRunner();
        resetLoginRateLimiter();
        process.env = { ...savedEnv };
    });

    test("edits the session tenant's chunk and returns the stored chunk", async () => {
        const calls = [];
        installWorkingRunner(calls);
        const res = await put(`${tenantId}/chunks/RETURNS/0`, {
            text: "  new text here  ",
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.chunk.text, "new text here");
        assert.equal(body.chunk.doc_id, "RETURNS");
        assert.equal(body.chunk.chunk_index, 0);
        assert.equal(body.chunk.embedding, undefined);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].tenantId, tenantId);
        assert.equal(calls[0].chunkIndex, 0);
        assert.equal(calls[0].text, "new text here");
        assert.equal(dbDocs.doc_vectors[1].text, "other tenant text");
    });

    test("tenant comes from the session: a mismatched body tenant_id or foreign URL tenant is refused", async () => {
        const calls = [];
        installWorkingRunner(calls);
        const spoof = await put(`${tenantId}/chunks/RETURNS/0`, {
            text: "x",
            tenant_id: "someone_else",
        });
        assert.equal(spoof.status, 403);
        assert.equal(calls.length, 0);
        assert.equal(dbDocs.doc_vectors[1].text, "other tenant text");

        const foreign = await put("someone_else/chunks/RETURNS/0", { text: "hijack" });
        assert.ok([403, 404].includes(foreign.status));
        assert.equal(calls.length, 0);
        assert.equal(dbDocs.doc_vectors[1].text, "other tenant text");
    });

    test("requires a session", async () => {
        const calls = [];
        installWorkingRunner(calls);
        const res = await put(
            `${tenantId}/chunks/RETURNS/0`,
            { text: "x" },
            {},
            { withCookie: false }
        );
        assert.equal(res.status, 401);
        assert.equal(calls.length, 0);
    });

    test("CSRF: a cross-site or disallowed-origin request carrying the cookie is blocked", async () => {
        const calls = [];
        installWorkingRunner(calls);
        const crossOrigin = await put(
            `${tenantId}/chunks/RETURNS/0`,
            { text: "x" },
            { Origin: "https://evil.example" }
        );
        assert.equal(crossOrigin.status, 403);
        const crossSite = await put(
            `${tenantId}/chunks/RETURNS/0`,
            { text: "x" },
            { "Sec-Fetch-Site": "cross-site" }
        );
        assert.equal(crossSite.status, 403);
        assert.equal(calls.length, 0);
        assert.equal(dbDocs.doc_vectors[0].text, "old text");
    });

    test("rejects invalid text, doc_id and chunk index without running the embedder", async () => {
        const calls = [];
        installWorkingRunner(calls);
        for (const body of [
            {},
            { text: 5 },
            { text: "   " },
            { text: "x".repeat(8001) },
        ]) {
            const res = await put(`${tenantId}/chunks/RETURNS/0`, body);
            assert.equal(res.status, 400);
        }
        assert.equal((await put(`${tenantId}/chunks/RETURNS/abc`, { text: "x" })).status, 400);
        assert.equal((await put(`${tenantId}/chunks/RETURNS/-1`, { text: "x" })).status, 400);
        assert.equal((await put(`${tenantId}/chunks/bad$id/0`, { text: "x" })).status, 400);
        assert.equal(calls.length, 0);
    });

    test("unknown chunk is 404 without running the embedder", async () => {
        const calls = [];
        installWorkingRunner(calls);
        const res = await put(`${tenantId}/chunks/RETURNS/7`, { text: "x" });
        assert.equal(res.status, 404);
        assert.equal(calls.length, 0);
    });

    test("embedding failure returns 500 with no detail and the chunk stays unchanged", async () => {
        setChunkEditRunner(async () => {
            const err = new Error("secret connection string /srv/x");
            err.code = "EDIT_ERROR";
            throw err;
        });
        const res = await put(`${tenantId}/chunks/RETURNS/0`, { text: "new" });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.ok(!JSON.stringify(body).includes("secret"));
        assert.equal(dbDocs.doc_vectors[0].text, "old text");
        assert.deepEqual(dbDocs.doc_vectors[0].embedding, [0.1, 0.1]);
    });

    test("worker validation error (token limit) is a 400 carrying its message", async () => {
        setChunkEditRunner(async () => {
            const err = new Error("Chunk is about 600 tokens; limit 512.");
            err.code = "VALIDATION_ERROR";
            throw err;
        });
        const res = await put(`${tenantId}/chunks/RETURNS/0`, { text: "new" });
        assert.equal(res.status, 400);
        assert.match((await res.json()).error, /tokens/);
        assert.equal(dbDocs.doc_vectors[0].text, "old text");
    });
});
