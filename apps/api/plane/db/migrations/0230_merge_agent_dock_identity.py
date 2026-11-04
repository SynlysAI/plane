# Copyright (c) 2023-present Plane Software, Inc. contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""合并 Agent Dock 个人身份绑定与通知投递两条迁移链。"""

from django.db import migrations


class Migration(migrations.Migration):
    """收敛 0222 个人身份绑定链与 0229 通知投递链的两个叶子节点。"""

    dependencies = [
        ("db", "0222_remove_researchagentidentitybinding_rsch_agent_ident_uq_plane_and_more"),
        ("db", "0229_merge_agent_dock_notification_delivery"),
    ]

    operations = []
