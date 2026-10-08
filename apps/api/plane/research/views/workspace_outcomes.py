"""工作区成果分页浏览，复用既有成果模型及可见性矩阵。"""

from django.db.models import Q
from rest_framework.response import Response

from plane.db.models import ProjectMember, ResearchOutcome
from plane.research.serializers.outcome import ResearchOutcomeSerializer
from plane.research.utils.acl import build_actor_context
from plane.research.utils.projects import TEAM_CONTENT_ROLES
from plane.research.views.base import ResearchAPIView, parse_date, parse_uuid
from plane.research.views.projects import visible_profile_queryset


class ResearchWorkspaceOutcomeEndpoint(ResearchAPIView):
    """先在数据库过滤权限及条件，再分页和序列化。"""

    def get(self, request, slug):
        """返回可见成果以及允许登记成果的项目选项。"""
        workspace, error = self.get_workspace(section="stages")
        if error:
            return error
        context = build_actor_context(request.user, workspace.id)
        profiles = visible_profile_queryset(workspace, request.user)
        queryset = (
            ResearchOutcome.objects.filter(workspace=workspace)
            .select_related(
                "project__research_profile",
                "created_by",
            )
            .prefetch_related("links", "attachments")
        )
        profile = "project__research_profile__"
        owner = Q(created_by=request.user) | Q(created_by__isnull=True, **{profile + "owner": request.user})
        formal = ~Q(status="DRAFT")
        audience = Q()
        if context.is_main_pi:
            audience = formal
        else:
            audience = formal & (
                Q(**{profile + "org_unit_id__in": context.managing_unit_ids})
                | Q(created_by_id__in=context.advises)
                | Q(created_by__isnull=True, **{profile + "owner_id__in": context.advises})
                | Q(visibility="WORKSPACE")
                | Q(visibility="UNIT", **{profile + "org_unit_id__in": context.unit_ids})
                | Q(**{profile + "research_type": "RESEARCH_PROJECT", "project_id__in": context.project_ids})
            )
        queryset = queryset.filter(owner | audience).distinct()
        keyword = str(request.GET.get("q") or "").strip()[:200]
        if keyword:
            queryset = queryset.filter(
                Q(title__icontains=keyword) | Q(venue__icontains=keyword) | Q(doi__icontains=keyword)
            )
        for parameter, field in (("org_unit", profile + "org_unit_id"), ("owner", "created_by_id")):
            value, error = parse_uuid(request.GET.get(parameter), parameter)
            if error:
                return error
            if value:
                queryset = queryset.filter(**{field: value})
        dates = {}
        for parameter, lookup in (("date_from", "gte"), ("date_to", "lte")):
            value, error = parse_date(request.GET.get(parameter), parameter)
            if error:
                return error
            dates[parameter] = value
            if value:
                queryset = queryset.filter(**{f"published_at__{lookup}": value})
        if dates["date_from"] and dates["date_to"] and dates["date_from"] > dates["date_to"]:
            return Response({"error_code": "invalid_date_range"}, status=400)
        for parameter in ("output_type", "status"):
            if request.GET.get(parameter):
                queryset = queryset.filter(**{parameter: request.GET[parameter].upper()})
        scope = request.GET.get("scope", "all")
        if scope == "mine":
            queryset = queryset.filter(owner)
        elif scope != "all":
            return Response({"error_code": "invalid_scope"}, status=400)
        response = self.paginate(
            request=request,
            queryset=queryset.order_by("-created_at", "id"),
            on_results=lambda items: ResearchOutcomeSerializer(items, many=True, context={"request": request}).data,
            default_per_page=50,
            max_per_page=100,
        )
        active_member_project_ids = set(
            ProjectMember.objects.filter(
                project_id__in=[profile.project_id for profile in profiles],
                workspace=workspace,
                member=request.user,
                role__in=TEAM_CONTENT_ROLES,
                is_active=True,
                deleted_at__isnull=True,
            ).values_list("project_id", flat=True)
        )
        response.data["create_projects"] = [
            {"id": str(item.project_id), "name": item.project.name}
            for item in profiles
            if item.owner_id == request.user.id or item.project_id in active_member_project_ids
        ]
        return response
