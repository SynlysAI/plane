/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
import { Sparkles, ArrowUp, Square, RefreshCw, Plus } from "lucide-react";
import { Button } from "@plane/propel/button";
import { EPortalPosition, EPortalWidth, ModalPortal } from "@plane/propel/portal";
// components
import { MarkdownRenderer } from "@/components/ui/markdown-to-component";
import { useAssistantChat } from "./use-assistant-chat";
import { useAssistantPageContext } from "./use-assistant-page-context";
// store
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

type Props = {
  workspaceSlug: string;
};

export const AIAssistantPanel = observer(function AIAssistantPanel({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const assistantStore = useAIAssistant();
  const pageContext = useAssistantPageContext();
  const { messages, streamingAnswer, streamState, send, stop, reset } = useAssistantChat(workspaceSlug, pageContext);
  const [input, setInput] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const busy = streamState.phase === "streaming" || streamState.phase === "queued";

  const handleSend = () => {
    const query = input;
    setInput("");
    void send(query);
  };

  return (
    <ModalPortal
      isOpen={assistantStore.isOpen}
      onClose={() => assistantStore.close()}
      position={EPortalPosition.RIGHT}
      width={EPortalWidth.QUARTER}
      contentClassName="bg-surface-1 border-l border-subtle flex h-full flex-col"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <span className="text-sm font-medium text-primary">{t("aiAssistant.title")}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={reset} aria-label={t("aiAssistant.new_conversation")}>
              <Plus className="size-3.5" />
            </Button>
          </div>
        </header>

        <div ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {messages.length === 0 && !streamingAnswer && streamState.phase !== "streaming" && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Sparkles className="size-6 text-tertiary" />
              <p className="text-sm font-medium text-secondary">{t("aiAssistant.empty_greeting")}</p>
              <p className="max-w-56 text-12 text-tertiary">{t("aiAssistant.empty_hint")}</p>
            </div>
          )}
          {messages.map((message) =>
            message.role === "user" ? (
              <div
                key={message.id}
                className="ml-auto max-w-[85%] rounded-lg bg-surface-2 px-3 py-2 text-13 text-primary"
              >
                {message.content}
              </div>
            ) : (
              <div key={message.id} className="max-w-full text-13 text-primary">
                <MarkdownRenderer markdown={message.content} />
              </div>
            )
          )}
          {(streamState.phase === "streaming" || streamingAnswer) && (
            <div className="max-w-full text-13 text-primary">
              {streamingAnswer ? (
                <MarkdownRenderer markdown={streamingAnswer} />
              ) : (
                <span className="animate-pulse">▍</span>
              )}
            </div>
          )}
          {streamState.phase === "queued" && <p className="text-12 text-tertiary">{t("aiAssistant.queued")}</p>}
          {streamState.phase === "streaming" && streamState.status && (
            <p className="text-12 text-tertiary">
              {streamState.status === "started" || streamState.status === "working"
                ? t("aiAssistant.working")
                : t("aiAssistant.retrieving")}
            </p>
          )}
          {streamState.phase === "loading-history" && <p className="text-12 text-tertiary">…</p>}
          {streamState.phase === "interrupted" && (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-12 text-secondary">
              {t("aiAssistant.interrupt_notice")}
            </p>
          )}
          {streamState.phase === "error" && (
            <div className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-2 text-12 text-danger-primary">
              <span>{t("aiAssistant.error_generic")}</span>
              {streamState.canRetry && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void send(input || (messages[messages.length - 1]?.content ?? ""))}
                >
                  <RefreshCw className="size-3" />
                  {t("aiAssistant.retry")}
                </Button>
              )}
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-subtle p-3">
          <div className="flex items-end gap-2 rounded-lg border border-subtle bg-surface-2 p-2">
            <textarea
              value={input}
              rows={1}
              placeholder={t("aiAssistant.placeholder")}
              aria-label={t("aiAssistant.placeholder")}
              className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-13 text-primary outline-none placeholder:text-tertiary"
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            />
            {busy ? (
              <Button variant="error-fill" size="sm" onClick={() => void stop()} aria-label={t("aiAssistant.stop")}>
                <Square className="size-3.5" />
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!input.trim()}
                onClick={handleSend}
                aria-label={t("aiAssistant.send")}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-11 text-tertiary">{t("aiAssistant.shortcut_hint")}</p>
        </footer>
      </div>
    </ModalPortal>
  );
});
