"""Task comments reuse the same sanitized rich-text format as work item comments."""

from bs4 import BeautifulSoup
from rest_framework import serializers

from plane.db.models import ResearchTaskComment
from plane.utils.content_validator import validate_html_content
from plane.utils.html_processor import strip_tags


class ResearchTaskCommentSerializer(serializers.ModelSerializer):
    actor_detail = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()

    class Meta:
        model = ResearchTaskComment
        fields = [
            "id",
            "task",
            "actor",
            "actor_detail",
            "comment_html",
            "comment_stripped",
            "created_at",
            "updated_at",
            "edited_at",
            "can_edit",
            "can_delete",
        ]
        read_only_fields = [field for field in fields if field != "comment_html"]
        extra_kwargs = {"comment_html": {"max_length": 50000, "allow_blank": False}}

    def validate_comment_html(self, value):
        valid, error, cleaned = validate_html_content(value)
        if not valid:
            raise serializers.ValidationError(error)
        cleaned = cleaned or ""
        document = BeautifulSoup(cleaned, "html.parser")
        if document.find(["img", "image-component"]):
            raise serializers.ValidationError("Task comments do not accept image attachments.")
        if not strip_tags(cleaned).strip() and not document.find("mention-component"):
            raise serializers.ValidationError("Comment cannot be empty.")
        return cleaned

    def get_actor_detail(self, obj):
        return {
            "id": str(obj.actor_id),
            "display_name": obj.actor.display_name or obj.actor.username,
            "avatar_url": obj.actor.avatar_url,
        }

    def get_can_edit(self, obj):
        request = self.context.get("request")
        return bool(request and obj.actor_id == request.user.id and obj.task.chain.status == "ACTIVE")

    def get_can_delete(self, obj):
        return self.get_can_edit(obj)
