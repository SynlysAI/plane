"""开发环境账号清理命令的预览、防护与事务回归测试。"""

import json
from io import StringIO
from uuid import uuid4

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from plane.db.models import (
    AccountLink,
    AdministrativeOrganization,
    Issue,
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchProjectProfile,
    ResearchUserProfile,
    User,
    WorkspaceMember,
)
from plane.license.models import InstanceRoleAssignment
from plane.research.services.dev_account_prune import (
    ADMIN_EMAIL,
    ADVISOR_EMAIL,
    MEMBER_EMAIL,
    MAIN_PI_EMAIL,
    STUDENT_EMAIL,
)
from plane.research.utils.roles import MAIN_PI, WORKSPACE_ADMIN_ROLE, WORKSPACE_MEMBER_ROLE
from plane.tests.research_fixtures import (
    add_workspace_member,
    enable_research,
    grant_admin_tag,
    make_instance_admin,
    make_research_org_unit,
    make_user,
    make_workspace,
)

pytestmark = pytest.mark.django_db

EXTRA_EMAIL = "fangyikaii@163.com"


def _command(**options):
    """执行清理命令并解析 JSON 输出。

    Args:
        **options: 传给管理命令的参数。

    Returns:
        命令输出的 JSON 对象。
    """
    stdout = StringIO()
    call_command("prune_dev_accounts", json=True, stdout=stdout, **options)
    return json.loads(stdout.getvalue())


def _bot(index):
    """创建一个系统 bot 账号。

    Args:
        index: 用于区分邮箱的序号。

    Returns:
        bot 用户。
    """
    user = make_user(email=f"bot{index}@ai4ms.local", first_name=f"Bot{index}")
    user.is_bot = True
    user.save(update_fields=["is_bot"])
    return user


@pytest.fixture
def baseline():
    """构造含多余账号、组织和科研项目的最小 dev 库。

    Returns:
        保留账号、多余账号、工作区、组织和业务对象组成的测试基线。
    """
    admin = make_user(email=ADMIN_EMAIL, first_name="Admin")
    make_instance_admin(admin)
    hong = make_user(email=MAIN_PI_EMAIL, first_name="洪文晶")
    advisor = make_user(email=ADVISOR_EMAIL, first_name="刘俊扬")
    student = make_user(email=STUDENT_EMAIL, first_name="张曦宇")
    member = make_user(email=MEMBER_EMAIL, first_name="高鹏")
    extra = make_user(email=EXTRA_EMAIL, first_name="方一凯")
    bots = [_bot(index) for index in range(1, 4)]
    grant_admin_tag(hong, MAIN_PI, actor=admin)
    grant_admin_tag(extra, MAIN_PI, actor=admin)

    public = make_workspace(admin, name="公共工作区", slug="public")
    pi = make_workspace(admin, name="主PI工作区", slug="pi")
    public_setting = enable_research(public, purpose="PUBLIC_RESEARCH", main_pi=hong)
    pi_setting = enable_research(pi, purpose="PI_PRIVATE", main_pi=hong)
    for user in (hong, advisor, student, member, extra, *bots):
        if user.id != admin.id:
            add_workspace_member(public, user, role=WORKSPACE_MEMBER_ROLE)
            add_workspace_member(pi, user, role=WORKSPACE_MEMBER_ROLE)

    root = make_research_org_unit(public, "π-Lab", unit_type=OrgUnit.UnitType.ROOT)
    basic = make_research_org_unit(
        public,
        "基础研究",
        parent=root,
        unit_type=OrgUnit.UnitType.LAB,
    )
    basic.business_category = OrgUnit.BusinessCategory.BASIC_RESEARCH
    basic.save(update_fields=["business_category"])
    device = make_research_org_unit(
        public,
        "器件",
        parent=basic,
        unit_type=OrgUnit.UnitType.TEAM,
    )
    device.business_category = OrgUnit.BusinessCategory.BASIC_RESEARCH
    device.save(update_fields=["business_category"])
    extra_direction = make_research_org_unit(
        public,
        "产业化",
        parent=root,
        unit_type=OrgUnit.UnitType.LAB,
    )
    extra_team = make_research_org_unit(
        public,
        "电池",
        parent=extra_direction,
        unit_type=OrgUnit.UnitType.TEAM,
    )

    OrgUnitMember.objects.create(
        workspace=public, org_unit=device, user=hong, org_role=OrgUnitMember.OrgRole.PI, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=public, org_unit=root, user=advisor, org_role=OrgUnitMember.OrgRole.PI, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=public, org_unit=device, user=student, org_role=OrgUnitMember.OrgRole.REVIEWER, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=public, org_unit=device, user=member, org_role=OrgUnitMember.OrgRole.REVIEWER, is_primary=True
    )
    OrgUnitMember.objects.create(
        workspace=public, org_unit=extra_team, user=extra, org_role=OrgUnitMember.OrgRole.REVIEWER, is_primary=True
    )
    MentorBinding.objects.create(
        workspace=public, mentee=student, mentor=advisor, org_unit=device, is_primary_advisor=True
    )
    MentorBinding.objects.create(
        workspace=public, mentee=student, mentor=extra, org_unit=extra_team, is_primary_advisor=False
    )
    ResearchUserProfile.objects.create(user=member, category=ResearchUserProfile.Category.STUDENT)
    ResearchUserProfile.objects.create(user=extra, category=ResearchUserProfile.Category.STUDENT)
    AccountLink.objects.create(
        canonical_identity=EXTRA_EMAIL,
        provider="oidc",
        external_subject="extra-subject",
        local_user=extra,
        request_id=f"link-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )

    project = Project.objects.create(workspace=public, name="待清理课题", identifier="DEV")
    ResearchProjectProfile.objects.create(workspace=public, project=project, owner=student, org_unit=device)
    Issue.objects.create(project=project, workspace=public, name="待清理工作项")
    ResearchChain.objects.create(
        project=project,
        workspace=public,
        owner=student,
        request_id=f"chain-{uuid4().hex}",
        payload_hash=uuid4().hex,
    )
    admin_project = Project.objects.create(workspace=public, name="待清理行政项目", identifier="ADM")

    return {
        "admin": admin,
        "hong": hong,
        "advisor": advisor,
        "student": student,
        "member": member,
        "extra": extra,
        "bots": bots,
        "public": public,
        "pi": pi,
        "public_setting": public_setting,
        "pi_setting": pi_setting,
        "root": root,
        "basic": basic,
        "device": device,
        "extra_direction": extra_direction,
        "extra_team": extra_team,
        "project": project,
        "admin_project": admin_project,
        "passwords": {user.email: user.password for user in (admin, hong, advisor, student, member)},
    }


def test_dry_run_keeps_data_and_reports_counts(baseline):
    """无 flag 视为 dry-run，不改库并预告将删项目、账号和组织节点。

    Args:
        baseline: 隔离开发库基线。
    """
    result = _command()
    assert result["mode"] == "dry-run"
    assert result["projects_to_delete"] == 2
    assert result["accounts_to_delete"] == 1
    assert result["org_units_to_delete"] == 2
    assert EXTRA_EMAIL in result["account_emails_to_delete"]
    assert not result["missing_keep_users"]
    assert User.objects.filter(email=EXTRA_EMAIL).exists()
    assert Project.objects.filter(pk=baseline["project"].pk).exists()
    assert OrgUnit.objects.filter(pk=baseline["extra_team"].pk).exists()
    baseline["hong"].refresh_from_db()
    assert baseline["hong"].password == baseline["passwords"][MAIN_PI_EMAIL]


def test_yes_without_prune_flag_fails(baseline, monkeypatch):
    """未注入 PLANE_DEV_PRUNE 时拒绝写入，数据保持完整。

    Args:
        baseline: 隔离开发库基线。
        monkeypatch: pytest 环境变量替换器。
    """
    monkeypatch.delenv("PLANE_DEV_PRUNE", raising=False)
    with pytest.raises(CommandError, match="PLANE_DEV_PRUNE"):
        _command(yes=True)
    assert User.objects.filter(email=EXTRA_EMAIL).exists()
    assert Project.objects.filter(pk=baseline["project"].pk).exists()


def test_yes_rejects_production_web_url(baseline, monkeypatch):
    """生产 WEB_URL 即使打开开关也拒绝写入。

    Args:
        baseline: 隔离开发库基线。
        monkeypatch: pytest 环境与配置替换器。
    """
    monkeypatch.setenv("PLANE_DEV_PRUNE", "1")
    monkeypatch.setattr("django.conf.settings.WEB_URL", "https://openeva.xmuzc.com")
    with pytest.raises(CommandError, match="生产"):
        _command(yes=True)
    assert User.objects.filter(email=EXTRA_EMAIL).exists()
    assert Project.objects.filter(pk=baseline["project"].pk).exists()


def test_conflicting_flags_are_rejected(baseline):
    """同时指定 --dry-run 和 --yes 时报错。

    Args:
        baseline: 隔离开发库基线。
    """
    with pytest.raises(CommandError, match="不能同时指定"):
        _command(dry_run=True, yes=True)


def test_apply_keeps_five_humans_and_rebuilds_min_org(baseline, monkeypatch):
    """写入后只留 5 个人类账号与 3 个 bot，并重建最小组织和身份。

    Args:
        baseline: 隔离开发库基线。
        monkeypatch: pytest 环境与配置替换器。
    """
    monkeypatch.setenv("PLANE_DEV_PRUNE", "1")
    monkeypatch.setattr("django.conf.settings.WEB_URL", "https://fangyikai-pc.tail1b4cb7.ts.net")
    result = _command(yes=True)
    assert result["mode"] == "apply"
    assert result["after"]["humans"] == 5
    assert result["after"]["bots"] == 3
    assert result["after"]["projects"] == 0
    assert result["after"]["chains"] == 0
    assert result["after"]["issues"] == 0
    assert result["after"]["org_units"] == 3
    assert result["after"]["mentor_bindings"] == 1
    assert not User.objects.filter(email=EXTRA_EMAIL).exists()
    assert not Project.all_objects.filter(pk=baseline["project"].pk).exists()
    assert not OrgUnit.all_objects.filter(pk=baseline["extra_team"].pk).exists()
    assert not AccountLink.all_objects.filter(local_user=baseline["extra"]).exists()

    emails = set(User.objects.filter(is_bot=False).values_list("email", flat=True))
    assert emails == {ADMIN_EMAIL, MAIN_PI_EMAIL, ADVISOR_EMAIL, STUDENT_EMAIL, MEMBER_EMAIL}
    assert User.objects.filter(is_bot=True).count() == 3

    units = list(OrgUnit.objects.filter(workspace=baseline["public"]).order_by("depth"))
    assert [unit.name for unit in units] == ["π-Lab", "基础研究", "器件"]
    assert units[0].unit_type == OrgUnit.UnitType.ROOT
    assert units[1].parent_id == units[0].id
    assert units[1].unit_type == OrgUnit.UnitType.LAB
    assert units[2].parent_id == units[1].id
    assert units[2].unit_type == OrgUnit.UnitType.TEAM

    hong_memberships = list(OrgUnitMember.objects.filter(user=baseline["hong"]))
    assert len(hong_memberships) == 1
    assert hong_memberships[0].org_unit.name == "π-Lab"
    assert hong_memberships[0].org_role == OrgUnitMember.OrgRole.PI
    advisor_memberships = list(OrgUnitMember.objects.filter(user=baseline["advisor"]))
    assert len(advisor_memberships) == 1
    assert advisor_memberships[0].org_unit.name == "器件"
    assert advisor_memberships[0].org_role == OrgUnitMember.OrgRole.ADVISOR
    student_memberships = list(OrgUnitMember.objects.filter(user=baseline["student"]))
    assert len(student_memberships) == 1
    assert student_memberships[0].org_role == OrgUnitMember.OrgRole.REVIEWER
    assert not OrgUnitMember.objects.filter(user=baseline["member"]).exists()
    assert not ResearchUserProfile.objects.filter(user=baseline["member"]).exists()
    assert not OrgUnitMember.objects.filter(user=baseline["admin"]).exists()

    binding = MentorBinding.objects.get()
    assert binding.mentee_id == baseline["student"].id
    assert binding.mentor_id == baseline["advisor"].id
    assert binding.is_primary_advisor

    public_admin = WorkspaceMember.objects.get(workspace=baseline["public"], member=baseline["admin"])
    pi_admin = WorkspaceMember.objects.get(workspace=baseline["pi"], member=baseline["admin"])
    assert public_admin.role == WORKSPACE_ADMIN_ROLE
    assert pi_admin.role == WORKSPACE_ADMIN_ROLE
    assert WorkspaceMember.objects.filter(workspace=baseline["pi"], member=baseline["hong"]).exists()
    assert not WorkspaceMember.objects.filter(workspace=baseline["pi"], member=baseline["advisor"]).exists()
    assert not WorkspaceMember.objects.filter(workspace=baseline["pi"], member=baseline["student"]).exists()
    assert not WorkspaceMember.objects.filter(workspace=baseline["pi"], member=baseline["member"]).exists()
    for bot in baseline["bots"]:
        assert WorkspaceMember.objects.filter(workspace=baseline["public"], member=bot).exists()
        assert WorkspaceMember.objects.filter(workspace=baseline["pi"], member=bot).exists()

    baseline["public_setting"].refresh_from_db()
    baseline["pi_setting"].refresh_from_db()
    assert baseline["public_setting"].main_pi_id == baseline["hong"].id
    assert baseline["pi_setting"].main_pi_id == baseline["hong"].id
    assert InstanceRoleAssignment.objects.filter(role=MAIN_PI, deleted_at__isnull=True).count() == 1
    assert InstanceRoleAssignment.objects.get(role=MAIN_PI).user_id == baseline["hong"].id

    for workspace in (baseline["public"], baseline["pi"]):
        default_org = AdministrativeOrganization.objects.get(workspace=workspace, is_default=True)
        assert default_org.name == "公共"

    for email, password in baseline["passwords"].items():
        user = User.objects.get(email=email)
        assert user.password == password


def test_identity_failure_rolls_back_all_changes(baseline, monkeypatch):
    """身份修复失败时，业务清理与账号删除一并回滚。

    Args:
        baseline: 隔离开发库基线。
        monkeypatch: pytest 环境与函数替换器。
    """
    monkeypatch.setenv("PLANE_DEV_PRUNE", "1")
    monkeypatch.setattr("django.conf.settings.WEB_URL", "https://fangyikai-pc.tail1b4cb7.ts.net")

    def boom(**kwargs):
        raise RuntimeError("identity repair failed")

    monkeypatch.setattr("plane.research.services.dev_account_prune.repair_identities", boom)
    with pytest.raises(RuntimeError, match="identity repair failed"):
        _command(yes=True)
    assert User.objects.filter(email=EXTRA_EMAIL).exists()
    assert Project.objects.filter(pk=baseline["project"].pk).exists()
    assert OrgUnit.objects.filter(pk=baseline["extra_team"].pk).exists()
    assert ResearchUserProfile.objects.filter(user=baseline["member"]).exists()


def test_missing_keep_user_is_reported_in_dry_run_and_blocks_apply(monkeypatch):
    """缺少保留账号时 dry-run 只列出缺失项，apply 失败且不改库。

    Args:
        monkeypatch: pytest 环境与配置替换器。
    """
    admin = make_user(email=ADMIN_EMAIL, first_name="Admin")
    make_instance_admin(admin)
    make_workspace(admin, name="公共工作区", slug="public")
    make_workspace(admin, name="主PI工作区", slug="pi")
    extra = make_user(email=EXTRA_EMAIL, first_name="方一凯")
    preview = _command()
    assert MAIN_PI_EMAIL in preview["missing_keep_users"]
    assert User.objects.filter(pk=extra.pk).exists()
    monkeypatch.setenv("PLANE_DEV_PRUNE", "1")
    monkeypatch.setattr("django.conf.settings.WEB_URL", "https://fangyikai-pc.tail1b4cb7.ts.net")
    with pytest.raises(CommandError, match="缺少必须保留的账号"):
        _command(yes=True)
    assert User.objects.filter(pk=extra.pk).exists()
