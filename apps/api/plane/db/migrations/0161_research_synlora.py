from django.db import migrations, models


class Migration(migrations.Migration):
    """Add the shared Synlora runtime as a first-class integration."""

    dependencies = [("db", "0160_research_group_knowledge_bindings")]

    operations = [
        migrations.AlterField(
            model_name="externalsystemconnection",
            name="system",
            field=models.CharField(
                max_length=24,
                choices=[
                    ("RAGPORTAL", "RAGPortal"),
                    ("WEKNORA", "WeKnora"),
                    ("SYNLORA", "Synlora"),
                    ("SPECLABOS", "SpecLabOS"),
                    ("SMARTACCESS", "SmartAccess"),
                    ("POLY_AGENT", "Poly_Agent"),
                    ("SPEC_AGENT", "Spec_Agent"),
                ],
            ),
        ),
        migrations.AlterField(
            model_name="integrationcalllog",
            name="system",
            field=models.CharField(
                max_length=24,
                choices=[
                    ("RAGPORTAL", "RAGPortal"),
                    ("WEKNORA", "WeKnora"),
                    ("SYNLORA", "Synlora"),
                    ("SPECLABOS", "SpecLabOS"),
                    ("SMARTACCESS", "SmartAccess"),
                    ("POLY_AGENT", "Poly_Agent"),
                    ("SPEC_AGENT", "Spec_Agent"),
                ],
            ),
        ),
        migrations.AlterField(
            model_name="researchexternalreference",
            name="system",
            field=models.CharField(
                max_length=24,
                choices=[
                    ("RAGPORTAL", "RAGPortal"),
                    ("WEKNORA", "WeKnora"),
                    ("SYNLORA", "Synlora"),
                    ("SPECLABOS", "SpecLabOS"),
                    ("SMARTACCESS", "SmartAccess"),
                    ("POLY_AGENT", "Poly_Agent"),
                    ("SPEC_AGENT", "Spec_Agent"),
                ],
            ),
        ),
    ]
