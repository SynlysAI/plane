"""仅清理科研项目的旧 Plane 业务数据，保护科研链及行政数据。"""

import hashlib
import json
import re

from django.apps import apps
from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction
from django.db.models import Q
from django.db.models.deletion import Collector

from plane.db.models import FileAsset, Page, Project, ProjectPage
from plane.utils.administrative_projects import research_project_ids


LEGACY_MODELS = (
    "IssueActivity", "Issue", "DraftIssue", "Cycle", "Module", "IssueView",
    "Intake", "Label", "IssueSequence", "UserFavorite", "UserRecentVisit",
)
PRESERVED_MODELS = frozenset({
    "Project", "ProjectMember", "ProjectIdentifier", "ProjectUserProperty",
    "Workspace", "WorkspaceMember", "User", "Profile", "State",
})
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)


class CleanupJSONEncoder(DjangoJSONEncoder):
    """保留页面二进制正文的精确内容，并暴露可读资源引用。"""

    def default(self, value):
        """序列化二进制字段，其余字段沿用 Django 编码。

        Args:
            value: 待编码字段值。

        Returns:
            可 JSON 序列化的字段值。
        """
        if isinstance(value, (bytes, bytearray, memoryview)):
            content = bytes(value)
            return {"binary_hex": content.hex(), "binary_text": content.decode(errors="replace")}
        return super().default(value)


def all_rows(model):
    """返回包含软删除记录的查询集。

    Args:
        model: Django 模型。

    Returns:
        该模型的全部记录查询集。
    """
    return getattr(model, "all_objects", model._base_manager).all()


def is_research_model(model):
    """判断模型是否承载科研数据。

    Args:
        model: Django 模型。

    Returns:
        科研模型为 True。
    """
    return "/research/" in model.__module__.replace(".", "/")


def protected_references():
    """收集科研记录引用的 UUID，包括 JSON 中的资源引用。

    Returns:
        受保护资源主键字符串集合。
    """
    references = set()
    for model in apps.get_app_config("db").get_models():
        if is_research_model(model):
            for row in all_rows(model).values().iterator():
                payload = json.dumps(row, cls=CleanupJSONEncoder, sort_keys=True)
                references.update(value.lower() for value in UUID_PATTERN.findall(payload))
    return references


def protected_fingerprint(workspace, target_ids, references):
    """为科研数据、行政数据及保留资源生成内容指纹。

    Args:
        workspace: 目标工作区。
        target_ids: 本次清理的科研项目 ID 集合。
        references: 科研数据引用的受保护资源 ID。

    Returns:
        按模型记录行数及 SHA256 的字典。
    """
    result = {}
    for model in apps.get_app_config("db").get_models():
        fields = {field.name for field in model._meta.fields if field.is_relation}
        rows = all_rows(model)
        if is_research_model(model) or model.__name__ in PRESERVED_MODELS:
            pass
        elif "project" in fields:
            rows = rows.filter(workspace=workspace) if "workspace" in fields else rows
            rows = rows.filter(~Q(project_id__in=target_ids) | Q(pk__in=references))
            if model is ProjectPage:
                rows = all_rows(model).filter(
                    ~Q(project_id__in=target_ids) | Q(page_id__in=references)
                )
        elif model is Page:
            rows = rows.filter(workspace=workspace).filter(
                Q(id__in=references) | ~Q(project_pages__project_id__in=target_ids)
            ).distinct()
        else:
            protected = Q(pk__in=references)
            if "page" in fields:
                protected |= Q(page_id__in=references)
            rows = rows.filter(protected)
        digest = hashlib.sha256()
        count = 0
        for row in rows.order_by("pk").values().iterator():
            digest.update(json.dumps(row, cls=CleanupJSONEncoder, sort_keys=True).encode())
            count += 1
        result[model._meta.label] = {"count": count, "sha256": digest.hexdigest()}
    return result


def cleanup_legacy_plane_data(workspace, apply=False):
    """预览或事务性清理科研项目下的旧 Plane 数据。

    Args:
        workspace: 目标工作区。
        apply: 是否执行删除；默认仅预览。

    Returns:
        项目、删除清单、保留资源及验证结果。

    Raises:
        RuntimeError: 级联将影响科研、行政或保留数据，或清理后指纹不一致。
    """
    with transaction.atomic():
        projects = Project.all_objects.filter(workspace=workspace, id__in=research_project_ids())
        target_ids = set(projects.values_list("id", flat=True))
        if apply:
            list(projects.select_for_update())
        references = protected_references()
        collector = Collector(using=projects.db)
        protected_pages = set(Page.all_objects.filter(id__in=references).values_list("id", flat=True))
        referenced_asset_pages = FileAsset.all_objects.filter(id__in=references).exclude(page_id=None).values("page_id")
        protected_pages.update(Page.all_objects.filter(id__in=referenced_asset_pages).values_list("id", flat=True))
        shared_pages = ProjectPage.all_objects.exclude(project_id__in=target_ids).values("page_id")
        protected_pages.update(Page.all_objects.filter(id__in=shared_pages).values_list("id", flat=True))
        # 递归保留科研页面的父页面，避免级联更改科研正文的层级关系。
        while True:
            parents = set(Page.all_objects.filter(id__in=protected_pages).exclude(parent_id=None).values_list("parent_id", flat=True))
            if parents.issubset(protected_pages):
                break
            protected_pages.update(parents)
        references.update(str(value) for value in protected_pages)
        for name in LEGACY_MODELS:
            model = apps.get_model("db", name)
            fields = {field.name for field in model._meta.fields if field.is_relation}
            if "project" in fields:
                collector.collect(all_rows(model).filter(project_id__in=target_ids))
        pages = Page.all_objects.filter(
            workspace=workspace, project_pages__project_id__in=target_ids
        ).exclude(id__in=protected_pages).distinct()
        collector.collect(pages)
        collector.collect(ProjectPage.all_objects.filter(project_id__in=target_ids).exclude(page_id__in=protected_pages))

        affected = {model: {row.pk for row in rows} for model, rows in collector.data.items()}
        for rows in collector.fast_deletes:
            affected.setdefault(rows.model, set()).update(rows.values_list("pk", flat=True))
        for model, ids in affected.items():
            if not ids:
                continue
            if is_research_model(model) or model.__name__ in PRESERVED_MODELS:
                raise RuntimeError(f"删除会影响保留模型：{model._meta.label}")
            if set(str(value) for value in ids).intersection(references):
                raise RuntimeError(f"删除会影响科研引用：{model._meta.label}")
            fields = {field.name for field in model._meta.fields if field.is_relation}
            if "page" in fields and all_rows(model).filter(pk__in=ids, page_id__in=references).exists():
                raise RuntimeError(f"删除会影响科研页面资源：{model._meta.label}")
            if "project" in fields and all_rows(model).filter(pk__in=ids).exclude(project_id__in=target_ids).exists():
                raise RuntimeError(f"删除会影响行政数据：{model._meta.label}")
        for (field, _value), batches in collector.field_updates.items():
            ids = set()
            for batch in batches:
                ids.update(batch.values_list("pk", flat=True) if hasattr(batch, "values_list") else (row.pk for row in batch))
            if not ids:
                continue
            if is_research_model(field.model) or field.model.__name__ in PRESERVED_MODELS:
                raise RuntimeError(f"删除会修改保留模型：{field.model._meta.label}.{field.name}")
            fields = {item.name for item in field.model._meta.fields if item.is_relation}
            protected = Q(pk__in=references)
            if "project" in fields:
                protected |= ~Q(project_id__in=target_ids)
            if "page" in fields:
                protected |= Q(page_id__in=references)
            if all_rows(field.model).filter(pk__in=ids).filter(protected).exists():
                raise RuntimeError(f"删除会修改受保护资源：{field.model._meta.label}.{field.name}")

        before = protected_fingerprint(workspace, target_ids, references)
        report = {
            "mode": "apply" if apply else "preview",
            "workspace": workspace.slug,
            "projects": list(projects.values("id", "name", "identifier")),
            "deletions": {model._meta.label: sorted(str(pk) for pk in ids) for model, ids in affected.items() if ids},
            "protected_pages": sorted(str(pk) for pk in protected_pages),
            "protected_before": before,
        }
        if apply:
            count, details = collector.delete()
            after = protected_fingerprint(workspace, target_ids, references)
            if before != after:
                raise RuntimeError("清理改变了科研或行政保留数据，事务已回滚")
            report.update(deleted_count=count, deleted_by_model=details, protected_after=after, verified=True)
        return report
