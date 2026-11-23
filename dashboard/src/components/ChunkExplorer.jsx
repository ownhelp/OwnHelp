"use client";

/**
 * Paged browser for a tenant's stored vector chunks (doc_vectors) with a detail view and manual
 * editing. Saving sends the new text to the gateway, which re-embeds it with the ingestion model
 * and stores text and vector together; the UI then shows the text the server stored, so a failed
 * save never looks like a successful one. Deleting chunks is not supported.
 */

import React, { useState } from "react";
import { useTenant } from "@/context/TenantContext";
import { updateTenantChunk } from "@/lib/chunkApi";

// Token budget of the embedding model; chunks above it are flagged (amber) because the model cannot
// embed more than this, and the gateway rejects edits it cannot embed in full.
const MAX_MODEL_TOKENS = 512;
// Must match the gateway/worker limit; longer text is rejected there.
const MAX_CHUNK_CHARS = 8000;

// Rough client-side estimate (about 1.3 tokens per word) for the live counter while typing; the
// gateway is the authority. Saved chunks show the server's own token_estimate instead.
function estimateTokens(text) {
    const trimmed = (text || "").trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    return Math.max(1, Math.ceil(words * 1.3));
}

// A chunk is identified by its document plus its position in it (no standalone chunk id is exposed).
function chunkKey(chunk) {
    return `${chunk.doc_id}-${chunk.chunk_index}`;
}

/**
 * Props: chunks, total, page, totalPages, loading (page data from the gateway); documents (for the
 * filter dropdown); selectedDocId and searchQuery (controlled filters); onChangeDocFilter,
 * onChangeSearch, onChangePage (callbacks; the parent page does the fetching).
 */
export default function ChunkExplorer({
    chunks = [],
    total = 0,
    page = 1,
    totalPages = 1,
    loading = false,
    documents = [],
    selectedDocId = "",
    searchQuery = "",
    onChangeDocFilter,
    onChangeSearch,
    onChangePage,
}) {
    const { activeTenantId } = useTenant();
    const [activeChunk, setActiveChunk] = useState(null);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState("");
    // Chunks as saved by the server, applied over the page data until the parent reloads it
    // (a new `chunks` array), so the table reflects an edit without a refetch.
    const [savedState, setSavedState] = useState({ source: null, byKey: {} });
    const savedByKey = savedState.source === chunks ? savedState.byKey : {};
    const shownChunks = chunks.map((chunk) => savedByKey[chunkKey(chunk)] || chunk);

    function openChunk(chunk) {
        setActiveChunk(savedByKey[chunkKey(chunk)] || chunk);
        setEditing(false);
        setSaveError("");
    }

    function openChunkForEdit(chunk) {
        const current = savedByKey[chunkKey(chunk)] || chunk;
        openChunk(chunk);
        setDraft(current.text || "");
        setEditing(true);
    }

    function closeChunk() {
        if (saving) return;
        setActiveChunk(null);
        setEditing(false);
        setSaveError("");
    }

    function startEditing() {
        setDraft(activeChunk.text || "");
        setSaveError("");
        setEditing(true);
    }

    function cancelEditing() {
        if (saving) return;
        setEditing(false);
        setSaveError("");
    }

    async function saveEdit() {
        const target = activeChunk;
        setSaving(true);
        setSaveError("");
        try {
            const stored = await updateTenantChunk(
                activeTenantId,
                target.doc_id,
                target.chunk_index,
                draft
            );
            setSavedState((prev) => ({
                source: chunks,
                byKey: {
                    ...(prev.source === chunks ? prev.byKey : {}),
                    [chunkKey(stored)]: stored,
                },
            }));
            setActiveChunk(stored);
            setEditing(false);
        } catch (err) {
            // Keep the draft so the edit is not lost; the stored chunk is unchanged.
            setSaveError(err.message || "Failed to save the chunk.");
        } finally {
            setSaving(false);
        }
    }

    const draftTokens = estimateTokens(draft);
    const draftTrimmedLength = draft.trim().length;
    const draftInvalid =
        draftTrimmedLength === 0 || draftTrimmedLength > MAX_CHUNK_CHARS;
    const draftUnchanged = activeChunk ? draft.trim() === (activeChunk.text || "").trim() : true;

    return (
        <section className="rounded border border-zinc-800 bg-zinc-950">
            {/* Header */}
            <div className="border-b border-zinc-800 px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-zinc-900/40">
                <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-sm font-semibold text-zinc-100">
                        Vector Chunk Explorer
                    </h2>
                    <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                        {total} chunks
                    </span>
                </div>

                {/* Filters */}
                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2">
                    <select
                        aria-label="Filter chunks by document"
                        value={selectedDocId}
                        onChange={(e) => onChangeDocFilter(e.target.value)}
                        className="w-full sm:w-auto sm:max-w-[16rem] bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 sm:py-1 font-mono text-xs text-zinc-200 focus:border-zinc-600 focus:outline-none"
                    >
                        <option value="">all documents ({documents.length})</option>
                        {documents.map((doc) => (
                            <option key={doc.doc_id} value={doc.doc_id}>
                                {doc.doc_id} ({doc.chunk_count})
                            </option>
                        ))}
                    </select>

                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => onChangeSearch(e.target.value)}
                        placeholder="Filter chunk text or section..."
                        className="w-full sm:w-52 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1.5 sm:py-1 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
                    />
                </div>
            </div>

            {/* Table */}
            {loading ? (
                <div className="p-8 text-center font-mono text-xs text-zinc-400">
                    Loading vector chunks from doc_vectors...
                </div>
            ) : chunks.length === 0 ? (
                <div className="p-8 text-center font-mono text-xs text-zinc-500">
                    No vector chunks match the current filter.
                </div>
            ) : (
                <>
                {/* Phone layout: one card per chunk. The table below takes over from md up. */}
                <ul className="md:hidden divide-y divide-zinc-800/80">
                    {shownChunks.map((chunk) => {
                        const withinBudget = chunk.token_estimate <= MAX_MODEL_TOKENS;
                        return (
                            <li key={chunkKey(chunk)} className="p-4 space-y-2.5">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate font-mono text-xs text-zinc-200">
                                            <span className="text-zinc-400">#{chunk.chunk_index}</span>{" "}
                                            {chunk.doc_id}
                                        </p>
                                        {chunk.section && (
                                            <p className="mt-0.5 line-clamp-2 break-words text-xs text-zinc-300">
                                                {chunk.section}
                                            </p>
                                        )}
                                    </div>
                                    <span
                                        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-xs ${
                                            withinBudget
                                                ? "bg-zinc-900 border-zinc-800 text-zinc-300"
                                                : "bg-amber-950/50 border-amber-800 text-amber-300"
                                        }`}
                                    >
                                        ~{chunk.token_estimate}/{MAX_MODEL_TOKENS}
                                    </span>
                                </div>
                                <p className="line-clamp-3 break-words font-mono text-xs leading-relaxed text-zinc-400">
                                    {chunk.snippet}
                                </p>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="font-mono text-xs text-zinc-500">
                                        {chunk.char_count} chars
                                    </span>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => openChunk(chunk)}
                                            className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-200 cursor-pointer"
                                        >
                                            Inspect
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => openChunkForEdit(chunk)}
                                            className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-200 cursor-pointer"
                                        >
                                            Edit
                                        </button>
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>

                {/* md and up: the snippet column shows from xl and the chars column from lg, so the
                    table fits without sideways scrolling at common widths. */}
                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/20 font-mono text-[11px] uppercase text-zinc-400">
                                <th className="py-2.5 px-4 lg:px-5 font-medium">Index</th>
                                <th className="py-2.5 px-4 font-medium">doc_id</th>
                                <th className="py-2.5 px-4 font-medium">Section Header</th>
                                <th className="hidden xl:table-cell py-2.5 px-4 font-medium">Text Snippet</th>
                                <th className="hidden lg:table-cell py-2.5 px-4 font-medium">Chars</th>
                                <th className="py-2.5 px-4 font-medium">Tokens</th>
                                <th className="py-2.5 px-4 lg:px-5 font-medium text-right">
                                    Actions
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/80 text-xs">
                            {shownChunks.map((chunk) => {
                                const withinBudget =
                                    chunk.token_estimate <= MAX_MODEL_TOKENS;
                                return (
                                    <tr
                                        key={chunkKey(chunk)}
                                        onClick={() => openChunk(chunk)}
                                        className="hover:bg-zinc-900/30 transition-colors cursor-pointer"
                                    >
                                        <td className="py-2.5 px-4 lg:px-5 font-mono text-xs text-zinc-300">
                                            #{chunk.chunk_index}
                                        </td>
                                        <td className="py-2.5 px-4 font-mono text-xs text-zinc-200 max-w-[160px] truncate">
                                            {chunk.doc_id}
                                        </td>
                                        <td className="py-2.5 px-4 text-zinc-300 max-w-[180px] truncate">
                                            {chunk.section}
                                        </td>
                                        <td className="hidden xl:table-cell py-2.5 px-4 font-mono text-xs text-zinc-400 max-w-md truncate">
                                            {chunk.snippet}
                                        </td>
                                        <td className="hidden lg:table-cell py-2.5 px-4 font-mono text-xs text-zinc-400">
                                            {chunk.char_count}
                                        </td>
                                        <td className="py-2.5 px-4 whitespace-nowrap">
                                            <span
                                                className={`rounded border px-1.5 py-0.5 font-mono text-xs ${
                                                    withinBudget
                                                        ? "bg-zinc-900 border-zinc-800 text-zinc-300"
                                                        : "bg-amber-950/50 border-amber-800 text-amber-300"
                                                }`}
                                            >
                                                ~{chunk.token_estimate}/{MAX_MODEL_TOKENS}
                                            </span>
                                        </td>
                                        <td className="py-2.5 px-4 lg:px-5">
                                            {/* nowrap + gap: the two buttons never wrap onto or over each other */}
                                            <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        openChunk(chunk);
                                                    }}
                                                    className="shrink-0 rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-200 cursor-pointer"
                                                >
                                                    Inspect
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        openChunkForEdit(chunk);
                                                    }}
                                                    className="shrink-0 rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-200 cursor-pointer"
                                                >
                                                    Edit
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                </>
            )}

            {/* Pagination Footer */}
            <div className="border-t border-zinc-800 px-4 sm:px-5 py-3 bg-zinc-900/40 flex flex-wrap items-center justify-between gap-2 font-mono text-xs text-zinc-400">
                <span>
                    page {page} of {totalPages} • {total} total chunks
                </span>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        disabled={page <= 1 || loading}
                        onClick={() => onChangePage(page - 1)}
                        className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-zinc-200 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                    >
                        Prev
                    </button>
                    <button
                        type="button"
                        disabled={page >= totalPages || loading}
                        onClick={() => onChangePage(page + 1)}
                        className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-zinc-200 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                    >
                        Next
                    </button>
                </div>
            </div>

            {/* Chunk Inspection Modal */}
            {activeChunk && (
                <div
                    className="fixed inset-0 z-50 bg-black/75 flex items-end sm:items-center justify-center p-0 sm:p-4"
                    onClick={closeChunk}
                >
                    <div
                        className="w-full max-w-2xl max-h-[92dvh] overflow-y-auto rounded-t sm:rounded border border-zinc-800 bg-zinc-950"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="sticky top-0 z-10 border-b border-zinc-800 px-4 sm:px-5 py-3.5 flex items-start justify-between gap-3 bg-zinc-900">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="break-all font-mono text-xs font-semibold text-zinc-100">
                                    {activeChunk.doc_id}
                                </span>
                                <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-300">
                                    chunk #{activeChunk.chunk_index}
                                </span>
                                <span className="rounded bg-zinc-900 border border-zinc-800 px-2 py-0.5 font-mono text-xs text-zinc-400">
                                    ~{activeChunk.token_estimate} / {MAX_MODEL_TOKENS} tokens
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={closeChunk}
                                disabled={saving}
                                className="shrink-0 rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-300 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                            >
                                Close
                            </button>
                        </div>

                        <div className="p-4 sm:p-5 space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-xs text-zinc-400">
                                <span className="break-words">section: {activeChunk.section}</span>
                                <span>
                                    {activeChunk.char_count} chars • {activeChunk.word_count} words
                                </span>
                            </div>

                            {editing ? (
                                <div className="space-y-2">
                                    <textarea
                                        aria-label="Chunk text"
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        disabled={saving}
                                        rows={12}
                                        className="w-full max-h-96 rounded border border-zinc-800 bg-zinc-900 p-4 font-mono text-xs leading-relaxed text-zinc-100 focus:border-zinc-600 focus:outline-none disabled:opacity-60"
                                    />
                                    <div
                                        className={`font-mono text-xs ${
                                            draftTokens > MAX_MODEL_TOKENS ||
                                            draftTrimmedLength > MAX_CHUNK_CHARS
                                                ? "text-amber-300"
                                                : "text-zinc-400"
                                        }`}
                                    >
                                        {draftTrimmedLength} chars • ~{draftTokens} /{" "}
                                        {MAX_MODEL_TOKENS} tokens
                                        {draftTokens > MAX_MODEL_TOKENS &&
                                            " — may exceed the embedding limit; the gateway rejects text it cannot embed in full."}
                                        {draftTrimmedLength > MAX_CHUNK_CHARS &&
                                            ` — over the ${MAX_CHUNK_CHARS} character limit.`}
                                    </div>
                                    {saveError && (
                                        <div
                                            role="alert"
                                            className="rounded border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-300"
                                        >
                                            {saveError}
                                        </div>
                                    )}
                                    <div className="flex items-center justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={cancelEditing}
                                            disabled={saving}
                                            className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 font-mono text-xs text-zinc-300 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={saveEdit}
                                            disabled={saving || draftInvalid || draftUnchanged}
                                            className="rounded border border-zinc-700 bg-zinc-100 hover:bg-white px-2.5 py-1 font-mono text-xs text-zinc-900 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                                        >
                                            {saving ? "Re-embedding and saving..." : "Save"}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded border border-zinc-800 bg-zinc-900 p-4 font-mono text-xs leading-relaxed text-zinc-100">
                                    {activeChunk.text}
                                </pre>
                            )}

                            <div className="flex flex-wrap items-center justify-between gap-2 pt-1 font-mono text-xs text-zinc-500">
                                <span>embedding: BAAI/bge-small-en-v1.5 (384 dims)</span>
                                {!editing && (
                                    <button
                                        type="button"
                                        onClick={startEditing}
                                        className="rounded border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 px-2.5 py-1 text-zinc-200 cursor-pointer"
                                    >
                                        Edit chunk
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

