"""Task discussion CRUD, ACL, HTML validation and retry behaviour."""

from uuid import uuid4

import pytest

from plane.db.models import ResearchAuditEvent, ResearchTaskComment, ResearchChainNodeTask
from plane.tests.contract.app.test_research_chain_tasks import _create, _url, _client
from plane.tests.research_fixtures import make_research_boundary_fixture

pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(settings):
    settings.RESEARCH_MODULE_ENABLED = True
    fixture = make_research_boundary_fixture()
    fixture.update({"student_client": _client(fixture["student"]), "advisor_client": _client(fixture["advisor"])})
    return fixture


def test_comments_reject_a_reader_outside_private_chain_and_wrong_workspace(env):
    task = _create(env)
    comment = post_comment(env, task).data
    env["project_profile"].chain_visibility = "PRIVATE"
    env["project_profile"].save(update_fields=["chain_visibility"])
    env["chain"].visibility = "PRIVATE"
    env["chain"].save(update_fields=["visibility"])
    env["cross_org_project_member"].is_active = False
    env["cross_org_project_member"].save(update_fields=["is_active"])
    outsider = _client(env["cross_org"])
    url = comments_url(env, task["id"])
    assert outsider.get(url).status_code == 404
    assert (
        outsider.post(url, {"comment_html": "<p>Outside</p>", "request_id": uuid4().hex}, format="json").status_code
        == 404
    )
    wrong_workspace = url.replace(env["workspace"].slug, "unknown-workspace")
    assert env["student_client"].get(wrong_workspace).status_code == 404
    assert outsider.delete(url + str(comment["id"]) + "/").status_code == 404


def comments_url(env, task_id):
    return _url(env, task_id) + "comments/"


def post_comment(env, task, client=None, **overrides):
    payload = {"comment_html": "<p>请补充实验数据。</p>", "request_id": uuid4().hex}
    payload.update(overrides)
    return (client or env["student_client"]).post(comments_url(env, task["id"]), payload, format="json")


def test_comments_survive_reload_without_overwriting_task_description(env):
    task = _create(env)
    response = post_comment(env, task)
    assert response.status_code == 201, response.data
    created = response.data
    assert str(created["actor"]) == str(env["student"].pk)
    assert created["can_edit"] and created["can_delete"]
    payload = env["student_client"].get(comments_url(env, task["id"])).data
    assert payload["can_comment"] is True
    assert payload["results"][0]["comment_stripped"] == "请补充实验数据。"
    assert ResearchChainNodeTask.objects.get(pk=task["id"]).instruction == task["instruction"]

    detail = comments_url(env, task["id"]) + created["id"] + "/"
    edited = env["student_client"].patch(detail, {"comment_html": "<p><strong>已补充</strong>数据</p>"}, format="json")
    assert edited.status_code == 200
    assert edited.data["edited_at"]
    assert edited.data["comment_stripped"] == "已补充数据"
    assert env["student_client"].delete(detail).status_code == 204
    assert env["student_client"].get(comments_url(env, task["id"])).data["results"] == []
    assert ResearchTaskComment.all_objects.filter(pk=created["id"], deleted_at__isnull=False).exists()
    actions = set(ResearchAuditEvent.objects.filter(resource_id=task["id"]).values_list("action", flat=True))
    assert {"task.comment.create", "task.comment.update", "task.comment.delete"} <= actions


def test_task_reader_can_comment_but_cannot_change_another_authors_comment(env):
    task = _create(env)
    own = post_comment(env, task)
    reader = env["advisor_client"]
    posted = post_comment(env, task, client=reader)
    assert posted.status_code == 201, posted.data
    assert str(posted.data["actor"]) == str(env["advisor"].pk)
    payload = reader.get(comments_url(env, task["id"])).data
    author_comment = next(item for item in payload["results"] if item["id"] == own.data["id"])
    assert author_comment["can_edit"] is False
    assert author_comment["can_delete"] is False
    detail = comments_url(env, task["id"]) + own.data["id"] + "/"
    assert reader.patch(detail, {"comment_html": "<p>Changed</p>"}, format="json").status_code == 403
    assert reader.delete(detail).status_code == 403


@pytest.mark.parametrize("status", ["ARCHIVED", "DELETED", "COMPLETED"])
def test_comment_id_is_scoped_to_its_task_and_inactive_chain_is_read_only(env, status):
    first = _create(env)
    second = _create(env)
    comment = post_comment(env, first).data
    other_url = comments_url(env, second["id"]) + comment["id"] + "/"
    assert env["student_client"].patch(other_url, {"comment_html": "<p>Changed</p>"}, format="json").status_code == 404
    assert env["student_client"].delete(other_url).status_code == 404
    env["chain"].status = status
    env["chain"].save(update_fields=["status"])
    payload = env["student_client"].get(comments_url(env, first["id"])).data
    assert payload["can_comment"] is False
    assert payload["results"][0]["can_edit"] is False
    assert post_comment(env, first).status_code == 409


@pytest.mark.parametrize(
    "html", ["", "<p><br></p>", "<p>&nbsp;</p>", "<script>alert(1)</script>", "<img src='https://example.com/a.png'>"]
)
def test_empty_or_unsupported_comment_is_rejected(env, html):
    task = _create(env)
    assert post_comment(env, task, comment_html=html).status_code == 400
    assert ResearchTaskComment.objects.count() == 0


def test_rich_text_is_sanitized_and_same_request_is_not_posted_twice(env):
    task = _create(env)
    request_id = uuid4().hex
    html = '<p onclick="alert(1)"><strong>结果</strong><script>alert(1)</script></p>'
    first = post_comment(env, task, request_id=request_id, comment_html=html)
    assert first.status_code == 201
    assert "onclick" not in first.data["comment_html"]
    assert "script" not in first.data["comment_html"]
    retry = post_comment(env, task, request_id=request_id, comment_html=html)
    assert retry.status_code == 200
    assert retry.data["id"] == first.data["id"]
    assert ResearchTaskComment.objects.count() == 1
    assert post_comment(env, task, request_id=request_id).status_code == 409
