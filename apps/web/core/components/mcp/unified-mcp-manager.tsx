import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { copyTextToClipboard } from "@plane/utils";
import { LocalDate } from "@/components/core/local-date";
import { useExpiration } from "@/hooks/use-expiration";
import {
  UnifiedMCPService,
  type UnifiedConnection,
  type UnifiedDomain,
  type UnifiedMode,
  type UnifiedOptions,
  type UnifiedWorkspace,
} from "@/services/unified-mcp.service";
import { downloadMCPConfiguration } from "./connection-download";
import { unifiedConfiguration, unifiedError, unifiedMetadata } from "./unified-config";

const service = new UnifiedMCPService();
const domains = [
  { key: "administrative", label: "行政" },
  { key: "research", label: "科研" },
] as const;
const inputClass = "rounded border border-subtle bg-surface-1 px-3 py-2 text-primary";
type Selection = Record<string, Partial<Record<UnifiedDomain, UnifiedMode>>>;
function merge<T extends { id: string }>(before: T[], after: T[]) {
  return [...new Map([...before, ...after].map((item) => [item.id, item])).values()];
}

export function UnifiedMCPManager({ initialWorkspace }: { initialWorkspace?: string }) {
  const [name, setName] = useState("我的 Agent");
  const [selected, setSelected] = useState<Selection>({});
  const [future, setFuture] = useState(true);
  const [options, setOptions] = useState<UnifiedOptions>();
  const [workspaces, setWorkspaces] = useState<UnifiedWorkspace[]>([]);
  const [optionsError, setOptionsError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [connections, setConnections] = useState<UnifiedConnection[]>([]);
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [csrf, setCsrf] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [generated, setGenerated] = useState<(ReturnType<typeof unifiedConfiguration> & { expires: string }) | null>(
    null
  );
  const [revoke, setRevoke] = useState<UnifiedConnection | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const epoch = useRef(0);
  const mutation = useRef(false);
  const optionPending = useRef(false);
  const listPending = useRef(false);
  const touched = useRef(false);

  const loadOptions = useCallback(
    async (next?: string) => {
      if (optionPending.current) return;
      optionPending.current = true;
      const expected = epoch.current;
      setOptionsLoading(true);
      setOptionsError("");
      try {
        const page = await service.options(next);
        if (epoch.current !== expected) return;
        setOptions(page);
        setCsrf(page.csrf_token);
        setWorkspaces((current) => (next ? merge(current, page.results) : page.results));
        const initial = page.results.find((workspace) => workspace.slug === initialWorkspace);
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
          optionPending.current = false;
          setOptionsLoading(false);
        }
      }
    },
    [initialWorkspace]
  );
  const loadConnections = useCallback(async (next?: string) => {
    if (listPending.current) return;
    listPending.current = true;
    const expected = epoch.current;
    setListLoading(true);
    setListError("");
    try {
      const page = await service.connections(next);
      if (epoch.current !== expected) return;
      setConnections((current) =>
        next ? merge(current, page.results.map(unifiedMetadata)) : page.results.map(unifiedMetadata)
      );
      setListCursor(page.next_cursor);
      setCsrf(page.csrf_token);
    } catch (failure) {
      if (epoch.current === expected) setListError(unifiedError(failure));
    } finally {
      if (epoch.current === expected) {
        listPending.current = false;
        setListLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    epoch.current += 1;
    touched.current = false;
    optionPending.current = false;
    listPending.current = false;
    setGenerated(null);
    setReceiptId(null);
    setSelected({});
    setOptions(undefined);
    setWorkspaces([]);
    setConnections([]);
    setListCursor(null);
    setCsrf("");
    setError("");
    setNotice("");
    setUncertain(false);
    void loadOptions();
    void loadConnections();
    return () => {
      epoch.current += 1;
    };
  }, [loadOptions, loadConnections]);

  function changeForm() {
    touched.current = true;
    setGenerated(null);
    setReceiptId(null);
    if (!uncertain) setError("");
    setNotice("");
  }
  const entries = Object.entries(selected);
  const hasWrites = entries.some(([, values]) => Object.values(values).includes("read_write"));
  const nameValid =
    name.trim().length > 0 &&
    name.trim().length <= 100 &&
    ![...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  const valid =
    nameValid &&
    entries.length > 0 &&
    entries.length <= 20 &&
    entries.every(([, values]) => Object.keys(values).length > 0) &&
    (future || !hasWrites) &&
    Boolean(csrf) &&
    Boolean(options);
  async function generate() {
    if (mutation.current || !valid || receiptId || uncertain) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setGenerated(null);
    const expected = epoch.current;
    try {
      const issued = await service.issue(
        {
          name: name.trim(),
          include_future_objects: future,
          workspaces: entries.map(([workspace_id, values]) => ({ workspace_id, domains: values })),
        },
        csrf
      );
      if (epoch.current !== expected) return;
      setReceiptId(issued.id);
      setConnections((current) => [unifiedMetadata(issued), ...current.filter((item) => item.id !== issued.id)]);
      try {
        setGenerated({ ...unifiedConfiguration(issued), expires: issued.expires_at });
      } catch {
        setError("连接已生成，但配置格式无法识别。请在列表中撤销后重新生成。");
      }
    } catch (failure) {
      if (epoch.current !== expected) return;
      const status = (failure as { status?: number })?.status;
      if (!status || status >= 500) {
        setUncertain(true);
        setError("签发结果尚未确认。请刷新连接列表核对；若已有刚创建的连接，请先撤销，避免重复签发。");
        void loadConnections();
      } else setError(unifiedError(failure));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  async function confirmRevoke() {
    if (!revoke || mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setRevokeError("");
    setGenerated(null);
    const expected = epoch.current;
    try {
      await service.revoke(revoke.id, csrf);
      if (epoch.current !== expected) return;
      setConnections((current) =>
        current.map((item) => (item.id === revoke.id ? { ...item, revoked_at: new Date().toISOString() } : item))
      );
      if (receiptId === revoke.id) setReceiptId(null);
      setUncertain(false);
      setRevoke(null);
      setNotice("连接已撤销，后续机器调用将被拒绝。");
    } catch (failure) {
      if (epoch.current === expected) setRevokeError(unifiedError(failure));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <section aria-label="创建统一连接" className="space-y-5 rounded-xl border border-subtle p-4 sm:p-5">
        <div className="space-y-1">
          <h2 className="text-18 font-semibold">创建统一连接</h2>
          <p className="text-secondary">
            使用当前登录账号的权限。选择工作区和能力后，只生成一条连接与一个 MCP 服务配置。
          </p>
        </div>
        <label className="block max-w-lg">
          连接名称
          <input
            aria-label="统一连接名称"
            maxLength={100}
            disabled={busy}
            className={`mt-1 block w-full ${inputClass}`}
            value={name}
            onChange={(event) => {
              changeForm();
              setName(event.target.value);
            }}
          />
        </label>
        <fieldset className="space-y-3" disabled={busy}>
          <legend className="mb-2 font-medium">工作区与访问能力</legend>
          <p className="text-secondary">
            范围包含所选工作区内你有权访问的项目、链、节点和任务；每次调用仍校验当前权限。
          </p>
          {workspaces.map((workspace) => (
            <div key={workspace.id} className="space-y-3 rounded-lg border border-subtle p-3">
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  aria-label={`选择工作区 ${workspace.name}`}
                  checked={Boolean(selected[workspace.id])}
                  disabled={!selected[workspace.id] && entries.length >= 20}
                  onChange={(event) => {
                    changeForm();
                    setSelected((current) => {
                      const next = { ...current };
                      if (event.target.checked)
                        next[workspace.id] = Object.fromEntries(
                          Object.keys(workspace.domains).map((domain) => [domain, "read"])
                        );
                      else delete next[workspace.id];
                      return next;
                    });
                  }}
                />
                {workspace.name}
              </label>
              {selected[workspace.id] && (
                <div className="flex flex-wrap gap-4">
                  {domains.map(({ key, label }) =>
                    workspace.domains[key] ? (
                      <label key={key} className="flex items-center gap-2">
                        {label}
                        <select
                          className={inputClass}
                          aria-label={`${label}能力 ${workspace.name}`}
                          value={selected[workspace.id][key] ?? "none"}
                          onChange={(event) => {
                            changeForm();
                            const value = event.target.value;
                            setSelected((current) => {
                              const values = { ...current[workspace.id] };
                              if (value === "none") delete values[key];
                              else values[key] = value as UnifiedMode;
                              return { ...current, [workspace.id]: values };
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
          {!optionsLoading && !optionsError && options && !workspaces.length && <p>暂无可选择的工作区。</p>}
          {optionsLoading && <p role="status">正在加载可选工作区…</p>}
          {optionsError && (
            <div role="alert" className="space-y-2">
              <p>{optionsError}</p>
              <Button variant="secondary" onClick={() => void loadOptions(options?.next_cursor ?? undefined)}>
                重试工作区
              </Button>
            </div>
          )}
          {options?.next_cursor && (
            <Button
              variant="secondary"
              disabled={optionsLoading}
              onClick={() => void loadOptions(options.next_cursor!)}
            >
              加载更多工作区
            </Button>
          )}
        </fieldset>
        <label className="flex items-start gap-2">
          <input
            className="mt-1"
            type="checkbox"
            aria-label="包含未来新增且有权限的内容"
            checked={future}
            disabled={busy}
            onChange={(event) => {
              changeForm();
              setFuture(event.target.checked);
            }}
          />
          <span>
            动态包含未来新增且本人有权访问的内容
            <span className="mt-1 block text-12 text-secondary">
              包括未来新增的项目、链、节点和任务；不会获得你原本没有的权限。取消后固定已有范围，仅支持只读。
            </span>
          </span>
        </label>
        {hasWrites && !future && <p role="alert">读写连接需要动态范围，请勾选包含未来新增内容，或将能力改为只读。</p>}
        {options && (
          <p className="text-12 text-secondary">有效期由服务端设定，生成结果显示实际到期时间。最多选择 20 个工作区。</p>
        )}
        {hasWrites && (
          <p className="text-12 text-secondary">
            行政任务写入直接执行；科研部分动作先生成提案再执行。读写能力不等于审核权，也不包含正式周报提交。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="flex flex-wrap gap-3">
          <Button disabled={busy || !valid || Boolean(receiptId) || uncertain} onClick={() => void generate()}>
            {busy ? "正在处理…" : "生成单份配置"}
          </Button>
          {receiptId && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setGenerated(null);
                setReceiptId(null);
                setError("");
              }}
            >
              新建另一条连接
            </Button>
          )}
          {uncertain && (
            <Button
              variant="secondary"
              disabled={busy || listLoading || Boolean(listError)}
              onClick={() => {
                setUncertain(false);
                setError("");
              }}
            >
              已核对列表，重新生成
            </Button>
          )}
        </div>
      </section>
      {generated && (
        <section aria-label="统一连接生成结果" className="space-y-4 rounded-xl border border-subtle p-4 sm:p-5">
          <h2 className="text-18 font-semibold">单份连接配置</h2>
          <p className="text-secondary">
            完整密钥仅在本次生成时显示。复制或导出后关闭；关闭、切换范围或离开页面后无法找回。
          </p>
          <p className="text-12 text-secondary">
            实际到期时间：
            <LocalDate value={generated.expires} />
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="min-w-0">
              Codex TOML
              <textarea
                aria-label="统一 TOML 配置"
                readOnly
                className={`font-mono mt-1 h-48 w-full text-12 ${inputClass}`}
                value={generated.toml}
              />
            </label>
            <label className="min-w-0">
              通用 MCP JSON
              <textarea
                aria-label="统一 JSON 配置"
                readOnly
                className={`font-mono mt-1 h-48 w-full text-12 ${inputClass}`}
                value={generated.json}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"
              onClick={() =>
                void copyTextToClipboard(generated.toml).then(
                  () => setNotice("配置已复制。"),
                  () => setNotice("复制失败，请手动选择配置。")
                )
              }
            >
              复制 TOML
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void copyTextToClipboard(generated.json).then(
                  () => setNotice("配置已复制。"),
                  () => setNotice("复制失败，请手动选择配置。")
                )
              }
            >
              复制 JSON
            </Button>
            <Button variant="secondary" onClick={() => downloadMCPConfiguration(generated.toml, "toml")}>
              导出 TOML
            </Button>
            <Button variant="secondary" onClick={() => downloadMCPConfiguration(generated.json, "json")}>
              导出 JSON
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setGenerated(null);
                setNotice("已清除页面中的密钥，连接仍保留在下方列表中。");
              }}
            >
              关闭配置并清除密钥
            </Button>
          </div>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      <section aria-label="统一连接列表" className="space-y-4 rounded-xl border border-subtle p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-18 font-semibold">统一连接</h2>
          <Button variant="secondary" disabled={busy || listLoading} onClick={() => void loadConnections()}>
            刷新连接列表
          </Button>
        </div>
        <p className="text-secondary">完整密钥无法再次查看。可随时撤销连接。</p>
        {listLoading && <p role="status">正在加载连接…</p>}
        {listError && (
          <div role="alert">
            <p>{listError}</p>
            <Button
              variant="secondary"
              disabled={listLoading}
              onClick={() => void loadConnections(listCursor ?? undefined)}
            >
              重试连接列表
            </Button>
          </div>
        )}
        {!listLoading && !listError && !connections.length && <p>尚无统一连接。</p>}
        <div className="grid gap-3 lg:grid-cols-2">
          {connections.map((connection) => (
            <UnifiedConnectionCard
              key={connection.id}
              connection={connection}
              workspaces={workspaces}
              disabled={busy || !csrf}
              onRevoke={() => {
                setRevokeError("");
                setRevoke(connection);
              }}
            />
          ))}
        </div>
        {listCursor && (
          <Button variant="secondary" disabled={busy || listLoading} onClick={() => void loadConnections(listCursor)}>
            加载更多连接
          </Button>
        )}
      </section>
      <AlertModalCore
        isOpen={Boolean(revoke)}
        handleClose={() => {
          if (!mutation.current) setRevoke(null);
        }}
        handleSubmit={confirmRevoke}
        isSubmitting={busy}
        title="确认撤销统一连接"
        primaryButtonText={{ default: "确认撤销", loading: "正在撤销…" }}
        secondaryButtonText="取消"
        content={
          <>
            {revoke?.name}：撤销后无法继续访问，操作不能恢复。
            {revokeError && (
              <span role="alert" className="mt-2 block">
                {revokeError}
              </span>
            )}
          </>
        }
      />
    </div>
  );
}

function UnifiedConnectionCard({
  connection,
  workspaces,
  disabled,
  onRevoke,
}: {
  connection: UnifiedConnection;
  workspaces: UnifiedWorkspace[];
  disabled: boolean;
  onRevoke: () => void;
}) {
  const expired = useExpiration(connection.expires_at);
  return (
    <article className="space-y-3 rounded-lg border border-subtle p-4" aria-label={`统一连接 ${connection.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto font-medium break-words">{connection.name}</h3>
        <span className="rounded bg-surface-2 px-2 py-0.5 text-12">
          {connection.revoked_at ? "已撤销" : expired === null ? "确认有效期…" : expired ? "已到期" : "有效"}
        </span>
      </div>
      <ul className="space-y-1 text-12 text-secondary">
        {connection.scope.workspaces.map((scope) => (
          <li key={scope.workspace_id}>
            {workspaces.find((workspace) => workspace.id === scope.workspace_id)?.name ?? "未加载或已不可访问的工作区"}{" "}
            ·{" "}
            {domains
              .flatMap(({ key, label }) =>
                scope.domains[key] ? [`${label}${scope.domains[key] === "read_write" ? "读写" : "只读"}`] : []
              )
              .join("、")}
          </li>
        ))}
      </ul>
      <p className="text-12 text-secondary">
        {connection.scope.include_future_objects ? "动态包含未来新增且有权限的内容" : "固定已有范围（只读）"}
      </p>
      <dl className="space-y-1 text-12 text-secondary">
        <div>
          <dt className="inline">到期时间：</dt>
          <dd className="inline">
            <LocalDate value={connection.expires_at} />
          </dd>
        </div>
        <div>
          <dt className="inline">最近使用：</dt>
          <dd className="inline">
            <LocalDate value={connection.last_used_at} emptyLabel="尚未使用" />
          </dd>
        </div>
      </dl>
      <Button
        variant="secondary"
        disabled={disabled || Boolean(connection.revoked_at)}
        aria-label={`撤销统一连接：${connection.name}`}
        onClick={onRevoke}
      >
        撤销连接
      </Button>
    </article>
  );
}
