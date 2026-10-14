# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Research paper review API contracts."""

from collections import Counter
from hashlib import sha256
from unittest import mock
from uuid import uuid4

import pytest
from rest_framework.test import APIClient

from plane.db.models import FileAsset, ProjectMember, ResearchChainEvent, ResearchChainNode
from plane.db.models import Notification
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = pytest.mark.contract

PAPER_REVIEW_SCHEMA_VERSION = "research-paper-review.v1"
PAPER_ASSET_ENTITY = "RESEARCH_PAPER_REVIEW_VERSION"


@pytest.fixture
def env(db, settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update(
        {
            "student_client": _client(fixture["student"]),
            "advisor_client": _client(fixture["advisor"]),
            "admin_client": _client(fixture["workspace_admin"]),
        }
    )
    return fixture


def _client(user):
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def _reviews_url(env, suffix=""):
    return (
        f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/"
        f"nodes/{env['paper_node'].id}/paper-reviews/{suffix}"
    )


def _review_url(env, review_id, suffix=""):
    return f"/api/research/workspaces/{env['workspace'].slug}/paper-reviews/{review_id}/{suffix}"


def _version_url(env, review_id, version_no="", action=""):
    suffix = f"versions/{version_no}/" if version_no else "versions/"
    if action:
        suffix += f"{action}/"
    return _review_url(env, review_id, suffix)


def _create_review(env, client=None, **overrides):
    payload = {
        "final_reviewer": str(env["advisor"].id),
        "request_id": f"paper-review-{uuid4()}",
    }
    payload.update(overrides)
    response = (client or env["student_client"]).post(_reviews_url(env), payload, format="json")
    assert response.status_code == 201, response.json()
    return response.json()["data"]


def _make_asset(env, review_id, file_name, content_type, size, user=None):
    digest = sha256(f"{file_name}:{size}".encode()).hexdigest()
    asset = FileAsset(
        attributes={"name": file_name, "type": content_type, "size": size, "sha256": digest},
        asset=f"{env['workspace'].id}/research/paper-reviews/{review_id}/{uuid4().hex}-{file_name}",
        size=size,
        workspace=env["workspace"],
        user=user or env["student"],
        created_by=user or env["student"],
        entity_type=PAPER_ASSET_ENTITY,
        entity_identifier=str(review_id),
        is_uploaded=True,
    )
    asset.save(created_by_id=(user or env["student"]).id)
    return asset


def _submit_version(env, review_id, file_name, change_summary, user=None, content_type=None, size=128):
    asset = _make_asset(
        env,
        review_id,
        file_name,
        content_type or ("application/pdf" if file_name.lower().endswith(".pdf") else "text/markdown"),
        size,
        user=user,
    )
    response = (user and _client(user) or env["student_client"]).post(
        _version_url(env, review_id),
        {
            "asset_id": str(asset.id),
            "change_summary": change_summary,
            "request_id": f"paper-version-{uuid4()}",
        },
        format="json",
    )
    assert response.status_code == 201, response.json()
    return response.json()["data"]


def _event_types(env, node=None):
    return list(
        ResearchChainEvent.objects.filter(node=node or env["paper_node"])
        .order_by("created_at")
        .values_list("event_type", flat=True)
    )


@pytest.mark.django_db
class TestResearchPaperReviewApi:
    def test_submit_return_resubmit_and_accept_with_chain_event_order(self, env):
        review = _create_review(env)
        assert review["status"] == "OPEN"
        assert review["owner"] == str(env["student"].id)
        assert review["final_reviewer"] == str(env["advisor"].id)
        assert review["schema_version"] == PAPER_REVIEW_SCHEMA_VERSION

        first = _submit_version(env, review["id"], "paper-v1.pdf", "提交初稿。")
        assert first["version_no"] == 1
        assert first["status"] == "SUBMITTED"
        assert first["submitted_by"] == str(env["student"].id)

        ProjectMember.objects.create(
            project=env["project"],
            member=env["group_member"],
            role=15,
        )

        denied = _client(env["group_member"]).post(
            _version_url(env, review["id"], 1, "return"),
            {"request_id": f"member-return-{uuid4()}", "comment": "Ordinary member cannot review."},
            format="json",
        )
        assert denied.status_code == 403
        assert denied.json()["error_code"] == "research_permission_denied"

        return_response = env["advisor_client"].post(
            _version_url(env, review["id"], 1, "return"),
            {"request_id": f"paper-return-{uuid4()}", "comment": "补充第 3 节对照说明。"},
            format="json",
        )
        assert return_response.status_code == 200, return_response.json()
        assert return_response.json()["data"]["status"] == "SUBMITTED"
        assert env["student_client"].get(_review_url(env, review["id"])).json()["data"]["status"] == "NEEDS_REVISION"

        second = _submit_version(env, review["id"], "paper-v2.md", "补充审稿意见对应的修改说明。")
        assert second["version_no"] == 2
        assert second["status"] == "SUBMITTED"

        accepted = (
            env["advisor_client"]
            .post(
                _version_url(env, review["id"], 2, "accept"),
                {"request_id": f"paper-accept-{uuid4()}", "comment": "最终版本已确认。"},
                format="json",
            )
            .json()["data"]
        )
        assert accepted["status"] == "ACCEPTED"

        detail = env["student_client"].get(_review_url(env, review["id"])).json()["data"]
        assert detail["status"] == "ACCEPTED"
        assert [item["version_no"] for item in detail["versions"]] == [2, 1]
        assert detail["versions"][0]["status"] == "ACCEPTED"
        assert detail["versions"][1]["status"] == "SUPERSEDED"

        listed = env["student_client"].get(_reviews_url(env)).json()["data"]
        assert [item["id"] for item in listed] == [review["id"]]

        first_detail = env["advisor_client"].get(_version_url(env, review["id"], 1)).json()["data"]
        assert first_detail["file_name"] == "paper-v1.pdf"
        assert first_detail["content_hash"]

        assert _event_types(env) == [
            "PAPER_REVIEW_OPENED",
            "PAPER_VERSION_SUBMITTED",
            "PAPER_REVIEW_RETURNED",
            "PAPER_VERSION_SUBMITTED",
            "PAPER_REVIEW_ACCEPTED",
        ]
        accept_event = ResearchChainEvent.objects.get(event_type="PAPER_REVIEW_ACCEPTED")
        assert accept_event.metadata["comment"] == "最终版本已确认。"
        assert {item["kind"] for item in accept_event.refs} == {"chain", "node", "paper_review", "paper_version"}
        notification_actions = Counter(
            Notification.objects.filter(
                entity_name="research_paper_review",
                data__review_id=review["id"],
            ).values_list("data__action", flat=True)
        )
        assert notification_actions == {"submitted": 2, "returned": 1, "accepted": 1}

    def test_workspace_admin_can_review_without_org_relation(self, env):
        """工作区管理员无需组织关系即可退回论文评审。"""
        review = _create_review(env)
        _submit_version(env, review["id"], "paper-admin.pdf", "提交初稿。")

        returned = env["admin_client"].post(
            _version_url(env, review["id"], 1, "return"),
            {"request_id": f"admin-return-{uuid4()}", "comment": "管理员退回补充对照实验。"},
            format="json",
        )

        assert returned.status_code == 200, returned.json()
        assert returned.json()["data"]["status"] == "SUBMITTED"
        assert env["student_client"].get(_review_url(env, review["id"])).json()["data"]["status"] == "NEEDS_REVISION"

    def test_owner_can_withdraw_an_open_review(self, env):
        review = _create_review(env)
        _submit_version(env, review["id"], "draft.pdf", "等待导师意见的版本。")

        response = env["student_client"].post(
            _review_url(env, review["id"], "withdraw/"),
            {"request_id": f"paper-withdraw-{uuid4()}", "reason": "论文方向调整。"},
            format="json",
        )

        assert response.status_code == 200, response.json()
        assert response.json()["data"]["status"] == "WITHDRAWN"
        assert _event_types(env)[-1] == "PAPER_REVIEW_WITHDRAWN"

    def test_final_reviewer_is_validated_by_server_scope(self, env):
        response = env["student_client"].post(
            _reviews_url(env),
            {
                "final_reviewer": str(env["descendant"].id),
                "request_id": f"invalid-final-{uuid4()}",
            },
            format="json",
        )

        assert response.status_code == 403
        assert response.json()["error_code"] == "research_permission_denied"
        assert not env["paper_node"].paper_reviews.exists()

    def test_only_paper_writing_node_can_create_review(self, env):
        other_node = ResearchChainNode.objects.create(
            chain=env["chain"],
            node_type="PAPER_RESEARCH",
            title="论文调研",
            status=ResearchChainNode.Status.ACTIVE,
            request_id=f"paper-research-node-{uuid4()}",
            payload_hash=uuid4().hex,
        )
        response = env["student_client"].post(
            f"/api/research/workspaces/{env['workspace'].slug}/chains/{env['chain'].id}/"
            f"nodes/{other_node.id}/paper-reviews/",
            {"request_id": f"invalid-node-{uuid4()}"},
            format="json",
        )

        assert response.status_code == 422
        assert response.json()["error_code"] == "research_chain_invalid"
        assert not other_node.paper_reviews.exists()

    def test_presign_and_version_registration_restrict_file_type_and_size(self, env):
        review = _create_review(env)
        env["workspace"].research_setting.markdown_max_mb = 1
        env["workspace"].research_setting.save(update_fields=["markdown_max_mb"])

        storage = mock.Mock()
        storage.generate_presigned_post.return_value = {"url": "https://upload.example", "fields": {"key": "k"}}
        with mock.patch("plane.research.views.paper_reviews.S3Storage", return_value=storage):
            wrong_type = env["student_client"].post(
                _review_url(env, review["id"], "versions/presign/"),
                {
                    "file_name": "paper.txt",
                    "content_type": "text/plain",
                    "size": 8,
                    "sha256": "a" * 64,
                    "request_id": f"paper-type-{uuid4()}",
                },
                format="json",
            )
            assert wrong_type.status_code == 422
            assert wrong_type.json()["error_code"] == "file_type_not_allowed"

            oversized = env["student_client"].post(
                _review_url(env, review["id"], "versions/presign/"),
                {
                    "file_name": "paper.md",
                    "content_type": "text/markdown",
                    "size": 2 * 1024 * 1024,
                    "sha256": "b" * 64,
                    "request_id": f"paper-size-{uuid4()}",
                },
                format="json",
            )
            assert oversized.status_code == 422
            assert oversized.json()["error_code"] == "file_size_exceeded"
            assert not FileAsset.objects.filter(entity_identifier=str(review["id"])).exists()

            presigned = env["student_client"].post(
                _review_url(env, review["id"], "versions/presign/"),
                {
                    "file_name": "paper.pdf",
                    "content_type": "application/pdf",
                    "size": 128,
                    "sha256": "c" * 64,
                    "request_id": f"paper-presign-{uuid4()}",
                },
                format="json",
            )

        assert presigned.status_code == 200, presigned.json()
        assert presigned.json()["data"]["upload_data"] == {"url": "https://upload.example", "fields": {"key": "k"}}
        asset = FileAsset.objects.get(pk=presigned.json()["data"]["asset_id"])
        assert asset.entity_type == PAPER_ASSET_ENTITY
        assert asset.attributes["sha256"] == "c" * 64
        asset.is_uploaded = True
        asset.save(update_fields=["is_uploaded"])

        invalid_asset = _make_asset(env, review["id"], "notes.txt", "text/plain", 8)
        invalid = env["student_client"].post(
            _version_url(env, review["id"]),
            {
                "asset_id": str(invalid_asset.id),
                "change_summary": "非法类型不应提交。",
                "request_id": f"paper-invalid-{uuid4()}",
            },
            format="json",
        )
        assert invalid.status_code == 422
        assert invalid.json()["error_code"] == "file_type_not_allowed"
        assert review["current_version_no"] == 0
