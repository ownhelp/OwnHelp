// Protects the contract between the widget client and the mock gateway: SSE/JSON shapes, headers, error envelope, no sources leaked.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createMockApp } from "../mock/mock_gateway.js";
import { streamChat } from "../src/lib/chatClient.js";

let server;
let apiUrl;

// Valid for the real gateway: 16 to 128 characters of letters, digits and _ - . :
const SID = "test-session-0001";
const ALLOWED = "https://shop.example.test";

before(async () => {
    server = createMockApp({ tokenDelayMs: 1, allowedOrigins: [ALLOWED] }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
    server.closeAllConnections?.();
    server.close();
});

const call = (message, extra = {}) =>
    streamChat({ apiUrl, tenantId: "example_tenant", message, sessionId: SID, ...extra });

test("contract: streaming reply delivers only tokens and done", async () => {
    const tokens = [];
    const result = await call("What is your return policy?", { onToken: (t) => tokens.push(t) });
    assert.ok(tokens.length > 1, "expected multiple token events");
    assert.equal(result.answer, tokens.join(""));
    assert.match(result.answer, /return policy/);
    assert.deepEqual(Object.keys(result).sort(), ["answer", "sessionId"]);
});

test("contract: the raw stream contains no sources and no escalation signal", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ tenant_id: "example_tenant", message: "hi", session_id: SID }),
    });
    const text = await response.text();
    const events = [...text.matchAll(/^event: (.*)$/gm)].map((match) => match[1]);
    assert.ok(events.length > 2);
    assert.deepEqual([...new Set(events)].sort(), ["done", "token"]);
    for (const leaked of ["sources", "doc_id", "escalat", "action", "confidence"]) {
        assert.ok(!text.toLowerCase().includes(leaked), `stream must not contain '${leaked}'`);
    }
});

test("contract: real SSE content type and anti-buffering headers", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ tenant_id: "example_tenant", message: "hi", session_id: SID }),
    });
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    assert.match(response.headers.get("cache-control"), /no-cache/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    await response.body.cancel();
});

test("contract: JSON fallback when the client does not accept SSE", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ tenant_id: "example_tenant", message: "hi", session_id: SID }),
    });
    const body = await response.json();
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.equal(typeof body.answer, "string");
    assert.equal(body.session_id, SID);
});

test("contract: nostream keyword yields JSON that the client still handles", async () => {
    const result = await call("nostream please");
    assert.match(result.answer, /nostream please/);
    assert.deepEqual(Object.keys(result).sort(), ["answer", "sessionId"]);
});

test("contract: the JSON fallback body has only answer and session_id", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ tenant_id: "example_tenant", message: "hi", session_id: SID }),
    });
    assert.deepEqual(Object.keys(await response.json()).sort(), ["answer", "session_id"]);
});

test("contract: validation errors use the error envelope", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: "example_tenant", session_id: SID }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");

    const tooLong = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: "example_tenant", session_id: SID, message: "x".repeat(2001) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error.code, "message_too_long");
});

test("contract: 429 and 404 surface as ChatError", async () => {
    await assert.rejects(call("ratelimit"), (e) => e.code === "rate_limited" && e.status === 429);
    await assert.rejects(call("unknown tenant"), (e) => e.code === "unknown_tenant" && e.status === 404);
});

test("contract: mid-stream error and missing done are reported", async () => {
    const tokens = [];
    await assert.rejects(call("error", { onToken: (t) => tokens.push(t) }), (e) => e.code === "generation_failed");
    assert.ok(tokens.length > 0, "tokens should arrive before the failure");
    await assert.rejects(call("cutoff"), (e) => e.code === "stream_interrupted");
});

test("contract: CORS preflight allows cross-origin POST without credentials", async () => {
    const response = await fetch(`${apiUrl}/api/chat`, {
        method: "OPTIONS",
        headers: {
            Origin: "https://shop.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    });
    assert.ok(response.status < 300);
    assert.ok(response.headers.get("access-control-allow-origin"));
    assert.notEqual(response.headers.get("access-control-allow-credentials"), "true");
});

test("aborting mid-stream stops the client", async () => {
    const controller = new AbortController();
    const pending = call("slow answer", {
        signal: controller.signal,
        onToken: () => controller.abort(),
    });
    await assert.rejects(pending, (e) => e.code === "aborted");
});

test("contract: follow-up capability supports SSE and JSON and scopes contact saving", async () => {
    const { submitContact } = await import("../src/lib/chatClient.js");
    for (const message of ["human please", "human nostream please"]) {
        const result = await call(message);
        assert.equal(result.followUp.available, true);
        assert.equal(typeof result.followUp.token, "string");
        assert.equal(result.followUp.contactEmail, "support@example.test");
        const options = { apiUrl, tenantId: "example_tenant", sessionId: SID, followUpToken: result.followUp.token,
            name: "Test Visitor", email: "visitor@example.test" };
        assert.deepEqual(await submitContact(options), { status: "saved" });
        await assert.rejects(submitContact({ ...options, sessionId: "other-session-0002" }), (error) => error.status === 403);
        await assert.rejects(submitContact({ ...options, tenantId: "other_tenant" }), (error) => error.status === 403);
    }
});

const post = (path, body, headers = {}, raw) =>
    fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: raw ?? JSON.stringify(body),
    });
const chatBody = (over = {}) => ({ tenant_id: "example_tenant", message: "hi", session_id: SID, ...over });
const codeOf = async (response) => (await response.json()).error.code;

test("mock enforces the real session_id format", async () => {
    for (const bad of ["s1", "short-id-15-cha", "has space in it 123", "semi;colon;1234567", "x".repeat(129), 12345678901234567, undefined]) {
        const response = await post("/api/chat", chatBody({ session_id: bad }));
        assert.equal(response.status, 400, String(bad));
        assert.equal(await codeOf(response), "invalid_request", String(bad));
    }
    for (const good of ["a".repeat(16), "A-b_c.d:e-1234567", "x".repeat(128)]) {
        const response = await post("/api/chat", chatBody({ session_id: good }), { Accept: "application/json" });
        assert.equal(response.status, 200, good);
    }
});

test("mock requires a message and caps it at 2000 characters", async () => {
    for (const bad of [undefined, "", "   ", 42]) {
        const response = await post("/api/chat", chatBody({ message: bad }));
        assert.equal(response.status, 400);
        assert.equal(await codeOf(response), "invalid_request");
    }
    const exact = await post("/api/chat", chatBody({ message: "x".repeat(2000) }), { Accept: "application/json" });
    assert.equal(exact.status, 200);
    assert.equal((await post("/api/chat", chatBody({ message: "x".repeat(2001) }))).status, 400);
});

test("mock caps bodies at 16kb for chat and 8kb for contact with 400 invalid_request", async () => {
    const bigChat = await post("/api/chat", chatBody({ pad: "x".repeat(17 * 1024) }));
    assert.equal(bigChat.status, 400);
    assert.equal(await codeOf(bigChat), "invalid_request");
    // 10 KB is fine for chat but over the contact limit.
    const tenKb = { pad: "x".repeat(10 * 1024) };
    assert.equal((await post("/api/chat", chatBody(tenKb), { Accept: "application/json" })).status, 200);
    const bigContact = await post("/api/chat/contact", { tenant_id: "example_tenant", session_id: SID, ...tenKb });
    assert.equal(bigContact.status, 400);
    assert.equal(await codeOf(bigContact), "invalid_request");
    const malformed = await post("/api/chat", null, {}, "{not json");
    assert.equal(malformed.status, 400);
    assert.equal(await codeOf(malformed), "invalid_request");
});

test("mock enforces the origin allowlist on the POST, not on the preflight", async () => {
    const denied = await post("/api/chat", chatBody(), { Origin: "https://evil.example.test" });
    assert.equal(denied.status, 403);
    assert.equal(await codeOf(denied), "origin_not_allowed");
    assert.equal(denied.headers.get("access-control-allow-origin"), "https://evil.example.test");
    assert.equal((await post("/api/chat", chatBody(), { Origin: "null" })).status, 403);
    assert.equal((await post("/api/chat", chatBody(), { Origin: ALLOWED, Accept: "application/json" })).status, 200);
    // No Origin header (curl, server side) is allowed, as in the real gateway.
    assert.equal((await post("/api/chat", chatBody(), { Accept: "application/json" })).status, 200);
    const contact = await post("/api/chat/contact",
        { tenant_id: "example_tenant", session_id: SID, follow_up_token: "x", name: "A", email: "a@b.test" },
        { Origin: "https://evil.example.test" });
    assert.equal(contact.status, 403);
    assert.equal(await codeOf(contact), "origin_not_allowed");
    const preflight = await fetch(`${apiUrl}/api/chat`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example.test", "Access-Control-Request-Method": "POST" },
    });
    assert.ok(preflight.status < 300);
});

test("mock answers 404 unknown_tenant for unknown or malformed tenant ids", async () => {
    for (const tenant of ["unknown_tenant", "Bad Tenant!", "x"]) {
        const response = await post("/api/chat", chatBody({ tenant_id: tenant }));
        assert.equal(response.status, 404, tenant);
        assert.equal(await codeOf(response), "unknown_tenant", tenant);
    }
});

test("mock answers 429 rate_limited with a Retry-After header", async () => {
    const response = await post("/api/chat", chatBody({ message: "ratelimit please" }));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(await codeOf(response), "rate_limited");
});

test("mock contact: validation, scoping, first-submission-wins and rate limit", async () => {
    const { submitContact } = await import("../src/lib/chatClient.js");
    const { followUp } = await call("human please");
    const base = { apiUrl, tenantId: "example_tenant", sessionId: SID, followUpToken: followUp.token,
        name: "Test Visitor", email: "visitor@example.test" };
    const fails = (options, status, code) =>
        assert.rejects(submitContact(options), (error) => error.status === status && error.code === code);

    await fails({ ...base, email: "not-an-email" }, 400, "invalid_request");
    await fails({ ...base, name: " " }, 400, "invalid_request");
    await fails({ ...base, name: "x".repeat(101) }, 400, "invalid_request");
    await fails({ ...base, sessionId: "short" }, 400, "invalid_request");
    await fails({ ...base, followUpToken: "forged" }, 403, "invalid_follow_up");
    await fails({ ...base, name: "ratelimit" }, 429, "rate_limited");
    await fails({ ...base, tenantId: "unknown_tenant" }, 404, "unknown_tenant");
    await assert.rejects(submitContact({ ...base, name: "ratelimit" }), (error) => error.retryAfterSec === 30);

    assert.deepEqual(await submitContact(base), { status: "saved" });
    assert.deepEqual(await submitContact(base), { status: "saved" }, "identical resubmission is idempotent");
    await fails({ ...base, name: "Someone Else" }, 409, "contact_already_submitted");
});
