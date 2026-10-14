"""Project navigation categories and channel-specific project trees."""

import math
import uuid

from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import (
    OrgUnit,
    Project,
    ProjectNavigationCategory,
    ResearchChain,
    ResearchProjectProfile,
)
from plane.research.utils.org import is_workspace_admin
from plane.research.utils.roles import is_research_admin
from plane.utils.administrative_projects import (
    administrative_projects_for_user,
    user_can_manage_administrative_organization,
)
from plane.research.views.base import ResearchAPIView, parse_uuid
from plane.research.views.projects import visible_profile_queryset

MAX_CATEGORY_DEPTH = 3
UNCATEGORIZED_TARGET = "uncategorized"
SCOPES = {ProjectNavigationCategory.Scope.RESEARCH, ProjectNavigationCategory.Scope.ADMINISTRATIVE}


def _scope(value):
    """Normalize a requested navigation scope.

    Args:
        value: The raw query or body value.

    Returns:
        A valid scope value, or ``None`` when the request is invalid.
    """
    value = str(value or "").upper()
    return value if value in SCOPES else None


def _can_manage(user, workspace):
    """Check whether the user may manage navigation categories.

    Args:
        user: The authenticated requester.
        workspace: The resolved workspace.

    Returns:
        True for a workspace or research administrator.
    """
    return is_workspace_admin(user, workspace.id) or is_research_admin(user, workspace.id)


def _depth(category):
    """Calculate the active ancestry depth of a category.

    Args:
        category: The category to inspect.

    Returns:
        The number of category levels from this node to its root.
    """
    depth = 1
    parent = category.parent
    while parent is not None:
        depth += 1
        parent = parent.parent
    return depth


def _descendant_ids(category):
    """Collect active descendant IDs for delete and cycle checks.

    Args:
        category: The category whose subtree is inspected.

    Returns:
        A set containing all active descendant primary keys.
    """
    descendant_ids = set()
    pending = list(category.children.filter(deleted_at__isnull=True).values_list("id", flat=True))
    while pending:
        current_id = pending.pop()
        if current_id in descendant_ids:
            continue
        descendant_ids.add(current_id)
        pending.extend(
            ProjectNavigationCategory.objects.filter(parent_id=current_id, deleted_at__isnull=True).values_list(
                "id", flat=True
            )
        )
    return descendant_ids


def _subtree_height(category):
    """Calculate the height of an active category subtree.

    Args:
        category: The category whose subtree is inspected.

    Returns:
        The number of levels in the subtree, including this category.
    """
    children = list(category.children.filter(deleted_at__isnull=True))
    return 1 + max((_subtree_height(child) for child in children), default=0)


def _valid_name(value):
    """Validate and normalize a category name.

    Args:
        value: The raw request value.

    Returns:
        A ``(name, error_response)`` tuple with exactly one non-null side.
    """
    name = str(value or "").strip()
    if not name:
        return None, Response(
            {"error_code": "navigation_category_invalid", "message": "name is required."},
            status=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    if len(name) > 255:
        return None, Response(
            {"error_code": "navigation_category_invalid", "message": "name is too long."},
            status=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return name, None


def _valid_sort_order(value):
    """Validate a category sort value.

    Args:
        value: The raw request value.

    Returns:
        A ``(number, error_response)`` tuple with exactly one useful side.
    """
    if value is None:
        return 65535, None
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = math.nan
    if not math.isfinite(number):
        return None, Response(
            {"error_code": "navigation_sort_invalid", "message": "sort_order must be a finite number."},
            status=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )
    return number, None


def _duplicate_exists(workspace, scope, parent, name, exclude=None):
    """Check for an active sibling category with the same name.

    Args:
        workspace: The category workspace.
        scope: The channel scope.
        parent: The optional parent category.
        name: The requested category name.
        exclude: A category excluded from the check during updates.

    Returns:
        True when another active sibling uses the name.
    """
    queryset = ProjectNavigationCategory.objects.filter(
        workspace=workspace,
        scope=scope,
        parent=parent,
        name=name,
        deleted_at__isnull=True,
    )
    if exclude is not None:
        queryset = queryset.exclude(pk=exclude.pk)
    return queryset.exists()


def _duplicate_response():
    """Return the stable conflict envelope for duplicate sibling names."""
    return Response(
        {
            "error_code": "navigation_category_duplicate",
            "message": "A sibling category already uses this name.",
        },
        status=status.HTTP_409_CONFLICT,
    )


def _administrative_category_readonly_response():
    """Return the stable conflict response for retired administrative categories."""
    return Response(
        {
            "error_code": "navigation_category_readonly",
            "message": "Administrative categories were migrated to organizations.",
        },
        status=status.HTTP_409_CONFLICT,
    )


def _project_queryset(workspace, user, scope):
    """Return projects visible to the caller in one navigation channel.

    Args:
        workspace: The resolved workspace.
        user: The authenticated requester.
        scope: The navigation channel scope.

    Returns:
        A Project queryset filtered by the existing channel ACL.
    """
    if scope == ProjectNavigationCategory.Scope.RESEARCH:
        profile_ids = (
            visible_profile_queryset(workspace, user)
            .filter(
                workflow_status=ResearchProjectProfile.WorkflowStatus.ACTIVE,
            )
            .values_list("project_id", flat=True)
        )
        return Project.objects.filter(
            workspace=workspace,
            id__in=profile_ids,
            deleted_at__isnull=True,
        ).select_related("navigation_category", "research_profile", "research_chain")

    queryset = (
        Project.objects.filter(
            workspace=workspace,
            deleted_at__isnull=True,
        )
        .exclude(research_profile__isnull=False)
        .select_related("navigation_category", "administrative_organization")
    )
    if is_workspace_admin(user, workspace.id):
        return queryset
    return queryset.filter(
        Q(project_projectmember__member=user, project_projectmember__is_active=True)
        | Q(
            administrative_organization__members__member=user,
            administrative_organization__members__is_active=True,
            administrative_organization__members__deleted_at__isnull=True,
        )
        | Q(id__in=administrative_projects_for_user(user, workspace.slug).values("id"))
    ).distinct()


def _project_payload(project, scope):
    """Serialize stable fields and the existing business route kind.

    Args:
        project: A visible Project instance.
        scope: The navigation channel scope.

    Returns:
        A dictionary containing the project ID, optional chain ID, name, identifier, and route kind.
    """
    route_kind = "ADMINISTRATIVE"
    profile = getattr(project, "research_profile", None)
    if scope == ProjectNavigationCategory.Scope.RESEARCH and profile:
        if profile.chain_kind == ResearchProjectProfile.ChainKind.RESEARCH_CHAIN:
            route_kind = "RESEARCH_CHAIN"
        elif profile.research_type == ResearchProjectProfile.ResearchType.RESEARCH_PROJECT:
            route_kind = "TEAM_RESEARCH"
        else:
            route_kind = "LEGACY_RESEARCH"
    chain = None
    if route_kind == "RESEARCH_CHAIN":
        try:
            chain = project.research_chain
        except ResearchChain.DoesNotExist:
            chain = None
    payload = {
        "id": str(project.id),
        "name": project.name,
        "identifier": project.identifier,
        "kind": route_kind,
    }
    if route_kind == "RESEARCH_CHAIN":
        payload["chain_id"] = str(chain.id) if chain is not None else None
    return payload


def _ancestor_ids_from_path(path):
    """Extract organization unit IDs from a materialized path.

    Args:
        path: The slash-delimited OrgUnit path.

    Returns:
        All parseable UUID strings found in the path.
    """
    ancestor_ids = set()
    for segment in str(path or "").split("/"):
        if not segment:
            continue
        try:
            ancestor_ids.add(str(uuid.UUID(segment)))
        except ValueError:
            continue
    return ancestor_ids


def _organization_nodes(workspace, categories, project_by_org):
    """Project the existing organization tree as read-only navigation nodes.

    Args:
        workspace: The resolved workspace.
        categories: Active custom categories in the research scope.
        project_by_org: Projects grouped by their actual OrgUnit ID.

    Returns:
        A mapping from actual OrgUnit ID to a virtual navigation node.
    """
    direct_ids = set(project_by_org)
    direct_ids.update(
        str(category.org_unit_id) for category in categories if category.org_unit_id and category.parent_id is None
    )
    direct_units = list(OrgUnit.objects.filter(workspace=workspace, id__in=direct_ids, deleted_at__isnull=True))
    all_unit_ids = set(direct_ids)
    for unit in direct_units:
        all_unit_ids.update(_ancestor_ids_from_path(unit.path))
    resolved_unit_ids = set()
    pending_ids = set(all_unit_ids)
    units = []
    while pending_ids:
        fetched_units = list(OrgUnit.objects.filter(workspace=workspace, id__in=pending_ids, deleted_at__isnull=True))
        units.extend(fetched_units)
        resolved_unit_ids.update(str(unit.id) for unit in fetched_units)
        pending_ids = {
            str(unit.parent_id)
            for unit in fetched_units
            if unit.parent_id and str(unit.parent_id) not in resolved_unit_ids
        }
    unit_ids = {str(unit.id) for unit in units}
    nodes = {}
    for unit in units:
        nodes[str(unit.id)] = {
            "id": f"org:{unit.id}",
            "name": unit.name,
            "kind": "ORG",
            "scope": ProjectNavigationCategory.Scope.RESEARCH,
            "parent": f"org:{unit.parent_id}" if unit.parent_id and str(unit.parent_id) in unit_ids else None,
            "sort_order": unit.sort_order,
            "projects": project_by_org.get(str(unit.id), []),
            "children": [],
            "can_manage": False,
        }
    nodes_by_navigation_id = {node["id"]: node for node in nodes.values()}
    for node in nodes.values():
        if node["parent"] in nodes_by_navigation_id:
            nodes_by_navigation_id[node["parent"]]["children"].append(node)
    return nodes


def _tree(workspace, user, scope, projects, can_manage=False):
    """Build a channel-specific navigation tree without changing project ACLs.

    Args:
        workspace: The resolved workspace.
        scope: The navigation channel scope.
        projects: Projects already filtered by the caller's visibility.
        can_manage: Whether the caller may manage custom categories.

    Returns:
        A response containing custom categories, org projection, and uncategorized projects.
    """
    categories = list(
        ProjectNavigationCategory.objects.filter(
            workspace=workspace, scope=scope, deleted_at__isnull=True
        ).select_related("parent")
    )
    active_category_ids = {str(category.id) for category in categories}
    by_parent = {}
    by_org = {}
    for category in categories:
        if category.org_unit_id and category.parent_id is None:
            by_org.setdefault(str(category.org_unit_id), []).append(category)
        else:
            parent_key = str(category.parent_id) if category.parent_id else None
            by_parent.setdefault(parent_key, []).append(category)

    project_by_category = {}
    project_by_org = {}
    uncategorized = []
    for project in projects:
        category_id = str(project.navigation_category_id) if project.navigation_category_id else None
        if scope == ProjectNavigationCategory.Scope.ADMINISTRATIVE and project.administrative_organization_id:
            project_by_org.setdefault(str(project.administrative_organization_id), []).append(
                _project_payload(project, scope)
            )
            continue
        if category_id in active_category_ids:
            project_by_category.setdefault(category_id, []).append(_project_payload(project, scope))
            continue

        profile = getattr(project, "research_profile", None)
        if scope == ProjectNavigationCategory.Scope.RESEARCH and profile and profile.org_unit_id:
            project_by_org.setdefault(str(profile.org_unit_id), []).append(_project_payload(project, scope))
        else:
            uncategorized.append(_project_payload(project, scope))

    if scope == ProjectNavigationCategory.Scope.RESEARCH:
        org_nodes = _organization_nodes(workspace, categories, project_by_org)
    else:
        from plane.db.models import AdministrativeOrganization

        org_nodes = {}
        organizations = AdministrativeOrganization.objects.filter(
            workspace=workspace, deleted_at__isnull=True
        ).order_by("name")
        visible_project_ids = {str(project.id) for project in projects}
        if can_manage:
            visible_project_ids.update(
                str(project_id)
                for project_id in administrative_projects_for_user(user, workspace.slug).values_list("id", flat=True)
            )
        if can_manage:
            managed_projects = (
                Project.objects.filter(workspace=workspace, id__in=visible_project_ids, deleted_at__isnull=True)
                .exclude(research_profile__isnull=False)
                .exclude(id__in=ResearchChain.objects.values("project_id"))
            )
            for project in managed_projects:
                if project.administrative_organization_id:
                    project_by_org.setdefault(str(project.administrative_organization_id), []).append(
                        _project_payload(project, scope)
                    )
        organization_ids = set(
            str(organization_id)
            for organization_id in AdministrativeOrganization.objects.filter(
                workspace=workspace,
                members__member=user,
                members__is_active=True,
                members__deleted_at__isnull=True,
                deleted_at__isnull=True,
            ).values_list("id", flat=True)
        )
        for organization in organizations:
            organization_projects = [
                payload
                for payload in project_by_org.get(str(organization.id), [])
                if payload["id"] in visible_project_ids
            ]
            if (
                organization.is_default
                or organization_projects
                or str(organization.id) in organization_ids
                or can_manage
            ):
                org_nodes[str(organization.id)] = {
                    "id": f"admin-org:{organization.id}",
                    "name": organization.name,
                    "kind": "ORG",
                    "scope": scope,
                    "parent": None,
                    "sort_order": 1,
                    "projects": organization_projects,
                    "children": [],
                    "can_manage": user_can_manage_administrative_organization(user, workspace.slug, organization.id),
                    "org_unit": None,
                    "organization_id": str(organization.id),
                }

    def build(parent_id):
        """Build active custom child nodes for one parent.

        Args:
            parent_id: The parent category ID, or ``None`` for a root.

        Returns:
            The ordered custom category nodes under the parent.
        """
        nodes = []
        for category in sorted(by_parent.get(parent_id, []), key=lambda item: (item.sort_order, item.name)):
            node = {
                "id": str(category.id),
                "name": category.name,
                "kind": "CUSTOM",
                "scope": category.scope,
                "parent": str(category.parent_id) if category.parent_id else None,
                "sort_order": category.sort_order,
                "projects": project_by_category.get(str(category.id), []),
                "children": build(str(category.id)),
                "can_manage": can_manage,
                "org_unit": str(category.org_unit_id) if category.org_unit_id else None,
            }
            if can_manage or node["projects"] or node["children"]:
                nodes.append(node)
        return nodes

    if scope == ProjectNavigationCategory.Scope.RESEARCH:
        for org_id, org_node in org_nodes.items():
            for category in sorted(by_org.get(org_id, []), key=lambda item: (item.sort_order, item.name)):
                custom_node = {
                    "id": str(category.id),
                    "name": category.name,
                    "kind": "CUSTOM",
                    "scope": category.scope,
                    "parent": None,
                    "sort_order": category.sort_order,
                    "projects": project_by_category.get(str(category.id), []),
                    "children": build(str(category.id)),
                    "can_manage": can_manage,
                    "org_unit": org_id,
                }
                if can_manage or custom_node["projects"] or custom_node["children"]:
                    org_node["children"].append(custom_node)
        roots = [node for node in org_nodes.values() if node["parent"] is None]
    else:
        roots = list(org_nodes.values())
    roots.extend(build(None))
    roots = [node for node in roots if can_manage or node["projects"] or node["children"]]
    return {
        "scope": scope,
        "can_manage": can_manage,
        "categories": roots,
        "uncategorized": uncategorized,
    }


def _serialize_category(category):
    """Serialize category write responses with stable parent/org references.

    Args:
        category: The category to serialize.

    Returns:
        A dictionary containing category navigation metadata.
    """
    return {
        "id": str(category.id),
        "name": category.name,
        "scope": category.scope,
        "parent": str(category.parent_id) if category.parent_id else None,
        "org_unit": str(category.org_unit_id) if category.org_unit_id else None,
        "sort_order": category.sort_order,
    }


class ProjectNavigationTreeEndpoint(ResearchAPIView):
    """GET/POST navigation categories and the channel-specific project tree."""

    nav_capability = None

    def initial(self, request, *args, **kwargs):
        """按 GET 的 scope 决定该次导航树是否依赖科研模块。

        Args:
            request: 当前 HTTP 请求。
            *args: DRF initial 额外参数。
            **kwargs: DRF initial 额外关键字参数。
        """
        scope = _scope(request.GET.get("scope")) if request.method == "GET" else None
        self.research_module_required = scope != ProjectNavigationCategory.Scope.ADMINISTRATIVE
        self.research_membership_required = scope != ProjectNavigationCategory.Scope.ADMINISTRATIVE
        return super().initial(request, *args, **kwargs)

    def get(self, request, slug):
        """Return one scoped tree using existing project visibility rules."""
        scope = _scope(request.GET.get("scope"))
        is_research_scope = scope == ProjectNavigationCategory.Scope.RESEARCH
        workspace, error = self.get_workspace(
            nav=None,
            require_enabled=is_research_scope,
            research_member=is_research_scope,
        )
        if error:
            return error
        if scope is None:
            return Response(
                {"error_code": "navigation_scope_invalid", "message": "scope is required."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        projects = _project_queryset(workspace, request.user, scope)
        return Response(
            _tree(workspace, request.user, scope, projects, _can_manage(request.user, workspace)),
            status=status.HTTP_200_OK,
        )

    def post(self, request, slug):
        """Create a custom category in one navigation channel."""
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        if not _can_manage(request.user, workspace):
            return Response(
                {"error_code": "navigation_permission_denied", "message": "Not allowed."},
                status=status.HTTP_403_FORBIDDEN,
            )
        scope = _scope(request.data.get("scope"))
        if scope is None:
            return Response(
                {"error_code": "navigation_category_invalid", "message": "scope is required."},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        if scope == ProjectNavigationCategory.Scope.ADMINISTRATIVE:
            return _administrative_category_readonly_response()
        name, error = _valid_name(request.data.get("name"))
        if error:
            return error
        sort_order, error = _valid_sort_order(request.data.get("sort_order"))
        if error:
            return error
        parent_id, error = parse_uuid(request.data.get("parent"), "parent")
        if error:
            return error
        parent = (
            ProjectNavigationCategory.objects.filter(
                pk=parent_id, workspace=workspace, scope=scope, deleted_at__isnull=True
            ).first()
            if parent_id
            else None
        )
        if parent_id and parent is None:
            return Response(
                {"error_code": "navigation_parent_not_found", "message": "Parent category not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if parent and _depth(parent) >= MAX_CATEGORY_DEPTH:
            return Response(
                {"error_code": "navigation_depth_exceeded", "message": "Category nesting is limited."},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        org_unit_id, error = parse_uuid(request.data.get("org_unit"), "org_unit")
        if error:
            return error
        org_unit = None
        if org_unit_id:
            if scope != ProjectNavigationCategory.Scope.RESEARCH or parent is not None:
                return Response(
                    {
                        "error_code": "navigation_org_unit_invalid",
                        "message": "An org unit can only anchor a research root category.",
                    },
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            org_unit = OrgUnit.objects.filter(pk=org_unit_id, workspace=workspace, deleted_at__isnull=True).first()
            if org_unit is None:
                return Response(
                    {"error_code": "navigation_org_unit_not_found", "message": "Organisation unit not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
        if _duplicate_exists(workspace, scope, parent, name):
            return _duplicate_response()
        try:
            category = ProjectNavigationCategory.objects.create(
                workspace=workspace,
                scope=scope,
                parent=parent,
                org_unit=org_unit,
                name=name,
                sort_order=sort_order,
            )
        except IntegrityError:
            return _duplicate_response()
        return Response(_serialize_category(category), status=status.HTTP_201_CREATED)


class ProjectNavigationCategoryDetailEndpoint(ResearchAPIView):
    """PATCH/DELETE a custom category without touching projects silently."""

    nav_capability = None

    def patch(self, request, slug, category_id):
        """Rename, reorder, or move a custom category."""
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        if not _can_manage(request.user, workspace):
            return Response(
                {"error_code": "navigation_permission_denied", "message": "Not allowed."},
                status=status.HTTP_403_FORBIDDEN,
            )
        category = ProjectNavigationCategory.objects.filter(
            pk=category_id, workspace=workspace, deleted_at__isnull=True
        ).first()
        if category is None:
            return Response(
                {"error_code": "navigation_category_not_found", "message": "Category not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if category.scope == ProjectNavigationCategory.Scope.ADMINISTRATIVE:
            return _administrative_category_readonly_response()

        if "name" in request.data:
            name, error = _valid_name(request.data.get("name"))
            if error:
                return error
            if _duplicate_exists(workspace, category.scope, category.parent, name, exclude=category):
                return _duplicate_response()
            category.name = name

        if "sort_order" in request.data:
            sort_order, error = _valid_sort_order(request.data.get("sort_order"))
            if error:
                return error
            category.sort_order = sort_order

        if "parent" in request.data:
            parent_id, error = parse_uuid(request.data.get("parent"), "parent")
            if error:
                return error
            parent = (
                ProjectNavigationCategory.objects.filter(
                    pk=parent_id,
                    workspace=workspace,
                    scope=category.scope,
                    deleted_at__isnull=True,
                ).first()
                if parent_id
                else None
            )
            if parent_id and parent is None:
                return Response(
                    {"error_code": "navigation_parent_not_found", "message": "Parent category not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if parent and parent.id == category.id:
                return Response(
                    {"error_code": "navigation_parent_invalid", "message": "A category cannot parent itself."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if parent and parent.id in _descendant_ids(category):
                return Response(
                    {"error_code": "navigation_parent_invalid", "message": "A category cannot move below itself."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if parent and category.org_unit_id:
                return Response(
                    {
                        "error_code": "navigation_org_unit_invalid",
                        "message": "An org-anchored category must remain a root.",
                    },
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if parent and _depth(parent) + _subtree_height(category) > MAX_CATEGORY_DEPTH:
                return Response(
                    {"error_code": "navigation_depth_exceeded", "message": "Category nesting is limited."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if _duplicate_exists(workspace, category.scope, parent, category.name, exclude=category):
                return _duplicate_response()
            category.parent = parent

        try:
            category.save(update_fields=["name", "sort_order", "parent", "updated_at"])
        except IntegrityError:
            return _duplicate_response()
        return Response(_serialize_category(category))

    def delete(self, request, slug, category_id):
        """Soft-delete a category after explicitly preserving its contents."""
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        if not _can_manage(request.user, workspace):
            return Response(
                {"error_code": "navigation_permission_denied", "message": "Not allowed."},
                status=status.HTTP_403_FORBIDDEN,
            )
        category = ProjectNavigationCategory.objects.filter(
            pk=category_id, workspace=workspace, deleted_at__isnull=True
        ).first()
        if category is None:
            return Response(
                {"error_code": "navigation_category_not_found", "message": "Category not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        if category.scope == ProjectNavigationCategory.Scope.ADMINISTRATIVE:
            return _administrative_category_readonly_response()

        raw_target = request.query_params.get("move_to")
        if raw_target == UNCATEGORIZED_TARGET:
            target = None
        else:
            target_id, error = parse_uuid(raw_target, "move_to")
            if error:
                return error
            target = (
                ProjectNavigationCategory.objects.filter(
                    pk=target_id, workspace=workspace, scope=category.scope, deleted_at__isnull=True
                ).first()
                if target_id
                else None
            )
            if target_id and target is None:
                return Response(
                    {"error_code": "navigation_target_not_found", "message": "Target category not found."},
                    status=status.HTTP_404_NOT_FOUND,
                )
            if target and target.id == category.id:
                return Response(
                    {"error_code": "navigation_target_invalid", "message": "A category cannot move to itself."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if target and target.id in _descendant_ids(category):
                return Response(
                    {"error_code": "navigation_target_invalid", "message": "A category cannot move below itself."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )
            if target and _depth(target) + _subtree_height(category) > MAX_CATEGORY_DEPTH:
                return Response(
                    {"error_code": "navigation_depth_exceeded", "message": "Target category is too deep."},
                    status=status.HTTP_422_UNPROCESSABLE_ENTITY,
                )

        has_projects = category.projects.filter(deleted_at__isnull=True).exists()
        if has_projects and raw_target is None:
            return Response(
                {
                    "error_code": "navigation_category_not_empty",
                    "message": "Choose uncategorized or a target category before deleting.",
                },
                status=status.HTTP_409_CONFLICT,
            )

        try:
            with transaction.atomic():
                category.projects.filter(deleted_at__isnull=True).update(navigation_category=target)
                if target is None:
                    category.children.filter(deleted_at__isnull=True).update(
                        parent=category.parent, org_unit=category.org_unit
                    )
                else:
                    category.children.filter(deleted_at__isnull=True).update(parent=target)
                category.deleted_at = timezone.now()
                category.save(update_fields=["deleted_at", "updated_at"])
        except IntegrityError:
            return Response(
                {
                    "error_code": "navigation_category_duplicate",
                    "message": "The target already contains a sibling with the same name.",
                },
                status=status.HTTP_409_CONFLICT,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectNavigationMoveProjectEndpoint(ResearchAPIView):
    """Move a project between categories without changing project access."""

    nav_capability = None

    def post(self, request, slug, project_id):
        """Move one visible project to a custom category or uncategorized."""
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        if not _can_manage(request.user, workspace):
            return Response(
                {"error_code": "navigation_permission_denied", "message": "Not allowed."},
                status=status.HTTP_403_FORBIDDEN,
            )
        project = Project.objects.filter(pk=project_id, workspace=workspace, deleted_at__isnull=True).first()
        if project is None:
            return Response(
                {"error_code": "project_not_found", "message": "Project not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        scope = _scope(request.data.get("scope"))
        profile = ResearchProjectProfile.objects.filter(project=project).first()
        expected = (
            ProjectNavigationCategory.Scope.RESEARCH if profile else ProjectNavigationCategory.Scope.ADMINISTRATIVE
        )
        if scope is None or scope != expected:
            return Response(
                {"error_code": "navigation_scope_conflict", "message": "Project does not belong to this channel."},
                status=status.HTTP_409_CONFLICT,
            )
        if expected == ProjectNavigationCategory.Scope.ADMINISTRATIVE:
            return _administrative_category_readonly_response()
        if not _project_queryset(workspace, request.user, scope).filter(pk=project.pk).exists():
            return Response(
                {"error_code": "navigation_project_hidden", "message": "Project is not visible to this user."},
                status=status.HTTP_403_FORBIDDEN,
            )
        category_id, error = parse_uuid(request.data.get("category"), "category")
        if error:
            return error
        category = (
            ProjectNavigationCategory.objects.filter(
                pk=category_id, workspace=workspace, scope=scope, deleted_at__isnull=True
            ).first()
            if category_id
            else None
        )
        if category_id and category is None:
            return Response(
                {"error_code": "navigation_category_not_found", "message": "Category not found."},
                status=status.HTTP_404_NOT_FOUND,
            )
        project.navigation_category = category
        project.save(update_fields=["navigation_category", "updated_at"])
        return Response(
            {"project_id": str(project.id), "category": str(category.id) if category else None},
            status=status.HTTP_200_OK,
        )
