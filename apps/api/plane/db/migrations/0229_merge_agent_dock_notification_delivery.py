from django.db import migrations


class Migration(migrations.Migration):
    """Merge the Agent Dock and notification delivery migration branches."""

    dependencies = [
        ("db", "0220_agent_dock_unified_connection"),
        ("db", "0228_workspacenotificationpolicy"),
    ]

    operations = []
