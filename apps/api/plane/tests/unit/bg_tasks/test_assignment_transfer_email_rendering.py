"""Assignment email rendering and transfer-candidate presentation contracts."""

from datetime import timedelta
from uuid import uuid4

from bs4 import BeautifulSoup
from django.template.loader import render_to_string
from django.utils import timezone

import pytest

from plane.bgtasks.email_notification_task import (
    audit_email_image_resources,
    send_research_notification_email,
)
from plane.db.models import (
    Issue,
    NotificationEmailDelivery,
    NotificationEvent,
    Profile,
    Project,
    ProjectMember,
    ResearchChainNodeTask,
    User,
    WorkspaceMember,
)
from plane.tests.research_fixtures import make_research_boundary_fixture
from plane.utils.assignment_transfer import assignment_transfer_email_context


def _user(workspace, index, project):
    user = User.objects.create(
        email=f"candidate-{index}-{uuid4().hex[:6]}@example.com",
        username=f"candidate-{index}-{uuid4().hex[:6]}",
        first_name=f"候选{index:02d}",
        last_name="成员",
    )
    WorkspaceMember.objects.create(workspace=workspace, member=user, role=15)
    ProjectMember.objects.create(workspace=workspace, project=project, member=user, role=15)
    return user


@pytest.mark.django_db
def test_assignment_email_candidates_are_sorted_capped_and_explain_overflow(workspace, create_user):
    project = Project.objects.create(
        name="候选人截断项目",
        identifier=f"CT{uuid4().hex[:3]}",
        workspace=workspace,
        created_by=create_user,
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    owner = _user(workspace, 0, project)
    owner.display_name = "当前负责人"
    owner.save(update_fields=["display_name"])
    candidates = [_user(workspace, index, project) for index in range(1, 11)]
    issue = Issue.objects.create(
        name="候选人截断工作项",
        project=project,
        workspace=workspace,
        created_by=create_user,
    )
    issue.issue_assignee.create(
        workspace=workspace,
        project=project,
        issue=issue,
        assignee=owner,
    )

    context = assignment_transfer_email_context("issue", issue, owner, "https://plane.example")

    assert [item["display_name"] for item in context["candidates"]] == [
        user.display_name for user in sorted(candidates, key=lambda user: user.display_name)[:8]
    ]
    assert context["has_more_candidates"] is True
    assert context["native_url"].endswith("email_transfer=1")
    assert all("/email-actions/assignment-transfer/" in item["url"] for item in context["candidates"])


@pytest.mark.django_db
def test_assignment_email_pins_preferred_collaborators_before_candidate_cap(workspace, create_user):
    """高频合作者应在候选人截断前置顶，保证进入邮件展示的前八位。"""
    project = Project.objects.create(
        name="合作者优先项目",
        identifier=f"PC{uuid4().hex[:3]}",
        workspace=workspace,
        created_by=create_user,
    )
    ProjectMember.objects.create(workspace=workspace, project=project, member=create_user, role=20)
    owner = _user(workspace, 0, project)
    owner.display_name = "当前负责人"
    owner.save(update_fields=["display_name"])
    # 名字按字母序排前八的普通候选人。
    for index in range(1, 9):
        _user(workspace, index, project)
    # 配置的合作者名字按字母序会落在前八之外。
    preferred_a = _user(workspace, 9, project)
    preferred_a.first_name = "周合作者甲"
    preferred_a.save(update_fields=["first_name"])
    preferred_b = _user(workspace, 10, project)
    preferred_b.first_name = "郑合作者乙"
    preferred_b.save(update_fields=["first_name"])
    Profile.objects.update_or_create(
        user=owner,
        defaults={"preferred_collaborators": [str(preferred_a.id), str(preferred_b.id)]},
    )
    issue = Issue.objects.create(
        name="合作者优先工作项",
        project=project,
        workspace=workspace,
        created_by=create_user,
    )
    issue.issue_assignee.create(
        workspace=workspace,
        project=project,
        issue=issue,
        assignee=owner,
    )

    context = assignment_transfer_email_context("issue", issue, owner, "https://plane.example")

    display_names = [item["display_name"] for item in context["candidates"]]
    assert display_names[:2] == [preferred_a.display_name, preferred_b.display_name]
    remaining = display_names[2:]
    assert remaining == sorted(remaining)
    assert len(remaining) == 6
    assert context["has_more_candidates"] is True


@pytest.mark.django_db
@pytest.mark.parametrize("entity_type", ["行政工作项", "科研工作项"])
def test_shared_template_keeps_button_links_and_separate_plain_text(entity_type):
    """HTML 只显示操作按钮，纯文本版本仍保留可使用的完整地址。"""
    context = {
        "heading": "科研工作项通知",
        "item_identifier": "RB123",
        "item_title": "JACS 审稿意见回复",
        "summary": "以下科研工作项有新的动态：",
        "actor_summary": "负责同学",
        "change_rows": [
            {
                "actor_name": "负责同学",
                "activity_time": "11-05 10:30",
                "field_label": "负责人",
                "old_value": "",
                "new_value": "负责同学",
            }
        ],
        "comments": [],
        "receiver": {"email": "receiver@example.com"},
        "current_site": "https://plane.example",
        "issue_url": "https://plane.example/work/research",
        "project_url": "https://plane.example/work",
        "workspace": "work",
        "project": "科研项目",
        "user_preference": "https://plane.example/settings",
        "entity_type": entity_type,
        "assignment_transfer": {
            "enabled": True,
            "candidates": [
                {
                    "display_name": "下一位负责人",
                    "url": "https://plane.example/email-actions/assignment-transfer/?token=signed&candidate=next",
                }
            ],
            "has_more_candidates": False,
            "native_url": "https://plane.example/work/item",
        },
    }
    html = render_to_string("emails/notifications/issue-updates.html", context)
    plain = render_to_string("emails/notifications/issue-updates.txt", context)
    soup = BeautifulSoup(html, "html.parser")

    audit_email_image_resources(html)
    assert "plane-marketing.s3" not in html
    assert "https://plane.example/static/logos/Logo.png" in html
    assert "选择下一位负责人" in html
    assert "转派给 下一位负责人" in html
    candidate_url = context["assignment_transfer"]["candidates"][0]["url"]
    assert soup.find("a", string="转派给 下一位负责人")["href"] == candidate_url
    assert soup.find("a", string=f"查看{entity_type}")["href"] == context["issue_url"]
    assert "https://" not in soup.get_text()
    assert candidate_url in plain
    assert "&amp;" not in plain
    assert "https://plane.example/work/research" in plain
    assert "账户通知设置" in plain


@pytest.mark.django_db
def test_research_assignment_email_uses_shared_standard_template(db, settings, monkeypatch):
    """使用标准模板发送科研指派邮件，兼容不返回状态值的邮件后端。"""
    settings.RESEARCH_MODULE_ENABLED = True
    settings.WEB_URL = "https://plane.example"
    fixture = make_research_boundary_fixture()
    for key in ("group_member", "advisor"):
        ProjectMember.objects.create(project=fixture["project"], member=fixture[key], role=15)
    task = ResearchChainNodeTask.objects.create(
        workspace=fixture["workspace"],
        chain=fixture["chain"],
        node=fixture["paper_node"],
        title="JACS 审稿意见回复",
        status=ResearchChainNodeTask.Status.ASSIGNED,
        assignee=fixture["group_member"],
        assigned_by=fixture["student"],
        request_id=f"render-task-{uuid4().hex}",
        payload_hash=uuid4().hex,
        created_by=fixture["student"],
    )
    event = NotificationEvent.objects.create(
        idempotency_key=f"render-event-{uuid4().hex}",
        workspace=fixture["workspace"],
        project=fixture["project"],
        receiver=fixture["group_member"],
        triggered_by=fixture["student"],
        entity_name="research_chain_task",
        entity_identifier=task.id,
        action="assigned",
        category=NotificationEvent.Category.ASSIGNMENT,
        recipient_reason="direct",
        title="科研节点任务已指派：JACS 审稿意见回复",
        summary=fixture["student"].display_name,
        route=(
            f"/{fixture['workspace'].slug}/research/chains/{fixture['chain'].id}"
            f"?node={fixture['paper_node'].id}&task={task.id}"
        ),
        payload={"task_id": str(task.id), "action": "assigned"},
        immediate=True,
    )
    delivery = NotificationEmailDelivery.objects.create(
        event=event,
        status=NotificationEmailDelivery.Status.PROCESSING,
        available_at=timezone.now(),
        lease_until=timezone.now() + timedelta(minutes=5),
        lease_token="render-lease",
    )
    captured = {}

    class FakeMessage:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def attach_alternative(self, content, mime_type):
            captured["html"] = content
            captured["mime_type"] = mime_type

        def send(self):
            return 1

    class FakeConnection:
        def open(self):
            return None

        def close(self):
            return None

    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task._notification_email_delivery_enabled",
        lambda: True,
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task._claim_smtp_probe",
        lambda: (True, "probe", None),
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task._research_preference_enabled",
        lambda receiver_id, category: True,
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task._research_event_currently_authorized",
        lambda item, receiver: True,
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task.get_email_configuration",
        lambda: ("smtp", "user", "password", "587", "1", "0", "from@example.com"),
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task.get_connection",
        lambda **kwargs: FakeConnection(),
    )
    monkeypatch.setattr(
        "plane.bgtasks.email_notification_task.EmailMultiAlternatives",
        FakeMessage,
    )

    result = send_research_notification_email([delivery.id], "render-lease")

    assert result is True
    html = captured["html"]
    audit_email_image_resources(html)
    assert "科研工作项通知" in html
    assert "JACS 审稿意见回复" in html
    assert "选择下一位负责人" in html
    assert fixture["advisor"].display_name in html
    assert "<ul>" not in html
    assert "https://" not in BeautifulSoup(html, "html.parser").get_text()
    assert "转派给" in captured["body"]
    assert "/email-actions/assignment-transfer/?token=" in captured["body"]
    assert "&candidate=" in captured["body"]
