"""行政系统默认视图的全员布局契约。"""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from plane.db.models import (
    WorkspaceAdministrativeViewDefault,
    WorkspaceMember,
    WorkspaceResearchSetting,
)
from plane.tests.research_fixtures import add_workspace_member, make_user


pytestmark = [pytest.mark.contract, pytest.mark.django_db]


@pytest.fixture
def env(workspace, create_user):
    """创建行政视图默认布局契约测试所需的工作区客户端。"""
    client = APIClient()
    client.force_authenticate(user=create_user)
    return {"workspace": workspace, "admin": create_user, "client": client}


def endpoint_url(workspace):
    """返回行政视图默认布局接口地址。"""
    return reverse("workspace-administrative-view-default", kwargs={"slug": workspace.slug})


def client_for(user):
    """返回已登录的 API 客户端。"""
    client = APIClient()
    client.force_authenticate(user=user)
    return client


def test_default_layout_is_readable_without_persisting(env):
    """首次读取返回内置默认，不为工作区额外写一条配置。"""
    response = env["client"].get(endpoint_url(env["workspace"]))

    assert response.status_code == status.HTTP_200_OK, response.data
    payload = response.json()
    assert payload["display_filters"]["layout"] == "spreadsheet"
    assert payload["display_filters"]["order_by"] == "-created_at"
    assert payload["display_properties"]["key"] is False
    assert payload["updated_at"] is None
    assert not WorkspaceAdministrativeViewDefault.objects.filter(workspace=env["workspace"]).exists()


@pytest.mark.parametrize("role", [15, 5])
def test_all_workspace_roles_can_read_default_layout(env, role):
    """成员和访客都读取同一套工作区默认布局。"""
    member = make_user(first_name="Member")
    add_workspace_member(env["workspace"], member, role=role)

    response = client_for(member).get(endpoint_url(env["workspace"]))

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["display_filters"]["layout"] == "spreadsheet"


def test_workspace_admin_publishes_layout_for_everyone(env):
    """工作区管理员发布后，所有角色读取同一套配置。"""
    payload = {
        "display_filters": {
            "calendar": {"show_weekends": True, "layout": "week"},
            "group_by": "state",
            "sub_group_by": None,
            "layout": "list",
            "order_by": "-updated_at",
            "show_empty_groups": False,
            "sub_issue": False,
        },
        "display_properties": {"key": True, "state": False, "priority": True},
    }

    response = env["client"].patch(endpoint_url(env["workspace"]), payload, format="json")

    assert response.status_code == status.HTTP_200_OK, response.data
    assert response.json()["display_filters"] == payload["display_filters"]
    assert all(
        response.json()["display_properties"][key] == value for key, value in payload["display_properties"].items()
    )
    assert response.json()["updated_at"] is not None
    saved = WorkspaceAdministrativeViewDefault.objects.get(workspace=env["workspace"])
    assert saved.display_filters == payload["display_filters"]

    member = make_user(first_name="Member")
    add_workspace_member(env["workspace"], member, role=15)
    guest = make_user(first_name="Guest")
    add_workspace_member(env["workspace"], guest, role=5)
    for reader in (member, guest):
        member_response = client_for(reader).get(endpoint_url(env["workspace"]))
        assert member_response.status_code == status.HTTP_200_OK
        assert member_response.json()["display_filters"]["layout"] == "list"
        assert member_response.json()["display_properties"]["state"] is False


@pytest.mark.parametrize("role", [15, 5])
def test_non_admin_cannot_publish_default_layout(env, role):
    """普通成员和访客不能修改全员默认布局。"""
    member = make_user(first_name="Member")
    add_workspace_member(env["workspace"], member, role=role)

    response = client_for(member).patch(
        endpoint_url(env["workspace"]),
        {"display_filters": {"layout": "list"}},
        format="json",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert not WorkspaceAdministrativeViewDefault.objects.filter(workspace=env["workspace"]).exists()


def test_default_layout_remains_admin_only_when_administrative_lock_is_enabled(env):
    """行政配置锁定开启时，全员默认布局仍只由工作区管理员发布。"""
    WorkspaceResearchSetting.objects.update_or_create(
        workspace=env["workspace"],
        defaults={"administrative_settings_admin_only": True},
    )
    member = make_user(first_name="Locked", last_name="Member")
    add_workspace_member(env["workspace"], member, role=15)

    member_response = client_for(member).patch(
        endpoint_url(env["workspace"]),
        {"display_filters": {"layout": "list"}},
        format="json",
    )
    admin_response = env["client"].patch(
        endpoint_url(env["workspace"]),
        {"display_filters": {"layout": "list"}},
        format="json",
    )

    assert member_response.status_code == status.HTTP_403_FORBIDDEN
    assert admin_response.status_code == status.HTTP_200_OK, admin_response.data
    assert admin_response.json()["display_filters"]["layout"] == "list"


def test_invalid_default_layout_payload_is_rejected(env):
    """未知字段、未知布局和错误类型都不能写入服务端。"""
    cases = [
        {"display_filters": {}, "display_properties": {}, "updated_at": "2026-10-28"},
        {"display_filters": {"layout": "board"}, "display_properties": {}},
        {"display_filters": {"layout": 1}, "display_properties": {}},
        {"display_filters": {"unknown": True}, "display_properties": {}},
        {"display_filters": {"sub_issue": "false"}, "display_properties": {}},
        {"display_filters": {}, "display_properties": {"unknown": True}},
        {"display_filters": {}, "display_properties": {"key": "true"}},
    ]

    for payload in cases:
        response = env["client"].patch(endpoint_url(env["workspace"]), payload, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST, payload
        assert not WorkspaceAdministrativeViewDefault.objects.filter(workspace=env["workspace"]).exists()


def test_workspace_membership_is_required(env):
    """非工作区成员不能读取工作区默认布局。"""
    outsider = make_user(first_name="Outsider")

    response = client_for(outsider).get(endpoint_url(env["workspace"]))

    assert response.status_code == status.HTTP_403_FORBIDDEN
    assert not WorkspaceMember.objects.filter(workspace=env["workspace"], member=outsider).exists()
