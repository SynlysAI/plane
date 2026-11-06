"""为影响待办的批量写入补足 Django 模型信号未覆盖的失效通知。"""

from django.db import models, router, transaction

from plane.utils.workspace_todos_cache import (
    invalidate_todo_workspaces,
    todo_fields_affect_projection,
    todo_workspace_path,
)


class TodoInvalidationQuerySet(models.QuerySet):
    """保持 QuerySet 行为，仅为待办依赖模型安排提交后失效。"""

    def update(self, **kwargs):
        """批量更新后失效原工作区及关联变更后的工作区。

        Args:
            **kwargs: Django 原生批量更新字段及其值。

        Returns:
            实际更新的记录数量。
        """
        path = todo_workspace_path(self.model)
        if not todo_fields_affect_projection(self.model, kwargs):
            return super().update(**kwargs)
        using = self._db or router.db_for_write(self.model, **self._hints)
        with transaction.atomic(using=using):
            relation = path.split("__", 1)[0].removesuffix("_id")
            relocating = bool({relation, f"{relation}_id", "pk", "id"}.intersection(kwargs))
            if relocating:
                affected = list(self.using(using).order_by().values_list("pk", path))
                workspace_ids = {workspace_id for _, workspace_id in affected}
            else:
                # 状态及软删除更新只需工作区集合，避免为大批任务收集全部主键。
                workspace_ids = set(self.using(using).order_by().values_list(path, flat=True).distinct())
            updated = super().update(**kwargs)
            if updated:
                if relocating:
                    workspace_ids.update(
                        self.model._base_manager.using(using)
                        .filter(pk__in={pk for pk, _ in affected})
                        .order_by()
                        .values_list(path, flat=True)
                    )
                invalidate_todo_workspaces(workspace_ids, model=self.model, using=using)
            return updated

    def bulk_create(
        self,
        objs,
        batch_size=None,
        ignore_conflicts=False,
        update_conflicts=False,
        update_fields=None,
        unique_fields=None,
    ):
        """批量创建后按工作区失效，不改变插入及冲突处理语义。

        Args:
            objs: 需要插入的模型对象。
            batch_size: Django 原生批次大小。
            ignore_conflicts: 是否忽略插入冲突。
            update_conflicts: 是否在插入冲突时更新记录。
            update_fields: 冲突时允许更新的字段。
            unique_fields: 用于定位冲突记录的唯一字段。

        Returns:
            Django 原生批量创建返回的模型对象列表。
        """
        path = todo_workspace_path(self.model)
        options = {
            "batch_size": batch_size,
            "ignore_conflicts": ignore_conflicts,
            "update_conflicts": update_conflicts,
            "update_fields": update_fields,
            "unique_fields": unique_fields,
        }
        if path is None:
            return super().bulk_create(objs, **options)
        objs = list(objs)
        if not objs:
            return super().bulk_create(objs, **options)
        using = self._db or router.db_for_write(self.model, **self._hints)
        with transaction.atomic(using=using):
            affected = self.model._base_manager.using(using)
            matches = models.Q(pk__in=[obj.pk for obj in objs])
            workspace_ids = set()
            if update_conflicts and unique_fields:
                # UUID 主键在按其他唯一键 upsert 后可能仍是输入值，必须按冲突键查真实记录。
                fields = [self.model._meta.get_field(name if name != "pk" else "id") for name in unique_fields]
                matches = models.Q()
                for obj in objs:
                    matches |= models.Q(**{field.attname: getattr(obj, field.attname) for field in fields})
                workspace_ids.update(affected.filter(matches).order_by().values_list(path, flat=True))
            result = super().bulk_create(objs, **options)
            if path == "workspace_id":
                workspace_ids.update(obj.workspace_id for obj in objs)
            else:
                workspace_ids.update(affected.filter(matches).order_by().values_list(path, flat=True))
            invalidate_todo_workspaces(workspace_ids, model=self.model, using=using)
            return result
