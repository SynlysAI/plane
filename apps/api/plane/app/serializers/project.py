# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Third party imports
from rest_framework import serializers

# Python imports
import re

# Module imports
from .base import BaseSerializer, DynamicBaseSerializer
from django.db.models import Max
from plane.app.serializers.workspace import WorkspaceLiteSerializer
from plane.app.serializers.user import UserLiteSerializer, UserAdminLiteSerializer
from plane.db.models import (
    AdministrativeOrganization,
    AdministrativeOrganizationMember,
    Project,
    ProjectMember,
    ProjectMemberInvite,
    ProjectIdentifier,
    DeployBoard,
    Label,
    Module,
    ProjectPublicMember,
    IssueSequence,
    WorkspaceMember,
    Workspace,
)
from plane.utils.content_validator import (
    validate_html_content,
)
from plane.utils.administrative_projects import (
    get_or_create_default_administrative_organization,
    user_can_manage_administrative_organization,
    research_project_ids,
    assignable_project_member_ids,
)
from plane.utils.home_activity import record_project_activity, resolve_project_change_values
from plane.utils.project_identifier import random_identifier, unique_identifier
from plane.utils.work_item_required_fields import MODULE_REQUIRED_ERROR


def resolve_is_research_project(obj):
    """Optional additive flag for the project serializers (P0-PRJ-06).

    Uses the ``_is_research_project`` annotation when the queryset provides it
    (keeps project lists free of N+1 queries) and falls back to a lookup
    otherwise. Plain projects always answer ``False``.
    """
    annotated = getattr(obj, "is_research_project", None)
    if annotated is not None:
        return bool(annotated)
    from plane.db.models import ResearchProjectProfile

    return ResearchProjectProfile.objects.filter(project_id=obj.id).exists()


class ProjectSerializer(BaseSerializer):
    workspace_detail = WorkspaceLiteSerializer(source="workspace", read_only=True)
    inbox_view = serializers.BooleanField(read_only=True, source="intake_view")
    new_administrative_organization = serializers.CharField(write_only=True, required=False, allow_blank=True)
    identifier = serializers.CharField(required=False, allow_blank=True, max_length=12)

    class Meta:
        model = Project
        fields = "__all__"
        read_only_fields = ["workspace", "deleted_at"]

    def validate_name(self, name):
        if re.match(Project.FORBIDDEN_IDENTIFIER_CHARS_PATTERN, name):
            raise serializers.ValidationError(detail="PROJECT_NAME_CANNOT_CONTAIN_SPECIAL_CHARACTERS")

        return name

    def validate_identifier(self, identifier):
        project_id = self.instance.id if self.instance else None
        workspace_id = self.context["workspace_id"]

        identifier = str(identifier or "").strip().upper()
        if not identifier:
            if self.instance is None:
                return identifier
            raise serializers.ValidationError(detail="PROJECT_IDENTIFIER_IS_REQUIRED")

        if re.match(Project.FORBIDDEN_IDENTIFIER_CHARS_PATTERN, identifier):
            raise serializers.ValidationError(detail="PROJECT_IDENTIFIER_CANNOT_CONTAIN_SPECIAL_CHARACTERS")

        project = Project.objects.filter(identifier=identifier, workspace_id=workspace_id, deleted_at__isnull=True)

        if project_id:
            project = project.exclude(id=project_id)

        # The identifier ledger can drift when a project code is renamed in
        # ``projects`` only; check both tables before inserting a ledger row.
        identifier_ledger = ProjectIdentifier.objects.filter(
            workspace_id=workspace_id,
            name=identifier,
            deleted_at__isnull=True,
        )
        if project_id:
            identifier_ledger = identifier_ledger.exclude(project_id=project_id)

        if project.exists() or identifier_ledger.exists():
            raise serializers.ValidationError(
                detail="PROJECT_IDENTIFIER_ALREADY_EXIST",
            )

        return identifier

    def validate(self, data):
        # Validate description content for security
        if "description_html" in data and data["description_html"]:
            is_valid, error_msg, sanitized_html = validate_html_content(str(data["description_html"]))
            # Update the data with sanitized HTML if available
            if sanitized_html is not None:
                data["description_html"] = sanitized_html

            if not is_valid:
                raise serializers.ValidationError({"error": "html content is not valid"})

        administrative_only = data.get(
            "administrative_settings_admin_only",
            getattr(self.instance, "administrative_settings_admin_only", False),
        )
        if self.instance is None and administrative_only:
            raise serializers.ValidationError(
                {"administrative_settings_admin_only": ["Enable the project lock after creating the project."]}
            )
        if self.instance is not None and administrative_only and resolve_is_research_project(self.instance):
            raise serializers.ValidationError(
                {"administrative_settings_admin_only": ["The project lock only applies to administrative projects."]}
            )

        assignment_fields = ("project_lead", "default_assignee")
        for field in assignment_fields:
            if field not in data or data[field] is None:
                continue

            user = data[field]
            user_id = getattr(user, "id", user)
            if self.instance is None:
                # A project being created has no roster yet. Its view creates
                # memberships for the caller and selected lead; a default
                # assignee remains deferred and is rechecked when an issue is
                # created.
                is_valid_user = WorkspaceMember.objects.filter(
                    workspace_id=self.context["workspace_id"],
                    member_id=user_id,
                    is_active=True,
                    deleted_at__isnull=True,
                ).exists()
            else:
                is_valid_user = assignable_project_member_ids(self.instance).filter(id=user_id).exists()

            if not is_valid_user:
                raise serializers.ValidationError({field: "The provided user is not an active member of this project"})

        organization = data.get("administrative_organization")
        module_required = data.get("is_module_required", getattr(self.instance, "is_module_required", False))
        label_required = data.get("is_label_required", getattr(self.instance, "is_label_required", False))
        if module_required or label_required:
            effective_organization = organization
            if effective_organization is None and self.instance is not None:
                effective_organization = self.instance.administrative_organization
            is_research = self.instance is not None and resolve_is_research_project(self.instance)
            if effective_organization is None or is_research:
                errors = {}
                if module_required:
                    errors["is_module_required"] = ["Required fields can only be enabled for administrative projects."]
                if label_required:
                    errors["is_label_required"] = ["Required fields can only be enabled for administrative projects."]
                raise serializers.ValidationError(errors)

            required_project_id = self.instance.id if self.instance else None
            module_view = data.get("module_view", getattr(self.instance, "module_view", False))
            if module_required:
                if not module_view:
                    raise serializers.ValidationError(
                        {"is_module_required": ["Enable the modules feature before requiring a module."]}
                    )
                if not Module.objects.filter(project_id=required_project_id, archived_at__isnull=True).exists():
                    raise serializers.ValidationError(
                        {"is_module_required": ["Create at least one module before requiring a module."]}
                    )
            if label_required and not Label.objects.filter(project_id=required_project_id).exists():
                raise serializers.ValidationError(
                    {"is_label_required": ["Create at least one label before requiring a label."]}
                )

        if (
            self.instance is not None
            and self.instance.is_module_required
            and "module_view" in data
            and not data["module_view"]
        ):
            raise serializers.ValidationError(
                {"module_view": [MODULE_REQUIRED_ERROR, "Disable module requirement before turning off modules."]}
            )

        new_organization_name = str(data.pop("new_administrative_organization", "") or "").strip()
        if new_organization_name:
            if organization is not None:
                raise serializers.ValidationError(
                    {
                        "new_administrative_organization": (
                            "Choose either an existing organization or a new organization name."
                        )
                    }
                )
            if (
                not new_organization_name
                or len(new_organization_name) > 255
                or new_organization_name == AdministrativeOrganization.PUBLIC_NAME
            ):
                raise serializers.ValidationError({"new_administrative_organization": "Organization name is invalid."})
            if AdministrativeOrganization.objects.filter(
                workspace_id=self.context["workspace_id"],
                name=new_organization_name,
                deleted_at__isnull=True,
            ).exists():
                raise serializers.ValidationError(
                    {"new_administrative_organization": "Organization name is already taken."}
                )
            data["new_administrative_organization"] = new_organization_name
        elif self.instance is None and organization is None:
            raise serializers.ValidationError(
                {"administrative_organization": "An administrative project must select an organization."}
            )
        if organization is None and "administrative_organization" in data and self.instance is not None:
            organization = get_or_create_default_administrative_organization(
                Workspace.objects.filter(pk=self.context["workspace_id"]).first()
            )
            data["administrative_organization"] = organization
        if organization is not None:
            organization_obj = AdministrativeOrganization.objects.filter(
                pk=organization.pk,
                workspace_id=self.context["workspace_id"],
                deleted_at__isnull=True,
            ).first()
            if organization_obj is None:
                raise serializers.ValidationError(
                    {"administrative_organization": "Organization should belong to this workspace."}
                )
            requester = getattr(getattr(self.context.get("request"), "user", None), "is_authenticated", False)
            workspace = organization_obj.workspace
            if not organization_obj.is_default and (
                not requester
                or not user_can_manage_administrative_organization(
                    self.context["request"].user,
                    workspace.slug,
                    organization_obj.id,
                )
            ):
                raise serializers.ValidationError(
                    {"administrative_organization": "Only organization administrators can assign this organization."}
                )
            data["administrative_organization"] = organization_obj

        if self.instance is not None and "administrative_organization" in data:
            if research_project_ids().filter(id=self.instance.id).exists():
                raise serializers.ValidationError(
                    {"administrative_organization": "Research projects cannot join administrative organizations."}
                )
            current = self.instance.administrative_organization
            target = data.get("administrative_organization")
            if current != target:
                requester = getattr(self.context.get("request"), "user", None)
                workspace_slug = self.instance.workspace.slug
                for organization in (current, target):
                    if organization is not None and not user_can_manage_administrative_organization(
                        requester, workspace_slug, organization.id
                    ):
                        raise serializers.ValidationError(
                            {
                                "administrative_organization": (
                                    "Only source and target organization administrators can move this project."
                                )
                            }
                        )

        return data

    PROJECT_ACTIVITY_FIELDS = (
        "name",
        "description",
        "project_lead",
        "network",
        "guest_view_all_features",
        "start_date",
        "target_date",
    )

    @staticmethod
    def _project_changes(instance, validated_data):
        """Build readable change records for meaningful project updates.

        Args:
            instance: Project state before the update.
            validated_data: Serializer fields supplied by the requester.

        Returns:
            A list of field-level before/after dictionaries.
        """
        changes = []
        for field in ProjectSerializer.PROJECT_ACTIVITY_FIELDS:
            if field not in validated_data:
                continue
            old_value = getattr(instance, field, None)
            new_value = validated_data.get(field)
            old_id = getattr(old_value, "id", old_value)
            new_id = getattr(new_value, "id", new_value)
            if str(old_id or "") == str(new_id or ""):
                continue
            old_display, new_display = resolve_project_change_values(field, old_id, new_id)
            changes.append({"field": field, "old_value": old_display, "new_value": new_display})
        return changes

    def create(self, validated_data):
        workspace_id = self.context["workspace_id"]
        if not validated_data.get("identifier"):
            workspace = Workspace.objects.filter(pk=workspace_id).first()
            validated_data["identifier"] = unique_identifier(workspace, random_identifier())
        new_organization_name = validated_data.pop("new_administrative_organization", None)
        if new_organization_name:
            workspace = Workspace.objects.filter(pk=workspace_id).first()
            creator = self.context["request"].user
            organization = AdministrativeOrganization.objects.create(
                workspace=workspace,
                name=new_organization_name,
                created_by=creator,
            )
            AdministrativeOrganizationMember.objects.create(
                workspace=workspace,
                organization=organization,
                member=creator,
                role=AdministrativeOrganizationMember.Role.ADMIN,
                created_by=creator,
            )
            validated_data["administrative_organization"] = organization
        project = Project.objects.create(**validated_data, workspace_id=workspace_id)

        ProjectIdentifier.objects.create(name=project.identifier, project=project, workspace_id=workspace_id)

        record_project_activity(project, self.context.get("request").user, "created")
        return project

    def update(self, instance, validated_data):
        changes = self._project_changes(instance, validated_data)
        project = super().update(instance, validated_data)
        if changes:
            record_project_activity(project, self.context.get("request").user, "updated", changes)
        return project


class ProjectLiteSerializer(BaseSerializer):
    class Meta:
        model = Project
        fields = [
            "id",
            "identifier",
            "name",
            "cover_image",
            "cover_image_url",
            "logo_props",
            "description",
        ]
        read_only_fields = fields


class ProjectListSerializer(DynamicBaseSerializer):
    is_favorite = serializers.BooleanField(read_only=True)
    sort_order = serializers.FloatField(read_only=True)
    member_role = serializers.IntegerField(read_only=True)
    anchor = serializers.CharField(read_only=True)
    members = serializers.SerializerMethodField()
    cover_image_url = serializers.CharField(read_only=True)
    inbox_view = serializers.BooleanField(read_only=True, source="intake_view")
    next_work_item_sequence = serializers.SerializerMethodField()
    # Additive optional flag: false for every upstream project (P0-PRJ-06)
    is_research_project = serializers.SerializerMethodField()
    # 研究链上级的只读标记。不是成员时为 "review"，不伪造 member_role。
    research_access = serializers.SerializerMethodField()

    def get_is_research_project(self, obj):
        return resolve_is_research_project(obj)

    def get_research_access(self, obj):
        """返回研究链只读标记。

        Returns:
            非成员的研究链读者为 ``review``，其余为 None。
        """
        return getattr(obj, "research_access", None)

    def get_members(self, obj):
        project_members = getattr(obj, "members_list", None)
        if project_members is not None:
            # Filter members by the project ID
            return [member.member_id for member in project_members if member.is_active and not member.member.is_bot]
        return []

    def get_next_work_item_sequence(self, obj):
        """Get the next sequence ID that will be assigned to a new issue"""
        max_sequence = IssueSequence.objects.filter(project_id=obj.id).aggregate(max_seq=Max("sequence"))["max_seq"]
        return (max_sequence + 1) if max_sequence else 1

    class Meta:
        model = Project
        fields = "__all__"


class ProjectDetailSerializer(BaseSerializer):
    # workspace = WorkSpaceSerializer(read_only=True)
    default_assignee = UserLiteSerializer(read_only=True)
    project_lead = UserLiteSerializer(read_only=True)
    is_favorite = serializers.BooleanField(read_only=True)
    sort_order = serializers.FloatField(read_only=True)
    member_role = serializers.IntegerField(read_only=True)
    anchor = serializers.CharField(read_only=True)
    # Additive optional flag: false for every upstream project (P0-PRJ-06)
    is_research_project = serializers.SerializerMethodField()

    def get_is_research_project(self, obj):
        return resolve_is_research_project(obj)

    class Meta:
        model = Project
        fields = "__all__"


class ProjectMemberSerializer(BaseSerializer):
    workspace = WorkspaceLiteSerializer(read_only=True)
    project = ProjectLiteSerializer(read_only=True)
    member = UserLiteSerializer(read_only=True)

    class Meta:
        model = ProjectMember
        fields = "__all__"


class ProjectMemberPreferenceSerializer(BaseSerializer):
    class Meta:
        model = ProjectMember
        fields = ["preferences", "project_id", "member_id", "workspace_id"]

    def validate_preferences(self, value):
        preferences = self.instance.preferences

        preferences.update(value)
        return preferences


class ProjectMemberAdminSerializer(BaseSerializer):
    workspace = WorkspaceLiteSerializer(read_only=True)
    project = ProjectLiteSerializer(read_only=True)
    member = UserAdminLiteSerializer(read_only=True)

    class Meta:
        model = ProjectMember
        fields = "__all__"


class ProjectMemberRoleSerializer(DynamicBaseSerializer):
    original_role = serializers.IntegerField(source="role", read_only=True)

    class Meta:
        model = ProjectMember
        fields = ("id", "role", "member", "project", "original_role", "created_at")
        read_only_fields = ["original_role", "created_at"]


class ProjectMemberInviteSerializer(BaseSerializer):
    project = ProjectLiteSerializer(read_only=True)
    workspace = WorkspaceLiteSerializer(read_only=True)

    class Meta:
        model = ProjectMemberInvite
        fields = "__all__"


class ProjectMemberInvitePublicSerializer(BaseSerializer):
    """Safe read-only serializer for the public project invite GET endpoint.

    Intentionally excludes ``email`` and ``token`` so that an unauthenticated
    caller cannot retrieve the invitee's email address or the acceptance token
    (GHSA-2r58-hgv7-635q).
    """

    project = ProjectLiteSerializer(read_only=True)
    workspace = WorkspaceLiteSerializer(read_only=True)

    class Meta:
        model = ProjectMemberInvite
        fields = [
            "id",
            "project",
            "workspace",
            "role",
            "message",
            "accepted",
            "responded_at",
        ]
        read_only_fields = fields


class ProjectIdentifierSerializer(BaseSerializer):
    class Meta:
        model = ProjectIdentifier
        fields = "__all__"


class ProjectMemberLiteSerializer(BaseSerializer):
    member = UserLiteSerializer(read_only=True)
    is_subscribed = serializers.BooleanField(read_only=True)

    class Meta:
        model = ProjectMember
        fields = ["member", "id", "is_subscribed"]
        read_only_fields = fields


class DeployBoardSerializer(BaseSerializer):
    project_details = ProjectLiteSerializer(read_only=True, source="project")
    workspace_detail = WorkspaceLiteSerializer(read_only=True, source="workspace")

    class Meta:
        model = DeployBoard
        fields = "__all__"
        read_only_fields = ["workspace", "project", "anchor"]


class ProjectPublicMemberSerializer(BaseSerializer):
    class Meta:
        model = ProjectPublicMember
        fields = "__all__"
        read_only_fields = ["workspace", "project", "member"]
