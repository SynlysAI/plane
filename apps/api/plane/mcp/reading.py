"""Bounded unified navigation over the existing native business read services."""

import hashlib
import json
from functools import partial
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID

from django.conf import settings
from django.core import signing
from django.db.models import Q
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from plane.db.models import (
    FileAsset,
    Issue,
    IssueActivity,
    IssueComment,
    IssueLink,
    ProjectMember,
    Workspace,
)
from plane.mcp.authorization import (
    UnifiedReadAuthorization,
    active_connection,
    scoped_administrative_projects,
    workspace_access,
)
from plane.mcp.catalog import validate
from plane.research.services.chain_context import ResearchReadService, _instruction_text
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.utils.role_resolution import resolve_role_context
from plane.research.utils.audit import record_audit_event
from plane.utils.administrative_projects import active_issue_assignees

VERSION = "plane.unified-mcp.v2"
SALT = "plane.unified-mcp.page.v1"
MAX_OUTPUT = 24000


def encode(value):
    return json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))


def web_origin():
    return str(getattr(settings, "WEB_URL", "") or getattr(settings, "APP_URL", "")).rstrip("/")


class UnifiedReadService:
    def __init__(self, connection):
        self.connection = connection
        self.user = connection.owner
        self.readers = {}

    def execute(self, name, arguments):
        self.args = validate(name, arguments)
        current = active_connection(self.connection.pk)
        if current is None:
            raise ResearchReadError("scope_denied", "Connection is no longer valid.", 403)
        self.connection, self.user = current, current.owner
        self.readers = {}  # ACL projections are never reused across invocations.
        self.name = name
        self.binding = hashlib.sha256(
            encode(
                {
                    "id": str(current.pk),
                    "scope": current.scope,
                    "owner": str(self.user.pk),
                    "tool": name,
                    "arguments": {k: v for k, v in self.args.items() if k != "cursor"},
                }
            ).encode()
        ).hexdigest()
        self.position = self.position_for(self.args.get("cursor"))
        dispatch = {
            "plane_list_workspaces": self.workspaces,
            "plane_list_containers": self.containers,
            "plane_list_nodes": self.nodes,
            "plane_list_tasks": self.tasks,
            "plane_get_context": self.context,
            "plane_read_resource": self.resource,
        }
        value = {
            "schema_version": VERSION,
            **dispatch[name](),
            "retrieved_at": timezone.now().isoformat(),
            "content_policy": "untrusted_reference_data",
        }
        value.setdefault("truncated", False)
        if len(encode(value)) > MAX_OUTPUT:
            raise ResearchReadError("response_too_large", "Reduce the page size or requested content size.", 413)
        if hasattr(self, "audit_workspace"):
            record_audit_event(
                workspace=self.audit_workspace,
                actor=self.user,
                action="mcp.read",
                resource_type="unified_mcp_connection",
                resource_id=current.pk,
                metadata={"tool": name, "outcome": "success"},
            )
        return value

    def position_for(self, cursor):
        if not cursor:
            return {}
        try:
            state = signing.loads(cursor, salt=SALT, max_age=3600)
            if not isinstance(state, dict) or state.get("binding") != self.binding:
                raise ValueError()
            return state
        except (signing.BadSignature, ValueError, TypeError):
            raise ResearchReadError(
                "invalid_cursor", "Cursor is expired or belongs to another query or connection."
            ) from None

    def cursor(self, **state):
        return signing.dumps({"binding": self.binding, **state}, salt=SALT, compress=True)

    def page(self, groups):
        """Seek in querysets before projection; advance past denied references."""
        result, used, scanned, more, anchor = [], 0, 0, False, None
        limit = self.args.get("limit", 20)
        for group, rows, project in groups:
            if self.position.get("group", "") > group:
                continue
            if self.position.get("group") == group:
                try:
                    created = parse_datetime(self.position["created_at"])
                    identity = UUID(self.position["id"])
                    if created is None:
                        raise ValueError()
                except (ValueError, KeyError, TypeError):
                    raise ResearchReadError("invalid_cursor", "Invalid pagination position.") from None
                rows = rows.filter(Q(created_at__gt=created) | Q(created_at=created, pk__gt=identity))
            if len(result) >= limit:
                more = rows.exists()
                if more:
                    break
                continue
            candidates = list(rows.order_by("created_at", "pk")[:201])
            for index, row in enumerate(candidates):
                if scanned >= 200:
                    more = True
                    break
                value = project(row)
                size = len(encode(value)) if value is not None else 0
                if value is not None and used + size > MAX_OUTPUT - 3000:
                    if not result:
                        raise ResearchReadError(
                            "response_too_large", "Object projection exceeds the response budget.", 413
                        )
                    more = True
                    break
                if value is not None:
                    result.append(value)
                    used += size
                scanned += 1
                anchor = {"group": group, "created_at": row.created_at.isoformat(), "id": str(row.pk)}
                if len(result) >= limit:
                    more = index + 1 < len(candidates)
                    break
            if more:
                break
        return {
            "data": result,
            "page": {"has_more": more, "next_cursor": self.cursor(**anchor) if more and anchor else None},
        }

    def workspace(self, slug):
        workspace = Workspace.objects.filter(slug=slug).first()
        if workspace is None or not any(
            entry["workspace_id"] == str(workspace.pk) for entry in self.connection.scope["workspaces"]
        ):
            raise ResearchReadError("not_found", "Workspace not found in connection scope.", 404)
        workspace_access(self.user, workspace, "administrative")
        self.audit_workspace = workspace
        return workspace

    def reader(self, workspace):
        key = str(workspace.pk)
        if key not in self.readers:
            auth = UnifiedReadAuthorization(self.connection, workspace)
            self.readers[key] = ResearchReadService(workspace=workspace, user=self.user, authorization=auth)
        return self.readers[key]

    def cutoff(self, rows):
        if not self.connection.scope["include_future_objects"]:
            rows = rows.filter(created_at__lte=parse_datetime(self.connection.scope["snapshot_at"]))
        return rows

    def issues(self, workspace):
        rows = Issue.issue_objects.filter(
            workspace=workspace, project__in=scoped_administrative_projects(self.connection, workspace)
        ).select_related("project", "state")
        # The native guest restriction is per project, including effective inherited roles.
        guest_ids = ProjectMember.objects.filter(workspace=workspace, member=self.user, is_active=True, role=5).values(
            "project_id"
        )
        # Effective administrator/organization roles supersede a direct guest row.
        from plane.utils.administrative_projects import (
            administrative_projects_for_user,
            administrative_organization_project_ids,
            public_administrative_project_ids,
        )

        restricted = Q(project_id__in=guest_ids, project__guest_view_all_features=False) & ~Q(created_by=self.user)
        inherited = (
            Q(project_id__in=administrative_projects_for_user(self.user, workspace.slug).values("id"))
            | Q(project_id__in=administrative_organization_project_ids(self.user, workspace.slug))
            | Q(project_id__in=public_administrative_project_ids(self.user, workspace.slug))
        )
        return self.cutoff(rows.exclude(restricted & ~inherited))

    @staticmethod
    def reference(domain, kind, obj, workspace):
        return {"domain": domain, "object_type": kind, "workspace_slug": workspace.slug, "id": str(obj.pk)}

    def base(self, obj, workspace, domain, kind, name, parent, url, status=None):
        return {
            **self.reference(domain, kind, obj, workspace),
            "name": str(name or "")[:500],
            "parent": parent,
            "status": status,
            "url": url,
            "allowed_actions": self.actions(obj, workspace, domain, kind),
        }

    def actions(self, obj, workspace, domain, kind):
        if domain == "research":
            from plane.mcp.research_capabilities import actions_for

            return actions_for(self.connection, workspace, kind, obj)
        if domain != "administrative" or kind not in {"Project", "Issue"}:
            return []
        entry = next(
            (entry for entry in self.connection.scope["workspaces"] if entry["workspace_id"] == str(workspace.pk)), {}
        )
        if entry.get("domains", {}).get("administrative") != "read_write":
            return []
        from plane.utils.issue_mutations import issue_action_allowed
        from plane.utils.administrative_projects import assignable_project_member_ids

        project = obj if kind == "Project" else obj.project
        actions = []
        if issue_action_allowed(self.user, project, "create") and assignable_project_member_ids(project).exists():
            actions.append("create_task")
        if kind == "Issue":
            if issue_action_allowed(self.user, project, "update", obj):
                actions.extend(["update_task", "set_state"])
            if issue_action_allowed(self.user, project, "comment", obj):
                actions.append("add_comment")
        return actions

    def administrative_capabilities(self, workspace, kind, target):
        from plane.db.models import Label, Module, State, User
        from plane.mcp.catalog import ADMIN_FIELDS
        from plane.utils.administrative_projects import assignable_project_member_ids

        project = target if kind == "Project" else target.project
        actions = self.actions(target, workspace, "administrative", kind)
        members = User.objects.filter(pk__in=assignable_project_member_ids(project))
        relation_write_available = bool({"create_task", "update_task"} & set(actions))
        if not relation_write_available:
            members = members.none()
        modules = (
            Module.objects.filter(project=project, archived_at__isnull=True, deleted_at__isnull=True)
            if relation_write_available
            else Module.objects.none()
        )
        labels = (
            Label.objects.filter(project=project, deleted_at__isnull=True)
            if relation_write_available
            else Label.objects.none()
        )
        if "query" in self.args:
            members = members.filter(
                Q(display_name__icontains=self.args["query"]) | Q(first_name__icontains=self.args["query"])
            )
            modules = modules.filter(name__icontains=self.args["query"])
            labels = labels.filter(name__icontains=self.args["query"])
        states = (
            State.objects.filter(project=project, workspace=workspace)
            if "set_state" in actions
            else State.objects.none()
        )
        options = self.page(
            [
                (
                    "assignee",
                    members,
                    lambda row: {
                        "option_type": "assignee",
                        "id": str(row.pk),
                        "display_name": row.display_name or row.first_name or str(row.pk),
                    },
                ),
                (
                    "module",
                    modules,
                    lambda row: {"option_type": "module", "id": str(row.pk), "name": row.name, "action": "module_ids"},
                ),
                (
                    "label",
                    labels,
                    lambda row: {"option_type": "label", "id": str(row.pk), "name": row.name, "action": "label_ids"},
                ),
                (
                    "state",
                    states,
                    lambda row: {
                        "option_type": "state",
                        "id": str(row.pk),
                        "name": row.name,
                        "group": row.group,
                        "action": "set_state",
                    },
                ),
            ]
        )
        state_options = [option for option in options["data"] if option["option_type"] == "state"]
        return {
            "data": {
                "allowed_actions": actions,
                "editable_fields": list(ADMIN_FIELDS) if "update_task" in actions else [],
                "create_fields": list(ADMIN_FIELDS) if "create_task" in actions else [],
                "assignable_users": [option for option in options["data"] if option["option_type"] == "assignee"],
                "module_options": [option for option in options["data"] if option["option_type"] == "module"],
                "label_options": [option for option in options["data"] if option["option_type"] == "label"],
                "state_options": state_options,
                "transition_options": state_options,
                "required_fields": {
                    "create_task": ["parent", "request_id", "name"]
                    + (["module_ids"] if project.is_module_required else [])
                    + (["label_ids"] if project.is_label_required else []),
                    "add_comment": ["target", "request_id", "comment_html"],
                    "set_state": ["target", "action", "state_id"],
                },
                "execution_mode": "direct" if actions else "read_only",
            },
            "page": options["page"],
        }

    def project_data(self, project, workspace):
        return {
            **self.base(
                project,
                workspace,
                "administrative",
                "Project",
                project.name,
                self.reference("administrative", "Workspace", workspace, workspace),
                f"{web_origin()}/{workspace.slug}/projects/{project.pk}/",
                None,
            ),
            "module_view": project.module_view,
            "is_module_required": project.is_module_required,
            "is_label_required": project.is_label_required,
        }

    def chain_data(self, chain, workspace):
        reader = self.reader(workspace)
        return {
            **self.base(
                chain,
                workspace,
                "research",
                "ResearchChain",
                chain.project.name,
                self.reference("research", "Workspace", workspace, workspace),
                f"{web_origin()}/{workspace.slug}/research/chains/{chain.pk}/",
                chain.status,
            ),
            "project_id": str(chain.project_id),
            "node_count_in_scope": reader.nodes(chain).count(),
        }

    def node_data(self, node, workspace):
        native = self.reader(workspace)._node_data(node)
        return {
            **native,
            **self.base(
                node,
                workspace,
                "research",
                "ResearchChainNode",
                node.title,
                self.reference("research", "ResearchChain", node.chain, workspace),
                f"{web_origin()}/{workspace.slug}/research/chains/{node.chain_id}/?tab=nodes&node={node.pk}",
                node.status,
            ),
        }

    def issue_data(self, issue, workspace):
        parent = self.reference("administrative", "Project", issue.project, workspace)
        outside = False
        if issue.parent_id:
            accessible = self.issues(workspace).filter(pk=issue.parent_id).first()
            if accessible is not None:
                parent = self.reference("administrative", "Issue", accessible, workspace)
            else:
                outside = True
        state = (
            {"id": str(issue.state_id), "name": issue.state.name, "group": issue.state.group}
            if issue.state_id
            else None
        )
        return {
            **self.base(
                issue,
                workspace,
                "administrative",
                "Issue",
                issue.name,
                parent,
                f"{web_origin()}/{workspace.slug}/projects/{issue.project_id}/issues/{issue.pk}",
                state,
            ),
            "project_id": str(issue.project_id),
            "parent_outside_scope": outside,
            "priority": issue.priority,
            "start_date": issue.start_date,
            "target_date": issue.target_date,
            "assignee_ids": [
                str(pk) for pk in active_issue_assignees().filter(issue=issue).values_list("assignee_id", flat=True)
            ],
            "updated_at": issue.updated_at.isoformat(),
        }

    def task_data(self, task, workspace):
        return {
            **self.base(
                task,
                workspace,
                "research",
                "ResearchChainNodeTask",
                task.title,
                self.reference("research", "ResearchChainNode", task.node, workspace),
                f"{web_origin()}/{workspace.slug}/research/chains/{task.chain_id}/?tab=nodes&node={task.node_id}",
                task.status,
            ),
            "url_target": "parent",
            "chain_id": str(task.chain_id),
            "node_id": str(task.node_id),
            "project_id": str(task.chain.project_id),
            "assignee_id": str(task.assignee_id) if task.assignee_id else None,
            "due_at": task.due_at,
            "updated_at": task.updated_at.isoformat(),
        }

    def workspaces(self):
        ids = [entry["workspace_id"] for entry in self.connection.scope["workspaces"]]
        rows = Workspace.objects.filter(pk__in=ids)
        if self.args.get("query"):
            rows = rows.filter(name__icontains=self.args["query"])

        def workspace_data(workspace):
            domains = self.available_domains(workspace)
            role_context = resolve_role_context(self.user, workspace) if domains else None
            return {
                **self.base(
                    workspace,
                    workspace,
                    "administrative",
                    "Workspace",
                    workspace.name,
                    None,
                    f"{web_origin()}/{workspace.slug}/",
                ),
                "domain": None,
                "domains": domains,
                "live_access": bool(domains),
                "unavailable_reason": None
                if domains
                else "Workspace membership, private access or module policy changed.",  # noqa: E501
                "role_context": role_context,
                "action_families": {
                    "administrative": ["read"]
                    + (["direct_write"] if domains.get("administrative") == "read_write" else []),  # noqa: E501
                    "research": ["read"]
                    + (["proposal_write", "lifecycle_write"] if domains.get("research") == "read_write" else []),  # noqa: E501
                },
            }

        return self.page(
            [
                (
                    "workspace",
                    rows,
                    workspace_data,
                )
            ]
        )

    def available_domains(self, workspace):
        entry = next(
            entry for entry in self.connection.scope["workspaces"] if entry["workspace_id"] == str(workspace.pk)
        )
        domains = {}
        for domain, mode in entry["domains"].items():
            try:
                workspace_access(self.user, workspace, domain)
                domains[domain] = mode
            except ResearchReadError:
                pass
        return domains

    def containers(self):
        workspace = self.workspace(self.args["workspace_slug"])
        wanted = self.args.get("domain", "all")
        available = self.available_domains(workspace)
        if wanted != "all" and wanted not in available:
            raise ResearchReadError("scope_denied", "Domain is not currently authorized.", 403)
        groups = []
        for domain in ("administrative", "research"):
            if domain not in available or wanted not in ("all", domain):
                continue
            if domain == "administrative":
                rows = scoped_administrative_projects(self.connection, workspace)
                if self.args.get("query"):
                    rows = rows.filter(name__icontains=self.args["query"])
                project = partial(self.project_data, workspace=workspace)
            else:
                rows = self.reader(workspace).chains()
                if self.args.get("query"):
                    rows = rows.filter(project__name__icontains=self.args["query"])
                project = partial(self.chain_data, workspace=workspace)
            groups.append((domain, rows, project))
        return self.page(groups)

    def resolve(self, reference):
        workspace = self.workspace(reference["workspace_slug"])
        domain, kind = reference["domain"], reference["object_type"]
        identity = reference.get("id")
        ancestry = {}
        if "url" in reference:
            try:
                link = urlsplit(reference["url"])
                allowed = {
                    (urlsplit(value).scheme, urlsplit(value).netloc)
                    for value in [web_origin(), str(getattr(settings, "APP_URL", ""))]
                    if value
                }
                if (
                    link.scheme not in {"http", "https"}
                    or link.username
                    or link.password
                    or (link.scheme, link.netloc) not in allowed
                    or link.fragment
                ):
                    raise ValueError()
                path = [unquote(part) for part in link.path.strip("/").split("/")]
                query = parse_qs(link.query, keep_blank_values=True)
                if path[0] != workspace.slug or any(len(values) != 1 for values in query.values()):
                    raise ValueError()
                if (
                    domain == "administrative"
                    and kind == "Issue"
                    and len(path) == 3
                    and path[1] == "browse"
                    and not query
                ):
                    identifier, sequence = path[2].rsplit("-", 1)
                    issue = (
                        self.issues(workspace).filter(project__identifier=identifier, sequence_id=int(sequence)).first()
                    )
                    if issue is None:
                        raise ValueError()
                    identity = str(issue.pk)
                elif domain == "administrative" and len(path) in (3, 5) and path[1] == "projects" and not query:
                    ancestry["project_id"] = str(UUID(path[2]))
                    if kind == "Project" and len(path) == 3:
                        identity = path[2]
                    elif kind == "Issue" and len(path) == 5 and path[3] == "issues":
                        identity = path[4]
                    else:
                        raise ValueError()
                elif (
                    domain == "research"
                    and len(path) == 4
                    and path[1:3] == ["research", "chains"]
                    and not (set(query) - {"tab", "node"})
                ):
                    ancestry["chain_id"] = str(UUID(path[3]))
                    if kind == "ResearchChain" and "node" not in query:
                        identity = path[3]
                    elif kind == "ResearchChainNode" and query.get("tab", ["nodes"]) == ["nodes"]:
                        identity = query["node"][0]
                    else:
                        raise ValueError()
                else:
                    raise ValueError()
                identity = str(UUID(identity))
            except (ValueError, IndexError, KeyError, TypeError):
                raise ResearchReadError(
                    "invalid_reference", "Use a known same-instance link with matching native type and workspace."
                ) from None
        if domain == "administrative":
            rows = (
                scoped_administrative_projects(self.connection, workspace)
                if kind == "Project"
                else self.issues(workspace)
            )
        else:
            reader = self.reader(workspace)
            if kind == "ResearchChain":
                rows = reader.chains()
            elif kind == "ResearchChainNode":
                rows = reader.nodes()
            else:
                from plane.db.models import ResearchChainNodeTask

                rows = self.cutoff(
                    ResearchChainNodeTask.objects.filter(
                        workspace=workspace, chain__in=reader.chains(), node__in=reader.nodes()
                    ).select_related("node", "chain__project")
                )
        target = rows.filter(pk=identity).first()
        if target is None:
            raise ResearchReadError("not_found", "Object not found in current scope.", 404)
        if (
            domain == "research"
            and kind == "ResearchChainNodeTask"
            and not reader._candidates(target.node, "task").filter(pk=target.pk).exists()
        ):
            raise ResearchReadError("not_found", "Task not found in current scope.", 404)
        for field, value in ancestry.items():
            actual = target.pk if kind in ("Project", "ResearchChain") else getattr(target, field)
            if str(actual) != value:
                raise ResearchReadError("not_found", "Object ancestry does not match the link.", 404)
        return workspace, kind, target

    def nodes(self):
        workspace, kind, container = self.resolve(self.args["container"])
        if kind == "Project":
            if "status" in self.args or "node_type" in self.args:
                raise ResearchReadError("invalid_arguments", "Administrative projects have no node status or type.")
            return {
                "data": [],
                "applicability": "not_applicable",
                "next_tool": {
                    "name": "plane_list_tasks",
                    "arguments": {"parent": self.reference("administrative", "Project", container, workspace)},
                },
            }
        rows = self.reader(workspace).nodes(container)
        for key, field in (("query", "title__icontains"), ("status", "status"), ("node_type", "node_type")):
            if key in self.args:
                rows = rows.filter(**{field: self.args[key]})
        return self.page([("node", rows, lambda row: self.node_data(row, workspace))])

    def tasks(self):
        workspace, kind, parent = self.resolve(self.args["parent"])
        if kind in ("Project", "Issue"):
            rows = self.issues(workspace).filter(project=parent if kind == "Project" else parent.project)
            if kind == "Issue":
                rows = rows.filter(parent=parent)
            if "state_id" in self.args:
                rows = rows.filter(state_id=self.args["state_id"])
            if "assignee_id" in self.args:
                rows = rows.filter(
                    pk__in=active_issue_assignees().filter(assignee_id=self.args["assignee_id"]).values("issue_id")
                )
            if "query" in self.args:
                rows = rows.filter(
                    Q(name__icontains=self.args["query"]) | Q(description_stripped__icontains=self.args["query"])
                )
            project = partial(self.issue_data, workspace=workspace)
        else:
            rows = self.reader(workspace)._candidates(parent, "task").select_related("node", "chain__project")
            for key, field in (("status", "status"), ("assignee_id", "assignee_id")):
                if key in self.args:
                    rows = rows.filter(**{field: self.args[key]})
            if "query" in self.args:
                rows = rows.filter(
                    Q(title__icontains=self.args["query"]) | Q(instruction__icontains=self.args["query"])
                )
            project = partial(self.task_data, workspace=workspace)
        return self.page([("task", rows, project)])

    def comments(self, task):
        return self.cutoff(
            IssueComment.objects.filter(
                issue=task, project_id=task.project_id, workspace_id=task.workspace_id
            ).select_related("actor")
        )

    def activities(self, task):
        return self.cutoff(
            IssueActivity.objects.filter(issue=task, project_id=task.project_id, workspace_id=task.workspace_id)
        )

    def comment_data(self, comment, workspace):
        return {
            **self.base(
                comment,
                workspace,
                "administrative",
                "IssueComment",
                "Comment",
                self.reference("administrative", "Issue", comment.issue, workspace),
                f"{web_origin()}/{workspace.slug}/projects/{comment.project_id}/issues/{comment.issue_id}",
            ),
            "url_target": "parent",
            "text": comment.comment_stripped[:2000],
            "text_truncated": len(comment.comment_stripped) > 2000,
            "actor_id": str(comment.actor_id) if comment.actor_id else None,
            "created_at": comment.created_at.isoformat(),
        }

    def activity_data(self, activity, workspace):
        return {
            **self.base(
                activity,
                workspace,
                "administrative",
                "IssueActivity",
                activity.verb,
                self.reference("administrative", "Issue", activity.issue, workspace),
                f"{web_origin()}/{workspace.slug}/projects/{activity.project_id}/issues/{activity.issue_id}",
            ),
            "url_target": "parent",
            "field": activity.field,
            "comment": activity.comment[:2000],
            "created_at": activity.created_at.isoformat(),
        }

    def research_resource_data(self, reader, node, kind, resource, workspace):
        native = reader._resource_data(node, kind, resource)
        if native is None:
            return None
        if kind == "event":
            native.update(reader._event_data(node, resource))
        elif kind == "snapshot":
            native.update(reader._snapshot_data(node, resource))
        return {
            **native,
            "domain": "research",
            "object_type": resource._meta.object_name,
            "workspace_slug": workspace.slug,
            "name": native["title"],
            "parent": self.reference("research", "ResearchChainNode", node, workspace),
            "url": f"{web_origin()}/{workspace.slug}/research/chains/{node.chain_id}/?tab=nodes&node={node.pk}",
            "url_target": "parent",
            "allowed_actions": [],
        }

    def context(self):
        workspace, kind, target = self.resolve(self.args["target"])
        section = self.args["section"]
        if "query" in self.args and section != "capabilities":
            raise ResearchReadError("invalid_arguments", "query is only supported for assignee candidates.")
        if "resource_kind" in self.args and not (kind == "ResearchChainNode" and section == "resources"):
            raise ResearchReadError("invalid_arguments", "resource_kind is only supported for node resources.")
        if section == "details":
            projections = {
                "Project": self.project_data,
                "Issue": self.issue_data,
                "ResearchChain": self.chain_data,
                "ResearchChainNode": self.node_data,
                "ResearchChainNodeTask": self.task_data,
            }
            data = projections[kind](target, workspace)
            if kind == "Issue":
                data.update(
                    description_excerpt=(target.description_stripped or "")[:2000],
                    description_truncated=len(target.description_stripped or "") > 2000,
                    content_ref={"kind": "issue_description", "id": str(target.pk)},
                )
            elif kind == "ResearchChainNodeTask":
                instruction = _instruction_text(target)
                data.update(
                    instruction_excerpt=instruction[:2000],
                    instruction_truncated=len(instruction) > 2000,
                    content_ref={"kind": "task", "id": str(target.pk), "node_id": str(target.node_id)},
                )
            return {"data": data}
        if section == "capabilities":
            if kind in {"Project", "Issue"}:
                return self.administrative_capabilities(workspace, kind, target)
            if kind in {"ResearchChainNode", "ResearchChainNodeTask"}:
                from plane.mcp.research_capabilities import capabilities

                return capabilities(self, workspace, kind, target)
            # Only capabilities that can actually be invoked in this release.
            return {
                "data": {
                    "allowed_actions": [],
                    "editable_fields": [],
                    "assignable_users": [],
                    "transition_options": [],
                    "execution_mode": "read_only",
                    "write_unavailable_reason": "No task actions apply to this object.",
                }
            }
        if kind == "Issue":
            if section == "comments":
                return self.page([("comment", self.comments(target), lambda row: self.comment_data(row, workspace))])
            if section == "events":
                return self.page(
                    [("activity", self.activities(target), lambda row: self.activity_data(row, workspace))]
                )
            if section == "resources":
                links = self.cutoff(IssueLink.objects.filter(issue=target, project=target.project, workspace=workspace))
                assets = self.cutoff(
                    FileAsset.objects.filter(
                        issue=target,
                        project=target.project,
                        workspace=workspace,
                        entity_type=FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
                        is_uploaded=True,
                        is_deleted=False,
                    )
                )

                def metadata(row):
                    is_link = isinstance(row, IssueLink)
                    return {
                        **self.base(
                            row,
                            workspace,
                            "administrative",
                            row._meta.object_name,
                            row.title if is_link else row.attributes.get("name", "Attachment"),
                            self.reference("administrative", "Issue", target, workspace),
                            self.issue_data(target, workspace)["url"],
                        ),
                        "url_target": "parent",
                        "content_state": "metadata_only",
                        "content_available": False,
                        **({"resource_url": row.url} if is_link else {"size_bytes": row.size}),
                    }

                return self.page([("asset", assets, metadata), ("link", links, metadata)])
        if kind in ("ResearchChainNode", "ResearchChainNodeTask"):
            reader = self.reader(workspace)
            node = target if kind == "ResearchChainNode" else target.node
            if section == "comments" and kind == "ResearchChainNodeTask":
                rows = reader._candidates(node, "task_comment").filter(task=target).select_related("actor")
                return self.page(
                    [
                        (
                            "comment",
                            rows,
                            lambda row: {
                                **self.research_resource_data(reader, node, "task_comment", row, workspace),
                                "text": row.comment_stripped[:2000],
                                "text_truncated": len(row.comment_stripped) > 2000,
                                "actor_id": str(row.actor_id),
                            },
                        )
                    ]
                )
            if section in ("resources", "events", "snapshots"):
                resource_kind = {"events": "event", "snapshots": "snapshot"}.get(
                    section, self.args.get("resource_kind")
                )
                if kind == "ResearchChainNodeTask" and section == "snapshots":
                    return {"data": [], "applicability": "not_applicable"}
                if kind == "ResearchChainNodeTask" and section == "resources":
                    from plane.research.services.chain_context import normalise_reference

                    bound = normalise_reference({"kind": target.resource_type, "id": str(target.resource_id)})
                    if bound is None:
                        return {"data": [], "page": {"has_more": False, "next_cursor": None}}
                    resource_kind = bound["kind"]
                if resource_kind is None:
                    raise ResearchReadError("invalid_arguments", "Select resource_kind for node resources.")
                rows = reader._candidates(node, resource_kind)
                if kind == "ResearchChainNodeTask":
                    rows = (
                        rows.filter(refs__contains=[{"kind": "task", "id": str(target.pk)}])
                        if section == "events"
                        else rows.filter(**{"snapshot_id" if resource_kind == "snapshot" else "pk": bound["id"]})
                    )
                return self.page(
                    [
                        (
                            resource_kind,
                            rows,
                            lambda row: self.research_resource_data(reader, node, resource_kind, row, workspace),
                        )
                    ]
                )
        if section == "operations":
            if kind in {"ResearchChainNode", "ResearchChainNodeTask"}:
                from plane.db.models import ResearchAgentOperation
                from plane.research.services.agent_operations import ResearchOperationService
                from plane.research.services.operation_authorization import UnifiedOperationAuthorization

                authorization = UnifiedOperationAuthorization(self.connection)
                service = ResearchOperationService(workspace=workspace, user=self.user, authorization=authorization)
                service.authenticate("list_research_operations")
                node = target if kind == "ResearchChainNode" else target.node
                rows = ResearchAgentOperation.objects.filter(
                    workspace=workspace, user=self.user, node=node, **authorization.operation_filters
                )

                def present_operation(operation):
                    try:
                        from plane.mcp.research_writing import proposal_projection

                        return proposal_projection(service.present(service.load(operation.pk)), workspace, node)
                    except ResearchReadError:
                        return None

                return self.page([("operation", rows, present_operation)])
            return {"data": [], "applicability": "not_applicable"}
        return {"data": [], "applicability": "not_applicable"}

    def resource(self):
        workspace, kind, parent = self.resolve(self.args["parent"])
        resource_kind, identity = self.args["kind"], self.args["resource_id"]
        version = None
        if kind == "Issue":
            if resource_kind == "issue_description":
                if identity != str(parent.pk):
                    raise ResearchReadError("not_found", "Issue description not found.", 404)
                body = {"html": parent.description_html, "text": parent.description_stripped or ""}
            else:
                rows = self.comments(parent) if resource_kind == "issue_comment" else self.activities(parent)
                row = rows.filter(pk=identity).first()
                if row is None:
                    raise ResearchReadError("not_found", "Resource not found in task scope.", 404)
                body = (
                    {"html": row.comment_html, "text": row.comment_stripped}
                    if resource_kind == "issue_comment"
                    else {
                        "verb": row.verb,
                        "field": row.field,
                        "comment": row.comment,
                        "old_value": row.old_value,
                        "new_value": row.new_value,
                    }
                )
        else:
            reader = self.reader(workspace)
            row = reader._lookup(parent, resource_kind, identity)
            if row is None or not reader._allowed(parent, resource_kind, row):
                raise ResearchReadError("not_found", "Resource not found in authorized node references.", 404)
            body, version = reader._content(parent, resource_kind, row, self.args.get("version"))
        content = encode(body)
        digest = hashlib.sha256(content.encode()).hexdigest()
        if self.position and self.position.get("content_hash") != digest:
            raise ResearchReadError("version_changed", "Resource changed while paging; restart the read.", 409)
        offset = self.position.get("offset", 0)
        if type(offset) is not int or not 0 <= offset <= len(content):
            raise ResearchReadError("invalid_cursor", "Invalid content offset.")
        end = min(offset + self.args.get("max_chars", 8000), len(content))
        more = end < len(content)
        resource_type = "Issue" if resource_kind == "issue_description" else row._meta.object_name
        native_parent = self.reference(self.args["parent"]["domain"], kind, parent, workspace)
        parent_data = self.issue_data(parent, workspace) if kind == "Issue" else self.node_data(parent, workspace)
        return {
            "data": {
                "domain": self.args["parent"]["domain"],
                "object_type": resource_type,
                "id": identity,
                "parent": native_parent,
                "name": resource_kind,
                "status": parent_data["status"]
                if resource_kind == "issue_description"
                else getattr(row, "status", None),
                "url": parent_data["url"],
                "url_target": "parent",
                "allowed_actions": [],
                "kind": resource_kind,
                "version": version,
                "content_format": "json_text",
                "text": content[offset:end],
                "content_hash": digest,
                "offset": offset,
                "complete": not more,
            },
            "page": {"has_more": more, "next_cursor": self.cursor(offset=end, content_hash=digest) if more else None},
            "truncated": more,
        }
