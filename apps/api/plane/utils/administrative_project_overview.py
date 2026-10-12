"""按工作项可见范围生成行政项目首页概览。"""

from django.db.models import Count, F, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce, Greatest

from plane.db.models import Issue, IssueActivity, IssueComment, ProjectMember
from plane.utils.administrative_projects import administrative_projects_for_user


OVERVIEW_FIELDS = {"open_issues", "done_issues", "last_activity_at"}


def administrative_overview_annotations(user, slug, fields):
    """构造只计算所请求概览字段的项目查询注解。

    Args:
        user: 当前请求用户。
        slug: 工作区别名。
        fields: 请求的统计字段集合。

    Returns:
        可传入项目 queryset.annotate 的表达式字典。
    """
    managed_ids = administrative_projects_for_user(user, slug).values("id")
    restricted_ids = (
        ProjectMember.objects.filter(
            workspace__slug=slug,
            member=user,
            is_active=True,
            role=5,
            project__guest_view_all_features=False,
        )
        .exclude(project_id__in=managed_ids)
        .values("project_id")
    )
    # 与项目工作项列表一致：受限访客只能看到自己创建的工作项。
    issues = Issue.issue_objects.filter(workspace__slug=slug).exclude(
        Q(project_id__in=restricted_ids) & ~Q(created_by=user)
    )
    project_issues = issues.filter(project_id=OuterRef("pk"))
    annotations = {}
    for field, groups in (
        ("open_issues", ["backlog", "unstarted", "started"]),
        ("done_issues", ["completed"]),
    ):
        if field in fields:
            count = (
                project_issues.filter(state__group__in=groups)
                .order_by()
                .values("project_id")
                .annotate(count=Count("id"))
                .values("count")
            )
            annotations[field] = Coalesce(Subquery(count), Value(0))

    if "last_activity_at" in fields:
        issue_ids = issues.order_by().values("id")
        activities = IssueActivity.objects.filter(
            workspace__slug=slug,
            project_id=OuterRef("pk"),
            issue_id__in=issue_ids,
            issue_comment__deleted_at__isnull=True,
        ).annotate(activity_at=Greatest("created_at", "updated_at"))
        comments = IssueComment.objects.filter(
            workspace__slug=slug, project_id=OuterRef("pk"), issue_id__in=issue_ids
        ).annotate(activity_at=Greatest("updated_at", "edited_at"))
        annotations["last_activity_at"] = Greatest(
            F("updated_at"),
            Coalesce(Subquery(project_issues.order_by("-updated_at").values("updated_at")[:1]), F("updated_at")),
            Coalesce(Subquery(activities.order_by("-activity_at").values("activity_at")[:1]), F("updated_at")),
            Coalesce(Subquery(comments.order_by("-activity_at").values("activity_at")[:1]), F("updated_at")),
        )
    return annotations
