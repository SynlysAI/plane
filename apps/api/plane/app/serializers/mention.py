"""行政 Web、API、MCP 和公开评论共用的提及保存边界。"""

import json

from django.core.serializers.json import DjangoJSONEncoder
from django.db import transaction

from plane.utils.mentions import validate_new_mentions


class IssueMentionValidationMixin:
    """在保存事务内锁定旧版本并校验新增提及。"""

    @transaction.atomic
    def save(self, **kwargs):
        """使用实际持久化版本做差分，无权提及使整个保存回滚。"""
        field = "comment_html" if self.Meta.model._meta.model_name == "issuecomment" else "description_html"
        previous_html = ""
        if self.instance is not None:
            self.instance = self.Meta.model.objects.select_for_update().get(pk=self.instance.pk)
            previous_html = getattr(self.instance, field)
        self.mention_previous_html = previous_html
        instance = super().save(**kwargs)
        if field in self.validated_data:
            source = instance.issue if field == "comment_html" else instance
            validate_new_mentions("issue", source, getattr(instance, field), previous_html)
        return instance

    def notification_previous(self, previous):
        """用锁内正文修正通知旧快照，避免并发请求重复产生提及。

        Args:
            previous: 调用方保存前序列化的业务快照。

        Returns:
            保留原字段并替换正文的 JSON 快照。
        """
        snapshot = json.loads(previous) if isinstance(previous, str) else dict(previous or {})
        field = "comment_html" if self.Meta.model._meta.model_name == "issuecomment" else "description_html"
        snapshot[field] = self.mention_previous_html
        return json.dumps(snapshot, cls=DjangoJSONEncoder)
