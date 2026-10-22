/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
import { Button } from "@plane/propel/button";
import { AlertModalCore } from "@plane/ui";
import { copyTextToClipboard } from "@plane/utils";
import { PageHead } from "@/components/core/page-title";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUser } from "@/hooks/store/user";
import type { TNativeConnection } from "@/services/mcp.service";
import { NativeMCPManager, emptyNative, nativeService, type NativeState } from "./native-mcp-manager";
import { ResearchWorkspacePicker, researchService } from "./research-workspace-picker";
import { ExistingMCPConnections } from "./existing-connections";
import {
  configurationFiles,
  nativeConfig,
  researchConfig,
  failureMessage,
  actionLabels,
  type MCPConfig,
} from "./connection-config";
import { targetVersion, type MCPTarget } from "./types";

type Result = {
  target: MCPTarget;
  accountName: string;
  status: "success" | "failure";
  message: string;
  config?: MCPConfig;
  expires?: string;
};
type Revoke = { source: "admin" | "research"; workspace: string; id: string; label: string; csrf: string };
const inputClass = "rounded border border-subtle bg-surface-1 px-3 py-2";
function capabilities(target: MCPTarget) {
  return target.mode === "read"
    ? "只读"
    : target.source === "admin"
      ? "读取与进展发布"
      : `读取与受控写入${target.actions.map((action) => `、${actionLabels[action] ?? action}`).join("")}`;
}
function download(text: string, extension: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `plane-mcp-connections.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const MCPManagement = observer(function MCPManagement({
  workspaceSlug,
  inModal = false,
}: {
  workspaceSlug?: string;
  inModal?: boolean;
}) {
  const workspaceStore = useWorkspace();
  const { data: currentUser } = useUser();
  const [params] = useSearchParams();
  // Modal settings never consume the underlying workbench's query parameters.
  const initialWorkspace = inModal ? workspaceSlug : (params.get("workspace") ?? workspaceSlug);
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceRetry, setWorkspaceRetry] = useState(0);
  const [native, setNative] = useState<NativeState>(emptyNative);
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const [selected, setSelected] = useState<Record<string, MCPTarget>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const receipts = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [nativeVersion, setNativeVersion] = useState(0);
  const [name, setName] = useState("我的 Agent");
  const [days, setDays] = useState(7);
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [notice, setNotice] = useState("");
  const [revoke, setRevoke] = useState<Revoke | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const revoking = useRef(false);
  const maxNativeDays = native.options?.max_token_days;
  useEffect(() => {
    if (maxNativeDays) setDays((current) => Math.min(current, maxNativeDays));
  }, [maxNativeDays]);
  useEffect(() => {
    let active = true;
    setWorkspaceLoading(true);
    setWorkspaceError("");
    void workspaceStore
      .fetchWorkspaces()
      .catch(() => {
        if (active) setWorkspaceError("无法加载本实例工作区，请重试。");
      })
      .finally(() => {
        if (active) setWorkspaceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceStore, workspaceRetry]);
  useEffect(() => {
    clearSecrets();
    return () => {
      epoch.current += 1;
    };
  }, [initialWorkspace]);
  function clearSecrets() {
    epoch.current += 1;
    setResults((current) =>
      Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { ...value, config: undefined }]))
    );
    setNotice("");
  }
  function invalidateNative() {
    clearSecrets();
    setSelected((current) =>
      Object.fromEntries(Object.entries(current).filter(([, target]) => target.source !== "admin"))
    );
  }
  function nativeChanged(next: NativeState) {
    if (nativeRef.current.session && (!next.session || next.session.csrf !== nativeRef.current.session.csrf)) {
      invalidateNative();
    }
    setNative(next);
  }
  function select(targets: MCPTarget[], remove = false) {
    clearSecrets();
    setSelected((current) => {
      const next = { ...current };
      for (const target of targets) {
        if (remove) delete next[target.key];
        else next[target.key] = target;
      }
      return next;
    });
  }
  const targets = Object.values(selected);
  const configs = Object.values(results).flatMap((result) => (result.config ? [result.config] : []));
  const files = configurationFiles(configs);
  const successful = Object.values(results).filter((result) => result.status === "success").length;
  const failures = Object.values(results).filter((result) => result.status === "failure").length;
  async function generate() {
    if (pending.current || !targets.length || !name.trim()) return;
    const requested = targets.filter((target) => !receipts.current.has(targetVersion(target)));
    if (!requested.length) {
      setNotice("所选目标已签发成功。密钥关闭后无法找回；如需新密钥，请先在已有连接中撤销旧连接，再重新选择。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice("");
    const expected = epoch.current;
    for (const target of requested) {
      if (expected !== epoch.current) break;
      const key = targetVersion(target);
      const accountName =
        target.source === "admin"
          ? (nativeRef.current.session?.name ?? "未验证账号")
          : currentUser?.display_name || currentUser?.first_name || "当前账号";
      try {
        let config: MCPConfig | undefined;
        let expires: string;
        const label = name.trim();
        if (target.source === "admin") {
          const state = nativeRef.current;
          if (!state.options || !state.session || !state.candidates?.workspaces.includes(target.workspace))
            throw new Error("请先验证行政身份并刷新候选范围。");
          // Issue sequentially so a target change can stop the remaining batch.
          // eslint-disable-next-line no-await-in-loop
          const result = await nativeService.write<TNativeConnection>(
            "tokens",
            { workspace: target.workspace, label, days, publish: target.mode === "write" },
            state.options.csrf_token,
            state.session.csrf
          );
          receipts.current.set(key, result.id);
          expires = new Date(result.expires * 1000).toLocaleString();
          try {
            config = nativeConfig(result);
          } catch {
            /* issuance succeeded; never retry it as a failed issuance */
          }
        } else {
          // eslint-disable-next-line no-await-in-loop
          const result = await researchService.issue(
            target.workspace,
            { node_id: target.nodeId!, label, mode: target.mode, actions: target.actions },
            target.csrf
          );
          receipts.current.set(key, result.id);
          expires = new Date(result.expires_at).toLocaleString();
          config = researchConfig(result);
        }
        if (expected === epoch.current)
          setResults((current) => ({
            ...current,
            [key]: {
              target,
              accountName,
              status: "success",
              message: config ? "已生成" : "已生成；服务返回的配置格式无法识别，请联系管理员，勿重复签发。",
              config,
              expires,
            },
          }));
      } catch (failure) {
        if (expected === epoch.current)
          setResults((current) => ({
            ...current,
            [key]: {
              target,
              accountName,
              status: receipts.current.has(key) ? "success" : "failure",
              message: failureMessage(failure),
            },
          }));
      }
    }
    pending.current = false;
    setBusy(false);
    setVersion((value) => value + 1);
    setNativeVersion((value) => value + 1);
  }
  async function revokeConnection() {
    if (!revoke || revoking.current || pending.current) return;
    revoking.current = true;
    setBusy(true);
    setRevokeError("");
    clearSecrets();
    try {
      if (revoke.source === "admin") {
        const state = nativeRef.current;
        if (!state.options || !state.session) throw new Error("请重新验证行政身份。");
        await nativeService.write(`tokens/${revoke.id}/revoke`, {}, state.options.csrf_token, state.session.csrf);
      } else await researchService.revoke(revoke.workspace, revoke.id, revoke.csrf);
      // Explicit revocation permits a new issuance for this target.
      for (const [key, id] of receipts.current) if (id === revoke.id) receipts.current.delete(key);
      setRevoke(null);
      setNotice("连接已撤销，后续机器请求将被拒绝。");
      setVersion((value) => value + 1);
      setNativeVersion((value) => value + 1);
    } catch (failure) {
      setRevokeError(failureMessage(failure));
    } finally {
      revoking.current = false;
      setBusy(false);
    }
  }
  const workspaces = Object.values(workspaceStore.workspaces);
  return (
    <div className="space-y-6 text-13 text-primary">
      <PageHead title="MCP 配置" />
      <header className="space-y-2">
        <h1 className="text-24 font-semibold">MCP 配置</h1>
        <p className="text-secondary">验证接入身份、选择访问范围，并集中管理所有连接。</p>
      </header>
      <section aria-label="创建连接" className="space-y-5 rounded-xl border border-subtle p-4 sm:p-5">
        <div className="space-y-1">
          <h2 className="text-18 font-semibold">创建连接</h2>
          <p className="text-secondary">先验证行政身份或展开科研工作区，再选择需要访问的内容。</p>
        </div>
        <NativeMCPManager
          state={native}
          onChange={nativeChanged}
          onInvalidate={invalidateNative}
          refreshVersion={nativeVersion}
          disabled={busy}
        />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-label="选择连接目标" className="min-w-0 space-y-4">
            <h3 className="text-16 font-semibold">选择访问范围</h3>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setQuery(searchInput.trim());
              }}
            >
              <label className="min-w-40 flex-1 text-12 text-secondary">
                搜索工作区、科研链或节点
                <input
                  aria-label="搜索连接目标"
                  maxLength={200}
                  className={`mt-1 block w-full text-13 text-primary ${inputClass}`}
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              </label>
              <Button type="submit">搜索</Button>
            </form>
            <div className="space-y-3" aria-label="工作区与能力选择">
              {native.session &&
                native.candidates?.workspaces
                  .filter((slug) => !query || slug.toLowerCase().includes(query.toLowerCase()))
                  .map((slug) => {
                    // Keep successful receipts across session renewal, but never across
                    // independent portal identities or instances with the same workspace name.
                    const key = `admin:${native.options?.plane_ui_url ?? native.options?.portal_url}:${native.candidates!.account.id}:${slug}`;
                    const target: MCPTarget = {
                      key,
                      source: "admin",
                      workspace: slug,
                      workspaceName: `${slug} · 行政账号 ${native.session!.name}`,
                      title: "行政项目访问",
                      mode: "read",
                      actions: [],
                      csrf: native.options!.csrf_token,
                    };
                    const chosen = selected[key];
                    return (
                      <section key={key} className="space-y-3 rounded border border-subtle p-4">
                        <h4 className="font-medium">
                          {slug} · 行政来源 {native.options?.plane_ui_url} · {native.session?.name}
                        </h4>
                        <label className="block">
                          <input
                            aria-label={`行政项目访问 ${slug}`}
                            type="checkbox"
                            disabled={busy}
                            checked={Boolean(chosen)}
                            onChange={() => select([target], Boolean(chosen))}
                          />{" "}
                          行政项目访问（读取）
                        </label>
                        {chosen && native.options?.allow_publish && (
                          <label className="block pl-5">
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={chosen.mode === "write"}
                              onChange={(event) =>
                                select([{ ...chosen, mode: event.target.checked ? "write" : "read" }])
                              }
                            />{" "}
                            允许准备并发布行政进展评论
                          </label>
                        )}
                      </section>
                    );
                  })}
              {workspaceLoading && <p role="status">正在加载本实例工作区…</p>}
              {workspaceError && (
                <div role="alert">
                  <p>{workspaceError}</p>
                  <Button onClick={() => setWorkspaceRetry((value) => value + 1)}>重试工作区</Button>
                </div>
              )}
              {workspaces.map((workspace) => (
                <ResearchWorkspacePicker
                  key={workspace.id}
                  workspace={workspace}
                  query={query}
                  selected={selected}
                  disabled={busy}
                  onSelect={select}
                  version={version}
                  initiallyOpen={workspace.slug === initialWorkspace}
                />
              ))}
            </div>
          </section>
          <section
            aria-label="授权摘要"
            className="space-y-4 rounded-lg border border-subtle bg-surface-2 p-4 xl:sticky xl:top-4"
          >
            <h3 className="text-16 font-semibold">授权摘要</h3>
            <p>
              已选择 {new Set(targets.map((target) => `${target.source}:${target.workspace}`)).size} 个来源工作区、
              {targets.filter((target) => target.source === "research").length} 个科研节点，共 {targets.length}{" "}
              条独立连接。
            </p>
            {targets.length === 0 && <p className="text-secondary">请选择需要访问的工作区或科研节点。</p>}
            <ul className="max-h-56 space-y-2 overflow-y-auto text-secondary">
              {targets.map((target) => (
                <li key={target.key}>
                  {target.workspaceName} · {target.source === "admin" ? "行政" : `科研 ${target.chainTitle} /`}{" "}
                  {target.title} · {capabilities(target)}
                </li>
              ))}
            </ul>
            <p>科研写入仍须经过“准备提案 → 人工确认 → 执行”。选择写入能力不会批准任何具体提案。</p>
            <label className="block">
              连接名称
              <input
                aria-label="连接名称"
                className={`mt-1 block w-full ${inputClass}`}
                maxLength={64}
                disabled={busy}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {targets.some((target) => target.source === "admin") && (
              <label className="block">
                行政连接有效天数（最长 {native.options?.max_token_days} 天）
                <input
                  aria-label="行政连接有效天数"
                  className={`mt-1 block w-24 ${inputClass}`}
                  type="number"
                  min={1}
                  max={native.options?.max_token_days}
                  disabled={busy}
                  value={days}
                  onChange={(event) => setDays(Number(event.target.value))}
                />
              </label>
            )}
            {targets.some((target) => target.source === "research") && (
              <p>
                科研节点有效期由服务端固定：
                {[
                  ...new Set(
                    targets.filter((target) => target.source === "research").map((target) => target.ttlSeconds)
                  ),
                ].join(" / ")}{" "}
                秒。下方生成结果显示实际到期时间。
              </p>
            )}
            <Button
              className="w-full"
              disabled={
                busy ||
                !targets.length ||
                !name.trim() ||
                targets.some(
                  (target) => target.mode === "write" && target.source === "research" && !target.actions.length
                ) ||
                (targets.some((target) => target.source === "admin") &&
                  (!Number.isInteger(days) || days < 1 || days > (native.options?.max_token_days ?? 0)))
              }
              onClick={() => void generate()}
            >
              {busy ? "正在处理…" : failures ? "重试未成功目标" : "批量生成独立连接"}
            </Button>
          </section>
        </div>
      </section>
      {Object.keys(results).length > 0 && (
        <section aria-label="批量生成结果" className="space-y-4 rounded-xl border border-subtle p-4 sm:p-5">
          <h2 className="text-16 font-semibold">
            本次生成结果：{successful} 成功、{failures} 失败
          </h2>
          {Object.entries(results).map(([key, result]) => (
            <p key={key} role={result.status === "failure" ? "alert" : "status"}>
              账号：{result.accountName} ·{" "}
              {result.target.mode === "read"
                ? "只读"
                : result.target.source === "admin"
                  ? "读写（进展发布）"
                  : "读写（受控）"}{" "}
              · 到期时间：
              {result.expires ?? (result.status === "failure" ? "未签发" : "未提供")}
              {result.message !== "已生成" && ` · ${result.message}`}
            </p>
          ))}
          {configs.length > 0 && (
            <>
              <p>
                密钥仅本次展示。关闭结果、修改目标或退出验证后清除。配置包含多个命名服务项，各自使用独立地址及密钥。
              </p>
              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <label className="block min-w-0">
                  Codex TOML
                  <textarea
                    aria-label="批量 TOML 配置"
                    readOnly
                    className="font-mono mt-1 h-48 w-full rounded border border-subtle bg-surface-1 p-3"
                    value={files.toml}
                  />
                </label>
                <label className="block min-w-0">
                  通用 MCP JSON
                  <textarea
                    aria-label="批量 JSON 配置"
                    readOnly
                    className="font-mono mt-1 h-48 w-full rounded border border-subtle bg-surface-1 p-3"
                    value={files.json}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void copyTextToClipboard(files.toml).then(
                      () => setNotice("配置已复制。"),
                      () => setNotice("复制失败，请手动选择配置。")
                    )
                  }
                >
                  复制 TOML
                </Button>
                <Button variant="secondary" onClick={() => download(files.toml, "toml")}>
                  导出 TOML
                </Button>
                <Button variant="secondary" onClick={() => download(files.json, "json")}>
                  导出 JSON
                </Button>
              </div>
            </>
          )}
          <Button variant="secondary" onClick={clearSecrets}>
            关闭生成结果并清除密钥
          </Button>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      <ExistingMCPConnections
        native={native}
        workspaces={workspaces}
        version={version}
        disabled={busy}
        workspaceLoading={workspaceLoading}
        workspaceError={workspaceError}
        onRetryWorkspaces={() => setWorkspaceRetry((value) => value + 1)}
        onRevoke={(connection) => {
          setRevokeError("");
          setRevoke(connection);
        }}
      />
      <AlertModalCore
        isOpen={Boolean(revoke)}
        handleClose={() => {
          if (!revoking.current) setRevoke(null);
        }}
        handleSubmit={revokeConnection}
        isSubmitting={busy}
        title="确认撤销连接"
        content={
          <>
            <p>
              {revoke?.label} · {revoke?.workspace}：撤销后此连接将无法继续访问，操作不能恢复。
            </p>
            {revokeError && <p role="alert">{revokeError}</p>}
          </>
        }
      />
    </div>
  );
});
