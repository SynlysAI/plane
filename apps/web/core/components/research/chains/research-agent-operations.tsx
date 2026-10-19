"use client";

import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@plane/constants";
import { Button } from "@plane/propel/button";
import {
  ResearchAgentOperationService,
  type TAgentAction,
  type TAgentConnection,
  type TAgentOperationState,
} from "@/services/research/agent-operation.service";

const service = new ResearchAgentOperationService();
const labels: Record<TAgentAction, string> = {
  create_task: "创建未指派任务",
  append_task_comment: "追加任务评论",
  save_analysis_draft: "保存分析草稿",
  attach_task_resource: "关联已有材料",
  append_research_note: "追加科研记录",
};
const statusLabels: Record<string, string> = {
  PROPOSED: "待确认",
  APPROVED: "已确认，等待 Agent 执行",
  COMMITTED: "已写入",
  REJECTED: "已拒绝",
  CANCELLED: "已取消",
  EXPIRED: "已到期",
  CONFLICT: "数据已变化，请重新准备",
};
const fieldLabels: Record<string, string> = {
  title: "任务标题",
  instruction: "任务说明",
  task_id: "目标任务",
  text: "正文",
  method: "分析方法",
  summary: "分析摘要",
  conclusion: "草稿结论",
  resource_type: "材料类型",
  resource_id: "材料编号",
  version: "材料版本",
};

type Props = { workspaceSlug: string; nodeId: string; operationId?: string | null };

export function ResearchAgentOperations(props: Props) {
  return (
    <ResearchAgentOperationsPanel
      key={JSON.stringify([props.workspaceSlug, props.nodeId, props.operationId])}
      {...props}
    />
  );
}

function ResearchAgentOperationsPanel({ workspaceSlug, nodeId, operationId }: Props) {
  const [state, setState] = useState<TAgentOperationState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [connection, setConnection] = useState<TAgentConnection | null>(null);
  const [actions, setActions] = useState<TAgentAction[]>([]);
  const [reportIds, setReportIds] = useState<string[]>([]);
  const [agentLabel, setAgentLabel] = useState("Codex");
  const generation = useRef(0);

  async function load(params: Record<string, string> = {}, expected = generation.current) {
    const next = await service.getState(workspaceSlug, nodeId, params);
    if (expected === generation.current) {
      setState(next);
      setUnavailable(false);
    }
    return next;
  }

  useEffect(() => {
    const expected = ++generation.current;
    setState(null);
    setConnection(null);
    setError("");
    setActions([]);
    setReportIds([]);
    setUnavailable(false);
    setBusy(false);
    void load(operationId ? { operation_id: operationId } : {}, expected).catch(
      (failure: { error_code?: string; message?: string }) => {
        if (expected !== generation.current) return;
        if (failure.error_code === "disabled") setUnavailable(true);
        else setError(failure.message || "未能加载 Agent 操作，请刷新重试。");
      }
    );
    return () => {
      generation.current = expected + 1;
    };
    // The node and deep link are the request identity; stale responses must not cross nodes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, nodeId, operationId]);

  async function act(data: Record<string, unknown>) {
    if (!state || busy) return;
    const expected = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await service.act<TAgentConnection>(workspaceSlug, nodeId, state.csrf_token, data);
      if (expected !== generation.current) return;
      if (data.kind === "issue_grant") setConnection(result);
      await load(operationId ? { operation_id: operationId } : {}, expected);
    } catch (failure) {
      if (expected === generation.current)
        setError((failure as { message?: string }).message || "操作未完成，请刷新核对后重试。");
    } finally {
      if (expected === generation.current) setBusy(false);
    }
  }

  return (
    <section aria-label="Agent 操作审核" className="border-t border-subtle p-4 text-13 text-primary">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Agent 操作审核</h3>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => {
            setError("");
            void load(operationId ? { operation_id: operationId } : {}).catch(() => setError("刷新失败，请重试。"));
          }}
        >
          刷新
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-red-600 my-2">
          {error}
        </p>
      )}
      {unavailable && (
        <p role="status" className="py-3 text-secondary">
          当前部署或工作区尚未开放科研节点 MCP 操作。请联系管理员核对科研模块、科研链及 MCP 读取和写入开关。
        </p>
      )}
      {!state && !error && !unavailable && <p className="py-3 text-secondary">正在加载…</p>}
      {state && (
        <>
          {!state.enabled ? (
            <div className="my-3 space-y-2">
              <p>当前工作区尚未开放 Agent 写入。</p>
              {state.can_configure && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act({ kind: "workspace_policy", enabled: true })}
                >
                  启用工作区 Agent 操作
                </Button>
              )}
            </div>
          ) : (
            <details className="my-3 rounded border border-subtle p-3">
              <summary className="cursor-pointer font-medium">连接 Agent 与管理授权</summary>
              <p className="my-2 text-secondary">
                授权只覆盖当前节点。连接有效期 {((state.connection_ttl_seconds ?? 604800) / 86400).toLocaleString()}{" "}
                天，每项变更仍需在下方确认；授权到期后需重新连接。
              </p>
              <label className="block">
                Agent 名称
                <input
                  className="ml-2 rounded border border-subtle p-1"
                  value={agentLabel}
                  maxLength={100}
                  onChange={(event) => setAgentLabel(event.target.value)}
                />
              </label>
              <fieldset className="my-2 space-y-1">
                <legend>允许准备的操作</legend>
                {state.allowed_actions.map((action) => (
                  <label key={action} className="block">
                    <input
                      type="checkbox"
                      checked={actions.includes(action)}
                      onChange={(event) =>
                        setActions((current) =>
                          event.target.checked ? [...current, action] : current.filter((item) => item !== action)
                        )
                      }
                    />{" "}
                    {labels[action]}
                  </label>
                ))}
              </fieldset>
              {state.report_options?.length > 0 && (
                <fieldset className="my-2">
                  <legend>可读取和引用的正式报告版本</legend>
                  {state.report_options.map((report) => (
                    <label key={report.id} className="block">
                      <input
                        type="checkbox"
                        checked={reportIds.includes(report.id)}
                        onChange={(event) =>
                          setReportIds((current) =>
                            event.target.checked ? [...current, report.id] : current.filter((id) => id !== report.id)
                          )
                        }
                      />{" "}
                      {report.title} · 版本 {report.version}
                    </label>
                  ))}
                </fieldset>
              )}
              <Button
                variant="secondary"
                disabled={busy || !actions.length || !agentLabel.trim()}
                onClick={() =>
                  void act({
                    kind: "issue_grant",
                    actions,
                    agent_label: agentLabel.trim(),
                    reports: (state.report_options ?? [])
                      .filter((report) => reportIds.includes(report.id))
                      .map(({ id, version }) => ({ id, version })),
                  })
                }
              >
                生成当前节点连接配置
              </Button>
              {connection && (
                <div className="my-3 space-y-2">
                  <p>连接密钥仅本次展示，请保存到本机私密配置。到期时间：{connection.expires_at}</p>
                  <textarea
                    aria-label="Agent 连接配置"
                    readOnly
                    className="font-mono h-48 w-full rounded border border-subtle p-2 text-12"
                    value={JSON.stringify(
                      {
                        url: connectionURL(connection.mcp_path),
                        http_headers: connection.headers,
                      },
                      null,
                      2
                    )}
                  />
                  <Button variant="secondary" onClick={() => setConnection(null)}>
                    隐藏连接密钥
                  </Button>
                </div>
              )}
              {state.grants.map((grant) => (
                <div key={grant.context_id} className="mt-2 flex items-center justify-between gap-2">
                  <span>
                    {grant.agent_label} · 有效至 {grant.expires_at} ·{" "}
                    {grant.actions.map((action) => labels[action]).join("、")}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setConnection(null);
                      void act({ kind: "revoke_grant", context_id: grant.context_id });
                    }}
                  >
                    撤销授权
                  </Button>
                </div>
              ))}
            </details>
          )}
          <p className="my-2 text-secondary">
            确认后由 Agent 执行。多个提案独立执行；任务和分析草稿不会自动改变节点状态。
          </p>
          {!state.operations.length && <p className="py-2 text-secondary">当前没有待查看的变更提案。</p>}
          {state.operations.map((operation) => (
            <article key={operation.operation_id} className="my-3 rounded border border-subtle p-3">
              <h4 className="font-medium">
                {labels[operation.action]} · {statusLabels[operation.status] ?? operation.status}
              </h4>
              <p className="my-1 text-secondary">
                {operation.agent_label} · 提案到期 {operation.expires_at}
              </p>
              {operation.target?.node_title && <p className="my-1">目标节点：{operation.target.node_title}</p>}
              {operation.target?.task_title && <p className="my-1">目标任务：{operation.target.task_title}</p>}
              <dl className="space-y-2">
                {Object.entries(operation.payload).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-secondary">{fieldLabels[key] ?? key}</dt>
                    <dd className="break-words whitespace-pre-wrap">{String(value)}</dd>
                  </div>
                ))}
              </dl>
              {operation.source_refs.length > 0 && (
                <details className="my-2">
                  <summary>查看依据</summary>
                  {operation.source_refs.map((ref) => (
                    <p key={`${ref.kind}:${ref.id}:${ref.version ?? "current"}:${ref.usage}`}>
                      {ref.kind} · {ref.id}
                      {ref.version ? ` · 版本 ${ref.version}` : ""} ·{" "}
                      {ref.usage === "body" ? "引用正文" : "仅引用元数据"}
                    </p>
                  ))}
                </details>
              )}
              <p className="my-2 text-12 break-all text-secondary">操作编号：{operation.operation_id}</p>
              {operation.status === "PROPOSED" && (
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    disabled={busy || !state.enabled || Date.parse(operation.expires_at) <= Date.now()}
                    onClick={() =>
                      void act({
                        kind: "decision",
                        operation_id: operation.operation_id,
                        proposal_hash: operation.proposal_hash,
                        decision: "APPROVED",
                      })
                    }
                  >
                    确认这项变更
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy || !state.enabled}
                    onClick={() =>
                      void act({
                        kind: "decision",
                        operation_id: operation.operation_id,
                        proposal_hash: operation.proposal_hash,
                        decision: "REJECTED",
                      })
                    }
                  >
                    拒绝
                  </Button>
                </div>
              )}
              {operation.status === "COMMITTED" && (
                <p className="break-all">
                  已写入对象：{operation.result.object_id} ·{" "}
                  {operation.result.readback === "verified"
                    ? "Agent 已读回核对"
                    : operation.result.readback === "changed"
                      ? "对象已有后续修改，请核对"
                      : "等待读回核对"}
                </p>
              )}
              {operation.result.event_id && (
                <p className="text-12 break-all text-secondary">来源事件：{operation.result.event_id}</p>
              )}
              {operation.result.audit_id && (
                <p className="text-12 break-all text-secondary">审计编号：{operation.result.audit_id}</p>
              )}
            </article>
          ))}
          {state.next_cursor && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                void load({ before: state.next_cursor! }).catch(() => setError("加载下一页失败。"));
              }}
            >
              查看更早的提案
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function connectionURL(path: string) {
  // The machine connection uses the same configured API origin as Plane's services.
  return new URL(path, API_BASE_URL || window.location.origin).toString();
}
