"""待办依赖模型在写事务提交后使整个工作区的投影缓存失效。"""

from django.apps import apps
from django.db.models.signals import post_delete, post_save, pre_delete, pre_save

from plane.utils.workspace_todos_cache import (
    invalidate_todo_workspaces,
    todo_fields_affect_projection,
    todo_workspace_path,
)


def _workspace_ids(sender, instance, using):
    """解析模型当前归属，包括无直接工作区外键的子记录。

    Args:
        sender: 写入涉及的模型类。
        instance: 当前模型实例。
        using: 业务数据库别名。

    Returns:
        当前归属的工作区 ID 集合。
    """
    path = todo_workspace_path(sender)
    if "__" not in path:
        return {getattr(instance, path)}
    return set(sender._base_manager.using(using).filter(pk=instance.pk).values_list(path, flat=True))


def remember_todo_workspaces(sender, instance, using, update_fields=None, **kwargs):
    """在删除或关联变化前记录原归属，保证旧工作区同样失效。

    Args:
        sender: 写入涉及的模型类。
        instance: 当前模型实例。
        using: 业务数据库别名。
        update_fields: 保存时指定的字段列表。
        **kwargs: Django 信号的其他参数。
    """
    if instance._state.adding or not todo_fields_affect_projection(sender, update_fields):
        return
    path = todo_workspace_path(sender)
    relation = path.split("__", 1)[0].removesuffix("_id")
    if update_fields is not None and not {relation, f"{relation}_id"}.intersection(update_fields):
        return
    instance._todo_previous_workspace_ids = set(
        sender._base_manager.using(using).filter(pk=instance.pk).values_list(path, flat=True)
    )


def invalidate_workspace_todo_projection(sender, instance, using, update_fields=None, **kwargs):
    """相关记录保存后失效当前及原工作区。

    Args:
        sender: 写入涉及的模型类。
        instance: 已保存的模型实例。
        using: 业务数据库别名。
        update_fields: 保存时指定的字段列表。
        **kwargs: Django 信号的其他参数。
    """
    if not todo_fields_affect_projection(sender, update_fields):
        return
    workspace_ids = _workspace_ids(sender, instance, using)
    workspace_ids.update(getattr(instance, "_todo_previous_workspace_ids", ()))
    invalidate_todo_workspaces(workspace_ids, model=sender, using=using)
    instance.__dict__.pop("_todo_previous_workspace_ids", None)


def invalidate_deleted_todo_projection(sender, instance, using, **kwargs):
    """按删除前归属失效，避免级联删除后回查不存在的父记录。

    Args:
        sender: 删除涉及的模型类。
        instance: 已删除的模型实例。
        using: 业务数据库别名。
        **kwargs: Django 信号的其他参数。
    """
    invalidate_todo_workspaces(getattr(instance, "_todo_previous_workspace_ids", ()), model=sender, using=using)


for todo_model in apps.get_models():
    if todo_workspace_path(todo_model) is None:
        continue
    for signal, receiver in (
        (pre_save, remember_todo_workspaces),
        (pre_delete, remember_todo_workspaces),
        (post_save, invalidate_workspace_todo_projection),
        (post_delete, invalidate_deleted_todo_projection),
    ):
        signal.connect(
            receiver,
            sender=todo_model,
            dispatch_uid=f"workspace_todos_{receiver.__name__}_{id(signal)}_{todo_model._meta.label_lower}",
        )
