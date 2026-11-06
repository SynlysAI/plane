"""文件传输与原生业务权限、附件登记之间的共享边界。"""

from plane.db.models import (
    FileAsset,
    ResearchChain,
    ResearchChainNode,
    ResearchChainNodeTask,
    ResearchChainNodeTaskAttachment,
)
from plane.mcp.authorization import active_connection
from plane.mcp.reading import UnifiedReadService
from plane.research.services.chain_tasks import actor_can_manage_chain_tasks, chain_writer
from plane.research.services.mcp_catalog import ResearchReadError
from plane.research.services.paper_review import actor_can_submit_paper, paper_file_error, PAPER_ASSET_ENTITY
from plane.research.utils.files import extension_of, research_chain_upload_limits, validate_attachment
from plane.research.utils.settings import get_workspace_research_settings
from plane.utils.comment_attachments import MAX_FILE_ATTACHMENTS
from plane.utils.issue_mutations import issue_action_allowed

ASSET_TYPES = {
    "issue_attachment": FileAsset.EntityTypeContext.ISSUE_ATTACHMENT,
    "issue_comment": FileAsset.EntityTypeContext.COMMENT_ATTACHMENT,
    "task_instruction": FileAsset.EntityTypeContext.RESEARCH_TASK_INSTRUCTION_ATTACHMENT,
    "task_comment": FileAsset.EntityTypeContext.RESEARCH_TASK_COMMENT_ATTACHMENT,
    "paper_version": PAPER_ASSET_ENTITY,
}
RESEARCH_KINDS = {
    "task_instruction": "task_attachment",
    "task_comment": "task_comment_attachment",
    "node_file": "upload",
    "paper_version": "paper_review",
    "report_attachment": "report",
}


class FileBusiness:
    """每次操作重新解析真实父对象，防止任意资产 ID 越权。"""

    def __init__(self, connection):
        """绑定需要实时复核的 MCP 连接。"""
        self.connection = active_connection(connection.pk)
        if self.connection is None:
            raise ResearchReadError("scope_denied", "MCP 连接已撤销或过期。", 403)
        self.reader = UnifiedReadService(self.connection)
        self.user = self.connection.owner

    def context(self, target, location, *, write=False, resource_id=None):
        """解析文件位置与父对象，并交叉检查 MCP 和原生权限。"""
        workspace, kind, parent = self.reader.resolve(target)
        if location in {"issue_attachment", "issue_comment"}:
            valid = kind == "Issue"
        elif location in {"task_instruction", "task_comment"}:
            valid = kind == "ResearchChainNodeTask"
        else:
            valid = kind == "ResearchChainNode" and location in RESEARCH_KINDS
        if not valid:
            raise ResearchReadError("invalid_target", "文件位置与业务父对象类型不匹配。", 422)
        if not write:
            return workspace, parent
        entry = next(item for item in self.connection.scope["workspaces"] if item["workspace_id"] == str(workspace.pk))
        if (
            entry["domains"].get(target["domain"]) != "read_write"
            or not self.connection.scope["include_future_objects"]
        ):
            raise ResearchReadError("scope_denied", "上传需要对应业务的动态读写权限。", 403)
        if kind == "Issue":
            action = "comment" if location == "issue_comment" else "update"
            if not issue_action_allowed(self.user, parent.project, action, parent):
                raise ResearchReadError("permission_denied", "当前角色不能向此位置上传文件。", 403)
        else:
            from plane.research.services.agent_operations import allowed_actions, check_membership, workspace_policy

            workspace_policy(workspace)
            check_membership(workspace, self.user)
            node = parent.node if kind == "ResearchChainNodeTask" else parent
            if node.chain.status != "ACTIVE" or node.status in {"ARCHIVED", "COMPLETED", "WAITING_HUMAN"}:
                raise ResearchReadError("state_conflict", "当前研究链或节点不接受 Agent 文件写入。", 409)
            allowed = True
            if location == "task_instruction":
                allowed = parent.status in {"DRAFT", "ASSIGNED"} and actor_can_manage_chain_tasks(
                    workspace, node.chain, self.user
                )
            elif location == "node_file":
                allowed = chain_writer(workspace, self.user, node.chain)
            elif location == "task_comment":
                allowed = "append_task_comment" in allowed_actions(workspace, self.user, node)
            elif location == "paper_version":
                review = self.resource(parent, location, resource_id)
                allowed = actor_can_submit_paper(workspace, review, self.user)
                if review.status not in {"OPEN", "NEEDS_REVISION"}:
                    raise ResearchReadError("state_conflict", "论文当前状态不允许上传候选版本。", 409)
            elif location == "report_attachment":
                allowed = False
            if not allowed:
                raise ResearchReadError("permission_denied", "当前角色或业务状态不允许此项文件写入。", 403)
        return workspace, parent

    def resource(self, parent, location, identity):
        """从授权节点的资源集合中读取原生记录。"""
        reader = self.reader.reader(parent.chain.workspace)
        kind = RESEARCH_KINDS[location]
        row = reader._lookup(parent, kind, identity) if identity else None
        if row is None or not reader._allowed(parent, kind, row):
            raise ResearchReadError("not_found", "文件所属资源不在当前授权范围。", 404)
        return row

    def limits(self, workspace, location):
        """读取当前业务大小限制，不为分块通道添加额外总量限制。"""
        return (
            research_chain_upload_limits(workspace)
            if location == "node_file"
            else get_workspace_research_settings(workspace)
        )

    def validate_metadata(self, workspace, location, name, content_type, size):
        """使用网页端同类文件的额度和类型限制校验声明。"""
        limits = self.limits(workspace, location)
        validator = paper_file_error if location == "paper_version" else validate_attachment
        error = validator(file_name=name, content_type=content_type, size_bytes=size, limits=limits)
        if location == "node_file" and extension_of(name) not in {".pdf", ".md", ".markdown", ".txt", ".doc", ".docx"}:
            error = "file_type_not_allowed"
        if error:
            raise ResearchReadError(error, "文件类型或大小不符合此业务位置的要求。", 422)
        return limits

    def rows(self, target, location, *, resource_id=None, version=None):
        """返回已授权的文件行；版本化文件必须绑定对应版本。"""
        workspace, parent = self.context(target, location)
        if location.startswith("issue_"):
            rows = self.reader.cutoff(
                FileAsset.objects.filter(
                    workspace=workspace,
                    project=parent.project,
                    issue=parent,
                    entity_type=ASSET_TYPES[location],
                    is_uploaded=True,
                    is_deleted=False,
                )
            )
            if location == "issue_comment":
                rows = rows.filter(comment__in=self.reader.comments(parent))
            return rows.order_by("pk"), parent
        if location in {"task_instruction", "task_comment"}:
            reader = self.reader.reader(workspace)
            rows = reader._candidates(parent.node, RESEARCH_KINDS[location])
            return rows.filter(
                **{"task": parent} if location == "task_instruction" else {"comment__task": parent}
            ).order_by("pk"), parent
        row = self.resource(parent, location, resource_id) if resource_id else None
        if location == "node_file":
            rows = self.reader.reader(workspace)._candidates(parent, "upload")
            if resource_id:
                rows = rows.filter(pk=row.pk)
            return rows.order_by("pk"), parent
        if row is None:
            raise ResearchReadError("resource_required", "请明确选择论文审核或正式报告资源。", 422)
        if location == "paper_version":
            rows = self.reader.cutoff(row.versions.all())
            if version is not None:
                rows = rows.filter(version_no=version)
            return rows.select_related("asset").order_by("pk"), parent
        if version is None:
            raise ResearchReadError("version_required", "正式报告附件必须指定快照版本。", 422)
        reader = self.reader.reader(workspace)
        snapshot = reader.authorization.report_versions(row).filter(version_no=version).first()
        if snapshot is None:
            raise ResearchReadError("not_found", "该报告版本不在当前授权范围。", 404)
        return sorted(snapshot.attachment_manifest, key=lambda item: item["attachment_id"]), parent

    @staticmethod
    def describe(target, location, row, *, resource_id=None, version=None):
        """构造携带父对象、原生 ID 和必要版本的文件引用。"""
        if isinstance(row, dict):
            identity, asset = row["attachment_id"], None
            name, content_type, size = row["file_name"], row["content_type"], row["file_size"]
            sha256 = None
        elif location == "node_file":
            identity, asset = str(row.pk), None
            name, size, sha256 = row.file_name, row.file_size, row.file_hash
            content_type = {
                "pdf": "application/pdf",
                "md": "text/markdown",
                "txt": "text/plain",
                "markdown": "text/markdown",
                "doc": "application/msword",
                "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }.get(row.file_type, "application/octet-stream")
        else:
            identity = str(row.pk)
            asset = row if isinstance(row, FileAsset) else row.asset
            name = asset.attributes.get("name") or asset.asset.name.rsplit("/", 1)[-1]
            content_type = asset.attributes.get("type") or "application/octet-stream"
            size = int(asset.size)
            sha256 = asset.attributes.get("sha256")
            if location == "paper_version":
                version = row.version_no
                resource_id = str(row.review_id)
        reference = {"parent": target, "location": location, "id": identity}
        if resource_id:
            reference["resource_id"] = str(resource_id)
        if version is not None:
            reference["version"] = version
        return {
            "file_ref": reference,
            "file_name": name,
            "content_type": content_type,
            "size": size,
            "sha256": sha256,
            "available_operations": ["download"],
        }

    def source(self, reference):
        """验证完整文件引用后返回描述、资产或外部文件记录。"""
        location = reference["location"]
        if location in {"paper_version", "report_attachment"} and "version" not in reference:
            raise ResearchReadError("version_required", "下载论文或正式报告附件必须指定版本。", 422)
        rows, parent = self.rows(
            reference["parent"], location, resource_id=reference.get("resource_id"), version=reference.get("version")
        )
        row = (
            next((item for item in rows if item["attachment_id"] == reference["id"]), None)
            if isinstance(rows, list)
            else rows.filter(pk=reference["id"]).first()
        )
        if row is None:
            raise ResearchReadError("not_found", "文件不属于指定父对象、位置或版本。", 404)
        info = self.describe(
            reference["parent"],
            location,
            row,
            resource_id=reference.get("resource_id"),
            version=reference.get("version"),
        )
        if location == "node_file":
            return info, row
        if isinstance(row, dict):
            asset = FileAsset.objects.filter(
                pk=row["asset_id"],
                workspace=parent.chain.workspace,
                entity_type=FileAsset.EntityTypeContext.REPORT_ATTACHMENT,
                entity_identifier=reference["resource_id"],
            ).first()
        else:
            asset = row if isinstance(row, FileAsset) else row.asset
        if asset is None or asset.is_deleted or asset.deleted_at or not asset.is_uploaded:
            raise ResearchReadError("not_found", "文件资产已删除或尚未完成上传。", 404)
        return info, asset

    def lock_parent(self, parent):
        """按原生业务顺序锁定父对象，使额度及最终登记保持原子性。"""
        from plane.db.models import Issue

        if isinstance(parent, Issue):
            return Issue.issue_objects.select_for_update(of=("self",)).get(pk=parent.pk)
        node = parent.node if isinstance(parent, ResearchChainNodeTask) else parent
        ResearchChain.objects.select_for_update().get(pk=node.chain_id)
        ResearchChainNode.objects.select_for_update().get(pk=node.pk)
        if isinstance(parent, ResearchChainNodeTask):
            ResearchChainNodeTask.objects.select_for_update().get(pk=parent.pk)
        return parent

    def register(self, transfer):
        """登记校验后的独立对象；评论和论文候选保持待业务发布状态。"""
        workspace, parent = self.context(
            transfer.target, transfer.location, write=True, resource_id=transfer.file_ref.get("resource_id")
        )
        self.lock_parent(parent)
        self.context(transfer.target, transfer.location, write=True, resource_id=transfer.file_ref.get("resource_id"))
        if transfer.asset_id:
            return transfer.asset
        location = transfer.location
        identifier = str(transfer.file_ref.get("resource_id") if location == "paper_version" else parent.pk)
        rows = FileAsset.objects.filter(
            workspace=workspace, entity_type=ASSET_TYPES[location], entity_identifier=identifier, is_deleted=False
        )
        if location == "issue_comment":
            rows = rows.filter(comment__isnull=True, created_by=self.user)
        elif location == "task_comment":
            rows = rows.filter(research_task_comment_attachments__isnull=True, created_by=self.user)
        if location != "paper_version" and rows.count() >= MAX_FILE_ATTACHMENTS:
            raise ResearchReadError("attachment_count_exceeded", "附件数量已达到业务上限。", 422)
        asset = FileAsset(
            workspace=workspace,
            user=self.user,
            project=parent.project if location.startswith("issue_") else None,
            issue=parent if location.startswith("issue_") else None,
            entity_type=ASSET_TYPES[location],
            entity_identifier=identifier,
            asset=transfer.final_key,
            attributes={
                "name": transfer.file_name,
                "type": transfer.content_type,
                "size": transfer.size,
                "sha256": transfer.sha256,
            },
            size=transfer.size,
            is_uploaded=True,
            storage_metadata={"ContentType": transfer.content_type, "ContentLength": transfer.size},
        )
        asset.save(created_by_id=self.user.pk)
        if location == "task_instruction":
            attachment = ResearchChainNodeTaskAttachment.objects.create(
                task=parent,
                asset=asset,
                file_name=transfer.file_name,
                content_type=transfer.content_type,
                file_size=transfer.size,
                uploaded_by=self.user,
                created_by=self.user,
            )
            attachment_id = str(attachment.pk)
        else:
            attachment_id = str(asset.pk)
        resource_id = transfer.file_ref.get("resource_id") or transfer.target.get("resource_id")
        transfer.file_ref = {"parent": transfer.target, "location": location, "id": attachment_id}
        if resource_id:
            transfer.file_ref["resource_id"] = str(resource_id)
        transfer.asset = asset
        transfer.state = "PUBLISHED" if location in {"issue_attachment", "task_instruction"} else "READY"
        transfer.result = {
            "asset_id": str(asset.pk),
            "attachment_id": attachment_id,
            "business_published": transfer.state == "PUBLISHED",
        }
        return asset

    @staticmethod
    def publication(transfer):
        """按真实关联查询评论或论文是否已发布，避免将字节接收误报为发布。"""
        asset = transfer.asset
        if asset is None:
            return transfer.result
        result = dict(transfer.result)
        if transfer.location == "issue_comment" and asset.comment_id:
            result.update(business_published=True, comment_id=str(asset.comment_id))
        elif transfer.location == "task_comment":
            attachment = asset.research_task_comment_attachments.select_related("comment").first()
            if attachment:
                result.update(business_published=True, comment_id=str(attachment.comment_id))
        elif transfer.location == "paper_version":
            from plane.db.models import ResearchPaperReviewVersion

            version = ResearchPaperReviewVersion.objects.filter(asset=asset).first()
            if version:
                result.update(business_published=True, version_id=str(version.pk), version=version.version_no)
        return result
