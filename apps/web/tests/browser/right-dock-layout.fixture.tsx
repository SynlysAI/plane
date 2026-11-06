import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import type { TResearchChainNodeTask } from "@plane/types";
import { UserOutline } from "@makeplane/propel/icons";
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";
import { RightDockPortal, RightDockProvider, RightDockShell } from "@/components/right-dock";
import { ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { ResearchChainTaskPeek } from "@/components/research/chains/research-chain-task-peek";
// oxlint-disable-next-line import/no-unassigned-import -- Browser fixture uses real application styles.
import "../../styles/globals.css";

type TDetailKind = "none" | "administrative" | "research";

const researchTask = {
  id: "task-1",
  workspace: "workspace-1",
  chain: "chain-1",
  node: "node-1",
  title: "跨尺度高分子智能材料合成与表征任务完整标题",
  instruction: "请补充长任务说明，用于检查详情栏正文换行与滚动。",
  instruction_attachments: [],
  status: "ASSIGNED",
  assignee: "student-1",
  assignee_is_valid: true,
  assignee_detail: { id: "student-1", display_name: "方奕凯" },
  assigned_by: "advisor-1",
  assigned_by_detail: { id: "advisor-1", display_name: "王家威" },
  completed_by: null,
  completed_by_detail: null,
  due_at: "2026-11-20T00:00:00Z",
  can_complete: true,
  can_reopen: false,
  completed_at: null,
  resource_type: "NONE",
  resource_id: null,
  request_id: "request-1",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
  capabilities: {
    schema_version: "research-capabilities.v1",
    actions: {
      view: { allowed: true, reason_code: "", reason: "" },
      edit: { allowed: true, reason_code: "", reason: "" },
      assign: { allowed: true, reason_code: "", reason: "" },
      complete: { allowed: true, reason_code: "", reason: "" },
      reopen: { allowed: false, reason_code: "", reason: "" },
      cancel: { allowed: false, reason_code: "", reason: "" },
    },
  },
} as unknown as TResearchChainNodeTask;

const researchForm = {
  taskId: "task-1",
  title: researchTask.title,
  instruction: researchTask.instruction,
  assignee: "student-1",
  dueAt: "2026-11-20",
};

const reportRows = [
  {
    id: "report-1",
    period: "2026-W44",
    owner: "王家威",
    organization: "跨尺度表征",
    status: "已提交",
    read: "待导师阅读",
    visibility: "工作区全员",
    updated: "2026/11/03 08:53",
  },
  {
    id: "report-2",
    period: "2026-W44",
    owner: "郑哲雄",
    organization: "跨尺度高分子智能",
    status: "已提交",
    read: "待导师阅读",
    visibility: "工作区全员",
    updated: "2026/11/02 20:12",
  },
];

/** Render the real right-dock coordination shell with representative Plane content. */
function Fixture() {
  const [detailKind, setDetailKind] = useState<TDetailKind>("administrative");
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentWidth, setAgentWidth] = useState(420);

  return (
    <RightDockProvider>
      <div data-shell-root className="flex h-screen w-screen overflow-hidden bg-canvas">
        <RightDockShell
          agentOpen={agentOpen}
          agentDocked
          agentWidth={agentWidth}
          launcherVisible={false}
          onOpenAgent={() => setAgentOpen(true)}
          agentPanel={
            <aside data-agent-panel className="flex h-full w-full min-w-0 flex-col border-l border-subtle bg-surface-1">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle px-4 py-3">
                <strong className="text-13">AI 助手</strong>
                <div className="flex flex-wrap gap-1">
                  {[320, 420, 560].map((width) => (
                    <button
                      key={width}
                      type="button"
                      data-agent-width={width}
                      className="rounded border border-subtle px-2 py-1 text-12 text-secondary"
                      onClick={() => setAgentWidth(width)}
                    >
                      {width}
                    </button>
                  ))}
                  <button
                    type="button"
                    data-close-agent
                    className="rounded border border-subtle px-2 py-1 text-12 text-secondary"
                    onClick={() => setAgentOpen(false)}
                  >
                    关闭
                  </button>
                </div>
              </div>
              <div data-agent-scroll className="vertical-scrollbar min-h-0 flex-1 overflow-y-auto p-4 text-13">
                {Array.from({ length: 30 }, (_, index) => (
                  <p key={index} className="mb-3">
                    Agent 消息 {index + 1}：用于检查详情与助手各自垂直滚动。
                  </p>
                ))}
              </div>
            </aside>
          }
        >
          <div data-main className="@container flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-3">
              {(["administrative", "research", "none"] as TDetailKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  data-detail-kind={kind}
                  className="rounded border border-subtle px-2 py-1 text-12 text-secondary"
                  onClick={() => setDetailKind(kind)}
                >
                  {kind}
                </button>
              ))}
              <button
                type="button"
                data-open-agent
                className="rounded border border-subtle px-2 py-1 text-12 text-secondary"
                onClick={() => setAgentOpen(true)}
              >
                打开 Agent
              </button>
            </div>
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-60 shrink-0 border-r border-subtle bg-surface-1 p-4 text-13 text-secondary @max-md:hidden">
                项目导航
              </aside>
              <div
                data-report-page
                className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto bg-canvas p-5"
              >
                <div data-report-table className="min-w-0">
                  <ResearchTableSurface>
                    <Table className="min-w-240">
                      <TableHeader>
                        <TableRow>
                          <TableHead>周期</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead>提交人</TableHead>
                          <TableHead>课题组</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>已读状态</TableHead>
                          <TableHead>可见性</TableHead>
                          <TableHead className="text-right">更新时间</TableHead>
                          <TableHead className="sticky right-0 z-10 bg-layer-1 text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reportRows.map((row) => (
                          <TableRow key={row.id} className="group/report-row hover:bg-surface-2">
                            <TableCell>{row.period}</TableCell>
                            <TableCell>周报</TableCell>
                            <TableCell>{row.owner}</TableCell>
                            <TableCell>{row.organization}</TableCell>
                            <TableCell>{row.status}</TableCell>
                            <TableCell>{row.read}</TableCell>
                            <TableCell>{row.visibility}</TableCell>
                            <TableCell className="text-right">{row.updated}</TableCell>
                            <TableCell className="sticky right-0 z-10 border-l border-subtle bg-surface-1 text-right group-hover/report-row:bg-surface-2">
                              <a data-report-open href={`#/${row.id}`} className="text-12 text-accent-primary">
                                打开
                              </a>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </ResearchTableSurface>
                </div>
              </div>
            </div>
          </div>

          {detailKind === "administrative" && (
            <RightDockPortal
              id="issue:fixture"
              title="科研采购审批-丙二醇甲醚醋酸酯等试剂耗材-80367.3元"
              onClose={() => setDetailKind("none")}
            >
              <div
                data-administrative-content
                className="flex h-full min-h-0 w-full min-w-0 flex-col text-body-sm-regular"
              >
                <section
                  data-administrative-detail
                  className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
                >
                  <div
                    data-administrative-scroll
                    className="vertical-scrollbar min-h-0 w-full flex-1 overflow-y-auto p-4"
                  >
                    <h2 className="text-20 font-medium break-words">
                      科研采购审批-丙二醇甲醚醋酸酯等试剂耗材-80367.3元
                    </h2>
                    <SidebarPropertyListItem icon={UserOutline} label="创建人">
                      <span className="min-w-0 text-body-xs-medium break-words">纪金朝</span>
                    </SidebarPropertyListItem>
                    <SidebarPropertyListItem icon={UserOutline} label="一个非常长的属性标签用于检查换行">
                      <span className="min-w-0 text-body-xs-medium break-words">方奕凯</span>
                    </SidebarPropertyListItem>
                    {Array.from({ length: 30 }, (_, index) => (
                      <p key={index} className="mt-3 text-13 text-secondary">
                        行政详情第 {index + 1} 段：用于检查右侧任务详情在 Dock 内独立滚动。
                      </p>
                    ))}
                  </div>
                </section>
              </div>
            </RightDockPortal>
          )}

          {detailKind === "research" && (
            <ResearchChainTaskPeek
              kind="task"
              task={researchTask}
              form={researchForm}
              formBusy={false}
              formError=""
              isEditMode={false}
              candidates={[]}
              candidateState="ready"
              locale="zh-CN"
              mode="side"
              workspaceSlug="lab"
              chainId="chain-1"
              nodeId="node-1"
              actionBusy=""
              onModeChange={() => undefined}
              onClose={() => setDetailKind("none")}
              onToggleEditMode={() => undefined}
              onFormChange={() => undefined}
              onTaskAttachmentsChange={() => undefined}
              onCommit={() => undefined}
              onCreate={() => undefined}
              onAction={() => undefined}
            />
          )}
        </RightDockShell>
      </div>
    </RightDockProvider>
  );
}

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <TranslationProvider>
      <Fixture />
    </TranslationProvider>
  </MemoryRouter>
);
