# 2026-09-24 L1 Plane BFF → RAGPortal 集成连接

> **历史证据**：本文记录 2026-09-25 Phase 1.5 旧 seed 联调结果，只用于审计复盘，不代表当前 `public` π-Lab Excel 基线。当前人工测试请使用 Phase 1.5 分角色人工测试计划。

## 结论

修复 P15-001 后，Plane 使用 `RAGPORTAL_AUTH_SECRET` 签发短时 AI4MS Bearer token 并调用 RAGPortal：

```text
GET http://172.19.0.1:8004/api/kb/list?refresh=false
HTTP 200
items=5
latency_ms=98
```

首个知识库为「往年正刊知识库」，返回项只包含外部 ID、标题、类型与元数据，不包含凭证。

## Plane 调用审计

```text
system=RAGPORTAL
operation=list_knowledge_bases
outcome=SUCCESS
status_code=200
latency_ms=98
error_code=''
```

修复提交：`c282ecc20`。
