"""RWS-1 migration round-trip tests."""

from uuid import uuid4

import pytest
from django.db import connections
from django.db.migrations.loader import MigrationLoader
from django.test.utils import override_settings

pytestmark = [pytest.mark.unit, pytest.mark.django_db]

MIGRATION_NAME = "0235_research_workspace_control_plane"
PREVIOUS_MIGRATION = "0234_research_chain_stage_withdrawal_actions"
RWS_TABLES = {
    "study_workspaces",
    "workspace_working_copies",
    "workspace_operations",
    "workspace_resource_references",
    "workspace_assets",
    "workspace_index_projections",
}


def _tables_in_schema(connection, schema):
    """Return tables created in an isolated PostgreSQL schema.

    Args:
        connection: Active Django database connection.
        schema: PostgreSQL schema name.

    Returns:
        A set of table names in the supplied schema.
    """
    with connection.cursor() as cursor:
        cursor.execute("SELECT tablename FROM pg_tables WHERE schemaname = %s", [schema])
        return {row[0] for row in cursor.fetchall()}


def test_research_workspace_migration_round_trip(transactional_db):
    """Apply and reverse the RWS-1 migration in an isolated PostgreSQL schema.

    Args:
        transactional_db: Provides a transactional test database supporting DDL verification.
    """
    connection = connections["default"]
    schema = f"rws_migration_{uuid4().hex}"
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE SCHEMA "{schema}"')
        cursor.execute(f'SET search_path TO "{schema}", public')

    try:
        with override_settings(MIGRATION_MODULES={}):
            loader = MigrationLoader(None)
            state = loader.project_state([("db", PREVIOUS_MIGRATION)])
            migration = loader.disk_migrations[("db", MIGRATION_NAME)]

        setting_model = state.apps.get_model("db", "WorkspaceResearchSetting")
        with connection.schema_editor() as editor:
            editor.create_model(setting_model)
            after = migration.apply(state.clone(), editor)
        assert RWS_TABLES <= _tables_in_schema(connection, schema)

        with connection.schema_editor() as editor:
            migration.unapply(after.clone(), editor)
        assert not (RWS_TABLES & _tables_in_schema(connection, schema))
    finally:
        with connection.cursor() as cursor:
            cursor.execute("SET search_path TO public")
            cursor.execute(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE')
