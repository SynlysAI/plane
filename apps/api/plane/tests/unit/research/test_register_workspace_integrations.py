# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""public 工作区 RAGPortal / Synlora 登记回归。"""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import ExternalSystemConnection
from plane.research.services.workspace_integration_registration import register_workspace_integrations
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


class _Probe:
    def __init__(self, connection, *, ok=True):
        self.connection = connection
        self.ok = ok

    def health(self):
        self.connection.health_status = (
            ExternalSystemConnection.HealthStatus.OK if self.ok else ExternalSystemConnection.HealthStatus.DEGRADED
        )
        self.connection.last_error = "" if self.ok else "http_error"
        self.connection.save(update_fields=["health_status", "last_error", "updated_at"])

        class Result:
            latency_ms = 8
            degraded_reason = "" if self.ok else "http_error"
            request_id = "req-test"

        return Result()


def _command(monkeypatch, *args):
    """运行登记命令。"""
    monkeypatch.setattr(
        "plane.research.services.workspace_integration_registration.client_for",
        lambda system, connection=None: _Probe(connection),
    )
    stdout = StringIO()
    call_command("register_workspace_integrations", *args, stdout=stdout)
    return json.loads(stdout.getvalue()), stdout.getvalue()


def test_apply_is_idempotent_and_hides_the_secret(db, monkeypatch):
    owner = make_user()
    workspace = make_workspace(owner, slug="public")
    first, raw = _command(
        monkeypatch,
        "--workspace",
        "public",
        "--ragportal-url",
        "http://ragportal.internal:8004",
        "--synlora-url",
        "http://synlora.internal:8005",
    )
    assert first["continue_r8"] is True
    assert {row["system"] for row in first["results"]} == {"RAGPORTAL", "SYNLORA"}
    assert all(row["degraded_reason"] == "" for row in first["results"])
    ids = set(ExternalSystemConnection.objects.filter(workspace=workspace).values_list("id", flat=True))
    assert len(ids) == 2
    second, _raw = _command(
        monkeypatch,
        "--workspace",
        "public",
        "--ragportal-url",
        "http://ragportal.internal:8004",
        "--synlora-url",
        "http://synlora.internal:8005",
    )
    assert second["continue_r8"] is True
    assert set(ExternalSystemConnection.objects.filter(workspace=workspace).values_list("id", flat=True)) == ids
    assert not ExternalSystemConnection.objects.filter(workspace=workspace).exclude(credential="").exists()


def test_disable_keeps_the_previous_health_error(db, monkeypatch):
    owner = make_user()
    workspace = make_workspace(owner, slug="public")
    monkeypatch.setattr(
        "plane.research.services.workspace_integration_registration.client_for",
        lambda system, connection=None: _Probe(connection, ok=False),
    )
    register_workspace_integrations(
        workspace,
        base_urls={"RAGPORTAL": "http://ragportal.internal:8004", "SYNLORA": "http://synlora.internal:8005"},
    )
    payload, _raw = _command(monkeypatch, "--workspace", "public", "--disable")
    assert all(row["degraded_reason"] == "http_error" for row in payload["results"])
    assert all(row["preserved_error"] is True for row in payload["results"])
    assert ExternalSystemConnection.objects.filter(workspace=workspace, is_enabled=True).count() == 0
    assert ExternalSystemConnection.objects.filter(workspace=workspace).count() == 2


def test_rejects_other_workspaces_and_systems(db, monkeypatch):
    owner = make_user()
    make_workspace(owner, slug="pi")
    with pytest.raises(CommandError, match="public"):
        _command(monkeypatch, "--workspace", "pi")
    public = make_workspace(owner, slug="public")
    with pytest.raises(Exception, match="RAGPORTAL"):
        register_workspace_integrations(public, base_urls={"SPECLABOS": "http://example.invalid"})
