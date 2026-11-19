// Protects: the NDJSON streaming mode of POST /api/documents/upload (real stage events, done/error events, 4xx before streaming) and the unchanged JSON mode.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Stage uploads in a private directory. This must be set before ../src/routes/documents is
// loaded (it reads the variable once). Test files run in parallel, and
// auth_and_authorization.test.js counts the files in the default /tmp/uploads before and after a
// rejected upload, so sharing that directory made it fail intermittently.
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownhelp-stream-test-"));
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
    setIngestionRunner,
    resetIngestionRunner,
} = require("../src/routes/documents");

// Minimal in-memory database: just enough for signup and session lookups.
function buildMockDb(dbDocs) {
    return {
        databaseName: "stream_test_db",
        collection: (name) => ({
            createIndex: async () => "ok",
            countDocuments: async () => (dbDocs[name] || []).length,
            findOne: async (query = {}) =>
                (dbDocs[name] || []).find((doc) =>
                    Object.entries(query).every(([k, v]) => doc[k] === v)
                ) || null,
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
            updateOne: async (filter, update, options = {}) => {
                const list = dbDocs[name];
                const idx = list.findIndex((d) =>
                    Object.entries(filter).every(([k, v]) =>
                        typeof v === "object" && v !== null && "$exists" in v
                            ? (d[k] !== undefined) === Boolean(v.$exists)
                            : d[k] === v
                    )
                );
                if (idx === -1) {
                    if (options.upsert) {
                        list.push({
                            ...(update.$setOnInsert || {}),
                            ...(update.$set || {}),
                        });
                        return { modifiedCount: 0, upsertedCount: 1 };
                    }
                    return { modifiedCount: 0 };
                }
                if (update.$set) Object.assign(list[idx], update.$set);
                return { modifiedCount: 1 };
            },
            updateMany: async () => ({ modifiedCount: 0 }),
            deleteOne: async () => ({ deletedCount: 0 }),
        }),
    };
}

function parseNdjson(text) {
    return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
}

describe("Document upload NDJSON streaming", () => {
    let server;
    let baseUrl;
    let cookie;
    const savedEnv = { ...process.env };

    function uploadForm(name = "WARRANTY.md") {
        const form = new FormData();
        form.append(
            "file",
            new Blob(["# Warranty\nLifetime guarantee."], {
                type: "text/markdown",
            }),
            name
        );
        return form;
    }

    beforeEach(async () => {
        process.env.APP_MODE = "standard";
        process.env.MONGODB_DB_NAME = "stream_test_db";
        process.env.MONGODB_TRAINING_DB_NAME = "stream_training_db";
        resetLoginRateLimiter();
        setDatabaseAdapter(
            buildMockDb({
                businesses: [],
                admin_users: [],
                admin_sessions: [],
                doc_vectors: [],
                ticket_logs: [],
            })
        );
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
                admin_name: "Sam Stream",
                email: "sam@stream.example",
                password: "StreamPassword1!",
                business_name: "Stream Gear",
                industry: "Outdoor",
                contact_email: "support@stream.example",
            }),
        });
        assert.equal(signup.status, 201);
        // Take whatever the session cookie is called so the test does not pin its name.
        cookie = (signup.headers.get("set-cookie") || "").split(";")[0];
        assert.ok(cookie.includes("="));
    });

    afterEach(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
            server = null;
        }
        resetDatabaseAdapter();
        resetIngestionRunner();
        resetLoginRateLimiter();
        process.env = { ...savedEnv };
    });

    test("streams real stages then a done event carrying the summary", async () => {
        setIngestionRunner(async (params) => {
            params.onStage("parsing");
            params.onStage("embedding");
            params.onStage("bogus_stage");
            params.onStage("writing");
            return {
                status: "success",
                tenant_id: params.tenantId,
                doc_id: params.docId,
                chunks_created: 2,
            };
        });
        const res = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: {
                Cookie: cookie,
                Accept: "application/x-ndjson",
            },
            body: uploadForm(),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /application\/x-ndjson/);
        const events = parseNdjson(await res.text());
        assert.deepEqual(
            events.slice(0, 4).map((e) => e.stage),
            ["uploading", "parsing", "embedding", "writing"]
        );
        const last = events[events.length - 1];
        assert.equal(last.event, "done");
        assert.equal(last.status, "success");
        assert.equal(last.doc_id, "WARRANTY");
        assert.equal(last.chunks_created, 2);
        assert.equal(events.length, 5);
    });

    test("runner failure becomes an error event without stack, path or raw stderr", async () => {
        setIngestionRunner(async (params) => {
            const err = new Error(
                `Failed at ${params.filePath}\n    at secretFunction (/srv/app/x.js:1:1)`
            );
            err.code = "VALIDATION_ERROR";
            throw err;
        });
        const res = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: { Cookie: cookie, Accept: "application/x-ndjson" },
            body: uploadForm(),
        });
        assert.equal(res.status, 200);
        const events = parseNdjson(await res.text());
        const last = events[events.length - 1];
        assert.equal(last.event, "error");
        assert.equal(last.error, "VALIDATION_ERROR");
        assert.ok(!/secretFunction|\/srv\/|\.js:|uploads/.test(last.message));

        setIngestionRunner(async () => {
            throw new Error("raw stderr with /home/user/.env contents");
        });
        const res2 = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: { Cookie: cookie, Accept: "application/x-ndjson" },
            body: uploadForm(),
        });
        const events2 = parseNdjson(await res2.text());
        const last2 = events2[events2.length - 1];
        assert.equal(last2.event, "error");
        assert.equal(last2.message, "Failed to ingest uploaded document.");
    });

    test("validation errors before streaming still return normal 4xx JSON", async () => {
        let called = false;
        setIngestionRunner(async () => {
            called = true;
            return { status: "success" };
        });
        const noFile = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: { Cookie: cookie, Accept: "application/x-ndjson" },
            body: new FormData(),
        });
        assert.equal(noFile.status, 400);
        assert.match(noFile.headers.get("content-type"), /application\/json/);

        const unauth = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: { Accept: "application/x-ndjson" },
            body: uploadForm(),
        });
        assert.equal(unauth.status, 401);
        assert.equal(called, false);
    });

    test("without the NDJSON Accept header the response is the unchanged JSON summary", async () => {
        setIngestionRunner(async (params) => {
            // JSON mode passes no onStage, so a runner must tolerate its absence.
            assert.equal(params.onStage, undefined);
            return { status: "success", doc_id: params.docId, chunks_created: 1 };
        });
        const res = await fetch(`${baseUrl}/api/documents/upload`, {
            method: "POST",
            headers: { Cookie: cookie },
            body: uploadForm(),
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type"), /application\/json/);
        assert.deepEqual(await res.json(), {
            status: "success",
            doc_id: "WARRANTY",
            chunks_created: 1,
        });
    });
});
