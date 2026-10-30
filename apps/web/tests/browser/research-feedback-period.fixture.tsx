/** Isolated browser fixture for feedback period popover anchoring and layering. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { initPromise, TranslationProvider } from "@plane/i18n";
import { StoreProvider } from "@/lib/store-context";
import { APIService } from "@/services/api.service";
import { ResearchPlatformService } from "@/services/research/platform.service";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";
import type { TResearchFeedback, TResearchIdentity } from "@plane/types";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./research-home-workbench.fixture.css";

const workspaceSlug = "sample";
const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "dialog";

const identity = {
  module_enabled: true,
  workspace_enabled: true,
  sections: { org: false, reports: true, approvals: false, research_chain: false },
  capabilities: {
    level: "ADMIN",
    nav: [],
    is_mentor: false,
    is_main_pi: false,
    is_stage_reviewer: false,
    management: { workspace: false, organization: false, integrations: false, operations: false, accounts: false },
  },
  user: {
    id: "person-1",
    is_workspace_admin: true,
    is_research_admin: false,
    is_main_pi: false,
    is_system_admin: false,
    org_units: [],
    mentor_ids: [],
    mentee_ids: [],
  },
  workspace: { slug: workspaceSlug, purpose: "GENERAL", report_timezone: "Asia/Shanghai" },
} as TResearchIdentity;

/** 构造指定创建时间的反馈记录，便于周期筛选产生可见差异。 */
function record(id: string, content: string, createdAt: string): TResearchFeedback {
  return {
    feedback_id: id,
    content,
    feedback_type: "bug",
    status: "open",
    username: "肖旭",
    path: "/sample/research/reports",
    browser: "Microsoft Edge 155.0",
    module: "research",
    screenshots: [],
    history: [],
    replies: [],
    created_at: createdAt,
    updated_at: createdAt,
  } as TResearchFeedback;
}

const feedbackRecords = [
  record("feedback-current", "本周提交的反馈记录", "2026-10-13T02:00:00.000Z"),
  record("feedback-previous", "上周提交的反馈记录", "2026-10-06T02:00:00.000Z"),
];

declare global {
  interface Window {
    __feedbackRequests: Array<Record<string, string>>;
  }
}

window.__feedbackRequests = [];
ResearchPlatformService.prototype.getIdentity = async () => identity;
const originalGet = APIService.prototype.get;
APIService.prototype.get = async function (rawUrl: string, config?: { params?: Record<string, string> }) {
  const path = new URL(rawUrl, window.location.origin).pathname;
  if (path.endsWith("/feedback/")) {
    const request = config?.params ?? {};
    window.__feedbackRequests.push({ ...request });
    const results = feedbackRecords.filter((item) => {
      const created = item.created_at.slice(0, 10);
      return (!request.date_from || created >= request.date_from) && (!request.date_to || created <= request.date_to);
    });
    return { data: { data: { results, count: results.length } } };
  }
  return originalGet.call(this, rawUrl, config);
};

await initPromise;
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter>
        <main className="min-h-screen bg-canvas px-6 py-8">
          {view === "standalone" ? (
            <div className="mx-auto max-w-5xl">
              <FeedbackDialog workspaceSlug={workspaceSlug} standalone />
            </div>
          ) : (
            <>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-subtle bg-canvas pb-2">
                <span className="text-12 text-secondary">工作区固定工具条 z-10</span>
                <FeedbackDialog workspaceSlug={workspaceSlug} />
              </div>
              <p className="mt-6 max-w-md text-12 text-tertiary">
                入口弹窗内切换“我的反馈”“反馈统计”，并点击“任意时间”验证日历锚点与层级。
              </p>
            </>
          )}
        </main>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
