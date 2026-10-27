import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { copyTextToClipboard } from "@plane/utils";
import {
  WeeklyReportMCPService,
  type WeeklyReportAction,
  type WeeklyReportConnection,
  type WeeklyReportOptions,
  type WeeklyReportProblem,
  type WeeklyReportWorkspace,
} from "@/services/weekly-report-mcp.service";
import { configurationFiles, type MCPConfig } from "./connection-config";
import { downloadMCPConfiguration } from "./connection-download";
import { weeklyReportConfig } from "./weekly-report-config";

const service = new WeeklyReportMCPService();
const actionLabels: Record<WeeklyReportAction, string> = { save_draft: "保存草稿", submit: "正式提交" };
const inputClass = "mt-1 w-full rounded border border-subtle bg-surface-1 p-2";
const errorMessage = (error: unknown) => (error as WeeklyReportProblem)?.message || "服务请求失败，请刷新后重试。";
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : "尚未使用");
const hasControlCharacters = (value: string) =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function WeeklyReportMCPSettings({ workspaceSlug }: { workspaceSlug?: string }) {
  const [options, setOptions] = useState<WeeklyReportOptions>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setOptions(undefined);
    setError("");
    void service.options().then(
      (value) => {
        if (!active) return;
        setOptions(value);
        setSelected(value.workspaces.find((w) => w.slug === workspaceSlug)?.slug ?? value.workspaces[0]?.slug ?? "");
        return;
      },
      (failure) => {
        if (active) setError(errorMessage(failure));
      }
    );
    return () => {
      active = false;
    };
  }, [workspaceSlug, retry]);
  const workspace = options?.workspaces.find((w) => w.slug === selected);
  return (
    <section aria-label="周报连接设置" className="space-y-5">
      <h2 className="text-18 font-semibold">周报连接</h2>
      <p className="text-secondary">连接 Agent 后，可整理并提交本人的周报。正文提案和提交授权在 Agent 客户端完成。</p>
      {error ? (
        <div role="alert">
          {error}
          <Button variant="secondary" onClick={() => setRetry((v) => v + 1)}>
            重试周报设置
          </Button>
        </div>
      ) : !options ? (
        <p role="status">正在加载周报设置…</p>
      ) : (
        <>
          <p>当前账号：{options.identity.display_name}</p>
          {options.workspaces.length === 0 ? (
            <p>暂无可管理周报连接的工作区。</p>
          ) : (
            <label className="block max-w-lg">
              工作区
              <select
                aria-label="周报工作区"
                className={inputClass}
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
          )}
          {workspace && <WorkspaceWeeklyReportSettings key={workspace.slug} workspace={workspace} />}
          <Button variant="secondary" onClick={() => setRetry((v) => v + 1)}>
            刷新周报能力
          </Button>
        </>
      )}
    </section>
  );
}

function WorkspaceWeeklyReportSettings({ workspace }: { workspace: WeeklyReportWorkspace }) {
  const [label, setLabel] = useState("个人周报助手");
  const [actions, setActions] = useState<WeeklyReportAction[]>([]);
  const [days, setDays] = useState(workspace.ttl_days[0]);
  const [rows, setRows] = useState<WeeklyReportConnection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [listReady, setListReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [result, setResult] = useState<{ id: string; expires: string; config: MCPConfig }>();
  const [revoke, setRevoke] = useState<WeeklyReportConnection | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const live = useRef(false);
  const writing = useRef(false);
  const loading = useRef(false);
  const csrf = useRef("");
  const failedCursor = useRef<string | undefined>(undefined);
  const listSequence = useRef(0);

  const load = useCallback(
    async (next?: string) => {
      if (loading.current) return;
      loading.current = true;
      const sequence = ++listSequence.current;
      setListBusy(true);
      setListError("");
      setListReady(false);
      failedCursor.current = next;
      try {
        const page = await service.connections(workspace.slug, next);
        if (!live.current || sequence !== listSequence.current) return;
        csrf.current = page.csrf_token;
        const own = page.results.filter((row) => row.workspace === workspace.slug);
        setRows((previous) => [...new Map([...(next ? previous : []), ...own].map((row) => [row.id, row])).values()]);
        setCursor(page.next_cursor);
        setListReady(true);
      } catch (failure) {
        if (live.current && sequence === listSequence.current) setListError(errorMessage(failure));
      } finally {
        if (sequence === listSequence.current) {
          loading.current = false;
          if (live.current) setListBusy(false);
        }
      }
    },
    [workspace.slug]
  );
  useEffect(() => {
    live.current = true;
    loading.current = false;
    void load();
    return () => {
      live.current = false;
    };
    // A new workspace gets a new component and no retained credential or cursor.
  }, [load]);

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    if (
      writing.current ||
      loading.current ||
      !listReady ||
      uncertain ||
      result ||
      !workspace.enabled ||
      !csrf.current ||
      !label.trim() ||
      label.trim().length > 100 ||
      hasControlCharacters(label) ||
      !actions.length ||
      actions.some((action) => !workspace.actions.includes(action)) ||
      !workspace.ttl_days.includes(days)
    )
      return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const issued = await service.issue(
        workspace.slug,
        { label: label.trim(), actions, ttl_days: days },
        csrf.current
      );
      if (!live.current) return;
      const config = weeklyReportConfig(issued, workspace.slug);
      csrf.current = issued.csrf_token;
      setResult({ id: issued.id, expires: issued.expires_at, config });
      setNotice("连接已生成，请保存本次配置。");
      await load();
    } catch (failure) {
      if (!live.current) return;
      // A network/5xx failure or unusable success response may have created a grant.
      if ((failure as WeeklyReportProblem)?.uncertain !== false) {
        setUncertain(true);
        setError("签发结果尚未确认。已尝试刷新列表，请核对并撤销不需要的连接；密钥无法从列表找回。");
        await load();
      } else setError(errorMessage(failure));
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function revokeConnection() {
    if (!revoke || writing.current || loading.current || !csrf.current) return;
    const id = revoke.id;
    writing.current = true;
    setBusy(true);
    setRevokeError("");
    if (result?.id === id) setResult(undefined);
    try {
      await service.revoke(workspace.slug, id, csrf.current);
      if (!live.current) return;
      setRevoke(null);
      setNotice("周报连接已撤销。");
      await load();
    } catch (failure) {
      if (live.current) setRevokeError(errorMessage(failure));
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }

  const valid = Boolean(
    workspace.enabled &&
    listReady &&
    csrf.current &&
    label.trim() &&
    label.trim().length <= 100 &&
    !hasControlCharacters(label) &&
    actions.length &&
    workspace.ttl_days.includes(days)
  );
  return (
    <div className="space-y-5">
      <p>{workspace.period_description}</p>
      {!workspace.enabled && (
        <p role="status">
          此工作区暂不可创建周报连接：{workspace.unavailable_reason || "周报连接尚未开放。"} 仍可管理已有连接。
        </p>
      )}
      <form onSubmit={(event) => void issue(event)} className="space-y-4 rounded-xl border border-subtle p-4">
        <fieldset disabled={!workspace.enabled || busy || Boolean(result)} className="space-y-4">
          <legend className="text-16 font-semibold">创建本人周报连接</legend>
          <label className="block max-w-lg">
            连接名称
            <input
              aria-label="周报连接名称"
              className={inputClass}
              maxLength={100}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-wrap gap-4">
            <legend>允许的操作（分别授权）</legend>
            {workspace.actions.map((action) => (
              <label key={action} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={actionLabels[action]}
                  checked={actions.includes(action)}
                  onChange={(event) =>
                    setActions((old) => (event.target.checked ? [...old, action] : old.filter((a) => a !== action)))
                  }
                />
                {actionLabels[action]}
              </label>
            ))}
          </fieldset>
          <label className="block max-w-lg">
            有效期
            <select
              aria-label="周报连接有效期"
              className={inputClass}
              value={days ?? ""}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              {workspace.ttl_days.map((day) => (
                <option key={day} value={day}>
                  {day} 天
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <p className="text-12 text-secondary">
          正式提交会生成正式版本并按现有规则通知审阅人。此连接不包含科研节点读取权。签发未返回时离开页面，请先在已有连接中核对结果。
        </p>
        <Button type="submit" disabled={!valid || busy || listBusy || uncertain || Boolean(result)}>
          {busy && !revoke ? "正在生成…" : "生成周报连接"}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {uncertain && (
        <Button
          variant="secondary"
          disabled={!listReady || listBusy || busy}
          onClick={() => {
            setUncertain(false);
            setError("");
          }}
        >
          已核对连接，继续创建
        </Button>
      )}
      {result && (
        <WeeklyReportResult
          config={result.config}
          expires={result.expires}
          clear={() => {
            setResult(undefined);
            setNotice("本次配置和密钥已清除。");
          }}
          setNotice={setNotice}
        />
      )}
      {notice && <p role="status">{notice}</p>}
      <section aria-label="已有周报连接" className="space-y-3">
        <div className="flex items-center gap-3">
          <h3 className="text-16 font-semibold">已有周报连接</h3>
          <Button variant="secondary" disabled={listBusy || busy} onClick={() => void load()}>
            刷新周报连接列表
          </Button>
        </div>
        {listBusy && <p role="status">正在加载周报连接…</p>}
        {listError && (
          <div role="alert">
            {listError}
            <Button variant="secondary" disabled={listBusy || busy} onClick={() => void load(failedCursor.current)}>
              重试周报连接列表
            </Button>
          </div>
        )}
        {listReady && rows.length === 0 && <p>尚无周报连接。</p>}
        {rows.map((row) => (
          <article key={row.id} className="space-y-2 rounded-lg border border-subtle p-4">
            <h4 className="font-medium break-words">{row.label}</h4>
            <p>
              权限：{row.actions.map((a) => actionLabels[a]).join("、")} ·{" "}
              {row.revoked_at ? "已撤销" : Date.parse(row.expires_at) <= Date.now() ? "已到期" : "有效"}
            </p>
            <p>
              到期时间：{date(row.expires_at)} · 最近使用：{date(row.last_used_at)}
            </p>
            <Button
              variant="secondary"
              aria-label={`撤销周报连接：${row.label}`}
              disabled={Boolean(row.revoked_at) || busy || listBusy || !listReady}
              onClick={() => {
                setRevokeError("");
                setRevoke(row);
              }}
            >
              撤销连接
            </Button>
          </article>
        ))}
        {cursor && (
          <Button variant="secondary" disabled={listBusy || busy} onClick={() => void load(cursor)}>
            加载更多周报连接
          </Button>
        )}
      </section>
      <AlertModalCore
        isOpen={Boolean(revoke)}
        handleClose={() => {
          if (!writing.current) setRevoke(null);
        }}
        handleSubmit={revokeConnection}
        isSubmitting={busy}
        title="确认撤销周报连接"
        content={
          <>
            <p>
              {revoke?.label} · {workspace.name}：撤销后此连接将无法继续访问，操作不能恢复。
            </p>
            {revokeError && <p role="alert">{revokeError}</p>}
          </>
        }
      />
    </div>
  );
}

function WeeklyReportResult({
  config,
  expires,
  clear,
  setNotice,
}: {
  config: MCPConfig;
  expires: string;
  clear: () => void;
  setNotice: (value: string) => void;
}) {
  const files = configurationFiles([config]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function copy(text: string) {
    try {
      await copyTextToClipboard(text);
      if (active.current) setNotice("配置已复制。");
    } catch {
      if (active.current) setNotice("复制失败，请手动选择配置。");
    }
  }
  function download(extension: "toml" | "json") {
    try {
      downloadMCPConfiguration(files[extension], extension);
    } catch {
      setNotice("导出失败，请复制配置。");
    }
  }
  return (
    <section aria-label="周报连接生成结果" className="space-y-4 rounded-xl border border-subtle p-4">
      <h3 className="text-16 font-semibold">本次周报连接配置</h3>
      <p>
        到期时间：{date(expires)}
        。密钥仅本次展示，切页、切工作区、关闭设置或清除结果后无法找回。请妥善保管复制或导出的文件。
      </p>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {(["toml", "json"] as const).map((format) => (
          <label key={format} className="block min-w-0">
            {format === "toml" ? "Codex TOML" : "通用 MCP JSON"}
            <textarea
              aria-label={`周报 ${format.toUpperCase()} 配置`}
              readOnly
              className="font-mono mt-1 h-48 w-full rounded border border-subtle bg-surface-1 p-3"
              value={files[format]}
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        {(["toml", "json"] as const).map((format) => (
          <span key={format} className="flex gap-3">
            <Button variant="secondary" onClick={() => void copy(files[format])}>
              复制 {format.toUpperCase()}
            </Button>
            <Button variant="secondary" onClick={() => download(format)}>
              导出 {format.toUpperCase()}
            </Button>
          </span>
        ))}
        <Button variant="secondary" onClick={clear}>
          清除周报配置和密钥
        </Button>
      </div>
    </section>
  );
}
