"""Phase 0 research observability and active external health probes."""

from datetime import timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from plane.db.models import IntegrationCallLog, IntegrationSystem, ResearchAgentSession, ResearchAuditEvent, ResearchChainEvent
from plane.research.services.integrations import client_for
from plane.research.utils.audit import ResearchAuditAction
from plane.research.utils.capabilities import NAV_PLATFORM
from plane.research.utils.org import is_workspace_admin
from plane.research.utils.settings import workspace_research_sections
from plane.research.views.base import ResearchAPIView
from plane.research.views.integrations import connection_map


class ResearchObservabilityEndpoint(ResearchAPIView):
    """``GET /api/research/workspaces/<slug>/observability/``."""

    nav_capability = NAV_PLATFORM

    def get(self, request, slug):
        workspace, error = self.get_workspace(section="org")
        if error:
            return error
        if not is_workspace_admin(request.user, workspace.id):
            return Response({"error_code": "research_permission_denied"}, status=status.HTTP_403_FORBIDDEN)

        now = timezone.now()
        day_ago = now - timedelta(days=1)
        audits = ResearchAuditEvent.objects.filter(workspace=workspace)
        calls = IntegrationCallLog.objects.filter(workspace=workspace)
        sessions = ResearchAgentSession.objects.filter(workspace=workspace)
        denials_24h = audits.filter(action=ResearchAuditAction.SECURITY_DENIED, created_at__gte=day_ago).count()
        degraded_total = calls.filter(outcome="DEGRADED").count() + sessions.filter(status="DEGRADED").count()
        agent_errors = sessions.filter(status__in=("ERROR", "DEGRADED")).count()

        metrics = {
            "schema_version": "research-observability.v1",
            "api_requests_total": audits.count(),
            "agent_runs_total": sessions.count(),
            "external_calls_total": calls.count(),
            "external_degraded_total": calls.filter(outcome="DEGRADED").count(),
            "agent_degraded_total": sessions.filter(status="DEGRADED").count(),
            "security_denials_total": audits.filter(action=ResearchAuditAction.SECURITY_DENIED).count(),
            "security_denials_24h": denials_24h,
            "context_reads_total": audits.filter(action=ResearchAuditAction.CONTEXT_READ).count(),
            "chain_events_total": ResearchChainEvent.objects.filter(chain__workspace=workspace).count(),
            "agent_errors_total": agent_errors,
            "degraded_total": degraded_total,
        }
        alerts = {
            "external_degraded": degraded_total > 0,
            "security_denial_spike": denials_24h > 100,
            "agent_error_rate": agent_errors > 0 and sessions.count() > 0 and agent_errors / sessions.count() > 0.2,
        }
        return Response(
            {
                "metrics": metrics,
                "alerts": alerts,
                "log_redaction": {
                    "request_body": "not_persisted",
                    "response_body": "not_persisted",
                    "sensitive_headers": ["authorization", "cookie", "x-api-key", "x-research-context-token"],
                },
                "external_sources": {
                    "api_latency_and_errors": "plane.api.request JSON logs",
                    "queue_wait": "celery worker telemetry",
                    "storage_bytes": "object-storage telemetry",
                },
            }
        )


class ResearchExternalHealthProbeEndpoint(ResearchAPIView):
    """Actively probe configured external systems without persisting bodies."""

    nav_capability = NAV_PLATFORM

    def post(self, request, slug):
        workspace, error = self.get_workspace(section="integrations")
        if error:
            return error
        if not is_workspace_admin(request.user, workspace.id):
            return Response({"error_code": "research_permission_denied"}, status=status.HTTP_403_FORBIDDEN)
        requested = str(request.data.get("system") or request.GET.get("system") or "").upper()
        systems = [requested] if requested else list(IntegrationSystem.values)
        connections = connection_map(workspace, enabled_only=True)
        results = []
        for system in systems:
            if system not in IntegrationSystem.values:
                continue
            connection = connections.get(system)
            if connection is None:
                results.append({"system": system, "status": "UNKNOWN", "reason": "not_configured"})
                continue
            result = client_for(system, connection).health(request=request)
            results.append(
                {
                    "system": system,
                    "status": "DEGRADED" if result.degraded else "OK",
                    "reason": result.degraded_reason,
                    "request_id": result.request_id,
                    "latency_ms": result.latency_ms,
                }
            )
        return Response(
            {
                "results": results,
                "count": len(results),
                "degraded_count": sum(item["status"] == "DEGRADED" for item in results),
            }
        )
