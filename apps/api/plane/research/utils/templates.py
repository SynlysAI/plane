# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Stage material templates and variable resolution (P1-OPN-08)."""

import re

from plane.db.models import ReportTemplate

VARIABLE_PATTERN = re.compile(r"\{\{\s*([a-z_]+)\s*\}\}")
SECTION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_TEMPLATE_SECTIONS = 50


def validate_template_sections(value):
    """校验并规范化结构化模板章节配置。

    Args:
        value: API 或种子数据传入的 ``sections_json`` 对象。

    Returns:
        ``(规范化后的配置, 错误信息)``；错误信息为 ``None`` 表示校验通过。
    """
    if value in (None, ""):
        return {"version": 1, "guidance": "", "sections": []}, None
    if not isinstance(value, dict):
        return None, "sections_json 必须是对象。"

    version = value.get("version", 1)
    if version != 1:
        return None, "sections_json 仅支持 version 1。"

    guidance = str(value.get("guidance") or "").strip()
    if len(guidance) > 2000:
        return None, "模板整体说明不能超过 2000 字。"

    raw_sections = value.get("sections", [])
    if not isinstance(raw_sections, list):
        return None, "sections 必须是数组。"
    if len(raw_sections) > MAX_TEMPLATE_SECTIONS:
        return None, f"模板章节数量不能超过 {MAX_TEMPLATE_SECTIONS}。"

    normalized_sections = []
    seen_ids = set()
    for index, raw_section in enumerate(raw_sections, start=1):
        if not isinstance(raw_section, dict):
            return None, f"第 {index} 个章节必须是对象。"

        section_id = str(raw_section.get("id") or "").strip()
        if not SECTION_ID_PATTERN.fullmatch(section_id):
            return None, f"第 {index} 个章节 ID 仅支持字母、数字、下划线和连字符。"
        if section_id in seen_ids:
            return None, f"章节 ID 重复：{section_id}。"
        seen_ids.add(section_id)

        title = str(raw_section.get("title") or "").strip()
        if not title:
            return None, f"第 {index} 个章节标题不能为空。"
        if len(title) > 120:
            return None, f"第 {index} 个章节标题不能超过 120 字。"

        section_guidance = str(raw_section.get("guidance") or "").strip()
        if not section_guidance:
            return None, f"第 {index} 个章节说明不能为空。"
        if len(section_guidance) > 1000:
            return None, f"第 {index} 个章节说明不能超过 1000 字。"

        required = raw_section.get("required", False)
        if not isinstance(required, bool):
            return None, f"第 {index} 个章节的 required 必须是布尔值。"

        max_chars = raw_section.get("max_chars")
        if max_chars is not None:
            if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars <= 0:
                return None, f"第 {index} 个章节字数上限必须是正整数。"
            if max_chars > 10000:
                return None, f"第 {index} 个章节字数上限不能超过 10000。"

        section = {
            "id": section_id,
            "title": title,
            "guidance": section_guidance,
            "required": required,
        }
        if max_chars is not None:
            section["max_chars"] = max_chars
        normalized_sections.append(section)

    return {"version": 1, "guidance": guidance, "sections": normalized_sections}, None


def sections_to_content(sections_json):
    """将结构化章节配置转换为 Plane 编辑器可用的初始文档。

    Args:
        sections_json: 已通过 ``validate_template_sections`` 规范化的配置。

    Returns:
        TipTap ``doc`` JSON 对象。
    """
    config = sections_json or {}
    content = []
    guidance = str(config.get("guidance") or "").strip()
    if guidance:
        content.append(
            {
                "type": "blockquote",
                "content": [{"type": "paragraph", "content": [{"type": "text", "text": guidance}]}],
            }
        )

    for section in config.get("sections") or []:
        hints = [str(section["guidance"])]
        if section.get("max_chars"):
            hints.append(f"（{section['max_chars']} 字以内）")
        content.extend(
            [
                {
                    "type": "heading",
                    "attrs": {"level": 2, "id": section["id"]},
                    "content": [{"type": "text", "text": section["title"]}],
                },
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": "".join(hints)}],
                },
                {"type": "paragraph", "content": []},
            ]
        )

    return {"type": "doc", "content": content}


def template_target_key(scope, report_type="", stage="", material_type=""):
    """计算模板适用对象的稳定键。

    Args:
        scope: 模板范围。
        report_type: 周期报告类型。
        stage: 科研阶段。
        material_type: 阶段材料类型。

    Returns:
        用于默认模板与重名隔离的目标键。
    """
    scope = str(scope or ReportTemplate.Scope.REPORT).upper()
    if scope == ReportTemplate.Scope.REPORT:
        return f"REPORT:{str(report_type or 'WEEKLY').upper()}"
    if scope == ReportTemplate.Scope.STAGE_MATERIAL:
        return f"STAGE_MATERIAL:{str(stage or '').upper()}:{str(material_type or '').upper()}"
    return f"EXPERIMENT:{str(material_type or 'ALL').upper()}"


def resolve_variables(content_json, values):
    """Return ``(resolved, unresolved)`` for a template body.

    Unresolved variables are reported so the caller can refuse to write the
    material instead of storing a half rendered document.
    """
    unresolved = set()

    def walk(node):
        if isinstance(node, dict):
            return {key: walk(value) for key, value in node.items()}
        if isinstance(node, list):
            return [walk(item) for item in node]
        if isinstance(node, str):

            def replace(match):
                name = match.group(1)
                if name in values and values[name] not in (None, ""):
                    return str(values[name])
                unresolved.add(name)
                return match.group(0)

            return VARIABLE_PATTERN.sub(replace, node)
        return node

    resolved = walk(content_json or {})
    return resolved, sorted(unresolved)


def template_values(*, user=None, project=None, stage="", org_unit="", period=""):
    return {
        "user": getattr(user, "display_name", "") if user is not None else "",
        "project": getattr(project, "name", "") if project is not None else "",
        "stage": stage,
        "period": period,
        "advisor": "",
        "org_unit": org_unit,
    }


def find_material_template(workspace, stage, material_type):
    """Return the active template for one stage material target."""
    target_key = template_target_key(
        ReportTemplate.Scope.STAGE_MATERIAL,
        stage=stage,
        material_type=material_type,
    )
    return (
        ReportTemplate.objects.filter(
            workspace=workspace,
            scope=ReportTemplate.Scope.STAGE_MATERIAL,
            target_key=target_key,
            is_active=True,
            deleted_at__isnull=True,
        )
        .order_by("-is_default", "name")
        .first()
    )


def find_report_template(workspace, report_type):
    """Return the active default template for a periodic report type."""
    target_key = template_target_key(ReportTemplate.Scope.REPORT, report_type=report_type)
    return (
        ReportTemplate.objects.filter(
            workspace=workspace,
            scope=ReportTemplate.Scope.REPORT,
            target_key=target_key,
            is_active=True,
            is_default=True,
            deleted_at__isnull=True,
        )
        .order_by("-is_default", "name")
        .first()
    )
