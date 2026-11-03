"""Link Agent Dock sessions to their short-lived unified MCP connection."""

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0219_context_grant_server_token"),
    ]

    operations = [
        migrations.AddField(
            model_name="researchagentsession",
            name="unified_mcp_connection",
            field=models.OneToOneField(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="agent_dock_session",
                to="db.unifiedmcpconnection",
            ),
        ),
    ]
