"use client";

/**
 * Right-hand drawer (full height, full width on phones) that fetches and shows the raw stored
 * content of one document, with copy and replace actions. Rendered by the overview page only while
 * a document is selected; clicking the backdrop closes it.
 */

import React, { useState, useEffect } from "react";
import { fetchTenantDocumentDetail } from "@/lib/api";

/** Props: tenantId, docId (what to load); onClose; onRequestReupload (replace this document). */
export default function DocumentViewerModal({
    tenantId,
    docId,
    onClose,
    onRequestReupload,
}) {
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    // Escape closes the drawer, matching the "ESC / Close" label on the button.
    useEffect(() => {
        function handleKeyDown(event) {
            if (event.key === "Escape") onClose();
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        if (!tenantId || !docId) return;
        let cancelled = false;

        async function loadDetail() {
            // Deferring one microtask keeps the setState calls below out of the effect's synchronous body.
            await Promise.resolve();
            if (cancelled) return;
            setLoading(true);
            setError(null);
            try {
                const data = await fetchTenantDocumentDetail(tenantId, docId);
                if (!cancelled) {
                    setDetail(data);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err.message || "Failed to load document content.");
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        loadDetail();
        return () => {
            cancelled = true;
        };
    }, [tenantId, docId]);

    if (!docId) return null;

    const handleCopy = async () => {
        if (!detail?.raw_text) return;
        try {
            await navigator.clipboard.writeText(detail.raw_text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard unavailable
        }
    };

    return (
        <div
            className="fixed inset-0 z-50 bg-black/75 flex items-center justify-end"
            onClick={onClose}
        >
            <div
                className="h-dvh w-full max-w-3xl bg-zinc-950 sm:border-l border-zinc-800 flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Drawer Header */}
                <div className="border-b border-zinc-800 px-4 sm:px-6 py-3 sm:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-zinc-900/40">
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-sm font-semibold text-zinc-100">
                                {detail?.file_name || docId}
                            </span>
                            <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                                .{detail?.format || "md"}
                            </span>
                            {detail?.chunk_count !== undefined && (
                                <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
                                    {detail.chunk_count} chunks
                                </span>
                            )}
                        </div>
                        <p className="break-all font-mono text-xs text-zinc-500 mt-1">
                            tenant_id: {tenantId} • doc_id: {docId}
                        </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
                        {detail?.raw_text && (
                            <button
                                type="button"
                                onClick={handleCopy}
                                className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-2 sm:py-1 font-mono text-xs text-zinc-200 cursor-pointer"
                            >
                                {copied ? "copied" : "copy raw"}
                            </button>
                        )}
                        {onRequestReupload && (
                            <button
                                type="button"
                                // Close first so the drawer does not cover the dropzone the page targets.
                                onClick={() => {
                                    onClose();
                                    onRequestReupload(docId);
                                }}
                                className="rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-2 sm:py-1 text-xs font-medium text-zinc-100 cursor-pointer"
                            >
                                Re-upload
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onClose}
                            className="ml-auto sm:ml-0 rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-2 sm:py-1 font-mono text-xs text-zinc-400 hover:text-zinc-100 cursor-pointer"
                        >
                            <span className="hidden sm:inline">ESC / </span>Close
                        </button>
                    </div>
                </div>

                {/* Drawer Body */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
                    {loading ? (
                        <div className="rounded border border-zinc-800 bg-zinc-900/30 p-8 text-center font-mono text-xs text-zinc-400">
                            Loading raw document for {docId}...
                        </div>
                    ) : error ? (
                        <div className="rounded border border-red-900 bg-red-950/40 p-4 font-mono text-xs text-red-200">
                            {error}
                        </div>
                    ) : (
                        <pre className="whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-900/50 p-4 font-mono text-xs leading-relaxed text-zinc-200">
                            {detail?.raw_text || ""}
                        </pre>
                    )}
                </div>

                {/* Drawer Footer */}
                <div className="border-t border-zinc-800 px-4 sm:px-6 py-3 bg-zinc-900/40 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs text-zinc-500">
                    <span>
                        chars: {detail?.raw_text ? detail.raw_text.length.toLocaleString() : 0}
                    </span>
                    <span>
                        created_at: {detail?.created_at || "—"}
                    </span>
                </div>
            </div>
        </div>
    );
}

