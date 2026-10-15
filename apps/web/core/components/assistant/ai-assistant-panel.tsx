/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import {
  Sparkles,
  ArrowUp,
  Square,
  RefreshCw,
  Plus,
  X,
  Maximize2,
  Minimize2,
  Link2,
  ChevronDown,
  Cloud,
  HardDrive,
  Loader2,
  Wrench,
} from "lucide-react";
import { Button } from "@plane/propel/button";
import { EPortalPosition, EPortalWidth, ModalPortal } from "@plane/propel/portal";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// components
import { useAssistantChat } from "./use-assistant-chat";
import { useWorkbenchChat } from "./use-workbench-chat";
import { useAssistantPageContext } from "./use-assistant-page-context";
// store
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

type Props = {
  workspaceSlug: string;
};

/** AI answer rendering with design-spec markdown styles. */
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

const ThinkingBlock = observer(function ThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 text-11 text-tertiary transition hover:text-secondary"
      >
        <ChevronDown className={`size-3 transition-transform ${open ? "" : "-rotate-90"}`} />
        {t("aiAssistant.thinking")}
      </button>
      {open && (
        <p className="border-accent-primary/40 mt-1.5 max-h-48 overflow-y-auto rounded-lg border-l-2 bg-surface-1 p-2.5 text-11 leading-relaxed whitespace-pre-wrap text-tertiary">
          {text}
        </p>
      )}
    </div>
  );
});

export const AIAssistantPanel = observer(function AIAssistantPanel({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const assistantStore = useAIAssistant();
  const pageContext = useAssistantPageContext();
  const cloud = useAssistantChat(workspaceSlug, pageContext);
  const local = useWorkbenchChat(workspaceSlug, assistantStore.contextNodeId);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const provider = assistantStore.activeProvider;
  const busy =
    provider === "cloud" ? cloud.streamState.phase === "streaming" || cloud.streamState.phase === "queued" : local.busy;
  const localAvailable = Boolean(assistantStore.contextNodeId);

  const send = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || busy) return;
    setInput("");
    if (provider === "local" && localAvailable) void local.send(trimmed);
    else void cloud.send(trimmed);
  };

  const reset = () => {
    if (provider === "local") local.reset();
    else cloud.reset();
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
  return (
    <ModalPortal
      isOpen={assistantStore.isOpen}
      onClose={() => assistantStore.close()}
      position={EPortalPosition.RIGHT}
      width={assistantStore.expanded ? EPortalWidth.THREE_QUARTER : EPortalWidth.QUARTER}
      contentClassName={`bg-canvas border-l border-subtle flex h-full flex-col ${assistantStore.expanded ? "min-w-[min(24rem,100vw)]" : "min-w-[min(20rem,100vw)]"}`}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* header */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-subtle px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary text-on-color">
              <Sparkles className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-15 truncate leading-tight font-semibold text-primary">{t("aiAssistant.title")}</p>
              <p className="truncate text-11 leading-tight text-tertiary">{t("aiAssistant.subtitle")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
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
              onClick={reset}
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
        </header>

        {/* messages */}
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
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-primary px-3.5 py-2 text-13 leading-relaxed whitespace-pre-wrap text-on-color">
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

          {provider === "cloud" && (cloud.streamingAnswer || cloud.streamState.phase === "streaming") && (
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
                    {t("aiAssistant.working")}
                  </span>
                )}
              </div>
            </div>
          )}

          {provider === "cloud" && cloud.streamState.phase === "queued" && (
            <p className="text-11 text-tertiary">{t("aiAssistant.queued")}</p>
          )}
          {provider === "cloud" && cloud.streamState.phase === "interrupted" && (
            <p className="rounded-lg bg-surface-1 px-3 py-2 text-11 text-secondary">
              {t("aiAssistant.interrupt_notice")}
            </p>
          )}
          {provider === "cloud" && cloud.streamState.phase === "error" && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-danger-subtle/50 px-3 py-2 text-12 text-danger-primary">
              <span>{t("aiAssistant.error_generic")}</span>
              {cloud.streamState.canRetry && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => send(input || cloud.messages[cloud.messages.length - 1]?.content || "")}
                >
                  <RefreshCw className="size-3" />
                  {t("aiAssistant.retry")}
                </Button>
              )}
            </div>
          )}

          {provider === "local" &&
            local.items.map((item) => {
              const key = item.key;
              switch (item.kind) {
                case "user":
                  return (
                    <div key={key} className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-primary px-3.5 py-2 text-13 leading-relaxed whitespace-pre-wrap text-on-color">
                        {item.text}
                      </div>
                    </div>
                  );
                case "assistant":
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
                case "thinking":
                  return <ThinkingBlock key={key} text={item.text} />;
                case "process":
                  return (
                    <div key={key} className="flex items-center gap-1.5 text-11 text-tertiary">
                      <Loader2 className="size-3 animate-spin" />
                      {item.label}
                    </div>
                  );
                case "tool":
                  return (
                    <div key={key} className="flex items-center gap-1.5 text-11 text-tertiary">
                      <Wrench className="size-3" />
                      {item.name} · {item.status}
                    </div>
                  );
                case "approval":
                  return (
                    <div key={key} className="rounded-lg bg-surface-1 px-3 py-2 text-11 text-secondary">
                      {t("aiAssistant.approval_pending")}
                    </div>
                  );
                case "notice":
                  return (
                    <div
                      key={key}
                      className={`rounded-lg px-3 py-2 text-11 ${item.tone === "error" ? "bg-danger-subtle/50 text-danger-primary" : "bg-surface-1 text-secondary"}`}
                    >
                      {item.label}
                    </div>
                  );
                default:
                  return null;
              }
            })}

          {provider === "local" && !localAvailable && (
            <div className="flex h-full items-center justify-center text-center text-12 text-tertiary">
              {t("aiAssistant.local_unavailable")}
            </div>
          )}
          {provider === "local" && local.error && (
            <div className="rounded-lg bg-danger-subtle/50 px-3 py-2 text-12 text-danger-primary">{local.error}</div>
          )}
        </div>

        {/* composer */}
        <div className="focus-within:border-accent-primary mx-4 mb-2 shrink-0 rounded-xl border border-subtle bg-surface-1 p-2.5 transition">
          <textarea
            value={input}
            rows={1}
            placeholder={t("aiAssistant.placeholder")}
            aria-label={t("aiAssistant.placeholder")}
            className="max-h-32 min-h-6 w-full resize-none bg-transparent text-13 text-primary outline-none placeholder:text-tertiary"
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
              {pageContext && (
                <span className="flex min-w-0 items-center gap-1 text-10 text-tertiary" title={pageContext}>
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
                disabled={!input.trim()}
                aria-label={t("aiAssistant.send")}
                className="flex size-7 items-center justify-center rounded-lg bg-accent-primary text-on-color transition hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUp className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <p className="shrink-0 pb-3 text-center text-10 text-tertiary">{t("aiAssistant.disclaimer")}</p>
      </div>
    </ModalPortal>
  );
});
