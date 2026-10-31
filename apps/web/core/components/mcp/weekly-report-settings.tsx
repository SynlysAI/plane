import { useEffect, useMemo, useState } from "react";
import { Button } from "@plane/propel/button";
import {
  WeeklyReportMCPService,
  type WeeklyReportAction,
  type WeeklyReportOptions,
  type WeeklyReportWorkspace,
  type WeeklyReportProblem,
} from "@/services/weekly-report-mcp.service";
import { ConnectionBrowser, CreateConnectionDialog, LifetimeSelect, MCP_INPUT } from "./connection-ui";
import { configurationFiles } from "./connection-config";
import { useConnectionManager } from "./use-connection-manager";
import { weeklyReportActionLabels, weeklyReportConfig, weeklyReportMetadata } from "./weekly-report-config";

const SERVICE = new WeeklyReportMCPService();
/** 将服务错误转换为不含凭据的中文消息。 */
function errorMessage(error: unknown) {
  return (error as WeeklyReportProblem)?.message || "请求未完成，请刷新后重试。";
}

/** 周报连接保持独立授权，与项目连接共享创建和管理体验。 */
export function WeeklyReportMCPSettings({ workspaceSlug }: { workspaceSlug?: string }) {
  const [options, setOptions] = useState<WeeklyReportOptions>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setOptions(undefined);
    setError("");
    void SERVICE.options().then(
      (value) => {
        if (!live) return;
        setOptions(value);
        setSelected(value.workspaces.find((w) => w.slug === workspaceSlug)?.slug ?? value.workspaces[0]?.slug ?? "");
        return;
      },
      (failure) => {
        if (live) setError(errorMessage(failure));
      }
    );
    return () => {
      live = false;
    };
  }, [workspaceSlug, retry]);
  const workspace = options?.workspaces.find((w) => w.slug === selected);
  return (
    <section aria-label="周报连接设置" className="min-w-0 space-y-5 text-13">
      <header className="space-y-2">
        <h1 className="text-24 font-semibold">周报连接</h1>
      </header>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setRetry((v) => v + 1)}>
            重试周报设置
          </Button>
        </div>
      ) : !options ? (
        <p role="status">正在加载周报设置…</p>
      ) : (
        <>
          <p className="text-secondary">当前账号：{options.identity.display_name}</p>
          {options.workspaces.length ? (
            <label className="block max-w-lg space-y-2">
              <span>工作区</span>
              <select
                aria-label="周报工作区"
                className={MCP_INPUT}
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {options.workspaces.map((w) => (
                  <option key={w.id} value={w.slug}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p>暂无可管理周报连接的工作区。</p>
          )}
          {workspace && <WorkspaceWeeklyReportSettings key={workspace.slug} workspace={workspace} />}
        </>
      )}
    </section>
  );
}

/** 按工作区隔离周报记录和所有临时凭据。 */
function WorkspaceWeeklyReportSettings({ workspace }: { workspace: WeeklyReportWorkspace }) {
  const slug = workspace.slug;
  const adapter = useMemo(
    () => ({
      list: (cursor?: string) => SERVICE.connections(slug, cursor),
      issue: (data: Parameters<typeof SERVICE.issue>[1], csrf: string) => SERVICE.issue(slug, data, csrf),
      configuration: (id: string, csrf: string) => SERVICE.configuration(slug, id, csrf),
      rotate: (id: string, csrf: string) => SERVICE.rotate(slug, id, csrf),
      revoke: (id: string, csrf: string) => SERVICE.revoke(slug, id, csrf),
      delete: (id: string, csrf: string) => SERVICE.delete(slug, id, csrf),
      metadata: weeklyReportMetadata,
      files: (value: Parameters<typeof weeklyReportConfig>[0]) => configurationFiles([weeklyReportConfig(value, slug)]),
      error: errorMessage,
    }),
    [slug]
  );
  const manager = useConnectionManager(adapter);
  const [actions, setActions] = useState<WeeklyReportAction[]>([]);
  const [days, setDays] = useState<number | null>(workspace.default_ttl_days ?? 365);
  const [creating, setCreating] = useState(false);
  const valid =
    workspace.enabled &&
    actions.length > 0 &&
    actions.every((a) => workspace.actions.includes(a)) &&
    workspace.ttl_days.includes(days) &&
    manager.ready &&
    !manager.loading;
  return (
    <div className="min-w-0 space-y-6">
      <section aria-label="创建周报连接" className="space-y-5">
        <h2 className="text-16 font-semibold">创建周报连接</h2>
        <p className="text-secondary">{workspace.period_description}</p>
        {!workspace.enabled && (
          <p role="status">此工作区暂不可创建周报连接：{workspace.unavailable_reason || "周报连接尚未开放。"}</p>
        )}
        <fieldset disabled={!workspace.enabled || manager.busy || creating} className="space-y-4">
          <legend className="mb-3 text-14 font-medium">访问权限</legend>
          <div className="flex flex-wrap gap-4">
            {workspace.actions.map((action) => (
              <label key={action} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={weeklyReportActionLabels[action]}
                  checked={actions.includes(action)}
                  onChange={(event) =>
                    setActions((before) =>
                      event.target.checked ? [...before, action] : before.filter((a) => a !== action)
                    )
                  }
                />
                {weeklyReportActionLabels[action]}
              </label>
            ))}
          </div>
          <LifetimeSelect value={days} onChange={setDays} options={workspace.ttl_days} />
        </fieldset>
        {actions.includes("submit") && (
          <p className="text-12 text-secondary">正式提交将生成周报版本，并按现有规则通知审阅人。</p>
        )}
        <Button disabled={!valid || manager.busy || manager.uncertain} onClick={() => setCreating(true)}>
          创建连接
        </Button>
        {manager.uncertain && (
          <Button
            variant="secondary"
            disabled={manager.loading || Boolean(manager.listError) || manager.busy}
            onClick={manager.confirmRecovery}
          >
            已核对列表，继续创建
          </Button>
        )}
      </section>
      <CreateConnectionDialog
        open={creating}
        onClose={() => setCreating(false)}
        busy={manager.busy}
        blocked={manager.uncertain}
        error={manager.error}
        summary={
          <>
            <p>{workspace.name} · 仅本人周报</p>
            <p>访问权限：{actions.map((a) => weeklyReportActionLabels[a]).join("、")}</p>
            <p>有效期：{days === null ? "永不过期" : days === 365 ? "一年" : `${days} 天`}</p>
          </>
        }
        onConfirm={async (label) => {
          if (await manager.issue({ label, actions, ttl_days: days })) setCreating(false);
        }}
      />
      <ConnectionBrowser
        title="已有周报连接"
        {...manager}
        selected={manager.selected}
        name={(row) => row.label}
        docsPath={(row) => `/mcp/api-docs/weekly-report/${encodeURIComponent(slug)}/${encodeURIComponent(row.id)}`}
        refresh={() => void manager.load()}
        retry={() => void manager.retry()}
        more={() => void manager.load(manager.cursor!)}
        hide={manager.hideConfiguration}
      >
        {manager.selected && (
          <div className="space-y-2 text-13">
            <h4 className="font-medium">授权范围</h4>
            <p>{workspace.name} · 仅本人本周与上周的周报</p>
            <p className="text-secondary">
              {manager.selected.actions.map((a) => weeklyReportActionLabels[a]).join("、")}
            </p>
          </div>
        )}
      </ConnectionBrowser>
    </div>
  );
}
