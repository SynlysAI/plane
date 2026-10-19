from django.urls import path

from plane.mcp.views import NativeMCPBridgeEndpoint

urlpatterns = [
    path("mcp/native/<path:action>/", NativeMCPBridgeEndpoint.as_view(), name="native-mcp-bridge"),
]
