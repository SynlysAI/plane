from django.db import migrations


def retire_flow_templates(apps, schema_editor):
    """停用所有仍标记为启用的行政审批流程模板。

    行政审批已改为负责人直接指派后自动完成，流程模板不再参与新请求；
    停用仅影响模板展示，不改变历史审批记录与流程版本。
    """
    AdministrativeApprovalFlow = apps.get_model("db", "AdministrativeApprovalFlow")
    AdministrativeApprovalFlow.objects.filter(is_template=True, is_active=True).update(is_active=False)


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0189_asset_preview"),
    ]

    operations = [
        migrations.RunPython(retire_flow_templates, migrations.RunPython.noop),
    ]
