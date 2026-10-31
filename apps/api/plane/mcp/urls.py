from django.urls import path

from plane.mcp.views import NativeMCPBridgeEndpoint
from plane.mcp.endpoints import (
    UnifiedConnectionOptionsEndpoint,
    UnifiedConnectionsEndpoint,
    UnifiedMCPEndpoint,
    UnifiedRevokeEndpoint,
    UnifiedDeleteEndpoint,
    UnifiedConfigurationEndpoint,
    UnifiedRotateEndpoint,
)

urlpatterns = [
    path("mcp/", UnifiedMCPEndpoint.as_view(), name="unified-mcp"),
    path("mcp/connections/", UnifiedConnectionsEndpoint.as_view(), name="unified-mcp-connections"),
    path("mcp/connections/options/", UnifiedConnectionOptionsEndpoint.as_view(), name="unified-mcp-options"),
    path(
        "mcp/connections/<uuid:connection_id>/configuration/",
        UnifiedConfigurationEndpoint.as_view(),
        name="unified-mcp-configuration",
    ),
    path("mcp/connections/<uuid:connection_id>/rotate/", UnifiedRotateEndpoint.as_view(), name="unified-mcp-rotate"),
    path("mcp/connections/<uuid:connection_id>/revoke/", UnifiedRevokeEndpoint.as_view(), name="unified-mcp-revoke"),
    path("mcp/connections/<uuid:connection_id>/", UnifiedDeleteEndpoint.as_view(), name="unified-mcp-delete"),
    path("mcp/native/<path:action>/", NativeMCPBridgeEndpoint.as_view(), name="native-mcp-bridge"),
]
