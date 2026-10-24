"""Serializers for report comment threads and explicit AI feedback."""

from bs4 import BeautifulSoup
from rest_framework import serializers

from plane.db.models import PeriodicReportComment, PeriodicReportCommentFeedback, PeriodicReportCommentThread
from plane.utils.content_validator import validate_html_content
from plane.utils.html_processor import strip_tags


def actor_detail(user) -> dict | None:
    """Return the minimal actor profile needed by the comment sidebar."""
    if user is None:
        return None
    return {
        "id": str(user.id),
        "display_name": user.display_name or user.username,
        "avatar_url": user.avatar_url,
    }


class PeriodicReportCommentSerializer(serializers.ModelSerializer):
    """Sanitized rich-text comment with actor-scoped edit capabilities."""

    actor_detail = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    can_submit_ai_feedback = serializers.SerializerMethodField()
    ai_feedback = serializers.SerializerMethodField()

    class Meta:
        model = PeriodicReportComment
        fields = [
            "id",
            "thread",
            "parent",
            "actor",
            "actor_detail",
            "comment_html",
            "comment_stripped",
            "feedback_type",
            "created_at",
            "updated_at",
            "edited_at",
            "can_edit",
            "can_delete",
            "can_submit_ai_feedback",
            "ai_feedback",
        ]
        read_only_fields = [field for field in fields if field != "comment_html"]
        extra_kwargs = {"comment_html": {"max_length": 50000}}

    def validate_comment_html(self, value):
        """Sanitize report comments and keep them free of binary assets."""
        valid, error, cleaned = validate_html_content(value)
        if not valid:
            raise serializers.ValidationError(error)
        cleaned = cleaned or ""
        document = BeautifulSoup(cleaned, "html.parser")
        if document.find(["img", "image-component"]):
            raise serializers.ValidationError("Report comments do not accept images.")
        if not strip_tags(cleaned).strip() and not document.find("mention-component"):
            raise serializers.ValidationError("Comment cannot be empty.")
        return cleaned

    def get_actor_detail(self, obj):
        return actor_detail(obj.actor)

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and obj.actor_id == request.user.id)

    def get_can_delete(self, obj):
        return self.get_can_edit(obj)

    def get_can_submit_ai_feedback(self, obj):
        request = self.context.get("request")
        return bool(request and obj.actor_id == request.user.id and not hasattr(obj, "ai_feedback"))

    def get_ai_feedback(self, obj):
        feedback = getattr(obj, "ai_feedback", None)
        if feedback is None:
            return None
        return {
            "id": str(feedback.id),
            "status": feedback.status,
            "submitted_at": feedback.submitted_at,
            "agent_session": str(feedback.agent_session_id) if feedback.agent_session_id else None,
        }


class PeriodicReportCommentFeedbackSerializer(serializers.ModelSerializer):
    """Public projection of an explicit feedback submission."""

    class Meta:
        model = PeriodicReportCommentFeedback
        fields = ["id", "comment", "report", "thread", "feedback_type", "status", "submitted_at", "agent_session"]
        read_only_fields = fields


class PeriodicReportCommentThreadSerializer(serializers.ModelSerializer):
    """A threaded discussion pinned to an immutable report snapshot."""

    created_by_detail = serializers.SerializerMethodField()
    status_updated_by_detail = serializers.SerializerMethodField()
    comments = PeriodicReportCommentSerializer(many=True, read_only=True)
    comment_count = serializers.SerializerMethodField()
    can_resolve = serializers.SerializerMethodField()

    class Meta:
        model = PeriodicReportCommentThread
        fields = [
            "id",
            "report",
            "anchor",
            "quoted_text",
            "snapshot_version",
            "content_hash",
            "status",
            "status_updated_at",
            "status_updated_by",
            "status_updated_by_detail",
            "created_by",
            "created_by_detail",
            "created_at",
            "updated_at",
            "last_activity_at",
            "comment_count",
            "can_resolve",
            "comments",
        ]
        read_only_fields = fields

    def get_created_by_detail(self, obj):
        return actor_detail(obj.created_by)

    def get_status_updated_by_detail(self, obj):
        return actor_detail(obj.status_updated_by)

    def get_comment_count(self, obj):
        comments = getattr(obj, "_prefetched_objects_cache", {}).get("comments")
        if comments is not None:
            return len(comments)
        return obj.comments.filter(deleted_at__isnull=True).count()

    def get_can_resolve(self, obj):
        return bool(self.context.get("can_resolve", False))
