# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import serializers

# Module imports
from .base import BaseSerializer, DynamicBaseSerializer
from .user import UserLiteSerializer, UserAdminLiteSerializer


from plane.db.models import (
    Workspace,
    WorkspaceMember,
    WorkspaceMemberTag,
    WorkspaceMemberTagGroup,
    WorkspaceMemberInvite,
    WorkspaceTheme,
    WorkspaceUserProperties,
    WorkspaceUserLink,
    UserRecentVisit,
    Issue,
    Page,
    Project,
    ProjectMember,
    WorkspaceHomePreference,
    WorkspaceAdministrativeViewDefault,
    Sticky,
    WorkspaceUserPreference,
)
from plane.utils.constants import RESTRICTED_WORKSPACE_SLUGS
from plane.utils.url import contains_url
from plane.utils.content_validator import (
    validate_html_content,
    validate_binary_data,
    has_alphanumeric,
)

# Django imports
from django.core.validators import URLValidator
from django.core.exceptions import ValidationError
import re


ADMIN_VIEW_LAYOUTS = {"list", "kanban", "calendar", "spreadsheet", "gantt_chart"}
ADMIN_VIEW_CALENDAR_LAYOUTS = {"month", "week"}
ADMIN_VIEW_DISPLAY_FILTER_KEYS = {
    "calendar",
    "group_by",
    "sub_group_by",
    "layout",
    "order_by",
    "show_empty_groups",
    "sub_issue",
}
ADMIN_VIEW_DISPLAY_PROPERTY_KEYS = {
    "assignee",
    "start_date",
    "due_date",
    "labels",
    "key",
    "priority",
    "state",
    "sub_issue_count",
    "link",
    "attachment_count",
    "estimate",
    "created_on",
    "updated_on",
    "modules",
    "cycle",
    "issue_type",
}


class WorkSpaceSerializer(DynamicBaseSerializer):
    research_enabled = serializers.BooleanField(source="research_setting.module_enabled", read_only=True)
    research_purpose = serializers.CharField(source="research_setting.purpose", read_only=True)
    total_members = serializers.IntegerField(read_only=True)
    logo_url = serializers.CharField(read_only=True)
    role = serializers.IntegerField(read_only=True)

    def validate_name(self, value):
        # Check if the name contains a URL
        if contains_url(value):
            raise serializers.ValidationError("Name must not contain URLs")
        # Reject symbol-only names like "-_________-" that have no letter or
        # digit. Mirrors the frontend HAS_ALPHANUMERIC_REGEX check so the rule
        # cannot be bypassed via a direct API call.
        if not has_alphanumeric(value):
            raise serializers.ValidationError("Name must contain at least one letter or number")
        return value

    def validate_slug(self, value):
        # Check if the slug is restricted
        if value in RESTRICTED_WORKSPACE_SLUGS:
            raise serializers.ValidationError("Slug is not valid")
        # Slug should only contain alphanumeric characters, hyphens, and underscores
        if not re.match(r"^[a-zA-Z0-9_-]+$", value):
            raise serializers.ValidationError(
                "Slug can only contain letters, numbers, hyphens (-), and underscores (_)"
            )
        return value

    class Meta:
        model = Workspace
        fields = "__all__"
        read_only_fields = [
            "id",
            "created_by",
            "updated_by",
            "created_at",
            "updated_at",
            "owner",
            "logo_url",
        ]


class WorkspaceLiteSerializer(BaseSerializer):
    class Meta:
        model = Workspace
        fields = ["name", "slug", "id", "logo_url"]
        read_only_fields = fields


class WorkSpaceMemberSerializer(DynamicBaseSerializer):
    member = UserLiteSerializer(read_only=True)
    tags = serializers.SerializerMethodField()
    is_operations_account = serializers.BooleanField(read_only=True)

    def get_tags(self, instance):
        """返回成员已关联的标签，供成员列表一次性渲染。"""
        assignments = getattr(instance, "prefetched_tag_assignments", None)
        if assignments is None:
            assignments = instance.tag_assignments.select_related("tag__group").all()
        return WorkspaceMemberTagSerializer([assignment.tag for assignment in assignments], many=True).data

    class Meta:
        model = WorkspaceMember
        fields = "__all__"


class WorkspaceMemberMeSerializer(BaseSerializer):
    draft_issue_count = serializers.IntegerField(read_only=True)
    is_operations_account = serializers.BooleanField(read_only=True)

    class Meta:
        model = WorkspaceMember
        fields = "__all__"


class WorkspaceMemberAdminSerializer(DynamicBaseSerializer):
    member = UserAdminLiteSerializer(read_only=True)
    tags = serializers.SerializerMethodField()
    is_operations_account = serializers.BooleanField(read_only=True)

    def get_tags(self, instance):
        """返回成员已关联的标签，供管理员成员列表一次性渲染。"""
        assignments = getattr(instance, "prefetched_tag_assignments", None)
        if assignments is None:
            assignments = instance.tag_assignments.select_related("tag__group").all()
        return WorkspaceMemberTagSerializer([assignment.tag for assignment in assignments], many=True).data

    class Meta:
        model = WorkspaceMember
        fields = "__all__"


class WorkspaceMemberTagSerializer(BaseSerializer):
    """序列化成员标签及其所属标签组标识。"""

    group_id = serializers.UUIDField(read_only=True)

    class Meta:
        model = WorkspaceMemberTag
        fields = ["id", "group_id", "name", "color", "sort_order"]
        read_only_fields = fields


class WorkspaceMemberTagGroupSerializer(BaseSerializer):
    """序列化标签组及其有序标签列表。"""

    tags = WorkspaceMemberTagSerializer(many=True, read_only=True)

    class Meta:
        model = WorkspaceMemberTagGroup
        fields = ["id", "name", "sort_order", "tags"]
        read_only_fields = ["id", "tags"]


class WorkSpaceMemberInviteSerializer(BaseSerializer):
    workspace = WorkspaceLiteSerializer(read_only=True)
    invite_link = serializers.SerializerMethodField()

    def get_invite_link(self, obj):
        return f"/workspace-invitations/?invitation_id={obj.id}&slug={obj.workspace.slug}&token={obj.token}"

    class Meta:
        model = WorkspaceMemberInvite
        fields = "__all__"
        read_only_fields = [
            "id",
            "email",
            "token",
            "workspace",
            "message",
            "responded_at",
            "created_at",
            "updated_at",
            "invite_link",
        ]


class WorkSpaceMemberInvitePublicSerializer(BaseSerializer):
    """Safe read-only serializer for the public workspace invite GET endpoint.

    Intentionally excludes ``token`` and ``invite_link`` so that an
    unauthenticated caller cannot retrieve the acceptance token and use it to
    hijack an invitation (GHSA-86mg-259g-pwgg / GHSA-gf48-p6jp-cwc4).
    """

    workspace = WorkspaceLiteSerializer(read_only=True)

    class Meta:
        model = WorkspaceMemberInvite
        fields = [
            "id",
            "email",
            "display_name",
            "research_profile_enabled",
            "research_profile_category",
            "workspace",
            "role",
            "message",
            "accepted",
            "responded_at",
            "created_at",
            "updated_at",
            "created_by",
        ]
        read_only_fields = fields


class WorkspaceThemeSerializer(BaseSerializer):
    class Meta:
        model = WorkspaceTheme
        fields = "__all__"
        read_only_fields = ["workspace", "actor"]


class WorkspaceUserPropertiesSerializer(BaseSerializer):
    class Meta:
        model = WorkspaceUserProperties
        fields = "__all__"
        read_only_fields = ["workspace", "user"]


class WorkspaceUserLinkSerializer(BaseSerializer):
    class Meta:
        model = WorkspaceUserLink
        fields = "__all__"
        read_only_fields = ["workspace", "owner"]

    def to_internal_value(self, data):
        url = data.get("url", "")
        if url and not url.startswith(("http://", "https://")):
            data["url"] = "http://" + url

        return super().to_internal_value(data)

    def validate_url(self, value):
        url_validator = URLValidator()
        try:
            url_validator(value)
        except ValidationError:
            raise serializers.ValidationError({"error": "Invalid URL format."})

        return value

    def create(self, validated_data):
        # Filtering the WorkspaceUserLink with the given url to check if the link already exists.

        url = validated_data.get("url")

        workspace_user_link = WorkspaceUserLink.objects.filter(
            url=url,
            workspace_id=validated_data.get("workspace_id"),
            owner_id=validated_data.get("owner_id"),
        )

        if workspace_user_link.exists():
            raise serializers.ValidationError({"error": "URL already exists for this workspace and owner"})

        return super().create(validated_data)

    def update(self, instance, validated_data):
        # Filtering the WorkspaceUserLink with the given url to check if the link already exists.

        url = validated_data.get("url")

        workspace_user_link = WorkspaceUserLink.objects.filter(
            url=url, workspace_id=instance.workspace_id, owner=instance.owner
        )

        if workspace_user_link.exclude(pk=instance.id).exists():
            raise serializers.ValidationError({"error": "URL already exists for this workspace and owner"})

        return super().update(instance, validated_data)


class IssueRecentVisitSerializer(serializers.ModelSerializer):
    project_identifier = serializers.SerializerMethodField()
    assignees = serializers.SerializerMethodField()

    class Meta:
        model = Issue
        fields = [
            "id",
            "name",
            "state",
            "priority",
            "assignees",
            "type",
            "sequence_id",
            "project_id",
            "project_identifier",
        ]

    def get_project_identifier(self, obj):
        project = obj.project
        return project.identifier if project else None

    def get_assignees(self, obj):
        return list(obj.assignees.filter(issue_assignee__deleted_at__isnull=True).values_list("id", flat=True))


class ProjectRecentVisitSerializer(serializers.ModelSerializer):
    project_members = serializers.SerializerMethodField()

    class Meta:
        model = Project
        fields = ["id", "name", "logo_props", "project_members", "identifier"]

    def get_project_members(self, obj):
        members = ProjectMember.objects.filter(project_id=obj.id, member__is_bot=False, is_active=True).values_list(
            "member", flat=True
        )

        return members


class PageRecentVisitSerializer(serializers.ModelSerializer):
    project_id = serializers.SerializerMethodField()
    project_identifier = serializers.SerializerMethodField()

    class Meta:
        model = Page
        fields = [
            "id",
            "name",
            "logo_props",
            "project_id",
            "owned_by",
            "project_identifier",
        ]

    def get_project_id(self, obj):
        if "recent_project" in self.context:
            return self.context["recent_project"].id
        return obj.project_id if hasattr(obj, "project_id") else obj.projects.values_list("id", flat=True).first()

    def get_project_identifier(self, obj):
        project = self.context.get("recent_project") or obj.projects.first()

        return project.identifier if project else None


def get_entity_model_and_serializer(entity_type):
    entity_map = {
        "issue": (Issue, IssueRecentVisitSerializer),
        "page": (Page, PageRecentVisitSerializer),
        "project": (Project, ProjectRecentVisitSerializer),
    }
    return entity_map.get(entity_type, (None, None))


class WorkspaceRecentVisitSerializer(BaseSerializer):
    entity_data = serializers.SerializerMethodField()

    class Meta:
        model = UserRecentVisit
        fields = ["id", "entity_name", "entity_identifier", "entity_data", "visited_at"]
        read_only_fields = ["workspace", "owner", "created_by", "updated_by"]

    def get_entity_data(self, obj):
        entity_name = obj.entity_name
        entity_identifier = obj.entity_identifier

        entity_model, entity_serializer = get_entity_model_and_serializer(entity_name)

        if entity_model and entity_serializer:
            try:
                entity = entity_model.objects.get(pk=entity_identifier)

                context = {}
                projects = self.context.get("recent_administrative_projects")
                if entity_name == "page" and projects is not None:
                    # 页面可关联多个项目，链接必须指向本次授权范围内的行政项目。
                    project = (
                        projects.filter(
                            project_pages__page=entity,
                            project_pages__deleted_at__isnull=True,
                        )
                        .order_by("id")
                        .first()
                    )
                    if project is None:
                        return None
                    context["recent_project"] = project
                return entity_serializer(entity, context=context).data
            except entity_model.DoesNotExist:
                return None
        return None


class WorkspaceHomePreferenceSerializer(BaseSerializer):
    class Meta:
        model = WorkspaceHomePreference
        fields = ["key", "is_enabled", "config", "sort_order"]
        read_only_fields = ["key", "workspace", "created_by", "updated_by"]

    def validate_config(self, value):
        """Reject malformed layout metadata before it reaches the home client."""
        if not isinstance(value, dict):
            raise serializers.ValidationError("Config must be an object.")
        return value


class WorkspaceAdministrativeViewDefaultSerializer(BaseSerializer):
    """Validate and serialize the administrative system-view layout default."""

    updated_at = serializers.DateTimeField(read_only=True)

    class Meta:
        model = WorkspaceAdministrativeViewDefault
        fields = ["display_filters", "display_properties", "updated_at"]
        read_only_fields = ["workspace", "created_by", "updated_by", "updated_at"]

    def validate(self, data):
        """Reject unsupported top-level fields before merging the default layout.

        Args:
            data: Validated display-filter and display-property overrides.

        Returns:
            The validated serializer data.
        """
        allowed_fields = {"display_filters", "display_properties"}
        unknown_fields = set(self.initial_data) - allowed_fields
        if unknown_fields:
            raise serializers.ValidationError(f"Unsupported fields: {', '.join(sorted(unknown_fields))}.")
        return data

    def validate_display_filters(self, value):
        """Reject unsupported or malformed display-filter values.

        Args:
            value: Requested display-filter overrides.

        Returns:
            The validated display-filter overrides.
        """
        if not isinstance(value, dict):
            raise serializers.ValidationError("Display filters must be an object.")

        unknown_keys = set(value) - ADMIN_VIEW_DISPLAY_FILTER_KEYS
        if unknown_keys:
            raise serializers.ValidationError(f"Unsupported display filter keys: {', '.join(sorted(unknown_keys))}.")

        layout = value.get("layout")
        if layout is not None and (not isinstance(layout, str) or layout not in ADMIN_VIEW_LAYOUTS):
            raise serializers.ValidationError("Layout must be list, kanban, calendar, spreadsheet, or gantt_chart.")

        for key in ("show_empty_groups", "sub_issue"):
            if key in value and not isinstance(value[key], bool):
                raise serializers.ValidationError(f"{key} must be a boolean.")

        for key in ("group_by", "sub_group_by", "order_by"):
            if key in value and value[key] is not None and not isinstance(value[key], str):
                raise serializers.ValidationError(f"{key} must be a string or null.")

        calendar = value.get("calendar")
        if calendar is not None:
            if not isinstance(calendar, dict):
                raise serializers.ValidationError("Calendar options must be an object.")
            if set(calendar) - {"show_weekends", "layout"}:
                raise serializers.ValidationError("Calendar options contain unsupported keys.")
            if "show_weekends" in calendar and not isinstance(calendar["show_weekends"], bool):
                raise serializers.ValidationError("Calendar show_weekends must be a boolean.")
            calendar_layout = calendar.get("layout")
            if calendar_layout is not None and (
                not isinstance(calendar_layout, str) or calendar_layout not in ADMIN_VIEW_CALENDAR_LAYOUTS
            ):
                raise serializers.ValidationError("Calendar layout must be month or week.")

        return value

    def validate_display_properties(self, value):
        """Reject unsupported or malformed display-property values.

        Args:
            value: Requested display-property overrides.

        Returns:
            The validated display-property overrides.
        """
        if not isinstance(value, dict):
            raise serializers.ValidationError("Display properties must be an object.")

        unknown_keys = set(value) - ADMIN_VIEW_DISPLAY_PROPERTY_KEYS
        if unknown_keys:
            raise serializers.ValidationError(f"Unsupported display property keys: {', '.join(sorted(unknown_keys))}.")
        if any(not isinstance(property_value, bool) for property_value in value.values()):
            raise serializers.ValidationError("Display properties must be booleans.")
        return value


class StickySerializer(BaseSerializer):
    class Meta:
        model = Sticky
        fields = "__all__"
        read_only_fields = ["workspace", "owner"]
        extra_kwargs = {"name": {"required": False}}

    def validate(self, data):
        # Validate description content for security
        if "description_html" in data and data["description_html"]:
            is_valid, error_msg, sanitized_html = validate_html_content(data["description_html"])
            if not is_valid:
                raise serializers.ValidationError({"error": "html content is not valid"})
            # Update the data with sanitized HTML if available
            if sanitized_html is not None:
                data["description_html"] = sanitized_html

        if "description_binary" in data and data["description_binary"]:
            is_valid, error_msg = validate_binary_data(data["description_binary"])
            if not is_valid:
                raise serializers.ValidationError({"description_binary": "Invalid binary data"})

        return data


class WorkspaceUserPreferenceSerializer(BaseSerializer):
    class Meta:
        model = WorkspaceUserPreference
        fields = ["key", "is_pinned", "sort_order"]
        read_only_fields = ["workspace", "created_by", "updated_by"]
