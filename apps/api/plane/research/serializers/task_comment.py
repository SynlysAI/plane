"""Task comments reuse the same sanitized rich-text format as work item comments."""

from bs4 import BeautifulSoup
from uuid import UUID
from rest_framework import serializers

from plane.db.models import FileAsset, ResearchTaskComment
from plane.research.services.task_comment_attachments import attachment_ids_for_comment
from plane.utils.content_validator import validate_html_content
from plane.utils.html_processor import strip_tags


class ResearchTaskCommentSerializer(serializers.ModelSerializer):
    actor_detail = serializers.SerializerMethodField()
    can_edit = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    attachment_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        write_only=True,
        max_length=10,
    )
    file_attachments = serializers.SerializerMethodField()

    class Meta:
        model = ResearchTaskComment
        fields = [
            "id",
            "task",
            "actor",
            "actor_detail",
            "comment_html",
            "comment_stripped",
            "attachment_ids",
            "file_attachments",
            "created_at",
            "updated_at",
            "edited_at",
            "can_edit",
            "can_delete",
        ]
        read_only_fields = [field for field in fields if field != "comment_html"]
        extra_kwargs = {"comment_html": {"max_length": 50000, "allow_blank": True, "required": False}}

    def validate_comment_html(self, value):
        valid, error, cleaned = validate_html_content(value)
        if not valid:
            raise serializers.ValidationError(error)
        cleaned = cleaned or ""
        return cleaned

    def validate(self, attrs):
        """Validate task-scoped inline images and the comment's non-empty envelope."""
        document = BeautifulSoup(attrs.get("comment_html") or "", "html.parser")
        has_image = self._validate_inline_images(document)
        attachment_ids = attrs.get("attachment_ids") or []
        has_saved_attachment = bool(self.instance and attachment_ids_for_comment(self.instance))
        if not attachment_ids and not has_image and not has_saved_attachment:
            if not strip_tags(attrs.get("comment_html") or "").strip() and not document.find("mention-component"):
                raise serializers.ValidationError("Comment cannot be empty.")
        return attrs

    def _validate_inline_images(self, document):
        """Allow only uploaded image assets owned by the current task.

        Returns:
            Whether the cleaned HTML contains an inline image.
        """
        task = self.context.get("task")
        nodes = document.find_all(["img", "image-component"])
        if not task:
            if nodes:
                raise serializers.ValidationError("Task comments do not accept external images.")
            return False
        prefix = (
            f"/api/research/workspaces/{task.workspace.slug}/chains/{task.chain_id}/"
            f"nodes/{task.node_id}/tasks/{task.id}/comment-images/"
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
                    entity_type=FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_IMAGE,
                    entity_identifier=str(task.id),
                    is_uploaded=True,
                    is_deleted=False,
                    deleted_at__isnull=True,
                ).exists()
            ):
                raise serializers.ValidationError("Task comments do not accept external images.")
        return bool(nodes)

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

    def get_file_attachments(self, obj):
        """Return active task-comment files with authenticated download URLs."""
        attachments = (
            obj.attachments.filter(deleted_at__isnull=True, asset__is_uploaded=True, asset__is_deleted=False)
            .select_related("asset", "comment__task__workspace")
            .order_by("created_at", "id")
        )
        return [
            {
                "id": str(attachment.asset_id),
                "name": attachment.file_name,
                "type": attachment.content_type,
                "size": attachment.file_size,
                "download_url": (
                    f"/api/research/workspaces/{attachment.comment.task.workspace.slug}/"
                    f"chains/{attachment.comment.task.chain_id}/nodes/{attachment.comment.task.node_id}/"
                    f"tasks/{attachment.comment.task.id}/comment-attachments/{attachment.asset_id}/download/"
                ),
            }
            for attachment in attachments
        ]
