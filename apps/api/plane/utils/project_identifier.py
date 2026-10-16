"""项目短编号的共享生成工具。"""

import re
import secrets

from plane.db.models import Project, ProjectIdentifier


def identifier_from(name):
    """从项目名称派生 ASCII 短编号；无可派生字符时返回空串。

    Args:
        name: 项目名称或用户显式提供的编号。

    Returns:
        仅保留字母数字并转大写后的前 8 个字符。
    """
    letters = re.sub(r"[^A-Za-z0-9]", "", name or "").upper()
    return letters[:8]


def random_identifier():
    """生成 PRJ 前缀的随机短编号。

    Returns:
        形如 ``PRJ3F9A2C`` 的 9 位编号，满足项目编号 12 位上限。
    """
    return f"PRJ{secrets.token_hex(3).upper()}"


def identifier_reserved(workspace, candidate):
    """判断候选编号是否已被项目或编号表占用。

    两张表可能漂移（改编号只更新项目行），需同时检查，否则编号表插入会违反唯一约束。

    Args:
        workspace: 工作区实例。
        candidate: 候选编号。

    Returns:
        候选编号已被占用时为 True。
    """
    return (
        Project.objects.filter(workspace=workspace, identifier=candidate, deleted_at__isnull=True).exists()
        or ProjectIdentifier.objects.filter(workspace=workspace, name=candidate, deleted_at__isnull=True).exists()
    )


def unique_identifier(workspace, base):
    """返回在项目表与编号表中均未占用的编号。

    Args:
        workspace: 工作区实例。
        base: 期望的基础编号；为空时直接使用随机编号。

    Returns:
        未被占用的项目编号。
    """
    if not base:
        # 非纯 ASCII 名称无字符可派生；共享固定前缀会全域冲突，因此抽取随机短编号。
        while True:
            candidate = random_identifier()
            if not identifier_reserved(workspace, candidate):
                return candidate
    candidate = base
    suffix = 0
    while identifier_reserved(workspace, candidate):
        suffix += 1
        candidate = f"{base[:6]}{suffix}"[:12]
    return candidate
