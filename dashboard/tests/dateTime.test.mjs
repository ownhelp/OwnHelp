// Protects the ticket/document time display: UTC timestamps must render in the viewer's timezone.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(new URL("../src/lib/dateTime.mjs", import.meta.url));

// The timezone is read when the process starts, so each zone is checked in its own process.
function format(tz, value, options = {}) {
    const script = `import(${JSON.stringify(modulePath)}).then((m) => console.log(m.formatLocalDateTime(${JSON.stringify(value)}, ${JSON.stringify(options)})));`;
    return execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString().trim();
}

test("a UTC timestamp is shown in the local timezone, not as UTC", () => {
    assert.equal(format("America/Denver", "2026-11-23T05:29:10.000Z"), "2026-11-22 22:29");
    assert.equal(format("America/Denver", "2026-11-23T05:29:10.000Z", { seconds: true }), "2026-11-22 22:29:10");
    assert.equal(format("UTC", "2026-11-23T05:29:10.000Z"), "2026-11-23 05:29");
    assert.equal(format("Asia/Tokyo", "2026-11-23T05:29:10.000Z"), "2026-11-23 14:29");
});

test("both stored formats carry the zone: JS 'Z' and Python '+00:00' show the same local time", () => {
    // Gateway writes new Date().toISOString(); ingestion writes datetime.now(timezone.utc).isoformat().
    assert.equal(format("America/Denver", "2026-11-23T05:29:10.123Z"), "2026-11-22 22:29");
    assert.equal(format("America/Denver", "2026-11-23T05:29:10.123456+00:00"), "2026-11-22 22:29");
    // A non-UTC offset is converted too.
    assert.equal(format("America/Denver", "2026-11-22T22:29:10-07:00"), "2026-11-22 22:29");
});

test("the timezone name can be appended, and bad values fall back", () => {
    assert.match(format("America/Denver", "2026-11-23T05:29:10.000Z", { zone: true }), /^2026-11-22 22:29 \S+/);
    assert.equal(format("UTC", ""), "—");
    assert.equal(format("UTC", "not a date"), "—");
});
