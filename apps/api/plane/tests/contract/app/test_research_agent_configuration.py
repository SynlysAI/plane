"""个人智能体配置的治理、权限与已有会话兼容性。"""

import pytest
import httpx
from rest_framework.test import APIClient

from plane.db.models import (
    ResearchAgentBackendConnection,
    ResearchAgentSession,
    ResearchAuditEvent,
    WorkspaceResearchSetting,
)
from plane.license.utils.encryption import decrypt_data, encrypt_data
from plane.research.services.backend_connections import resolve_science_discovery_connection
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    make_org_member,
    make_user,
    make_workspace,
)

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


def client_for(user):
    """创建指定用户的认证客户端。"""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_governance_setting_round_trip_and_audit(settings):
    """管理员可保存总闸并产生审计，普通科研成员不能修改。"""
    settings.RESEARCH_MODULE_ENABLED = True
    admin = make_user()
    workspace = make_workspace(admin)
    make_org_member(workspace, admin)
    enable_research(workspace, research_agent_enabled=True)
    url = f"/api/research/workspaces/{workspace.slug}/settings/"
    client = client_for(admin)
    assert client.get(url).json()["research_agent_user_backend_enabled"] is False
    for enabled in (True, False):
        response = client.patch(url, {"research_agent_user_backend_enabled": enabled}, format="json")
        assert response.status_code == 200
        assert response.json()["research_agent_user_backend_enabled"] is enabled
        assert client.get(url).json()["research_agent_user_backend_enabled"] is enabled
    events = ResearchAuditEvent.objects.filter(workspace=workspace, action="config.update")
    assert any("research_agent_user_backend_enabled" in event.metadata["changed"] for event in events)
    member = make_user()
    add_workspace_member(workspace, member)
    make_org_member(workspace, member, org_role="MEMBER")
    assert (
        client_for(member).patch(url, {"research_agent_user_backend_enabled": True}, format="json").status_code == 403
    )


def test_connection_access_requires_research_organization_membership(sd_session):
    """普通工作区成员无法读取、保存、测试或删除连接。"""
    workspace = sd_session.workspace
    member = make_user()
    add_workspace_member(workspace, member)
    client = client_for(member)
    url = f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/"
    assert client.get(url).status_code == 403
    assert client.post(url, {"base_url": "http://192.168.1.10:5300", "token": "test"}).status_code == 403
    assert client.post(f"{url}test/").status_code == 403
    assert client.delete(url).status_code == 403


def test_connections_are_isolated_per_user_and_workspace(sd_session, settings):
    """只有本人科研组织连接可见，其他用户和工作区均无法读取凭据。"""
    settings.RESEARCH_MODULE_ENABLED = True
    workspace = sd_session.workspace
    admin = make_user()
    add_workspace_member(workspace, admin, role=20)
    make_org_member(workspace, admin)
    client = client_for(admin)
    url = f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/"
    assert client.get(url).json()["connection"] is None
    response = client.post(
        url,
        {"base_url": "http://192.168.1.11:5300", "token": "isolated-secret", "is_enabled": True},
        format="json",
    )
    assert response.status_code == 201
    own = ResearchAgentBackendConnection.objects.get(workspace=workspace, user=admin)
    assert decrypt_data(own.credential_encrypted) == "isolated-secret"
    assert client.get(url).json()["connection"]["base_url"] == own.base_url
    assert (
        client_for(sd_session.user).get(url).json()["connection"]["base_url"] == sd_session.backend_connection.base_url
    )

    other_workspace = make_workspace(admin)
    make_org_member(other_workspace, admin)
    other_connection = ResearchAgentBackendConnection.objects.create(
        workspace=other_workspace,
        user=admin,
        base_url="http://192.168.1.12:5300",
        credential_encrypted=encrypt_data("other-workspace-secret"),
        is_enabled=True,
        created_by=admin,
    )
    setting, _ = WorkspaceResearchSetting.objects.get_or_create(workspace=other_workspace)
    setting.research_agent_user_backend_enabled = True
    setting.save(update_fields=["research_agent_user_backend_enabled", "updated_at"])
    assert resolve_science_discovery_connection(other_workspace, admin).pk == other_connection.pk


def test_removing_connection_preserves_bound_sessions(sd_session):
    """删除连接会停用新会话路由，同时保留已有会话的运行时绑定。"""
    connection_id = sd_session.backend_connection_id
    url = f"/api/research/workspaces/{sd_session.workspace.slug}/agent/backend-connections/"
    setting = WorkspaceResearchSetting.objects.get(workspace=sd_session.workspace)
    setting.research_agent_user_backend_enabled = True
    setting.save(update_fields=["research_agent_user_backend_enabled", "updated_at"])
    response = client_for(sd_session.user).delete(url)
    assert response.status_code == 204
    sd_session.refresh_from_db()
    assert sd_session.backend_connection_id == connection_id
    assert ResearchAgentSession.objects.get(pk=sd_session.pk).backend_connection_id == connection_id
    assert not ResearchAgentBackendConnection.objects.filter(pk=connection_id).exists()
    connection = ResearchAgentBackendConnection.all_objects.get(pk=connection_id)
    assert connection.deleted_at is not None
    assert connection.credential_encrypted
    assert not ResearchAgentSession.objects.filter(pk=sd_session.pk).first().deleted_at
    assert resolve_science_discovery_connection(sd_session.workspace, sd_session.user) is None


def test_seated_research_admin_without_org_can_configure_backend(settings):
    """入座科研管理员无需 OrgUnit 即可读写个人智能体后端。"""
    settings.RESEARCH_MODULE_ENABLED = True
    admin = make_user()
    workspace = make_workspace(admin)
    enable_research(workspace, research_agent_enabled=True, research_agent_user_backend_enabled=True)
    client = client_for(admin)
    url = f"/api/research/workspaces/{workspace.slug}/agent/backend-connections/"
    assert client.get(url).status_code == 200
    response = client.post(
        url,
        {"base_url": "http://192.168.1.20:5300", "token": "admin-secret", "is_enabled": True},
        format="json",
    )
    assert response.status_code == 201


def test_cloud_and_local_configs_are_saved_and_removed_independently(sd_session):
    client = client_for(sd_session.user)
    url = f"/api/research/workspaces/{sd_session.workspace.slug}/agent/backend-connections/"
    local = sd_session.backend_connection
    local_credential = local.credential_encrypted
    response = client.post(url, {"system": "SYNLORA", "token": "cloud-personal-token"}, format="json")
    assert response.status_code == 201
    cloud = ResearchAgentBackendConnection.objects.get(
        workspace=sd_session.workspace, user=sd_session.user, system="SYNLORA"
    )
    assert cloud.is_enabled
    assert decrypt_data(cloud.credential_encrypted) == "cloud-personal-token"
    response = client.post(url, {"system": "SYNLORA", "base_url": ""}, format="json")
    assert response.status_code == 201
    cloud.refresh_from_db()
    assert decrypt_data(cloud.credential_encrypted) == "cloud-personal-token"
    assert client.get(url, {"system": "SYNLORA"}).json()["connection"]["id"] == str(cloud.id)
    assert client.get(url).json()["connection"]["id"] == str(local.id)
    assert client.delete(f"{url}?system=SYNLORA").status_code == 204
    assert client.get(url, {"system": "SYNLORA"}).json()["connection"] is None
    local.refresh_from_db()
    assert local.credential_encrypted == local_credential


def test_cloud_probe_uses_cloud_token_and_does_not_probe_local(sd_session, settings, monkeypatch):
    from plane.app.views.assistant.client import SynloraAssistantClient
    from plane.research.services.sciencediscovery import ScienceDiscoveryClient

    settings.SYNLORA_BASE_URL = "http://synlora.internal:5050"
    client = client_for(sd_session.user)
    url = f"/api/research/workspaces/{sd_session.workspace.slug}/agent/backend-connections/"
    client.post(url, {"system": "SYNLORA", "token": "cloud-probe-token"}, format="json")
    local_probe = []
    monkeypatch.setattr(ScienceDiscoveryClient, "list_models", lambda self: local_probe.append(True))
    configs = []

    def health(self):
        configs.append(self.config)
        return httpx.Response(200, request=httpx.Request("GET", f"{self.config.base_url}/api/system/ready"))

    monkeypatch.setattr(SynloraAssistantClient, "health", health)
    response = client.post(f"{url}test/", {"system": "SYNLORA"}, format="json")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert configs[0].token == "cloud-probe-token"
    assert configs[0].base_url == settings.SYNLORA_BASE_URL
    assert local_probe == []
    cloud = ResearchAgentBackendConnection.objects.get(
        workspace=sd_session.workspace, user=sd_session.user, system="SYNLORA"
    )
    assert cloud.health_status == "OK"

    def unavailable(self):
        raise httpx.ConnectError("unavailable")

    monkeypatch.setattr(SynloraAssistantClient, "health", unavailable)
    response = client.post(f"{url}test/", {"system": "SYNLORA"}, format="json")
    assert response.status_code == 502
    assert response.json()["ok"] is False
    cloud.refresh_from_db()
    assert cloud.health_status == "DOWN"
