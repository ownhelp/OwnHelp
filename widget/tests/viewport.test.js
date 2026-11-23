// Protects the phone keyboard handling: the widget box follows the visual viewport, only while unzoomed.
import assert from "node:assert/strict";
import test from "node:test";
import { viewportBox } from "../src/lib/viewport.js";

test("keyboard open: box follows the visible area and reports the keyboard", () => {
    assert.deepEqual(viewportBox({ innerHeight: 800, vvHeight: 480, vvOffsetTop: 0, vvScale: 1 }), {
        top: 0,
        height: 480,
        keyboardOpen: true,
    });
});

test("iOS pans the visual viewport down when focusing: the box moves with it", () => {
    const box = viewportBox({ innerHeight: 800, vvHeight: 480.4, vvOffsetTop: 122.6, vvScale: 1 });
    assert.deepEqual(box, { top: 123, height: 480, keyboardOpen: true });
});

test("keyboard closed or a small browser-bar change is not treated as a keyboard", () => {
    assert.equal(viewportBox({ innerHeight: 800, vvHeight: 800, vvOffsetTop: 0, vvScale: 1 }).keyboardOpen, false);
    assert.equal(viewportBox({ innerHeight: 800, vvHeight: 740, vvOffsetTop: 0, vvScale: 1 }).keyboardOpen, false);
});

test("pinch-zoomed or unusable values fall back to CSS sizing", () => {
    assert.equal(viewportBox({ innerHeight: 800, vvHeight: 400, vvOffsetTop: 0, vvScale: 2 }), null);
    assert.equal(viewportBox({ innerHeight: 800, vvHeight: 0, vvOffsetTop: 0, vvScale: 1 }), null);
    assert.equal(viewportBox({ innerHeight: 800, vvHeight: NaN, vvOffsetTop: 0, vvScale: 1 }), null);
});
