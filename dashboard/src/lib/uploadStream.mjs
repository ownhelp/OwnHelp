/**
 * Pure helpers for the gateway's NDJSON upload stream (POST /api/documents/upload with
 * `Accept: application/x-ndjson`): one JSON object per line, `stage` events while the document is
 * processed, then exactly one `done` (the ingestion summary) or `error` event. No DOM or fetch here
 * so node:test can exercise it directly.
 */

/** Splits arbitrary text chunks into complete JSON lines; a partial last line waits for more text. */
export function createNdjsonLineBuffer() {
    let pending = "";
    const parseLines = (lines) => {
        const events = [];
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === "object") events.push(parsed);
            } catch {
                // A malformed line is skipped rather than failing a whole upload.
            }
        }
        return events;
    };
    return {
        push(text) {
            pending += text;
            const lines = pending.split("\n");
            pending = lines.pop();
            return parseLines(lines);
        },
        flush() {
            const rest = pending;
            pending = "";
            return parseLines([rest]);
        },
    };
}

/**
 * Reads a streamed upload to its end. `reader` is a ReadableStream reader (read() resolving to
 * { done, value } with Uint8Array or string values). Calls onStage(stage) for each stage event and
 * returns the `done` summary without its `event` key; throws an Error (with `code`) on an `error`
 * event or when the stream ends without a terminal event.
 */
export async function readUploadStream(reader, onStage) {
    const decoder = new TextDecoder();
    const buffer = createNdjsonLineBuffer();
    let summary = null;
    let failure = null;

    const handle = (events) => {
        for (const event of events) {
            if (event.event === "stage" && typeof event.stage === "string") {
                if (typeof onStage === "function") onStage(event.stage);
            } else if (event.event === "done") {
                // Drop the protocol's `event` marker so callers get the plain ingestion summary.
                const { event: _ignored, ...rest } = event;
                summary = rest;
            } else if (event.event === "error") {
                failure = event;
            }
        }
    };

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        handle(
            buffer.push(
                typeof value === "string"
                    ? value
                    : decoder.decode(value, { stream: true })
            )
        );
    }
    handle(buffer.flush());

    if (failure) {
        const error = new Error(failure.message || "Document upload failed.");
        error.code = failure.error || null;
        throw error;
    }
    if (!summary) {
        throw new Error(
            "The upload ended before the server confirmed it finished. Check the document list before retrying."
        );
    }
    return summary;
}

/** Human label for a stage, with a generic fallback for stages a newer gateway may add. */
export function describeUploadStage(stage, fileName = "") {
    switch (stage) {
        case "uploading":
            return `Uploading ${fileName || "file"} to Gateway staging...`;
        case "parsing":
            return "Parsing document into chunks...";
        case "embedding":
            return "Embedding chunks with BAAI/bge-small-en-v1.5...";
        case "writing":
            return "Writing vectors to doc_vectors...";
        default:
            return "Processing...";
    }
}
