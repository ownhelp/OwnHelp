// Protects the NDJSON upload stream reader: stage events, done/error handling and chunk-boundary safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createNdjsonLineBuffer,
    describeUploadStage,
    readUploadStream,
} from "../src/lib/uploadStream.mjs";

function readerOf(chunks) {
    const encoder = new TextEncoder();
    let index = 0;
    return {
        async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[index++]) };
        },
    };
}

test("line buffer holds a partial line until it is complete and skips junk", () => {
    const buffer = createNdjsonLineBuffer();
    assert.deepEqual(buffer.push('{"a":1}\n{"b"'), [{ a: 1 }]);
    assert.deepEqual(buffer.push(':2}\nnot json\n'), [{ b: 2 }]);
    assert.deepEqual(buffer.push('{"c":3}'), []);
    assert.deepEqual(buffer.flush(), [{ c: 3 }]);
});

test("stages are reported in order and the done summary is returned", async () => {
    const stages = [];
    const summary = await readUploadStream(
        readerOf([
            '{"event":"stage","stage":"uploading"}\n{"event":"sta',
            'ge","stage":"parsing"}\n{"event":"stage","stage":"embedding"}\n',
            '{"event":"done","status":"success","doc_id":"A","chunks_created":3}\n',
        ]),
        (stage) => stages.push(stage)
    );
    assert.deepEqual(stages, ["uploading", "parsing", "embedding"]);
    assert.deepEqual(summary, {
        status: "success",
        doc_id: "A",
        chunks_created: 3,
    });
});

test("an error event throws with its message and code", async () => {
    await assert.rejects(
        readUploadStream(
            readerOf([
                '{"event":"error","error":"DOCUMENT_EXISTS","message":"Already there."}\n',
            ])
        ),
        (error) => error.message === "Already there." && error.code === "DOCUMENT_EXISTS"
    );
});

test("a stream that ends without done or error is an error", async () => {
    await assert.rejects(
        readUploadStream(readerOf(['{"event":"stage","stage":"parsing"}\n'])),
        /ended before the server confirmed/
    );
});

test("unknown stages get a generic label", () => {
    assert.equal(describeUploadStage("something_new"), "Processing...");
    assert.match(describeUploadStage("uploading", "a.md"), /a\.md/);
});
