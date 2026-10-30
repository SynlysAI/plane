"""Targeted notifications for the thirteen-stage Research Chain approvals."""

from html import escape

from django.utils import timezone

from plane.db.models import Notification


RESEARCH_CHAIN_STAGE_ENTITY = "research_chain_stage"

STAGE_TITLES = {
    "LITERATURE_REVIEW": "文献调研",
    "TOPIC_SELECTION": "选题",
    "TOPIC_EVALUATION": "选题评估",
    "PRE_EXPERIMENT": "预实验",
    "ANALYSIS_PRE_EXPERIMENT": "预实验分析",
    "OPENING": "开题",
    "EXPERIMENT": "实验",
    "ANALYSIS_EXPERIMENT": "实验分析",
    "ITERATION": "迭代",
    "SUMMARY": "总结",
    "PAPER_WRITING": "论文写作",
    "COMPLETION": "结题",
    "TRANSFER": "转化",
}


def _stage_href(stage):
    """Build the server-relative deep link for one stage notification."""
    return (
        f"/{stage.workspace.slug}/research/chains/{stage.chain_id}"
        f"?tab=nodes&stage={stage.stage_code.lower()}&approval=1"
    )


def _notify(stage, receivers, actor, *, title, action):
    """Create one in-app notification for each non-triggering receiver.

    Args:
        stage: Research Chain stage whose lifecycle changed.
        receivers: Users that should see the notification.
        actor: User who triggered the lifecycle change.
        title: Localized notification title.
        action: Stable notification action for rendering.

    Returns:
        The created notification rows.
    """
    rows = []
    display_title = f"{title}：{STAGE_TITLES.get(stage.stage_code, stage.stage_code)}"
    for receiver in receivers:
        if receiver is None or receiver.id == actor.id:
            continue
        rows.append(
            Notification(
                workspace=stage.workspace,
                project_id=stage.chain.project_id,
                entity_identifier=stage.id,
                entity_name=RESEARCH_CHAIN_STAGE_ENTITY,
                title=display_title,
                message={"action": action, "status": stage.status, "at": timezone.now().isoformat()},
                message_html=f"<p>{escape(display_title)}</p>",
                message_stripped=display_title,
                sender="research",
                triggered_by=actor,
                receiver=receiver,
                data={
                    "chain_id": str(stage.chain_id),
                    "chain_name": stage.chain.project.name,
                    "stage_id": str(stage.id),
                    "stage_code": stage.stage_code,
                    "stage_name": STAGE_TITLES.get(stage.stage_code, stage.stage_code),
                    "status": stage.status,
                    "action": action,
                    "href": _stage_href(stage),
                },
            )
        )
    if rows:
        Notification.objects.bulk_create(rows, batch_size=100)
    return rows


def notify_chain_stage_submitted(stage, advisor, actor):
    """Notify the direct advisor that a stage is awaiting review."""
    return _notify(stage, [advisor], actor, title="科研链阶段已提交，等待导师审核", action="submitted")


def notify_chain_stage_escalated(stage, principal, actor):
    """Notify the principal investigator that an advisor escalated a stage."""
    return _notify(stage, [principal], actor, title="科研链阶段已转主 PI 审核", action="escalated")


def notify_chain_stage_decided(stage, owner, actor, action):
    """Notify the research owner about a final approval or return."""
    title = "科研链阶段已通过" if action == "approved" else "科研链阶段已退回"
    return _notify(stage, [owner], actor, title=title, action=action)
