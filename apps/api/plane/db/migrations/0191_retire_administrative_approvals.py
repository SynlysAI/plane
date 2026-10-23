import json
import os
from datetime import datetime, timezone
from pathlib import Path

from django.conf import settings
from django.db import migrations


SYSTEM_CANCEL_COMMENT = "行政审批链路已下线：存量审批自动关闭，请通过工作项负责人直接推进。"


def _archive_path():
    """解析审批历史归档文件输出路径。

    Returns:
        归档 JSONL 文件的绝对路径；优先读取 PLANE_ADMIN_APPROVAL_ARCHIVE。
    """
    configured = os.environ.get("PLANE_ADMIN_APPROVAL_ARCHIVE")
    if configured:
        return Path(configured)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path(settings.BASE_DIR) / "backups" / f"administrative-approvals-{timestamp}.jsonl"


def _serialize_value(value):
    """把模型字段值转换为可 JSON 序列化的基础类型。

    Args:
        value: 模型字段的原始取值。

    Returns:
        JSON 兼容值；UUID 使用带连字符的标准字符串。
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _dump_model(archive, label, queryset):
    """按具体字段全量导出单个审批模型的数据行。

    Args:
        archive: 已打开的 JSONL 文件对象。
        label: 归档记录中的模型标识。
        queryset: 待导出的历史模型查询集，已按稳定字段排序。
    """
    for row in queryset.iterator():
        fields = {
            field.attname: _serialize_value(getattr(row, field.attname))
            for field in row._meta.concrete_fields
        }
        archive.write(json.dumps({"model": label, "fields": fields}, ensure_ascii=False, sort_keys=True) + "\n")


def _archive_administrative_approvals(apps):
    """把行政审批全量历史（含软删除行）写入 JSONL 归档文件。

    Args:
        apps: 迁移提供的 historical 模型注册器。
    """
    flow_model = apps.get_model("db", "AdministrativeApprovalFlow")
    step_model = apps.get_model("db", "AdministrativeApprovalStep")
    setting_model = apps.get_model("db", "AdministrativeProjectApprovalSetting")
    request_model = apps.get_model("db", "AdministrativeApprovalRequest")
    action_model = apps.get_model("db", "AdministrativeApprovalAction")

    target = _archive_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as archive:
        _dump_model(
            archive,
            "administrative_approval_flow",
            flow_model.objects.all().order_by("created_at", "id"),
        )
        _dump_model(
            archive,
            "administrative_approval_step",
            step_model.objects.all().order_by("flow_id", "order"),
        )
        _dump_model(
            archive,
            "administrative_project_approval_setting",
            setting_model.objects.all().order_by("created_at", "id"),
        )
        _dump_model(
            archive,
            "administrative_approval_request",
            request_model.objects.all().order_by("created_at", "id"),
        )
        _dump_model(
            archive,
            "administrative_approval_action",
            action_model.objects.all().order_by("created_at", "id"),
        )


def _close_pending_requests(apps):
    """关闭仍处于审批中的历史请求并补写系统关闭记录。

    Args:
        apps: 迁移提供的 historical 模型注册器。
    """
    workspace_member_model = apps.get_model("db", "WorkspaceMember")
    request_model = apps.get_model("db", "AdministrativeApprovalRequest")
    action_model = apps.get_model("db", "AdministrativeApprovalAction")

    admin_cache = {}
    pending_requests = request_model.objects.filter(status="PENDING")
    for request in pending_requests:
        workspace_id = request.workspace_id
        if workspace_id not in admin_cache:
            admin_member = (
                workspace_member_model.objects.filter(
                    workspace_id=workspace_id,
                    is_active=True,
                    deleted_at__isnull=True,
                    role=20,
                )
                .order_by("created_at", "id")
                .first()
            )
            admin_cache[workspace_id] = admin_member.member_id if admin_member else None
        actor_id = admin_cache[workspace_id] or request.requested_by_id
        request.status = "CANCELLED"
        request.save(update_fields=["status", "updated_at"])
        action_model.objects.create(
            request_id=request.id,
            actor_id=actor_id,
            step_order=request.current_step_order,
            action="CANCEL",
            comment=SYSTEM_CANCEL_COMMENT,
        )


def retire_administrative_approvals(apps, schema_editor):
    """归档并删除行政审批历史数据。

    先把存量审批中请求自动关闭，再把含系统关闭动作的全量历史写入
    JSONL 归档文件，最后由同迁移的 DeleteModel 操作删除相关数据表。
    """
    _close_pending_requests(apps)
    _archive_administrative_approvals(apps)


class Migration(migrations.Migration):
    dependencies = [
        ("db", "0190_retire_administrative_approval_flow_templates"),
    ]

    operations = [
        migrations.RunPython(retire_administrative_approvals, migrations.RunPython.noop),
        migrations.DeleteModel(name="AdministrativeProjectApprovalSetting"),
        migrations.DeleteModel(name="AdministrativeApprovalAction"),
        migrations.DeleteModel(name="AdministrativeApprovalRequest"),
        migrations.DeleteModel(name="AdministrativeApprovalStep"),
        migrations.DeleteModel(name="AdministrativeApprovalFlow"),
    ]
