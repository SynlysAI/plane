import { useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { copyTextToClipboard } from "@plane/utils";
import {
  WeeklyReportMCPService,
  type WeeklyReportAction,
  type WeeklyReportIssueRequest,
  type WeeklyReportOptions,
  type WeeklyReportWorkspace,
} from "@/services/weekly-report-mcp.service";
import { configurationFiles, type MCPConfig } from "./connection-config";
import { downloadMCPConfiguration } from "./connection-download";
import {
  useWeeklyReportConnections,
  useWeeklyReportMutations,
  weeklyReportErrorMessage as errorMessage,
} from "./use-weekly-report-settings";
import { WeeklyReportConnectionsList, WeeklyReportDate } from "./weekly-report-connections";
import { weeklyReportActionLabels as actionLabels } from "./weekly-report-config";

const service = new WeeklyReportMCPService();
const inputClass = "mt-1 w-full rounded border border-subtle bg-surface-1 p-2";
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
  const list = useWeeklyReportConnections(workspace.slug);
  const mutation = useWeeklyReportMutations(workspace.slug, list);
  return (
    <div className="space-y-5">
      <p>{workspace.period_description}</p>
      {!workspace.enabled && (
        <p role="status">
          此工作区暂不可创建周报连接：{workspace.unavailable_reason || "周报连接尚未开放。"} 仍可管理已有连接。
        </p>
      )}
      <WeeklyReportConnectionForm
        workspace={workspace}
        busy={mutation.busy}
        issuing={mutation.issuing}
        blocked={!list.ready || list.busy || mutation.uncertain || Boolean(mutation.result)}
        hasResult={Boolean(mutation.result)}
        onIssue={mutation.issue}
      />
      {mutation.error && <p role="alert">{mutation.error}</p>}
      {mutation.uncertain && (
        <Button
          variant="secondary"
          disabled={!list.ready || list.busy || mutation.busy}
          onClick={mutation.confirmRecovery}
        >
          已核对连接，继续创建
        </Button>
      )}
      {mutation.result && (
        <WeeklyReportResult
          config={mutation.result.config}
          expires={mutation.result.expires}
          clear={mutation.clearResult}
          setNotice={mutation.setNotice}
        />
      )}
      {mutation.notice && <p role="status">{mutation.notice}</p>}
      <WeeklyReportConnectionsList list={list} busy={mutation.busy} onRevoke={mutation.openRevoke} />
      <AlertModalCore
        isOpen={Boolean(mutation.revoke)}
        handleClose={mutation.closeRevoke}
        handleSubmit={mutation.revokeConnection}
        isSubmitting={mutation.busy}
        title="确认撤销周报连接"
        content={
          <>
            <p>
              {mutation.revoke?.label} · {workspace.name}：撤销后此连接将无法继续访问，操作不能恢复。
            </p>
            {mutation.revokeError && <p role="alert">{mutation.revokeError}</p>}
          </>
        }
      />
    </div>
  );
}

function validIssue(workspace: WeeklyReportWorkspace, request: WeeklyReportIssueRequest) {
  const allowedActions = new Set(workspace.actions);
  return Boolean(
    workspace.enabled &&
    request.label &&
    request.label.length <= 100 &&
    !hasControlCharacters(request.label) &&
    request.actions.length &&
    request.actions.every((action) => allowedActions.has(action)) &&
    workspace.ttl_days.includes(request.ttl_days)
  );
}

function WeeklyReportConnectionForm({
  workspace,
  busy,
  issuing,
  blocked,
  hasResult,
  onIssue,
}: {
  workspace: WeeklyReportWorkspace;
  busy: boolean;
  issuing: boolean;
  blocked: boolean;
  hasResult: boolean;
  onIssue: (request: WeeklyReportIssueRequest) => Promise<void>;
}) {
  const [label, setLabel] = useState("个人周报助手");
  const [actions, setActions] = useState<WeeklyReportAction[]>([]);
  const [selectedDays, setSelectedDays] = useState<number>();
  const days =
    selectedDays !== undefined && workspace.ttl_days.includes(selectedDays) ? selectedDays : workspace.ttl_days[0];
  const request = { label: label.trim(), actions, ttl_days: days ?? 0 };
  const valid = validIssue(workspace, request) && !hasControlCharacters(label);
  const selectedActions = new Set(actions);
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (valid && !busy && !blocked) void onIssue(request);
  }
  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-subtle p-4">
      <fieldset disabled={!workspace.enabled || busy || hasResult} className="space-y-4">
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
                checked={selectedActions.has(action)}
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
            onChange={(event) => setSelectedDays(Number(event.target.value))}
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
      <Button type="submit" disabled={!valid || busy || blocked}>
        {issuing ? "正在生成…" : "生成周报连接"}
      </Button>
    </form>
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
        到期时间：
        <WeeklyReportDate value={expires} />
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
