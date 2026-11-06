"""统一 MCP 文件工具的闭合契约和客户端操作说明。"""

from plane.mcp.schema_types import PAGING, REQUEST_ID, TARGET, UUID, enum, obj, text

LOCATIONS = enum(
    "issue_attachment",
    "issue_comment",
    "task_instruction",
    "task_comment",
    "node_file",
    "paper_version",
    "report_attachment",
)
DESTINATION = obj({"parent": TARGET, "location": LOCATIONS, "resource_id": UUID}, ["parent", "location"])
FILE_REF = obj(
    {**DESTINATION["properties"], "id": UUID, "version": {"type": "integer", "minimum": 1}},
    ["parent", "location", "id"],
)
SESSION = {"session_id": UUID}
FILE_SCHEMAS = {
    "plane_list_files": obj(
        {**DESTINATION["properties"], "version": {"type": "integer", "minimum": 1}, **PAGING}, ["parent", "location"]
    ),
    "plane_get_file_download": obj({"file_ref": FILE_REF}, ["file_ref"]),
    "plane_read_file_chunk": obj(
        {
            **SESSION,
            "cursor": text(4096),
            "chunk_size": {"type": "integer", "minimum": 1, "maximum": 16384, "default": 4096},
        },
        ["session_id"],
    ),
    "plane_prepare_file_upload": obj(
        {
            "target": DESTINATION,
            "file_name": text(255),
            "content_type": text(255),
            "size": {"type": "integer", "minimum": 1, "maximum": 9223372036854775807},
            "sha256": {**text(64), "pattern": "^[a-fA-F0-9]{64}$"},
            "request_id": REQUEST_ID,
        },
        ["target", "file_name", "content_type", "size", "sha256", "request_id"],
    ),
    "plane_upload_file_chunk": obj(
        {
            **SESSION,
            "offset": {"type": "integer", "minimum": 0, "maximum": 9223372036854775807},
            "content_base64": text(21848),
        },
        ["session_id", "offset", "content_base64"],
    ),
    "plane_complete_file_upload": obj({**SESSION, "transport": enum("http", "mcp")}, ["session_id", "transport"]),
    "plane_upload_markdown": obj(
        {
            "target": DESTINATION,
            "file_name": text(255),
            "text": {"type": "string", "minLength": 1, "maxLength": 262144},
            "request_id": REQUEST_ID,
        },
        ["target", "file_name", "text", "request_id"],
    ),
    "plane_submit_paper_version": obj(
        {**SESSION, "change_summary": text(8000), "request_id": REQUEST_ID},
        ["session_id", "change_summary", "request_id"],
    ),
}
FILE_READ_NAMES = frozenset({"plane_list_files", "plane_get_file_download", "plane_read_file_chunk"})
FILE_DESCRIPTIONS = {
    "plane_list_files": (
        "列举指定业务位置的文件、完整引用、大小、摘要及当前权限。论文和报告使用资源 ID；正式报告必须指定版本。"
        "保留父对象及版本，不使用任意资产 ID 下载。"
    ),
    "plane_get_file_download": (
        "为已选文件准备不可变下载快照，返回临时 HTTP GET 和 MCP 分块入口。PREPARING 时用 "
        "plane_get_write_result 的 download:<session_id> 查询。优先用 Agent 现有 HTTP 文件工具下载并校验 SHA-256；"
        "HTTP 不可用时逐块解码保存。"
    ),
    "plane_read_file_chunk": (
        "读取下载快照的一块 Base64；默认原始字节 4 KiB，最大 16 KiB。使用返回游标续传，由已有本地文件或执行工具解码，"
        "结束后校验总摘要。不要让 LLM 编造字节。"
    ),
    "plane_prepare_file_upload": (
        "为用户授权文件准备持久上传会话。先由 Agent 文件工具计算真实大小和 SHA-256；优先按返回 HTTP PUT 自动直传，"
        "备用 MCP 分块覆盖全部业务允许大小。服务端不能读取客户端本地路径。复用 request_id 恢复，不需要新增密钥或 SDK。"
    ),
    "plane_upload_file_chunk": (
        "按字节偏移顺序发送真实文件的 Base64 块，最大原始 16 KiB，默认 4 KiB。同偏移同内容幂等确认；"
        "错误偏移返回续传位置，不回显正文。使用 Agent 现有文件或执行工具编码。"
    ),
    "plane_complete_file_upload": (
        "字节发送完成后必须调用，后台核对大小、签名和总摘要并登记独立最终文件。"
        "FINALIZING 仍未完成；按原 request_id 查询。"
        "评论附件 READY 后才调用评论工具关联 attachment_ids；论文 READY 只是候选，显式提交才进入审核。"
    ),
    "plane_upload_markdown": (
        "将真实 Markdown 正文生成 .md 文件并复用完整登记流程。UTF-8 正文上限为工作区额度和 256 KiB 的较小值；"
        "更大文件使用普通直传或分块。评论附件随后关联，上传回执不是评论发布成功。"
    ),
    "plane_submit_paper_version": (
        "显式将已完成的论文候选上传提交为新审核版本，要求变更说明和稳定 request_id。"
        "先确认用户提交意图；上传本身不会改变审核状态。重试和结果恢复不会重复生成版本。"
    ),
}
FILE_TOOLS = tuple(
    {
        "name": name,
        "description": FILE_DESCRIPTIONS[name],
        "inputSchema": schema,
        "annotations": {
            "readOnlyHint": name in FILE_READ_NAMES,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": name in {"plane_get_file_download", "plane_complete_file_upload"},
        },
    }
    for name, schema in FILE_SCHEMAS.items()
)
