import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@plane/propel/button";
import { UnifiedMCPService, type UnifiedApiDocs } from "@/services/unified-mcp.service";
import { WeeklyReportMCPService, type WeeklyReportApiDocs } from "@/services/weekly-report-mcp.service";
import type { McpApiTool } from "@/services/mcp-api-types";

type ApiDocs = UnifiedApiDocs | WeeklyReportApiDocs;
type StatusFilter = "all" | "available" | "unavailable";
type DetailTab = "example" | "schema" | "actions";

const GROUP_LABELS: Record<string, string> = {
  general_read: "通用读取",
  administrative_project: "行政项目",
  administrative_task: "行政任务",
  research_lifecycle: "科研项目 / 研究链 / 节点",
  research_proposal: "科研提案",
  receipt: "创建回执",
  weekly_read: "周报读取",
  weekly_write_review: "周报写操作与审阅",
  weekly_proposal_recovery: "周报提案恢复",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

/** 登录态 MCP API 文档页；展示完整目录、可用性与用法，不加载或保存密钥。 */
export function MCPApiDocs({
  kind,
  connectionId,
  workspaceSlug,
}: {
  kind: "project" | "weekly-report";
  connectionId: string;
  workspaceSlug?: string;
}) {
  const [docs, setDocs] = useState<ApiDocs>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [group, setGroup] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value =
        kind === "weekly-report" && workspaceSlug
          ? await new WeeklyReportMCPService().tools(workspaceSlug, connectionId)
          : await new UnifiedMCPService().tools(connectionId);
      setDocs(value);
    } catch {
      setError("API 文档暂时无法加载，请确认连接仍存在后重试。");
    } finally {
      setLoading(false);
    }
  }, [connectionId, kind, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load, epoch]);

  const catalog = useMemo(() => (docs?.catalog.length ? docs.catalog : (docs?.tools ?? [])), [docs]);
  const availableGroups = useMemo(
    () => GROUP_ORDER.filter((item) => catalog.some((tool) => tool.group === item)),
    [catalog]
  );
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return catalog.filter((tool) => {
      if (status === "available" && !tool.availability.enabled) return false;
      if (status === "unavailable" && tool.availability.enabled) return false;
      if (group !== "all" && tool.group !== group) return false;
      if (!keyword) return true;
      const searchable = [
        tool.name,
        tool.description,
        GROUP_LABELS[tool.group] ?? tool.group,
        tool.usage.when_to_use,
        tool.availability.reason,
        tool.availability.required_connection_scope ?? "",
        tool.availability.required_actions?.join(" ") ?? "",
      ]
        .join("\n")
        .toLowerCase();
      return searchable.includes(keyword);
    });
  }, [catalog, group, query, status]);
  const selected = filtered.find((tool) => tool.name === selectedId) ?? filtered[0];
  const summary =
    docs?.catalog_summary ??
    (docs ? { total: docs.tools.length, available: docs.tools.length, unavailable: 0 } : undefined);

  return (
    <div data-testid="mcp-api-docs-page" className="flex h-full min-h-0 flex-col bg-canvas text-primary">
      <header className="shrink-0 space-y-3 border-b border-subtle bg-surface-1 px-4 py-3 md:px-6 md:py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-20 font-semibold break-words md:text-24">
                {docs ? ("name" in docs.connection ? docs.connection.name : docs.connection.label) : "MCP 连接"}
              </h1>
              <span className="rounded border border-subtle px-2 py-0.5 text-12 text-secondary">
                {kind === "weekly-report" ? "周报" : "项目 / 科研"}
              </span>
            </div>
            <p className="text-13 text-secondary">
              {docs
                ? `${docs.server.name} ${docs.server.version} · ${docs.server.protocol_version}`
                : "正在读取连接契约"}
            </p>
          </div>
          {docs && (
            <a
              className="text-13 font-medium text-accent-primary"
              href={docs.server.docs_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              在新窗口打开
            </a>
          )}
        </div>

        {summary && (
          <div className="grid grid-cols-2 items-center gap-x-4 gap-y-1.5 text-13 md:flex md:flex-wrap md:gap-x-5 md:gap-y-2">
            <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-4 md:col-span-1 md:contents">
              <span className="font-medium">全部 {summary.total}</span>
              <span className="text-accent-primary">可用 {summary.available}</span>
              <span className="text-secondary">未授权 {summary.unavailable}</span>
            </div>
            <div className="min-w-0 md:contents">
              {docs && <CopyValue label="server key" value={docs.server.server_key} />}
            </div>
            <div className="min-w-0 md:contents">
              {docs && <CopyValue label="认证头" value={docs.server.auth_header} />}
            </div>
            <div className="col-span-2 min-w-0 md:contents">
              {docs && <CopyValue label="端点" value={docs.server.url} />}
            </div>
          </div>
        )}
        <p className="text-12 text-secondary">
          本页显示全部 API；可用仅代表当前连接已授权，实际调用仍受对象级权限限制。
        </p>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1fr)_140px_220px]">
          <label className="col-span-2 block min-w-0 space-y-1 text-12 text-secondary md:col-span-1">
            <span>搜索 API</span>
            <input
              aria-label="搜索 API"
              className="focus:border-accent-primary h-9 w-full rounded border border-subtle bg-surface-1 px-3 text-13 text-primary outline-none"
              value={query}
              placeholder="工具名、用途或授权"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
            />
          </label>
          <label className="block space-y-1 text-12 text-secondary">
            <span>状态筛选</span>
            <select
              aria-label="状态筛选"
              className="h-9 w-full rounded border border-subtle bg-surface-1 px-2 text-13 text-primary"
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
            >
              <option value="all">全部</option>
              <option value="available">可用</option>
              <option value="unavailable">未授权</option>
            </select>
          </label>
          <label className="hidden space-y-1 text-12 text-secondary md:block">
            <span>分组筛选</span>
            <select
              aria-label="分组筛选"
              className="h-9 w-full rounded border border-subtle bg-surface-1 px-2 text-13 text-primary"
              value={group}
              onChange={(event) => setGroup(event.target.value)}
            >
              <option value="all">全部分组</option>
              {availableGroups.map((item) => (
                <option key={item} value={item}>
                  {GROUP_LABELS[item]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading && (
        <p role="status" className="flex items-center justify-center py-10 text-13 text-secondary">
          正在加载 API 列表…
        </p>
      )}
      {error && (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-13">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setEpoch((value) => value + 1)}>
            重试
          </Button>
        </div>
      )}

      {docs && (
        <div className="mx-auto min-h-0 w-full max-w-7xl flex-1 overflow-y-auto md:overflow-hidden">
          <div className="md:flex md:h-full md:min-h-0">
            <aside
              data-testid="mcp-api-index"
              aria-label="API 索引"
              className="w-full shrink-0 border-subtle md:h-full md:w-72 md:overflow-y-auto md:border-r"
            >
              <nav
                aria-label="API 分组导航"
                className="sticky top-0 z-10 border-b border-subtle bg-canvas px-3 py-2 md:hidden"
              >
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {[
                    { key: "all", label: "全部" },
                    ...availableGroups.map((key) => ({ key, label: GROUP_LABELS[key] })),
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-current={group === item.key ? "true" : undefined}
                      className={`shrink-0 rounded border px-2.5 py-1 text-12 transition-colors ${
                        group === item.key
                          ? "border-accent-primary font-medium text-accent-primary"
                          : "border-subtle text-secondary hover:bg-surface-2"
                      }`}
                      onClick={() => setGroup(item.key)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </nav>
              <nav className="space-y-4 px-3 py-4">
                {availableGroups.map((groupKey) => {
                  const groupTools = filtered.filter((tool) => tool.group === groupKey);
                  if (!groupTools.length) return null;
                  const allGroupTools = catalog.filter((tool) => tool.group === groupKey);
                  const availableCount = allGroupTools.filter((tool) => tool.availability.enabled).length;
                  return (
                    <section key={groupKey} aria-label={GROUP_LABELS[groupKey]} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2 px-2">
                        <h2 className="text-12 font-semibold">{GROUP_LABELS[groupKey]}</h2>
                        <span className="text-11 text-secondary">
                          {availableCount}/{allGroupTools.length}
                        </span>
                      </div>
                      <ul className="space-y-0.5">
                        {groupTools.map((tool) => (
                          <li key={tool.name}>
                            <button
                              type="button"
                              aria-current={selected?.name === tool.name ? "true" : undefined}
                              className={`flex w-full items-center gap-2 rounded border-l-2 px-2 py-1.5 text-left text-13 transition-colors ${
                                selected?.name === tool.name
                                  ? "border-accent-primary bg-surface-2 font-medium"
                                  : "border-transparent hover:bg-surface-2"
                              }`}
                              onClick={() => setSelectedId(tool.name)}
                            >
                              <span
                                aria-hidden="true"
                                className={`size-1.5 shrink-0 rounded-full ${
                                  tool.availability.enabled ? "bg-accent-primary" : "bg-secondary"
                                }`}
                              />
                              <span className="font-mono min-w-0 flex-1 truncate text-12">{tool.name}</span>
                              <span className="shrink-0 text-11 text-secondary">
                                {tool.execution_mode === "proposal" ? "P" : "D"}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
                {!filtered.length && <p className="px-2 py-6 text-13 text-secondary">没有匹配的 API。</p>}
                {docs.workspaces.length > 0 && <WorkspaceAccess docs={docs} />}
              </nav>
            </aside>

            <main
              data-testid="mcp-api-detail"
              className="min-w-0 md:h-full md:flex-1 md:overflow-y-auto"
              aria-label="API 详情"
            >
              {selected ? (
                <ToolDetail key={selected.name} tool={selected} />
              ) : (
                <div className="space-y-2 px-6 py-10 text-13">
                  <p className="font-medium">没有匹配的 API。</p>
                  <p className="text-secondary">请调整搜索词、状态或分组后重试。</p>
                </div>
              )}
            </main>
          </div>
        </div>
      )}
    </div>
  );
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-secondary">{label}</span>
      <code className="font-mono min-w-0 truncate text-12">{value}</code>
      <button
        type="button"
        className="shrink-0 text-12 text-accent-primary hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
              return undefined;
            },
            () => setCopied(false)
          );
        }}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </span>
  );
}

function WorkspaceAccess({ docs }: { docs: ApiDocs }) {
  return (
    <section aria-label="实时访问" className="mt-6 space-y-2 border-t border-subtle pt-4">
      <h2 className="px-2 text-12 font-semibold">实时访问</h2>
      <dl className="space-y-2 px-2 text-12">
        {docs.workspaces.map((workspace) => {
          const roleContext = workspace.role_context as { roles?: unknown; org_units?: unknown[] } | null;
          const roles = Array.isArray(roleContext?.roles) ? roleContext.roles.map(String) : [];
          const orgCount = Array.isArray(roleContext?.org_units) ? roleContext.org_units.length : 0;
          const authorized =
            "authorized_domains" in workspace
              ? Object.entries(workspace.authorized_domains)
                  .map(([key, value]) => `${key}:${value}`)
                  .join("；")
              : workspace.authorized_actions.join("；");
          const live =
            "live_domains" in workspace
              ? Object.entries(workspace.live_domains)
                  .map(([key, value]) => `${key}:${value}`)
                  .join("；")
              : workspace.live_actions.join("；");
          return (
            <div key={workspace.id} className="space-y-1 border border-subtle bg-surface-2 p-2">
              <div className="flex items-center justify-between gap-2">
                <dt className="font-medium">{workspace.name}</dt>
                <dd className="text-secondary">{workspace.live_access ? "可访问" : "不可访问"}</dd>
              </div>
              <div>
                <dt className="inline text-secondary">已授权：</dt>
                <dd className="inline">{authorized || "无"}</dd>
              </div>
              <div>
                <dt className="inline text-secondary">实时可用：</dt>
                <dd className="inline">{live || "无"}</dd>
              </div>
              <div>
                <dt className="inline text-secondary">角色：</dt>
                <dd className="inline">{roles.join("、") || "无"}</dd>
              </div>
              <div>
                <dt className="inline text-secondary">组织单元：</dt>
                <dd className="inline">{orgCount}</dd>
              </div>
              <details>
                <summary className="cursor-pointer text-secondary">查看完整角色上下文</summary>
                <pre className="font-mono mt-1 max-h-48 overflow-auto text-11">
                  {JSON.stringify(workspace.role_context ?? {}, null, 2)}
                </pre>
              </details>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function ToolDetail({ tool }: { tool: McpApiTool }) {
  const [tab, setTab] = useState<DetailTab>("example");
  const required =
    tool.availability.required_connection_scope ?? tool.availability.required_actions?.join("、") ?? "本人周报上下文";
  const tabs = [
    { id: "example" as const, label: "示例" },
    { id: "schema" as const, label: "Input schema" },
    ...(tool.usage.action_examples ? [{ id: "actions" as const, label: "动作示例" }] : []),
  ];

  return (
    <article className="space-y-5 px-4 py-5 md:px-7 md:py-6">
      <header className="space-y-3 border-b border-subtle pb-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-mono min-w-0 text-18 font-semibold break-all">{tool.name}</h2>
          <span
            className={`rounded border px-2 py-0.5 text-12 ${
              tool.availability.enabled
                ? "border-accent-primary/30 text-accent-primary"
                : "border-subtle text-secondary"
            }`}
          >
            {tool.availability.enabled ? "可用" : "未授权"}
          </span>
        </div>
        <p className="text-13">{tool.description}</p>
        <p className="text-12 text-secondary">
          {GROUP_LABELS[tool.group] ?? tool.group} · {tool.execution_mode} · {tool.availability.reason}
        </p>
      </header>

      <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <section aria-label="授权与权限" className="space-y-2">
          <h3 className="text-12 font-semibold text-secondary">授权与权限</h3>
          <dl className="space-y-2 text-13">
            <div>
              <dt className="text-secondary">所需连接授权</dt>
              <dd>{required}</dd>
            </div>
            {tool.availability.object_level_permission && (
              <div>
                <dt className="text-secondary">对象级权限</dt>
                <dd>{tool.availability.object_level_permission}</dd>
              </div>
            )}
            <div>
              <dt className="text-secondary">执行方式</dt>
              <dd>{tool.execution_mode}</dd>
            </div>
          </dl>
          {tool.action_availability && (
            <div className="space-y-2">
              <h4 className="text-12 font-semibold text-secondary">周报动作授权</h4>
              <dl className="divide-y divide-subtle border-y border-subtle">
                {Object.entries(tool.action_availability).map(([action, availability]) => (
                  <div key={action} className="flex items-center justify-between gap-3 py-2 text-12">
                    <dt>
                      {tool.usage.action_examples?.[action] ? (
                        <button
                          type="button"
                          className="font-mono text-accent-primary hover:underline"
                          onClick={() => setTab("actions")}
                        >
                          {action}
                        </button>
                      ) : (
                        <span className="font-mono">{action}</span>
                      )}
                    </dt>
                    <dd className={availability.enabled ? "" : "text-secondary"}>
                      {availability.enabled ? "可用" : availability.reason}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </section>

        <section aria-label="使用方法" className="space-y-2">
          <h3 className="text-12 font-semibold text-secondary">使用方法</h3>
          <p className="text-13">{tool.usage.when_to_use}</p>
          <ol className="list-decimal space-y-1 pl-5 text-13">
            {tool.usage.workflow.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </section>
      </div>

      <section aria-label="参数与示例" className="space-y-3">
        <div role="tablist" aria-label="API 内容视图" className="flex gap-1 border-b border-subtle">
          {tabs.map((item) => (
            <button
              key={item.id}
              id={`api-docs-tab-${tool.name}-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`api-docs-panel-${tool.name}-${item.id}`}
              className={`px-3 py-2 text-13 ${
                tab === item.id ? "border-accent-primary border-b-2 font-medium" : "text-secondary"
              }`}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`api-docs-panel-${tool.name}-${tab}`}
          aria-labelledby={`api-docs-tab-${tool.name}-${tab}`}
          className="min-h-0"
        >
          {tab === "example" && <CodeBlock value={JSON.stringify(tool.usage.example, null, 2)} caption="示例参数" />}
          {tab === "schema" && (
            <CodeBlock value={JSON.stringify(tool.inputSchema, null, 2)} caption="完整 input schema" />
          )}
          {tab === "actions" && tool.usage.action_examples && (
            <div className="space-y-4">
              {Object.entries(tool.usage.action_examples).map(([action, example]) => (
                <CodeBlock key={action} value={JSON.stringify(example, null, 2)} caption={`动作示例：${action}`} />
              ))}
            </div>
          )}
        </div>
      </section>
    </article>
  );
}

function CodeBlock({ value, caption }: { value: string; caption: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-12 font-semibold text-secondary">{caption}</h4>
        <button
          type="button"
          className="text-12 text-accent-primary hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
                return undefined;
              },
              () => setCopied(false)
            );
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="font-mono max-h-80 overflow-auto rounded border border-subtle bg-surface-2 p-3 text-12">
        {value}
      </pre>
    </section>
  );
}
