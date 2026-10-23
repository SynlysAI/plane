# Generated for the structured research template feature.

import django.db.models.deletion
import plane.db.models.research.template
from django.db import migrations, models


def backfill_template_targets(apps, schema_editor):
    """Backfill stable target keys for existing report templates."""
    template_model = apps.get_model("db", "ReportTemplate")
    for template in template_model.objects.all().iterator():
        if template.scope == "STAGE_MATERIAL":
            template.target_key = f"STAGE_MATERIAL:{template.stage.upper()}:{template.material_type.upper()}"
        elif template.scope == "EXPERIMENT":
            template.target_key = f"EXPERIMENT:{template.material_type.upper() or 'ALL'}"
        else:
            template.target_key = f"REPORT:{template.report_type.upper() or 'WEEKLY'}"
        template.save(update_fields=["target_key"])


class Migration(migrations.Migration):
    """Add structured sections, stable targets, and filled-object links."""

    dependencies = [
        ("db", "0193_research_report_comments_feedback"),
    ]

    operations = [
        migrations.AddField(
            model_name="reporttemplate",
            name="sections_json",
            field=models.JSONField(
                blank=True,
                default=plane.db.models.research.template.get_default_template_sections,
            ),
        ),
        migrations.AddField(
            model_name="reporttemplate",
            name="target_key",
            field=models.CharField(db_index=True, default="", editable=False, max_length=128),
        ),
        migrations.AddField(
            model_name="periodicreport",
            name="template",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="periodic_reports",
                to="db.reporttemplate",
            ),
        ),
        migrations.AddField(
            model_name="stagematerial",
            name="template",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="stage_materials",
                to="db.reporttemplate",
            ),
        ),
        migrations.RunPython(backfill_template_targets, migrations.RunPython.noop),
        migrations.AlterModelOptions(
            name="reporttemplate",
            options={
                "ordering": ("target_key", "name"),
                "verbose_name": "Research Report Template",
                "verbose_name_plural": "Research Report Templates",
            },
        ),
        migrations.RemoveConstraint(
            model_name="reporttemplate",
            name="rsch_template_uq_ws_type_name",
        ),
        migrations.RemoveConstraint(
            model_name="reporttemplate",
            name="rsch_template_uq_default",
        ),
        migrations.AddConstraint(
            model_name="reporttemplate",
            constraint=models.UniqueConstraint(
                condition=models.Q(deleted_at__isnull=True),
                fields=("workspace", "target_key", "name"),
                name="rsch_template_uq_ws_target_name",
            ),
        ),
        migrations.AddConstraint(
            model_name="reporttemplate",
            constraint=models.UniqueConstraint(
                condition=models.Q(deleted_at__isnull=True, is_default=True),
                fields=("workspace", "target_key"),
                name="rsch_template_uq_target_default",
            ),
        ),
    ]
