"""高频合作者偏好读取与稳定置顶排序的共享工具。"""

from plane.db.models import Profile

MAX_PREFERRED_COLLABORATORS = 3


def preferred_collaborator_rank_map(receiver_id):
    """读取接收人配置的高频合作者并生成优先级映射。

    Args:
        receiver_id: 通知接收人用户 ID。

    Returns:
        以合作者用户 ID 字符串为键、配置顺序（0 为最高）为值的映射；未配置时为空字典。
    """
    profile = Profile.objects.filter(user_id=receiver_id).only("preferred_collaborators").first()
    if profile is None:
        return {}
    collaborators = profile.preferred_collaborators or []
    return {
        str(collaborator_id): rank
        for rank, collaborator_id in enumerate(collaborators[:MAX_PREFERRED_COLLABORATORS])
    }


def order_by_preferred_collaborators(items, actor_key, receiver_id):
    """按接收人配置将命中合作者的条目稳定置顶。

    Args:
        items: 待排序的条目序列。
        actor_key: 从条目中提取人员 ID 字符串的函数。
        receiver_id: 通知接收人用户 ID。

    Returns:
        命中合作者按配置顺序排在最前、其余条目保持原始顺序的新列表；未配置时原样返回。
    """
    priority = preferred_collaborator_rank_map(receiver_id)
    if not priority:
        return items
    return sorted(items, key=lambda item: priority.get(actor_key(item), len(priority)))
