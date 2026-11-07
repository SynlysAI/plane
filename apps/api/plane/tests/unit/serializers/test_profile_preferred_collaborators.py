"""高频合作者偏好字段的序列化校验契约。"""

from uuid import uuid4

import pytest

from plane.app.serializers.user import ProfileSerializer
from plane.db.models import User


def _member(index, is_active=True):
    """创建用于校验测试的成员。"""
    return User.objects.create(
        email=f"preferred-{index}-{uuid4().hex[:6]}@example.com",
        username=f"preferred-{index}-{uuid4().hex[:6]}",
        first_name=f"成员{index}",
        is_active=is_active,
    )


@pytest.mark.django_db
def test_valid_collaborators_preserve_order(workspace, create_user):
    """三位活跃成员按提交顺序通过校验。"""
    first, second, third = _member(1), _member(2), _member(3)

    serializer = ProfileSerializer(
        data={"preferred_collaborators": [str(first.id), str(second.id), str(third.id)]}
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["preferred_collaborators"] == [
        str(first.id),
        str(second.id),
        str(third.id),
    ]


@pytest.mark.django_db
def test_duplicate_collaborators_are_deduplicated(workspace, create_user):
    """重复成员会被去重并保持首次出现顺序。"""
    first, second = _member(1), _member(2)

    serializer = ProfileSerializer(
        data={"preferred_collaborators": [str(second.id), str(second.id), str(first.id)]}
    )

    assert serializer.is_valid(), serializer.errors
    assert serializer.validated_data["preferred_collaborators"] == [str(second.id), str(first.id)]


@pytest.mark.django_db
def test_more_than_three_collaborators_are_rejected(workspace, create_user):
    """超过三位合作者被拒绝。"""
    members = [_member(index) for index in range(4)]

    serializer = ProfileSerializer(
        data={"preferred_collaborators": [str(member.id) for member in members]}
    )

    assert not serializer.is_valid()
    assert "preferred_collaborators" in serializer.errors


@pytest.mark.django_db
def test_invalid_collaborator_id_is_rejected(workspace, create_user):
    """非法用户标识被拒绝。"""
    serializer = ProfileSerializer(data={"preferred_collaborators": ["not-a-uuid"]})

    assert not serializer.is_valid()
    assert "preferred_collaborators" in serializer.errors


@pytest.mark.django_db
def test_inactive_or_missing_collaborator_is_rejected(workspace, create_user):
    """停用或不存在的成员被拒绝。"""
    inactive = _member(1, is_active=False)

    serializer = ProfileSerializer(data={"preferred_collaborators": [str(inactive.id)]})
    assert not serializer.is_valid()

    serializer = ProfileSerializer(data={"preferred_collaborators": [str(uuid4())]})
    assert not serializer.is_valid()
