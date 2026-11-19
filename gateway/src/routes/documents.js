/**
 * Document management routes (mounted under /api, behind requireAuth).
 *
 * Purpose: let an administrator upload a Markdown/JSON document, list documents and inspect the
 * stored text and vector chunks for their own tenant. Embedding and chunking are Python work, so
 * uploads are staged on disk and handed to scripts/ingest_uploaded_document.py; this keeps the
 * embedding model out of the Node process and reuses the one ingestion implementation.
 *
 * Security: every route resolves its tenant through authorizeTenantAccess, so a tenant id in the
 * URL, query or form can never widen access. Uploaded file names are sanitized and prefixed, only
 * .md/.json up to 10 MB are accepted, and the staged file is always deleted afterwards.
 *
 * Env: UPLOAD_STAGING_DIR (staging directory), PYTHON_EXECUTABLE (interpreter override).
 * Callers: the dashboard's document manager and chunk viewer. Tests swap the Python runner with
 * setIngestionRunner() so they never spawn a process.
 */
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const multer = require("multer");
const { getDocVectorsCollection } = require("../db/mongo");
const { getAppMode, getActiveDatabaseName } = require("../config/mode");
const {
    isPresetTenantId,
    isValidTenantId,
    isValidDocId,
} = require("../config/presets");
const { authorizeTenantAccess } = require("../middleware/auth");

const router = express.Router();

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const UPLOAD_STAGING_DIR =
    (process.env.UPLOAD_STAGING_DIR || "").trim() || "/tmp/uploads";

fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });

function sanitizeFilename(filename) {
    return path
        .basename(filename || "document.md")
        .replace(/[^a-zA-Z0-9._-]/g, "_");
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
        cb(null, UPLOAD_STAGING_DIR);
    },
    filename: (req, file, cb) => {
        const sanitized = sanitizeFilename(file.originalname);
        const uniquePrefix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        cb(null, `${uniquePrefix}_${sanitized}`);
    },
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10 MB limit
    },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase();
        if (ext !== ".md" && ext !== ".json") {
            return cb(
                new Error(
                    "Only Markdown (.md) and JSON (.json) files are allowed."
                )
            );
        }
        cb(null, true);
    },
});

/**
 * Resolves a preset source file under data/<tenantId>/<docId>.<ext> ONLY when:
 * 1. APP_MODE === 'preset_training'
 * 2. tenantId is a registered preset tenant
 * 3. tenantId and docId pass strict identifier validation
 * 4. The resolved path stays strictly inside PROJECT_ROOT/data/<tenantId>
 */
function resolveSafePresetSourcePath(tenantId, docId, ext) {
    if (getAppMode(process.env) !== "preset_training") {
        return null;
    }
    if (
        !isValidTenantId(tenantId) ||
        !isPresetTenantId(tenantId) ||
        !isValidDocId(docId)
    ) {
        return null;
    }
    if (ext !== "md" && ext !== "json") {
        return null;
    }

    const baseDataDir = path.resolve(PROJECT_ROOT, "data");
    const tenantDir = path.resolve(baseDataDir, tenantId);
    if (
        !tenantDir.startsWith(baseDataDir + path.sep) ||
        path.dirname(tenantDir) !== baseDataDir
    ) {
        return null;
    }

    const candidatePath = path.resolve(tenantDir, `${docId}.${ext}`);
    if (
        !candidatePath.startsWith(tenantDir + path.sep) ||
        path.dirname(candidatePath) !== tenantDir
    ) {
        return null;
    }

    if (!fs.existsSync(candidatePath)) {
        return null;
    }

    return candidatePath;
}

function inferFormat(docId, explicitFormat, sampleText, tenantId) {
    if (explicitFormat === "md" || explicitFormat === "json") {
        return explicitFormat;
    }

    if (resolveSafePresetSourcePath(tenantId, docId, "json")) {
        return "json";
    }
    if (resolveSafePresetSourcePath(tenantId, docId, "md")) {
        return "md";
    }

    if (
        docId === "faq_support_knowledgebase" ||
        docId.endsWith("_matrix") ||
        docId.endsWith("_specs") ||
        (typeof sampleText === "string" && sampleText.trim().startsWith("{"))
    ) {
        return "json";
    }
    return "md";
}

// Runs the ingestion script and trusts only its last stdout line (a JSON summary) so library
// noise printed earlier cannot be mistaken for the result. Interpreter order: PYTHON_EXECUTABLE,
// then <repo>/.venv/bin/python, then `uv run`. The target database is passed explicitly so the
// worker writes to the gateway's active database (never its own default).
function defaultPythonIngestionRunner({
    filePath,
    tenantId,
    overwrite,
    docId,
    dbName,
    onStage,
}) {
    return new Promise((resolve, reject) => {
        const pythonExecutable = (process.env.PYTHON_EXECUTABLE || "").trim();
        let command = "uv";
        let scriptArgs = [
            "run",
            "python",
            "-m",
            "scripts.ingest_uploaded_document",
            "--file",
            filePath,
            "--tenant",
            tenantId,
            "--overwrite",
            overwrite ? "true" : "false",
            "--doc-id",
            docId,
            "--db-name",
            dbName,
        ];

        if (pythonExecutable) {
            command = pythonExecutable;
            scriptArgs = scriptArgs.slice(2);
        } else {
            const venvPython = path.resolve(PROJECT_ROOT, ".venv/bin/python");
            if (fs.existsSync(venvPython)) {
                command = venvPython;
                scriptArgs = scriptArgs.slice(2);
            }
        }

        const child = spawn(command, scriptArgs, {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                MONGODB_DB_NAME: dbName,
                HF_HUB_DISABLE_PROGRESS_BARS: "1",
                TOKENIZERS_PARALLELISM: "false",
            },
        });

        let stdout = "";
        let stderr = "";

        // Stage lines ({"event":"stage",...}) are reported as they arrive; they stay in `stdout`
        // harmlessly because only the LAST line is ever read as the final summary.
        let pendingLine = "";
        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            stdout += text;
            if (typeof onStage !== "function") return;
            pendingLine += text;
            const parts = pendingLine.split("\n");
            pendingLine = parts.pop();
            for (const part of parts) {
                try {
                    const event = JSON.parse(part);
                    if (event && event.event === "stage") onStage(event.stage);
                } catch {
                    // Not a JSON line (library noise): ignore.
                }
            }
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (err) => {
            reject(new Error(`Failed to spawn uv process: ${err.message}`));
        });

        child.on("close", (code) => {
            const lines = stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
            const lastLine = lines[lines.length - 1] || "";

            let parsed = null;
            try {
                parsed = JSON.parse(lastLine);
            } catch {
                parsed = null;
            }

            if (code === 0 && parsed && parsed.status === "success") {
                return resolve(parsed);
            }

            if (parsed && parsed.error) {
                const err = new Error(parsed.error);
                err.code = parsed.code || "INGESTION_ERROR";
                err.exitCode = code;
                return reject(err);
            }

            const fallbackMsg =
                stderr.trim() ||
                stdout.trim() ||
                `Python ingestion process exited with code ${code}`;
            const err = new Error(fallbackMsg);
            err.exitCode = code;
            reject(err);
        });
    });
}

const NDJSON_STAGES = new Set(["parsing", "embedding", "writing"]);

function wantsNdjson(req) {
    return String(req.get("accept") || "")
        .toLowerCase()
        .includes("application/x-ndjson");
}

// Streamed errors must never leak stack traces, staging paths or raw process stderr. Only errors
// the worker classified itself (they carry a `code`) keep their message; anything else is generic.
function safeStreamErrorMessage(error, tempFilePath) {
    if (!error || !error.code) {
        return "Failed to ingest uploaded document.";
    }
    let message = String(error.message || "Failed to ingest uploaded document.");
    if (tempFilePath) {
        message = message.split(tempFilePath).join("the uploaded file");
    }
    message = message.replace(/\/[^\s'"]*\/[^\s'"]*/g, "[path]");
    return message.split(/\r?\n/)[0].slice(0, 300);
}

let activeIngestionRunner = defaultPythonIngestionRunner;

function setIngestionRunner(runner) {
    activeIngestionRunner = runner || defaultPythonIngestionRunner;
}

function resetIngestionRunner() {
    activeIngestionRunner = defaultPythonIngestionRunner;
}

/**
 * POST /api/documents/upload
 * Auth: session cookie; multipart field `file` (.md/.json) plus optional `doc_id`, `overwrite`.
 * Response 200 ingestion summary from the worker; 400 bad file/doc_id/worker error; 409
 * DOCUMENT_EXISTS when overwrite is false.
 * With `Accept: application/x-ndjson` the 200 body is a stream of JSON lines instead: stage events
 * (uploading, parsing, embedding, writing) then one `done` (the summary) or `error` event.
 * Authenticates session and pre-validates any query/header tenant selector BEFORE multipart parsing.
 * After multipart parsing, verifies any body tenant_id against the session tenant, cleans up temp files
 * on rejection, and passes the session-authorized tenantId and active database name to the worker.
 */
router.post("/documents/upload", (req, res) => {
    // Pre-multipart authorization check (session + any query/header selector)
    const preAuthTenant = authorizeTenantAccess(req, res);
    if (!preAuthTenant) {
        return;
    }

    upload.single("file")(req, res, async (uploadErr) => {
        if (uploadErr) {
            return res.status(400).json({
                status: "error",
                error: uploadErr.message || "File upload failed.",
            });
        }

        const tempFilePath = req.file?.path;
        try {
            // Post-multipart authorization check (validates body.tenant_id if provided)
            const authorizedTenantId = authorizeTenantAccess(req, res);
            if (!authorizedTenantId) {
                return;
            }

            if (!req.file) {
                return res.status(400).json({
                    status: "error",
                    error: "No file uploaded. Provide a .md or .json file under field 'file'.",
                });
            }

            const rawOverwrite = req.body?.overwrite;
            const overwrite =
                rawOverwrite === undefined
                    ? true
                    : String(rawOverwrite).toLowerCase() === "true" ||
                      String(rawOverwrite) === "1";

            const originalStem = path.parse(req.file.originalname).name;
            const targetDocId = (req.body?.doc_id || originalStem || "document")
                .trim()
                .replace(/\.(md|json)$/i, "");

            if (!isValidDocId(targetDocId)) {
                return res.status(400).json({
                    status: "error",
                    error: "Invalid doc_id format.",
                });
            }

            const activeDbName = getActiveDatabaseName(process.env);
            const runnerParams = {
                filePath: tempFilePath,
                tenantId: authorizedTenantId,
                overwrite,
                docId: targetDocId,
                dbName: activeDbName,
            };

            if (wantsNdjson(req)) {
                // Everything that can fail with a plain 4xx has been validated above, so from
                // here on the status line is committed to 200 and failures travel as events.
                res.status(200);
                res.set({
                    "Content-Type": "application/x-ndjson; charset=utf-8",
                    "Cache-Control": "no-cache",
                    "X-Accel-Buffering": "no",
                });
                if (typeof res.flushHeaders === "function") res.flushHeaders();
                const send = (payload) => {
                    if (!res.writableEnded && !res.destroyed) {
                        res.write(`${JSON.stringify(payload)}\n`);
                    }
                };
                send({ event: "stage", stage: "uploading" });
                try {
                    const summary = await activeIngestionRunner({
                        ...runnerParams,
                        onStage: (stage) => {
                            if (NDJSON_STAGES.has(stage)) {
                                send({ event: "stage", stage });
                            }
                        },
                    });
                    send({ event: "done", ...summary });
                } catch (error) {
                    console.error(
                        "[POST /api/documents/upload] Error:",
                        error.message
                    );
                    send({
                        event: "error",
                        error: error.code || "INGESTION_ERROR",
                        message: safeStreamErrorMessage(error, tempFilePath),
                    });
                }
                return res.end();
            }

            const summary = await activeIngestionRunner(runnerParams);

            return res.status(200).json(summary);
        } catch (error) {
            console.error(
                "[POST /api/documents/upload] Error:",
                error.message
            );
            const statusCode = error.code === "DOCUMENT_EXISTS" ? 409 : 400;
            return res.status(statusCode).json({
                status: "error",
                code: error.code || "INGESTION_ERROR",
                error: error.message || "Failed to ingest uploaded document.",
            });
        } finally {
            if (tempFilePath) {
                await fs.promises.unlink(tempFilePath).catch(() => {});
            }
        }
    });
});

/**
 * GET /api/tenants/:tenantId/documents
 * Auth: session cookie, tenant must match the session. Response 200 document list with chunk
 * counts; 403 tenant mismatch; 500 on database failure.
 * Queries doc_vectors grouped by doc_id for the session-authorized tenant.
 */
router.get("/tenants/:tenantId/documents", async (req, res) => {
    try {
        const authorizedTenantId = authorizeTenantAccess(
            req,
            res,
            req.params.tenantId
        );
        if (!authorizedTenantId) return;

        const docVectors = await getDocVectorsCollection();

        const pipeline = [
            { $match: { tenant_id: authorizedTenantId } },
            { $sort: { chunk_index: 1 } },
            {
                $group: {
                    _id: "$doc_id",
                    chunk_count: { $sum: 1 },
                    created_at: { $max: "$created_at" },
                    format: { $first: "$format" },
                    sample_text: { $first: "$text" },
                    total_chars: {
                        $sum: { $strLenCP: { $ifNull: ["$text", ""] } },
                    },
                },
            },
            { $sort: { _id: 1 } },
        ];

        const grouped = await docVectors.aggregate(pipeline).toArray();

        const documents = grouped.map((item) => {
            const docId = item._id;
            const format = inferFormat(
                docId,
                item.format,
                item.sample_text,
                authorizedTenantId
            );
            return {
                doc_id: docId,
                file_name: `${docId}.${format}`,
                format,
                chunk_count: item.chunk_count,
                total_chars: item.total_chars || 0,
                created_at: item.created_at || null,
            };
        });

        return res.json(documents);
    } catch (error) {
        console.error(
            "[GET /api/tenants/:tenantId/documents] Error:",
            error.message
        );
        return res.status(500).json({
            error: "Failed to fetch tenant documents.",
        });
    }
});

/**
 * GET /api/tenants/:tenantId/documents/:docId
 * Auth: session cookie, tenant must match the session. Response 200 text + chunks; 400 bad
 * docId; 404 unknown document; 403 tenant mismatch.
 * Returns raw document text and ordered chunks for DocumentViewerModal.
 */
router.get("/tenants/:tenantId/documents/:docId", async (req, res) => {
    try {
        const authorizedTenantId = authorizeTenantAccess(
            req,
            res,
            req.params.tenantId
        );
        if (!authorizedTenantId) return;

        const { docId } = req.params;
        if (!isValidDocId(docId)) {
            return res.status(400).json({
                error: "Invalid document identifier.",
            });
        }

        const docVectors = await getDocVectorsCollection();

        const chunks = await docVectors
            .find(
                { tenant_id: authorizedTenantId, doc_id: docId },
                { projection: { _id: 0, embedding: 0 } }
            )
            .sort({ chunk_index: 1 })
            .toArray();

        if (!chunks || chunks.length === 0) {
            return res.status(404).json({
                error: `Document '${docId}' not found for tenant '${authorizedTenantId}'.`,
            });
        }

        const firstChunk = chunks[0];
        const format = inferFormat(
            docId,
            firstChunk.format,
            firstChunk.text,
            authorizedTenantId
        );

        let rawText = null;
        if (!firstChunk.format) {
            const safeDiskPath = resolveSafePresetSourcePath(
                authorizedTenantId,
                docId,
                format
            );
            if (safeDiskPath) {
                rawText = await fs.promises.readFile(safeDiskPath, "utf-8");
            }
        }

        if (!rawText) {
            if (format === "md") {
                const parts = [];
                let lastSection = null;
                for (const chunk of chunks) {
                    const sec = chunk.section || "Overview";
                    if (sec !== lastSection) {
                        parts.push(`## ${sec}\n\n${chunk.text}`);
                        lastSection = sec;
                    } else {
                        parts.push(chunk.text);
                    }
                }
                rawText = parts.join("\n\n");
            } else {
                rawText = chunks.map((c) => c.text).join("\n\n");
            }
        }

        return res.json({
            tenant_id: authorizedTenantId,
            doc_id: docId,
            file_name: `${docId}.${format}`,
            format,
            chunk_count: chunks.length,
            created_at: chunks[chunks.length - 1]?.created_at || null,
            raw_text: rawText,
            chunks,
        });
    } catch (error) {
        console.error(
            "[GET /api/tenants/:tenantId/documents/:docId] Error:",
            error.message
        );
        return res.status(500).json({
            error: "Failed to load document content.",
        });
    }
});

/**
 * GET /api/tenants/:tenantId/chunks
 * Auth: session cookie, tenant must match the session. Query: doc_id, page, limit.
 * Response 200 { chunks, total, page, limit, total_pages }. The embedding vector is projected out
 * (large, useless to the UI); limit is capped server side.
 * Returns paginated chunks for the session-authorized tenant.
 *
 * TODO(chunk-editing): this is the only chunk route and it is read-only. Manual chunk editing
 * needs PUT (edit text, re-embed) and DELETE routes under the same tenant check, a way to run the
 * embedding model from the gateway (today only the Python side embeds, so this likely calls the
 * chat service or a script), tests like the upload ones, and a doc_vectors write that follows the
 * replace_chunks pattern so a failure never loses the chunk. Never add fields to the doc_vectors
 * schema.
 */
router.get("/tenants/:tenantId/chunks", async (req, res) => {
    try {
        const authorizedTenantId = authorizeTenantAccess(
            req,
            res,
            req.params.tenantId
        );
        if (!authorizedTenantId) return;

        const docIdFilter = (req.query.doc_id || "").trim();
        if (docIdFilter && !isValidDocId(docIdFilter)) {
            return res.status(400).json({
                error: "Invalid doc_id filter.",
            });
        }

        const searchQuery = (req.query.search || "").trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(
            200,
            Math.max(1, parseInt(req.query.limit, 10) || 50)
        );
        const skip = (page - 1) * limit;

        const query = { tenant_id: authorizedTenantId };
        if (docIdFilter) {
            query.doc_id = docIdFilter;
        }
        if (searchQuery) {
            const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            query.$or = [
                { text: { $regex: escaped, $options: "i" } },
                { section: { $regex: escaped, $options: "i" } },
                { doc_id: { $regex: escaped, $options: "i" } },
            ];
        }

        const docVectors = await getDocVectorsCollection();
        const [total, rawChunks] = await Promise.all([
            docVectors.countDocuments(query),
            docVectors
                .find(query, { projection: { _id: 0, embedding: 0 } })
                .sort({ doc_id: 1, chunk_index: 1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
        ]);

        const chunks = rawChunks.map((chunk) => {
            const text = chunk.text || "";
            const charCount = text.length;
            const words = text.trim() ? text.trim().split(/\s+/).length : 0;
            const tokenEstimate = Math.max(1, Math.ceil(words * 1.3));
            const snippet =
                text.length > 160 ? `${text.slice(0, 160).trim()}...` : text;

            return {
                tenant_id: chunk.tenant_id,
                doc_id: chunk.doc_id,
                chunk_index: chunk.chunk_index,
                section: chunk.section || "Overview",
                snippet,
                text,
                char_count: charCount,
                word_count: words,
                token_estimate: tokenEstimate,
                created_at: chunk.created_at || null,
            };
        });

        return res.json({
            tenant_id: authorizedTenantId,
            chunks,
            total,
            page,
            limit,
            total_pages: Math.max(1, Math.ceil(total / limit)),
        });
    } catch (error) {
        console.error(
            "[GET /api/tenants/:tenantId/chunks] Error:",
            error.message
        );
        return res.status(500).json({
            error: "Failed to fetch tenant vector chunks.",
        });
    }
});

module.exports = router;
module.exports.setIngestionRunner = setIngestionRunner;
module.exports.resetIngestionRunner = resetIngestionRunner;
module.exports.resolveSafePresetSourcePath = resolveSafePresetSourcePath;
