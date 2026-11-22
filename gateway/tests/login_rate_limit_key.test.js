// Protects: the login rate-limit key is derived from req.ip (set by Express "trust proxy") and the
// email only, so a client-supplied x-forwarded-for header can never change the bucket.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { getRateLimitKey } = require("../src/routes/auth");

describe("login rate-limit key", () => {
    test("uses req.ip and the email", () => {
        const key = getRateLimitKey({ ip: "203.0.113.5", headers: {} }, "a@b.com");
        assert.equal(key, "203.0.113.5:a@b.com");
    });

    test("a spoofed x-forwarded-for header does not change the key", () => {
        const plain = getRateLimitKey({ ip: "203.0.113.5", headers: {} }, "a@b.com");
        const spoofed = getRateLimitKey(
            { ip: "203.0.113.5", headers: { "x-forwarded-for": "1.2.3.4" } },
            "a@b.com"
        );
        assert.equal(spoofed, plain);
    });

    test("without req.ip it falls back to the socket address, never the header", () => {
        const key = getRateLimitKey(
            {
                headers: { "x-forwarded-for": "1.2.3.4" },
                socket: { remoteAddress: "198.51.100.7" },
            },
            "a@b.com"
        );
        assert.equal(key, "198.51.100.7:a@b.com");

        const none = getRateLimitKey({ headers: { "x-forwarded-for": "1.2.3.4" } }, "");
        assert.equal(none, "unknown:unknown");
    });

    test("through Express with trust proxy off, a spoofed header is ignored", async () => {
        const app = express();
        app.set("trust proxy", false);
        app.get("/key", (req, res) => res.json({ key: getRateLimitKey(req, "a@b.com") }));
        const server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        try {
            const url = `http://127.0.0.1:${server.address().port}/key`;
            const a = await (await fetch(url)).json();
            const b = await (
                await fetch(url, { headers: { "X-Forwarded-For": "9.9.9.9" } })
            ).json();
            assert.equal(a.key, b.key);
            assert.ok(!a.key.includes("9.9.9.9"));
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
