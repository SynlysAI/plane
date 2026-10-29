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
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUser } from "@/hooks/store/user";
import type { TNativeConnection } from "@/services/mcp.service";
import { NativeMCPManager } from "./native-mcp-manager";
import { emptyNative, nativeService, researchService, type NativeState } from "./mcp-services";
import { ResearchWorkspacePicker } from "./research-workspace-picker";
import { NativeWorkspacePicker } from "./native-workspace-picker";
import { AuthorizationSummary } from "./authorization-summary";
import { GeneratedConnections, type ConnectionResult } from "./generated-connections";
import { ExistingMCPConnections } from "./existing-connections";
import { nativeConfig, researchConfig, failureMessage, parseNativeDays, type MCPConfig } from "./connection-config";
import { targetVersion, type MCPTarget } from "./types";

type Revoke = { source: "admin" | "research"; workspace: string; id: string; label: string; csrf: string };
const inputClass = "rounded border border-subtle bg-surface-1 px-3 py-2";
export const LegacyMCPManagement = observer(function LegacyMCPManagement({
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
  const [selected, setSelected] = useState<Record<string, MCPTarget>>({});
  const [results, setResults] = useState<Record<string, ConnectionResult>>({});
  const receipts = useRef(new Map<string, string>());
  const epoch = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [nativeVersion, setNativeVersion] = useState(0);
  const [name, setName] = useState("我的 Agent");
  const [days, setDays] = useState("7");
  const [query, setQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [notice, setNotice] = useState("");
  const [revoke, setRevoke] = useState<Revoke | null>(null);
  const [revokeError, setRevokeError] = useState("");
  const revoking = useRef(false);
  const maxNativeDays = native.options?.max_token_days;
  useEffect(() => {
    if (maxNativeDays)
      setDays((current) => {
        const value = Number(current);
        return current.trim() && Number.isFinite(value) ? String(Math.min(value, maxNativeDays)) : current;
      });
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
    nativeRef.current = next;
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
  const failures = Object.values(results).filter((result) => result.status === "failure").length;
  const nativeDays = parseNativeDays(days, maxNativeDays);
  const canGenerate =
    targets.length > 0 &&
    Boolean(name.trim()) &&
    targets.every((target) =>
      target.source === "admin" ? nativeDays !== null : target.mode === "read" || target.actions.length > 0
    );
  async function generate() {
    if (pending.current || !canGenerate) return;
    const requested = targets.filter((target) => !receipts.current.has(targetVersion(target)));
    if (!requested.length) {
      setNotice("所选目标已签发成功。密钥关闭后无法找回；如需新密钥，请先在已有连接中撤销旧连接，再重新选择。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setNotice("");
    const expected = epoch.current;
    try {
      /* eslint-disable no-await-in-loop -- Each completed issuance is a cancellation checkpoint. */
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
            // A target/session change must stop this batch before another credential is issued.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const result = await nativeService.write<TNativeConnection>(
              "tokens",
              { workspace: target.workspace, label, days: nativeDays, publish: target.mode === "write" },
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
            // Deliberately sequential for the same cancellation boundary as administrative issuance.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
      /* eslint-enable no-await-in-loop */
    } finally {
      pending.current = false;
      setBusy(false);
      setVersion((value) => value + 1);
      setNativeVersion((value) => value + 1);
    }
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
      <header className="space-y-2">
        <h2 className="text-18 font-semibold">兼容连接</h2>
        <p className="text-secondary">旧行政门户与单节点科研连接保持原授权范围，不会自动扩大或替换。</p>
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
              <NativeWorkspacePicker {...{ native, query, selected, busy, select }} />
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
          <AuthorizationSummary
            {...{ targets, native, name, setName, days, setDays, busy, failures, canGenerate, generate }}
            validDays={nativeDays !== null}
          />
        </div>
      </section>
      <GeneratedConnections {...{ results, setNotice, clearSecrets }} />
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
