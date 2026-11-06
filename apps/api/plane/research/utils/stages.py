# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Shared helpers for the stage workflow (P1-A1).

Stage instances and stage materials reuse the single ACL entry point: this
module only projects them into ``ResearchResource`` objects so
``check_access`` stays the only place that answers "may this actor do this".
"""

from plane.db.models import ResearchProjectProfile, ResearchStageInstance
from plane.research.utils.acl import ResearchResource
from plane.research.utils.settings import get_workspace_research_settings

STAGE_RESOURCE_KIND = "stage_instance"
MATERIAL_RESOURCE_KIND = "stage_material"


def default_stage_visibility(workspace):
    """Stage objects inherit the workspace research default visibility."""
    return get_workspace_research_settings(workspace).get("default_report_visibility") or "DIRECT_ADVISOR"


def stage_queryset(workspace):
    return (
        ResearchStageInstance.objects.filter(workspace=workspace, deleted_at__isnull=True)
        .select_related("project", "org_unit")
        .prefetch_related("transitions")
        .order_by("project_id", "sort_order")
    )


def project_owner_id(project_id, workspace_id):
    """Owner of the research project, used as the ACL subject for stages."""
    profile = (
        ResearchProjectProfile.objects.filter(project_id=project_id, workspace_id=workspace_id)
        .values_list("owner_id", flat=True)
        .first()
    )
    return profile


def stage_resource(
    instance, *, owner_id=None, visibility=None, with_reviewers=False, reviewer_ids=None
) -> ResearchResource:
    """将阶段及可选的批量预取评审人转换为权限资源。

    Args:
        instance: 当前阶段实例。
        owner_id: 可选的已解析课题所有者 ID。
        visibility: 可选的已解析阶段可见范围。
        with_reviewers: 未提供评审人列表时是否查询有效分配。
        reviewer_ids: 已批量加载的评审人 ID；None 表示未预取。

    Returns:
        保持原有可见性语义的阶段权限资源。
    """
    profile = getattr(instance.project, "research_profile", None)
    if owner_id is not None:
        owner = owner_id
    else:
        owner = (
            profile.owner_id
            if profile and profile.deleted_at is None and profile.workspace_id == instance.workspace_id
            else None
        )
    if reviewer_ids is not None:
        reviewer_ids = [str(reviewer_id) for reviewer_id in reviewer_ids]
    elif with_reviewers:
        from plane.research.services.review_rules import effective_assignments

        reviewer_ids = [str(assignment.reviewer_id) for assignment in effective_assignments(instance)]
    else:
        reviewer_ids = []
    return ResearchResource(
        kind=STAGE_RESOURCE_KIND,
        workspace_id=instance.workspace_id,
        owner_id=owner,
        org_unit_id=instance.org_unit_id,
        visibility=visibility or default_stage_visibility(instance.workspace),
        state=instance.status,
        # Stage metadata itself is not a private note. Draft protection applies
        # to each material Page through ``material_resource`` and Page guards.
        is_draft=False,
        reviewer_ids=reviewer_ids,
        project_id=instance.project_id,
        is_team_content=bool(profile and profile.research_type == ResearchProjectProfile.ResearchType.RESEARCH_PROJECT),
    )


def material_resource(
    material,
    *,
    stage=None,
    owner_id=None,
    visibility=None,
    with_reviewers=False,
) -> ResearchResource:
    stage = stage or material.stage_instance
    owner = owner_id or project_owner_id(stage.project_id, stage.workspace_id)
    reviewer_ids = []
    if with_reviewers:
        from plane.research.services.review_rules import effective_assignments

        reviewer_ids = [str(assignment.reviewer_id) for assignment in effective_assignments(stage)]
    profile = getattr(stage.project, "research_profile", None)
    return ResearchResource(
        kind=MATERIAL_RESOURCE_KIND,
        workspace_id=stage.workspace_id,
        owner_id=material.owner_id or owner,
        org_unit_id=stage.org_unit_id,
        visibility=visibility or material.visibility,
        state=material.status,
        # A draft with a submitted version has a private live revision and a
        # formal snapshot for authorised readers. A never-submitted draft has
        # no audience beyond its author.
        is_draft=material.status == "DRAFT" and not _has_submitted_material_version(material),
        reviewer_ids=reviewer_ids,
        project_id=stage.project_id,
        is_team_content=bool(profile and profile.research_type == ResearchProjectProfile.ResearchType.RESEARCH_PROJECT),
    )


def _has_submitted_material_version(material):
    prefetched = getattr(material, "_prefetched_objects_cache", {}).get("versions")
    versions = prefetched if prefetched is not None else material.versions.all()
    return any(version.snapshot.get("status") == "SUBMITTED" for version in versions)
