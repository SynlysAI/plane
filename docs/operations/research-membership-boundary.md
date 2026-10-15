# 科研组织成员边界与发布检查

## 权限口径

- 只有当前工作区科研组织树中的有效成员可以进入科研 API 与科研导航；成员关系必须在生效期内，所属组织节点未删除且未停用。
- 工作区管理员、实例管理员、主 PI 配置、科研档案、导师绑定、阶段评审指派和行政组织成员身份都不能单独授予科研入口。
- 无科研组织身份的行政人员继续使用 Plane 原生项目权限与行政组织项目树，不显示科研链入口。

## 发布前审计

在 API 容器内执行：

```bash
python manage.py audit_research_membership_boundary <workspace_slug>
python manage.py audit_research_membership_boundary <workspace_slug> --json
```

命令只读，会列出仍拥有旧科研信号但没有有效科研组织关系的账号及原因。确实需要保留科研权限的账号，先由科研组织管理员加入有效组织节点，再发布本版本；仅需行政权限的账号无需处理。
