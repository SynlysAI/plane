"""科研列表共用的服务端范围、关键词和日期筛选。"""

from django.db.models import Q

from plane.research.views.base import parse_date, parse_uuid


def filter_profiles(queryset, request):
    """在可见项目查询上应用筛选，分页前完成过滤。

    Args:
        queryset: 已执行项目 ACL 的查询。
        request: 含列表查询参数的请求。

    Returns:
        过滤后的查询及可选错误响应。
    """
    from rest_framework.response import Response

    scope = request.GET.get("scope", "all")
    if scope not in {"all", "owned", "participating"}:
        return None, Response({"error_code": "invalid_scope"}, status=400)
    if scope == "owned":
        queryset = queryset.filter(owner=request.user)
    elif scope == "participating":
        queryset = queryset.filter(
            project__project_projectmember__member=request.user,
            project__project_projectmember__is_active=True,
            project__project_projectmember__deleted_at__isnull=True,
        )
    keyword = str(request.GET.get("q") or "").strip()[:200]
    if keyword:
        queryset = queryset.filter(
            Q(project__name__icontains=keyword)
            | Q(project__identifier__icontains=keyword)
            | Q(owner__display_name__icontains=keyword)
            | Q(owner__first_name__icontains=keyword)
        )
    for parameter, field in (("owner", "owner_id"), ("org_unit", "org_unit_id")):
        value, error = parse_uuid(request.GET.get(parameter), parameter)
        if error:
            return None, error
        if value:
            queryset = queryset.filter(**{field: value})
    dates = {}
    for parameter in ("date_from", "date_to"):
        dates[parameter], error = parse_date(request.GET.get(parameter), parameter)
        if error:
            return None, error
    if dates["date_from"] and dates["date_to"] and dates["date_from"] > dates["date_to"]:
        return None, Response({"error_code": "invalid_date_range"}, status=400)
    if dates["date_from"]:
        queryset = queryset.filter(started_at__gte=dates["date_from"])
    if dates["date_to"]:
        queryset = queryset.filter(started_at__lte=dates["date_to"])
    for parameter in ("research_type", "workflow_status"):
        if request.GET.get(parameter):
            queryset = queryset.filter(**{parameter: request.GET[parameter].upper()})
    return queryset.distinct(), None
