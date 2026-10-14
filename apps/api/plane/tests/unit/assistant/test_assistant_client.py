# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Assistant BFF client: config resolution and Run API request shaping."""

import pytest

from plane.app.views.assistant.client import (
    AssistantNotConfigured,
    resolve_assistant_client,
    resolve_assistant_config,
)
from plane.db.models import ExternalSystemConnection, IntegrationSystem
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _connection(workspace, credential=None, **kwargs):
    defaults = {
        "workspace": workspace,
        "system": IntegrationSystem.SYNLORA,
        "display_name": "Synlora",
        "base_url": "http://synlora.internal:5050",
        "auth_mode": ExternalSystemConnection.AuthMode.BEARER,
        "is_enabled": True,
    }
    defaults.update(kwargs)
    connection = ExternalSystemConnection.objects.create(**defaults)
    if credential:
        connection.set_credential(credential)
        connection.save(update_fields=["credential"])
    return connection


def test_personal_mode_has_no_shared_client(db, settings):
    settings.SYNLORA_BASE_URL = ""
    owner = make_user()
    workspace = make_workspace(owner)
    _connection(workspace, credential="yxkey-personal", credential_mode="PERSONAL")
    config = resolve_assistant_config(workspace)
    assert config.credential_mode == "PERSONAL"
    assert config.token == ""
    with pytest.raises(AssistantNotConfigured):
        resolve_assistant_client(workspace)


def test_shared_credential_and_env_base_url_fallback(db, settings):
    settings.SYNLORA_BASE_URL = "http://fallback:5050/"
    owner = make_user()
    workspace = make_workspace(owner)
    connection = ExternalSystemConnection.objects.create(
        workspace=workspace,
        system=IntegrationSystem.SYNLORA,
        display_name="Synlora",
        base_url="",
        auth_mode=ExternalSystemConnection.AuthMode.BEARER,
        is_enabled=True,
    )
    connection.set_credential("yxkey-shared")
    connection.save(update_fields=["credential"])

    client = resolve_assistant_client(workspace)
    assert client.config.base_url == "http://fallback:5050"
    assert client.config.token == "yxkey-shared"
    assert client._headers == {"Authorization": "Bearer yxkey-shared"}


def test_disabled_or_missing_connection_is_not_configured(db, settings):
    settings.SYNLORA_BASE_URL = "http://fallback:5050"
    owner = make_user()
    workspace = make_workspace(owner)
    # no connection row at all
    with pytest.raises(AssistantNotConfigured):
        resolve_assistant_client(workspace)
    # disabled row
    _connection(workspace, credential="yxkey-shared", is_enabled=False)
    with pytest.raises(AssistantNotConfigured):
        resolve_assistant_client(workspace)


def test_start_run_always_pins_the_server_side_agent_slug(db, settings):
    settings.SYNLORA_BASE_URL = "http://synlora.internal:5050"
    settings.SYNLORA_AGENT_SLUG = "plane-assistant"
    owner = make_user()
    workspace = make_workspace(owner)
    _connection(workspace, credential="yxkey-shared")
    client = resolve_assistant_client(workspace)

    captured = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {}

    def fake_request(method, url, *, headers=None, json=None, params=None, timeout=None):
        captured.update({"method": method, "url": url, "json": json, "headers": headers})
        return FakeResponse()

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr("plane.app.views.assistant.client.httpx.request", fake_request)
        response = client.start_run(query="q", thread_id="t-1", request_id="r-1")

    assert response.status_code == 200
    assert captured["method"] == "POST"
    assert captured["url"] == "http://synlora.internal:5050/api/agent/runs"
    assert captured["json"]["agent_slug"] == "plane-assistant"
    assert captured["json"]["queue_policy"] == "enqueue"
    assert captured["json"]["meta"] == {"request_id": "r-1"}
    assert captured["headers"]["Authorization"] == "Bearer yxkey-shared"
