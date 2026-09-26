"""Tests for the locked π-Lab roster parser and instance baseline rebuild."""

from pathlib import Path

import pytest

from plane.db.models import (
    MentorBinding,
    OrgUnit,
    OrgUnitMember,
    Project,
    ResearchChain,
    ResearchKnowledgeRequest,
    ResearchProjectProfile,
    ResearchUserProfile,
    User,
    UserImportAccountSource,
    UserImportRow,
    WorkspaceResearchSetting,
)
from plane.research.services import pi_lab_baseline as service
from plane.research.utils.audit import ResearchAuditAction, ResearchResourceType, record_audit_event
from plane.tests.research_fixtures import make_user, pi_workspace, public_workspace

pytestmark = pytest.mark.unit

STUDENT_CSV = (
    "姓名,学号,邮件,电话,年级,人员类别,业务方向,小组,主导师,联合导师1,联合导师2\n"
    "学生甲,A001,student-a@example.com,13800000001,26,MS,基础研究,电池,洪文晶,其他导师,\n"
    "学生乙,0,student-b@example.com,13800000002,26,MS,基础研究,器件,缺失导师,,联合缺失\n"
    "小白鼠,T001,test-mouse@example.com,13800000003,00,kg,产业化,测试,测试组,,\n"
)
ADVISOR_CSV = "导师姓名,邮箱\n洪文晶,hong@example.com\n其他导师,other@example.com\n测试组,test@example.com\n"


@pytest.fixture
def small_team_map(monkeypatch):
    """Reduce the production team map to a synthetic three-team fixture."""
    mapping = {
        "电池": OrgUnit.BusinessCategory.BASIC_RESEARCH,
        "器件": OrgUnit.BusinessCategory.BASIC_RESEARCH,
        "测试": OrgUnit.BusinessCategory.INDUSTRIALIZATION,
    }
    monkeypatch.setattr(service, "TEAM_BUSINESS_CATEGORIES", mapping)
    return mapping


@pytest.fixture
def synthetic_plan(tmp_path, small_team_map):
    """Create a small roster with the same edge cases as the real workbook."""
    students = tmp_path / "students.csv"
    advisors = tmp_path / "advisors.csv"
    students.write_text(STUDENT_CSV, encoding="utf-8")
    advisors.write_text(ADVISOR_CSV, encoding="utf-8")
    expected = service.ExpectedBaseline(
        original_student_rows=3,
        imported_students=2,
        excluded_students=1,
        imported_advisors=2,
        team_count=3,
        primary_relation_gaps=1,
        co_advisor_reference_gaps=1,
        resolved_primary_relations=1,
        invalid_student_no_count=1,
    )
    return service.load_pi_lab_plan(students, advisors, expected=expected)


def test_real_locked_roster_counts_when_source_is_available():
    """Validate the authoritative local workbooks without copying them into CI."""
    parents = Path(__file__).resolve().parents
    roots = [parents[6]] if len(parents) > 6 else []
    roots.append(parents[4])
    sources = [(root / "refer" / "π-Lab学生-导入信息表.xlsx", root / "refer" / "导师信息表.xlsx") for root in roots]
    sources = [pair for pair in sources if pair[0].is_file() and pair[1].is_file()]
    if not sources:
        pytest.skip("authoritative π-Lab workbooks are not available in this test image")
    students_path, advisors_path = sources[0]
    service.verify_pi_lab_source_files(students_path, advisors_path)
    plan = service.load_pi_lab_plan(students_path, advisors_path)
    assert len(plan.students) == 189
    assert len(plan.advisor_mapping) == 14
    assert len(plan.team_directions) == 21
    assert len(plan.primary_relation_gaps) == 37
    assert len(plan.co_advisor_reference_gaps) == 14
    assert sum(bool(item.primary_advisor_email) for item in plan.students) == 152
    assert sum(item.student_no == "" for item in plan.students) == 2
    assert plan.excluded_students == ("小白鼠",)


def test_synthetic_plan_keeps_test_team_but_excludes_test_account(synthetic_plan):
    """The test team remains an organization node while its test row is not imported."""
    assert [item.row.name for item in synthetic_plan.students] == ["学生甲", "学生乙"]
    assert synthetic_plan.excluded_students == ("小白鼠",)
    assert set(synthetic_plan.team_directions) == {"电池", "器件", "测试"}
    assert synthetic_plan.students[1].student_no == ""
    assert synthetic_plan.students[1].primary_advisor_email == ""


def test_rebuild_purges_research_and_creates_unique_main_pi(db, synthetic_plan, small_team_map, tmp_path):
    """Full rebuild clears research payload and restores the frozen identity graph."""
    admin = make_user(email="rebuild-admin@example.com")
    public = public_workspace(admin)
    private = pi_workspace(admin)
    old_project = Project.objects.create(
        workspace=public,
        name="旧科研项目",
        identifier="OLD",
        created_by=admin,
    )
    ResearchProjectProfile.objects.create(
        project=old_project,
        workspace=public,
        owner=admin,
        created_by=admin,
    )
    ResearchChain.objects.create(
        project=old_project,
        workspace=public,
        owner=admin,
        request_id="old-chain",
        payload_hash="0" * 64,
        created_by=admin,
    )
    OrgUnit.objects.create(
        workspace=private,
        name="旧私有组织",
        unit_type=OrgUnit.UnitType.ROOT,
        path="old",
        depth=0,
    )

    record_audit_event(
        workspace=public,
        action=ResearchAuditAction.ORG_UNIT_CREATE,
        resource_type=ResearchResourceType.ORG_UNIT,
        actor=admin,
        metadata={"test": True},
    )
    history_dir = tmp_path / "history"
    exported = service.export_research_history(history_dir)
    assert exported["ResearchAuditEvent"] >= 1
    assert (history_dir / "ResearchAuditEvent.jsonl").is_file()

    service.purge_instance_research_data()
    assert not Project.objects.filter(id=old_project.id).exists()
    assert not ResearchProjectProfile.objects.exists()
    assert not ResearchChain.objects.exists()
    assert not OrgUnit.objects.exists()

    first = service.build_pi_lab_baseline(public, admin, synthetic_plan)
    report = service.verify_pi_lab_baseline(public, synthetic_plan)
    assert first.users_created == 4
    assert report["org_units"] == 4
    assert report["students"] == 2
    assert report["advisors"] == 2
    assert report["primary_mentor_bindings"] == 1
    assert report["primary_relation_gaps"] == 1
    assert ResearchKnowledgeRequest.objects.count() == 0

    pi_roles = OrgUnitMember.objects.filter(org_role=OrgUnitMember.OrgRole.PI)
    assert pi_roles.count() == 1
    assert pi_roles.get().user.display_name == "洪文晶"
    assert UserImportRow.objects.filter(primary_advisor_email="").count() == 1
    assert ResearchUserProfile.objects.filter(category="STUDENT", student_no="").count() == 1
    assert WorkspaceResearchSetting.objects.get(workspace=public).main_pi.display_name == "洪文晶"
    assert WorkspaceResearchSetting.objects.get(workspace=private).main_pi.display_name == "洪文晶"
    assert UserImportRow.objects.exclude(initial_password="").count() == 2
    assert UserImportAccountSource.objects.filter(kind="ROSTER").exclude(initial_password="").count() == 2
    assert UserImportAccountSource.objects.filter(kind="ADVISOR").exclude(initial_password="").count() == 2
    for source in UserImportAccountSource.objects.select_related("user"):
        assert source.user.check_password(source.initial_password)
        assert source.user.is_password_reset_required is True
    password_hashes = dict(User.objects.values_list("email", "password"))

    service.purge_instance_research_data()
    second = service.build_pi_lab_baseline(public, admin, synthetic_plan)
    service.verify_pi_lab_baseline(public, synthetic_plan)
    assert second.users_created == 0
    assert OrgUnit.objects.count() == 4
    assert OrgUnitMember.objects.filter(org_role=OrgUnitMember.OrgRole.PI).count() == 1
    assert MentorBinding.objects.filter(is_primary_advisor=True).count() == 1
    assert UserImportRow.objects.count() == 2
    assert not UserImportRow.objects.exclude(initial_password="").exists()
    assert dict(User.objects.values_list("email", "password")) == password_hashes


def test_write_credential_manifest_is_protected_and_atomic(db, tmp_path, synthetic_plan):
    """Credentials use create-only semantics and mode 0600."""
    service.purge_instance_research_data()
    admin = make_user(email="credential-admin@example.com")
    public = public_workspace(admin)
    pi_workspace(admin)
    result = service.build_pi_lab_baseline(public, admin, synthetic_plan)
    path = tmp_path / "credentials.json"
    service.write_credential_manifest(path, result.credentials)
    assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(FileExistsError):
        service.write_credential_manifest(path, result.credentials)
