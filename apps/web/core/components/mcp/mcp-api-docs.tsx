import { useCallback, useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import { UnifiedMCPService, type UnifiedApiDocs } from "@/services/unified-mcp.service";
import { WeeklyReportMCPService, type WeeklyReportApiDocs } from "@/services/weekly-report-mcp.service";
import type { McpApiTool } from "@/services/mcp-api-types";

type ApiDocs = UnifiedApiDocs | WeeklyReportApiDocs;

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
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [epoch, setEpoch] = useState(0);

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

  const catalog = docs?.catalog.length ? docs.catalog : (docs?.tools ?? []);
  const visibleTools = onlyAvailable ? catalog.filter((tool) => tool.availability.enabled) : catalog;
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    tools: visibleTools.filter((tool) => tool.group === group),
  })).filter((section) => section.tools.length > 0);

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="space-y-3 border-b border-subtle pb-6">
        <p className="text-12 tracking-wide text-secondary uppercase">MCP API Reference</p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-24 font-semibold break-words">
              {docs ? ("name" in docs.connection ? docs.connection.name : docs.connection.label) : "MCP 连接"}
            </h1>
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
      </header>

      {loading && (
        <p role="status" className="py-8 text-13 text-secondary">
          正在加载 API 列表…
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-3 py-8 text-13">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setEpoch((value) => value + 1)}>
            重试
          </Button>
        </div>
      )}

      {docs && (
        <div className="space-y-8 py-7">
          <section aria-label="服务信息" className="grid gap-5 border-b border-subtle pb-7 md:grid-cols-2">
            <div className="space-y-2">
              <h2 className="text-15 font-semibold">服务</h2>
              <dl className="space-y-2 text-13">
                <div className="flex gap-3">
                  <dt className="w-28 shrink-0 text-secondary">server key</dt>
                  <dd className="font-mono min-w-0 break-all">{docs.server.server_key}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-28 shrink-0 text-secondary">端点</dt>
                  <dd className="font-mono min-w-0 break-all">{docs.server.url}</dd>
                </div>
                <div className="flex gap-3">
                  <dt className="w-28 shrink-0 text-secondary">认证头</dt>
                  <dd className="font-mono">{docs.server.auth_header}</dd>
                </div>
              </dl>
            </div>
            <div className="space-y-2">
              <h2 className="text-15 font-semibold">实时访问</h2>
              <div className="space-y-3 text-13">
                {docs.workspaces.map((workspace) => (
                  <article key={workspace.id} className="border border-subtle bg-surface-2 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-medium">{workspace.name}</h3>
                      <span className="text-12 text-secondary">
                        {workspace.live_access ? "可访问" : "当前不可访问"}
                      </span>
                    </div>
                    <pre className="font-mono mt-2 max-h-48 overflow-auto text-12 text-secondary">
                      {JSON.stringify(workspace.role_context ?? {}, null, 2)}
                    </pre>
                  </article>
                ))}
              </div>
            </div>
          </section>

          <section aria-label="目录说明" className="space-y-3 border-b border-subtle pb-7">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <h2 className="text-15 font-semibold">完整 API 目录</h2>
                <p className="max-w-3xl text-13 text-secondary">
                  本页显示全部
                  API。“可用”只表示当前连接已授权；实际调用仍会实时检查项目、研究链、节点、报告和审批路由级权限。
                </p>
              </div>
              {docs.catalog_summary && (
                <dl className="grid shrink-0 grid-cols-3 gap-4 border border-subtle bg-surface-2 px-4 py-3 text-center text-13">
                  <div>
                    <dt className="text-12 text-secondary">全部</dt>
                    <dd className="text-18 font-semibold">{docs.catalog_summary.total}</dd>
                  </div>
                  <div>
                    <dt className="text-12 text-secondary">可用</dt>
                    <dd className="text-18 font-semibold">{docs.catalog_summary.available}</dd>
                  </div>
                  <div>
                    <dt className="text-12 text-secondary">未授权</dt>
                    <dd className="text-18 font-semibold">{docs.catalog_summary.unavailable}</dd>
                  </div>
                </dl>
              )}
            </div>
            <label className="flex items-center gap-2 text-13">
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(event) => setOnlyAvailable(event.target.checked)}
              />
              只看当前连接可用
            </label>
          </section>

          {grouped.map((section) => (
            <section key={section.group} aria-label={GROUP_LABELS[section.group]} className="space-y-4">
              <div className="flex items-baseline justify-between gap-4 border-b border-subtle pb-2">
                <h2 className="text-16 font-semibold">{GROUP_LABELS[section.group]}</h2>
                <span className="text-12 text-secondary">{section.tools.length} tools</span>
              </div>
              <div className="divide-y divide-subtle border-y border-subtle">
                {section.tools.map((tool) => (
                  <ToolCard key={tool.name} tool={tool} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function ToolCard({ tool }: { tool: McpApiTool }) {
  const required =
    tool.availability.required_connection_scope ?? tool.availability.required_actions?.join("、") ?? "本人周报上下文";
  return (
    <details open className="px-1 py-4">
      <summary className="flex cursor-pointer flex-wrap items-center gap-3 py-1">
        <span className="font-mono text-13 font-medium">{tool.name}</span>
        <span
          className={`rounded border px-2 py-0.5 text-12 ${
            tool.availability.enabled ? "border-accent-primary/30 text-accent-primary" : "border-subtle text-secondary"
          }`}
        >
          {tool.availability.enabled ? "可用" : "未授权"}
        </span>
        <span className="text-12 text-secondary">{tool.execution_mode}</span>
      </summary>
      <div className="space-y-5 pt-4 text-13">
        <p>{tool.description}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <section className="space-y-2">
            <h3 className="text-12 font-semibold text-secondary">可用性</h3>
            <p>{tool.availability.reason}</p>
            <p className="text-secondary">所需连接授权：{required}</p>
            {tool.availability.object_level_permission && (
              <p className="text-secondary">对象级权限：{tool.availability.object_level_permission}</p>
            )}
            {tool.action_availability && (
              <dl className="mt-2 divide-y divide-subtle border-y border-subtle">
                {Object.entries(tool.action_availability).map(([action, availability]) => (
                  <div key={action} className="flex items-center justify-between gap-3 py-2">
                    <dt className="font-mono text-12">{action}</dt>
                    <dd className={availability.enabled ? "" : "text-secondary"}>
                      {availability.enabled ? "可用" : availability.reason}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          <section className="space-y-2">
            <h3 className="text-12 font-semibold text-secondary">何时使用</h3>
            <p>{tool.usage.when_to_use}</p>
            <h3 className="mt-3 text-12 font-semibold text-secondary">推荐步骤</h3>
            <ol className="list-decimal space-y-1 pl-5">
              {tool.usage.workflow.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>
        </div>
        <section className="space-y-2">
          <h3 className="text-12 font-semibold text-secondary">示例参数</h3>
          <pre className="font-mono max-h-72 overflow-auto border border-subtle bg-surface-2 p-3 text-12">
            {JSON.stringify(tool.usage.example, null, 2)}
          </pre>
          {tool.usage.action_examples && (
            <div className="space-y-2">
              <h4 className="text-12 font-semibold text-secondary">按动作分支的示例</h4>
              {Object.entries(tool.usage.action_examples).map(([action, example]) => (
                <div key={action} className="space-y-1">
                  <p className="font-mono text-12">{action}</p>
                  <pre className="font-mono max-h-56 overflow-auto border border-subtle bg-surface-2 p-3 text-12">
                    {JSON.stringify(example, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </section>
        <details className="space-y-2">
          <summary className="cursor-pointer text-12 font-semibold text-secondary">完整 input schema</summary>
          <pre className="font-mono max-h-96 overflow-auto border border-subtle bg-surface-2 p-3 text-12">
            {JSON.stringify(tool.inputSchema, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}
