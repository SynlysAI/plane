# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Serializers for Phase 1.6 research collaboration objects."""

from uuid import UUID

from bs4 import BeautifulSoup
from rest_framework import serializers

from plane.db.models import (
    FileAsset,
    ResearchChainNodeTask,
    ResearchPaperReview,
    ResearchPaperReviewVersion,
)
from plane.research.services.chain_tasks import (
    actor_can_cancel_task,
    actor_can_review_task,
    actor_can_submit_task,
    chain_writer,
    chain_assignable_user_ids,
)
from plane.research.services.paper_review import (
    actor_can_review_paper,
    actor_can_submit_paper,
    actor_can_withdraw_paper,
)
from plane.research.utils.action_capabilities import capability_map
from plane.utils.content_validator import validate_html_content

TASK_ACTIONS = ("view", "edit", "assign", "submit", "return", "complete", "cancel")
PAPER_REVIEW_ACTIONS = ("view", "submit", "return", "accept", "withdraw")
EDITABLE_STATUSES = (
    ResearchChainNodeTask.Status.DRAFT,
    ResearchChainNodeTask.Status.ASSIGNED,
    ResearchChainNodeTask.Status.NEEDS_REVISION,
)


def _actor(serializer):
    """Return the authenticated serializer actor, if present."""
    request = serializer.context.get("request")
    user = getattr(request, "user", None)
    return user if getattr(user, "is_authenticated", False) else None


def _user_detail(user):
    """Project a user without leaking account contact fields."""
    if user is None:
        return None
    return {
        "id": str(user.id),
        "display_name": user.display_name or user.username or str(user.id),
    }


def _capabilities(serializer, task):
    """Resolve the stable task action map for the current actor."""
    actor = _actor(serializer)
    if actor is None:
        return capability_map(TASK_ACTIONS, {})
    workspace = task.workspace
    cache = serializer.context.setdefault("_research_task_roles", {})
    cache_key = (workspace.id, task.chain_id, actor.id)
    if cache_key not in cache:
        cache[cache_key] = {
            "writer": chain_writer(workspace, actor, task.chain),
            "reviewer": actor_can_review_task(workspace, task, actor),
            "manager": actor_can_cancel_task(workspace, task, actor),
        }
    roles = cache[cache_key]
    editable = task.status in EDITABLE_STATUSES
    writer = editable and roles["writer"]
    decisions = {
        "view": True,
        "edit": writer,
        "assign": writer,
        "submit": actor_can_submit_task(
            workspace, task, actor, assignee_is_valid=serializer.get_assignee_is_valid(task)
        ),
        "return": roles["reviewer"] and task.status == ResearchChainNodeTask.Status.SUBMITTED,
        "complete": roles["reviewer"] and task.status == ResearchChainNodeTask.Status.SUBMITTED,
        "cancel": roles["manager"] and editable,
    }
    return capability_map(TASK_ACTIONS, decisions)


class ResearchChainNodeTaskSerializer(serializers.ModelSerializer):
    """Serialize a node task without coupling it to node lifecycle state."""

    schema_version = serializers.SerializerMethodField()
    assignee_detail = serializers.SerializerMethodField()
    assignee_is_valid = serializers.SerializerMethodField()
    assigned_by_detail = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()
    instruction_attachments = serializers.SerializerMethodField()

    class Meta:
        model = ResearchChainNodeTask
        fields = [
            "schema_version",
            "id",
            "workspace",
            "chain",
            "node",
            "title",
            "instruction",
            "instruction_attachments",
            "status",
            "assignee",
            "assignee_detail",
            "assignee_is_valid",
            "assigned_by",
            "assigned_by_detail",
            "due_at",
            "submitted_at",
            "completed_at",
            "resource_type",
            "resource_id",
            "request_id",
            "capabilities",
            "instruction_attachments",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "schema_version",
            "id",
            "workspace",
            "chain",
            "node",
            "status",
            "assigned_by",
            "assigned_by_detail",
            "assignee_detail",
            "assignee_is_valid",
            "submitted_at",
            "completed_at",
            "request_id",
            "capabilities",
            "created_at",
            "updated_at",
        ]
        extra_kwargs = {
            "title": {"required": True, "allow_blank": False, "max_length": 500},
            "instruction": {"required": False, "allow_blank": True, "max_length": 50000},
        }

    def validate_instruction(self, value):
        """清洗任务说明，并拒绝非本任务范围的内嵌图片。

        Args:
            value: 前端提交的任务说明 HTML。

        Returns:
            清洗后的 HTML；创建阶段不允许携带图片。
        """
        valid, error, cleaned = validate_html_content(value)
        if not valid:
            raise serializers.ValidationError(error)
        cleaned = cleaned or ""
        self._validate_inline_images(BeautifulSoup(cleaned, "html.parser"))
        return cleaned

    def _validate_inline_images(self, document):
        """只允许引用当前任务已确认的描述图片资产。

        Args:
            document: 已清洗的任务说明文档。
        """
        task = self.instance
        nodes = document.find_all(["img", "image-component"])
        if not task:
            if nodes:
                raise serializers.ValidationError("Task instructions cannot reference images before the task exists.")
            return
        prefix = (
            f"/api/research/workspaces/{task.workspace.slug}/chains/{task.chain_id}/"
            f"nodes/{task.node_id}/tasks/{task.id}/instruction-images/"
        )
        for node in nodes:
            source = node.get("src", "")
            asset_id = str(source[len(prefix) :]).rstrip("/") if source.startswith(prefix) else ""
            try:
                valid_asset = bool(UUID(asset_id)) if asset_id else False
            except ValueError:
                valid_asset = False
            if (
                not valid_asset
                or not FileAsset.objects.filter(
                    pk=asset_id,
                    workspace_id=task.workspace_id,
                    entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_IMAGE,
                    entity_identifier=str(task.id),
                    is_uploaded=True,
                    is_deleted=False,
                    deleted_at__isnull=True,
                ).exists()
            ):
                raise serializers.ValidationError("Task instructions do not accept external images.")

    def get_schema_version(self, _obj):
        """Return the task API contract version."""
        return "research-chain-task.v1"

    def get_assignee_detail(self, obj):
        """Return the assignee display projection."""
        return _user_detail(obj.assignee)

    def get_assignee_is_valid(self, obj):
        """返回负责人当前是否具备有效课题成员资格。

        Args:
            obj: 当前科研任务。

        Returns:
            无负责人或成员资格失效时返回 False。
        """
        if obj.assignee_id is None:
            return False
        cache = self.context.setdefault("_research_task_assignees", {})
        key = (obj.workspace_id, obj.chain_id)
        if key not in cache:
            cache[key] = chain_assignable_user_ids(obj.workspace, obj.chain)
        return obj.assignee_id in cache[key]

    def get_assigned_by_detail(self, obj):
        """Return the assigning user display projection."""
        return _user_detail(obj.assigned_by)

    def get_capabilities(self, obj):
        """Return explicit task action decisions for the current actor."""
        return _capabilities(self, obj)

    def get_instruction_attachments(self, obj):
        """Return persisted task-description files with authenticated URLs."""
        attachments = [
            attachment
            for attachment in obj.instruction_attachments.all()
            if attachment.deleted_at is None
            and attachment.asset is not None
            and attachment.asset.is_uploaded
            and not attachment.asset.is_deleted
            and attachment.asset.deleted_at is None
        ]
        return [
            {
                "id": str(attachment.asset_id),
                "name": attachment.file_name,
                "type": attachment.content_type,
                "size": attachment.file_size,
                "download_url": (
                    f"/api/research/workspaces/{obj.workspace.slug}/chains/{obj.chain_id}/"
                    f"nodes/{obj.node_id}/tasks/{obj.id}/"
                    f"instruction-attachments/{attachment.asset_id}/download/"
                ),
            }
            for attachment in attachments
        ]


def _paper_capabilities(serializer, review):
    """Resolve the stable paper action map for the current actor."""
    actor = _actor(serializer)
    if actor is None:
        return capability_map(PAPER_REVIEW_ACTIONS, {})
    cache = serializer.context.setdefault("_research_paper_roles", {})
    cache_key = (review.workspace_id, review.chain_id, review.id, actor.id)
    if cache_key not in cache:
        cache[cache_key] = {
            "submitter": actor_can_submit_paper(review.workspace, review, actor),
            "reviewer": actor_can_review_paper(review.workspace, review, actor),
            "withdrawer": actor_can_withdraw_paper(review.workspace, review, actor),
        }
    roles = cache[cache_key]
    open_for_submit = review.status in (
        ResearchPaperReview.Status.OPEN,
        ResearchPaperReview.Status.NEEDS_REVISION,
    )
    decisions = {
        "view": True,
        "submit": open_for_submit and roles["submitter"],
        "return": roles["reviewer"] and review.status == ResearchPaperReview.Status.WAITING_REVIEW,
        "accept": roles["reviewer"] and review.status == ResearchPaperReview.Status.WAITING_REVIEW,
        "withdraw": roles["withdrawer"]
        and review.status
        not in (
            ResearchPaperReview.Status.ACCEPTED,
            ResearchPaperReview.Status.WITHDRAWN,
        ),
    }
    return capability_map(PAPER_REVIEW_ACTIONS, decisions)


class ResearchPaperReviewSerializer(serializers.ModelSerializer):
    """Serialize a paper review loop and its derived action capabilities."""

    schema_version = serializers.SerializerMethodField()
    owner_detail = serializers.SerializerMethodField()
    final_reviewer_detail = serializers.SerializerMethodField()
    versions = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

    class Meta:
        model = ResearchPaperReview
        fields = [
            "schema_version",
            "id",
            "workspace",
            "chain",
            "node",
            "outcome",
            "owner",
            "owner_detail",
            "status",
            "current_version_no",
            "final_reviewer",
            "final_reviewer_detail",
            "due_at",
            "request_id",
            "versions",
            "capabilities",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "schema_version",
            "id",
            "workspace",
            "chain",
            "node",
            "owner",
            "owner_detail",
            "status",
            "current_version_no",
            "final_reviewer_detail",
            "request_id",
            "versions",
            "capabilities",
            "created_at",
            "updated_at",
        ]

    def get_schema_version(self, _obj):
        """Return the paper review API contract version."""
        return "research-paper-review.v1"

    def get_owner_detail(self, obj):
        """Return the review owner display projection."""
        return _user_detail(obj.owner)

    def get_final_reviewer_detail(self, obj):
        """Return the final reviewer display projection."""
        return _user_detail(obj.final_reviewer)

    def get_versions(self, obj):
        """Return versions only for detail responses to keep lists compact."""
        if not self.context.get("include_versions"):
            return []
        return ResearchPaperReviewVersionSerializer(
            obj.versions.all(),
            many=True,
            context=self.context,
        ).data

    def get_capabilities(self, obj):
        """Return explicit paper action decisions for the current actor."""
        return _paper_capabilities(self, obj)


class ResearchPaperReviewVersionSerializer(serializers.ModelSerializer):
    """Serialize an immutable paper version with derived response status."""

    schema_version = serializers.SerializerMethodField()
    asset_detail = serializers.SerializerMethodField()
    submitted_by_detail = serializers.SerializerMethodField()
    status = serializers.SerializerMethodField()

    class Meta:
        model = ResearchPaperReviewVersion
        fields = [
            "schema_version",
            "id",
            "review",
            "version_no",
            "asset",
            "asset_detail",
            "file_name",
            "content_type",
            "file_size",
            "change_summary",
            "status",
            "submitted_by",
            "submitted_by_detail",
            "submitted_at",
            "content_hash",
        ]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        """Return the paper version API contract version."""
        return "research-paper-review-version.v1"

    def get_asset_detail(self, obj):
        """Project the registered asset without leaking storage credentials."""
        return {
            "id": str(obj.asset_id),
            "file_name": obj.file_name,
            "content_type": obj.content_type,
            "file_size": obj.file_size,
        }

    def get_submitted_by_detail(self, obj):
        """Return the submitter display projection."""
        return _user_detail(obj.submitted_by)

    def get_status(self, obj):
        """Derive version status without mutating append-only rows."""
        if obj.review.status == ResearchPaperReview.Status.ACCEPTED and obj.version_no == obj.review.current_version_no:
            return ResearchPaperReviewVersion.Status.ACCEPTED
        if obj.version_no < obj.review.current_version_no:
            return ResearchPaperReviewVersion.Status.SUPERSEDED
        return ResearchPaperReviewVersion.Status.SUBMITTED


class ResearchPaperReviewPresignSerializer(serializers.Serializer):
    """Validate metadata used to create a direct S3 paper upload slot."""

    asset_id = serializers.UUIDField(read_only=True)
    upload_data = serializers.DictField(read_only=True)
    file_name = serializers.CharField(max_length=255)
    content_type = serializers.CharField(max_length=128)
    size = serializers.IntegerField(min_value=1)
    sha256 = serializers.RegexField(r"^[0-9a-fA-F]{64}$")
