"""Synlora personal API key identity-binding tests."""

import json
from types import SimpleNamespace

import pytest
from plane.db.models import (
    ExternalSystemConnection,
    IntegrationSystem,
    ResearchAgentBackendConnection,
)
from plane.license.utils.encryption import decrypt_data, encrypt_data
from plane.research.services.agent_identity import (
    SynloraIdentityConflict,
    SynloraIdentityError,
    bind_synlora_api_key,
    ensure_synlora_identity_binding,
    repair_synlora_account_links,
    revoke_synlora_identity_connection,
)
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _synlora_connection(workspace):
    return ExternalSystemConnection.objects.create(
        workspace=workspace,
        system=IntegrationSystem.SYNLORA,
        display_name="Synlora",
        base_url="http://synlora.internal:5050",
        auth_mode=ExternalSystemConnection.AuthMode.BEARER,
        is_enabled=True,
    )


def _transport(status_code=200, sub="synlora-user", username="fangyikai"):
    def handler(request):
        assert request.url.path == "/api/v1/auth/me"
        assert request.headers["Authorization"] == "Bearer yxkey_test"
        if status_code != 200:
            return __import__("httpx").Response(status_code)
        return __import__("httpx").Response(
            200,
            json={
                "sub": sub,
                "username": username,
                "role": "user",
                "deployment_id": "synlora-test",
            },
        )

    return __import__("httpx").MockTransport(handler)


def test_bind_synlora_key_creates_one_to_one_identity():
    owner = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)

    binding = bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
    )

    assert binding.user == owner
    assert binding.external_user_id == "synlora-user"
    assert binding.external_username == "fangyikai"
    assert binding.deployment_id == "synlora-test"
    assert binding.base_url == "http://synlora.internal:5050"
    assert binding.credential_hash
    assert decrypt_data(binding.credential_encrypted) == "yxkey_test"


def test_same_synlora_user_cannot_bind_second_plane_user():
    owner = make_user()
    other = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)
    bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
    )

    with pytest.raises(SynloraIdentityConflict):
        bind_synlora_api_key(
            workspace,
            user=other,
            base_url="http://synlora.internal:5050",
            token="yxkey_test",
            transport=_transport(),
        )


def test_url_aliases_do_not_bypass_one_to_one_deployment_binding():
    """同一 Synlora 部署的内网/公网别名必须视为同一绑定范围。"""
    owner = make_user()
    other = make_user()
    workspace = make_workspace(owner)
    other_workspace = make_workspace(other)
    _synlora_connection(other_workspace)
    bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050/",
        token="yxkey_test",
        transport=_transport(),
    )

    with pytest.raises(SynloraIdentityConflict):
        bind_synlora_api_key(
            other_workspace,
            user=other,
            base_url="https://Synlora.Example:443",
            token="yxkey_test",
            transport=_transport(),
        )


def test_same_plane_user_can_rotate_key_for_same_synlora_user():
    owner = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)
    first = bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
    )

    connection = ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        system="SYNLORA",
        credential_encrypted=encrypt_data("yxkey_test"),
        identity_binding=first,
        is_enabled=True,
    )
    second = bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
        connection=connection,
    )

    assert second.pk == first.pk
    connection.refresh_from_db()
    assert connection.identity_binding == second


def test_invalid_synlora_key_fails_closed():
    owner = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)

    with pytest.raises(SynloraIdentityError):
        bind_synlora_api_key(
            workspace,
            user=owner,
            base_url="http://synlora.internal:5050",
            token="yxkey_test",
            transport=_transport(status_code=401),
        )


def test_repair_submits_one_idempotent_alias_per_plane_user(settings):
    owner = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)
    binding = bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
    )
    ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        system="SYNLORA",
        identity_binding=binding,
        credential_encrypted=encrypt_data("yxkey_test"),
        is_enabled=True,
    )
    settings.SYNLORA_SERVICE_TOKEN = "service-token"
    requests = []

    def handler(request):
        import httpx

        requests.append({"url": str(request.url), "json": json.loads(request.content)})
        return httpx.Response(201, json={"account_link_id": "plane-link"})

    result = repair_synlora_account_links(transport=__import__("httpx").MockTransport(handler))

    assert result == {"submitted": 1, "conflicts": 0, "failed": 0}
    assert len(requests) == 1
    assert requests[0]["json"]["synlora_user_id"] == "synlora-user"
    assert requests[0]["json"]["external_subject"].startswith("plane-ws-")
    assert requests[0]["json"]["workspace_name"] == workspace.name


def test_ensure_migrates_one_legacy_stored_synlora_key(settings, monkeypatch):
    settings.SYNLORA_BASE_URL = "http://synlora.internal:5050"
    owner = make_user()
    workspace = make_workspace(owner)
    _synlora_connection(workspace)
    ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        system="SYNLORA",
        credential_encrypted=encrypt_data("yxkey_test"),
        is_enabled=True,
    )
    monkeypatch.setattr(
        "plane.research.services.agent_identity.verify_synlora_api_key",
        lambda **_kwargs: SimpleNamespace(user_id="synlora-user", username="synlora", deployment_id="synlora-test"),
    )

    binding = ensure_synlora_identity_binding(workspace, owner)

    assert binding is not None
    connection = ResearchAgentBackendConnection.objects.get(workspace=workspace, user=owner, system="SYNLORA")
    assert connection.identity_binding == binding


def test_revoking_last_workspace_connection_removes_usable_credential():
    owner = make_user()
    workspace = make_workspace(owner)
    binding = bind_synlora_api_key(
        workspace,
        user=owner,
        base_url="http://synlora.internal:5050",
        token="yxkey_test",
        transport=_transport(),
    )
    connection = ResearchAgentBackendConnection.objects.create(
        workspace=workspace,
        user=owner,
        system="SYNLORA",
        identity_binding=binding,
        credential_encrypted=encrypt_data("yxkey_test"),
        is_enabled=True,
    )

    revoke_synlora_identity_connection(workspace, owner, connection)

    connection.refresh_from_db()
    binding.refresh_from_db()
    assert connection.identity_binding is None
    assert connection.credential_encrypted == ""
    assert binding.deleted_at is not None
    assert binding.credential_encrypted == ""
