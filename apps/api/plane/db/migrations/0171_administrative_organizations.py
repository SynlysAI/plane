# Generated for administrative project organizations.
import uuid

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models
from django.db.models import Q
from django.utils import timezone


DEFAULT_ORGANIZATION_NAME = "默认"


def _unique_name(base_name, used_names):
    """Return a unique organization name in one workspace.

    Args:
        base_name: The preferred name derived from a legacy category path.
        used_names: Existing active organization names in the workspace.

    Returns:
        A non-empty name no longer than 255 characters.
    """
    name = base_name[:255].strip() or DEFAULT_ORGANIZATION_NAME
    candidate = name
    sequence = 2
    while candidate in used_names:
        suffix = f" ({sequence})"
        candidate = f"{name[: 255 - len(suffix)]}{suffix}"
        sequence += 1
    used_names.add(candidate)
    return candidate


def _category_path(category, categories_by_id):
    """Build a stable flattened path from legacy administrative categories.

    Args:
        category: The legacy category being projected to an organization.
        categories_by_id: Active administrative categories indexed by ID.

    Returns:
        A slash-delimited path that distinguishes same-name child categories.
    """
    names = [category.name]
    seen = {category.id}
    parent_id = category.parent_id
    while parent_id and parent_id not in seen:
        parent = categories_by_id.get(parent_id)
        if parent is None:
            break
        names.append(parent.name)
        seen.add(parent.id)
        parent_id = parent.parent_id
    return " / ".join(reversed(names))


def _historical_manager(model):
    """Return a manager that includes soft-deleted historical rows."""
    return getattr(model, "all_objects", model._base_manager)


def create_administrative_organizations(apps, schema_editor):
    """Create default organizations and migrate legacy administrative categories.

    Args:
        apps: The historical Django application registry.
        schema_editor: The migration schema editor.
    """
    workspace_model = apps.get_model("db", "Workspace")
    project_model = apps.get_model("db", "Project")
    category_model = apps.get_model("db", "ProjectNavigationCategory")
    organization_model = apps.get_model("db", "AdministrativeOrganization")
    organization_member_model = apps.get_model("db", "AdministrativeOrganizationMember")
    workspace_member_model = apps.get_model("db", "WorkspaceMember")
    profile_model = apps.get_model("db", "ResearchProjectProfile")
    chain_model = apps.get_model("db", "ResearchChain")

    research_project_ids = set(_historical_manager(profile_model).values_list("project_id", flat=True))
    research_project_ids.update(_historical_manager(chain_model).values_list("project_id", flat=True))

    for workspace in workspace_model._base_manager.all():
        used_names = set(
            organization_model._base_manager.filter(workspace=workspace, deleted_at__isnull=True).values_list(
                "name", flat=True
            )
        )
        default_organization = organization_model._base_manager.filter(
            workspace=workspace, is_default=True, deleted_at__isnull=True
        ).first()
        if default_organization is None:
            default_organization = organization_model._base_manager.filter(
                workspace=workspace, name=DEFAULT_ORGANIZATION_NAME, deleted_at__isnull=True
            ).first()
        if default_organization is None:
            default_organization = organization_model.objects.create(
                workspace=workspace,
                name=_unique_name(DEFAULT_ORGANIZATION_NAME, used_names),
                is_default=True,
                created_by=workspace.owner,
            )
        elif not default_organization.is_default:
            default_organization.is_default = True
            default_organization.save(update_fields=["is_default", "updated_at"])

        categories = list(
            category_model._base_manager.filter(
                workspace=workspace,
                scope="ADMINISTRATIVE",
                deleted_at__isnull=True,
            ).order_by("created_at", "id")
        )
        categories_by_id = {category.id: category for category in categories}
        organization_by_category = {}

        for category in categories:
            path_name = _category_path(category, categories_by_id)
            organization = organization_model.objects.create(
                workspace=workspace,
                name=_unique_name(path_name, used_names),
                created_by=category.created_by or workspace.owner,
            )
            creator_is_member = (
                category.created_by
                and category.created_by.is_active
                and workspace_member_model._base_manager.filter(
                    workspace=workspace,
                    member=category.created_by,
                    is_active=True,
                    deleted_at__isnull=True,
                ).exists()
            )
            if creator_is_member:
                organization_member_model.objects.create(
                    workspace=workspace,
                    organization=organization,
                    member=category.created_by,
                    role="ADMIN",
                    created_by=category.created_by,
                )
            organization_by_category[category.id] = organization

        projects = project_model._base_manager.filter(
            workspace=workspace,
            deleted_at__isnull=True,
            administrative_organization__isnull=True,
        )
        for project in projects:
            if project.id in research_project_ids:
                continue
            organization = organization_by_category.get(project.navigation_category_id, default_organization)
            project.administrative_organization = organization
            project.save(update_fields=["administrative_organization", "updated_at"])

        category_model._base_manager.filter(
            workspace=workspace, scope="ADMINISTRATIVE", deleted_at__isnull=True
        ).update(deleted_at=timezone.now())


class Migration(migrations.Migration):
    dependencies = [("db", "0170_merge_research_project_deletion_and_task_comments")]

    operations = [
        migrations.CreateModel(
            name="AdministrativeOrganization",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                (
                    "id",
                    models.UUIDField(
                        db_index=True,
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                        unique=True,
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_created_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Created By",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_updated_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Last Modified By",
                    ),
                ),
                ("name", models.CharField(max_length=255)),
                ("is_default", models.BooleanField(default=False)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="administrative_organizations",
                        to="db.workspace",
                    ),
                ),
            ],
            options={"db_table": "administrative_organizations", "ordering": ("name", "created_at")},
        ),
        migrations.CreateModel(
            name="AdministrativeOrganizationMember",
            fields=[
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="Created At")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="Last Modified At")),
                ("deleted_at", models.DateTimeField(blank=True, null=True, verbose_name="Deleted At")),
                (
                    "id",
                    models.UUIDField(
                        db_index=True,
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                        unique=True,
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_created_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Created By",
                    ),
                ),
                (
                    "updated_by",
                    models.ForeignKey(
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="%(class)s_updated_by",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="Last Modified By",
                    ),
                ),
                (
                    "role",
                    models.CharField(
                        choices=[("ADMIN", "Administrator"), ("MEMBER", "Member")],
                        default="MEMBER",
                        max_length=12,
                    ),
                ),
                ("is_active", models.BooleanField(default=True)),
                (
                    "member",
                    models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to=settings.AUTH_USER_MODEL),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="members",
                        to="db.administrativeorganization",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, to="db.workspace"),
                ),
            ],
            options={"db_table": "administrative_organization_members"},
        ),
        migrations.AddField(
            model_name="project",
            name="administrative_organization",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="projects",
                to="db.administrativeorganization",
            ),
        ),
        migrations.AddConstraint(
            model_name="administrativeorganization",
            constraint=models.UniqueConstraint(
                condition=Q(deleted_at__isnull=True),
                fields=("workspace", "name"),
                name="admin_org_workspace_name_uq",
            ),
        ),
        migrations.AddConstraint(
            model_name="administrativeorganization",
            constraint=models.UniqueConstraint(
                condition=Q(is_default=True, deleted_at__isnull=True),
                fields=("workspace",),
                name="admin_org_workspace_default_uq",
            ),
        ),
        migrations.AddConstraint(
            model_name="administrativeorganizationmember",
            constraint=models.UniqueConstraint(
                condition=Q(deleted_at__isnull=True),
                fields=("organization", "member"),
                name="admin_org_member_uq",
            ),
        ),
        migrations.AddIndex(
            model_name="administrativeorganizationmember",
            index=models.Index(fields=["member", "is_active"], name="admin_org_member_user_idx"),
        ),
        migrations.RunPython(create_administrative_organizations, migrations.RunPython.noop),
    ]
