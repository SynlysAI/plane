import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import {
  UnifiedMCPService,
  type UnifiedDomain,
  type UnifiedMode,
  type UnifiedOptions,
  type UnifiedWorkspace,
} from "@/services/unified-mcp.service";
import { ConnectionBrowser, CreateConnectionDialog, LifetimeSelect, MCP_INPUT } from "./connection-ui";
import { useConnectionManager } from "./use-connection-manager";
import { unifiedConfiguration, unifiedError, unifiedMetadata } from "./unified-config";

const SERVICE = new UnifiedMCPService();
const ADAPTER = {
  list: (cursor?: string) => SERVICE.connections(cursor),
  issue: SERVICE.issue.bind(SERVICE),
  configuration: SERVICE.configuration.bind(SERVICE),
  rotate: SERVICE.rotate.bind(SERVICE),
  revoke: SERVICE.revoke.bind(SERVICE),
  delete: SERVICE.delete.bind(SERVICE),
  metadata: unifiedMetadata,
  files: unifiedConfiguration,
  error: unifiedError,
};
const DOMAINS = [
  { key: "administrative", label: "行政项目" },
  { key: "research", label: "科研任务" },
] as const;
type Selection = Record<string, Partial<Record<UnifiedDomain, UnifiedMode>>>;

/** 项目连接创建与管理，科研和行政共用一条连接。 */
export function UnifiedMCPManager({ initialWorkspace }: { initialWorkspace?: string }) {
  const manager = useConnectionManager(ADAPTER);
  const [options, setOptions] = useState<UnifiedOptions>();
  const [workspaces, setWorkspaces] = useState<UnifiedWorkspace[]>([]);
  const [optionsError, setOptionsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Selection>({});
  const [future, setFuture] = useState(true);
  const [days, setDays] = useState<number | null>(365);
  const [creating, setCreating] = useState(false);
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const pending = useRef(false);
  const touched = useRef(false);
  const failedCursor = useRef<string | undefined>(undefined);

  /** 分页加载可授权工作区，避免预取具体项目和科研节点。 */
  const loadOptions = useCallback(
    async (next?: string) => {
      if (pending.current) return;
      pending.current = true;
      const expected = epoch.current;
      failedCursor.current = next;
      setLoading(true);
      setOptionsError("");
      try {
        const page = await SERVICE.options(next);
        if (epoch.current !== expected) return;
        setOptions(page);
        setWorkspaces((before) => [
          ...new Map([...(next ? before : []), ...page.results].map((w) => [w.id, w])).values(),
        ]);
        const initial = page.results.find((w) => w.slug === initialWorkspace);
        if (!touched.current && initial) {
          touched.current = true;
          setSelected({
            [initial.id]: Object.fromEntries(Object.keys(initial.domains).map((domain) => [domain, "read"])),
          });
        }
      } catch (failure) {
        if (epoch.current === expected) setOptionsError(unifiedError(failure));
      } finally {
        if (epoch.current === expected) {
          pending.current = false;
          setLoading(false);
        }
      }
    },
    [initialWorkspace]
  );
  useEffect(() => {
    epoch.current += 1;
    pending.current = false;
    void loadOptions();
    return () => {
      epoch.current += 1;
    };
  }, [loadOptions, retry]);
  const defaultTtlDays = options?.default_ttl_days;
  useEffect(() => {
    if (defaultTtlDays !== undefined) setDays(defaultTtlDays);
  }, [defaultTtlDays]);

  const entries = Object.entries(selected);
  const hasWrites = entries.some(([, values]) => Object.values(values).includes("read_write"));
  const valid =
    Boolean(options) &&
    manager.ready &&
    !manager.loading &&
    entries.length > 0 &&
    entries.length <= (options?.max_workspaces ?? 20) &&
    entries.every(([, values]) => Object.keys(values).length > 0) &&
    (future || !hasWrites);
  const summary = (
    <>
      {entries.map(([id, values]) => (
        <p key={id}>
          {workspaces.find((w) => w.id === id)?.name}：
          {DOMAINS.flatMap(({ key, label }) =>
            values[key] ? [`${label} · ${values[key] === "read_write" ? "读写" : "只读"}`] : []
          ).join("；")}
        </p>
      ))}
      <p>{future ? "自动包含新增且本人可访问的内容" : "仅限创建时已有内容（只读）"}</p>
      <p>有效期：{days === null ? "永不过期" : days === 365 ? "一年" : `${days} 天`}</p>
    </>
  );
  return (
    <div className="min-w-0 space-y-6">
      <section aria-label="创建项目连接" className="space-y-5">
        <h2 className="text-16 font-semibold">创建项目连接</h2>
        <fieldset disabled={manager.busy || creating} className="space-y-4">
          <legend className="mb-3 text-14 font-medium">工作区与访问权限</legend>
          <div className="divide-y divide-subtle">
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="space-y-3 py-3 first:pt-0">
                <label className="flex items-start gap-2 font-medium">
                  <input
                    className="mt-1 shrink-0"
                    type="checkbox"
                    aria-label={`选择工作区 ${workspace.name}`}
                    checked={Boolean(selected[workspace.id])}
                    disabled={!selected[workspace.id] && entries.length >= (options?.max_workspaces ?? 20)}
                    onChange={(event) => {
                      touched.current = true;
                      setSelected((before) => {
                        const next = { ...before };
                        if (event.target.checked)
                          next[workspace.id] = Object.fromEntries(
                            Object.keys(workspace.domains).map((d) => [d, "read"])
                          );
                        else delete next[workspace.id];
                        return next;
                      });
                    }}
                  />
                  <span className="min-w-0 break-words">{workspace.name}</span>
                </label>
                {selected[workspace.id] && (
                  <div className="grid gap-3 pl-5 sm:grid-cols-2">
                    {DOMAINS.map(({ key, label }) =>
                      workspace.domains[key] ? (
                        <label key={key} className="space-y-2">
                          <span>{label}</span>
                          <select
                            className={MCP_INPUT}
                            aria-label={`${label}访问权限 ${workspace.name}`}
                            value={selected[workspace.id][key] ?? "none"}
                            onChange={(event) => {
                              const value = event.target.value;
                              setSelected((before) => {
                                const values = { ...before[workspace.id] };
                                if (value === "none") delete values[key];
                                else values[key] = value as UnifiedMode;
                                return { ...before, [workspace.id]: values };
                              });
                            }}
                          >
                            <option value="none">不授权</option>
                            <option value="read">只读</option>
                            <option value="read_write" disabled={!workspace.domains[key]?.includes("read_write")}>
                              读写{!workspace.domains[key]?.includes("read_write") ? "（当前未开放）" : ""}
                            </option>
                          </select>
                        </label>
                      ) : (
                        <p key={key} className="text-12 text-secondary">
                          {label}当前不可用
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {loading && <p role="status">正在加载可选工作区…</p>}
          {!loading && !optionsError && !workspaces.length && <p>暂无可选择的工作区。</p>}
          {optionsError && (
            <div role="alert">
              <p>{optionsError}</p>
              <Button
                variant="secondary"
                onClick={() => (failedCursor.current ? void loadOptions(failedCursor.current) : setRetry((v) => v + 1))}
              >
                重试工作区
              </Button>
            </div>
          )}
          {options?.next_cursor && (
            <Button variant="secondary" disabled={loading} onClick={() => void loadOptions(options.next_cursor!)}>
              加载更多工作区
            </Button>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              aria-label="自动包含新增内容"
              checked={future}
              onChange={(event) => setFuture(event.target.checked)}
            />
            <span>自动包含新增且本人可访问的内容</span>
          </label>
          <LifetimeSelect value={days} onChange={setDays} options={options?.ttl_days} />
        </fieldset>
        {hasWrites && !future && <p role="alert">读写连接需要自动包含新增内容，或将访问权限改为只读。</p>}
        {hasWrites && (
          <p className="text-12 text-secondary">
            行政任务支持直接创建、修改、状态流转及评论；科研任务的修改与状态流转可直接执行，
            创建、评论、资源关联及分析等操作通过提案执行。此连接不授予审核或正式周报提交权限。
          </p>
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
        summary={summary}
        onConfirm={async (name) => {
          if (
            await manager.issue({
              name,
              ttl_days: days,
              include_future_objects: future,
              workspaces: entries.map(([workspace_id, domains]) => ({ workspace_id, domains })),
            })
          )
            setCreating(false);
        }}
      />
      <ConnectionBrowser
        title="已有项目连接"
        {...manager}
        selected={manager.selected}
        name={(row) => row.name}
        docsPath={(row) => `/mcp/api-docs/project/${encodeURIComponent(row.id)}`}
        refresh={() => void manager.load()}
        retry={() => void manager.retry()}
        more={() => void manager.load(manager.cursor!)}
        hide={manager.hideConfiguration}
      >
        {manager.selected && (
          <div className="space-y-3 text-13">
            <h4 className="font-medium">授权范围</h4>
            {manager.selected.scope.workspaces.map((entry) => (
              <div key={entry.workspace_id} className="space-y-1">
                <p className="break-words">
                  {entry.workspace_name ??
                    workspaces.find((w) => w.id === entry.workspace_id)?.name ??
                    "已不可访问的工作区"}
                </p>
                <p className="text-secondary">
                  {DOMAINS.flatMap(({ key, label }) =>
                    entry.domains[key] ? [`${label} · ${entry.domains[key] === "read_write" ? "读写" : "只读"}`] : []
                  ).join("；")}
                </p>
              </div>
            ))}
            <p className="text-secondary">
              {manager.selected.scope.include_future_objects
                ? "自动包含新增且本人可访问的内容"
                : "仅限创建时已有内容（只读）"}
            </p>
          </div>
        )}
      </ConnectionBrowser>
    </div>
  );
}
