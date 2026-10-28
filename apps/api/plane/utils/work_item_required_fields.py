# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Required module and label rules shared by work item APIs."""

from plane.db.models import IssueLabel, ModuleIssue

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
