"use client";

import { useEffect, useRef } from "react";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
// components
import {
  agentPayloadText,
  mergeAgentMessages,
  type TAgentMessageItem,
} from "@/components/research/agent/research-agent-utils";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";
import { ReportContextSelector } from "./report-context-selector";

type Props = {
  api: TResearchAgentSessionApi;
};

/** 聊天式对话流：用户气泡 / AI 正文 / 折叠思考与过程 / 工具与产物卡，底部固定输入区。 */
export function ResearchAgentConversation({ api }: Props) {
  const { t } = useTranslation();
  const messages = mergeAgentMessages(api.events, api.userEcho);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // 新事件到达且用户仍停在底部时自动吸底。
  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [messages.length, api.uploadingFile]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {api.state === "loading_context" && (
            <p className="text-12 text-tertiary">{t("research.agent.description")}</p>
          )}
          {api.state === "forbidden" && (
            <p className="text-12 text-primary">{t("research.common.permission_denied")}</p>
          )}
          {api.state === "degraded" && <p className="text-12 text-primary">{t("research.agent.degraded")}</p>}
          {api.state === "error" && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-12 text-primary">{t("research.agent.status.ERROR")}</p>
              <button
                type="button"
                onClick={() => void api.reconnect()}
                className="text-12 text-accent-primary hover:underline"
              >
                {t("research.agent.reconnect")}
              </button>
            </div>
          )}
          {!api.session && api.state !== "loading_context" && api.state !== "forbidden" && (
            <p className="text-12 text-tertiary">{t("research.agent.no_session")}</p>
          )}
          {messages.map((item) => (
            <MessageItem key={item.key} item={item} api={api} />
          ))}
        </div>
      </div>

      <form
        className="mx-auto w-full max-w-3xl shrink-0 border-t border-subtle p-3"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void api.send();
        }}
      >
        <details className="mb-2">
          <summary className="cursor-pointer list-none text-11 text-tertiary hover:text-secondary">
            {t("research.agent.report_context")}
          </summary>
          <div className="mt-2 border-t border-subtle pt-2">
            <ReportContextSelector api={api} />
          </div>
        </details>
        {api.session?.provider === "SCIENCE_DISCOVERY" && (
          <div className="mb-2 flex items-center gap-3 text-11 text-secondary">
            <AttachmentUploadZone
              onFiles={(files) => void api.uploadFile(files[0])}
              disabled={!api.session || api.session.status === "CLOSED"}
              uploading={api.uploadingFile}
              variant="inline"
              title={api.uploadingFile ? t("research.agent.file_uploading") : t("research.agent.file_attach")}
              hint="仅支持一个文件"
            />
            {api.uploadedFile && (
              <span className="text-success-primary">
                {t("research.agent.file_uploaded", { name: api.uploadedFile })}
              </span>
            )}
            {api.uploadError && (
              <span className="text-danger-primary" role="alert">
                {api.uploadError}
              </span>
            )}
          </div>
        )}
        {api.reportError && (
          <p className="mb-2 text-11 text-danger-primary" role="alert">
            {api.reportError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            id="research-agent-message"
            value={api.message}
            onChange={(event) => api.setMessage(event.target.value)}
            placeholder={t("research.agent.input_placeholder")}
            rows={2}
            className="focus:border-accent-primary max-h-40 min-h-10 w-full resize-none rounded-lg border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary outline-none"
            disabled={!api.session || api.session.status === "CLOSED" || api.sending}
          />
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!api.session || api.session.status === "CLOSED" || api.sending || !api.message.trim()}
          >
            {api.sending ? t("research.agent.status.STREAMING") : t("research.agent.send")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** 单条消息条目的分层渲染。 */
function MessageItem({ item, api }: { item: TAgentMessageItem; api: TResearchAgentSessionApi }) {
  const { t } = useTranslation();

  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-3.5 py-2 text-13 break-words text-primary">
            {item.text}
          </p>
        </div>
      );
    case "assistant":
      return (
        <div className="flex flex-col gap-1">
          <p className="text-13 leading-relaxed break-words whitespace-pre-wrap text-primary">
            {item.text}
            {item.streaming && <span className="ml-0.5 animate-pulse text-tertiary">▍</span>}
          </p>
        </div>
      );
    case "thinking":
      return (
        <details className="rounded-md border border-subtle px-3 py-1.5">
          <summary className="cursor-pointer list-none text-11 text-tertiary hover:text-secondary">
            {t("research.agent.thinking_process")}
          </summary>
          <p className="mt-2 max-h-40 overflow-y-auto text-11 break-words whitespace-pre-wrap text-secondary">
            {item.text}
          </p>
        </details>
      );
    case "process":
      return (
        <p className="text-center text-11 text-tertiary">
          <span className="rounded-full bg-surface-2 px-2 py-0.5">{item.label}</span>
        </p>
      );
    case "tool":
      return (
        <details className="rounded-md border border-subtle px-3 py-1.5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-11 text-secondary">
            <span className="truncate font-medium">⚙ {item.name}</span>
            <span className="shrink-0 text-tertiary">{item.status}</span>
          </summary>
          {item.output && (
            <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-surface-2 p-2 text-11 break-words whitespace-pre-wrap text-secondary">
              {item.output}
            </pre>
          )}
        </details>
      );
    case "artifact": {
      const artifact = (item.event.payload.artifact ?? {}) as { name?: string; kind?: string };
      const version = (item.event.payload.version ?? {}) as { id?: string };
      return (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-subtle px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-12 font-medium text-primary">🗂 {artifact.name ?? "artifact"}</p>
            <p className="text-11 text-tertiary">{artifact.kind ?? ""}</p>
          </div>
          {api.session?.provider === "SCIENCE_DISCOVERY" && version.id && (
            <div className="flex shrink-0 gap-3 text-11 text-accent-primary">
              <button type="button" onClick={() => void api.downloadArtifact(item.event)} className="hover:underline">
                {t("research.agent.artifact_download")}
              </button>
              <button type="button" onClick={() => api.prepareArtifactSave(item.event)} className="hover:underline">
                {t("research.agent.save_artifact")}
              </button>
            </div>
          )}
        </div>
      );
    }
    case "data_change":
      return (
        <p className="text-11 text-secondary">
          📎 {t("research.agent.file_change")} · <span className="break-all">{item.label}</span>
        </p>
      );
    case "approval": {
      const request = (item.event.payload.request ?? {}) as Record<string, unknown>;
      const summary =
        agentPayloadText(item.event.payload, ["summary", "input_summary", "query", "input", "prompt"]) ||
        String(request.summary ?? "");
      const decided = api.approvalResult && api.session?.status !== "WAITING_APPROVAL";
      return (
        <div className="rounded-md border border-accent-strong/40 bg-surface-1 px-3 py-2.5">
          <p className="text-12 font-medium text-primary">🔐 {t("research.agent.approval_title")}</p>
          {summary && <p className="mt-1 text-11 break-words text-secondary">{summary}</p>}
          {decided ? (
            <p className="mt-2 text-11 text-success-primary">{api.approvalResult}</p>
          ) : (
            <div className="mt-2 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => void api.decideApproval("REJECTED", item.event)}
                disabled={api.approvalBusy}
                className="rounded-md border border-danger-strong/40 px-2.5 py-1 text-11 text-danger-primary disabled:opacity-50"
              >
                {t("research.approvals.reject")}
              </button>
              <button
                type="button"
                onClick={() => void api.decideApproval("APPROVED", item.event)}
                disabled={api.approvalBusy}
                className="rounded-md border border-subtle px-2.5 py-1 text-11 text-secondary disabled:opacity-50"
              >
                {t("research.agent.approval_once")}
              </button>
              <button
                type="button"
                onClick={() => void api.decideApproval("APPROVED_ALWAYS", item.event)}
                disabled={api.approvalBusy}
                className="rounded-md bg-accent-primary px-2.5 py-1 text-11 text-on-color disabled:opacity-50"
              >
                {t("research.agent.approval_always")}
              </button>
            </div>
          )}
          {api.approvalError && (
            <p className="mt-2 text-11 text-danger-primary" role="alert">
              {api.approvalError}
            </p>
          )}
        </div>
      );
    }
    case "decision":
      return <p className="text-center text-11 text-tertiary">✓ {item.label}</p>;
    case "notice":
      return (
        <p
          className={`rounded-md px-3 py-1.5 text-11 break-words ${
            item.tone === "error" ? "bg-danger-primary/10 text-danger-primary" : "bg-surface-2 text-secondary"
          }`}
        >
          {item.label}
        </p>
      );
    default:
      return null;
  }
}
