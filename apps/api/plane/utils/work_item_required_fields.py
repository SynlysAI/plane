# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Required module and label rules shared by work item APIs."""

from plane.db.models import Issue, IssueLabel, Label, Module, ModuleIssue

MODULE_REQUIRED_ERROR = "模块（财务报销科目）为必选项。"
LABEL_REQUIRED_ERROR = "标签（小组）为必选项。"


def active_issue_module_ids(issue) -> list:
    """Return active and non-archived module IDs attached to a work item.

    Args:
        issue: The work item whose module relations should be read.

    Returns:
        A list of module UUIDs.
    """
    return list(
        ModuleIssue.objects.filter(
            issue=issue,
            deleted_at__isnull=True,
            module__deleted_at__isnull=True,
            module__archived_at__isnull=True,
        ).values_list("module_id", flat=True)
    )


def active_issue_label_ids(issue) -> list:
    """Return active label IDs attached to a work item.

    Args:
        issue: The work item whose label relations should be read.

    Returns:
        A list of label UUIDs.
    """
    return list(
        IssueLabel.objects.filter(
            issue=issue,
            deleted_at__isnull=True,
            label__deleted_at__isnull=True,
        ).values_list("label_id", flat=True)
    )


def validate_required_issue_relations(
    project,
    *,
    module_ids=None,
    module_ids_supplied=False,
    label_ids=None,
    label_ids_supplied=False,
    instance=None,
    is_draft=False,
) -> dict[str, list[str]]:
    """Validate required work-item relations for an administrative project.

    Args:
        project: The project carrying the required-field configuration.
        module_ids: Requested module IDs after project-scope validation.
        module_ids_supplied: Whether the request explicitly supplied module IDs.
        label_ids: Requested label IDs after project-scope validation.
        label_ids_supplied: Whether the request explicitly supplied label IDs.
        instance: Existing work item for partial updates, if any.
        is_draft: Whether the resulting work item will remain a draft.

    Returns:
        A DRF-compatible field-to-error mapping; an empty mapping means valid.
    """
    errors: dict[str, list[str]] = {}
    if is_draft:
        return errors

    if project.is_module_required:
        modules = module_ids if module_ids_supplied else active_issue_module_ids(instance) if instance else []
        if not modules:
            errors["module_ids"] = [MODULE_REQUIRED_ERROR]

    if project.is_label_required:
        labels = label_ids if label_ids_supplied else active_issue_label_ids(instance) if instance else []
        if not labels:
            errors["label_ids"] = [LABEL_REQUIRED_ERROR]

    return errors


def module_removal_would_violate_requirement(project, current_module_ids, removed_module_ids) -> bool:
    """Check whether removing modules would leave a required work item empty.

    Args:
        project: The project carrying the required-field configuration.
        current_module_ids: Active module IDs before the requested operation.
        removed_module_ids: Module IDs requested for removal.

    Returns:
        True when the operation must be rejected.
    """
    if not project.is_module_required:
        return False
    remaining = {str(module_id) for module_id in current_module_ids} - {
        str(module_id) for module_id in removed_module_ids
    }
    return not remaining


def required_module_operation_error(project, module) -> str | None:
    """Return the reason a module operation would break a required-field rule.

    Args:
        project: The project carrying the required-field configuration.
        module: The module being deleted or archived.

    Returns:
        An error message, or None when the operation is allowed.
    """
    if not project.is_module_required:
        return None
    if Issue.objects.filter(
        issue_module__module=module,
        issue_module__deleted_at__isnull=True,
        is_draft=False,
    ).exists():
        return "模块仍被正式工作项使用，不能删除或归档。"
    if not Module.objects.filter(project=project, archived_at__isnull=True).exclude(pk=module.pk).exists():
        return "必填模块至少需要保留一个可选项。"
    return None


def required_label_delete_error(project, label) -> str | None:
    """Return the reason deleting a label would break a required-field rule.

    Args:
        project: The project carrying the required-field configuration.
        label: The label being deleted.

    Returns:
        An error message, or None when deletion is allowed.
    """
    if not project.is_label_required:
        return None
    if Issue.objects.filter(
        labels=label,
        label_issue__deleted_at__isnull=True,
        is_draft=False,
    ).exists():
        return "标签仍被正式工作项使用，不能删除。"
    if not Label.objects.filter(project=project).exclude(pk=label.pk).exists():
        return "必填标签至少需要保留一个可选项。"
    return None
