import django.db.models.deletion
import plane.db.models.research.report_agent
import uuid
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('db', '0200_orgunit_weekly_confidentiality_default'),
    ]

    operations = [
        migrations.CreateModel(
            name='ReportAgentGrant',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='Created At')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='Last Modified At')),
                ('deleted_at', models.DateTimeField(blank=True, null=True, verbose_name='Deleted At')),
                ('id', models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ('purpose', models.CharField(default='weekly_report', editable=False, max_length=24)),
                ('report_type', models.CharField(default='WEEKLY', editable=False, max_length=16)),
                ('label', models.CharField(max_length=100)),
                ('allowed_actions', models.JSONField(default=plane.db.models.research.report_agent.weekly_actions)),
                ('period_policy', models.CharField(default='current_and_previous_week.v1', max_length=64)),
                ('token_hash', models.CharField(max_length=64, unique=True)),
                ('expires_at', models.DateTimeField(db_index=True)),
                ('revoked_at', models.DateTimeField(blank=True, null=True)),
                ('last_used_at', models.DateTimeField(blank=True, null=True)),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='%(class)s_created_by', to=settings.AUTH_USER_MODEL, verbose_name='Created By')),
                ('updated_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='%(class)s_updated_by', to=settings.AUTH_USER_MODEL, verbose_name='Last Modified By')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='db.workspace')),
            ],
            options={
                'db_table': 'research_report_agent_grants',
            },
        ),
        migrations.CreateModel(
            name='ReportAgentOperation',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True, verbose_name='Created At')),
                ('updated_at', models.DateTimeField(auto_now=True, verbose_name='Last Modified At')),
                ('deleted_at', models.DateTimeField(blank=True, null=True, verbose_name='Deleted At')),
                ('id', models.UUIDField(db_index=True, default=uuid.uuid4, editable=False, primary_key=True, serialize=False, unique=True)),
                ('request_id', models.CharField(max_length=128)),
                ('action', models.CharField(max_length=16)),
                ('period_key', models.CharField(max_length=16)),
                ('payload', models.JSONField(default=dict)),
                ('expected_revision', models.CharField(max_length=2048)),
                ('preconditions', models.JSONField(default=dict)),
                ('request_hash', models.CharField(max_length=64)),
                ('proposal_hash', models.CharField(max_length=64)),
                ('expires_at', models.DateTimeField()),
                ('status', models.CharField(default='PROPOSED', max_length=20)),
                ('result', models.JSONField(default=dict)),
                ('failure', models.JSONField(blank=True, null=True)),
                ('created_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='%(class)s_created_by', to=settings.AUTH_USER_MODEL, verbose_name='Created By')),
                ('grant', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='db.reportagentgrant')),
                ('report', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.PROTECT, to='db.periodicreport')),
                ('updated_by', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='%(class)s_updated_by', to=settings.AUTH_USER_MODEL, verbose_name='Last Modified By')),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to=settings.AUTH_USER_MODEL)),
                ('workspace', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, to='db.workspace')),
            ],
            options={
                'db_table': 'research_report_agent_operations',
            },
        ),
        migrations.AddIndex(
            model_name='reportagentgrant',
            index=models.Index(fields=['workspace', 'user', 'created_at'], name='rsch_report_grant_user_idx'),
        ),
        migrations.AddConstraint(
            model_name='reportagentgrant',
            constraint=models.CheckConstraint(condition=models.Q(('purpose', 'weekly_report'), ('report_type', 'WEEKLY')), name='rsch_report_grant_purpose'),
        ),
        migrations.AddIndex(
            model_name='reportagentoperation',
            index=models.Index(fields=['grant', 'created_at'], name='rsch_report_op_grant_idx'),
        ),
        migrations.AddConstraint(
            model_name='reportagentoperation',
            constraint=models.UniqueConstraint(fields=('workspace', 'user', 'request_id'), name='rsch_report_agent_request_uq'),
        ),
    ]
