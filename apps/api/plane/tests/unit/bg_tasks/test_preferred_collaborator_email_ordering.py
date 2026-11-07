"""高频合作者邮件动态优先展示的排序契约。"""

from uuid import uuid4

import pytest

from plane.bgtasks.email_notification_task import (
    _issue_change_rows,
    _order_by_preferred_collaborators,
    _preferred_collaborator_rank_map,
    create_payload,
)
from plane.db.models import Profile, User


def _actor(index):
    """创建用于排序测试的普通成员。"""
    return User.objects.create(
        email=f"collaborator-{index}-{uuid4().hex[:6]}@example.com",
        username=f"collaborator-{index}-{uuid4().hex[:6]}",
        first_name=f"合作者{index}",
        last_name="测试",
    )


def _configure(receiver, collaborator_ids):
    """为接收人写入高频合作者配置。"""
    Profile.objects.update_or_create(user=receiver, defaults={"preferred_collaborators": collaborator_ids})


@pytest.mark.django_db
def test_rank_map_follows_configured_order(workspace, create_user):
    """配置顺序即优先级顺序，第一位 rank 为 0。"""
    first, second = _actor(1), _actor(2)
    _configure(create_user, [str(second.id), str(first.id)])

    rank_map = _preferred_collaborator_rank_map(create_user.id)

    assert rank_map == {str(second.id): 0, str(first.id): 1}


@pytest.mark.django_db
def test_rank_map_is_empty_without_configuration(workspace, create_user):
    """未配置时返回空映射，不参与排序。"""
    assert _preferred_collaborator_rank_map(create_user.id) == {}


@pytest.mark.django_db
def test_hit_collaborators_are_pinned_before_others_stably(workspace, create_user):
    """命中合作者按配置顺序置顶，其余保持原始顺序。"""
    first, second, other_a, other_b = _actor(1), _actor(2), _actor(3), _actor(4)
    _configure(create_user, [str(second.id), str(first.id)])

    actors = [str(other_a.id), str(first.id), str(other_b.id), str(second.id)]
    ordered = _order_by_preferred_collaborators(
        actors,
        lambda actor_id: actor_id,
        create_user.id,
    )

    assert ordered == [str(second.id), str(first.id), str(other_a.id), str(other_b.id)]


@pytest.mark.django_db
def test_unconfigured_receiver_keeps_original_order(workspace, create_user):
    """未配置接收人时列表原样返回。"""
    actors = [str(_actor(1).id), str(_actor(2).id)]

    ordered = _order_by_preferred_collaborators(actors, lambda actor_id: actor_id, create_user.id)

    assert ordered == actors


@pytest.mark.django_db
def test_issue_change_rows_render_preferred_collaborator_first(workspace, create_user):
    """邮件动态行中命中合作者的条目排在最前。"""
    preferred, regular_a, regular_b = _actor(1), _actor(2), _actor(3)
    _configure(create_user, [str(preferred.id)])
    notification_data = {
        str(regular_a.id): [
            {
                "issue_activity": {
                    "field": "name",
                    "old_value": "旧名称",
                    "new_value": "新名称",
                    "activity_time": "2026-11-07T10:00:00+00:00",
                }
            }
        ],
        str(preferred.id): [
            {
                "issue_activity": {
                    "field": "state",
                    "old_value": "进行中",
                    "new_value": "已完成",
                    "activity_time": "2026-11-07T10:01:00+00:00",
                }
            }
        ],
        str(regular_b.id): [
            {
                "issue_activity": {
                    "field": "priority",
                    "old_value": "低",
                    "new_value": "高",
                    "activity_time": "2026-11-07T10:02:00+00:00",
                }
            }
        ],
    }

    data = create_payload(notification_data)
    data = dict(_order_by_preferred_collaborators(data.items(), lambda pair: pair[0], create_user.id))
    rows = _issue_change_rows(data)

    assert [row["actor_name"] for row in rows] == [
        preferred.display_name,
        regular_a.display_name,
        regular_b.display_name,
    ]


@pytest.mark.django_db
def test_system_actor_stays_in_unmatched_group(workspace, create_user):
    """系统操作者（无 triggered_by）归入未命中组且保持原序。"""
    preferred, regular = _actor(1), _actor(2)
    _configure(create_user, [str(preferred.id)])
    events = [
        {"triggered_by_id": regular.id},
        {"triggered_by_id": None},
        {"triggered_by_id": preferred.id},
    ]

    ordered = _order_by_preferred_collaborators(
        events,
        lambda event: str(event["triggered_by_id"]),
        create_user.id,
    )

    assert [event["triggered_by_id"] for event in ordered] == [preferred.id, regular.id, None]
