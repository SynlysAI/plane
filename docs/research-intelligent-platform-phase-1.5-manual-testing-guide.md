# 科研智能体平台 Phase 1.5 人工测试指南

| 项目     | 内容                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 文档版本 | v1.0                                                                                                                                       |
| 适用环境 | 本机 Phase 1.5 开发联调环境，非生产环境                                                                                                    |
| 上游计划 | [`research-intelligent-platform-phase-1.5-integration-debug-plan.md`](./research-intelligent-platform-phase-1.5-integration-debug-plan.md) |
| 执行手册 | [`research-intelligent-platform-phase-1.5-execution-runbook.md`](./research-intelligent-platform-phase-1.5-execution-runbook.md)           |
| 目标读者 | 产品、测试、开发和研究人员；用于人工复验 Phase 1.5 已打通的科研链路                                                                        |

## 1. 测试目标与安全边界

### 1.1 你将要验证的内容

1. Plane Web 的科研导航、研究链、知识上传、Agent 会话和导出。
2. Plane → RAGPortal → WeKnora 的文档上传、解析与引用确认。
3. Plane → Synlora 的上下文授权、工具白名单和 `knowledge.search` 检索。
4. Workspace、PRIVATE、MENTOR、PI、ADMIN、NONE、Guest 的权限差异。
5. Synlora、RAGPortal、WeKnora 认证失败时的中文降级提示和人工记录路径。

### 1.2 安全与数据边界

- 只在本地开发环境和 `public` 测试工作区操作。
- 只向 WeKnora 的测试知识库上传可公开的测试文件。
- 新建数据统一命名：`人工测试-MMDD-姓名或昵称-用途`。
- 不要把 API key、token、密码或 `.env` 文件截图放进证据。
- WeKnora key 失效演练必须先备份 `RAGPortal/.env`，测试后立即恢复。
- 如果只做冒烟测试，可以复读既有 `Phase 1.5` 课题，不新建数据。

## 2. 服务与地址

| 服务      | 地址                      | 健康检查                | 正常结果                        |
| --------- | ------------------------- | ----------------------- | ------------------------------- |
| Plane Web | <http://127.0.0.1:3000>   | 打开首页                | 能进入登录页或工作区            |
| Plane API | <http://127.0.0.1:8001>   | `/api/research/health/` | HTTP 200，`module_enabled=true` |
| RAGPortal | <http://127.0.0.1:8004>   | `/api/health`           | `{"status":"ok"}`               |
| Synlora   | <http://127.0.0.1:8005>   | `/api/health`           | `status=ok`，版本 1.4.x         |
| WeKnora   | <http://10.26.15.93:8000> | 打开根路径              | HTTP 200                        |

本地约定：

```bash
export AI4MS_ROOT=/home/fangyikai/code/_AI4MS
export PLANE_ROOT="$AI4MS_ROOT/plane"
export RAGPORTAL_ROOT="$AI4MS_ROOT/RAGPortal"
export SYNLORA_ROOT="$AI4MS_ROOT/Synlora"
```

## 3. 从零启动环境

> 已在运行的服务不需要重复启动。先执行 §3.5 的健康检查，缺哪个再启动哪个。

### 3.1 启动 Plane

在 `plane` 仓库执行：

```bash
cd "$PLANE_ROOT"
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml up -d
```

如修改过 `apps/api/.env`，必须重建而不是只 restart：

```bash
docker compose -f docker-compose-local.yml -f docker-compose-local.override.yml \
  up -d --force-recreate --no-deps api worker beat-worker
```

启动 Web：

```bash
cd "$PLANE_ROOT"
pnpm --filter web dev
```

说明：

- `pnpm --filter web dev` 会构建并启动 Vite Preview，适合人工测试和局域网访问。
- 需要前端热更新时，另用 `pnpm --filter web dev:hmr`。
- 不要用根目录默认 `docker-compose.yml` 替代本地 compose 配置。

### 3.2 启动 RAGPortal

```bash
tmux new-session -d -s phase15_rag \
  -c "$RAGPORTAL_ROOT/backend" \
  '.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004'
```

查看日志：

```bash
tmux attach-session -t phase15_rag
```

退出 tmux 前台但保持服务运行：按 `Ctrl+b` 后按 `d`。

### 3.3 启动 Synlora

Synlora 必须保持单实例：

```bash
tmux new-session -d -s phase15_syn \
  -c "$SYNLORA_ROOT/apps/web/backend" \
  '.venv/bin/python run_uvicorn.py'
```

查看日志：

```bash
tmux attach-session -t phase15_syn
```

### 3.4 确认 Plane 容器能访问宿主机服务

Plane API 容器内没有 curl，用 Python：

```bash
docker exec -i plane-api-1 python - <<'PY'
import json
import urllib.request

for name, url in [
    ("RAGPortal", "http://172.19.0.1:8004/api/health"),
    ("Synlora", "http://172.19.0.1:8005/api/health"),
]:
    payload = json.load(urllib.request.urlopen(url, timeout=3))
    print(name, payload)
PY
```

预期两个服务均返回正常 JSON。

### 3.5 总健康检查

```bash
curl -fsS http://127.0.0.1:3000/ >/dev/null && echo "Plane Web OK"
curl -fsS http://127.0.0.1:8001/api/research/health/ && echo
curl -fsS http://127.0.0.1:8004/api/health && echo
curl -fsS http://127.0.0.1:8005/api/health && echo
curl -fsS -o /dev/null -w 'WeKnora HTTP %{http_code}\n' http://10.26.15.93:8000/
```

## 4. 登录账号与凭据

账号表只描述测试身份和预期视角。实际密码必须通过本机安全凭据、环境变量或密码管理器注入，不得写入文档、截图、日志或命令历史。

| 账号                           | 密码              | 用途              | 预期视角                               |
| ------------------------------ | ----------------- | ----------------- | -------------------------------------- |
| `liuyang.phd@ai4ms.local`      | `<由本机安全凭据注入>` | 学生 owner 主视角 | 科研总览、研究链；默认无审批中心       |
| `chenjing.advisor@ai4ms.local` | `<由本机安全凭据注入>` | 导师              | 增加审批中心；可写学生课题             |
| `zhangwei.pi@ai4ms.local`      | `<由本机安全凭据注入>` | 课题组 PI         | 可见审批与组织管理视角；业务数据按 ACL |
| `admin@ai4ms.local`            | `<由本机安全凭据注入>`     | 工作区管理员      | 可见科研管理；PRIVATE 课题 fail closed |
| `gaopeng.member@ai4ms.local`   | `<由本机安全凭据注入>` | NONE              | 无科研导航；WORKSPACE 课题只读         |
| `hexue.guest@ai4ms.local`      | `<由本机安全凭据注入>` | Guest             | 无科研导航；课题 API 403               |

建议使用浏览器的多个 profile 或隐私窗口，避免会话互相覆盖。

## 5. 30 分钟 UI 冒烟测试

### MT-01 登录并检查学生导航

1. 用 `liuyang.phd@ai4ms.local` 登录 Plane Web。
2. 进入 `public` 工作区。
3. 查看左侧科研分组。

预期：

- 可见「科研总览」「研究链」。
- 默认不可见「审批中心」和「科研管理」。
- 首页科研摘要能显示当前课题、节点和待办。

### MT-02 创建或选择测试课题

优先复用已有 `Phase 1.5` 课题。若需要新建：

1. 进入「科研 → 研究链」。
2. 切换到「项目 / 课题」视图。
3. 在创建表单填写：
   - 名称：`人工测试-MMDD-你的昵称`
   - 类型：团队科研项目
   - 组织：张伟课题组
   - 研究链类型：研究链
   - 可见性：先选 PRIVATE，后续权限测试再建 WORKSPACE 对照
4. 创建后进入课题详情。

预期：

- 创建成功后能在研究链列表看到新课题。
- Chain 可见性与创建时选择一致。

### MT-03 上传测试文件并确认引用

1. 打开一个研究链课题。
2. 进入「外部引用」页签。
3. 在「RAGPortal 知识库」面板选择知识库。
4. 选择一个小 PDF、Markdown 或 TXT 文件。
5. 点击「通过 BFF 上传」。
6. 点击「刷新状态」，直到状态从 `PENDING/PROCESSING` 变为 `SUCCESS`。
7. 点击「确认引用」。

预期：

- 上传后出现上传记录。
- 状态最终为 `SUCCESS`。
- 引用确认后记录保留，页面不报错。
- 再上传同一文件到同一课题节点，不应产生重复记录。

建议测试文件内容包含唯一标记，例如：

```text
Phase 1.5 manual test marker: manual-mmdd-xxxx
```

### MT-04 测试 Agent 知识检索

1. 在研究链页面选择当前节点。
2. 点击「打开智能体」。
3. 输入：

```text
请必须调用 knowledge.search 工具，检索 “Phase 1.5 manual test marker: manual-mmdd-xxxx”，并引用命中的原文片段。
```

4. 等待 Agent 回复。

预期：

- 会话创建成功，状态为可用。
- Trace 中出现 `knowledge.list` 和 `knowledge.search`。
- 回复引用你上传的测试文件和唯一标记。
- 事件序列单调递增，无重复事件。

### MT-05 推进节点并生成人工确认快照

> 此步骤会修改测试课题状态，只在自建人工测试课题上执行。

1. 进入「节点」页签。
2. 创建或选择一个节点。
3. 依次执行生命周期操作：启动、提交评审、通过。
4. 在 Agent 面板生成或填写一个分析产物。
5. 勾选「人工确认」后保存。

预期：

- 节点状态按预期推进。
- 产物生成 typed snapshot，不是未确认草稿。
- 快照在节点详情中可见且标记为 immutable。

### MT-06 导出研究链并校验 SHA256

1. 打开课题的「报告与成果」页签。
2. 点击「导出研究链」。
3. 保存 Markdown 文件。
4. 在终端计算哈希：

```bash
sha256sum /path/to/research-chain-*.md
```

5. 如需查看响应头，用浏览器开发者工具 Network 面板找到导出请求。

预期：

- 导出文件包含节点、事件、快照和外部引用。
- `X-Research-Chain-SHA256` 与本地 `sha256sum` 结果一致。

## 6. 角色权限人工抽测

> 建议准备一个 WORKSPACE 课题 A 和一个同 owner 的 PRIVATE 课题 B。A 用于工作区可见性，B 用于 fail closed 负例。

| 步骤 | 账号  | 操作     | 预期                                     |
| ---- | ----- | -------- | ---------------------------------------- |
| R-01 | 刘洋  | 查看 A/B | A/B 均可见、可写、可导出                 |
| R-02 | 孙浩  | 查看 A/B | A 可见只读；B 不出现在列表，直闯 404/403 |
| R-03 | 陈静  | 查看 A/B | A/B 均可见可写，体现有效导师绑定         |
| R-04 | 张伟  | 查看 A/B | A/B 可见但默认只读                       |
| R-05 | 李明  | 查看 A/B | A 可见只读；B 不可见                     |
| R-06 | ADMIN | 查看 A/B | A 可见只读；B fail closed                |
| R-07 | 高朋  | 查看 A/B | 无科研导航；直接打开 A 可只读，B 不可见  |
| R-08 | 何雪  | 查看 A/B | 无科研导航；A/B 页面和 API 均无权限      |

检查口径：

1. 侧栏入口。
2. 研究链列表。
3. 详情、导出和写入口。
4. 三者权限口径必须一致；发现不一致立即记录缺陷。

## 7. 功能开关人工抽测

使用 `admin@ai4ms.local` 登录，打开：

```text
/public/research/settings/platform
```

每次只关闭一个开关，验证后立即恢复。不要同时关闭多个开关。

| 开关           | 关闭后重点验证                                | 恢复后回归                    |
| -------------- | --------------------------------------------- | ----------------------------- |
| Research Chain | 研究链入口消失；写入 API 禁用；既有导出仍可用 | 手工添加 Chain 事件成功       |
| Research Agent | 新 Agent 会话被拒；Chain 人工记录不受影响     | 新会话创建成功                |
| External RAG   | 上传降级为人工路径；状态和引用有降级口径      | KB 列表和上传恢复             |
| Account Link   | 新绑定禁用；既有 ACTIVE 绑定保留              | 既有绑定可继续创建 Agent 会话 |
| IA v2          | 旧平铺侧栏恢复；旧路由 query/hash 不丢失      | 新四入口侧栏恢复              |

通过标准：

1. 入口隐藏或降级。
2. API 返回明确禁用或降级口径。
3. 既有数据只读不受损。
4. 其他开关功能不受影响。
5. 恢复开关后对应功能立即恢复。

## 8. 降级演练

### DEG-01 停止 Synlora

```bash
tmux kill-session -t phase15_syn
```

验证：

1. 打开 Agent 页面。
2. 预期显示中文提示：「智能体运行时尚未配置，研究链功能仍可继续使用」。
3. 在研究链节点中添加人工记录。
4. 预期人工记录保存成功。

恢复：

```bash
tmux new-session -d -s phase15_syn \
  -c "$SYNLORA_ROOT/apps/web/backend" \
  '.venv/bin/python run_uvicorn.py'
```

恢复后重新打开 Agent，确认可创建会话且事件不重复。

### DEG-02 停止 RAGPortal

```bash
tmux kill-session -t phase15_rag
```

验证：

1. 外部引用页显示 RAGPortal 降级。
2. 预期中文提示包含「网络传输失败」和「人工记录可继续」。
3. 上传返回降级口径，但不影响 Chain 人工记录。

恢复：

```bash
tmux new-session -d -s phase15_rag \
  -c "$RAGPORTAL_ROOT/backend" \
  '.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004'
```

恢复后点击「刷新」，预期知识库列表恢复。

### DEG-03 模拟 WeKnora key 失效

> 仅管理员执行；必须先备份并立即恢复。

```bash
cp "$RAGPORTAL_ROOT/.env" /tmp/ragportal.env.backup
sed -i 's#^WEKNORA_API_KEY=.*#WEKNORA_API_KEY=manual-test-invalid-key#' "$RAGPORTAL_ROOT/.env"
tmux kill-session -t phase15_rag
tmux new-session -d -s phase15_rag \
  -c "$RAGPORTAL_ROOT/backend" \
  '.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004'
```

验证：

1. 外部引用页出现「认证失败」中文提示。
2. 上传走人工记录路径。
3. Chain 人工记录不受阻断。

恢复：

```bash
tmux kill-session -t phase15_rag
cp /tmp/ragportal.env.backup "$RAGPORTAL_ROOT/.env"
tmux new-session -d -s phase15_rag \
  -c "$RAGPORTAL_ROOT/backend" \
  '.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8004'
```

恢复后必须重测：

1. WeKnora 根路径 HTTP 200。
2. BFF 知识库列表恢复测试知识库。
3. 重新上传刚才失败的文件。
4. 状态最终 `SUCCESS`，且同 hash 不产生重复记录。

## 9. 证据留痕

人工测试如需归档，将脱敏截图或记录放到：

```text
docs/evidence/phase-1.5/manual/
```

命名格式：

```text
YYYYMMDD-MT-序号-说明.png
YYYYMMDD-DEG-序号-说明.md
```

每条证据建议包含：

1. 测试时间。
2. 测试账号；隐藏邮箱时可以只写角色。
3. 页面 URL 路径。
4. 关键状态或响应。
5. 是否恢复现场。

禁止归档：

- API key、token、密码。
- `.env` 文件截图。
- 完整请求 Authorization 头。
- 生产数据截图。

## 10. 常见问题与处理

| 现象                            | 可能原因                        | 处理                                                                  |
| ------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| Plane Web 打不开                | Web 未启动或 3000 被占用        | `ss -ltnp \| grep :3000`；重启 `pnpm --filter web dev`                |
| Plane API 502 或连接拒绝        | API 容器未启动或正在重启        | 使用本地 compose 配置重建 api/worker/beat                             |
| RAGPortal 上传一直处理中        | WeKnora 解析队列仍在运行        | 点击刷新，等待 1–3 分钟；仍失败查看 RAGPortal 日志                    |
| Agent 会话 422 无可用模型       | Synlora 没有启用的模型 provider | 管理员在 Synlora 配置 OpenAI-compatible provider；不要把 key 写入文档 |
| Agent 403 context token invalid | Context 过期或切换节点          | 关闭并重新打开 Agent，创建新会话                                      |
| WeKnora 认证失败                | `WEKNORA_API_KEY` 错误或被替换  | 立即恢复备份 `.env` 并重启 RAGPortal                                  |
| 登录提示 Rate limit             | 连续切换账号过快                | 等待限制解除；使用独立浏览器 profile                                  |
| NONE 用户看不到研究链入口       | 符合设计                        | 直接访问 WORKSPACE 课题 URL 验证只读能力                              |
| 停止服务后进程仍存在            | tmux 会话名不一致               | `tmux ls` 确认后 kill 对应 session                                    |

## 11. 人工测试通过清单

- [ ] 五个服务健康检查全部通过。
- [ ] 学生能登录并看到科研总览与研究链。
- [ ] 能上传测试文档、轮询到 SUCCESS、确认引用。
- [ ] Agent 能调用 `knowledge.search` 命中唯一标记。
- [ ] 人工确认产物生成 typed snapshot。
- [ ] Markdown 导出成功，响应头 hash 与文件 hash 一致。
- [ ] 至少抽测学生、导师、PI、ADMIN、NONE、Guest 六个角色。
- [ ] 至少抽测一个非 IA v2 开关和 IA v2 开关。
- [ ] 至少完成一项降级演练并恢复现场。
- [ ] 测试数据命名清楚，没有污染生产或非测试知识库。
