"""One restricted Markdown AST produces editor JSON, safe HTML and Page text."""

import hashlib
import html
import json
import re
import unicodedata
from urllib.parse import urlsplit

from markdown_it import MarkdownIt

from plane.research.services.weekly_report_errors import WeeklyReportError
from plane.utils.content_validator import validate_html_content
from plane.utils.html_processor import strip_tags

BODY_FIELDS = ("description_json", "description_html", "description_stripped")
FALLBACK = "## 本周完成\n\n## 问题与风险\n\n## 下周计划"


def canonical(value):
    return unicodedata.normalize(
        "NFC", json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    )


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def body_hash(value):
    return digest({field: value[field] for field in BODY_FIELDS})


def invalid(message="Unsupported Markdown, HTML, image or resource reference."):
    raise WeeklyReportError("invalid_markdown", message)


def inline_nodes(tokens):
    result, marks = [], []
    for token in tokens or []:
        kind = token.type
        if kind in {"strong_open", "em_open", "link_open"}:
            mark = {"type": {"strong_open": "bold", "em_open": "italic", "link_open": "link"}[kind]}
            if kind == "link_open":
                href = token.attrGet("href") or ""
                parsed = urlsplit(href)
                if parsed.scheme not in {"http", "https", "mailto"} or any(ord(c) < 32 for c in href):
                    invalid("Links must use HTTP(S) or mailto; resource paths are not accepted.")
                if parsed.scheme in {"http", "https"} and (not parsed.hostname or parsed.username or parsed.password):
                    invalid("Invalid link.")
                if "/api/" in parsed.path or "/uploads/" in parsed.path:
                    invalid("Resource links require separate authorization and are not accepted in report Markdown.")
                mark["attrs"] = {"href": href}
            marks.append(mark)
        elif kind in {"strong_close", "em_close", "link_close"}:
            if not marks:
                invalid()
            marks.pop()
        elif kind in {"text", "code_inline", "softbreak"}:
            text = "\n" if kind == "softbreak" else token.content
            if not text:
                continue
            node = {"type": "text", "text": text}
            active = marks + ([{"type": "code"}] if kind == "code_inline" else [])
            if active:
                node["marks"] = list(active)
            result.append(node)
        elif kind == "hardbreak":
            result.append({"type": "hardBreak"})
        else:
            invalid()
    return result


def markdown_doc(markdown):
    tokens = MarkdownIt("commonmark", {"html": True, "maxNesting": 20}).parse(markdown)
    doc = {"type": "doc", "content": []}
    stack = [doc]
    blocks = {
        "paragraph": "paragraph",
        "heading": "heading",
        "bullet_list": "bulletList",
        "ordered_list": "orderedList",
        "list_item": "listItem",
        "blockquote": "blockquote",
    }
    for token in tokens:
        if token.type.endswith("_open"):
            name = token.type.removesuffix("_open")
            if name not in blocks:
                invalid()
            node = {"type": blocks[name], "content": []}
            if name == "heading":
                level = int(token.tag[1:])
                if level > 3:
                    invalid("Only headings h1-h3 are supported.")
                node["attrs"] = {"level": level}
            if name == "ordered_list":
                node["attrs"] = {"start": int(token.attrGet("start") or 1)}
            stack[-1]["content"].append(node)
            stack.append(node)
        elif token.type.endswith("_close"):
            stack.pop()
        elif token.type == "inline":
            if re.search(r"(?m)^\s*\|.*\|\s*$", token.content) or "~~" in token.content:
                invalid("Tables and strikethrough are outside the supported Markdown subset.")
            stack[-1]["content"].extend(inline_nodes(token.children))
        elif token.type in {"fence", "code_block"}:
            if token.info and not re.fullmatch(r"[A-Za-z0-9_+.-]{1,32}", token.info):
                invalid("Invalid code language.")
            node = {"type": "codeBlock", "content": []}
            if token.info:
                node["attrs"] = {"language": token.info}
            if token.content:
                node["content"] = [{"type": "text", "text": token.content.removesuffix("\n")}]
            stack[-1]["content"].append(node)
        elif token.type == "hr":
            stack[-1]["content"].append({"type": "horizontalRule"})
        else:
            invalid()
        if len(stack) > 16:
            raise WeeklyReportError("body_too_large", "Document nesting exceeds 16.")
    return doc


def render(node, depth=0):
    if depth > 16 or not isinstance(node, dict):
        raise WeeklyReportError("body_too_large", "Document structure exceeds its limit.")
    kind = node.get("type")
    if kind == "text":
        value = html.escape(node.get("text") or "")
        for mark in node.get("marks") or []:
            tag = {"bold": "strong", "italic": "em", "code": "code", "link": "a"}.get(mark["type"])
            if not tag:
                invalid("The selected template uses an unsupported text mark.")
            attrs = ""
            if tag == "a":
                href = (mark.get("attrs") or {}).get("href") or ""
                if urlsplit(href).scheme not in {"https", "http", "mailto"}:
                    invalid("Unsafe template link.")
                attrs = f' href="{html.escape(href, quote=True)}"'
            value = f"<{tag}{attrs}>{value}</{tag}>"
        return value
    if kind in {"hardBreak", "horizontalRule"}:
        return "<br>" if kind == "hardBreak" else "<hr>"
    tags = {
        "doc": "",
        "paragraph": "p",
        "heading": "h2",
        "bulletList": "ul",
        "orderedList": "ol",
        "listItem": "li",
        "blockquote": "blockquote",
        "codeBlock": "pre",
    }
    if kind not in tags:
        invalid("The selected template uses an unsupported document node.")
    tag = tags[kind]
    attrs = node.get("attrs") or {}
    if kind == "heading":
        level = attrs.get("level", 2)
        if level not in (1, 2, 3):
            invalid("Only headings h1-h3 are supported.")
        tag = f"h{level}"
    children = "".join(render(child, depth + 1) for child in node.get("content", []))
    if kind == "codeBlock":
        children = f"<code>{children}</code>"
    if not tag:
        return children or "<p></p>"
    extra = f' start="{int(attrs.get("start", 1))}"' if kind == "orderedList" else ""
    return f"<{tag}{extra}>{children}</{tag}>"


def document_body(doc):
    serialized = canonical(doc)

    # Count actual editor nodes, including inline text and marks; bound recursion before rendering.
    def count(node, depth=0):
        if depth > 16:
            raise WeeklyReportError("body_too_large", "Document nesting exceeds 16.")
        return 1 + sum(count(child, depth + 1) for child in node.get("content", []))

    if len(serialized.encode()) > 512 * 1024 or count(doc) > 2000:
        raise WeeklyReportError("body_too_large", "Document exceeds 512 KiB or 2000 nodes.")
    valid, _, safe = validate_html_content(render(doc))
    if not valid:
        invalid("Unable to validate generated HTML.")
    value = {"description_json": doc, "description_html": safe, "description_stripped": strip_tags(safe)}
    if len(canonical(value).encode()) > 512 * 1024:
        raise WeeklyReportError("body_too_large", "Converted body exceeds 512 KiB.")
    return value


def normalize_body(markdown):
    markdown = unicodedata.normalize("NFC", markdown.replace("\r\n", "\n").replace("\r", "\n"))
    if not 1 <= len(markdown) <= 50000 or not markdown.strip() or "\x00" in markdown:
        raise WeeklyReportError("body_too_large", "Body must contain 1-50000 characters.")
    if re.search(r"\]\(\s*(?:javascript|data|file|vbscript):", markdown, re.I):
        invalid("Unsafe link scheme.")
    value = document_body(markdown_doc(markdown))
    return {"body_markdown": markdown, **value, "body_hash": body_hash(value)}
