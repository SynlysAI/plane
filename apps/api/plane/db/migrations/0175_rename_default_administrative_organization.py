"""Rename the default administrative organization to the public organization."""

from django.db import migrations
from django.utils import timezone


PUBLIC_ORGANIZATION_NAME = "公共"


def _unique_name(base_name, used_names):
    """Return a non-empty organization name unique in one workspace."""
    name = base_name[:255].strip() or PUBLIC_ORGANIZATION_NAME
    candidate = name
    sequence = 2
    while candidate in used_names:
        suffix = f" ({sequence})"
        candidate = f"{name[: 255 - len(suffix)]}{suffix}"
        sequence += 1
    used_names.add(candidate)
    return candidate


def rename_default_administrative_organizations(apps, schema_editor):
    """Rename default organizations and retire their explicit member grants."""
    organization_model = apps.get_model("db", "AdministrativeOrganization")
    organization_member_model = apps.get_model("db", "AdministrativeOrganizationMember")

    default_organizations = organization_model._base_manager.filter(
        is_default=True,
        deleted_at__isnull=True,
    ).select_related("workspace")
    for default_organization in default_organizations:
        used_names = set(
            organization_model._base_manager.filter(
                workspace=default_organization.workspace,
                deleted_at__isnull=True,
            ).values_list("name", flat=True)
        )
        conflicts = organization_model._base_manager.filter(
            workspace=default_organization.workspace,
            is_default=False,
            deleted_at__isnull=True,
            name=PUBLIC_ORGANIZATION_NAME,
        ).order_by("created_at", "id")
        for conflict in conflicts:
            conflict.name = _unique_name(PUBLIC_ORGANIZATION_NAME, used_names)
            conflict.save(update_fields=["name", "updated_at"])

        default_organization.name = PUBLIC_ORGANIZATION_NAME
        default_organization.save(update_fields=["name", "updated_at"])
        now = timezone.now()
        organization_member_model._base_manager.filter(
            organization=default_organization,
            is_active=True,
            deleted_at__isnull=True,
        ).update(is_active=False, deleted_at=now, updated_at=now)


class Migration(migrations.Migration):
    """Data migration for the workspace-wide public administrative organization."""

    dependencies = [("db", "0174_remove_researchagentbackendconnection_rsch_agent_backend_uq_ws_user_and_more")]

    operations = [
        migrations.RunPython(
            rename_default_administrative_organizations,
            migrations.RunPython.noop,
        )
    ]
