"""Aggregate real business mutations into the workspace home activity feed."""

from datetime import timedelta

from django.db.models import Q
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.app.permissions import ROLE, allow_permission
from plane.app.serializers.user import UserLiteSerializer
from plane.app.views.base import BaseAPIView
from plane.db.models import (
    HomeActivityEvent,
    Issue,
    IssueActivity,
    IssueComment,
    PeriodicReport,
    Project,
    ProjectMember,
    ProjectNetwork,
    ResearchAuditEvent,
    ResearchChain,
    ResearchChainNodeTask,
    ResearchChainStage,
    ResearchChainStageMaterialItem,
    ExperimentRecord,
    LiteratureEntry,
    ResearchOutcome,
    ResearchProjectProfile,
    Workspace,
    WorkspaceMember,
)
from plane.research.utils.config import research_module_enabled
from plane.research.utils.settings import workspace_research_enabled
from plane.utils.administrative_projects import administrative_projects_for_user

RESEARCH_HOME_RESOURCE_TYPES = {
    "report",
    "report_comment",
    "report_comment_feedback",
    "research_project",
    "research_chain",
    "research_chain_node_task",
    "research_chain_stage",
    "stage_material",
    "literature_entry",
    "experiment_record",
    "research_outcome",
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

    Workspace admins retain the existing global view. Other members see public
    projects, their active memberships, administrative projects they manage, and
    research profiles already exposed by the research visibility rules.
    """
    projects = Project.objects.filter(workspace=workspace, archived_at__isnull=True)
    if WorkspaceMember.objects.filter(workspace=workspace, member=user, is_active=True, role=20).exists():
        return set(projects.values_list("id", flat=True))

    visible = projects.filter(
        Q(network=ProjectNetwork.PUBLIC.value)
        | Q(
            project_projectmember__member=user,
            project_projectmember__is_active=True,
            project_projectmember__deleted_at__isnull=True,
        )
    ).values_list("id", flat=True)
    managed = administrative_projects_for_user(user, workspace.slug).values_list("id", flat=True)
    research = ()
    if research_module_enabled() and workspace_research_enabled(workspace):
        from plane.research.views.projects import visible_profile_queryset

        research = visible_profile_queryset(workspace, user).values_list("project_id", flat=True)
    return set(visible) | set(managed) | set(research)


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
    for activity in activities.select_related("actor", "issue", "project"):
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
    for comment in comments.select_related("actor", "issue", "project"):
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
    for event in events.select_related("actor"):
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
    outcome_ids = set()

    for audit in audits:
        metadata = audit.metadata if isinstance(audit.metadata, dict) else {}
        if audit.resource_type in {"report", "report_comment", "report_comment_feedback"}:
            report_ids.add(audit.resource_id)
            if metadata.get("report"):
                report_ids.add(_uuid_or_none(metadata.get("report")))
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
        elif audit.resource_type == "literature_entry":
            literature_ids.add(audit.resource_id)
        elif audit.resource_type == "experiment_record":
            experiment_ids.add(audit.resource_id)
        elif audit.resource_type == "research_outcome":
            outcome_ids.add(audit.resource_id)

    reports = {
        obj.id: obj
        for obj in PeriodicReport.objects.filter(workspace=workspace, id__in=_clean_ids(report_ids))
        .select_related("project")
        .only("id", "report_type", "period_key", "project_id", "project__id", "project__name", "project__identifier")
    }
    profiles = {
        obj.id: obj
        for obj in ResearchProjectProfile.objects.filter(workspace=workspace, id__in=_clean_ids(profile_ids))
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
        for obj in ResearchChain.objects.filter(workspace=workspace, id__in=_clean_ids(chain_ids))
        .select_related("project")
        .only("id", "project_id", "project__id", "project__name", "project__identifier")
    }
    tasks = {
        obj.id: obj
        for obj in ResearchChainNodeTask.objects.filter(workspace=workspace, id__in=_clean_ids(task_ids))
        .select_related("chain__project", "node")
        .only("id", "title", "chain_id", "chain__project_id", "node_id")
    }
    stages = {
        obj.id: obj
        for obj in ResearchChainStage.objects.filter(workspace=workspace, id__in=_clean_ids(stage_ids))
        .select_related("chain__project")
        .only("id", "stage_code", "chain_id", "chain__project_id")
    }
    materials = {
        obj.id: obj
        for obj in ResearchChainStageMaterialItem.objects.filter(id__in=_clean_ids(material_ids))
        .select_related("stage__chain__project")
        .only("id", "title", "stage_id")
    }
    literature = {
        obj.id: obj
        for obj in LiteratureEntry.objects.filter(workspace=workspace, id__in=_clean_ids(literature_ids))
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
    }
    experiments = {
        obj.id: obj
        for obj in ExperimentRecord.objects.filter(workspace=workspace, id__in=_clean_ids(experiment_ids))
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
    }
    outcomes = {
        obj.id: obj
        for obj in ResearchOutcome.objects.filter(workspace=workspace, id__in=_clean_ids(outcome_ids))
        .select_related("project")
        .only("id", "title", "project_id", "project__name", "project__identifier")
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
        "outcome": outcomes,
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
        return (stage.chain.project, stage.get_stage_display(), "chain", stage.chain_id) if stage else None

    if audit.resource_type == "stage_material":
        material = contexts["material"].get(audit.resource_id)
        return (material.stage.chain.project, material.title, "chain", material.stage.chain_id) if material else None

    if audit.resource_type == "literature_entry":
        entry = contexts["literature"].get(audit.resource_id)
        return (entry.project, entry.title, "chain", None) if entry else None

    if audit.resource_type == "experiment_record":
        record = contexts["experiment"].get(audit.resource_id)
        return (record.project, record.title, "chain", None) if record else None

    if audit.resource_type == "research_outcome":
        outcome = contexts["outcome"].get(audit.resource_id)
        return (outcome.project, outcome.title, "chain", None) if outcome else None

    return None


def _research_url(workspace_slug, kind, resource):
    """Build a research route for the resolved resource, when one exists."""
    if kind == "report":
        return f"/{workspace_slug}/research/reports/{resource}/"
    if kind == "task":
        task_id, chain_id, node_id = resource
        return f"/{workspace_slug}/research/chains/{chain_id}/nodes/{node_id}/tasks/{task_id}/"
    if kind == "chain" and resource is not None:
        return f"/{workspace_slug}/research/chains/{resource}/"
    return None


def _metadata_changes(metadata):
    """Normalize audit metadata into compact before/after records."""
    changes = []
    if not isinstance(metadata, dict):
        return changes
    if "from" in metadata or "to" in metadata:
        changes.append({"field": "value", "old_value": metadata.get("from"), "new_value": metadata.get("to")})
    if isinstance(metadata.get("fields"), list):
        changes.append({"field": "fields", "new_value": ", ".join(map(str, metadata["fields"]))})
    if metadata.get("period_key"):
        changes.append({"field": "period", "new_value": metadata["period_key"]})
    if metadata.get("reason"):
        changes.append({"field": "reason", "new_value": str(metadata["reason"])[:240]})
    if metadata.get("comment"):
        changes.append({"field": "comment", "new_value": str(metadata["comment"])[:240]})
    return changes


def _research_rows(workspace_slug, audits, visible_project_ids, projects, user):
    """Convert meaningful research audits into project-scoped feed rows."""
    audits = list(audits.select_related("actor", "org_unit"))
    contexts = _research_contexts(audits[0].workspace if audits else None, audits)
    rows = []
    for audit in audits:
        context = _research_context(audit, contexts)
        if context is None:
            continue
        project, entity_name, kind, resource = context
        is_own_event = audit.actor_id == getattr(user, "id", None)
        if project is None or (project.id not in visible_project_ids and not is_own_event):
            continue
        rows.append(
            {
                "id": f"research-audit:{audit.id}",
                "source": "research",
                "actor": _actor_detail(audit.actor),
                "action": audit.action,
                "entity_type": audit.resource_type,
                "entity_id": str(audit.resource_id),
                "entity_name": entity_name,
                "project": _project_detail(projects.get(project.id)),
                "url": _research_url(workspace_slug, kind, resource),
                "occurred_at": audit.created_at,
                "changes": _metadata_changes(audit.metadata),
                "summary": "",
            }
        )
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
        try:
            offset = max(int(request.query_params.get("offset", 0) or 0), 0)
            per_page = min(max(int(request.query_params.get("per_page", 12) or 12), 1), 50)
        except ValueError:
            return Response({"detail": "offset and per_page must be integers"}, status=status.HTTP_400_BAD_REQUEST)
        if offset >= MAX_WINDOW:
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
        window = min(offset + per_page + 1, MAX_WINDOW)
        rows = []

        # 删除后的项目不再属于当前可见集合，但操作者仍应能在动态中追溯自己的删除事件。
        project_events = HomeActivityEvent.objects.filter(workspace=workspace).filter(
            Q(project_id__in=visible_project_ids) | Q(actor=request.user)
        )
        if cutoff:
            project_events = project_events.filter(occurred_at__gte=cutoff)
        rows.extend(
            _project_event_rows(
                slug,
                project_events.order_by("-occurred_at", "-created_at")[:window],
                projects,
            )
        )

        visible_issues = _visible_issues(request.user, workspace, visible_project_ids)
        issue_activities = IssueActivity.objects.filter(
            workspace=workspace,
            issue_id__in=visible_issues.values("id"),
        ).filter(Q(field__in=ISSUE_ACTIVITY_FIELDS - {None}) | Q(field__isnull=True))
        issue_activities = issue_activities.exclude(issue_comment__isnull=False)
        if cutoff:
            issue_activities = issue_activities.filter(created_at__gte=cutoff)
        rows.extend(
            _issue_activity_rows(
                slug,
                issue_activities.order_by("-created_at", "-id")[:window],
            )
        )

        comments = IssueComment.objects.filter(workspace=workspace, issue_id__in=visible_issues.values("id"))
        if cutoff:
            comments = comments.filter(created_at__gte=cutoff)
        rows.extend(
            _issue_comment_rows(
                slug,
                comments.order_by("-created_at", "-id")[:window],
            )
        )

        if research_module_enabled() and workspace_research_enabled(workspace):
            audits = ResearchAuditEvent.objects.filter(
                workspace=workspace,
                resource_type__in=RESEARCH_HOME_RESOURCE_TYPES,
            )
            if cutoff:
                audits = audits.filter(created_at__gte=cutoff)
            ordered_audits = audits.order_by("-created_at", "-id")[:window]
            rows.extend(_research_rows(slug, ordered_audits, visible_project_ids, projects, request.user))

        rows.sort(key=lambda row: (row["occurred_at"], row["id"]), reverse=True)
        page = rows[offset : offset + per_page]
        has_more = len(rows) > offset + per_page
        for row in page:
            row["occurred_at"] = _iso(row["occurred_at"])

        return Response(
            {
                "results": page,
                "next_offset": offset + per_page if has_more else None,
                "has_more": has_more,
                "offset": offset,
                "per_page": per_page,
            }
        )
