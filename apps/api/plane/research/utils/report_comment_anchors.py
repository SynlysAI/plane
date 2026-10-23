"""Validation and bounded resolution for periodic-report text anchors."""

import hashlib
import json


ANCHOR_SCHEMA_VERSION = 1
ANCHOR_KEYS = {
    "version",
    "block_id",
    "block_type",
    "selected_text",
    "prefix",
    "suffix",
    "start_offset",
    "end_offset",
}
MAX_BLOCK_ID_LENGTH = 128
MAX_BLOCK_TYPE_LENGTH = 64
MAX_SELECTED_LENGTH = 2000
MAX_CONTEXT_LENGTH = 128


class ReportAnchorError(ValueError):
    """Raised when an anchor is malformed or does not match its snapshot."""


def canonical_json(value) -> str:
    """Serialize editor JSON deterministically for stable content hashes."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def snapshot_content_hash(snapshot) -> str:
    """Hash the authoritative editor JSON of a formal report snapshot."""
    return hashlib.sha256(canonical_json(snapshot.description_json or {}).encode("utf-8")).hexdigest()


def _node_text(node) -> str:
    """Extract plain text from a TipTap JSON node without evaluating HTML."""
    if not isinstance(node, dict):
        return ""
    text = node.get("text")
    if isinstance(text, str):
        return text
    return "".join(_node_text(child) for child in node.get("content") or [])


def document_blocks(description_json) -> dict[str, dict[str, str]]:
    """Return stable block IDs mapped to block type and extracted text.

    Args:
        description_json: TipTap document JSON from a report snapshot.

    Returns:
        A mapping of block ID to ``{"type", "text"}``; blocks without IDs are
        deliberately omitted because they cannot be safely anchored.
    """
    blocks: dict[str, dict[str, str]] = {}

    def visit(node) -> None:
        if not isinstance(node, dict):
            return
        attrs = node.get("attrs")
        block_id = attrs.get("id") if isinstance(attrs, dict) else None
        node_type = node.get("type")
        if isinstance(block_id, str) and block_id and isinstance(node_type, str):
            blocks[block_id] = {"type": node_type, "text": _node_text(node)}
        for child in node.get("content") or []:
            visit(child)

    visit(description_json or {})
    return blocks


def _validate_shape(anchor) -> None:
    """Validate anchor field types and bounded lengths."""
    if not isinstance(anchor, dict) or set(anchor) != ANCHOR_KEYS:
        raise ReportAnchorError("Anchor fields are invalid.")
    if anchor["version"] != ANCHOR_SCHEMA_VERSION:
        raise ReportAnchorError("Anchor schema version is unsupported.")
    for key, limit in (
        ("block_id", MAX_BLOCK_ID_LENGTH),
        ("block_type", MAX_BLOCK_TYPE_LENGTH),
        ("selected_text", MAX_SELECTED_LENGTH),
        ("prefix", MAX_CONTEXT_LENGTH),
        ("suffix", MAX_CONTEXT_LENGTH),
    ):
        value = anchor[key]
        if not isinstance(value, str) or not value.strip() or len(value) > limit:
            raise ReportAnchorError(f"Anchor {key} is invalid.")
    start, end = anchor["start_offset"], anchor["end_offset"]
    if type(start) is not int or type(end) is not int or not 0 <= start < end:
        raise ReportAnchorError("Anchor offsets are invalid.")


def validate_report_anchor(description_json, anchor) -> dict:
    """Validate an anchor against the exact formal snapshot it targets.

    Args:
        description_json: TipTap JSON from the immutable report snapshot.
        anchor: Frontend-generated anchor payload.

    Returns:
        The validated anchor object, unchanged apart from already passing shape
        and content checks.

    Raises:
        ReportAnchorError: The anchor is malformed or no longer matches its
        stable block in the selected snapshot.
    """
    _validate_shape(anchor)
    block = document_blocks(description_json).get(anchor["block_id"])
    if block is None:
        raise ReportAnchorError("Anchored block is not available in this snapshot.")
    if block["type"] != anchor["block_type"]:
        raise ReportAnchorError("Anchored block type does not match this snapshot.")
    text = block["text"]
    start, end = anchor["start_offset"], anchor["end_offset"]
    if end > len(text) or text[start:end] != anchor["selected_text"]:
        raise ReportAnchorError("Anchored text does not match this snapshot.")
    expected_prefix = text[max(0, start - len(anchor["prefix"])) : start]
    expected_suffix = text[end : end + len(anchor["suffix"])]
    if anchor["prefix"] != expected_prefix or anchor["suffix"] != expected_suffix:
        raise ReportAnchorError("Anchor context does not match this snapshot.")
    return anchor


def resolve_anchor_text(text: str, anchor: dict) -> int | None:
    """Safely resolve an anchor inside one previously identified block.

    Args:
        text: Current plain text of the same stable block.
        anchor: Persisted report anchor.

    Returns:
        The current start index when exactly one safe match exists; ``None``
        when the anchor must be treated as stale. This function never searches
        outside the supplied block.
    """
    selected = anchor.get("selected_text", "")
    if not selected:
        return None

    start = anchor.get("start_offset")
    end = anchor.get("end_offset")
    if type(start) is int and type(end) is int and 0 <= start < end <= len(text):
        if text[start:end] == selected:
            prefix = anchor.get("prefix", "")
            suffix = anchor.get("suffix", "")
            if text[max(0, start - len(prefix)) : start] == prefix and text[end : end + len(suffix)] == suffix:
                return start

    contextual = f"{anchor.get('prefix', '')}{selected}{anchor.get('suffix', '')}"
    if contextual in text:
        return text.index(contextual) + len(anchor.get("prefix", ""))

    first = text.find(selected)
    if first >= 0 and text.find(selected, first + 1) < 0:
        return first
    return None
