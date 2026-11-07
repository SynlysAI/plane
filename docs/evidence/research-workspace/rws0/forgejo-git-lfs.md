# RWS-0 Forgejo Git/LFS/PR/Webhook 验证

| 项目         | 内容                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| 时间         | 2026-11-07 18:18–18:49 +08                                                |
| 环境         | 本地隔离 Docker POC                                                       |
| Forgejo 版本 | `15.0.11+gitea-1.22.0`                                                    |
| 镜像         | `data.forgejo.org/forgejo/forgejo:15`                                     |
| 镜像 digest  | `sha256:5d050e6d623e540923ff54b1c0c7acf41c3f9174a6c7ad515cc0c63d703fcd22` |
| 数据         | 独立 Docker volume `rws0-forgejo-data`                                    |
| 暴露端口     | 仅 `127.0.0.1:3010->3000`                                                 |

## 1. 部署与初始化

实测结果：

- Forgejo 容器启动成功。
- `forgejo --version` 返回 `15.0.11+gitea-1.22.0`。
- Git 版本为 `2.52.0`。
- SQLite 初始化成功。
- LFS 存储初始化于 `/data/git/lfs`。
- SSH 服务按 POC 配置禁用，仅验证 HTTPS。

重要纠偏：

- `FORGEJO__lfs__START=true` 不是 LFS HTTP 服务开关。
- 正确配置为 `FORGEJO__server__LFS_START_SERVER=true`。
- 修正后日志出现 `LFS server enabled`，Git LFS push 成功。

## 2. 测试用户与仓库

创建的实际 Forgejo 用户：

- `rws0-student`
- `rws0-mentor`
- `rws0-admin`

用户 token 均由 Forgejo CLI 生成，只保存在本机临时文件，未进入 Git。测试后已撤销导师协作者身份。

仓库：

```text
rws0-student/coffee-study-rws0
```

属性：

- private。
- `main` 为默认分支。
- Git object format 为 SHA-256。
- `main` 分支保护开启：
  - 禁止直推；
  - 允许 merge whitelist；
  - 需要 1 个 approval；
  - 规则对 admin 生效。

## 3. 两用户 HTTPS Git 协作

实测流程：

1. `rws0-student` HTTPS clone。
2. 创建 `user/rws0-student/literature`。
3. 提交 Markdown、`.research/workspace.yaml` 和 1 MiB Git LFS 二进制。
4. 推送分支。
5. `rws0-mentor` HTTPS clone。
6. Fetch 学生分支并追加 `literature/mentor-review.md`。
7. 推送同一分支。
8. 学生创建 PR。
9. 导师提交 official `APPROVED` review。
10. 导师通过 merge API 合入 `main`。

关键结果：

| 项目                | 值                                                                 |
| ------------------- | ------------------------------------------------------------------ |
| 学生提交            | `0d3afeec55096035cd7dc73d00e401f1748bf1ef3bb000fa32eb8ac50a123d57` |
| 导师追加后分支 HEAD | `0bf51e108e43754a0dce54bd14859f0aa7f0c7be1ede79a6f1ab9607c5bc8a08` |
| PR                  | `#1`                                                               |
| Review              | `APPROVED`，official = true                                        |
| Merge commit        | `2f9afbeed7fca31379e023df30b2e1c2cd16566794b30e53248dfbeebef23b92` |
| 合并者              | `rws0-mentor`                                                      |

## 4. Git LFS

初始 LFS 文件：

```text
path: literature/coffee-signal.bin
size: 1048576
sha256: 73ec1a4899fad56c45ccbda8582bd79127aaa6a416fee25386fa210d9dacd483
```

实测：

1. `git lfs track "*.bin"` 生效。
2. Push 时 LFS object 上传成功。
3. 删除本地副本后重新 clean clone。
4. LFS smudge 还原文件。
5. Clean clone 后 sha256 与源值一致。
6. `git lfs ls-files --long` 显示同 hash。

## 5. HTTPS 鉴权与撤权

### 5.1 原生 token 鉴权

- 学生 token 可 clone、push、创建仓库、创建 PR。
- 导师作为 write collaborator 可 clone、推送协作分支、review 和 merge。
- 仅具备 `write:repository,read:user` 的 token 调用 `POST /user/repos` 返回 403，Forgejo 要求补 `write:user` scope。

### 5.2 匿名访问

匿名 Git `ls-remote` 失败，退出码 128：

```text
could not read Username ... terminal prompts disabled
```

匿名 LFS batch 请求在携带正确 `Accept: application/vnd.git-lfs+json` 时返回：

```text
HTTP 401 Unauthorized
```

### 5.3 撤销导师协作者

学生删除导师 collaborator 后：

- API 返回 204。
- 导师原 token 仍有效，但对私有仓库 fetch 失败。
- Git 返回 `Repository not found`，退出码 128。

结论：Forgejo native repository ACL 撤权可对仍有效的个人 token fail-closed。

## 6. Reverse proxy auth

临时网关：

- Caddy 监听 `127.0.0.1:3011`。
- 反向代理到 `127.0.0.1:3010`。
- 注入 `X-WEBAUTH-USER: rws0-student`。
- Forgejo 信任代理范围仅 `127.0.0.0/8,::1/128`。

实测：

- 直接匿名 `/api/v1/user` 返回 401。
- 经网关访问 LFS batch 返回 200。
- 经网关无需 Git token 完成 clone。
- 经网关推送 `proxy/reverse-auth-2` 成功。
- 推送包含 2 MiB LFS object，上传成功。

反向代理验证分支：

```text
proxy/reverse-auth-2
HEAD: cf886374ec71b890bfa62d950319f596a69980aa8cd425985ddbf931dc5c0e27
LFS sha256: bb1feadbfb0f5a32ae59fc743890aa49e35c70c5005d8d662b66d9e25423fe1f
```

安全结论：

1. Forgejo reverse proxy auth 覆盖 Git Smart HTTP 和 LFS。
2. API `/api/v1/user` 在该配置下仍要求 token，不能仅凭反代身份读取。
3. 生产中 Forgejo 原生端口必须留在内网，不能让用户直连并伪造 trusted header。
4. Gateway 必须先完成自身认证，再注入身份头。

## 7. `main` 分支保护

导师在本地 `main` 制造直推提交后推送：

```text
remote: Forgejo: Not allowed to push to protected branch main
! [remote rejected] main -> main (pre-receive hook declined)
```

结论：PR whitelist + protected main 对原生 HTTPS push 生效。

## 8. Webhook

配置：

- Forgejo hook type：`forgejo`。
- Event：`push`。
- Content type：JSON。
- URL：本机临时接收端。
- Secret：仅保存在本机临时文件。
- `webhook.ALLOWED_HOST_LIST` 必须显式允许内网接收端地址。

最终验证推送：

```text
branch: webhook/rws0-proof-5
HEAD: c300e8773f8cfa77e99bf0ee72c3cf6e0a69e7fe40da3b6510587d268e5c7bd4
delivery: 487e1482-c935-4be9-a134-9819d11f6b9f
```

接收端校验：

- `X-Forgejo-Event: push`
- `X-Forgejo-Delivery` 存在。
- `X-Hub-Signature-256` 存在。
- 使用 webhook secret 重算 HMAC-SHA256 后签名匹配。
- Payload `ref` 与 push 分支一致。

结论：Forgejo webhook 签名、delivery ID、push payload 和允许地址策略均可用于后续 Plane 集成。

## 9. 保留事项

- 本验证是本地隔离 POC，不代表生产 Forgejo 已部署。
- `ALLOWED_HOST_LIST` 必须按实际 Plane / Runner 内网地址重新配置。
- 生产不能信任用户可直达的 Forgejo 端口。
- 后续 P1/P2 需将以上操作脚本化并加入自动化契约测试。
