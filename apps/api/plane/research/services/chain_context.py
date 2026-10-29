"""Scoped, paged research reads. No business writes, file downloads or raw URLs."""

import hashlib
import json
from uuid import UUID

from django.core import signing
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    ExperimentRecord, FileAsset, PeriodicReport, ResearchAgentRunEvent,
    PeriodicReportCommentFeedback, ResearchAnalysisResult, ResearchChain, ResearchChainEvent, ResearchChainNode,
    ResearchChainNodeTask, ResearchChainSnapshot, ResearchChainUpload,
    ResearchExternalReference, ResearchPaperReview, ResearchTaskComment, StageMaterial,
)
from plane.research.services.mcp_catalog import ResearchReadError, validate_arguments
from plane.research.services.report_context import ResearchReportContextError, selected_report_content
from plane.research.utils.acl import build_actor_context, check_access
from plane.research.utils.integrations import reference_allowed
from plane.research.utils.projects import can_manage_team_content
from plane.research.utils.reports import report_resource
from plane.research.utils.resource_projections import experiment_resource
from plane.research.utils.stages import material_resource
from plane.research.views.projects import visible_profile_queryset
from plane.utils.content_validator import validate_html_content
from plane.utils.html_processor import strip_tags

CURSOR_SALT = "research-mcp.read.v1"
MAX_SCAN = 200
MAX_OUTPUT = 24000
CONTENT_KINDS = frozenset({"analysis", "snapshot", "experiment", "report", "agent_event", "event", "task", "task_comment"})
ALIASES = {
    "experiment_record": "experiment", "periodic_report": "report",
    "analysis_result": "analysis", "research_analysis": "analysis",
    "chain_snapshot": "snapshot", "research_snapshot": "snapshot",
    "file": "topic_material", "external_ref": "external_reference",
    "research_task": "task", "node_task": "task", "research_task_comment": "task_comment",
}
MODELS = {
    "analysis": ResearchAnalysisResult, "snapshot": ResearchChainSnapshot,
    "upload": ResearchChainUpload, "paper_review": ResearchPaperReview,
    "report": PeriodicReport, "experiment": ExperimentRecord,
    "stage_material": StageMaterial, "topic_material": FileAsset,
    "external_reference": ResearchExternalReference, "agent_event": ResearchAgentRunEvent,
    "event": ResearchChainEvent, "task": ResearchChainNodeTask, "task_comment": ResearchTaskComment,
}

# Runtime payloads also contain raw tools and private reasoning. Public fields
# depend on the event discriminator; a generic `content` key is not sufficient.
PUBLIC_AGENT_FIELDS = {
    "OUTPUT": ("content", "summary"),
    "TOOL_CALL": ("name", "toolCallId"),
    "APPROVAL": ("summary",),
    "HUMAN_DECISION": ("summary",),
    "DATA_CHANGE": ("summary",),
    "INTERMEDIATE_ARTIFACT": ("summary",),
}
PUBLIC_AGENT_REMOTE_TYPES = {
    "OUTPUT": {"assistant.delta", "assistant.snapshot", "run.completed"},
    "TOOL_CALL": {"tool.started", "tool.output", "tool.completed"},
    "APPROVAL": {"permission.required"},
    "HUMAN_DECISION": {"permission.resolved"},
    "DATA_CHANGE": {"workspace.changed"},
    "INTERMEDIATE_ARTIFACT": {"artifact.upserted"},
}


def public_agent_fields(event):
    payload = event.payload
    fields = PUBLIC_AGENT_FIELDS.get(event.event_type)
    if fields is None or not isinstance(payload, dict):
        return None
    remote_type = payload.get("remote_type")
    if remote_type is not None and (
        not isinstance(remote_type, str) or remote_type not in PUBLIC_AGENT_REMOTE_TYPES[event.event_type]
    ):
        return None
    return {key: payload[key] for key in fields if isinstance(payload.get(key), str)}


def _json(value):
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def _clip(value, size=500):
    return str(value or "")[:size]


def _instruction_text(task):
    """Return a bounded plain-text projection of a task instruction."""
    _valid, _error, cleaned = validate_html_content(task.instruction or "")
    return strip_tags(cleaned or "").strip()


def normalise_reference(ref):
    """Recognise known object references, never interpret a URL as an object id."""
    if not isinstance(ref, dict):
        return None
    kind = str(ref.get("kind") or ref.get("resource_type") or ref.get("type") or "").lower()
    kind = ALIASES.get(kind, kind)
    raw_id = ref.get("id") or ref.get("resource_id") or ref.get("snapshot_id")
    if kind not in MODELS:
        return None
    try:
        resource_id = str(UUID(str(raw_id)))
    except (ValueError, TypeError, AttributeError):
        return None
    version = ref.get("version", ref.get("version_no"))
    return {"kind": kind, "id": resource_id,
            **({"version": version} if type(version) is int and version > 0 else {})}


class ResearchReadService:
    def __init__(self, *, workspace, user, grant=None, authorization=None):
        if grant is not None and authorization is not None:
            raise ValueError("Choose one explicit research authorization source.")
        self.workspace, self.user, self.grant = workspace, user, grant
        self.authorization = authorization
        self.actor = build_actor_context(user, workspace.id)
        self._reference_cache = {}
        self._truncated = False

    def execute(self, name, arguments):
        args = validate_arguments(name, arguments)
        if self.authorization is not None:
            self.authorization.authenticate(name)
        if self.grant is not None:
            if (self.grant.workspace_id != self.workspace.id or self.grant.user_id != self.user.id
                    or self.grant.revoked_at or self.grant.expires_at <= timezone.now()
                    or name not in self.grant.allowed_tools):
                raise ResearchReadError("scope_denied", "Research credential is expired or does not permit this tool.", 403)
        self.name, self.args = name, args
        self.binding = hashlib.sha256(_json({
            "workspace": self.workspace.id, "user": self.user.id,
            "grant": self.grant.context_id if self.grant else None,
            "policy": self.grant.policy_hash if self.grant else None,
            **({"authorization": self.authorization.binding} if self.authorization is not None else {}),
            "tool": name, "args": {k: v for k, v in args.items() if k != "cursor"},
        }).encode()).hexdigest()
        result = getattr(self, name)(**args)
        envelope = {
            "schema_version": "research-mcp.v1", **result,
            "retrieved_at": timezone.now().isoformat(), "truncated": self._truncated,
            "content_policy": "untrusted_reference_data", "degraded": False,
        }
        if len(_json(envelope)) > MAX_OUTPUT:
            raise ResearchReadError("response_too_large", "Reduce the page size or requested content size.", 413)
        return envelope

    def chains(self):
        profiles = visible_profile_queryset(self.workspace, self.user).filter(deleted_at__isnull=True)
        rows = ResearchChain.objects.filter(
            workspace=self.workspace, project_id__in=profiles.values("project_id"),
            project__deleted_at__isnull=True,
        ).exclude(status="DELETED").select_related("project", "project__research_profile")
        if self.grant:
            rows = rows.filter(project_id=self.grant.project_id)
            if self.grant.chain_node_id:
                rows = rows.filter(nodes__id=self.grant.chain_node_id, nodes__deleted_at__isnull=True)
        if self.authorization is not None:
            rows = self.authorization.scoped_chains(rows)
        return rows.distinct()

    def chain(self, chain_id):
        chain = self.chains().filter(pk=chain_id).first()
        if chain is None:
            raise ResearchReadError("not_found", "Research chain not found in the current scope.", 404)
        return chain

    def nodes(self, chain=None):
        rows = ResearchChainNode.objects.filter(chain__in=self.chains()).select_related("chain", "chain__project")
        if chain:
            rows = rows.filter(chain=chain)
        if self.grant and self.grant.chain_node_id:
            rows = rows.filter(pk=self.grant.chain_node_id)
        if self.authorization is not None:
            rows = self.authorization.scoped_nodes(rows)
        return rows

    def node(self, node_id):
        node = self.nodes().filter(pk=node_id).first()
        if node is None:
            raise ResearchReadError("not_found", "Research node not found in the current scope.", 404)
        return node

    def _cursor(self, **state):
        return signing.dumps({"binding": self.binding, **state}, salt=CURSOR_SALT, compress=True)

    def _position(self, cursor):
        if not cursor:
            return {}
        try:
            value = signing.loads(cursor, salt=CURSOR_SALT, max_age=3600)
            if not isinstance(value, dict) or value.get("binding") != self.binding:
                raise ValueError()
            return value
        except (signing.BadSignature, ValueError, TypeError):
            raise ResearchReadError("invalid_cursor", "Cursor is expired or belongs to another query/scope.") from None

    def _page(self, rows, project, *, cursor=None, limit=20):
        """Seek after scanned rows (including denied refs); never silently cap at 500."""
        position = self._position(cursor)
        if position:
            try:
                created = parse_datetime(position["created_at"])
                identity = UUID(position["id"])
                if created is None:
                    raise ValueError()
            except (KeyError, ValueError, TypeError):
                raise ResearchReadError("invalid_cursor", "Invalid list cursor.") from None
            rows = rows.filter(Q(created_at__gt=created) | Q(created_at=created, id__gt=identity))
        candidates = list(rows.order_by("created_at", "id")[:MAX_SCAN + 1])
        items, anchor, used, stopped = [], None, 0, False
        for row in candidates[:MAX_SCAN]:
            value = project(row)
            if value is not None:
                size = len(_json(value))
                if used + size > MAX_OUTPUT - 3000:
                    if not items:
                        raise ResearchReadError("response_too_large", "Resource projection exceeds the output budget.", 413)
                    stopped = True
                    break
                items.append(value)
                used += size
            anchor = {"created_at": row.created_at.isoformat(), "id": str(row.id)}
            if len(items) >= limit:
                stopped = row != candidates[-1] or len(candidates) > MAX_SCAN
                break
        more = stopped or len(candidates) > MAX_SCAN
        return {"data": items, "page": {"has_more": more,
                "next_cursor": self._cursor(**anchor) if more and anchor else None}}

    def _chain_data(self, chain):
        return {"id": str(chain.id), "project_id": str(chain.project_id),
                "title": _clip(chain.project.name), "status": chain.status,
                "visibility": chain.visibility, "owner_id": str(chain.owner_id),
                "node_count_in_scope": self.nodes(chain).count()}

    def _node_data(self, node):
        restricted = bool(self.grant and self.grant.chain_node_id)
        if self.authorization is not None and node.parent_node_id:
            restricted = not self.nodes().filter(pk=node.parent_node_id).exists()
        return {"id": str(node.id), "chain_id": str(node.chain_id), "project_id": str(node.chain.project_id),
                "title": _clip(node.title), "node_type": node.node_type, "status": node.status,
                "parent_node_id": str(node.parent_node_id) if node.parent_node_id and not restricted else None,
                "parent_outside_scope": bool(node.parent_node_id and restricted),
                "loop_iteration": node.loop_iteration,
                "assignee_id": str(node.assignee_id) if node.assignee_id else None}

    def list_research_chains(self, query=None, status=None, cursor=None, limit=20):
        rows = self.chains()
        if query:
            rows = rows.filter(project__name__icontains=query)
        if status:
            rows = rows.filter(status=status)
        return self._page(rows, self._chain_data, cursor=cursor, limit=limit)

    def get_research_chain(self, chain_id):
        return {"data": self._chain_data(self.chain(chain_id))}

    def list_research_nodes(self, chain_id, status=None, node_type=None, cursor=None, limit=20):
        rows = self.nodes(self.chain(chain_id))
        if status:
            rows = rows.filter(status=status)
        if node_type:
            rows = rows.filter(node_type=node_type)
        return self._page(rows, self._node_data, cursor=cursor, limit=limit)

    def _references(self, node, refs):
        result = []
        for raw in refs[:4] if isinstance(refs, list) else []:
            ref = normalise_reference(raw)
            if ref is not None:
                obj = self._lookup(node, ref["kind"], ref["id"])
                if obj is not None and self._allowed(node, ref["kind"], obj):
                    result.append({**ref, "content_available": ref["kind"] in CONTENT_KINDS})
        return result

    def _event_data(self, node, event):
        return {"id": str(event.id), "event_id": event.event_id, "node_id": str(node.id), "event_type": event.event_type,
                "occurred_at": event.occurred_at.isoformat(), "source_system": event.source_system,
                "summary": _clip(event.summary, 500), "summary_truncated": len(event.summary) > 500,
                "content_ref": {"kind": "event", "id": str(event.id), "node_id": str(node.id)},
                "source_content_hash": event.content_hash,
                "refs": self._references(node, event.refs),
                "refs_truncated": isinstance(event.refs, list) and len(event.refs) > 4}

    def get_research_node_context(self, node_id):
        node = self.node(node_id)
        types = {
            "input": None, "ai_action": ("AI_ACTION", "TOOL_CALL"),
            "intermediate": ("INTERMEDIATE_ARTIFACT",),
            "validation": ("VALIDATION", "VALIDATION_PASSED", "VALIDATION_FAILED"),
            "human_decision": ("HUMAN_DECISION", "APPROVAL"), "output": ("OUTPUT", "DATA_CHANGE"),
        }
        sections = []
        for kind, codes in types.items():
            rows = self._candidates(node, "event")
            rows = rows.exclude(refs=[]) if codes is None else rows.filter(event_type__in=codes)
            sample = list(rows.order_by("-created_at", "-id")[:2])
            sections.append({"kind": kind, "sample": [self._event_data(node, row) for row in sample],
                             "sample_only": True})
        # Output-only snapshots are still discoverable when no OUTPUT event exists.
        snapshots = [{"id": str(row.snapshot_id), "version": row.version, "summary": _clip(row.summary)}
                     for row in self._candidates(node, "snapshot").order_by("-created_at", "-id")[:3]]
        return {"data": {"node": self._node_data(node), "evidence_sections": sections,
                         "snapshot_sample": snapshots, "read_only": True,
                         "scope_kind": ("node" if self.grant.chain_node_id else "project") if self.grant else "visible_projects",
                         "next_tools": ["list_research_node_events", "list_research_node_snapshots",
                                        "list_research_node_tasks", "list_research_node_resources"]}}

    def list_research_node_events(self, node_id, event_type=None, cursor=None, limit=20):
        node = self.node(node_id)
        rows = self._candidates(node, "event")
        if event_type:
            rows = rows.filter(event_type=event_type)
        return self._page(rows, lambda row: self._event_data(node, row), cursor=cursor, limit=limit)

    def _snapshot_data(self, node, row):
        return {"id": str(row.snapshot_id), "node_id": str(node.id), "type": row.snapshot_type,
                "version": row.version, "summary": _clip(row.summary, 1200), "immutable": row.immutable,
                "summary_truncated": len(row.summary) > 1200, "source_content_hash": row.content_hash,
                "source_versions": self._references(node, row.source_versions),
                "resources": self._references(node, row.resources),
                "source_versions_truncated": len(row.source_versions) > 4,
                "resources_truncated": len(row.resources) > 4, "created_at": row.created_at.isoformat()}

    def list_research_node_snapshots(self, node_id, type=None, cursor=None, limit=20):
        node = self.node(node_id)
        rows = self._candidates(node, "snapshot")
        if type:
            rows = rows.filter(snapshot_type=type)
        return self._page(rows, lambda row: self._snapshot_data(node, row), cursor=cursor, limit=limit)

    def list_research_node_tasks(self, node_id, status=None, cursor=None, limit=20):
        node = self.node(node_id)
        rows = self._candidates(node, "task")
        if status:
            rows = rows.filter(status=status)
        return self._page(rows, lambda row: {
            "id": str(row.id), "node_id": str(node.id), "title": _clip(row.title),
            "instruction": _clip(_instruction_text(row), 2000),
            "instruction_truncated": len(_instruction_text(row)) > 2000,
            "content_ref": {"kind": "task", "id": str(row.id), "node_id": str(node.id)},
            "status": row.status, "assignee_id": str(row.assignee_id) if row.assignee_id else None,
            "due_at": row.due_at.isoformat() if row.due_at else None,
            "resource_refs": self._references(node, [{"kind": row.resource_type, "id": str(row.resource_id)}]),
        }, cursor=cursor, limit=limit)

    def list_research_task_comments(self, task_id, cursor=None, limit=20):
        task = ResearchChainNodeTask.objects.filter(
            pk=task_id, workspace=self.workspace, node__in=self.nodes(), chain__in=self.chains(),
        ).first()
        if task is None:
            raise ResearchReadError("not_found", "Research task not found in the current scope.", 404)
        if not self._candidates(task.node, "task").filter(pk=task.pk).exists():
            raise ResearchReadError("not_found", "Research task not found in the current scope.", 404)
        return self._page(self._candidates(task.node, "task_comment").filter(task=task).select_related("actor"), lambda row: {
            "id": str(row.id), "task_id": str(task.id), "actor_id": str(row.actor_id),
            "author": _clip(row.actor.display_name, 100), "text": _clip(row.comment_stripped, 2000),
            "content_ref": {"kind": "task_comment", "id": str(row.id), "node_id": str(task.node_id)},
            "text_truncated": len(row.comment_stripped) > 2000, "created_at": row.created_at.isoformat(),
        }, cursor=cursor, limit=limit)

    def list_research_report_feedback(self, cursor=None, limit=20):
        """Read explicit report-comment feedback within the pinned Context scope.

        Args:
            cursor: Opaque pagination cursor from a previous page.
            limit: Page size requested by the Agent plugin.

        Returns:
            A bounded feedback page containing only explicit human submissions.
        """
        if self.grant is None:
            raise ResearchReadError("scope_denied", "This tool requires a research context grant.", 403)
        allowed = {
            str(item.get("report_id")): int(item.get("version_no") or 0)
            for item in self.grant.allowed_reports
        }
        rows = (
            PeriodicReportCommentFeedback.objects.filter(
                report__workspace=self.workspace,
                report__deleted_at__isnull=True,
                thread__deleted_at__isnull=True,
                comment__deleted_at__isnull=True,
                status=PeriodicReportCommentFeedback.Status.SUBMITTED,
                deleted_at__isnull=True,
            )
            .select_related("report", "thread", "comment", "submitted_by", "agent_session")
            .order_by("created_at", "id")
        )

        def project(feedback):
            report_id = str(feedback.report_id)
            expected_version = allowed.get(report_id)
            if expected_version is None or feedback.thread.snapshot_version != expected_version:
                return None
            if not check_access(self.user, "view", report_resource(feedback.report), context=self.actor):
                return None
            payload = dict(feedback.payload or {})
            comment_payload = dict(payload.get("comment") or {})
            original_text = str(comment_payload.get("text") or "")
            original_html = str(comment_payload.get("html") or "")
            comment_payload["text"] = _clip(original_text, 8000)
            comment_payload["html"] = _clip(original_html, 8000)
            comment_payload["truncated"] = len(original_text) > 8000 or len(original_html) > 8000
            payload["comment"] = comment_payload
            return {
                "id": str(feedback.id),
                "feedback_type": feedback.feedback_type,
                "status": feedback.status,
                "submitted_at": feedback.submitted_at.isoformat(),
                "report_ref": {
                    "kind": "report",
                    "id": report_id,
                    "version": feedback.thread.snapshot_version,
                },
                "thread_id": str(feedback.thread_id),
                "comment_id": str(feedback.comment_id),
                "payload": payload,
            }

        return self._page(rows, project, cursor=cursor, limit=limit)

    def _candidates(self, node, kind):
        rows = self._raw_candidates(node, kind)
        return self.authorization.scoped_resources(rows, node, kind) if self.authorization is not None else rows

    def _raw_candidates(self, node, kind):
        model = MODELS[kind]
        if kind in {"analysis", "upload", "paper_review", "task"}:
            return model.objects.filter(node=node, chain=node.chain, workspace=self.workspace)
        if kind == "task_comment":
            return model.objects.filter(task__node=node, task__chain=node.chain, task__workspace=self.workspace,
                                        task__deleted_at__isnull=True)
        if kind == "event":
            return model.objects.filter(node=node, chain=node.chain)
        if kind == "snapshot":
            return model.objects.filter(node=node, chain=node.chain)
        if kind == "agent_event":
            return model.objects.filter(session__chain_node=node, session__workspace=self.workspace,
                                        session__project_id=node.chain.project_id,
                                        session__deleted_at__isnull=True).select_related("session")
        if kind == "stage_material":
            return model.objects.filter(stage_instance__project_id=node.chain.project_id,
                                        stage_instance__workspace=self.workspace,
                                        stage_instance__deleted_at__isnull=True).select_related(
                                            "stage_instance__project__research_profile", "page")
        if kind == "external_reference":
            return model.objects.filter(workspace=self.workspace)
        if kind == "report":
            return model.objects.filter(Q(project_id=node.chain.project_id) | Q(team_projects=node.chain.project_id),
                                        workspace=self.workspace).distinct().prefetch_related("official_snapshots", "access_grants")
        if kind == "topic_material":
            return model.objects.filter(workspace=self.workspace, project_id=node.chain.project_id,
                                        entity_type="RESEARCH_TOPIC_MATERIAL", is_uploaded=True, is_deleted=False)
        return model.objects.filter(workspace=self.workspace, project_id=node.chain.project_id).select_related(
            "project__research_profile", "stage_instance")

    def _lookup(self, node, kind, identity):
        key = (str(node.id), kind, identity)
        if key not in self._reference_cache:
            field = "snapshot_id" if kind == "snapshot" else "pk"
            self._reference_cache[key] = self._candidates(node, kind).filter(**{field: identity}).first()
        return self._reference_cache[key]

    def _linked(self, node, kind, obj):
        if kind in {"analysis", "snapshot", "upload", "paper_review", "agent_event", "event", "task", "task_comment"}:
            return True  # _candidates already constrained the real foreign keys.
        identity = str(obj.id)
        aliases = [name for name, target in ALIASES.items() if target == kind]
        names = [kind, kind.upper(), *aliases, *[name.upper() for name in aliases]]
        event_q, snapshot_q = Q(pk__in=[]), Q(pk__in=[])
        for name in names:
            for key in ("kind", "type", "resource_type"):
                for id_key in ("id", "resource_id"):
                    value = [{key: name, id_key: identity}]
                    event_q |= Q(refs__contains=value)
                    snapshot_q |= Q(resources__contains=value) | Q(source_versions__contains=value)
        task_kind = {"report": "REPORT", "stage_material": "STAGE_MATERIAL",
                     "external_reference": "EXTERNAL_REF"}.get(kind)
        if task_kind and ResearchChainNodeTask.objects.filter(
            node=node, chain=node.chain, resource_type=task_kind, resource_id=obj.id,
        ).exists():
            return True
        return node.events.filter(event_q).exists() or node.snapshots.filter(snapshot_q).exists()

    def _allowed(self, node, kind, obj):
        if not self._linked(node, kind, obj):
            return False
        if kind == "experiment":
            return check_access(self.user, "view", experiment_resource(obj), context=self.actor) or can_manage_team_content(
                self.user, obj.project.research_profile, obj)
        if kind == "report":
            if self.grant and not any(str(item.get("report_id")) == str(obj.id) for item in self.grant.allowed_reports):
                return False
            return check_access(self.user, "view", report_resource(obj), context=self.actor)
        if kind == "stage_material":
            return check_access(self.user, "view", material_resource(obj, with_reviewers=True), context=self.actor)
        if kind == "external_reference":
            return obj.status != "REVOKED" and reference_allowed(obj, self.user, self.workspace.id, context=self.actor)
        if kind == "agent_event":
            return public_agent_fields(obj) is not None
        return True

    def _resource_data(self, node, kind, obj):
        if not self._allowed(node, kind, obj):
            return None
        version = obj.version if kind == "snapshot" else None
        report_version_changed = False
        if kind == "report":
            versions = self.authorization.report_versions(obj) if self.authorization is not None else obj.official_snapshots.all()
            latest = versions.order_by("-version_no").first()
            if latest is None:
                return None
            version = latest.version_no
            if self.authorization is not None:
                current = obj.official_snapshots.order_by("-version_no").first()
                report_version_changed = current is not None and current.version_no != version
            if self.grant:
                version = next(item["version_no"] for item in self.grant.allowed_reports if str(item.get("report_id")) == str(obj.id))
        title = (obj.file_name if kind == "upload" else f"{obj.period_key} {obj.report_type}" if kind == "report"
                 else (obj.attributes or {}).get("name") if kind == "topic_material"
                 else getattr(obj, "title", None) or getattr(obj, "method", None) or kind)
        data = {"id": str(obj.snapshot_id if kind == "snapshot" else obj.id), "kind": kind,
                "node_id": str(node.id), "title": _clip(title), "version": version,
                "status": getattr(obj, "status", None), "content_available": kind in CONTENT_KINDS,
                "content_state": "readable" if kind in CONTENT_KINDS else "metadata_only"}
        if report_version_changed:
            # The shared report reader intentionally accepts only the latest
            # formal version. A frozen connection must not silently adopt it.
            data.update(content_available=False, content_state="version_changed")
        if kind == "upload":
            data.update(file_type=obj.file_type, size_bytes=obj.file_size, parsed_content_available=False)
        elif kind == "topic_material":
            data.update(size_bytes=obj.size, parsed_content_available=False)
        elif kind == "paper_review":
            data["current_version_no"] = obj.current_version_no
        elif kind == "experiment":
            data.update(current_version_no=obj.current_version_no, submitted=obj.submitted_at is not None)
        elif kind == "external_reference":
            data.update(source_system=obj.system, external_id=obj.external_id, external_type=obj.external_type)
        elif kind == "agent_event":
            data.update(version=1, event_type=obj.event_type, seq=obj.seq,
                        run_id=str(obj.run_id), session_id=str(obj.session.session_id))
        return data

    def list_research_node_resources(self, node_id, kind, cursor=None, limit=20):
        node = self.node(node_id)
        return self._page(self._candidates(node, kind), lambda obj: self._resource_data(node, kind, obj),
                          cursor=cursor, limit=limit)

    def _content(self, node, kind, obj, version):
        if kind in {"task", "task_comment", "event"}:
            if version is not None:
                raise ResearchReadError("version_invalid", "This resource has no numbered versions; use its content hash.")
            if kind == "task":
                return {"title": obj.title, "instruction": _instruction_text(obj), "status": obj.status,
                        "record_state": "current"}, None
            if kind == "task_comment":
                return {"text": obj.comment_stripped, "created_at": obj.created_at.isoformat(),
                        "edited_at": obj.edited_at.isoformat() if obj.edited_at else None}, None
            return {"event_id": obj.event_id, "event_type": obj.event_type, "summary": obj.summary,
                    "source_system": obj.source_system, "occurred_at": obj.occurred_at.isoformat(),
                    "refs": self._references(node, obj.refs), "refs_truncated": len(obj.refs) > 4,
                    "source_content_hash": obj.content_hash}, None
        if kind == "analysis":
            if version not in (None, 1):
                raise ResearchReadError("not_found", "Analysis version not found.", 404)
            return {"method": obj.method, "summary": obj.summary, "conclusion": obj.conclusion,
                    "metrics": obj.metrics, "quality": obj.quality, "status": obj.status,
                    "tool_version": obj.tool_version, "input_refs": self._references(node, obj.input_refs)}, 1
        if kind == "snapshot":
            if version not in (None, obj.version):
                raise ResearchReadError("version_changed", "Snapshot version does not match.", 409)
            return {"summary": obj.summary, "type": obj.snapshot_type, "immutable": obj.immutable,
                    "resources": self._references(node, obj.resources),
                    "source_versions": self._references(node, obj.source_versions)}, obj.version
        if kind == "agent_event":
            if version not in (None, 1):
                raise ResearchReadError("not_found", "Event version not found.", 404)
            public = public_agent_fields(obj)
            if public is None:
                raise ResearchReadError("not_found", "No public event content is available.", 404)
            return {"event_type": obj.event_type, "seq": obj.seq,
                    "run_id": str(obj.run_id), "session_id": str(obj.session.session_id), **public}, 1
        if kind == "experiment":
            if version is None:
                fields = ("title", "objective", "hypothesis", "method", "parameters", "environment",
                          "result", "metrics", "conclusion", "failure_reason", "status")
                return {**{key: getattr(obj, key) for key in fields}, "record_state": "current",
                        "submitted": obj.submitted_at is not None}, None
            snapshot = obj.versions.filter(version_no=version).first()
            if snapshot is None:
                raise ResearchReadError("not_found", "Experiment version not found.", 404)
            return snapshot.snapshot, snapshot.version_no
        if kind == "report":
            if version is None:
                raise ResearchReadError("version_required", "Select an explicit formal report version.")
            if self.grant and not any(str(item.get("report_id")) == str(obj.id) and item.get("version_no") == version
                                      for item in self.grant.allowed_reports):
                raise ResearchReadError("scope_denied", "This formal report version is not granted.", 403)
            if self.authorization is not None and not self.authorization.report_versions(obj).filter(version_no=version).exists():
                raise ResearchReadError("scope_denied", "This formal report version is outside the connection scope.", 403)
            try:
                report = selected_report_content(workspace=self.workspace, actor=self.user,
                    project_id=node.chain.project_id, selections=[{"report_id": str(obj.id), "version_no": version}])[0]
            except ResearchReportContextError as exc:
                raise ResearchReadError(exc.code, str(exc), exc.status_code) from None
            return {"title": report["title"], "text": report["text"], "attachments_parsed": False}, version
        raise ResearchReadError("unsupported_content", "Only metadata is available; file/external body parsing is not implemented.", 422)

    def read_research_resource(self, node_id, kind, resource_id, version=None, cursor=None, max_chars=8000):
        node = self.node(node_id)
        obj = self._lookup(node, kind, resource_id)
        if obj is None or not self._allowed(node, kind, obj):
            raise ResearchReadError("not_found", "Resource not found in this node's authorised references.", 404)
        value, actual_version = self._content(node, kind, obj, version)
        text = _json(value)
        digest = hashlib.sha256(text.encode()).hexdigest()
        position = self._position(cursor)
        if position and position.get("content_hash") != digest:
            raise ResearchReadError("version_changed", "Resource changed while reading; restart from a fresh reference.", 409)
        offset = position.get("offset", 0)
        if type(offset) is not int or offset < 0 or offset > len(text):
            raise ResearchReadError("invalid_cursor", "Invalid content offset.")
        end = min(offset + max_chars, len(text))
        more = end < len(text)
        self._truncated = more
        return {"data": {"kind": kind, "id": resource_id, "node_id": node_id, "version": actual_version,
                         "content_format": "json_text", "text": text[offset:end], "content_hash": digest,
                         "complete": not more, "offset": offset},
                "page": {"has_more": more,
                         "next_cursor": self._cursor(offset=end, content_hash=digest) if more else None}}


def node_report_selections(workspace, user, node):
    """Pin only explicitly linked, currently readable formal reports for a new session."""
    service = ResearchReadService(workspace=workspace, user=user)
    result = []
    for report in service._candidates(node, "report").iterator(chunk_size=100):
        if service._allowed(node, "report", report):
            latest = report.official_snapshots.order_by("-version_no").first()
            if latest is not None:
                result.append({"report_id": str(report.id), "version_no": latest.version_no})
        if len(result) == 50:
            break
    return result
