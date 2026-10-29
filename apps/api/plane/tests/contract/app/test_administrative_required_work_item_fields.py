# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import pytest
from rest_framework import status
from plane.celery import app as celery_app

from plane.db.models import (
    AdministrativeOrganization,
    DraftIssue,
    Issue,
    IssueLabel,
    Label,
    Module,
    ModuleIssue,
    Project,
    ProjectMember,
    User,
    WorkspaceMember,
)
from plane.utils.work_item_required_fields import active_issue_module_ids, module_removal_would_violate_requirement


@pytest.mark.contract
class TestAdministrativeRequiredWorkItemFields:
    """Project-level required module/label rules for administrative work items."""

    @staticmethod
    def project_url(workspace_slug, project_id):
        """Return the app project update endpoint."""
        return f"/api/workspaces/{workspace_slug}/projects/{project_id}/"

    @staticmethod
    def issue_url(workspace_slug, project_id, issue_id=None):
        """Return the app work item create or update endpoint."""
        base_url = f"/api/workspaces/{workspace_slug}/projects/{project_id}/issues/"
        return f"{base_url}{issue_id}/" if issue_id else base_url

    @staticmethod
    def issue_modules_url(workspace_slug, project_id, issue_id):
        """Return the endpoint that adds or removes modules for a work item."""
        return f"/api/workspaces/{workspace_slug}/projects/{project_id}/issues/{issue_id}/modules/"

    @staticmethod
    def module_issue_url(workspace_slug, project_id, module_id, issue_id):
        """Return the endpoint that removes one module from a work item."""
        return f"/api/workspaces/{workspace_slug}/projects/{project_id}/modules/{module_id}/issues/{issue_id}/"

    @staticmethod
    def external_issue_url(workspace_slug, project_id, issue_id=None):
        """Return the external API work item endpoint."""
        base_url = f"/api/v1/workspaces/{workspace_slug}/projects/{project_id}/issues/"
        return f"{base_url}{issue_id}/" if issue_id else base_url

    @pytest.fixture(autouse=True)
    def eager_celery(self):
        """Run background activity tasks synchronously during contract tests."""
        original = celery_app.conf.task_always_eager
        celery_app.conf.task_always_eager = True
        celery_app.conf.task_eager_propagates = True
        yield
        celery_app.conf.task_always_eager = original
        celery_app.conf.task_eager_propagates = False

    @pytest.fixture
    def administrative_project(self, db, workspace, create_user):
        """Create an administrative project with one module, label, and admin member."""
        organization = AdministrativeOrganization.objects.create(
            workspace=workspace,
            name="财务报销",
            created_by=create_user,
        )
        project = Project.objects.create(
            workspace=workspace,
            name="实验室经费支出",
            identifier="EXP",
            module_view=True,
            administrative_organization=organization,
            created_by=create_user,
        )
        ProjectMember.objects.create(
            project=project,
            member=create_user,
            role=20,
            is_active=True,
        )
        module = Module.objects.create(
            workspace=workspace,
            project=project,
            name="测试耗材",
            created_by=create_user,
        )
        label = Label.objects.create(
            workspace=workspace,
            project=project,
            name="试剂组",
            created_by=create_user,
        )
        return project, module, label

    @pytest.mark.django_db
    def test_admin_can_enable_required_fields(self, session_client, workspace, administrative_project):
        project, _, _ = administrative_project

        response = session_client.patch(
            self.project_url(workspace.slug, project.id),
            {"is_module_required": True, "is_label_required": True},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        project.refresh_from_db()
        assert project.is_module_required is True
        assert project.is_label_required is True

    @pytest.mark.django_db
    def test_member_cannot_change_required_fields(self, session_client, workspace, administrative_project, create_user):
        project, _, _ = administrative_project
        member = User.objects.create(email="member@example.com", username="required-member")
        WorkspaceMember.objects.create(workspace=workspace, member=member, role=15)
        ProjectMember.objects.create(project=project, member=member, role=15, is_active=True)
        session_client.force_authenticate(user=member)

        response = session_client.patch(
            self.project_url(workspace.slug, project.id),
            {"is_module_required": True},
            format="json",
        )

        assert response.status_code == status.HTTP_403_FORBIDDEN
        project.refresh_from_db()
        assert project.is_module_required is False

    @pytest.mark.django_db
    def test_workspace_admin_outside_project_can_change_required_fields(
        self, session_client, workspace, administrative_project
    ):
        project, _, _ = administrative_project
        admin = User.objects.create(email="workspace-admin@example.com", username="required-workspace-admin")
        WorkspaceMember.objects.create(workspace=workspace, member=admin, role=20)
        session_client.force_authenticate(user=admin)

        response = session_client.patch(
            self.project_url(workspace.slug, project.id),
            {"is_module_required": True},
            format="json",
        )

        assert response.status_code == status.HTTP_200_OK
        project.refresh_from_db()
        assert project.is_module_required is True

    @pytest.mark.django_db
    def test_research_project_cannot_enable_required_fields(self, session_client, workspace, create_user):
        project = Project.objects.create(
            workspace=workspace,
            name="科研项目",
            identifier="RES",
            created_by=create_user,
        )
        ProjectMember.objects.create(project=project, member=create_user, role=20, is_active=True)

        response = session_client.patch(
            self.project_url(workspace.slug, project.id),
            {"is_module_required": True},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        project.refresh_from_db()
        assert project.is_module_required is False

    @pytest.mark.django_db
    def test_module_required_needs_enabled_feature_and_option(self, session_client, workspace, administrative_project):
        project, module, _ = administrative_project
        module.delete()
        project.module_view = False
        project.save(update_fields=["module_view"])

        response = session_client.patch(
            self.project_url(workspace.slug, project.id),
            {"is_module_required": True},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        project.refresh_from_db()
        assert project.is_module_required is False

    @pytest.mark.django_db
    def test_missing_required_fields_reject_formal_issue(self, session_client, workspace, administrative_project):
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])

        response = session_client.post(
            self.issue_url(workspace.slug, project.id),
            {"name": "报销申请"},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["module_ids"] == ["模块为必选项。"]
        assert response.json()["label_ids"] == ["标签为必选项。"]
        assert not Issue.objects.filter(name="报销申请").exists()

    @pytest.mark.django_db
    def test_valid_required_fields_create_issue_and_relations_atomically(
        self, session_client, workspace, administrative_project
    ):
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])

        response = session_client.post(
            self.issue_url(workspace.slug, project.id),
            {
                "name": "报销申请",
                "label_ids": [str(label.id)],
                "module_ids": [str(module.id)],
            },
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED
        issue = Issue.objects.get(name="报销申请")
        assert list(issue.labels.values_list("id", flat=True)) == [label.id]
        assert list(issue.issue_module.values_list("module_id", flat=True)) == [module.id]

    @pytest.mark.django_db
    def test_legacy_null_module_ids_create_issue_when_rule_disabled(
        self, session_client, workspace, administrative_project
    ):
        project, _, _ = administrative_project

        response = session_client.post(
            self.issue_url(workspace.slug, project.id),
            {"name": "兼容创建", "module_ids": None},
            format="json",
        )

        assert response.status_code == status.HTTP_201_CREATED
        issue = Issue.objects.get(name="兼容创建")
        assert not issue.issue_module.filter(deleted_at__isnull=True).exists()

    @pytest.mark.django_db
    def test_null_module_ids_rejected_when_module_required(
        self, session_client, workspace, administrative_project
    ):
        project, _, _ = administrative_project
        project.is_module_required = True
        project.save(update_fields=["is_module_required"])

        response = session_client.post(
            self.issue_url(workspace.slug, project.id),
            {"name": "必选创建", "module_ids": None},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["module_ids"] == ["模块为必选项。"]
        assert not Issue.objects.filter(name="必选创建").exists()

    @pytest.mark.django_db
    def test_formal_issue_cannot_clear_required_fields(self, session_client, workspace, administrative_project):
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])
        issue = Issue.objects.create(
            name="已有报销",
            workspace=workspace,
            project=project,
            created_by=session_client.handler._force_user,
        )
        IssueLabel.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            label=label,
            created_by=session_client.handler._force_user,
        )
        ModuleIssue.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            module=module,
            created_by=session_client.handler._force_user,
        )
        project.refresh_from_db()
        assert project.is_module_required is True
        assert active_issue_module_ids(issue) == [module.id]
        assert module_removal_would_violate_requirement(project, [module.id], [str(module.id)]) is True

        response = session_client.patch(
            self.issue_url(workspace.slug, project.id, issue.id),
            {"label_ids": [], "module_ids": []},
            format="json",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert issue.labels.filter(id=label.id).exists()
        assert ModuleIssue.objects.filter(issue=issue, module=module).exists()

    @pytest.mark.django_db
    def test_null_module_ids_do_not_clear_existing_modules(
        self, session_client, workspace, administrative_project
    ):
        project, module, _ = administrative_project
        issue = Issue.objects.create(
            name="保留模块",
            workspace=workspace,
            project=project,
            created_by=session_client.handler._force_user,
        )
        ModuleIssue.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            module=module,
            created_by=session_client.handler._force_user,
        )

        response = session_client.patch(
            self.issue_url(workspace.slug, project.id, issue.id),
            {"name": "保留模块更新", "module_ids": None},
            format="json",
        )

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert ModuleIssue.objects.filter(issue=issue, module=module, deleted_at__isnull=True).exists()

    @pytest.mark.django_db
    def test_empty_module_ids_clear_existing_modules_when_rule_disabled(
        self, session_client, workspace, administrative_project
    ):
        project, module, _ = administrative_project
        issue = Issue.objects.create(
            name="清空模块",
            workspace=workspace,
            project=project,
            created_by=session_client.handler._force_user,
        )
        ModuleIssue.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            module=module,
            created_by=session_client.handler._force_user,
        )

        response = session_client.patch(
            self.issue_url(workspace.slug, project.id, issue.id),
            {"module_ids": []},
            format="json",
        )

        assert response.status_code == status.HTTP_204_NO_CONTENT
        assert not ModuleIssue.objects.filter(issue=issue, module=module, deleted_at__isnull=True).exists()

    @pytest.mark.django_db
    def test_module_relation_api_cannot_remove_last_required_module(
        self, session_client, api_key_client, workspace, administrative_project
    ):
        project, module, _ = administrative_project
        project.is_module_required = True
        project.save(update_fields=["is_module_required"])
        issue = Issue.objects.create(
            name="已有报销",
            workspace=workspace,
            project=project,
            created_by=session_client.handler._force_user,
        )
        ModuleIssue.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            module=module,
            created_by=session_client.handler._force_user,
        )

        response = session_client.post(
            self.issue_modules_url(workspace.slug, project.id, issue.id),
            {"modules": [], "removed_modules": [str(module.id)]},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

        response = session_client.delete(self.module_issue_url(workspace.slug, project.id, module.id, issue.id))
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert ModuleIssue.objects.filter(issue=issue, module=module).exists()

        external_response = api_key_client.delete(
            f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/modules/{module.id}/module-issues/{issue.id}/"
        )
        assert external_response.status_code == status.HTTP_400_BAD_REQUEST
        assert ModuleIssue.objects.filter(issue=issue, module=module).exists()

    @pytest.mark.django_db
    def test_required_options_cannot_be_removed_from_configuration(
        self,
        session_client,
        api_key_client,
        workspace,
        administrative_project,
    ):
        """Required modules and labels cannot become unavailable while the rule is active."""
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])
        issue = Issue.objects.create(
            name="选项保护",
            workspace=workspace,
            project=project,
            created_by=session_client.handler._force_user,
        )
        IssueLabel.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            label=label,
            created_by=session_client.handler._force_user,
        )
        ModuleIssue.objects.create(
            workspace=workspace,
            project=project,
            issue=issue,
            module=module,
            created_by=session_client.handler._force_user,
        )
        module.status = "completed"
        module.save(update_fields=["status"])

        responses = {
            "app_module_delete": session_client.delete(
                f"/api/workspaces/{workspace.slug}/projects/{project.id}/modules/{module.id}/"
            ),
            "app_module_archive": session_client.post(
                f"/api/workspaces/{workspace.slug}/projects/{project.id}/modules/{module.id}/archive/"
            ),
            "app_label_delete": session_client.delete(
                f"/api/workspaces/{workspace.slug}/projects/{project.id}/issue-labels/{label.id}/"
            ),
            "external_module_delete": api_key_client.delete(
                f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/modules/{module.id}/"
            ),
            "external_module_archive": api_key_client.post(
                f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/modules/{module.id}/archive/"
            ),
            "external_label_delete": api_key_client.delete(
                f"/api/v1/workspaces/{workspace.slug}/projects/{project.id}/labels/{label.id}/"
            ),
        }

        assert {name: response.status_code for name, response in responses.items()} == {
            name: status.HTTP_400_BAD_REQUEST for name in responses
        }
        module.refresh_from_db()
        label.refresh_from_db()
        assert module.deleted_at is None
        assert module.archived_at is None
        assert label.deleted_at is None
        assert ModuleIssue.objects.filter(issue=issue, module=module).exists()
        assert IssueLabel.objects.filter(issue=issue, label=label).exists()

    @pytest.mark.django_db
    def test_external_api_enforces_required_fields(
        self,
        api_key_client,
        workspace,
        administrative_project,
    ):
        """The external API follows the same administrative required-field contract."""
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])

        missing = api_key_client.post(
            self.external_issue_url(workspace.slug, project.id),
            {"name": "外部报销"},
            format="json",
        )
        assert missing.status_code == status.HTTP_400_BAD_REQUEST
        assert not Issue.objects.filter(name="外部报销").exists()

        created = api_key_client.post(
            self.external_issue_url(workspace.slug, project.id),
            {
                "name": "外部报销",
                "labels": [str(label.id)],
                "module_ids": [str(module.id)],
            },
            format="json",
        )
        assert created.status_code == status.HTTP_201_CREATED
        issue = Issue.objects.get(name="外部报销")
        assert list(issue.labels.values_list("id", flat=True)) == [label.id]
        assert list(issue.issue_module.values_list("module_id", flat=True)) == [module.id]

        cleared = api_key_client.patch(
            self.external_issue_url(workspace.slug, project.id, issue.id),
            {"labels": [], "module_ids": []},
            format="json",
        )
        assert cleared.status_code == status.HTTP_400_BAD_REQUEST
        assert issue.labels.filter(id=label.id).exists()
        assert ModuleIssue.objects.filter(issue=issue, module=module).exists()

    @pytest.mark.django_db
    def test_external_api_null_module_ids_do_not_clear_existing_modules(
        self,
        api_key_client,
        workspace,
        administrative_project,
    ):
        """The external API keeps treating JSON null as an omitted module list."""
        project, module, _ = administrative_project

        created = api_key_client.post(
            self.external_issue_url(workspace.slug, project.id),
            {
                "name": "外部兼容创建",
                "module_ids": [str(module.id)],
            },
            format="json",
        )
        assert created.status_code == status.HTTP_201_CREATED
        issue = Issue.objects.get(name="外部兼容创建")

        updated = api_key_client.patch(
            self.external_issue_url(workspace.slug, project.id, issue.id),
            {"name": "外部兼容更新", "module_ids": None},
            format="json",
        )

        assert updated.status_code == status.HTTP_200_OK
        assert ModuleIssue.objects.filter(issue=issue, module=module, deleted_at__isnull=True).exists()

    @pytest.mark.django_db
    def test_draft_may_be_incomplete_but_cannot_promote_without_required_fields(
        self, session_client, workspace, administrative_project
    ):
        project, module, label = administrative_project
        project.is_module_required = True
        project.is_label_required = True
        project.save(update_fields=["is_module_required", "is_label_required"])
        draft = DraftIssue.objects.create(
            name="报销草稿",
            workspace=workspace,
            project=project,
            description_html="<p></p>",
            created_by=session_client.handler._force_user,
        )

        failed = session_client.post(
            f"/api/workspaces/{workspace.slug}/draft-to-issue/{draft.id}/",
            {},
            format="json",
        )
        assert failed.status_code == status.HTTP_400_BAD_REQUEST
        assert DraftIssue.objects.filter(id=draft.id).exists()

        promoted = session_client.post(
            f"/api/workspaces/{workspace.slug}/draft-to-issue/{draft.id}/",
            {
                "name": draft.name,
                "description_html": draft.description_html,
                "label_ids": [str(label.id)],
                "module_ids": [str(module.id)],
            },
            format="json",
        )
        assert promoted.status_code == status.HTTP_201_CREATED
        assert not DraftIssue.objects.filter(id=draft.id).exists()
        issue = Issue.objects.get(name="报销草稿")
        assert list(issue.labels.values_list("id", flat=True)) == [label.id]
        assert list(issue.issue_module.values_list("module_id", flat=True)) == [module.id]
