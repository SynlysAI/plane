/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LocalDate } from "@/components/core/local-date";
import { useExpiration } from "@/hooks/use-expiration";
import { Button } from "@plane/propel/button";
import type { TResearchConnection } from "@/services/mcp.service";
import { researchService, type NativeState } from "./mcp-services";
import { failureMessage } from "./connection-config";

type Workspace = { slug: string; name: string };
type Revoke = { source: "admin" | "research"; workspace: string; id: string; label: string; csrf: string };
type Filter = "all" | "admin" | "research";
type ManagementProps = { disabled: boolean; onRevoke: (request: Revoke) => void };

export function ExistingMCPConnections({
  native,
  workspaces,
  version,
  disabled,
  onRevoke,
  workspaceLoading,
  workspaceError,
  onRetryWorkspaces,
}: ManagementProps & {
  native: NativeState;
  workspaces: Workspace[];
  version: number;
  workspaceLoading: boolean;
  workspaceError: string;
  onRetryWorkspaces: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const nativeTokens = native.tokens.filter((token) => !token.revoked);
  return (
    <section aria-label="已有连接" className="space-y-5 rounded-xl border border-subtle p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-18 font-semibold">已有连接</h2>
          <p className="text-secondary">集中查看和撤销行政、科研连接。完整密钥仅在生成时展示。</p>
        </div>
        <div role="group" aria-label="筛选已有连接" className="flex flex-wrap gap-2">
          {(
            [
              { value: "all", label: "全部连接" },
              { value: "admin", label: "行政连接" },
              { value: "research", label: "科研连接" },
            ] as const
          ).map((item) => (
            <Button
              key={item.value}
              variant={filter === item.value ? "primary" : "secondary"}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>
      </div>
      <div hidden={filter === "research"}>
        <section aria-label="已有行政连接" className="space-y-3">
          <h3 className="text-14 font-medium">
            行政连接{native.session && ` · ${native.session.name}`}
            <span className="font-normal ml-2 text-12 text-secondary">{native.options?.plane_ui_url}</span>
          </h3>
          {!native.session ? (
            <p className="text-secondary">验证行政身份后，可查看和管理此来源的已有连接。</p>
          ) : nativeTokens.length === 0 ? (
            <p className="text-secondary">尚无行政连接。</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {nativeTokens.map((token) => (
                <ConnectionCard
                  key={token.id}
                  source="admin"
                  label={token.label}
                  target={token.workspace}
                  workspace={token.workspace}
                  capability={token.publish ? "读取与进展发布" : "只读"}
                  expires={new Date(token.expires * 1000).toISOString()}
                  created={token.created ? new Date(token.created * 1000).toISOString() : null}
                  lastUsed={token.last_used ? new Date(token.last_used * 1000).toISOString() : null}
                  disabled={disabled}
                  onRevoke={() =>
                    onRevoke({
                      source: "admin",
                      workspace: token.workspace,
                      id: token.id,
                      label: token.label,
                      csrf: "",
                    })
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>
      <div hidden={filter === "admin"} className="space-y-5">
        {workspaceLoading && <p role="status">正在加载科研工作区…</p>}
        {workspaceError && (
          <div role="alert" className="space-y-2">
            <p>{workspaceError}</p>
            <Button variant="secondary" onClick={onRetryWorkspaces}>
              重试连接工作区
            </Button>
          </div>
        )}
        {workspaces.map((workspace) => (
          <ResearchConnections key={workspace.slug} {...{ workspace, version, disabled, onRevoke }} />
        ))}
      </div>
    </section>
  );
}

function ResearchConnections({
  workspace,
  version,
  disabled,
  onRevoke,
}: ManagementProps & { workspace: Workspace; version: number }) {
  const [connections, setConnections] = useState<TResearchConnection[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [csrf, setCsrf] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const pending = useRef(false);
  const retryCursor = useRef<string | undefined>(undefined);
  const load = useCallback(
    async (expected = generation.current, next?: string) => {
      if (pending.current) return;
      pending.current = true;
      retryCursor.current = next;
      setBusy(true);
      setError("");
      try {
        const page = await researchService.connections(workspace.slug, next);
        if (generation.current !== expected) return;
        const scoped = page.results.filter((connection) => connection.workspace === workspace.slug);
        setConnections((previous) => (next ? [...previous, ...scoped] : scoped));
        setCursor(page.next_cursor);
        setCsrf(page.csrf_token);
      } catch (failure) {
        if (generation.current === expected) setError(failureMessage(failure));
      } finally {
        if (generation.current === expected) {
          pending.current = false;
          // This is inside finally; only the current request may clear its loading state.
          // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally
          setBusy(false);
        }
      }
    },
    [workspace.slug]
  );
  useEffect(() => {
    const expected = ++generation.current;
    setConnections([]);
    setCursor(null);
    setCsrf("");
    pending.current = false;
    void load(expected);
    return () => {
      generation.current += 1;
    };
  }, [version, load]);
  const visible = connections.filter((connection) => !connection.revoked_at);
  if (!busy && !error && visible.length === 0 && !cursor) return null;
  return (
    <section aria-label={`科研连接 ${workspace.name}`} className="space-y-3">
      <h3 className="text-14 font-medium">科研连接 · {workspace.name}</h3>
      {error && (
        <div role="alert" className="space-y-2">
          <p>{error}</p>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void load(generation.current, retryCursor.current)}
          >
            重试连接列表
          </Button>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {visible.map((connection) => (
          <ConnectionCard
            key={connection.id}
            source="research"
            label={connection.label}
            target={`${workspace.name} · ${connection.chain_title} / ${connection.node_title}`}
            workspace={connection.workspace}
            capability={connection.mode === "write" ? "读取与受控写入" : "只读"}
            expires={connection.expires_at}
            created={connection.created_at}
            lastUsed={connection.last_used_at}
            disabled={disabled || !csrf}
            onRevoke={() =>
              onRevoke({
                source: "research",
                workspace: connection.workspace,
                id: connection.id,
                label: connection.label,
                csrf,
              })
            }
          />
        ))}
      </div>
      {busy && <p role="status">正在加载连接…</p>}
      {!busy && !error && visible.length === 0 && cursor && (
        <p className="text-secondary">当前已加载记录中没有未撤销的科研连接，可继续加载更多。</p>
      )}
      {cursor && (
        <Button variant="secondary" disabled={busy} onClick={() => void load(generation.current, cursor)}>
          加载更多科研连接
        </Button>
      )}
    </section>
  );
}

function ConnectionCard({
  source,
  label,
  target,
  workspace,
  capability,
  expires,
  created,
  lastUsed,
  disabled,
  onRevoke,
}: {
  source: "admin" | "research";
  label: string;
  target: string;
  workspace: string;
  capability: string;
  expires: string;
  created: string | null;
  lastUsed: string | null;
  disabled: boolean;
  onRevoke: () => void;
}) {
  const type = source === "admin" ? "行政" : "科研";
  const expired = useExpiration(expires);
  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-subtle p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="mr-auto text-14 font-medium break-words">{label}</h4>
        <span className="rounded bg-surface-2 px-2 py-0.5 text-11 text-secondary">兼容连接</span>
        <span className="rounded bg-surface-2 px-2 py-0.5 text-11 text-secondary">{type}</span>
        <span className="rounded bg-surface-2 px-2 py-0.5 text-11 text-secondary">{capability}</span>
        <span className="text-12 text-secondary">{expired === null ? "确认有效期…" : expired ? "已到期" : "有效"}</span>
      </div>
      <p className="text-12 break-words text-secondary">{target}</p>
      <div className="mt-auto flex flex-wrap items-start justify-between gap-3 border-t border-subtle pt-3">
        <details className="min-w-0 flex-1 text-12">
          <summary className="cursor-pointer text-secondary">查看详情</summary>
          <dl className="mt-2 space-y-1 break-words text-secondary">
            <div>
              <dt className="inline">工作区：</dt>
              <dd className="inline">{workspace}</dd>
            </div>
            <div>
              <dt className="inline">创建时间：</dt>
              <dd className="inline">
                <LocalDate value={created} emptyLabel="未提供" />
              </dd>
            </div>
            <div>
              <dt className="inline">到期时间：</dt>
              <dd className="inline">
                <LocalDate value={expires} emptyLabel="未提供" />
              </dd>
            </div>
            <div>
              <dt className="inline">最近使用时间：</dt>
              <dd className="inline">
                <LocalDate value={lastUsed} emptyLabel="尚未使用" />
              </dd>
            </div>
          </dl>
        </details>
        <Button variant="secondary" disabled={disabled} aria-label={`撤销${type}连接：${label}`} onClick={onRevoke}>
          撤销连接
        </Button>
      </div>
    </article>
  );
}
