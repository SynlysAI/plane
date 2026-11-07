"""Serializers for the RWS-1 resource control plane."""

from rest_framework import serializers

from plane.db.models import StudyWorkspace, WorkspaceOperation, WorkspaceResourceReference, WorkspaceWorkingCopy

SCHEMA_VERSION = "research-resource-ref.v1"
GIT_OID_PATTERN = r"^[0-9a-f]{40}$|^[0-9a-f]{64}$"
SHA256_PATTERN = r"^[0-9a-f]{64}$"
RELATIVE_PATH_PATTERN = r"^[A-Za-z0-9._()+,-]+(?:/[A-Za-z0-9._()+,-]+)*$"


class WorkspaceWorkingCopySerializer(serializers.ModelSerializer):
    """Stable logical projection of a persistent working copy."""

    resource_uri = serializers.SerializerMethodField()

    class Meta:
        model = WorkspaceWorkingCopy
        fields = (
            "id",
            "branch",
            "status",
            "is_default",
            "base_commit",
            "head_commit",
            "resource_uri",
        )

    def get_resource_uri(self, obj):
        """Return the immutable display URI of the working copy."""
        return obj.resource_uri


class StudyWorkspaceSerializer(serializers.ModelSerializer):
    """Stable projection of a study-level workspace resource."""

    resource_uri = serializers.SerializerMethodField()
    working_copy = serializers.SerializerMethodField()

    class Meta:
        model = StudyWorkspace
        fields = (
            "id",
            "workspace",
            "chain",
            "name",
            "status",
            "is_enabled",
            "resource_uri",
            "working_copy",
            "created_at",
            "updated_at",
        )

    def get_resource_uri(self, obj):
        """Return the immutable display URI of the study workspace."""
        return obj.resource_uri

    def get_working_copy(self, obj):
        """Return the default persistent copy without exposing host paths."""
        copy = obj.default_working_copy
        return WorkspaceWorkingCopySerializer(copy).data if copy else None


class WorkspaceOperationSerializer(serializers.ModelSerializer):
    """Auditable projection of a control-plane operation."""

    class Meta:
        model = WorkspaceOperation
        fields = (
            "id",
            "kind",
            "actor",
            "actor_type",
            "request_id",
            "payload_hash",
            "expected_head",
            "status",
            "error_code",
            "error_message",
            "created_at",
        )


class WorkspaceResourceReferenceSerializer(serializers.Serializer):
    """Validate and project the frozen ``research-resource-ref.v1`` contract."""

    schema_version = serializers.ChoiceField(choices=[SCHEMA_VERSION])
    study_id = serializers.UUIDField()
    kind = serializers.ChoiceField(choices=WorkspaceResourceReference.Kind.choices)
    repository_id = serializers.UUIDField(required=False, allow_null=True)
    commit = serializers.RegexField(GIT_OID_PATTERN, required=False, allow_blank=True)
    path = serializers.RegexField(RELATIVE_PATH_PATTERN, max_length=1024, required=False, allow_blank=True)
    blob_oid = serializers.RegexField(GIT_OID_PATTERN, required=False, allow_blank=True)
    lfs_oid = serializers.RegexField(SHA256_PATTERN, required=False, allow_blank=True)
    asset_revision_id = serializers.UUIDField(required=False, allow_null=True)
    logical_asset_id = serializers.UUIDField(required=False, allow_null=True)
    external_reference = serializers.CharField(max_length=1000, required=False, allow_blank=True)
    content_sha256 = serializers.RegexField(SHA256_PATTERN)
    size = serializers.IntegerField(min_value=0)
    source_system = serializers.CharField(max_length=64, required=False, allow_blank=True)
    source_run_id = serializers.CharField(max_length=128, required=False, allow_blank=True)
    digest = serializers.CharField(read_only=True)
    resource_uri = serializers.SerializerMethodField()

    ALLOWED_FIELDS = {
        "schema_version",
        "study_id",
        "kind",
        "repository_id",
        "commit",
        "path",
        "blob_oid",
        "lfs_oid",
        "asset_revision_id",
        "logical_asset_id",
        "external_reference",
        "content_sha256",
        "size",
        "source_system",
        "source_run_id",
    }
    REQUIRED_BY_KIND = {
        "git": ("repository_id", "commit", "path", "blob_oid"),
        "lfs": ("repository_id", "commit", "path", "lfs_oid"),
        "asset": ("asset_revision_id", "logical_asset_id", "path"),
        "legacy_external": ("external_reference",),
    }

    def get_resource_uri(self, obj):
        """Return the immutable content-addressed display URI."""
        return obj.resource_uri

    def validate(self, attrs):
        """Enforce the v1 kind-specific and additional-fields rules."""
        unknown = set(self.initial_data) - self.ALLOWED_FIELDS
        if unknown:
            raise serializers.ValidationError(f"unknown fields: {', '.join(sorted(unknown))}")
        study = getattr(self.context.get("study"), "id", None)
        if study is not None and attrs["study_id"] != study:
            raise serializers.ValidationError("study_id must match the target StudyWorkspace.")
        path = attrs.get("path", "")
        if path and any(segment in {".", ".."} for segment in path.split("/")):
            raise serializers.ValidationError("path must not contain dot or dot-dot segments.")
        missing = [field for field in self.REQUIRED_BY_KIND[attrs["kind"]] if not attrs.get(field)]
        if missing:
            raise serializers.ValidationError(f"{attrs['kind']} reference requires: {', '.join(missing)}")
        return attrs
