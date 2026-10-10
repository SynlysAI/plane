# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Serializers for Phase 1.6 research collaboration objects."""

from rest_framework import serializers

from plane.db.models import ResearchChainNodeTask
from plane.research.services.chain_tasks import (
    actor_can_cancel_task,
    actor_can_review_task,
    actor_can_submit_task,
    chain_writer,
)
from plane.research.utils.action_capabilities import capability_map

TASK_ACTIONS = ("view", "edit", "assign", "submit", "return", "complete", "cancel")
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
        "submit": actor_can_submit_task(workspace, task, actor),
        "return": roles["reviewer"] and task.status == ResearchChainNodeTask.Status.SUBMITTED,
        "complete": roles["reviewer"] and task.status == ResearchChainNodeTask.Status.SUBMITTED,
        "cancel": roles["manager"] and editable,
    }
    return capability_map(TASK_ACTIONS, decisions)


class ResearchChainNodeTaskSerializer(serializers.ModelSerializer):
    """Serialize a node task without coupling it to node lifecycle state."""

    schema_version = serializers.SerializerMethodField()
    assignee_detail = serializers.SerializerMethodField()
    assigned_by_detail = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()

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
            "status",
            "assignee",
            "assignee_detail",
            "assigned_by",
            "assigned_by_detail",
            "due_at",
            "submitted_at",
            "completed_at",
            "resource_type",
            "resource_id",
            "request_id",
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
            "status",
            "assigned_by",
            "assigned_by_detail",
            "assignee_detail",
            "submitted_at",
            "completed_at",
            "request_id",
            "capabilities",
            "created_at",
            "updated_at",
        ]
        extra_kwargs = {
            "title": {"required": True, "allow_blank": False, "max_length": 500},
            "instruction": {"required": False, "allow_blank": True},
        }

    def get_schema_version(self, _obj):
        """Return the task API contract version."""
        return "research-chain-task.v1"

    def get_assignee_detail(self, obj):
        """Return the assignee display projection."""
        return _user_detail(obj.assignee)

    def get_assigned_by_detail(self, obj):
        """Return the assigning user display projection."""
        return _user_detail(obj.assigned_by)

    def get_capabilities(self, obj):
        """Return explicit task action decisions for the current actor."""
        return _capabilities(self, obj)
