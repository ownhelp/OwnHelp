"use client";

/**
 * Table of a tenant's indexed documents with per-row view and replace (re-upload) actions. Below md
 * the table is replaced by a card list (a multi-column table does not fit a phone); both render the
 * same data and actions. Used by the overview page ("/").
 */

import React, { useRef, useState } from "react";
import { formatLocalDateTime } from "@/lib/dateTime.mjs";

/**
 * Props: documents, loading; onViewDocument (open the viewer); onReuploadDocument (called with
 * { file, overwrite: true, docId } after the hidden file input picks a file); onSelectTargetDoc
 * (optional, tells the page which doc the dropzone is replacing).
 */
export default function DocumentTable({
    documents = [],
    loading = false,
    onViewDocument,
    onReuploadDocument,
    onSelectTargetDoc,
}) {
    const fileInputRef = useRef(null);
    const [reuploadDocId, setReuploadDocId] = useState("");
    const [reuploadingId, setReuploadingId] = useState("");

    // One shared hidden file input serves every row: remember which doc was clicked, then open the picker.
    // The value is cleared first so choosing the same file twice still fires onChange.
    const handleTriggerRowReupload = (docId) => {
        setReuploadDocId(docId);
        if (onSelectTargetDoc) {
            onSelectTargetDoc(docId);
        }
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
            fileInputRef.current.click();
        }
    };

    const handleQuickFileChange = async (e) => {
        const file = e.target.files?.[0];
        if (!file || !reuploadDocId) return;

        setReuploadingId(reuploadDocId);
        try {
            await onReuploadDocument({
                file,
                overwrite: true,
                docId: reuploadDocId,
            });
        } finally {
            setReuploadingId("");
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    };

    return (
        <section className="rounded border border-zinc-800 bg-zinc-950">
            <input
                ref={fileInputRef}
                type="file"
                accept=".md,.json"
                onChange={handleQuickFileChange}
                className="hidden"
            />

            <div className="border-b border-zinc-800 px-4 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-zinc-900/40">
                <div className="flex items-center gap-2.5">
                    <h2 className="text-sm font-semibold text-zinc-100">
                        Ingested Documents
                    </h2>
                    <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                        {documents.length}
                    </span>
                </div>
                <span className="font-mono text-xs text-zinc-500">
                    collection: doc_vectors (grouped by doc_id)
                </span>
            </div>

            {loading ? (
                <div className="p-8 text-center font-mono text-xs text-zinc-400">
                    Querying tenant documents from MongoDB Atlas...
                </div>
            ) : documents.length === 0 ? (
                <div className="p-8 text-center">
                    <p className="text-sm font-medium text-zinc-300">
                        No documents ingested for this tenant yet.
                    </p>
                    <p className="font-mono text-xs text-zinc-500 mt-1">
                        Drop a .md or .json file above to index chunks into doc_vectors.
                    </p>
                </div>
            ) : (
                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/20 font-mono text-[11px] uppercase text-zinc-400">
                                <th className="py-2.5 px-5 font-medium">doc_id</th>
                                <th className="py-2.5 px-4 font-medium">Format</th>
                                <th className="py-2.5 px-4 font-medium">Chunks</th>
                                <th className="hidden lg:table-cell py-2.5 px-4 font-medium">Chars</th>
                                <th className="py-2.5 px-4 font-medium">Last Indexed</th>
                                <th className="py-2.5 px-5 font-medium text-right">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/80 text-xs">
                            {documents.map((doc) => {
                                const isRowReuploading =
                                    reuploadingId === doc.doc_id;
                                return (
                                    <tr
                                        key={doc.doc_id}
                                        className="hover:bg-zinc-900/30 transition-colors"
                                    >
                                        <td className="py-2.5 px-5 font-mono text-xs font-medium text-zinc-100">
                                            {doc.doc_id}
                                        </td>
                                        <td className="py-2.5 px-4">
                                            <span className="rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300 uppercase">
                                                .{doc.format || "md"}
                                            </span>
                                        </td>
                                        <td className="py-2.5 px-4 font-mono text-xs text-zinc-200">
                                            {doc.chunk_count}
                                        </td>
                                        <td className="hidden lg:table-cell py-2.5 px-4 font-mono text-xs text-zinc-400">
                                            {(doc.total_chars || 0).toLocaleString()}
                                        </td>
                                        <td className="py-2.5 px-4 font-mono text-xs text-zinc-400">
                                            {formatLocalDateTime(doc.created_at, { seconds: true })}
                                        </td>
                                        <td className="py-2.5 px-5 text-right">
                                            <div className="inline-flex items-center justify-end gap-2 whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onViewDocument(doc.doc_id)
                                                    }
                                                    className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-200 cursor-pointer"
                                                >
                                                    View
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={isRowReuploading}
                                                    onClick={() =>
                                                        handleTriggerRowReupload(
                                                            doc.doc_id
                                                        )
                                                    }
                                                    className="rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-100 disabled:opacity-50 cursor-pointer"
                                                >
                                                    {isRowReuploading
                                                        ? "Indexing..."
                                                        : "Re-upload"}
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Phone layout: one card per document. The table above takes over from md up. */}
            {!loading && documents.length > 0 && (
                <ul className="md:hidden divide-y divide-zinc-800/80">
                    {documents.map((doc) => {
                        const isRowReuploading = reuploadingId === doc.doc_id;
                        return (
                            <li key={doc.doc_id} className="p-4 space-y-2.5">
                                <div className="flex items-start justify-between gap-3">
                                    <p className="min-w-0 break-all font-mono text-xs font-medium text-zinc-100">
                                        {doc.doc_id}
                                    </p>
                                    <span className="shrink-0 rounded bg-zinc-900 border border-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-300 uppercase">
                                        .{doc.format || "md"}
                                    </span>
                                </div>
                                <p className="font-mono text-xs text-zinc-400">
                                    {doc.chunk_count} chunks •{" "}
                                    {(doc.total_chars || 0).toLocaleString()} chars
                                </p>
                                <p className="font-mono text-[11px] text-zinc-500">
                                    {formatLocalDateTime(doc.created_at, { seconds: true })}
                                </p>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onViewDocument(doc.doc_id)}
                                        className="flex-1 rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 cursor-pointer"
                                    >
                                        View
                                    </button>
                                    <button
                                        type="button"
                                        disabled={isRowReuploading}
                                        onClick={() =>
                                            handleTriggerRowReupload(doc.doc_id)
                                        }
                                        className="flex-1 rounded border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-100 disabled:opacity-50 cursor-pointer"
                                    >
                                        {isRowReuploading
                                            ? "Indexing..."
                                            : "Re-upload"}
                                    </button>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

