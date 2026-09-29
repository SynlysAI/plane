# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""小组知识库确认回归。"""

import json
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import OrgUnit, ResearchChainUpload, ResearchGroupKnowledgeBinding
from plane.research.services.group_knowledge import (
    GroupKnowledgeConfirmError,
    confirm_group_binding,
    describe_ragportal_candidates,
)
from plane.research.utils.org import build_path
from plane.tests.research_fixtures import make_user, make_workspace

pytestmark = pytest.mark.django_db


def _team(workspace, name):
    """创建一个活动小组。"""
    unit = OrgUnit.objects.create(
        workspace=workspace,
        name=name,
        unit_type=OrgUnit.UnitType.TEAM,
        depth=2,
        path="",
        is_active=True,
    )
    unit.path = build_path(unit.id, None)
    unit.save(update_fields=["path"])
    return unit


def test_confirm_is_reused_by_the_same_team_and_rejected_across_teams(db):
    owner = make_user()
    workspace = make_workspace(owner, slug="public")
    devices = _team(workspace, "器件")
    other = _team(workspace, "磷酸")
    pending = ResearchGroupKnowledgeBinding.objects.create(
        workspace=workspace,
        org_unit=other,
        request_key=f"team:{other.id}",
        state=ResearchGroupKnowledgeBinding.State.PENDING_ADMIN,
    )
    binding = confirm_group_binding(workspace, devices, "kb-devices", "器件", owner, seen_at="2026-09-27T00:00:00")
    assert binding.state == ResearchGroupKnowledgeBinding.State.READY
    again = confirm_group_binding(workspace, devices, "kb-devices", "器件", owner)
    assert again.id == binding.id
    with pytest.raises(GroupKnowledgeConfirmError, match="另一个小组"):
        confirm_group_binding(workspace, other, "kb-devices", "器件", owner)
    pending.refresh_from_db()
    assert pending.state == ResearchGroupKnowledgeBinding.State.PENDING_ADMIN
    assert pending.external_kb_id == ""
    assert ResearchChainUpload.objects.count() == 0


def test_candidate_messages_do_not_mix_connection_states(db, monkeypatch):
    owner = make_user()
    workspace = make_workspace(owner, slug="public")
    assert describe_ragportal_candidates(workspace)["connection_status"] == "not_connected"

    class EmptyClient:
        def knowledge_bases(self):
            class Result:
                degraded = False
                degraded_reason = ""
                items = []

            return Result()

    monkeypatch.setattr(
        "plane.research.services.group_knowledge.client_for",
        lambda system, connection=None: EmptyClient(),
    )
    from plane.db.models import ExternalSystemConnection

    ExternalSystemConnection.objects.create(
        workspace=workspace,
        system="RAGPORTAL",
        display_name="RAGPortal",
        base_url="http://ragportal.internal:8004",
        credential_ref="RAGPORTAL_AUTH_SECRET",
        is_enabled=True,
    )
    described = describe_ragportal_candidates(workspace)
    assert described["connection_status"] == "connected"
    assert described["candidates"] == []
    assert ResearchChainUpload.objects.count() == 0


def test_command_writes_only_a_unique_name(db, monkeypatch):
    owner = make_user()
    workspace = make_workspace(owner, slug="public")
    _team(workspace, "器件")

    def described(_workspace):
        return {
            "connection_status": "connected",
            "degraded_reason": "",
            "candidates": [
                {"name": "器件", "external_id": "kb-1", "source": "RAGPORTAL", "seen_at": "2026-09-27T00:00:00"},
                {"name": "其他", "external_id": "kb-2", "source": "RAGPORTAL", "seen_at": "2026-09-27T00:00:00"},
            ],
        }

    monkeypatch.setattr(
        "plane.db.management.commands.confirm_group_knowledge.describe_ragportal_candidates",
        described,
    )
    stdout = StringIO()
    call_command(
        "confirm_group_knowledge",
        "--workspace",
        "public",
        "--team",
        "器件",
        "--unique-name",
        "器件",
        stdout=stdout,
    )
    payload = json.loads(stdout.getvalue())
    assert payload["written"] is True
    assert payload["external_id"] == "kb-1"
    assert ResearchGroupKnowledgeBinding.objects.get(workspace=workspace).state == "READY"

    def ambiguous(_workspace):
        return {
            "connection_status": "connected",
            "degraded_reason": "",
            "candidates": [
                {"name": "磷酸", "external_id": "kb-3", "source": "RAGPORTAL", "seen_at": "2026-09-27T00:00:00"},
                {"name": "磷酸", "external_id": "kb-4", "source": "RAGPORTAL", "seen_at": "2026-09-27T00:00:00"},
            ],
        }

    monkeypatch.setattr(
        "plane.db.management.commands.confirm_group_knowledge.describe_ragportal_candidates",
        ambiguous,
    )
    _team(workspace, "磷酸")
    before = ResearchGroupKnowledgeBinding.objects.filter(org_unit__name="磷酸").count()
    with pytest.raises(CommandError, match="未写入"):
        call_command(
            "confirm_group_knowledge",
            "--workspace",
            "public",
            "--team",
            "磷酸",
            "--unique-name",
            "磷酸",
            stdout=StringIO(),
        )
    assert ResearchGroupKnowledgeBinding.objects.filter(org_unit__name="磷酸").count() == before
