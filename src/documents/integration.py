"""Shared, deterministic document views for generation and retrieval.

This module transforms representation only. It never changes source files,
repairs policy claims, chooses benchmark answers, embeds, or contacts a service.

Inputs: a tenant directory or a ``ParsedDocument``. Outputs: ordered document paths, parsed
documents, a text rendering for data generation, and chunk dicts carrying provenance
(``source_id``, ``source_sha256``, ``source_locator``, ``source_context``, ``source_block_index``,
``parser_version``) that match the extra ``doc_vectors`` fields written by the ingestor.
Callers: ``RAGDocumentIngestor`` (structured mode) and data-generation scripts. Using one module
for both generation and retrieval keeps the text a question was generated from identical to the
text that is later retrieved.
"""

from pathlib import Path
import json

from src.documents.parser import ParsedDocument, parse_document, context_blocks


PARSER_MODE_VERSION = "structured-v1"


def discover_document_paths(root: Path, include_reference: bool = False) -> list[Path]:
    """One eligibility/containment policy for every structured pipeline caller.

    Skips dotfiles and ``generation_reference`` folders (answer-key material that must never be
    retrievable unless explicitly included) and refuses symlinks that escape the root.
    """
    root = Path(root).resolve()
    if not root.is_dir():
        raise ValueError("Source document root must be a directory")
    paths = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if any(part.startswith(".") or (part == "generation_reference" and not include_reference)
               for part in relative.parts):
            continue
        if path.is_symlink() and root not in path.resolve().parents:
            raise ValueError("Document symlink resolves outside its source directory")
        if path.is_file() and path.suffix.lower() in {".md", ".json", ".txt"}:
            paths.append(path)
    return paths


def load_documents(root: Path, include_reference: bool = False) -> dict[str, ParsedDocument]:
    """Parses every eligible document, keyed by its path relative to ``root`` (posix style)."""
    root = Path(root).resolve()
    return {path.relative_to(root).as_posix(): parse_document(path, path.relative_to(root).as_posix())
            for path in discover_document_paths(root, include_reference)}


def render_generation_document(document: ParsedDocument, max_words: int | None = None) -> str:
    """Expose the same atomic text blocks used by retrieval, with provenance."""
    parts = [f"Document SHA256: {document.sha256}"]
    blocks = context_blocks(document, max_words) if max_words is not None else document.blocks
    for index, block in enumerate(blocks):
        locator = json.dumps(block.locator, sort_keys=True, ensure_ascii=False)
        parts.append(f"[Block {index}; kind={block.kind}; locator={locator}]\n{block.text}")
    return "\n\n".join(parts)


def document_chunks(document: ParsedDocument, max_words: int | None = None) -> list[dict]:
    """Keep complete parsed blocks; refuse an oversized block rather than cut it.

    A word budget is not a model tokenizer budget. Callers must separately check
    their embedding and inference token limits before serving new documents.
    """
    if max_words is not None and (type(max_words) is not int or max_words < 1):
        raise ValueError("max_words must be a positive integer or None")
    chunks = []
    blocks = context_blocks(document, max_words) if max_words is not None else document.blocks
    for index, block in enumerate(blocks):
        if max_words is not None and len(block.text.split()) > max_words:
            raise ValueError(
                f"Atomic document block {document.source_id}:{index} exceeds "
                f"the {max_words}-word budget; it was not truncated."
            )
        chunks.append({
            "doc_id": document.source_id,
            "section": block.section or "Overview",
            "text": block.text,
            "source_id": document.source_id,
            "source_sha256": document.sha256,
            "source_locator": dict(block.locator),
            "source_context": dict(block.metadata),
            "source_block_index": index,
            "parser_version": PARSER_MODE_VERSION,
        })
    return chunks
