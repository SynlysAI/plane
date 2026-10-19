from django.db import migrations


class Migration(migrations.Migration):
    """Merge the project-domain and research-agent migration branches."""

    dependencies = [
        ("db", "0181_project_domain_separation"),
        ("db", "0182_research_agent_operations"),
    ]

    operations = []
