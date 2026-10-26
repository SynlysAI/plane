"""可重新生成的附件预览缓存，不作为用户上传资产暴露。"""

import uuid
from django.db import models
from django.db.models import Q


class AssetPreview(models.Model):
    """记录源对象版本、转换状态及私有派生文件。"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    asset = models.ForeignKey("db.FileAsset", on_delete=models.SET_NULL, null=True, related_name="previews")
    chain_upload = models.ForeignKey(
        "db.ResearchChainUpload",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="previews",
    )
    fingerprint = models.CharField(max_length=64)
    converter_version = models.CharField(max_length=80)
    kind = models.CharField(max_length=16)
    status = models.CharField(max_length=16, default="pending")
    object_key = models.CharField(max_length=800, blank=True)
    content_type = models.CharField(max_length=100, blank=True)
    size = models.BigIntegerField(default=0)
    error_code = models.CharField(max_length=80, blank=True)
    attempt = models.UUIDField(default=uuid.uuid4)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "asset_previews"
        constraints = [
            models.UniqueConstraint(
                fields=["asset", "fingerprint", "converter_version"], name="asset_preview_source_version_uq"
            ),
            models.UniqueConstraint(
                fields=["chain_upload", "fingerprint", "converter_version"],
                condition=Q(chain_upload__isnull=False),
                name="chain_upload_preview_source_version_uq",
            ),
        ]
