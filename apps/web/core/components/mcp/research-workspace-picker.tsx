/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@plane/propel/button";
import { ResearchMCPService, type TMCPChain, type TMCPNode } from "@/services/mcp.service";
import { actionLabels, failureMessage } from "./connection-config";
import type { MCPTarget } from "./types";

export const researchService = new ResearchMCPService();
type SelectionProps = {
  selected: Record<string, MCPTarget>;
  disabled: boolean;
  onSelect: (targets: MCPTarget[], remove?: boolean) => void;
};
export function ResearchWorkspacePicker({
  workspace,
  query,
  selected,
  disabled,
  onSelect,
  version,
  initiallyOpen,
}: SelectionProps & {
  workspace: { slug: string; name: string };
  query: string;
  version: number;
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [chains, setChains] = useState<TMCPChain[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [csrf, setCsrf] = useState("");
  const [ttl, setTtl] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const loading = useRef(false);
  const loadChains = useCallback(
    async (expected = generation.current, next?: string) => {
      if (loading.current) return;
      loading.current = true;
      setBusy(true);
      setError("");
      try {
        const page = await researchService.candidates(workspace.slug, { q: query, cursor: next });
        if (generation.current !== expected) return;
        setChains((previous) =>
          next ? [...previous, ...(page.results as TMCPChain[])] : (page.results as TMCPChain[])
        );
        setCursor(page.next_cursor);
        setCsrf(page.csrf_token);
        setTtl(page.ttl_seconds ?? 0);
      } catch (failure) {
        if (generation.current === expected) setError(failureMessage(failure));
      } finally {
        if (generation.current === expected) {
          setBusy(false);
          loading.current = false;
        }
      }
    },
    [workspace.slug, query]
  );
  useEffect(() => {
    const expected = ++generation.current;
    setChains([]);
    setCursor(null);
    setError("");
    loading.current = false;
    if (open) {
      void loadChains(expected);
    }
    return () => {
      generation.current += 1;
    };
  }, [open, version, retry, loadChains]);

  return (
    <section className="rounded border border-subtle p-4" aria-label={`科研工作区 ${workspace.name}`}>
      <Button variant="secondary" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {workspace.name} · 本实例科研
      </Button>
      {open && (
        <div className="mt-3 space-y-3 pl-3">
          <h3 className="font-medium">科研链 / 科研节点</h3>
          <p>工作区仅用于分组；科研链的勾选只覆盖已加载并明确选择的节点，未来新增节点不会自动授权。</p>
          {ttl > 0 && (
            <p>
              节点连接实际有效期：{ttl} 秒（{Number((ttl / 86400).toFixed(2))} 天）。
            </p>
          )}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <Button variant="secondary" disabled={busy} onClick={() => setRetry((value) => value + 1)}>
                重试科研候选
              </Button>
            </div>
          )}
          {busy && <p role="status">正在加载科研链…</p>}
          {!busy && !error && chains.length === 0 && <p>没有可访问的科研链或搜索匹配项。</p>}
          {chains.map((chain) => (
            <ResearchChainPicker
              key={`${chain.id}:${query}:${retry}`}
              {...{ chain, workspace, query, csrf, ttl, selected, disabled, onSelect }}
            />
          ))}
          {cursor && (
            <Button variant="secondary" disabled={busy} onClick={() => void loadChains(generation.current, cursor)}>
              加载更多科研链
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function ResearchChainPicker({
  chain,
  workspace,
  query,
  csrf,
  ttl,
  selected,
  disabled,
  onSelect,
}: SelectionProps & {
  chain: TMCPChain;
  workspace: { slug: string; name: string };
  query: string;
  csrf: string;
  ttl: number;
}) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<TMCPNode[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const pending = useRef(false);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    []
  );
  async function load(next?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const expected = epoch.current;
    try {
      const page = await researchService.candidates(workspace.slug, { chain_id: chain.id, q: query, cursor: next });
      if (epoch.current !== expected) return;
      setNodes((previous) => (next ? [...previous, ...(page.results as TMCPNode[])] : (page.results as TMCPNode[])));
      setCursor(page.next_cursor);
    } catch (failure) {
      if (epoch.current === expected) setError(failureMessage(failure));
    } finally {
      if (epoch.current === expected) {
        setBusy(false);
        pending.current = false;
      }
    }
  }
  const target = (node: TMCPNode): MCPTarget => ({
    key: `research:${workspace.slug}:${node.id}`,
    source: "research",
    workspace: workspace.slug,
    workspaceName: workspace.name,
    title: node.title,
    chainTitle: chain.title,
    nodeId: node.id,
    mode: "read",
    actions: [],
    csrf,
    ttlSeconds: ttl,
  });
  const allSelected = nodes.length > 0 && nodes.every((node) => Boolean(selected[target(node).key]));
  return (
    <div className="space-y-2 border-l border-subtle pl-4">
      <Button
        variant="secondary"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open && nodes.length === 0) void load();
        }}
      >
        {chain.title} · {chain.status}
      </Button>
      {open && (
        <>
          {busy && <p role="status">正在加载节点…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <Button onClick={() => void load(cursor ?? undefined)}>重试节点</Button>
            </div>
          )}
          {nodes.length > 0 && (
            <label className="block">
              <input
                type="checkbox"
                disabled={disabled}
                checked={allSelected}
                onChange={() =>
                  onSelect(nodes.filter((node) => allSelected || !selected[target(node).key]).map(target), allSelected)
                }
              />{" "}
              选择此链已加载的 {nodes.length} 个节点（未选节点按只读添加）
            </label>
          )}
          {nodes.map((node) => {
            const item = target(node);
            const chosen = selected[item.key];
            return (
              <div key={node.id} className="space-y-2 rounded border border-subtle p-3">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`选择节点 ${node.title}`}
                    disabled={disabled}
                    checked={Boolean(chosen)}
                    onChange={() => onSelect([item], Boolean(chosen))}
                  />{" "}
                  {node.title} · {node.status}
                </label>
                {chosen && (
                  <div className="space-y-2 pl-5">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`受控写入 ${node.title}`}
                        disabled={disabled || node.actions.length === 0}
                        checked={chosen.mode === "write"}
                        onChange={(event) =>
                          onSelect([
                            {
                              ...chosen,
                              mode: event.target.checked ? "write" : "read",
                              actions: event.target.checked ? node.actions : [],
                            },
                          ])
                        }
                      />{" "}
                      允许准备受控写入提案
                    </label>
                    {node.write_unavailable_reason && <p className="text-secondary">{node.write_unavailable_reason}</p>}
                    {chosen.mode === "write" &&
                      node.actions.map((action) => (
                        <label key={action} className="block">
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={chosen.actions.includes(action)}
                            onChange={(event) =>
                              onSelect([
                                {
                                  ...chosen,
                                  actions: event.target.checked
                                    ? [...chosen.actions, action]
                                    : chosen.actions.filter((value) => value !== action),
                                },
                              ])
                            }
                          />{" "}
                          {actionLabels[action] ?? action}
                        </label>
                      ))}
                  </div>
                )}
              </div>
            );
          })}
          {cursor && (
            <Button variant="secondary" disabled={busy} onClick={() => void load(cursor)}>
              加载更多节点（未加载节点不会被全选）
            </Button>
          )}
          {!busy && !error && nodes.length === 0 && <p>没有匹配的可访问节点。</p>}
        </>
      )}
    </div>
  );
}
