"""Aggregate real business mutations into the workspace home activity feed."""

import json
from datetime import datetime, timedelta

from django.core import signing
from django.db.models import Case, CharField, DateTimeField, F, Q, Value, When
from django.db.models.functions import Cast, Concat
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.user import UserLiteSerializer
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    HomeActivityEvent,
    ApprovalRequest,
    Issue,
    IssueActivity,
    IssueComment,
    PeriodicReport,
    ReportAttachment,
    Project,
    ProjectMember,
    ResearchAuditEvent,
    ResearchChain,
    ResearchChainNodeTask,
    ResearchChainStage,
    ResearchChainStageMaterialItem,
    ResearchPaperReview,
    ResearchPaperReviewVersion,
    ResearchStageInstance,
    StageReviewerAssignment,
    StageReview,
    ExperimentRecord,
    ExperimentAmendment,
    LiteratureEntry,
    ResearchOutcome,
    ResearchProjectProfile,
    User,
    Workspace,
)
from plane.research.utils.config import research_module_enabled
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.reports import report_resource
from plane.research.utils.settings import workspace_research_enabled
from plane.utils.administrative_projects import restrict_administrative_project_visibility

RESEARCH_HOME_RESOURCE_TYPES = {
    "report",
    "report_comment",
    "report_comment_feedback",
    "report_attachment",
    "research_project",
    "research_chain",
    "research_chain_node_task",
    "research_chain_stage",
    "stage_material",
    "research_chain_stage_material",
    "literature_entry",
    "experiment_record",
    "experiment_amendment",
    "research_outcome",
    "approval_request",
    "stage_instance",
    "stage_review_assignment",
    "stage_review",
    "research_paper_review",
    "research_paper_review_version",
}
ISSUE_ACTIVITY_FIELDS = {
    None,
    "name",
    "parent",
    "priority",
    "state",
    "description_html",
    "target_date",
    "start_date",
    "labels",
    "assignees",
    "estimate",
    "archive_at",
    "closed_to",
}
MAX_WINDOW = 500
CURSOR_SALT = "workspace.home-activities.cursor.v1"
CURSOR_SOURCE_BATCH_SIZE = 100
CURSOR_MAX_AGE_SECONDS = 24 * 60 * 60


def _actor_detail(actor):
    """Serialize an actor without exposing email or account metadata."""
    return UserLiteSerializer(actor).data if actor else None


def _project_detail(project):
    """Return the minimum project context needed by a feed row."""
    if project is None:
        return None
    return {"id": str(project.id), "name": project.name, "identifier": project.identifier}


def _visible_project_ids(user, workspace):
    """Resolve projects visible to the requesting user in this workspace.

    Reuse the authoritative project-domain ACL so the feed can never expose a
    project the user cannot already see through project, research, or
    administrative access rules.
    """
    projects = Project.objects.filter(workspace=workspace, archived_at__isnull=True)
    return set(restrict_administrative_project_visibility(projects, user, workspace.slug).values_list("id", flat=True))


def _visible_issues(user, workspace, project_ids):
    """Return issue ids visible under the existing restricted-guest rule."""
    issues = Issue.issue_objects.filter(workspace=workspace, project_id__in=project_ids)
    restricted_projects = ProjectMember.objects.filter(
        workspace=workspace,
        member=user,
        is_active=True,
        role=5,
        project__guest_view_all_features=False,
    ).values("project_id")
    return issues.exclude(Q(project_id__in=restricted_projects) & ~Q(created_by=user))


def _issue_link(workspace_slug, activity):
    issue = activity.issue
    if issue is None:
        return None
    return f"/{workspace_slug}/browse/{issue.project.identifier}-{issue.sequence_id}/"


def _issue_activity_rows(workspace_slug, activities):
    """Convert meaningful work-item mutations into feed rows."""
    rows = []
    for activity in activities:
        issue = activity.issue
        if issue is None:
            continue
        rows.append(
            {
                "id": f"issue-activity:{activity.id}",
                "source": "work_item",
                "actor": _actor_detail(activity.actor),
                "action": activity.verb or "updated",
                "entity_type": "work_item",
                "entity_id": str(issue.id),
                "entity_name": issue.name,
                "project": _project_detail(activity.project),
                "url": _issue_link(workspace_slug, activity),
                "occurred_at": activity.created_at,
                "changes": [
                    {
                        "field": activity.field,
                        "old_value": activity.old_value,
                        "new_value": activity.new_value,
                    }
                ]
                if activity.field
                else [],
                "summary": activity.comment or "",
            }
        )
    return rows


def _issue_comment_rows(workspace_slug, comments):
    """Convert non-empty comments into feed rows."""
    rows = []
    for comment in comments:
        if not (comment.comment_stripped or "").strip():
            continue
        issue = comment.issue
        if issue is None:
            continue
        edited = comment.edited_at is not None and comment.edited_at > comment.created_at
        rows.append(
            {
                "id": f"issue-comment:{comment.id}",
                "source": "comment",
                "actor": _actor_detail(comment.actor),
                "action": "comment_updated" if edited else "commented",
                "entity_type": "work_item",
                "entity_id": str(issue.id),
                "entity_name": issue.name,
                "project": _project_detail(comment.project),
                "url": f"/{workspace_slug}/browse/{issue.project.identifier}-{issue.sequence_id}/",
                "occurred_at": comment.edited_at if edited else comment.created_at,
                "changes": [
                    {
                        "field": "comment",
                        "new_value": comment.comment_stripped[:240],
                    }
                ],
                "summary": comment.comment_stripped[:240],
            }
        )
    return rows


def _project_event_rows(workspace_slug, events, projects):
    """Convert project business events into feed rows."""
    rows = []
    for event in events:
        rows.append(
            {
                "id": f"project-event:{event.id}",
                "source": "project",
                "actor": _actor_detail(event.actor),
                "action": event.action,
                "entity_type": "project",
                "entity_id": str(event.entity_id),
                "entity_name": event.entity_name,
                "project": _project_detail(projects.get(event.project_id)),
                "url": f"/{workspace_slug}/projects/{event.entity_id}/issues",
                "occurred_at": event.occurred_at,
                "changes": event.changes if isinstance(event.changes, list) else [],
                "summary": event.summary,
            }
        )
    return rows


def _research_contexts(workspace, audits):
    """Resolve project, name and link context for research audit resources."""
    report_ids = set()
    profile_ids = set()
    chain_ids = set()
    task_ids = set()
    stage_ids = set()
    material_ids = set()
    literature_ids = set()
    experiment_ids = set()
    experiment_amendment_ids = set()
    outcome_ids = set()
    approval_ids = set()
    report_attachment_ids = set()
    stage_instance_ids = set()
    stage_review_assignment_ids = set()
    stage_review_ids = set()
    paper_review_ids = set()
    paper_review_version_ids = set()
    user_ids = set()
    resource_ids = set()

    user_fields = {"assignee", "member", "reviewer", "approver", "owner", "requester"}

    for audit in audits:
        metadata = audit.metadata if isinstance(audit.metadata, dict) else {}
        if audit.resource_type in {"report", "report_comment", "report_comment_feedback"}:
            report_ids.add(audit.resource_id)
            if metadata.get("report"):
                report_ids.add(_uuid_or_none(metadata.get("report")))
        elif audit.resource_type == "report_attachment":
            report_attachment_ids.add(audit.resource_id)
        elif audit.resource_type == "research_project":
            profile_ids.add(audit.resource_id)

        elif audit.resource_type == "research_chain":
            chain_ids.add(audit.resource_id)
        elif audit.resource_type == "research_chain_node_task":
            task_ids.add(audit.resource_id)
        elif audit.resource_type == "research_chain_stage":
            stage_ids.add(audit.resource_id)
        elif audit.resource_type == "stage_material":
            material_ids.add(audit.resource_id)
        elif audit.resource_type == "research_chain_stage_material":
            material_ids.add(audit.resource_id)
        elif audit.resource_type == "literature_entry":
            literature_ids.add(audit.resource_id)
        elif audit.resource_type == "experiment_record":
            experiment_ids.add(audit.resource_id)
        elif audit.resource_type == "experiment_amendment":
            experiment_amendment_ids.add(audit.resource_id)
        elif audit.resource_type == "research_outcome":
            outcome_ids.add(audit.resource_id)
        elif audit.resource_type == "approval_request":
            approval_ids.add(audit.resource_id)
        elif audit.resource_type == "stage_instance":
            stage_instance_ids.add(audit.resource_id)
        elif audit.resource_type == "stage_review_assignment":
            stage_review_assignment_ids.add(audit.resource_id)
            # Some automatic reviewer assignment records use the stage
            # instance id as their resource id. Keep both lookup paths.
            stage_instance_ids.add(audit.resource_id)
        elif audit.resource_type == "stage_review":
            stage_review_ids.add(audit.resource_id)
        elif audit.resource_type == "research_paper_review":
            paper_review_ids.add(audit.resource_id)
        elif audit.resource_type == "research_paper_review_version":
            paper_review_version_ids.add(audit.resource_id)

        for key in (
            "member",
            "assignee",
            "previous_assignee",
            "reviewer",
            "approver",
            "requester",
            "owner",
            "owner_id",
            "final_reviewer_id",
        ):
            user_id = _uuid_or_none(metadata.get(key))
            if user_id is not None:
                user_ids.add(user_id)
        for key in ("added", "removed", "reviewers", "approvers"):
            values = metadata.get(key)
            if isinstance(values, list):
                user_ids.update(
                    user_id for user_id in (_uuid_or_none(value) for value in values) if user_id is not None
                )
        root_resource_id = _uuid_or_none(metadata.get("resource_id"))
        if root_resource_id is not None:
            resource_ids.add(root_resource_id)
        raw_changes = metadata.get("changes")
        if isinstance(raw_changes, list):
            change_items = [item for item in raw_changes if isinstance(item, dict)]
        elif isinstance(raw_changes, dict):
            # Preserve the map key as the field name so user/resource IDs in
            # ``{"assignee": {"from": ..., "to": ...}}`` remain resolvable.
            change_items = []
            for field, values in raw_changes.items():
                if isinstance(values, dict):
                    change_items.append({**values, "field": field})
                else:
                    change_items.append({"field": field, "new_value": values})
        else:
            change_items = []
        for change in change_items:
            if not isinstance(change, dict):
                continue
            field = str(change.get("field") or "")
            if field in user_fields:
                for key in ("old_value", "new_value", "from", "to"):
                    user_id = _uuid_or_none(change.get(key))
                    if user_id is not None:
                        user_ids.add(user_id)
            if field == "resource_id":
                for key in ("old_value", "new_value", "from", "to"):
                    resource_id = _uuid_or_none(change.get(key))
                    if resource_id is not None:
                        resource_ids.add(resource_id)

    reports = {
        obj.id: obj
        for obj in PeriodicReport.all_objects.filter(
            workspace=workspace,
            id__in=_clean_ids(report_ids | resource_ids),
        )
        .select_related("project", "org_unit")
        .prefetch_related("access_grants")
    }
    profiles = {
        obj.id: obj
        for obj in ResearchProjectProfile.all_objects.filter(workspace=workspace, id__in=_clean_ids(profile_ids))
        .select_related("project", "project__research_chain")
        .only(
            "id",
            "project_id",
            "project__id",
            "project__name",
            "project__identifier",
            "project__research_chain__id",
        )
    }
    chains = {
        obj.id: obj
        for obj in ResearchChain.all_objects.filter(workspace=workspace, id__in=_clean_ids(chain_ids))
        .select_related("project")
        .only("id", "project_id", "project__id", "project__name", "project__identifier")
    }
    tasks = {
        obj.id: obj
        for obj in ResearchChainNodeTask.all_objects.filter(workspace=workspace, id__in=_clean_ids(task_ids))
        .select_related("chain__project", "node")
        .only(
            "id",
            "title",
            "chain_id",
            "node_id",
            "chain__project_id",
            "chain__project__id",
            "chain__project__name",
            "chain__project__identifier",
        )
    }
    stages = {
        obj.id: obj
        for obj in ResearchChainStage.all_objects.filter(workspace=workspace, id__in=_clean_ids(stage_ids))
        .select_related("chain__project")
        .only(
            "id",
            "stage_code",
            "chain_id",
            "chain__project_id",
            "chain__project__id",
            "chain__project__name",
            "chain__project__identifier",
        )
    }
    materials = {
        obj.id: obj
        for obj in ResearchChainStageMaterialItem.all_objects.filter(
            stage__chain__workspace=workspace,
            id__in=_clean_ids(material_ids | resource_ids),
        )
        .select_related("stage__chain__project")
        .only(
            "id",
            "title",
            "stage_id",
            "stage__id",
            "stage__chain_id",
            "stage__chain__project_id",
            "stage__chain__project__id",
            "stage__chain__project__name",
            "stage__chain__project__identifier",
        )
    }
    literature = {
        obj.id: obj
        for obj in LiteratureEntry.all_objects.filter(workspace=workspace, id__in=_clean_ids(literature_ids))
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
    }
    experiments = {
        obj.id: obj
        for obj in ExperimentRecord.all_objects.filter(workspace=workspace, id__in=_clean_ids(experiment_ids))
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
    }
    experiment_amendments = {
        obj.id: obj
        for obj in ExperimentAmendment.all_objects.filter(
            record__workspace=workspace,
            id__in=_clean_ids(experiment_amendment_ids),
        )
        .select_related("record__project")
        .only(
            "id",
            "record_id",
            "record__id",
            "record__title",
            "record__sequence_no",
            "record__project_id",
            "record__project__id",
            "record__project__name",
            "record__project__identifier",
            "status",
        )
    }
    outcomes = {
        obj.id: obj
        for obj in ResearchOutcome.all_objects.filter(
            workspace=workspace,
            id__in=_clean_ids(outcome_ids | resource_ids),
        )
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
    }
    approvals = {
        obj.id: obj
        for obj in ApprovalRequest.all_objects.filter(id__in=_clean_ids(approval_ids))
        .select_related("issue__project")
        .only(
            "id",
            "issue_id",
            "issue__id",
            "issue__name",
            "issue__sequence_id",
            "issue__project_id",
            "issue__project__id",
            "issue__project__name",
            "issue__project__identifier",
        )
    }
    report_attachments = {
        obj.id: obj
        for obj in ReportAttachment.all_objects.filter(id__in=_clean_ids(report_attachment_ids))
        .select_related("report__project")
        .only(
            "id",
            "file_name",
            "report_id",
            "report__id",
            "report__report_type",
            "report__period_key",
            "report__project_id",
            "report__project__id",
            "report__project__name",
            "report__project__identifier",
        )
    }
    stage_instances = {
        obj.id: obj
        for obj in ResearchStageInstance.all_objects.filter(id__in=_clean_ids(stage_instance_ids))
        .select_related("project")
        .only("id", "stage", "project_id", "project__id", "project__name", "project__identifier")
    }
    stage_assignments = {
        obj.id: obj
        for obj in StageReviewerAssignment.all_objects.filter(id__in=_clean_ids(stage_review_assignment_ids))
        .select_related("stage_instance__project")
        .only(
            "id",
            "reviewer_role",
            "stage_instance_id",
            "stage_instance__id",
            "stage_instance__stage",
            "stage_instance__project_id",
            "stage_instance__project__id",
            "stage_instance__project__name",
            "stage_instance__project__identifier",
        )
    }
    stage_reviews = {
        obj.id: obj
        for obj in StageReview.all_objects.filter(id__in=_clean_ids(stage_review_ids))
        .select_related("stage_instance__project")
        .only(
            "id",
            "reviewer_role",
            "recommendation",
            "stage_instance_id",
            "stage_instance__id",
            "stage_instance__stage",
            "stage_instance__project_id",
            "stage_instance__project__id",
            "stage_instance__project__name",
            "stage_instance__project__identifier",
        )
    }
    paper_reviews = {
        obj.id: obj
        for obj in ResearchPaperReview.all_objects.filter(
            workspace=workspace,
            id__in=_clean_ids(paper_review_ids),
        )
        .select_related("chain__project", "node", "outcome")
        .only(
            "id",
            "chain_id",
            "node_id",
            "node__title",
            "outcome_id",
            "outcome__title",
            "chain__project_id",
            "chain__project__id",
            "chain__project__name",
            "chain__project__identifier",
        )
    }
    paper_review_versions = {
        obj.id: obj
        for obj in ResearchPaperReviewVersion.objects.filter(
            review__workspace=workspace,
            id__in=_clean_ids(paper_review_version_ids),
        )
        .select_related("review__chain__project", "review__node", "review__outcome")
        .only(
            "id",
            "version_no",
            "file_name",
            "review_id",
            "review__chain_id",
            "review__node_id",
            "review__node__title",
            "review__outcome_id",
            "review__outcome__title",
            "review__chain__project_id",
            "review__chain__project__id",
            "review__chain__project__name",
            "review__chain__project__identifier",
        )
    }
    users = {
        obj.id: obj
        for obj in User.objects.filter(id__in=_clean_ids(user_ids)).only(
            "id", "display_name", "first_name", "last_name", "email"
        )
    }
    return {
        "report": reports,
        "profile": profiles,
        "chain": chains,
        "task": tasks,
        "stage": stages,
        "material": materials,
        "literature": literature,
        "experiment": experiments,
        "experiment_amendment": experiment_amendments,
        "outcome": outcomes,
        "approval": approvals,
        "report_attachment": report_attachments,
        "stage_instance": stage_instances,
        "stage_review_assignment": stage_assignments,
        "stage_review": stage_reviews,
        "paper_review": paper_reviews,
        "paper_review_version": paper_review_versions,
        "users": users,
        "resource_names": {
            **{
                obj.id: f"{obj.get_report_type_display()} {obj.period_key}"
                for obj in reports.values()
            },
            **{obj.id: obj.title for obj in materials.values()},
            **{obj.id: obj.title for obj in outcomes.values()},
            **{obj.id: obj.title for obj in literature.values()},
            **{obj.id: obj.title for obj in experiments.values()},
            **{
                obj.id: f"实验 #{obj.record.sequence_no} {obj.record.title}"
                for obj in experiment_amendments.values()
            },
        },
    }


def _uuid_or_none(value):
    """Convert a stored string id to UUID without raising on malformed audit data."""
    try:
        from uuid import UUID

        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _clean_ids(values):
    """Remove null values from resource-id collections."""
    return {value for value in values if value is not None}


def _research_context(audit, contexts):
    """Resolve one audit event to a visible project/name/link triple."""
    metadata = audit.metadata if isinstance(audit.metadata, dict) else {}
    report = None
    if audit.resource_type in {"report", "report_comment", "report_comment_feedback"}:
        report = contexts["report"].get(audit.resource_id)
        if report is None:
            report = contexts["report"].get(_uuid_or_none(metadata.get("report")))
        if report is None:
            return None
        return (
            report.project,
            f"{report.report_type} {report.period_key}",
            "report",
            report.id,
        )

    if audit.resource_type == "report_attachment":
        attachment = contexts["report_attachment"].get(audit.resource_id)
        report = attachment.report if attachment else None
        if report is None:
            return None
        return report.project, f"{report.report_type} {report.period_key}", "report", report.id

    if audit.resource_type == "research_project":
        profile = contexts["profile"].get(audit.resource_id)
        chain = None
        project_id = metadata.get("project")
        if project_id:
            chain = next((item for item in contexts["chain"].values() if str(item.project_id) == str(project_id)), None)
        if profile is not None:
            chain = getattr(profile.project, "research_chain", None)
            return profile.project, profile.project.name, "chain", chain.id if chain else None
        return None

    if audit.resource_type == "research_chain":
        chain = contexts["chain"].get(audit.resource_id)
        return (chain.project, chain.project.name, "chain", chain.id) if chain else None

    if audit.resource_type == "research_chain_node_task":
        task = contexts["task"].get(audit.resource_id)
        if task is None:
            return None
        return (
            task.chain.project,
            task.title,
            "task",
            (task.id, task.chain_id, task.node_id),
        )

    if audit.resource_type == "research_chain_stage":
        stage = contexts["stage"].get(audit.resource_id)
        return (stage.chain.project, stage.get_stage_code_display(), "chain", stage.chain_id) if stage else None

    if audit.resource_type in {"stage_material", "research_chain_stage_material"}:
        material = contexts["material"].get(audit.resource_id)
        return (material.stage.chain.project, material.title, "chain", material.stage.chain_id) if material else None

    if audit.resource_type == "literature_entry":
        entry = contexts["literature"].get(audit.resource_id)
        return (entry.project, entry.title, "chain", None) if entry else None

    if audit.resource_type == "experiment_record":
        record = contexts["experiment"].get(audit.resource_id)
        return (record.project, record.title, "chain", None) if record else None

    if audit.resource_type == "experiment_amendment":
        amendment = contexts["experiment_amendment"].get(audit.resource_id)
        if amendment is None or amendment.record is None:
            return None
        record = amendment.record
        return record.project, f"实验 #{record.sequence_no} {record.title}", "chain", None

    if audit.resource_type == "research_outcome":
        outcome = contexts["outcome"].get(audit.resource_id)
        return (outcome.project, outcome.title, "chain", None) if outcome else None

    if audit.resource_type == "approval_request":
        approval = contexts["approval"].get(audit.resource_id)
        if approval is None or approval.issue is None:
            return None
        issue = approval.issue
        return (
            issue.project,
            issue.name,
            "work_item",
            (issue.project.identifier, issue.sequence_id),
        )

    if audit.resource_type == "stage_instance":
        stage = contexts["stage_instance"].get(audit.resource_id)
        return (
            (stage.project, stage.get_stage_display(), "stage", (stage.project_id, stage.stage))
            if stage
            else None
        )

    if audit.resource_type == "stage_review_assignment":
        assignment = contexts["stage_review_assignment"].get(audit.resource_id)
        stage = assignment.stage_instance if assignment else None
        if stage is None:
            stage = contexts["stage_instance"].get(audit.resource_id)
        return (
            (stage.project, stage.get_stage_display(), "stage", (stage.project_id, stage.stage))
            if stage
            else None
        )

    if audit.resource_type == "stage_review":
        review = contexts["stage_review"].get(audit.resource_id)
        stage = review.stage_instance if review else None
        return (
            (stage.project, stage.get_stage_display(), "stage", (stage.project_id, stage.stage))
            if stage
            else None
        )

    if audit.resource_type == "research_paper_review":
        review = contexts["paper_review"].get(audit.resource_id)
        if review is None:
            return None
        entity_name = review.outcome.title if review.outcome is not None else review.node.title
        return review.chain.project, entity_name, "chain", review.chain_id

    if audit.resource_type == "research_paper_review_version":
        version = contexts["paper_review_version"].get(audit.resource_id)
        if version is None:
            return None
        review = version.review
        entity_name = review.outcome.title if review.outcome is not None else review.node.title
        return review.chain.project, entity_name, "chain", review.chain_id

    return None


def _research_url(workspace_slug, kind, resource):
    """Build a research route for the resolved resource, when one exists."""
    if kind == "report":
        return f"/{workspace_slug}/research/reports/{resource}/"
    if kind == "task":
        task_id, chain_id, node_id = resource
        return f"/{workspace_slug}/research/chains/{chain_id}/?tab=nodes&node={node_id}&task={task_id}"
    if kind == "chain" and resource is not None:
        return f"/{workspace_slug}/research/chains/{resource}/"
    if kind == "work_item" and resource is not None:
        identifier, sequence_id = resource
        return f"/{workspace_slug}/browse/{identifier}-{sequence_id}/"
    if kind == "stage" and resource is not None:
        project_id, stage_code = resource
        return f"/{workspace_slug}/research/projects/{project_id}/stages/{str(stage_code).lower()}/"
    return None


def _metadata_user_name(value, users):
    """Resolve a stored user id while preserving historical fallback text."""
    if isinstance(value, dict):
        for key in ("display_name", "name", "title", "label", "id"):
            if value.get(key) is not None:
                return _metadata_user_name(value[key], users)
        return "历史未记录"
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return "历史未记录"
        return _metadata_user_name(parsed, users)
    user = users.get(_uuid_or_none(value)) if value else None
    if user is None:
        if _uuid_or_none(value) is not None:
            return "历史未记录"
        return str(value) if value else None
    return user.display_name or " ".join(
        part for part in (user.first_name, user.last_name) if part
    ) or user.email


def _metadata_value(field, value, users, resource_names=None):
    """Format an audit value without exposing internal identifiers or markup."""
    if value is None:
        return None
    resource_names = resource_names or {}
    if field in {"assignee", "member", "reviewer", "approver", "owner", "requester"}:
        return _metadata_user_name(value, users)
    if field == "status":
        return {
            "DRAFT": "草稿",
            "PLANNED": "计划中",
            "RUNNING": "进行中",
            "ASSIGNED": "已指派",
            "COMPLETED": "已完成",
            "FAILED": "失败",
            "CANCELLED": "已取消",
            "ARCHIVED": "已归档",
            "SUBMITTED": "已提交",
            "NEEDS_REVISION": "需修改",
            "ACCEPTED": "已验收",
            "PENDING": "待审批",
            "APPROVED": "已通过",
            "REJECTED": "已驳回",
            "WITHDRAWN": "已撤回",
            "DELETED": "已删除",
            "NOT_STARTED": "未开始",
            "IN_PROGRESS": "进行中",
            "ACTIVE": "进行中",
            "WAITING_HUMAN": "待人工处理",
            "WAITING_REVIEW": "待评审",
            "AWAITING_ADVISOR": "待导师审批",
            "AWAITING_PI": "待项目负责人审批",
            "PASSED": "已通过",
            "REVISE": "需修改",
        }.get(str(value).upper(), str(value))
    if field in {"role", "reviewer_role", "org_role"}:
        return {
            "OWNER": "负责人",
            "ADMIN": "管理员",
            "MEMBER": "成员",
            "PI": "项目负责人",
            "DIRECT_ADVISOR": "导师",
            "ADVISOR": "导师",
            "REVIEWER": "评审人",
            "UNIT_ADMIN": "组织管理员",
            "PRIMARY_ADVISOR": "主导师",
            "MAIN_PI": "项目负责人",
            "UNIT_OWNER": "组织负责人",
            "UNIT_PI": "组织负责人",
            "15": "成员",
            "20": "管理员",
        }.get(str(value).upper(), str(value))
    if field in {"recommendation", "result"}:
        return {
            "PASS": "通过",
            "APPROVE": "通过",
            "APPROVED": "通过",
            "REJECT": "驳回",
            "REJECTED": "驳回",
            "REVISE": "需修改",
            "RETURN": "退回",
        }.get(str(value).upper(), str(value))
    if field == "resource_id" and _uuid_or_none(value) is not None:
        return resource_names.get(_uuid_or_none(value), "历史未记录")
    if isinstance(value, str) and "<" in value and ">" in value:
        from bs4 import BeautifulSoup

        return BeautifulSoup(value, "html.parser").get_text(" ", strip=True)[:240] or None
    if isinstance(value, (dict, list, tuple, set)):
        if isinstance(value, dict):
            for key in ("display_name", "name", "title", "label", "text", "value"):
                if value.get(key) is not None:
                    return _metadata_value(field, value[key], users, resource_names)
            return "历史未记录"
        values = [
            _metadata_value(field, item, users, resource_names)
            for item in value
            if item is not None
        ]
        values = [item for item in values if item]
        return "、".join(values)[:240] or None
    if isinstance(value, str) and value.lstrip().startswith(("{", "[")):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return "历史未记录"
        return _metadata_value(field, parsed, users, resource_names)
    if _uuid_or_none(value) is not None:
        return "历史未记录"
    return str(value)[:240]


def _metadata_changes(metadata, users=None, action=None, resource_names=None):
    """Normalize audit metadata into compact before/after records."""
    changes = []
    if not isinstance(metadata, dict):
        return changes
    users = users or {}
    resource_names = resource_names or {}

    def add_change(field, old_value=None, new_value=None):
        if old_value is None and new_value is None:
            return
        change = {"field": field, "old_value": old_value, "new_value": new_value}
        if change not in changes:
            changes.append(change)

    raw_changes = metadata.get("changes")
    if isinstance(raw_changes, list):
        for change in raw_changes:
            if not isinstance(change, dict) or not change.get("field"):
                continue
            field = str(change["field"])
            has_value = any(key in change for key in ("old_value", "new_value", "from", "to"))
            old_raw = change["old_value"] if "old_value" in change else change.get("from")
            new_raw = change["new_value"] if "new_value" in change else change.get("to")
            old_value = _metadata_value(field, old_raw, users, resource_names)
            new_value = _metadata_value(
                field,
                new_raw,
                users,
                resource_names,
            )
            if not has_value:
                new_value = "已更新"
            add_change(field, old_value, new_value)

    if isinstance(metadata.get("changes"), dict):
        for field, values in metadata["changes"].items():
            if isinstance(values, dict):
                old_value = values["old_value"] if "old_value" in values else values.get("from")
                new_value = values["new_value"] if "new_value" in values else values.get("to")
                if not any(key in values for key in ("old_value", "new_value", "from", "to")):
                    new_value = "已更新"
                add_change(
                    field,
                    _metadata_value(field, old_value, users, resource_names),
                    _metadata_value(field, new_value, users, resource_names),
                )
            else:
                add_change(field, None, _metadata_value(field, values, users, resource_names) or "已更新")

    if "from" in metadata or "to" in metadata or "old_value" in metadata or "new_value" in metadata:
        field = str(metadata.get("field") or metadata.get("changed_field") or "")
        if not field:
            field = "owner" if action == "project.owner.change" else "value"
        add_change(
            field,
            _metadata_value(field, metadata.get("from", metadata.get("old_value")), users, resource_names),
            _metadata_value(field, metadata.get("to", metadata.get("new_value")), users, resource_names),
        )
    for field_list_key in ("fields", "changed"):
        if not isinstance(metadata.get(field_list_key), list):
            continue
        for field in metadata[field_list_key]:
            field_name = str(field)
            if not any(change["field"] == field_name for change in changes):
                add_change(field_name, None, "已更新")
    if metadata.get("member"):
        member_name = metadata.get("member_name") or _metadata_user_name(metadata["member"], users)
        if action == "chain.member.remove":
            add_change("member", member_name, None)
        else:
            add_change("member", None, member_name)
    for key, field in (("reviewers", "reviewer"), ("approvers", "approver")):
        values = metadata.get(key)
        if isinstance(values, list):
            for value in values:
                add_change(field, None, _metadata_value(field, value, users, resource_names))
    if metadata.get("role"):
        add_change("role", None, _metadata_value("role", metadata["role"], users, resource_names))
    for key, field in (
        ("reviewer", "reviewer"),
        ("approver", "approver"),
        ("requester", "requester"),
        ("owner", "owner"),
        ("owner_id", "owner"),
        ("final_reviewer_id", "reviewer"),
    ):
        if metadata.get(key) and not any(change["field"] == field for change in changes):
            snapshot = metadata.get(f"{key}_name")
            add_change(field, None, snapshot or _metadata_value(field, metadata[key], users, resource_names))
    if metadata.get("reviewer_role") and not any(change["field"] == "reviewer_role" for change in changes):
        add_change(
            "reviewer_role",
            None,
            _metadata_value("reviewer_role", metadata["reviewer_role"], users, resource_names),
        )
    if metadata.get("recommendation") and not any(change["field"] == "recommendation" for change in changes):
        add_change(
            "recommendation",
            None,
            _metadata_value("recommendation", metadata["recommendation"], users, resource_names),
        )
    for key, field, is_removed in (("added", "member", False), ("removed", "member", True)):
        values = metadata.get(key)
        if isinstance(values, list):
            names = metadata.get(f"{key}_names")
            for index, value in enumerate(values):
                name = (
                    names[index]
                    if isinstance(names, list) and index < len(names) and names[index]
                    else _metadata_value("member", value, users, resource_names)
                )
                add_change(field, name if is_removed else None, None if is_removed else name)
    files = metadata.get("files")
    if isinstance(files, list):
        for file_name in files:
            if file_name:
                add_change("file", None, str(file_name)[:255])
    if metadata.get("file"):
        add_change("file", None, str(metadata["file"])[:255])
    if metadata.get("file_name"):
        add_change("file", None, str(metadata["file_name"])[:255])
    if metadata.get("status") and not any(change["field"] == "status" for change in changes):
        add_change("status", None, _metadata_value("status", metadata["status"], users, resource_names))
    if metadata.get("period_key"):
        add_change("period", None, metadata["period_key"])
    if metadata.get("reason"):
        add_change("reason", None, _metadata_value("reason", metadata["reason"], users, resource_names))
    if metadata.get("comment"):
        add_change("comment", None, _metadata_value("comment", metadata["comment"], users, resource_names))
    return changes


def _summary_text(metadata):
    """Return a short plain-text summary for comments, reasons, or opinions."""
    if not isinstance(metadata, dict):
        return ""
    for key in ("comment", "reason", "review_comment", "opinion", "escalation_reason"):
        value = metadata.get(key)
        if value:
            from plane.utils.html_processor import strip_tags

            return " ".join(strip_tags(str(value)).split())[:240]
    return ""


def _research_rows(workspace_slug, audits, visible_project_ids, visible_issue_ids, projects, user):
    """Convert meaningful research audits into project-scoped feed rows."""
    audits = list(audits)
    contexts = _research_contexts(audits[0].workspace if audits else None, audits)
    report_context = build_actor_context(user, audits[0].workspace_id) if audits else None
    rows = []
    for audit in audits:
        metadata = audit.metadata if isinstance(audit.metadata, dict) else {}
        is_own_event = audit.actor_id == getattr(user, "id", None)
        context = _research_context(audit, contexts)
        if context is None:
            # Audit rows are append-only and may outlive their business object.
            # Fall back to the immutable snapshot written by the mutation path
            # so the actor can still trace a deletion from the home feed.
            project_id = _uuid_or_none(metadata.get("project_id"))
            project = projects.get(project_id)
            if project is None and not is_own_event:
                continue
            entity_name = metadata.get("entity_name") or metadata.get("task_title") or "已删除对象"
            resource = audit.resource_id
            if audit.resource_type == "research_chain_node_task":
                kind = "task"
                resource = (
                    audit.resource_id,
                    _uuid_or_none(metadata.get("chain_id")),
                    _uuid_or_none(metadata.get("node_id")),
                )
            elif audit.resource_type in {"research_chain", "research_project"}:
                kind = "chain"
                resource = _uuid_or_none(metadata.get("chain_id")) or audit.resource_id
            elif audit.resource_type == "approval_request":
                kind = "work_item"
                resource = None
            else:
                kind = "chain"
                resource = None
        else:
            project, entity_name, kind, resource = context
        if project is None:
            if not is_own_event:
                continue
        elif project.id not in visible_project_ids and not is_own_event:
            continue
        if audit.resource_type == "approval_request":
            approval = contexts["approval"].get(audit.resource_id)
            if approval is None or (approval.issue_id not in visible_issue_ids and not is_own_event):
                continue
        if kind == "report":
            report = contexts["report"].get(resource)
            if report is None or not check_access(user, "view", report_resource(report), context=report_context):
                continue
        entity_name = metadata.get("entity_name") or metadata.get("task_title") or entity_name
        project_detail = _project_detail(project)
        if project_detail is None and is_own_event:
            project_detail = {
                "id": str(metadata.get("project_id")) if metadata.get("project_id") else None,
                "name": metadata.get("project_name") or "已删除项目",
                "identifier": metadata.get("project_identifier"),
            }
        rows.append(
            {
                "id": f"research-audit:{audit.id}",
                "source": "research",
                "actor": _actor_detail(audit.actor),
                "action": audit.action,
                "entity_type": audit.resource_type,
                "entity_id": str(audit.resource_id),
                "entity_name": entity_name,
                "project": project_detail,
                "url": _research_url(workspace_slug, kind, resource),
                "occurred_at": audit.created_at,
                "changes": _metadata_changes(
                    metadata,
                    contexts["users"],
                    audit.action,
                    contexts["resource_names"],
                ),
                "summary": _summary_text(metadata),
            }
        )
    return rows


def _encode_activity_cursor(workspace, user, days, row):
    """Encode a signed keyset cursor scoped to one workspace, user and filter.

    Args:
        workspace: Workspace whose activity stream is being read.
        user: Authenticated user whose permission scope is embedded in the cursor.
        days: Active time filter represented by ``30``, ``90`` or ``all``.
        row: Last feed row returned on the current page.

    Returns:
        An opaque, URL-safe cursor string.
    """
    return signing.dumps(
        {
            "workspace": str(workspace.id),
            "user": str(user.id),
            "days": days,
            "occurred_at": row["occurred_at"].isoformat(),
            "row_id": row["id"],
        },
        salt=CURSOR_SALT,
        compress=True,
    )


def _decode_activity_cursor(cursor, workspace, user, days):
    """Validate a feed cursor and return its keyset anchor.

    Args:
        cursor: Opaque cursor supplied by the client.
        workspace: Workspace in the current request.
        user: Authenticated user in the current request.
        days: Active time filter in the current request.

    Returns:
        A ``(occurred_at, row_id)`` tuple, or ``None`` when the cursor is invalid.
    """
    try:
        payload = signing.loads(cursor, salt=CURSOR_SALT, max_age=CURSOR_MAX_AGE_SECONDS)
        expected = {"workspace": str(workspace.id), "user": str(user.id), "days": days}
        if any(payload.get(key) != value for key, value in expected.items()):
            return None
        occurred_at = datetime.fromisoformat(payload["occurred_at"])
        row_id = payload["row_id"]
        if occurred_at.tzinfo is None or not isinstance(row_id, str):
            return None
    except (TypeError, ValueError, KeyError, signing.BadSignature):
        return None
    return occurred_at, row_id


def _comment_occurred_at_expression():
    """Build the effective event time used to sort edited comments."""
    return Case(
        When(edited_at__gt=F("created_at"), then=F("edited_at")),
        default=F("created_at"),
        output_field=DateTimeField(),
    )


def _cursor_feed_queryset(queryset, time_expression, row_prefix, anchor):
    """Annotate and filter one source using the global feed sort key.

    Args:
        queryset: Permission- and time-filtered source queryset.
        time_expression: Model expression yielding the feed event time.
        row_prefix: Stable prefix used by serialized rows from this source.
        anchor: Optional ``(occurred_at, row_id)`` tuple from the previous page.

    Returns:
        Queryset ordered by ``feed_time`` and full feed id descending.
    """
    queryset = queryset.annotate(
        feed_time=time_expression,
        feed_id=Concat(Value(row_prefix), Cast("id", output_field=CharField()), output_field=CharField()),
    )
    if anchor is not None:
        occurred_at, row_id = anchor
        queryset = queryset.filter(Q(feed_time__lt=occurred_at) | Q(feed_time__exact=occurred_at, feed_id__lt=row_id))
    return queryset.order_by("-feed_time", "-feed_id")


def _collect_cursor_rows(queryset, converter, target):
    """Collect enough serialized rows from one source for the next feed page.

    Args:
        queryset: Keyset-ordered queryset with ``feed_time`` and ``feed_id``.
        converter: Callable converting a materialized source batch to feed rows.
        target: Number of candidate rows needed to detect ``has_more``.

    Returns:
        Serialized rows from this source; may be fewer when the source is exhausted.
    """
    rows = []
    remaining = queryset
    batch_size = min(target, CURSOR_SOURCE_BATCH_SIZE)
    while len(rows) < target:
        batch = list(remaining[:batch_size])
        if not batch:
            break
        rows.extend(converter(batch))
        if len(batch) < batch_size:
            break
        last = batch[-1]
        remaining = remaining.filter(
            Q(feed_time__lt=last.feed_time) | Q(feed_time__exact=last.feed_time, feed_id__lt=last.feed_id)
        )
        batch_size = min(batch_size * 4, CURSOR_SOURCE_BATCH_SIZE)
    return rows


def _iso(value):
    """Render an event time in ISO-8601 form for stable frontend formatting."""
    return value.isoformat() if value else None


class WorkspaceHomeActivityEndpoint(BaseAPIView):
    """Read a permission-scoped, real-mutation activity stream for home."""

    use_read_replica = True

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def get(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        days = request.query_params.get("days", "30")
        if days not in {"30", "90", "all"}:
            return Response({"detail": "days must be 30, 90, or all"}, status=status.HTTP_400_BAD_REQUEST)
        pagination = request.query_params.get("pagination")
        if pagination not in {None, "cursor"}:
            return Response({"detail": "pagination must be cursor"}, status=status.HTTP_400_BAD_REQUEST)
        cursor_mode = pagination == "cursor"
        cursor_value = request.query_params.get("cursor")
        if not cursor_mode and cursor_value is not None:
            return Response({"detail": "cursor requires pagination=cursor"}, status=status.HTTP_400_BAD_REQUEST)
        if cursor_mode and "offset" in request.query_params:
            return Response({"detail": "cursor pagination does not accept offset"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            per_page = min(max(int(request.query_params.get("per_page", 12) or 12), 1), 50)
            offset = 0 if cursor_mode else max(int(request.query_params.get("offset", 0) or 0), 0)
        except ValueError:
            return Response({"detail": "offset and per_page must be integers"}, status=status.HTTP_400_BAD_REQUEST)
        cursor_anchor = None
        if cursor_mode and cursor_value:
            cursor_anchor = _decode_activity_cursor(cursor_value, workspace, request.user, days)
            if cursor_anchor is None:
                return Response({"detail": "invalid activity cursor"}, status=status.HTTP_400_BAD_REQUEST)
        if not cursor_mode and offset >= MAX_WINDOW:
            return Response(
                {
                    "results": [],
                    "next_offset": None,
                    "has_more": False,
                    "offset": offset,
                    "per_page": per_page,
                }
            )

        visible_project_ids = _visible_project_ids(request.user, workspace)
        projects = {
            project.id: project
            for project in Project.objects.filter(id__in=visible_project_ids).only("id", "name", "identifier")
        }
        cutoff = timezone.now() - timedelta(days=int(days)) if days != "all" else None
        rows = []

        # 删除后的项目不再属于当前可见集合，但操作者仍应能在动态中追溯自己的删除事件。
        project_events = HomeActivityEvent.objects.filter(workspace=workspace).filter(
            Q(project_id__in=visible_project_ids) | Q(actor=request.user)
        )
        if cutoff:
            project_events = project_events.filter(occurred_at__gte=cutoff)

        visible_issues = _visible_issues(request.user, workspace, visible_project_ids)
        visible_issue_ids = set(visible_issues.values_list("id", flat=True))
        issue_activities = IssueActivity.objects.filter(
            workspace=workspace,
            issue_id__in=visible_issues.values("id"),
        ).filter(Q(field__in=ISSUE_ACTIVITY_FIELDS - {None}) | Q(field__isnull=True))
        issue_activities = issue_activities.exclude(issue_comment__isnull=False)
        if cutoff:
            issue_activities = issue_activities.filter(created_at__gte=cutoff)

        comments = IssueComment.objects.filter(workspace=workspace, issue_id__in=visible_issues.values("id"))
        if cutoff:
            comments = comments.filter(created_at__gte=cutoff)

        audits = None
        if research_module_enabled() and workspace_research_enabled(workspace):
            audits = ResearchAuditEvent.objects.filter(
                workspace=workspace,
                resource_type__in=RESEARCH_HOME_RESOURCE_TYPES,
            )
            if cutoff:
                audits = audits.filter(created_at__gte=cutoff)

        if cursor_mode:
            target = per_page + 1
            cursor_project_events = _cursor_feed_queryset(
                project_events.select_related("actor"), F("occurred_at"), "project-event:", cursor_anchor
            )
            rows.extend(
                _collect_cursor_rows(
                    cursor_project_events,
                    lambda batch: _project_event_rows(slug, batch, projects),
                    target,
                )
            )

            cursor_issue_activities = _cursor_feed_queryset(
                issue_activities.select_related("actor", "issue", "project"),
                F("created_at"),
                "issue-activity:",
                cursor_anchor,
            )
            rows.extend(
                _collect_cursor_rows(
                    cursor_issue_activities,
                    lambda batch: _issue_activity_rows(slug, batch),
                    target,
                )
            )

            cursor_comments = _cursor_feed_queryset(
                comments.select_related("actor", "issue", "project"),
                _comment_occurred_at_expression(),
                "issue-comment:",
                cursor_anchor,
            )
            rows.extend(
                _collect_cursor_rows(
                    cursor_comments,
                    lambda batch: _issue_comment_rows(slug, batch),
                    target,
                )
            )

            if audits is not None:
                cursor_audits = _cursor_feed_queryset(
                    audits.select_related("actor", "org_unit"),
                    F("created_at"),
                    "research-audit:",
                    cursor_anchor,
                )
                rows.extend(
                    _collect_cursor_rows(
                        cursor_audits,
                        lambda batch: _research_rows(
                            slug,
                            batch,
                            visible_project_ids,
                            visible_issue_ids,
                            projects,
                            request.user,
                        ),
                        target,
                    )
                )
        else:
            window = min(offset + per_page + 1, MAX_WINDOW)
            rows.extend(
                _project_event_rows(
                    slug,
                    project_events.select_related("actor").order_by("-occurred_at", "-created_at")[:window],
                    projects,
                )
            )
            rows.extend(
                _issue_activity_rows(
                    slug,
                    issue_activities.select_related("actor", "issue", "project").order_by("-created_at", "-id")[
                        :window
                    ],
                )
            )
            rows.extend(
                _issue_comment_rows(
                    slug,
                    comments.select_related("actor", "issue", "project").order_by("-created_at", "-id")[:window],
                )
            )
            if audits is not None:
                ordered_audits = audits.select_related("actor", "org_unit").order_by("-created_at", "-id")[:window]
                rows.extend(
                    _research_rows(
                        slug,
                        ordered_audits,
                        visible_project_ids,
                        visible_issue_ids,
                        projects,
                        request.user,
                    )
                )

        rows.sort(key=lambda row: (row["occurred_at"], row["id"]), reverse=True)
        page = rows[:per_page] if cursor_mode else rows[offset : offset + per_page]
        has_more = len(rows) > per_page if cursor_mode else len(rows) > offset + per_page
        next_cursor = (
            _encode_activity_cursor(workspace, request.user, days, page[-1])
            if cursor_mode and has_more and page
            else None
        )
        for row in page:
            row["occurred_at"] = _iso(row["occurred_at"])

        return Response(
            {
                "results": page,
                "next_cursor": next_cursor,
                "next_offset": None if cursor_mode else (offset + per_page if has_more else None),
                "has_more": has_more,
                "offset": 0 if cursor_mode else offset,
                "per_page": per_page,
            }
        )
