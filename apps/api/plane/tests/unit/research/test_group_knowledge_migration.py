"""Regression coverage for knowledge bindings using historical models."""

from importlib import import_module
from types import SimpleNamespace

from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.test import TestCase, override_settings


class GroupKnowledgeMigrationTests(TestCase):
    def test_historical_requests_are_archived_once_and_ready_requests_remain(self):
        migration = import_module("plane.db.migrations.0160_research_group_knowledge_bindings")
        # Read migration history even when pytest creates the test schema with --nomigrations.
        with override_settings(MIGRATION_MODULES={}):
            apps = MigrationLoader(connection).project_state([("db", "0160_research_group_knowledge_bindings")]).apps
        User = apps.get_model("db", "User")
        Workspace = apps.get_model("db", "Workspace")
        Project = apps.get_model("db", "Project")
        Profile = apps.get_model("db", "ResearchProjectProfile")
        Unit = apps.get_model("db", "OrgUnit")
        Member = apps.get_model("db", "OrgUnitMember")
        Chain = apps.get_model("db", "ResearchChain")
        Request = apps.get_model("db", "ResearchKnowledgeRequest")
        Binding = apps.get_model("db", "ResearchGroupKnowledgeBinding")
        owner = User.objects.create(email="migration@example.com", username="migration")
        workspace = Workspace.objects.create(name="Migration", slug="migration", owner_id=owner.pk)
        team = Unit.objects.create(workspace_id=workspace.pk, name="Team", unit_type="TEAM", path="/")
        Member.objects.create(workspace_id=workspace.pk, org_unit_id=team.pk, user_id=owner.pk, is_primary=True)
        requests = []
        for index, state in enumerate(("PENDING_ADMIN", "REQUESTED", "READY")):
            project = Project.objects.create(workspace_id=workspace.pk, name=f"Project {index}", identifier=f"P{index}")
            if index == 0:
                Profile.objects.create(
                    workspace_id=workspace.pk, project_id=project.pk, owner_id=owner.pk, org_unit_id=team.pk
                )
            chain = Chain.objects.create(
                workspace_id=workspace.pk,
                project_id=project.pk,
                owner_id=owner.pk,
                request_id=f"chain-{index}",
                payload_hash="hash",
            )
            requests.append(
                Request.objects.create(
                    workspace_id=workspace.pk,
                    chain_id=chain.pk,
                    request_key=f"request-{index}",
                    state=state,
                    created_by_id=owner.pk,
                    parameter_summary={"kept": True},
                )
            )
        editor = SimpleNamespace(connection=connection)
        migration.archive_pending_chain_requests(apps, editor)
        migration.archive_pending_chain_requests(apps, editor)
        binding = Binding.objects.get(org_unit_id=team.pk)
        self.assertEqual(Binding.objects.count(), 1)
        self.assertEqual(binding.created_by_id, owner.pk)
        for request in requests[:2]:
            request.refresh_from_db()
            self.assertEqual(request.state, "ARCHIVED")
            self.assertTrue(request.parameter_summary["kept"])
            self.assertEqual(request.parameter_summary["superseded_by_group_binding_id"], str(binding.pk))
        requests[2].refresh_from_db()
        self.assertEqual(requests[2].state, "READY")
