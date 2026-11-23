// Protects the opt-in research log: nothing is stored unless the tenant opted in AND the widget showed the
// notice; stored turns carry the useful analysis fields but no raw session id or visitor contact details.
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../src/server");
const { setDatabaseAdapter, resetDatabaseAdapter } = require("../src/db/mongo");
const { setChatBackend } = require("../src/chat/backend");
const { resetChatState } = require("../src/routes/chat");
const {
    redactContactDetails,
    shouldRecordConversation,
    buildConversationLogEntry,
} = require("../src/chat/conversationLog");

const SESSION = "session-0123456789abcdef";

describe("conversation log helpers", () => {
    test("redacts e-mail addresses and phone-like numbers but keeps dates and short numbers", () => {
        assert.equal(
            redactContactDetails("Mail me at jane.doe+x@example.co.uk or call +1 (202) 555-0123 about order 4417 on 2026-11-22"),
            "Mail me at [email] or call [phone] about order 4417 on 2026-11-22"
        );
    });

    test("records only when the tenant opted in and the widget confirmed the notice", () => {
        const on = { record_conversations: true };
        assert.equal(shouldRecordConversation(on, { recording_notice: true }), true);
        assert.equal(shouldRecordConversation(on, {}), false);
        assert.equal(shouldRecordConversation(on, { recording_notice: "yes" }), false);
        assert.equal(shouldRecordConversation({}, { recording_notice: true }), false);
        assert.equal(shouldRecordConversation({ record_conversations: "true" }, { recording_notice: true }), false);
        assert.equal(shouldRecordConversation(null, { recording_notice: true }), false);
    });

    test("entry keeps analysis fields and never the raw session id", () => {
        const entry = buildConversationLogEntry({
            tenantId: "tenant_a",
            sessionId: SESSION,
            message: "Email me at a@b.com",
            answer: "Sure.",
            done: { type: "done", action: "escalate", confidence: 0.4, cited_sources: ["RETURNS"] },
            sources: [{ doc_id: "RETURNS", section: "Window", score: 0.8 }],
            agentConfig: { temperature: 0.2, max_context_chunks: 4, similarity_threshold: 0.7, core_policy: "" },
            latencyMs: 812.4,
            model: "test-model",
            now: new Date("2026-11-23T05:29:10.000Z"),
        });
        assert.equal(entry.question, "Email me at [email]");
        assert.equal(entry.action, "escalate");
        assert.equal(entry.confidence, 0.4);
        assert.deepEqual(entry.cited_sources, ["RETURNS"]);
        assert.equal(entry.latency_ms, 812);
        assert.equal(entry.created_at, "2026-11-23T05:29:10.000Z");
        assert.equal(entry.settings.custom_core_policy, false);
        assert.match(entry.conversation_id, /^CONV-[0-9A-F]{16}$/);
        assert.ok(!JSON.stringify(entry).includes(SESSION));
    });
});

describe("recording through /api/chat", () => {
    let server;
    let baseUrl;
    let logs;
    let tenants;
    const savedEnv = { ...process.env };

    beforeEach(async () => {
        process.env.APP_MODE = "standard";
        process.env.MONGODB_DB_NAME = "conversation_log_db";
        delete process.env.MONGODB_TRAINING_DB_NAME;
        process.env.CHAT_RATE_LIMIT_PER_IP = "1000";
        process.env.CHAT_RATE_LIMIT_PER_SESSION = "1000";
        resetChatState();
        logs = [];
        tenants = [
            { tenant_id: "recording_on", record_conversations: true, widget_config: { allowed_origins: ["https://site.example.com"] } },
            { tenant_id: "recording_off", widget_config: { allowed_origins: ["https://site.example.com"] } },
        ];
        setDatabaseAdapter({
            collection: (name) => ({
                findOne: async (query) => {
                    const found = name === "businesses" ? tenants.find((t) => t.tenant_id === query.tenant_id) : null;
                    return found ? structuredClone(found) : null;
                },
                insertOne: async (doc) => {
                    if (name === "conversation_logs") logs.push(structuredClone(doc));
                    return { acknowledged: true };
                },
                updateOne: async () => ({ acknowledged: true }),
            }),
        });
        setChatBackend({
            chat: () =>
                (async function* () {
                    yield { type: "sources", sources: [{ doc_id: "DOC", section: "S", score: 0.9, text: "SECRET" }] };
                    yield { type: "token", text: "Hello" };
                    yield { type: "done", action: "answer", confidence: 0.9, cited_sources: ["DOC"] };
                })(),
        });
        server = createApp().listen(0);
        await new Promise((resolve) => server.once("listening", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        setChatBackend(null);
        resetDatabaseAdapter();
        for (const key of Object.keys(process.env)) {
            if (!(key in savedEnv)) delete process.env[key];
        }
        Object.assign(process.env, savedEnv);
    });

    const chat = (body) =>
        fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream", Origin: "https://site.example.com" },
            body: JSON.stringify({ message: "What is the policy?", session_id: SESSION, ...body }),
        }).then((response) => response.text());

    test("opted-in tenant + notice shown: the turn is stored without retrieved text", async () => {
        await chat({ tenant_id: "recording_on", recording_notice: true });
        assert.equal(logs.length, 1);
        assert.equal(logs[0].tenant_id, "recording_on");
        assert.equal(logs[0].question, "What is the policy?");
        assert.equal(logs[0].answer, "Hello");
        assert.deepEqual(logs[0].retrieved, [{ doc_id: "DOC", section: "S", score: 0.9 }]);
        assert.ok(!JSON.stringify(logs[0]).includes("SECRET"));
        assert.ok(!JSON.stringify(logs[0]).includes(SESSION));
    });

    test("nothing is stored without the widget's notice confirmation or when the tenant has not opted in", async () => {
        await chat({ tenant_id: "recording_on" });
        await chat({ tenant_id: "recording_on", recording_notice: false });
        await chat({ tenant_id: "recording_off", recording_notice: true });
        assert.equal(logs.length, 0);
    });

    test("GET /api/chat tells the widget whether to show the notice", async () => {
        const get = (tenantId, origin = "https://site.example.com") =>
            fetch(`${baseUrl}/api/chat?tenant_id=${tenantId}`, { headers: { Origin: origin } });
        assert.deepEqual(await (await get("recording_on")).json(), { record_conversations: true });
        assert.deepEqual(await (await get("recording_off")).json(), { record_conversations: false });
        assert.equal((await get("missing_tenant")).status, 404);
        assert.equal((await get("recording_on", "https://evil.example.com")).status, 403);
        assert.equal((await fetch(`${baseUrl}/api/chat`)).status, 400);
    });
});
