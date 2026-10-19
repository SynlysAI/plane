"""使用内存资源验证报告图片解析和历史快照读取，不连接外部服务。"""

from contextlib import ExitStack
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import pytest
from django.test import SimpleTestCase, override_settings

from plane.db.models import FileAsset
from plane.research.services.report_context import selected_report_content
from plane.research.utils import report_images
from plane.research.views.report_images import ResearchReportImageEndpoint

pytestmark = pytest.mark.unit


@override_settings(CACHES={"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}})
class ReportImageTests(SimpleTestCase):
    """仅替换数据库和报告 ACL 边界，实际执行解析、清单组装与授权流程。"""

    def setUp(self):
        """准备相互独立的正式快照、当前草稿和已上传图片。"""
        self.report = SimpleNamespace(id=uuid4(), workspace_id=uuid4(), owner_id=uuid4())
        self.reader = SimpleNamespace(id=uuid4())
        self.assets = []
        self.asset = self.make_asset()
        self.snapshot = SimpleNamespace(
            version_no=1,
            description_json={},
            description_html="<p>正式正文</p>",
            description_stripped="正式正文",
            attachment_manifest=[],
            image_manifest=[],
        )
        self.report.page = SimpleNamespace(description_json={}, description_html="<p>当前草稿</p>")
        self.report.period_key = "2026-W42"
        self.report.get_report_type_display = lambda: "Weekly"
        self.report.official_snapshots = Mock()
        self.report.official_snapshots.all.return_value = [self.snapshot]
        self.report.official_snapshots.order_by.return_value.first.return_value = self.snapshot
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(FileAsset.objects, "filter", side_effect=self.filter_assets))
        reports = self.stack.enter_context(patch("plane.db.models.PeriodicReport.objects.filter"))
        reports.return_value.first.return_value = self.report
        reports.return_value.select_related.return_value.prefetch_related.return_value.first.return_value = self.report
        self.allowed = True
        for module in ("plane.research.utils.acl", "plane.research.services.report_context"):
            self.stack.enter_context(patch(f"{module}.build_actor_context", return_value=Mock()))
            self.stack.enter_context(patch(f"{module}.check_access", side_effect=lambda *args, **kwargs: self.allowed))
        self.stack.enter_context(patch("plane.research.utils.reports.report_resource", return_value=Mock()))
        self.stack.enter_context(patch("plane.research.services.report_context.report_resource", return_value=Mock()))

    def make_asset(self, **overrides):
        """创建未持久化的真实文件资源模型。

        Args:
            **overrides: 覆盖资源归属、类型或上传状态。

        Returns:
            加入内存资源集合的 FileAsset。
        """
        fields = {
            "id": uuid4(),
            "workspace_id": self.report.workspace_id,
            "entity_identifier": str(self.report.id),
            "entity_type": FileAsset.EntityTypeContext.REPORT_IMAGE,
            "is_uploaded": True,
            "is_deleted": False,
            "attributes": {"name": "image.png", "type": "image/png"},
            "size": 32,
        }
        fields.update(overrides)
        asset = FileAsset(**fields)
        self.assets.append(asset)
        return asset

    def filter_assets(self, **filters):
        """在内存中执行资源过滤，保留真实归属与状态条件。

        Args:
            **filters: ORM 的精确匹配及 in 查询条件。

        Returns:
            支持存在性检查和排序的查询桩。
        """
        assets = self.assets
        for key, expected in filters.items():
            field, _, lookup = key.partition("__")
            values = {str(value) for value in expected} if lookup == "in" else {str(expected)}
            assets = [asset for asset in assets if str(getattr(asset, field)) in values]
        queryset = Mock()
        queryset.exists.return_value = bool(assets)
        queryset.order_by.return_value = sorted(assets, key=lambda asset: asset.id)
        return queryset

    def body(self, *assets, node_type="imageComponent", tag="image-component"):
        """生成包含报告资源地址的编辑器正文。

        Args:
            *assets: 正文引用的资源。
            node_type: 编辑器 JSON 图片节点类型。
            tag: 图片 HTML 标签。

        Returns:
            JSON 和 HTML 正文字段。
        """
        sources = [f"/api/research/workspaces/lab/reports/{self.report.id}/images/{asset.id}/" for asset in assets]
        return {
            "description_json": {
                "type": "doc",
                "content": [{"type": node_type, "attrs": {"src": source}} for source in sources],
            },
            "description_html": "".join(f'<{tag} src="{source}"></{tag}>' for source in sources),
        }

    def test_editor_image_formats_are_collected_from_json_and_html(self):
        """新旧格式、独立字段及重复引用均生成唯一图片 ID。"""
        for node_type, tag in (("image", "img"), ("imageComponent", "image-component")):
            payload = self.body(self.asset, self.asset, node_type=node_type, tag=tag)
            for fields in (("description_json",), ("description_html",), tuple(payload)):
                with self.subTest(node_type=node_type, fields=fields):
                    selected = {field: payload[field] for field in fields}
                    self.assertEqual(report_images.body_image_ids(self.report, selected), {str(self.asset.id)})

    def test_submission_manifest_collects_mixed_editor_formats(self):
        """提交时合并新旧图片格式，并按资源 ID 稳定排序。"""
        other = self.make_asset()
        legacy = self.body(self.asset, node_type="image", tag="img")
        modern = self.body(other)
        self.report.page.description_json = legacy["description_json"]
        self.report.page.description_html = modern["description_html"]
        manifest = report_images.image_manifest(self.report)
        self.assertEqual([item["asset_id"] for item in manifest], sorted([str(self.asset.id), str(other.id)]))

    def test_resource_ids_and_absolute_report_urls_remain_supported(self):
        """裸资源 ID 与带域名的报告图片地址沿用相同归属检查。"""
        source = self.body(self.asset)["description_json"]["content"][0]["attrs"]["src"]
        for source in (str(self.asset.id), f"https://plane.example{source}"):
            with self.subTest(source=source):
                self.assertEqual(
                    report_images.body_image_ids(
                        self.report, {"description_json": {"type": "imageComponent", "attrs": {"src": source}}}
                    ),
                    {str(self.asset.id)},
                )

    def test_draft_validation_rejects_invalid_resource_scope_and_state(self):
        """两种编辑器格式均拒绝跨域资源归属、未上传、移除或错误类型。"""
        invalid_assets = [
            self.make_asset(workspace_id=uuid4()),
            self.make_asset(entity_identifier=str(uuid4())),
            self.make_asset(entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT),
            self.make_asset(is_uploaded=False),
            self.make_asset(is_deleted=True),
        ]
        for asset in invalid_assets:
            for node_type, tag in (("image", "img"), ("imageComponent", "image-component")):
                with self.subTest(asset=asset.id, node_type=node_type):
                    with self.assertRaises(ValueError):
                        report_images.body_image_ids(self.report, self.body(asset, node_type=node_type, tag=tag))

    def test_historical_empty_manifest_allows_formal_image(self):
        """复现生产故障：清单为空但正式正文有图片时导师仍可读取。"""
        self.snapshot.__dict__.update(self.body(self.asset))
        self.assertTrue(report_images.can_read_report_image(self.reader, self.asset))

    def test_existing_manifest_remains_authoritative_when_body_has_no_reference(self):
        """已有正式清单条目保持可读，不要求重新从正文找到同一引用。"""
        self.snapshot.image_manifest = [{"asset_id": str(self.asset.id), "file_name": "frozen.png"}]
        self.assertTrue(report_images.can_read_report_image(self.reader, self.asset))

    def test_historical_read_uses_snapshot_instead_of_current_draft(self):
        """正式图片从草稿移除后仍可读取，草稿新增图片不能外泄。"""
        draft_asset = self.make_asset()
        self.snapshot.__dict__.update(self.body(self.asset))
        self.report.page.__dict__.update(self.body(draft_asset))
        self.asset.is_deleted = True
        self.assertTrue(report_images.can_read_report_image(self.reader, self.asset))
        self.assertFalse(report_images.can_read_report_image(self.reader, draft_asset))

    def test_historical_image_requires_report_access_and_completed_upload(self):
        """历史兼容继续先检查报告 ACL 和资源实际上传状态。"""
        self.snapshot.__dict__.update(self.body(self.asset))
        self.allowed = False
        self.assertFalse(report_images.can_read_report_image(self.reader, self.asset))
        self.allowed = True
        self.asset.is_uploaded = False
        self.assertFalse(report_images.can_read_report_image(self.reader, self.asset))

    def test_historical_image_endpoint_redirects_only_for_authorized_reader(self):
        """图片接口复用历史补全结果，未获报告权限时不签发存储链接。"""
        self.snapshot.__dict__.update(self.body(self.asset))
        endpoint = ResearchReportImageEndpoint()
        request = SimpleNamespace(user=self.reader)
        with (
            patch.object(endpoint, "get_workspace", return_value=(Mock(), None)),
            patch.object(FileAsset.objects, "filter") as assets,
            patch("plane.research.views.report_images.S3Storage") as storage,
        ):
            assets.return_value.first.return_value = self.asset
            assets.return_value.order_by.return_value = [self.asset]
            storage.return_value.generate_presigned_url.return_value = "https://storage.invalid/image.png"
            response = endpoint.get(request, "lab", self.report.id, self.asset.id)
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response["Location"], "https://storage.invalid/image.png")
            storage.reset_mock()
            self.allowed = False
            response = endpoint.get(request, "lab", self.report.id, self.asset.id)
            self.assertEqual(response.status_code, 404)
            storage.assert_not_called()

    def test_draft_sources_reject_invalid_urls_and_preserve_external_http_images(self):
        """无效本地地址不能保存，外部 HTTP(S) 图片不计入本地清单。"""
        for source in ("relative.png", "data:image/png;base64,aaaa", "https://[invalid/image.png"):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    report_images.body_image_ids(
                        self.report, {"description_html": f'<image-component src="{source}"></image-component>'}
                    )
        self.assertEqual(
            report_images.body_image_ids(
                self.report, {"description_html": '<image-component src="https://external.example/image.png" />'}
            ),
            set(),
        )

    def test_context_supplements_partial_manifest_without_modifying_snapshot(self):
        """正式上下文补全遗漏图片，保留原有元数据和不可变快照。"""
        other = self.make_asset()
        self.snapshot.__dict__.update(self.body(self.asset, other, other))
        original = {"asset_id": str(self.asset.id), "file_name": "frozen-name.png", "file_size": 16}
        self.snapshot.image_manifest = [original]
        before = deepcopy(self.snapshot.__dict__)
        contents = selected_report_content(
            workspace=SimpleNamespace(id=self.report.workspace_id, slug="lab"),
            actor=self.reader,
            project_id=uuid4(),
            selections=[{"report_id": str(self.report.id), "version_no": 1}],
        )
        self.assertEqual(
            contents[0]["images"],
            [
                original,
                {"asset_id": str(other.id), "file_name": "image.png", "content_type": "image/png", "file_size": 32},
            ],
        )
        self.assertEqual(self.snapshot.__dict__, before)

    def test_context_ignores_foreign_incomplete_and_invalid_historical_sources(self):
        """坏引用不影响有效历史图片，且不会补入不属于该报告的资源。"""
        invalid_assets = [
            self.make_asset(workspace_id=uuid4()),
            self.make_asset(entity_identifier=str(uuid4())),
            self.make_asset(entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT),
            self.make_asset(is_uploaded=False),
        ]
        self.snapshot.__dict__.update(self.body(self.asset, *invalid_assets))
        self.snapshot.description_html += (
            '<image-component src="relative.png"></image-component><img src="https://external.example/image.png">'
        )
        contents = selected_report_content(
            workspace=SimpleNamespace(id=self.report.workspace_id, slug="lab"),
            actor=self.reader,
            project_id=uuid4(),
            selections=[{"report_id": str(self.report.id), "version_no": 1}],
        )
        self.assertEqual([item["asset_id"] for item in contents[0]["images"]], [str(self.asset.id)])
