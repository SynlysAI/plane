/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import {
  Activity,
  ArrowUp,
  ChevronDown,
  Cloud,
  FileSearch,
  HardDrive,
  Link2,
  Loader2,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@plane/propel/button";
import { EPortalPosition, EPortalWidth, ModalPortal } from "@plane/propel/portal";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// components
import { useAssistantChat } from "./use-assistant-chat";
import { mergeRuntimeToolCalls } from "./lib/runtime-events";
import { useWorkbenchChat } from "./use-workbench-chat";
import type { TAssistantStatus } from "@/services/assistant";
// store
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

type Props = {
  workspaceSlug: string;
  statusState: TAssistantStatus["state"] | "loading";
  onRetryStatus?: () => void;
};

/** Render assistant markdown with restrained Plane surface and typography tokens. */
const AnswerMarkdown = observer(function AnswerMarkdown({ content }: { content: string }) {
  return (
    <div className="answer-markdown min-w-0 text-13 leading-relaxed break-words text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto rounded-md border border-subtle">
              <table className="w-full border-collapse text-left text-12">{children}</table>
            </div>
          ),
          th: ({ children, style }) => (
            <th style={style} className="border-b border-subtle bg-surface-2 px-3 py-2 font-semibold whitespace-nowrap">
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td style={style} className="min-w-32 border-b border-subtle px-3 py-2 align-top">
              {children}
            </td>
          ),
          pre: ({ children }) => (
            <pre className="font-mono my-2 overflow-x-auto rounded-lg bg-surface-2 p-3 text-12 text-primary">
              {children}
            </pre>
          ),
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-1">{children}</ol>,
          h1: ({ children }) => <h3 className="mt-3 mb-1 text-14 font-semibold text-primary">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-3 mb-1 text-14 font-semibold text-primary">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-2.5 mb-1 text-13 font-semibold text-primary">{children}</h4>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-primary underline">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-accent-primary/50 my-2 border-l-2 pl-3 text-secondary">{children}</blockquote>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

/** Render a compact tool fact without exposing raw arguments or credentials. */
function ToolLine({ name, status }: { name: string; status?: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-subtle px-4 py-2.5 text-11 text-secondary last:border-b-0">
      <Wrench className="size-3.5 shrink-0 text-tertiary" />
      <span className="min-w-0 flex-1 truncate font-medium text-primary">{name}</span>
      {status && <span className="shrink-0 text-tertiary">{status}</span>}
    </div>
  );
}

export const AIAssistantPanel = observer(function AIAssistantPanel({
  workspaceSlug,
  statusState,
  onRetryStatus,
}: Props) {
  const { t } = useTranslation();
  const assistantStore = useAIAssistant();
  const cloudReady = statusState === "ready";
  const cloud = useAssistantChat(workspaceSlug, { enabled: cloudReady });
  const local = useWorkbenchChat(workspaceSlug, assistantStore.contextNodeId);
  const [input, setInput] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const provider = assistantStore.activeProvider;
  const busy =
    provider === "cloud"
      ? ["connecting", "running", "waiting_approval", "cancelling", "disconnected"].includes(cloud.streamState.phase)
      : local.busy;
  const disconnectCloud = cloud.disconnect;
  const localAvailable = Boolean(assistantStore.contextNodeId);
  const effectiveDockMode = assistantStore.dockMode === "docked" && isDesktop;

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setIsDesktop(false);
      return;
    }
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!assistantStore.isOpen) disconnectCloud();
  }, [assistantStore.isOpen, disconnectCloud]);

  useEffect(() => {
    if (
      assistantStore.activeProvider === "local" &&
      cloud.contextEnvelope &&
      cloud.contextEnvelope.target_type !== "RESEARCH_CHAIN_NODE"
    ) {
      assistantStore.setProvider("cloud");
    }
  }, [assistantStore, cloud.contextEnvelope]);

  useEffect(() => {
    listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [cloud.messages.length, cloud.streamingAnswer, local.sections]);

  const send = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    setInput("");
    if (provider === "local" && localAvailable) void local.send(trimmed);
    else void cloud.send(trimmed);
  };

  /** Start a clean conversation, explicitly cancelling a still-running turn first. */
  const startNewConversation = async () => {
    if (busy) {
      if (provider === "local") await local.stop();
      else await cloud.stop();
    }
    if (provider === "local") local.reset();
    else cloud.reset();
    assistantStore.setActiveView("conversation");
  };

  /** Drag a docked panel without overlaying or blocking the main workspace. */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!effectiveDockMode) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = assistantStore.width;
    const move = (moveEvent: PointerEvent) => {
      assistantStore.setWidth(startWidth + startX - moveEvent.clientX);
    };
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
  };

  const providerSelect = (
    <label className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-11 text-secondary transition hover:bg-surface-2">
      {provider === "cloud" ? (
        <Cloud className="size-3.5 text-accent-primary" />
      ) : (
        <HardDrive className="size-3.5 text-accent-primary" />
      )}
      <select
        value={provider}
        onChange={(event) => assistantStore.setProvider(event.target.value as "cloud" | "local")}
        className="cursor-pointer appearance-none bg-transparent pr-0.5 outline-none"
        aria-label={t("aiAssistant.provider")}
      >
        <option value="cloud">{t("aiAssistant.provider_cloud")}</option>
        <option value="local" disabled={!localAvailable}>
          {t("aiAssistant.provider_local")}
        </option>
      </select>
      <ChevronDown className="size-3 text-tertiary" />
    </label>
  );

  const viewTabs = [
    { key: "conversation", label: t("aiAssistant.view_conversation"), Icon: MessagesSquare },
    { key: "context", label: t("aiAssistant.view_context"), Icon: FileSearch },
    { key: "runtime", label: t("aiAssistant.view_runtime"), Icon: Activity },
  ] as const;

  const statusGuidance = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="max-w-72">
        <p className="text-14 font-medium text-primary">{t(`aiAssistant.status_${statusState}`)}</p>
        <p className="mt-1.5 text-12 leading-relaxed text-secondary">{t(`aiAssistant.status_${statusState}_hint`)}</p>
      </div>
      {statusState === "personal_credential_required" && (
        <Link
          href="/settings/profile/agent-configuration"
          className="rounded-md border border-subtle px-3 py-1.5 text-12 text-primary transition hover:bg-surface-2"
        >
          {t("aiAssistant.configure_token")}
        </Link>
      )}
      {statusState === "not_configured" && (
        <Link
          href={`/${workspaceSlug}/research/settings/integrations`}
          className="rounded-md border border-subtle px-3 py-1.5 text-12 text-primary transition hover:bg-surface-2"
        >
          {t("aiAssistant.open_workspace_settings")}
        </Link>
      )}
      {statusState === "service_unavailable" && (
        <Button variant="secondary" size="sm" onClick={onRetryStatus}>
          <RefreshCw className="size-3" />
          {t("aiAssistant.retry_status")}
        </Button>
      )}
    </div>
  );

  const conversationComposer = (
    <>
      <div className="focus-within:border-accent-primary mx-4 mb-2 shrink-0 rounded-xl border border-subtle bg-layer-1 p-2.5 transition">
        <textarea
          value={input}
          rows={1}
          placeholder={t("aiAssistant.placeholder")}
          aria-label={t("aiAssistant.placeholder")}
          className="max-h-32 min-h-6 w-full resize-none bg-transparent text-13 text-primary outline-none placeholder:text-tertiary"
          disabled={provider === "cloud" && !cloudReady}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(input);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2 pt-1.5">
          <div className="flex min-w-0 items-center gap-1">
            {providerSelect}
            {cloud.contextEnvelope && (
              <span
                className="flex min-w-0 items-center gap-1 text-10 text-tertiary"
                title={cloud.contextEnvelope.target_hierarchy.map((item) => item.title).join(" / ")}
              >
                <Link2 className="size-3 shrink-0 text-accent-primary" />
                <span className="truncate">{t("aiAssistant.context_linked")}</span>
              </span>
            )}
          </div>
          {busy ? (
            <button
              type="button"
              onClick={() => (provider === "cloud" ? void cloud.stop() : void local.stop())}
              aria-label={t("aiAssistant.stop")}
              className="hover:bg-surface-2-hover flex size-7 items-center justify-center rounded-lg bg-surface-2 text-danger-primary transition"
            >
              <Square className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => send(input)}
              disabled={!input.trim() || (provider === "cloud" && !cloudReady)}
              aria-label={t("aiAssistant.send")}
              className="flex size-7 items-center justify-center rounded-lg bg-accent-primary text-on-color transition hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <p className="shrink-0 pb-3 text-center text-10 text-tertiary">{t("aiAssistant.disclaimer")}</p>
    </>
  );

  const runtimeTools = useMemo(() => mergeRuntimeToolCalls(cloud.runtimeEvents), [cloud.runtimeEvents]);
  const approvalEvents = useMemo(
    () => cloud.runtimeEvents.filter((event) => event.event_type === "APPROVAL"),
    [cloud.runtimeEvents]
  );
  const contextSnapshots = useMemo(
    () => cloud.runtimeEvents.filter((event) => event.event_type === "CONTEXT_ASSEMBLED"),
    [cloud.runtimeEvents]
  );
  const contextAccessEvents = useMemo(
    () => cloud.runtimeEvents.filter((event) => event.event_type === "CONTEXT_ACCESSED"),
    [cloud.runtimeEvents]
  );
  const currentRunningTool = runtimeTools.find((tool) => tool.status === "running");
  const phaseLabels: Record<string, string> = {
    idle: "空闲",
    connecting: "连接中",
    running: "执行中",
    waiting_approval: "等待审批",
    cancelling: "正在停止",
    completed: "已完成",
    failed: "执行失败",
    cancelled: "已取消",
    disconnected: "连接中断，正在重连",
    expired: "上下文已过期",
  };
  const phaseLabel = phaseLabels[cloud.streamState.phase] ?? cloud.streamState.phase;
  const latestEventLabel = cloud.latestEventAt
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
        new Date(cloud.latestEventAt)
      )
    : "暂无事件";

  const contextView = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-11">
      <section className="pb-4">
        <h3 className="mb-2 text-12 font-semibold text-primary">已注入摘要</h3>
        <p className="leading-relaxed break-words text-secondary">
          {cloud.contextEnvelope?.target_hierarchy.map((item) => item.title).join(" / ") ||
            t("aiAssistant.context_workspace_only")}
        </p>
        <p className="mt-2 text-tertiary">
          资源 {cloud.contextEnvelope?.resources_summary.total ?? 0} 项 · 授权版本 v
          {cloud.contextEnvelope?.context_version ?? "—"}
        </p>
        <ul className="mt-1 space-y-1 text-secondary">
          {Object.entries(cloud.contextEnvelope?.resources_summary.by_kind ?? {}).map(([kind, count]) => (
            <li key={kind}>
              {kind}: {count}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-10 break-all text-tertiary">Manifest {cloud.contextEnvelope?.manifest_hash || "—"}</p>
        <p className="mt-2 leading-relaxed break-words whitespace-pre-wrap text-secondary">
          {cloud.contextEnvelope?.manifest_summary?.summary || "暂无摘要"}
        </p>
        {Boolean(cloud.contextEnvelope?.manifest_summary?.resources.length) && (
          <details className="mt-2">
            <summary className="cursor-pointer text-secondary">
              资源清单（{cloud.contextEnvelope?.manifest_summary?.resources.length ?? 0}）
            </summary>
            <ul className="mt-2 divide-y divide-subtle">
              {cloud.contextEnvelope?.manifest_summary?.resources.map((resource) => (
                <li key={`${resource.kind}-${resource.id}`} className="py-1.5">
                  <p className="break-words text-primary">{resource.title || resource.id}</p>
                  <p className="text-tertiary">
                    {resource.kind}
                    {resource.status ? ` · ${resource.status}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="border-t border-subtle py-4">
        <h3 className="mb-2 text-12 font-semibold text-primary">已授权能力</h3>
        <p className="text-tertiary">工具白名单</p>
        <p className="mt-1 break-words text-secondary">
          {cloud.contextEnvelope?.capabilities.allowed_tools.join(" · ") || "未授权工具"}
        </p>
        <p className="mt-2 text-tertiary">插件 · MCP · 知识库 · 文件范围</p>
        <p className="mt-1 break-words text-secondary">
          {[
            ...(cloud.contextEnvelope?.capabilities.allowed_plugins ?? []),
            ...(cloud.contextEnvelope?.capabilities.allowed_mcp_ids ?? []),
            ...(cloud.contextEnvelope?.capabilities.allowed_knowledge_base_ids ?? []),
            ...(cloud.contextEnvelope?.capabilities.allowed_file_ids ?? []),
          ].join(" · ") || "无额外授权范围"}
        </p>
        <p className="mt-2 text-tertiary">有效期至 {cloud.contextEnvelope?.expiry ?? "—"}</p>
      </section>

      <section className="border-t border-subtle pt-4">
        <h3 className="mb-2 text-12 font-semibold text-primary">实际访问证据</h3>
        {contextAccessEvents.length === 0 ? (
          <p className="text-secondary">尚未读取</p>
        ) : (
          <ul className="space-y-2">
            {contextAccessEvents.map((event) => (
              <li key={`${event.run_id}-${event.source_seq ?? event.seq}`} className="border-l border-subtle pl-3">
                <p className="font-medium text-primary">
                  {String(event.payload.name ?? event.raw_event_type ?? "上下文资源")}
                </p>
                <p className="mt-0.5 text-secondary">
                  {String(event.payload.status ?? "已访问")} · {event.created_at}
                </p>
                {Boolean(event.payload.resource_id) && (
                  <p className="mt-0.5 break-all text-tertiary">{String(event.payload.resource_id)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
  const localRuntimeFacts =
    provider === "local"
      ? local.sections.flatMap((section) =>
          section.items
            .filter((item) => item.kind === "tool" || item.kind === "approval")
            .map((item) => ({
              name: item.kind === "tool" ? item.name : t("aiAssistant.approval_pending"),
              status: item.kind === "tool" ? item.status : t("aiAssistant.view_runtime"),
            }))
        )
      : [];

  const runtimeView = (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
      <section>
        <h3 className="mb-2 text-12 font-semibold text-primary">实时事件</h3>
        {cloud.runtimeEvents.length ? (
          <ol className="space-y-2">
            {cloud.runtimeEvents.map((event) => {
              const summary =
                event.payload.summary ??
                event.payload.error ??
                event.payload.content ??
                event.payload.status ??
                event.payload.name;
              return (
                <li key={`${event.run_id}-${event.source_seq ?? event.seq}`} className="border-l border-subtle pl-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-medium text-primary">
                      {String(event.raw_event_type ?? event.event_type)}
                    </span>
                    <time className="shrink-0 text-10 text-tertiary">
                      {event.created_at
                        ? new Intl.DateTimeFormat(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          }).format(new Date(event.created_at))
                        : ""}
                    </time>
                  </div>
                  {summary !== undefined && <p className="mt-0.5 break-words text-secondary">{String(summary)}</p>}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-11 text-tertiary">{t("aiAssistant.runtime_empty")}</p>
        )}
      </section>

      <section className="border-t border-subtle pt-4">
        <h3 className="mb-2 text-12 font-semibold text-primary">{t("aiAssistant.runtime_events")}</h3>
        {provider === "cloud" && runtimeTools.length ? (
          runtimeTools.map((tool) => (
            <details key={tool.id} className="border-b border-subtle last:border-b-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-11">
                <span className="min-w-0 flex-1 truncate font-medium text-primary">{tool.name}</span>
                <span className="shrink-0 text-tertiary">{tool.status}</span>
              </summary>
              <div className="space-y-2 bg-surface-2/60 px-4 py-3 text-10 text-secondary">
                <div>
                  <p className="mb-1 font-medium text-primary">{t("aiAssistant.runtime_arguments")}</p>
                  <pre className="max-h-40 overflow-auto rounded-md border border-subtle bg-surface-1 p-2 whitespace-pre-wrap">
                    {tool.arguments}
                  </pre>
                </div>
                {tool.result && (
                  <div>
                    <p className="mb-1 font-medium text-primary">{t("aiAssistant.runtime_result")}</p>
                    <p className="break-words">{tool.result}</p>
                  </div>
                )}
                {tool.duration_ms !== null && <p>{t("aiAssistant.runtime_duration", { count: tool.duration_ms })}</p>}
              </div>
            </details>
          ))
        ) : provider === "local" && localRuntimeFacts.length ? (
          localRuntimeFacts.map((fact) => <ToolLine key={`${fact.name}-${fact.status}`} {...fact} />)
        ) : (
          <p className="px-4 py-3 text-11 text-tertiary">{t("aiAssistant.runtime_empty")}</p>
        )}
      </section>

      {(approvalEvents.length > 0 || contextSnapshots.length > 0) && (
        <section className="border-t border-subtle pt-4">
          <h3 className="mb-2 text-12 font-semibold text-primary">{t("aiAssistant.runtime_trace")}</h3>
          {approvalEvents.map((event) => (
            <ToolLine key={event.seq} name={t("aiAssistant.approval_pending")} status={event.event_type} />
          ))}
          {contextSnapshots.map((event) => (
            <ToolLine
              key={event.seq}
              name={`${t("aiAssistant.current_context")} v${String(event.payload.context_version ?? 1)}`}
              status={String(event.payload.manifest_hash ?? "").slice(0, 10)}
            />
          ))}
        </section>
      )}
    </div>
  );

  const panelBody = (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <header className="h-14 shrink-0 border-b border-subtle px-4">
        <div className="flex h-14 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary text-on-color">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-14 leading-tight font-semibold text-primary">{t("aiAssistant.title")}</p>
              <p className="truncate text-11 leading-tight text-tertiary">{t("aiAssistant.subtitle")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant={effectiveDockMode ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                if (effectiveDockMode) {
                  assistantStore.setDockMode("floating");
                  return;
                }
                assistantStore.setDockMode("docked");
                assistantStore.toggleExpanded(false);
              }}
              aria-label={effectiveDockMode ? t("aiAssistant.unpin") : t("aiAssistant.pin")}
              title={effectiveDockMode ? t("aiAssistant.unpin") : t("aiAssistant.pin")}
            >
              {effectiveDockMode ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => assistantStore.toggleExpanded()}
              aria-label={assistantStore.expanded ? t("aiAssistant.collapse") : t("aiAssistant.expand")}
              title={assistantStore.expanded ? t("aiAssistant.collapse") : t("aiAssistant.expand")}
            >
              {assistantStore.expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void startNewConversation()}
              aria-label={t("aiAssistant.new_conversation")}
              title={t("aiAssistant.new_conversation")}
            >
              <Plus className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => assistantStore.close()}
              aria-label={t("aiAssistant.close")}
              title={t("aiAssistant.close")}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        </div>
      </header>

      <nav
        className="flex shrink-0 items-center gap-1 border-b border-subtle px-3 py-1.5"
        aria-label={t("aiAssistant.title")}
      >
        {viewTabs.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => assistantStore.setActiveView(key)}
            aria-pressed={assistantStore.activeView === key}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-11 transition ${
              assistantStore.activeView === key
                ? "bg-surface-2 font-medium text-primary"
                : "text-tertiary hover:bg-surface-2 hover:text-secondary"
            }`}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </nav>

      {cloud.contextEnvelope && (
        <div className="shrink-0 border-b border-subtle bg-surface-2 px-4 py-2">
          <p className="truncate text-10 text-secondary" title={cloud.contextEnvelope.session_binding.target_key}>
            {cloud.contextEnvelope.target_hierarchy.map((item) => item.title).join(" / ")}
          </p>
        </div>
      )}

      {provider === "cloud" && assistantStore.activeView === "conversation" && (
        <aside className="shrink-0 border-b border-subtle px-4 py-2 text-10 text-secondary" aria-label="当前运行状态">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{cloud.contextEnvelope?.status === "linked" ? "上下文已绑定" : `上下文 ${cloud.contextStatus}`}</span>
            <span>Grant v{cloud.contextEnvelope?.context_version ?? "—"}</span>
            <span>{phaseLabel}</span>
            <span>{runtimeTools.length} 次工具调用</span>
            {currentRunningTool && <span>当前工具：{currentRunningTool.name}</span>}
            {cloud.streamState.phase === "waiting_approval" && <span>等待审批</span>}
            <span>最近事件：{latestEventLabel}</span>
          </div>
          {cloud.streamState.error && <p className="mt-1 break-words text-danger-primary">{cloud.streamState.error}</p>}
        </aside>
      )}

      {provider === "cloud" && !cloudReady ? (
        <>
          {statusGuidance}
          {conversationComposer}
        </>
      ) : assistantStore.activeView === "context" ? (
        contextView
      ) : assistantStore.activeView === "runtime" ? (
        runtimeView
      ) : (
        <>
          <div ref={listRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
            {provider === "cloud" && cloud.messages.length === 0 && !cloud.streamingAnswer && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <span className="flex size-10 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                  <Sparkles className="size-5" />
                </span>
                <div>
                  <p className="text-14 font-medium text-primary">{t("aiAssistant.empty_greeting")}</p>
                  <p className="mt-1 text-12 text-tertiary">{t("aiAssistant.empty_hint")}</p>
                </div>
              </div>
            )}

            {provider === "cloud" &&
              cloud.messages.map((message) =>
                message.role === "user" ? (
                  <div key={message.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-primary px-3.5 py-2 text-13 leading-relaxed break-words whitespace-pre-wrap text-on-color">
                      {message.content}
                    </div>
                  </div>
                ) : (
                  <div key={message.id} className="flex gap-3">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                      <Sparkles className="size-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <AnswerMarkdown content={message.content} />
                    </div>
                  </div>
                )
              )}

            {provider === "cloud" &&
              (cloud.streamingAnswer ||
                ["connecting", "running", "waiting_approval", "cancelling"].includes(cloud.streamState.phase)) && (
                <div className="flex gap-3">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                    <Sparkles className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {cloud.streamingAnswer ? (
                      <>
                        <AnswerMarkdown content={cloud.streamingAnswer} />
                        <span className="ml-0.5 inline-block animate-pulse text-accent-primary">▍</span>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-11 text-tertiary">
                        <Loader2 className="size-3 animate-spin" />
                        {cloud.streamState.phase === "connecting" ? "正在连接…" : "正在处理…"}
                      </span>
                    )}
                  </div>
                </div>
              )}

            {provider === "cloud" && cloud.streamState.phase === "waiting_approval" && (
              <p className="rounded-lg bg-layer-1 px-3 py-2 text-11 text-secondary">正在等待审批，批准后会继续执行。</p>
            )}
            {provider === "cloud" && cloud.streamState.phase === "disconnected" && (
              <p className="px-3 py-2 text-11 text-secondary">连接已断开，正在从最近事件位置恢复。</p>
            )}
            {provider === "cloud" && ["failed", "expired"].includes(cloud.streamState.phase) && (
              <div className="flex items-center justify-between gap-2 rounded-lg bg-danger-subtle/50 px-3 py-2 text-12 text-danger-primary">
                <span>
                  {cloud.streamState.phase === "expired"
                    ? "上下文授权已过期，请刷新上下文后重试。"
                    : (cloud.streamState.error ?? t("aiAssistant.error_generic"))}
                </span>
                {cloud.streamState.canRetry && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void cloud.send(input || cloud.messages[cloud.messages.length - 1]?.content || "")}
                  >
                    <RefreshCw className="size-3" />
                    {t("aiAssistant.retry")}
                  </Button>
                )}
              </div>
            )}

            {provider === "local" &&
              local.sections.map((section) => (
                <div key={section.userKey} className="space-y-4">
                  <div className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-primary px-3.5 py-2 text-13 leading-relaxed whitespace-pre-wrap text-on-color">
                      {section.text}
                    </div>
                  </div>
                  {section.items.map((item) => {
                    const key = item.key;
                    if (item.kind === "assistant") {
                      return (
                        <div key={key} className="flex gap-3">
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
                            <Sparkles className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <AnswerMarkdown content={item.text} />
                            {item.streaming && (
                              <span className="ml-0.5 inline-block animate-pulse text-accent-primary">▍</span>
                            )}
                          </div>
                        </div>
                      );
                    }
                    if (item.kind === "tool") return <ToolLine key={key} name={item.name} status={item.status} />;
                    if (item.kind === "approval")
                      return (
                        <p key={key} className="rounded-lg bg-layer-1 px-3 py-2 text-11 text-secondary">
                          {t("aiAssistant.approval_pending")}
                        </p>
                      );
                    if (item.kind === "notice")
                      return (
                        <p
                          key={key}
                          className={`rounded-lg px-3 py-2 text-11 ${
                            item.tone === "error"
                              ? "bg-danger-subtle/50 text-danger-primary"
                              : "bg-layer-1 text-secondary"
                          }`}
                        >
                          {item.label}
                        </p>
                      );
                    return null;
                  })}
                </div>
              ))}

            {provider === "local" && !localAvailable && (
              <div className="flex h-full items-center justify-center text-center text-12 text-tertiary">
                {t("aiAssistant.local_unavailable")}
              </div>
            )}
            {provider === "local" && local.error && (
              <div className="rounded-lg bg-danger-subtle/50 px-3 py-2 text-12 text-danger-primary">{local.error}</div>
            )}
          </div>

          {provider === "local" && local.waitingApproval && (
            <div className="mx-4 mb-2 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-subtle bg-layer-1 px-3 py-2 text-12 text-secondary">
              <span>{t("aiAssistant.approval_pending")}</span>
              <div className="flex gap-1.5">
                <Button variant="primary" size="sm" onClick={() => void local.decide(true)}>
                  {t("aiAssistant.approve")}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void local.decide(false)}>
                  {t("aiAssistant.reject")}
                </Button>
              </div>
            </div>
          )}

          {conversationComposer}
        </>
      )}
    </div>
  );

  if (assistantStore.isOpen && effectiveDockMode && !assistantStore.expanded) {
    return (
      <aside
        aria-label={t("aiAssistant.title")}
        data-agent-dock-mode="docked"
        className="relative flex h-full shrink-0 flex-col border-l border-subtle bg-surface-1"
        style={{ width: `${assistantStore.width}px` }}
      >
        <div
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("aiAssistant.resize")}
          tabIndex={0}
          className="absolute top-0 left-0 h-full w-1 cursor-col-resize bg-transparent transition hover:bg-accent-primary/30 focus-visible:bg-accent-primary/40"
        />
        {panelBody}
      </aside>
    );
  }

  return (
    <ModalPortal
      isOpen={assistantStore.isOpen}
      onClose={() => assistantStore.close()}
      showOverlay={false}
      closeOnOverlayClick={false}
      className="pointer-events-none"
      position={EPortalPosition.RIGHT}
      width={assistantStore.expanded ? EPortalWidth.FULL : EPortalWidth.QUARTER}
      contentClassName="pointer-events-auto flex h-full min-w-[min(26.25rem,100vw)] flex-col border-l border-subtle bg-surface-1"
    >
      {panelBody}
    </ModalPortal>
  );
});
