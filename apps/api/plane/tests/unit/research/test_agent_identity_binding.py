"""Synlora personal API key identity-binding tests."""

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
            200, json={"sub": sub, "username": username, "role": "user"}
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
