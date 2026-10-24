"""行政审批历史下线迁移的回归测试。"""

import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.state import ProjectState
from django.test.utils import override_settings

from plane.db.models import (
    AdministrativeOrganization,
    Issue,
    Project,
    User,
    Workspace,
    WorkspaceMember,
)


def _load_migration_module():
    """加载 0191 审批下线迁移模块，保持与迁移文件一致的执行入口。"""
    path = Path(__file__).parents[3] / "db/migrations/0191_retire_administrative_approvals.py"
    spec = spec_from_file_location("retire_administrative_approvals_migration", path)
    assert spec is not None and spec.loader is not None
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _historical_state():
    """返回审批模型仍存在时的历史迁移状态。

    仅保留 db、auth、contenttypes 三个应用，避免渲染无关应用时
    触发该工程历史迁移的既有兼容问题。
    """
    with override_settings(MIGRATION_MODULES={}):
        loader = MigrationLoader(None)
        state = loader.project_state([("db", "0190_retire_administrative_approval_flow_templates")])
        return ProjectState(
            models={key: value for key, value in state.models.items() if key[0] in {"db", "auth", "contenttypes"}}
        )


def _drop_approval_tables_if_exist():
    """清理复用测试库中上一次运行遗留的审批历史表。"""
    table_names = (
        "administrative_approval_actions",
        "administrative_approval_requests",
        "administrative_project_approval_settings",
        "administrative_approval_steps",
        "administrative_approval_flows",
    )
    with connection.cursor() as cursor:
        for table_name in table_names:
            cursor.execute(f'DROP TABLE IF EXISTS "{table_name}" CASCADE')


@pytest.mark.django_db
def test_retire_migration_closes_pending_and_archives_final_history(tmp_path, monkeypatch):
    """迁移应关闭存量审批并把最终历史完整写入 JSONL 归档。"""
    module = _load_migration_module()
    state = _historical_state()
    archive_path = tmp_path / "administrative-approvals.jsonl"
    monkeypatch.setenv("PLANE_ADMIN_APPROVAL_ARCHIVE", str(archive_path))

    owner = User.objects.create(email="retire-owner@plane.so", username="retire_owner")
    admin = User.objects.create(email="retire-admin@plane.so", username="retire_admin")
    requester = User.objects.create(email="retire-member@plane.so", username="retire_member")
    workspace = Workspace.objects.create(name="Retire workspace", slug="retire-workspace", owner=owner)
    WorkspaceMember.objects.create(workspace=workspace, member=admin, role=20)
    WorkspaceMember.objects.create(workspace=workspace, member=requester, role=15)
    organization = AdministrativeOrganization.objects.create(workspace=workspace, name="行政测试")
    project = Project.objects.create(
        workspace=workspace,
        name="Retire project",
        identifier="rtap",
        created_by=owner,
        administrative_organization=organization,
    )
    issue = Issue.objects.create(name="Retire issue", project=project, workspace=workspace, created_by=owner)

    with connection.schema_editor() as schema_editor:
        _drop_approval_tables_if_exist()
        flow_model = state.apps.get_model("db", "AdministrativeApprovalFlow")
        step_model = state.apps.get_model("db", "AdministrativeApprovalStep")
        setting_model = state.apps.get_model("db", "AdministrativeProjectApprovalSetting")
        request_model = state.apps.get_model("db", "AdministrativeApprovalRequest")
        action_model = state.apps.get_model("db", "AdministrativeApprovalAction")
        for model in (flow_model, step_model, setting_model, request_model, action_model):
            schema_editor.create_model(model)

        flow = flow_model.objects.create(
            workspace_id=workspace.id,
            organization_id=organization.id,
            name="采购审批",
        )
        step_model.objects.create(flow_id=flow.id, order=1, approver_kind="ORG_ADMIN")
        setting_model.objects.create(project_id=project.id, flow_id=flow.id)
        pending = request_model.objects.create(
            workspace_id=workspace.id,
            project_id=project.id,
            issue_id=issue.id,
            flow_id=flow.id,
            requested_by_id=requester.id,
            status="PENDING",
        )
        approved = request_model.objects.create(
            workspace_id=workspace.id,
            project_id=project.id,
            issue_id=issue.id,
            flow_id=flow.id,
            requested_by_id=requester.id,
            status="APPROVED",
        )

        module.retire_administrative_approvals(state.apps, schema_editor)

        assert request_model.objects.get(pk=pending.pk).status == "CANCELLED"
        assert request_model.objects.get(pk=approved.pk).status == "APPROVED"
        cancel_action = action_model.objects.filter(request_id=pending.pk, action="CANCEL").get()
        assert cancel_action.actor_id == admin.id
        assert cancel_action.comment == module.SYSTEM_CANCEL_COMMENT

    rows = [json.loads(line) for line in archive_path.read_text(encoding="utf-8").splitlines()]
    model_labels = [row["model"] for row in rows]
    assert model_labels.count("administrative_approval_flow") == 1
    assert model_labels.count("administrative_approval_step") == 1
    assert model_labels.count("administrative_project_approval_setting") == 1
    assert model_labels.count("administrative_approval_request") == 2
    assert model_labels.count("administrative_approval_action") == 1

    archived_requests = {
        row["fields"]["id"]: row["fields"] for row in rows if row["model"] == "administrative_approval_request"
    }
    assert archived_requests[str(pending.id)]["status"] == "CANCELLED"
    assert archived_requests[str(approved.id)]["status"] == "APPROVED"
    archived_action = next(row["fields"] for row in rows if row["model"] == "administrative_approval_action")
    assert archived_action["action"] == "CANCEL"
    assert archived_action["actor_id"] == str(admin.id)
    assert archived_action["comment"] == module.SYSTEM_CANCEL_COMMENT


def test_retire_migration_deletes_all_approval_tables():
    """迁移定义必须删除全部五张审批历史表且反向迁移不恢复数据。"""
    module = _load_migration_module()
    deleted = {
        operation.name
        for operation in module.Migration.operations
        if operation.__class__.__name__ == "DeleteModel"
    }
    assert deleted == {
        "AdministrativeProjectApprovalSetting",
        "AdministrativeApprovalAction",
        "AdministrativeApprovalRequest",
        "AdministrativeApprovalStep",
        "AdministrativeApprovalFlow",
    }
    run_python = next(
        operation for operation in module.Migration.operations if operation.__class__.__name__ == "RunPython"
    )
    assert run_python.reverse_code is module.migrations.RunPython.noop
