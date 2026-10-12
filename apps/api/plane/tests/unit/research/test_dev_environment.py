"""开发环境重建命令的隔离、凭据与事务回归测试。"""

import json
import stat
from io import StringIO

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import OrgUnit, OrgUnitMember, Project, ResearchProjectProfile, User, WorkspaceMember
from plane.research.services.dev_environment import write_password_manifest
from plane.tests.research_fixtures import enable_research, make_research_org_unit, make_user, make_workspace

pytestmark = pytest.mark.django_db


def _command(workspace, **options):
    """执行重建命令并解析 JSON 输出。

    Args:
        workspace: 本轮测试工作区。
        **options: 要传给命令的模式和输出参数。

    Returns:
        命令输出的 JSON 对象。
    """
    stdout = StringIO()
    call_command("rebuild_dev_environment", workspace=workspace.slug, json=True, stdout=stdout, **options)
    return json.loads(stdout.getvalue())


@pytest.fixture
def baseline():
    """创建含组织身份和科研项目的最小隔离工作区。

    Returns:
        用户、工作区、组织成员、科研档案和项目组成的测试基线。
    """
    user = make_user()
    workspace = make_workspace(user)
    setting = enable_research(workspace)
    unit = make_research_org_unit(workspace, "保留课题组")
    member = OrgUnitMember.objects.create(workspace=workspace, org_unit=unit, user=user)
    project = Project.objects.create(workspace=workspace, name="待清理项目", identifier="DEV")
    profile = ResearchProjectProfile.objects.create(workspace=workspace, project=project, owner=user, org_unit=unit)
    return {
        "user": user,
        "workspace": workspace,
        "setting": setting,
        "unit": unit,
        "member": member,
        "project": project,
        "profile": profile,
    }


def test_dry_run_keeps_business_data_and_needs_no_password(baseline, monkeypatch):
    """无运行时密码也能预览，且不会修改业务数据或账号。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
    """
    monkeypatch.delenv("PLANE_DEV_TEST_PASSWORD", raising=False)
    before = baseline["user"].password
    result = _command(baseline["workspace"], dry_run=True)
    assert result["mode"] == "dry-run"
    assert result["workspaces"][0]["counts"]["research"]["ResearchProjectProfile"] == 1
    assert Project.objects.filter(pk=baseline["project"].pk).exists()
    baseline["user"].refresh_from_db()
    assert baseline["user"].password == before


@pytest.mark.parametrize("mode", ["yes", "verify", "password_only"])
def test_password_is_required_before_mutation(baseline, monkeypatch, mode):
    """未注入密码时拒绝实际操作，业务数据保持完整。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
        mode: 要校验的命令模式。
    """
    monkeypatch.delenv("PLANE_DEV_TEST_PASSWORD", raising=False)
    with pytest.raises(CommandError, match="PLANE_DEV_TEST_PASSWORD"):
        _command(baseline["workspace"], **{mode: True})
    assert Project.objects.filter(pk=baseline["project"].pk).exists()


def test_password_only_keeps_projects_and_exports_private_manifest(baseline, monkeypatch, tmp_path):
    """只轮换密码时保留业务数据，凭据文件权限始终为 0600。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
        tmp_path: pytest 临时目录。
    """
    password = "isolated-runtime-test-password"
    monkeypatch.setenv("PLANE_DEV_TEST_PASSWORD", password)
    manifest = tmp_path / "credentials.csv"
    manifest.touch(mode=0o644)
    result = _command(baseline["workspace"], password_only=True, password_manifest=manifest)
    baseline["user"].refresh_from_db()
    assert baseline["user"].check_password(password)
    assert not baseline["user"].is_password_reset_required
    assert result["passwords"]["ok"]
    assert Project.objects.filter(pk=baseline["project"].pk).exists()
    assert stat.S_IMODE(manifest.stat().st_mode) == 0o600
    assert password not in json.dumps(result)


def test_rebuild_preserves_identities_and_other_workspace(baseline, monkeypatch, tmp_path):
    """重建只删除选定工作区业务数据，保留组织身份与其他工作区项目。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
        tmp_path: pytest 临时目录。
    """
    monkeypatch.setenv("PLANE_DEV_TEST_PASSWORD", "isolated-runtime-test-password")
    other_workspace = make_workspace(baseline["user"])
    other_project = Project.objects.create(workspace=other_workspace, name="保留项目", identifier="KEEP")
    result = _command(baseline["workspace"], yes=True, password_manifest=tmp_path / "credentials.csv")
    assert result["mode"] == "rebuild"
    assert not Project.all_objects.filter(pk=baseline["project"].pk).exists()
    assert not ResearchProjectProfile.objects.filter(pk=baseline["profile"].pk).exists()
    assert Project.objects.filter(pk=other_project.pk).exists()
    assert User.objects.filter(pk=baseline["user"].pk).exists()
    assert WorkspaceMember.objects.filter(workspace=baseline["workspace"], member=baseline["user"]).exists()
    assert OrgUnit.objects.filter(pk=baseline["unit"].pk).exists()
    assert OrgUnitMember.objects.filter(pk=baseline["member"].pk).exists()
    baseline["setting"].refresh_from_db()
    assert baseline["setting"].module_enabled


def test_manifest_failure_rolls_back_business_and_passwords(baseline, monkeypatch, tmp_path):
    """凭据输出失败时，清理操作与密码轮换一并回滚。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
        tmp_path: pytest 临时目录。
    """
    monkeypatch.setenv("PLANE_DEV_TEST_PASSWORD", "isolated-runtime-test-password")
    before = baseline["user"].password
    blocker = tmp_path / "not-a-directory"
    blocker.touch()
    with pytest.raises(FileExistsError):
        _command(baseline["workspace"], yes=True, password_manifest=blocker / "credentials.csv")
    baseline["user"].refresh_from_db()
    assert baseline["user"].password == before
    assert Project.objects.filter(pk=baseline["project"].pk).exists()
    assert ResearchProjectProfile.objects.filter(pk=baseline["profile"].pk).exists()


def test_verify_reports_password_mismatch_without_mutation(baseline, monkeypatch):
    """只读校验能报告密码不一致，且不会轮换账号密码。

    Args:
        baseline: 隔离工作区基线。
        monkeypatch: pytest 环境变量替换器。
    """
    monkeypatch.setenv("PLANE_DEV_TEST_PASSWORD", "different-isolated-test-password")
    before = baseline["user"].password
    result = _command(baseline["workspace"], verify=True)
    assert not result["ok"]
    assert result["passwords"]["invalid"] == 1
    baseline["user"].refresh_from_db()
    assert baseline["user"].password == before


def test_manifest_rejects_symlink(baseline, tmp_path):
    """拒绝通过符号链接覆盖其他文件中的凭据。

    Args:
        baseline: 用于提供测试账号的隔离基线。
        tmp_path: pytest 临时目录。
    """
    target = tmp_path / "target.csv"
    target.touch()
    manifest = tmp_path / "credentials.csv"
    manifest.symlink_to(target)
    with pytest.raises(OSError):
        write_password_manifest(manifest, password="isolated-runtime-test-password")
    assert target.stat().st_size == 0
