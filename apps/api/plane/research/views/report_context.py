"""普通报告选择列表与受控正式正文读取接口。"""

from rest_framework.response import Response

from plane.db.models import PeriodicReport, ResearchChainNode, ResearchContextGrant
from plane.research.services.report_context import content_for_grant, selected_report_content
from plane.research.services.synlora import SynloraError
from plane.research.views.base import ResearchAPIView, parse_uuid
from plane.research.views.context import ContextAuthenticationMixin, _validate_context_grant
from plane.research.views.projects import visible_profile_queryset


class ResearchFormalReportOptionsEndpoint(ResearchAPIView):
    """只列出当前课题关联且可见的固定正式版本。"""

    def get(self, request, slug):
        """根据课题或研究链节点返回正式报告选择项。"""
        workspace, error = self.get_workspace(section="research_agent", nav=None)
        if error:
            return error
        project_id, error = parse_uuid(request.GET.get("project_id"), "project_id")
        if error:
            return error
        if request.GET.get("chain_node_id"):
            node_id, error = parse_uuid(request.GET["chain_node_id"], "chain_node_id")
            if error:
                return error
            node = ResearchChainNode.objects.filter(pk=node_id, chain__workspace=workspace).first()
            project_id = node.chain.project_id if node else None
        if (
            not project_id
            or not visible_profile_queryset(workspace, request.user).filter(project_id=project_id).exists()
        ):
            return Response({"error_code": "report_context_denied"}, status=404)
        from django.db.models import Q

        reports = (
            PeriodicReport.objects.filter(
                Q(project_id=project_id) | Q(team_projects__id=project_id),
                workspace=workspace,
                submitted_at__isnull=False,
            )
            .prefetch_related("official_snapshots", "access_grants")
            .distinct()
        )
        results = []
        for report in reports:
            snapshot = report.official_snapshots.order_by("-version_no").first()
            if not snapshot:
                continue
            selection = {"report_id": str(report.id), "version_no": snapshot.version_no}
            try:
                content = selected_report_content(
                    workspace=workspace, actor=request.user, project_id=project_id, selections=[selection]
                )[0]
            except SynloraError as failure:
                if failure.code != "report_context_too_large":
                    continue
                content = {
                    "title": f"{report.period_key} · {report.get_report_type_display()}",
                    "text": snapshot.description_stripped or "",
                }
            results.append({**selection, "title": content["title"], "characters": len(content["text"])})
        return Response(
            {"results": results, "association_hint": "无项目报告需要先关联当前课题，再作为 Agent 正式报告上下文。"}
        )


class ResearchFormalReportContentEndpoint(ContextAuthenticationMixin, ResearchAPIView):
    """正文读取需要固定版本 Context 授权，元数据旧接口保持兼容。"""

    def get(self, request, slug, context_id):
        """检查 Context 归属及所有逐次授权条件后返回正式正文。"""
        workspace, error = self.get_workspace(nav=None)
        if error:
            return error
        authentication_grant = _validate_context_grant(request, workspace)
        if isinstance(authentication_grant, Response):
            return authentication_grant
        grant = (
            ResearchContextGrant.objects.select_related("workspace", "user")
            .filter(
                context_id=context_id,
                workspace=workspace,
                user=request.user,
            )
            .first()
        )
        if grant is None or isinstance(request.auth, ResearchContextGrant) and request.auth.pk != grant.pk:
            return Response({"error_code": "report_context_denied"}, status=404)
        from hmac import compare_digest

        supplied_hash = request.headers.get("X-Research-Context-Hash") or request.GET.get("context_hash")
        if supplied_hash and not compare_digest(str(supplied_hash), grant.context_hash):
            return Response({"error_code": "report_context_denied", "message": "报告 Context 哈希不匹配。"}, status=403)
        try:
            contents = content_for_grant(grant)
        except SynloraError as failure:
            return Response({"error_code": failure.code, "message": str(failure)}, status=failure.status_code)
        return Response({"context_id": str(grant.context_id), "context_hash": grant.context_hash, "reports": contents})
