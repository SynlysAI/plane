import { useCallback, useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import { UnifiedMCPService, type UnifiedApiDocs } from "@/services/unified-mcp.service";
import { WeeklyReportMCPService, type WeeklyReportApiDocs } from "@/services/weekly-report-mcp.service";

type ApiDocs = UnifiedApiDocs | WeeklyReportApiDocs;

const CATEGORY_LABELS: Record<string, string> = {
  read: "读取",
  direct_write: "直接写",
  proposal_write: "提案写",
};
const CATEGORY_ORDER = ["read", "direct_write", "proposal_write"] as const;

/** 登录态 MCP API 文档页；只展示 schema 与实时角色，不加载或保存密钥。 */
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

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    tools: docs?.tools.filter((tool) => tool.category === category) ?? [],
  })).filter((group) => group.tools.length > 0);

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

          {grouped.map((group) => (
            <section key={group.category} aria-label={`${CATEGORY_LABELS[group.category]}工具`} className="space-y-4">
              <div className="flex items-baseline justify-between gap-4 border-b border-subtle pb-2">
                <h2 className="text-16 font-semibold">{CATEGORY_LABELS[group.category]}</h2>
                <span className="text-12 text-secondary">{group.tools.length} tools</span>
              </div>
              <div className="divide-y divide-subtle border-y border-subtle">
                {group.tools.map((tool) => (
                  <details key={tool.name} className="group px-1 py-3">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 py-1">
                      <span className="font-mono text-13 font-medium">{tool.name}</span>
                      <span className="text-12 text-secondary">{tool.execution_mode}</span>
                      <span className="min-w-0 flex-1 text-12 text-secondary">{tool.required_role}</span>
                    </summary>
                    <div className="space-y-3 pt-3">
                      <p className="text-13">{tool.description}</p>
                      <pre className="font-mono max-h-96 overflow-auto border border-subtle bg-surface-2 p-3 text-12">
                        {JSON.stringify(tool.inputSchema, null, 2)}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
