import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { observer } from "mobx-react";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import { AIAssistantPanel } from "@/components/assistant/ai-assistant-panel";
import { StoreProvider, store } from "@/lib/store-context";
import { RightDockProvider, RightDockShell } from "@/components/right-dock";
import {
  AgentDockService,
  type TAgentContextEnvelope,
  type TAgentDockProvider,
  type TAgentDockSession,
} from "@/services/agent-dock";
// oxlint-disable-next-line import/no-unassigned-import -- Use the application's actual layout styles.
import "../../styles/globals.css";

const params = new URLSearchParams(window.location.search);
const theme = ["light", "dark", "light-contrast", "dark-contrast"].includes(params.get("theme") ?? "")
  ? (params.get("theme") as "light" | "dark" | "light-contrast" | "dark-contrast")
  : "light";

const available = params.get("configured") !== "false";
const cloudReady = params.get("cloud") !== "false";
const awaitingApproval = params.get("scenario") === "approval";
const answer = [
  "## 文献与实验材料",
  "已整理当前工作区的科研资料。",
  "",
  "| 资料 | 状态 | 记录 |",
  "| :--- | :--- | ---: |",
  "| 催化剂表征分析 | 已核对 | 12 |",
  "| 光谱与实验数据 | 待复核 | 8 |",
].join("\n");

/**
 * 构建不连接真实后端的页面上下文。
 * @param provider 当前后端。
 * @returns 浏览器可展示的上下文。
 */
function context(provider: TAgentDockProvider): TAgentContextEnvelope {
  return {
    schema_version: "agent-context-envelope.v2",
    provider,
    science_discovery: { available, reason: available ? "" : "science_discovery_not_configured" },
    context_id: `context-${provider}`,
    context_version: 1,
    status: "linked",
    target_type: "WORKSPACE",
    target_hierarchy: [{ type: "workspace", id: "lab", title: "材料科学研究组" }],
    resources_summary: { total: 2, by_kind: { file: 2 } },
    manifest_summary: { summary: "当前工作区：材料科学研究组", resources: [] },
    manifest_hash: "fixture-hash",
    expiry: "2099-01-01T00:00:00Z",
    capabilities: {
      agent: provider === "SYNLORA" ? "Synlora" : "ScienceDiscovery",
      tool_source: provider === "SYNLORA" ? "plane-unified-mcp" : "plane-research-mcp",
      allowed_tools:
        provider === "SYNLORA" ? ["plane.context.read"] : ["list_research_chains", "get_research_node_context"],
      allowed_plugins: [],
      allowed_mcp_ids: [],
      allowed_knowledge_base_ids: [],
      allowed_file_ids: [],
    },
    session_binding: { workspace_id: "lab", target_key: "workspace:lab", user_id: "researcher" },
  };
}

/**
 * 构建每个 provider 的稳定会话。
 * @param provider 当前后端。
 * @returns 对应的工作区线程。
 */
function session(provider: TAgentDockProvider): TAgentDockSession {
  const envelope = context(provider);
  return {
    schema_version: "agent-dock-session.v1",
    provider,
    session_id: provider,
    run_id: `run-${provider}`,
    target_type: "WORKSPACE",
    target_key: "workspace:lab",
    status: awaitingApproval ? "WAITING_APPROVAL" : "READY",
    last_error: "",
    assembly: {},
    latest_seq: 3,
    source_cursor: 2,
    run_start_cursor: 0,
    target_title: "材料科学研究组",
    context: { context_id: envelope.context_id, context_version: 1, status: "linked", expires_at: envelope.expiry },
    updated_at: "2026-11-05T12:00:00Z",
  };
}

// 所有 BFF 调用仅返回夹具数据，避免修改实际服务。
AgentDockService.prototype.resolveContext = async (_workspace, _route, _text, _focus, provider = "SYNLORA") =>
  context(provider);
AgentDockService.prototype.getSession = async (_workspace, id) => session(id as TAgentDockProvider);
AgentDockService.prototype.listSessions = async () => ({
  results: [session("SYNLORA"), session("SCIENCE_DISCOVERY")],
  count: 2,
});
AgentDockService.prototype.getEvents = async (_workspace, runId) => {
  const provider: TAgentDockProvider = runId.endsWith("SCIENCE_DISCOVERY") ? "SCIENCE_DISCOVERY" : "SYNLORA";
  return {
    results: [
      { seq: 1, event_type: "USER_MESSAGE", payload: { content: "整理工作区科研资料" } },
      {
        seq: 2,
        event_type: "OUTPUT",
        payload: {
          content: answer,
          remote_type: provider === "SCIENCE_DISCOVERY" ? "assistant.snapshot" : "assistant/message",
          remote_seq: 1,
        },
      },
      { seq: 3, event_type: "OUTPUT", payload: { content: answer, remote_type: "run.completed", remote_seq: 2 } },
    ].map((event) =>
      Object.assign(event, {
        schema_version: "agent-dock-event.v1",
        run_id: runId,
        request_id: `fixture-${event.seq}`,
        created_at: "2026-11-05T12:00:00Z",
      })
    ),
    count: 3,
    latest_seq: 3,
    session: session(provider),
  };
};

AgentDockService.prototype.getSessionEvents = async (workspace, sessionId) => {
  const data = await AgentDockService.prototype.getEvents(workspace, `run-${sessionId}`);
  if (awaitingApproval) {
    data.results = [
      ...data.results.slice(0, 2),
      ...[1, 2].map((index) => ({
        schema_version: "agent-dock-event.v1",
        run_id: `run-${sessionId}`,
        seq: index + 2,
        event_type: "APPROVAL",
        request_id: `fixture-approval-${index}`,
        created_at: "2026-11-05T12:00:00Z",
        payload: {
          remote_type: "permission.required",
          remote_seq: index + 1,
          request: {
            id: `permission-${index}`,
            toolCallId: `tool-${index}`,
            summary: index === 1 ? "写入光谱分析结果" : "保存实验复核记录",
            action: "write",
            resource: `/workspace/materials/spectroscopy/analysis-${index}/confirmed-results-and-evidence.txt`,
          },
        },
      })),
    ];
  }
  return { ...data, has_more: false, next_cursor: null };
};
AgentDockService.prototype.streamEvents = async (_workspace, _run, _cursor, signal) =>
  new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.close(), { once: true });
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } }
  );
AgentDockService.prototype.answerRun = async () => ({ ...session("SCIENCE_DISCOVERY"), status: "STREAMING" });

store.aiAssistant.hydrate("assistant-fixture");
store.aiAssistant.setThreadId("assistant-fixture", "SYNLORA", "cloud");
store.aiAssistant.setThreadId("assistant-fixture", "SCIENCE_DISCOVERY", "local");
store.aiAssistant.setProvider(params.get("provider") === "local" ? "local" : "cloud");
window.sessionStorage.setItem(
  "PLANE_AGENT_DOCK_LAUNCH_HISTORY_assistant-fixture:anonymous",
  JSON.stringify({ launchId: "fixture", sessionIds: ["SYNLORA", "SCIENCE_DISCOVERY"] })
);
store.aiAssistant.open();

await setLanguage("zh-CN");
document.documentElement.dataset.theme = theme;
const Fixture = observer(function Fixture() {
  return (
    <div className="h-screen w-screen">
      <RightDockProvider>
        <RightDockShell
          agentOpen={store.aiAssistant.isOpen}
          agentDocked={store.aiAssistant.dockMode === "docked"}
          agentWidth={store.aiAssistant.width}
          agentFloatingFull={store.aiAssistant.expanded}
          onOpenAgent={() => store.aiAssistant.open()}
          agentPanel={
            <AIAssistantPanel
              workspaceSlug="assistant-fixture"
              statusState={cloudReady ? "ready" : "personal_credential_required"}
              onRetryStatus={() => undefined}
            />
          }
        >
          <main className="p-8">
            <h1 className="text-22 font-semibold text-primary">材料科学研究组</h1>
          </main>
        </RightDockShell>
      </RightDockProvider>
    </div>
  );
});
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter>
        <Fixture />
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
