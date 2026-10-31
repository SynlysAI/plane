"""允许统一 MCP 写回执覆盖项目、科研链和节点创建。"""

from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("db", "0215_mcp_recoverable_credentials")]

    operations = [
        migrations.AlterField(
            model_name="unifiedmcpwriteresult",
            name="issue_id",
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.RemoveConstraint(
            model_name="unifiedmcpwriteresult",
            name="unified_mcp_receipt_tool_ck",
        ),
        migrations.AddConstraint(
            model_name="unifiedmcpwriteresult",
            constraint=models.CheckConstraint(
                condition=models.Q(
                    tool__in=[
                        "plane_create_task",
                        "plane_add_comment",
                        "plane_create_project",
                        "plane_create_research_project",
                        "plane_create_research_chain",
                        "plane_create_research_node",
                    ]
                ),
                name="unified_mcp_receipt_tool_ck",
            ),
        ),
    ]
