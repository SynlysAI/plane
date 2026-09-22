"""Serializers for explicit external account links."""

from rest_framework import serializers

from plane.db.models import AccountLink


class AccountLinkSerializer(serializers.ModelSerializer):
    """Expose account-link metadata without verification secrets."""

    schema_version = serializers.SerializerMethodField()

    class Meta:
        model = AccountLink
        fields = [
            "schema_version",
            "id",
            "canonical_identity",
            "provider",
            "external_subject",
            "local_user",
            "status",
            "verified_at",
            "bound_by",
            "unlinked_at",
            "created_at",
            "updated_at",
        ]
        read_only_fields = fields

    def get_schema_version(self, _obj):
        return "account-link.v1"
