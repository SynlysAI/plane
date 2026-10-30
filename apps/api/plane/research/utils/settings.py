# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Workspace-level research configuration.

The research application is installed with the backend. A workspace without a
``WorkspaceResearchSetting`` row defaults to disabled; provisioning a row does
not silently enable research. Workspace context activation remains the explicit
workspace-level switch.
"""

from plane.research.utils.config import (
    research_file_limits,
    research_gate_defaults,
    research_module_enabled,
    research_phase_zero_defaults,
    research_submodule_defaults,
)
from plane.research.utils.acl import visibility_breadth
from plane.utils.constants import DEFAULT_TIMEZONE

WEEKLY_DEFAULT_VISIBILITY = "WORKSPACE"
WEEKLY_CONFIDENTIAL_VISIBILITY = "UNIT"


def default_workspace_research_settings():
    limits = research_file_limits()
    return {
        "module_enabled": False,
        "purpose": "GENERAL",
        "main_pi": None,
        "required_reporter_categories": ["STUDENT", "POSTDOC"],
        "org_enabled": True,
        "report_enabled": True,
        "approval_enabled": True,
        "allow_multiple_projects": False,
        "default_report_visibility": "DIRECT_ADVISOR",
        "weekly_default_visibility": WEEKLY_DEFAULT_VISIBILITY,
        "monthly_default_visibility": None,
        "timezone": DEFAULT_TIMEZONE,
        "audit_retention_days": 0,
        **research_submodule_defaults(),
        **research_phase_zero_defaults(),
        **research_gate_defaults(),
        **limits,
    }


def get_workspace_research_settings(workspace):
    """Return the effective research settings for a workspace."""
    defaults = default_workspace_research_settings()
    try:
        from plane.db.models import WorkspaceResearchSetting
    except ImportError:  # pragma: no cover - model not shipped yet
        return defaults

    setting = WorkspaceResearchSetting.objects.filter(workspace=workspace).first()
    if setting is None:
        return defaults

    return {
        "module_enabled": bool(setting.module_enabled),
        "purpose": setting.purpose,
        "main_pi": setting.main_pi_id,
        "required_reporter_categories": setting.required_reporter_categories,
        "org_enabled": True,
        "report_enabled": True,
        "approval_enabled": True,
        "allow_multiple_projects": bool(setting.allow_multiple_projects),
        "default_report_visibility": setting.default_report_visibility,
        "weekly_default_visibility": setting.weekly_default_visibility,
        "monthly_default_visibility": setting.monthly_default_visibility,
        "timezone": setting.timezone or getattr(workspace, "timezone", None),
        "audit_retention_days": setting.audit_retention_days,
        "image_max_mb": setting.image_max_mb,
        "pdf_max_mb": setting.pdf_max_mb,
        "markdown_max_mb": setting.markdown_max_mb,
        "office_max_mb": setting.office_max_mb,
        "stage_enabled": bool(setting.stage_enabled),
        "experiment_enabled": bool(setting.experiment_enabled),
        "code_enabled": bool(setting.code_enabled),
        "integration_enabled": bool(setting.integration_enabled),
        "research_chain_enabled": True,
        "research_trace_enabled": bool(setting.research_trace_enabled),
        "research_account_link_enabled": bool(setting.research_account_link_enabled),
        "research_external_rag_enabled": bool(setting.research_external_rag_enabled),
        "research_ia_v2": True,
        "literature_min_included": setting.literature_min_included,
        "literature_max_entries": setting.literature_max_entries,
        "stage_min_reviewers": setting.stage_min_reviewers,
        "stage_pass_ratio": setting.stage_pass_ratio,
        "code_snapshot_max_mb": setting.code_snapshot_max_mb,
    }


def report_timezone_for(workspace, settings=None):
    """解析报告周期使用的有效时区。

    Args:
        workspace: 其科研设置可覆盖默认时区的工作区。
        settings: 调用方已加载时可复用的有效科研设置。

    Returns:
        用于计算报告周期的 IANA 时区名称。
    """
    settings = settings or get_workspace_research_settings(workspace)
    return settings.get("timezone") or getattr(workspace, "timezone", None) or DEFAULT_TIMEZONE


def workspace_research_enabled(workspace) -> bool:
    """Return whether the installed research app is enabled for a workspace."""
    if not research_module_enabled():
        return False
    config = get_workspace_research_settings(workspace)
    return config["purpose"] != "PI_PRIVATE" and bool(config["module_enabled"])


def workspace_research_sections(workspace):
    settings = get_workspace_research_settings(workspace)
    enabled = workspace_research_enabled(workspace)
    return {
        "org": bool(enabled and settings["org_enabled"]),
        "reports": bool(enabled and settings["report_enabled"]),
        "approvals": bool(enabled and settings["approval_enabled"]),
        "stages": enabled,
        "experiments": bool(enabled and settings["experiment_enabled"]),
        "code": bool(enabled and settings["code_enabled"]),
        "integrations": bool(enabled and settings["integration_enabled"]),
        "research_chain": bool(enabled and settings["research_chain_enabled"]),
    }


def weekly_confidential_paths(workspace, cache=None):
    """返回当前标记为周报保密的组织节点路径。

    Args:
        workspace: 工作区对象或 ID。
        cache: 可选的请求级字典，用于避免列表接口重复查询。

    Returns:
        保密节点的 materialised path 列表。
    """
    workspace_id = getattr(workspace, "id", workspace)
    cache_key = f"weekly-confidential-paths:{workspace_id}"
    if cache is not None and cache_key in cache:
        return cache[cache_key]

    try:
        from plane.db.models import OrgUnit
    except ImportError:  # pragma: no cover - model not shipped yet
        paths = []
    else:
        paths = list(
            OrgUnit.objects.filter(
                workspace_id=workspace_id,
                weekly_report_confidential=True,
                deleted_at__isnull=True,
            ).values_list("path", flat=True)
        )

    if cache is not None:
        cache[cache_key] = paths
    return paths


def org_unit_is_weekly_confidential(org_unit, workspace, cache=None):
    """判断组织节点是否位于任一周报保密子树。

    Args:
        org_unit: 待判断的组织节点对象；``None`` 表示报告没有组织归属。
        workspace: 工作区对象或 ID。
        cache: 可选的请求级字典，用于避免列表接口重复查询。

    Returns:
        节点是否需要套用周报保密规则。
    """
    if org_unit is None:
        return False
    workspace_id = getattr(workspace, "id", workspace)
    if str(getattr(org_unit, "workspace_id", workspace_id)) != str(workspace_id):
        return False

    unit_path = getattr(org_unit, "path", "") or ""
    if not unit_path:
        return False
    return any(unit_path.startswith(path) for path in weekly_confidential_paths(workspace_id, cache=cache))


def default_visibility_for(report_type, workspace, org_unit=None, cache=None):
    """解析报告类型的有效默认可见性。

    Args:
        report_type: 报告类型（WEEKLY 或 MONTHLY）。
        workspace: 工作区对象或 ID。
        org_unit: 报告所属组织节点；保密子树会收窄周报上限。
        cache: 可选的请求级字典，用于避免重复查询保密节点。

    Returns:
        该报告创建或修改可见性时可用的默认级别。
    """
    settings = get_workspace_research_settings(workspace)
    if report_type == "WEEKLY":
        configured = settings["weekly_default_visibility"] or WEEKLY_DEFAULT_VISIBILITY
        if org_unit_is_weekly_confidential(org_unit, workspace, cache=cache) and visibility_breadth(
            configured
        ) > visibility_breadth(WEEKLY_CONFIDENTIAL_VISIBILITY):
            return WEEKLY_CONFIDENTIAL_VISIBILITY
        return configured
    if report_type == "MONTHLY" and settings["monthly_default_visibility"]:
        return settings["monthly_default_visibility"]
    return settings["default_report_visibility"]
