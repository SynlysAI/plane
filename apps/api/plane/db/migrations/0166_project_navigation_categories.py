from django.db import migrations, models
import django.db.models.deletion
from django.conf import settings
import uuid


class Migration(migrations.Migration):
    dependencies = [("db", "0165_research_feedback")]

    operations = [
        migrations.CreateModel(
            name="ProjectNavigationCategory",
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
                ("created_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_created_by", to=settings.AUTH_USER_MODEL, verbose_name="Created By")),
                ("updated_by", models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="%(class)s_updated_by", to=settings.AUTH_USER_MODEL, verbose_name="Last Modified By")),
                ("name", models.CharField(max_length=255)),
                ("scope", models.CharField(choices=[("RESEARCH", "Research projects"), ("ADMINISTRATIVE", "Administrative projects")], max_length=24)),
                ("sort_order", models.FloatField(default=65535)),
                ("org_unit", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="navigation_categories", to="db.orgunit")),
                ("parent", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, related_name="children", to="db.projectnavigationcategory")),
                ("workspace", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="project_navigation_categories", to="db.workspace")),
            ],
            options={"db_table": "project_navigation_categories", "ordering": ("sort_order", "name", "created_at")},
        ),
        migrations.AddField(
            model_name="project",
            name="navigation_category",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="projects", to="db.projectnavigationcategory"),
        ),
        migrations.AddConstraint(
            model_name="projectnavigationcategory",
            constraint=models.UniqueConstraint(condition=models.Q(("deleted_at__isnull", True)), fields=("workspace", "scope", "parent", "name"), name="nav_category_workspace_scope_parent_name_uq"),
        ),
        migrations.AddConstraint(
            model_name="projectnavigationcategory",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True), ("parent__isnull", True)),
                fields=("workspace", "scope", "name"),
                name="nav_category_root_name_uq",
            ),
        ),
        migrations.AddConstraint(
            model_name="projectnavigationcategory",
            constraint=models.UniqueConstraint(
                condition=models.Q(("deleted_at__isnull", True), ("parent__isnull", False)),
                fields=("workspace", "scope", "parent", "name"),
                name="nav_category_child_name_uq",
            ),
        ),
        migrations.AddIndex(
            model_name="projectnavigationcategory",
            index=models.Index(fields=["workspace", "scope", "parent", "sort_order"], name="nav_category_tree_idx"),
        ),
    ]
