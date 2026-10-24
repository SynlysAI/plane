# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json


# Django imports
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import (
    Case,
    CharField,
    Count,
    Exists,
    F,
    IntegerField,
    OuterRef,
    Prefetch,
    Q,
    Subquery,
    Value,
    When,
)
from django.utils import timezone
from django.db.models.functions import Coalesce, Greatest

# Third Party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, ProjectMemberPermission, allow_permission
from plane.app.serializers import (
    DeployBoardSerializer,
    ProjectListSerializer,
    ProjectSerializer,
)
from plane.app.views.base import BaseAPIView, BaseViewSet
from plane.bgtasks.recent_visited_task import recent_visited_task
from plane.bgtasks.webhook_task import model_activity, webhook_activity
from plane.db.models import (
    UserFavorite,
    DeployBoard,
    Intake,
    Project,
    ProjectIdentifier,
    ProjectMember,
    ProjectNetwork,
    ProjectUserProperty,
    State,
    DEFAULT_STATES,
    Workspace,
    WorkspaceMember,
)
from plane.db.models.intake import IntakeIssueStatus
from plane.utils.host import base_host
from plane.utils.home_activity import record_project_activity
from plane.utils.order_queryset import PROJECT_ORDER_BY_ALLOWLIST, sanitize_order_by
from plane.utils.administrative_projects import (
    administrative_organization_project_ids,
    administrative_projects_for_user,
    restrict_administrative_project_visibility,
    administrative_project_filter,
    public_administrative_project_ids,
    research_project_ids,
    user_can_manage_administrative_project,
)


def _cached_research_review_ids(request, slug):
    """同一请求内只计算一次研究链只读项目。

    Args:
        request: 当前请求。
        slug: 工作区别名。

    Returns:
        项目主键列表。工作区不存在时为空列表。
    """
    cache = getattr(request, "_research_review_project_ids", None)
    if not isinstance(cache, dict):
        cache = {}
        request._research_review_project_ids = cache
    if slug not in cache:
        from plane.research.utils.project_review import research_review_project_ids_for_slug

        cache[slug] = research_review_project_ids_for_slug(request.user, slug)
    return cache[slug]


def _research_access_expression(request, slug):
    """生成非成员研究链读者的 ``research_access`` 注解。

    Args:
        request: 当前请求。
        slug: 工作区别名。

    Returns:
        可放进 queryset.annotate 的 Case 表达式。
    """
    review_ids = _cached_research_review_ids(request, slug)
    return Case(
        When(Q(id__in=review_ids) & Q(member_role__isnull=True), then=Value("review")),
        default=Value(None),
        output_field=CharField(null=True),
    )


def _project_member_role_expression(request, slug):
    """生成包含行政项目默认权限的有效项目角色。

    Args:
        request: 当前请求。
        slug: 工作区别名。

    Returns:
        管理身份在行政项目中返回管理员角色，其他情况返回显式成员角色。
    """
    member_role = ProjectMember.objects.filter(
        project_id=OuterRef("pk"), member_id=request.user.id, is_active=True
    ).values("role")
    explicit_project_ids = ProjectMember.objects.filter(
        project_id=OuterRef("pk"), member_id=request.user.id, is_active=True
    ).values("project_id")
    return Case(
        When(id__in=administrative_projects_for_user(request.user, slug).values("id"), then=Value(ROLE.ADMIN.value)),
        When(
            Q(id__in=public_administrative_project_ids(request.user, slug))
            | Q(id__in=administrative_organization_project_ids(request.user, slug)),
            then=Greatest(Coalesce(Subquery(member_role), Value(0)), Value(ROLE.MEMBER.value)),
        ),
        When(id__in=explicit_project_ids, then=Subquery(member_role)),
        default=Subquery(member_role),
        output_field=IntegerField(),
    )


def _restrict_workspace_project_visibility(queryset, request, slug):
    """限制行政项目成员准入，保留科研项目网络和研究链只读规则。

    Args:
        queryset: 工作区项目查询集。
        request: 当前请求。
        slug: 工作区别名。

    Returns:
        过滤后的查询集，默认管理身份仍可看到全部行政项目。
    """
    user = request.user
    queryset = restrict_administrative_project_visibility(queryset, user, slug)
    review_ids = _cached_research_review_ids(request, slug)
    administrative_ids = administrative_projects_for_user(user, slug).values("id")
    organization_ids = administrative_organization_project_ids(user, slug)
    public_ids = public_administrative_project_ids(user, slug)
    if WorkspaceMember.objects.filter(
        member=user,
        workspace__slug=slug,
        is_active=True,
        role=ROLE.GUEST.value,
    ).exists():
        return queryset.filter(
            Q(
                project_projectmember__member=user,
                project_projectmember__is_active=True,
            )
            | Q(id__in=review_ids)
            | Q(id__in=administrative_ids)
            | Q(id__in=public_ids)
            | Q(id__in=organization_ids)
        )
    if WorkspaceMember.objects.filter(
        member=user,
        workspace__slug=slug,
        is_active=True,
        role=ROLE.MEMBER.value,
    ).exists():
        # 公开项目的列表可见性与打开权限保持同一口径：默认公共组织（public_ids）
        # 或挂靠组织成员（organization_ids），非组织成员不再"看得到点不开"。
        return queryset.filter(
            Q(
                project_projectmember__member=user,
                project_projectmember__is_active=True,
            )
            | Q(id__in=review_ids)
            | Q(id__in=administrative_ids)
            | Q(id__in=public_ids)
            | Q(id__in=organization_ids)
        )
    return queryset


class ProjectViewSet(BaseViewSet):
    serializer_class = ProjectListSerializer
    model = Project
    webhook_event = "project"
    use_read_replica = True

    def get_queryset(self):
        sort_order = ProjectUserProperty.objects.filter(
            user=self.request.user,
            project_id=OuterRef("pk"),
            workspace__slug=self.kwargs.get("slug"),
        ).values("sort_order")
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .select_related("workspace", "workspace__owner", "default_assignee", "project_lead")
            .annotate(
                is_favorite=Exists(
                    UserFavorite.objects.filter(
                        user=self.request.user,
                        entity_identifier=OuterRef("pk"),
                        entity_type="project",
                        project_id=OuterRef("pk"),
                    )
                )
            )
            .annotate(member_role=_project_member_role_expression(self.request, self.kwargs.get("slug")))
            .annotate(research_access=_research_access_expression(self.request, self.kwargs.get("slug")))
            .annotate(
                anchor=DeployBoard.objects.filter(
                    entity_name="project",
                    entity_identifier=OuterRef("pk"),
                    workspace__slug=self.kwargs.get("slug"),
                ).values("anchor")
            )
            .annotate(sort_order=Subquery(sort_order))
            # additive research flag used by the optional serializer field
            .annotate(
                is_research_project=Exists(Project.all_objects.filter(pk=OuterRef("pk"), id__in=research_project_ids()))
            )
            .prefetch_related(
                Prefetch(
                    "project_projectmember",
                    queryset=ProjectMember.objects.filter(
                        workspace__slug=self.kwargs.get("slug"), is_active=True
                    ).select_related("member"),
                    to_attr="members_list",
                )
            )
            .distinct()
        )

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def list_detail(self, request, slug):
        fields = [field for field in request.GET.get("fields", "").split(",") if field]
        projects = self.get_queryset().order_by("sort_order", "name")
        projects = _restrict_workspace_project_visibility(projects, request, slug)

        if request.GET.get("scope") == "administrative":
            projects = projects.filter(administrative_project_filter())

        if request.GET.get("per_page", False) and request.GET.get("cursor", False):
            return self.paginate(
                order_by=sanitize_order_by(
                    request.GET.get("order_by", "-created_at"),
                    PROJECT_ORDER_BY_ALLOWLIST,
                    "-created_at",
                ),
                request=request,
                queryset=(projects),
                on_results=lambda projects: ProjectListSerializer(projects, many=True).data,
            )

        projects = ProjectListSerializer(projects, many=True, fields=fields if fields else None).data
        return Response(projects, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def list(self, request, slug):
        sort_order = ProjectUserProperty.objects.filter(
            user=self.request.user,
            project_id=OuterRef("pk"),
            workspace__slug=self.kwargs.get("slug"),
        ).values("sort_order")

        projects = (
            Project.objects.filter(workspace__slug=self.kwargs.get("slug"))
            .select_related("workspace", "workspace__owner", "default_assignee", "project_lead")
            .annotate(member_role=_project_member_role_expression(self.request, self.kwargs.get("slug")))
            .annotate(research_access=_research_access_expression(self.request, self.kwargs.get("slug")))
            .annotate(
                intake_count=Count(
                    "project_intakeissue",
                    filter=Q(
                        project_intakeissue__status=IntakeIssueStatus.PENDING.value,
                        project_intakeissue__deleted_at__isnull=True,
                    ),
                )
            )
            .annotate(inbox_view=F("intake_view"))
            .annotate(sort_order=Subquery(sort_order))
            .annotate(
                is_research_project=Exists(Project.all_objects.filter(pk=OuterRef("pk"), id__in=research_project_ids()))
            )
            .distinct()
        ).values(
            "id",
            "name",
            "identifier",
            "sort_order",
            "logo_props",
            "member_role",
            "intake_count",
            "archived_at",
            "workspace",
            "cycle_view",
            "issue_views_view",
            "module_view",
            "page_view",
            "inbox_view",
            "is_research_project",
            "research_access",
            "guest_view_all_features",
            "project_lead",
            "network",
            "created_at",
            "updated_at",
            "created_by",
            "updated_by",
        )

        projects = _restrict_workspace_project_visibility(projects, request, slug)
        if request.GET.get("scope") == "administrative":
            projects = projects.filter(administrative_project_filter())
        return Response(projects, status=status.HTTP_200_OK)

    @allow_permission(allowed_roles=[ROLE.ADMIN, ROLE.MEMBER, ROLE.GUEST], level="WORKSPACE")
    def retrieve(self, request, slug, pk):
        project = self.get_queryset().filter(archived_at__isnull=True).filter(pk=pk).first()

        if project is None:
            return Response({"error": "Project does not exist"}, status=status.HTTP_404_NOT_FOUND)

        member_ids = [str(project_member.member_id) for project_member in project.members_list]
        organization_member = administrative_organization_project_ids(request.user, slug).filter(id=pk).exists()
        public_member = public_administrative_project_ids(request.user, slug).filter(id=pk).exists()

        review_reader = getattr(project, "research_access", None) == "review"
        if (
            str(request.user.id) not in member_ids
            and not organization_member
            and not public_member
            and not review_reader
            and not user_can_manage_administrative_project(request.user, slug, pk)
        ):
            if not project.is_research_project:
                return Response(
                    {
                        "error": "Project membership must be configured by an administrator",
                        "code": "PROJECT_MEMBERSHIP_REQUIRED",
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            if project.network == ProjectNetwork.SECRET.value:
                return Response(
                    {"error": "You do not have permission"},
                    status=status.HTTP_403_FORBIDDEN,
                )
            else:
                return Response(
                    {"error": "You are not a member of this project"},
                    status=status.HTTP_409_CONFLICT,
                )

        recent_visited_task.delay(
            slug=slug,
            project_id=pk,
            entity_name="project",
            entity_identifier=pk,
            user_id=request.user.id,
        )

        serializer = ProjectListSerializer(project)
        return Response(serializer.data, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def create(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)

        serializer = ProjectSerializer(
            data={**request.data}, context={"workspace_id": workspace.id, "request": request}
        )
        if serializer.is_valid():
            with transaction.atomic():
                serializer.save()

                # Add the user as Administrator to the project
                _ = ProjectMember.objects.create(
                    project_id=serializer.data["id"],
                    member=request.user,
                    role=ROLE.ADMIN.value,
                )

                if serializer.data["project_lead"] is not None and str(serializer.data["project_lead"]) != str(
                    request.user.id
                ):
                    ProjectMember.objects.create(
                        project_id=serializer.data["id"],
                        member_id=serializer.data["project_lead"],
                        role=ROLE.ADMIN.value,
                    )

                State.objects.bulk_create(
                    [
                        State(
                            name=state["name"],
                            color=state["color"],
                            project=serializer.instance,
                            sequence=state["sequence"],
                            workspace=serializer.instance.workspace,
                            group=state["group"],
                            default=state.get("default", False),
                            created_by=request.user,
                        )
                        for state in DEFAULT_STATES
                    ]
                )

                project = self.get_queryset().filter(pk=serializer.data["id"]).first()
                transaction.on_commit(
                    lambda: model_activity.delay(
                        model_name="project",
                        model_id=str(project.id),
                        requested_data=request.data,
                        current_instance=None,
                        actor_id=request.user.id,
                        slug=slug,
                        origin=base_host(request=request, is_app=True),
                    )
                )

            serializer = ProjectListSerializer(project)
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def partial_update(self, request, slug, pk=None):
        # try:
        is_workspace_admin = WorkspaceMember.objects.filter(
            member=request.user,
            workspace__slug=slug,
            is_active=True,
            role=ROLE.ADMIN.value,
        ).exists()

        is_project_admin = ProjectMember.objects.filter(
            member=request.user,
            workspace__slug=slug,
            project_id=pk,
            role=ROLE.ADMIN.value,
            is_active=True,
        ).exists()

        # Return error for if the user is neither workspace admin nor project admin
        if (
            not is_project_admin
            and not is_workspace_admin
            and not user_can_manage_administrative_project(request.user, slug, pk)
        ):
            return Response(
                {"error": "You don't have the required permissions."},
                status=status.HTTP_403_FORBIDDEN,
            )

        workspace = Workspace.objects.get(slug=slug)

        project = Project.objects.get(pk=pk, workspace__slug=slug)
        intake_view = request.data.get("inbox_view", project.intake_view)
        current_instance = json.dumps(ProjectSerializer(project).data, cls=DjangoJSONEncoder)
        if project.archived_at:
            return Response(
                {"error": "Archived projects cannot be updated"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        serializer = ProjectSerializer(
            project,
            data={**request.data, "intake_view": intake_view},
            context={"workspace_id": workspace.id, "request": request},
            partial=True,
        )

        if serializer.is_valid():
            serializer.save()
            if intake_view:
                intake = Intake.objects.filter(project=project, is_default=True).first()
                if not intake:
                    Intake.objects.create(
                        name=f"{project.name} Intake",
                        project=project,
                        is_default=True,
                    )

            project = self.get_queryset().filter(pk=serializer.data["id"]).first()

            model_activity.delay(
                model_name="project",
                model_id=str(project.id),
                requested_data=request.data,
                current_instance=current_instance,
                actor_id=request.user.id,
                slug=slug,
                origin=base_host(request=request, is_app=True),
            )
            serializer = ProjectListSerializer(project)
            return Response(serializer.data, status=status.HTTP_200_OK)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

    def destroy(self, request, slug, pk):
        if (
            user_can_manage_administrative_project(request.user, slug, pk)
            or WorkspaceMember.objects.filter(
                member=request.user,
                workspace__slug=slug,
                is_active=True,
                role=ROLE.ADMIN.value,
            ).exists()
            or ProjectMember.objects.filter(
                member=request.user,
                workspace__slug=slug,
                project_id=pk,
                role=ROLE.ADMIN.value,
                is_active=True,
            ).exists()
        ):
            project = Project.objects.get(pk=pk, workspace__slug=slug)
            record_project_activity(project, request.user, "deleted")
            project.delete()
            webhook_activity.delay(
                event="project",
                verb="deleted",
                field=None,
                old_value=None,
                new_value=None,
                actor_id=request.user.id,
                slug=slug,
                current_site=base_host(request=request, is_app=True),
                event_id=project.id,
                old_identifier=None,
                new_identifier=None,
            )
            # Delete the project members
            DeployBoard.objects.filter(project_id=pk, workspace__slug=slug).delete()

            # Delete the user favorite
            UserFavorite.objects.filter(project_id=pk, workspace__slug=slug).delete()

            return Response(status=status.HTTP_204_NO_CONTENT)
        else:
            return Response(
                {"error": "You don't have the required permissions."},
                status=status.HTTP_403_FORBIDDEN,
            )


class ProjectArchiveUnarchiveEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def post(self, request, slug, project_id):
        project = Project.objects.get(pk=project_id, workspace__slug=slug)
        project.archived_at = timezone.now()
        project.save()
        record_project_activity(project, request.user, "archived")
        UserFavorite.objects.filter(workspace__slug=slug, project=project_id).delete()
        return Response({"archived_at": str(project.archived_at)}, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER])
    def delete(self, request, slug, project_id):
        project = Project.objects.get(pk=project_id, workspace__slug=slug)
        project.archived_at = None
        project.save()
        record_project_activity(project, request.user, "restored")
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectIdentifierEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        name = request.GET.get("name", "").strip().upper()

        if name == "":
            return Response({"error": "Name is required"}, status=status.HTTP_400_BAD_REQUEST)

        exists = ProjectIdentifier.objects.filter(name=name, workspace__slug=slug).values("id", "name", "project")

        return Response({"exists": len(exists), "identifiers": exists}, status=status.HTTP_200_OK)

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug):
        name = request.data.get("name", "").strip().upper()

        if name == "":
            return Response({"error": "Name is required"}, status=status.HTTP_400_BAD_REQUEST)

        if Project.objects.filter(identifier=name, workspace__slug=slug).exists():
            return Response(
                {"error": "Cannot delete an identifier of an existing project"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ProjectIdentifier.objects.filter(name=name, workspace__slug=slug).delete()

        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectUserViewsEndpoint(BaseAPIView):
    def post(self, request, slug, project_id):
        project = Project.objects.get(pk=project_id, workspace__slug=slug)

        project_member = ProjectMember.objects.filter(member=request.user, project=project, is_active=True).first()

        if project_member is None:
            return Response({"error": "Forbidden"}, status=status.HTTP_403_FORBIDDEN)

        view_props = project_member.view_props
        default_props = project_member.default_props
        preferences = project_member.preferences
        sort_order = project_member.sort_order

        project_member.view_props = request.data.get("view_props", view_props)
        project_member.default_props = request.data.get("default_props", default_props)
        project_member.preferences = request.data.get("preferences", preferences)
        project_member.sort_order = request.data.get("sort_order", sort_order)

        project_member.save()

        return Response(status=status.HTTP_204_NO_CONTENT)


class ProjectFavoritesViewSet(BaseViewSet):
    model = UserFavorite

    def get_queryset(self):
        return self.filter_queryset(
            super()
            .get_queryset()
            .filter(workspace__slug=self.kwargs.get("slug"))
            .filter(user=self.request.user)
            .select_related("project", "project__project_lead", "project__default_assignee")
            .select_related("workspace", "workspace__owner")
        )

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def create(self, request, slug):
        _ = UserFavorite.objects.create(
            user=request.user,
            entity_type="project",
            entity_identifier=request.data.get("project"),
            project_id=request.data.get("project"),
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    def destroy(self, request, slug, project_id):
        project_favorite = UserFavorite.objects.get(
            entity_identifier=project_id,
            entity_type="project",
            project=project_id,
            user=request.user,
            workspace__slug=slug,
        )
        project_favorite.delete(soft=False)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DeployBoardViewSet(BaseViewSet):
    permission_classes = [ProjectMemberPermission]
    serializer_class = DeployBoardSerializer
    model = DeployBoard

    def list(self, request, slug, project_id):
        project_deploy_board = DeployBoard.objects.filter(
            entity_name="project", entity_identifier=project_id, workspace__slug=slug
        ).first()

        serializer = DeployBoardSerializer(project_deploy_board)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def create(self, request, slug, project_id):
        comments = request.data.get("is_comments_enabled", False)
        reactions = request.data.get("is_reactions_enabled", False)
        intake = request.data.get("intake", None)
        votes = request.data.get("is_votes_enabled", False)
        views = request.data.get(
            "views",
            {
                "list": True,
                "kanban": True,
                "calendar": True,
                "gantt": True,
                "spreadsheet": True,
            },
        )

        project_deploy_board, _ = DeployBoard.objects.get_or_create(
            entity_name="project", entity_identifier=project_id, project_id=project_id
        )
        project_deploy_board.intake = intake
        project_deploy_board.view_props = views
        project_deploy_board.is_votes_enabled = votes
        project_deploy_board.is_comments_enabled = comments
        project_deploy_board.is_reactions_enabled = reactions

        project_deploy_board.save()

        serializer = DeployBoardSerializer(project_deploy_board)
        return Response(serializer.data, status=status.HTTP_200_OK)
