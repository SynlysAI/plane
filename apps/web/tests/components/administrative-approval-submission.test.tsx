// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TAdministrativeApproval } from "@/services/project-domains.service";

const mocks = vi.hoisted(() => ({
  setting: vi.fn(),
  flows: vi.fn(),
  submit: vi.fn(),
  requests: vi.fn(),
  getRequest: vi.fn(),
  allowed: true,
  act: vi.fn(),
}));
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => ({ allowPermissions: () => mocks.allowed }) }));
vi.mock("@plane/ui", () => ({
  EModalWidth: { LG: "lg" },
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? createPortal(<div role="dialog">{children}</div>, document.body) : null,
}));
vi.mock("@/services/project-domains.service", () => ({
  ProjectDomainsService: class {
    projectSetting = mocks.setting;
    flows = mocks.flows;
    submit = mocks.submit;
    requests = mocks.requests;
    getRequest = mocks.getRequest;
    act = mocks.act;
  },
  domainError: () => "请求失败",
}));
vi.mock("@/components/editor/rich-text", () => ({
  RichTextEditor: ({ initialValue }: { initialValue: string }) => (
    <div data-testid="work-item-description">{initialValue}</div>
  ),
}));
vi.mock("@/services/project/project.service", () => ({ ProjectService: vi.fn() }));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/table", () => ({
  Table: (props: React.HTMLAttributes<HTMLTableElement>) => <table {...props} />,
  TableHeader: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...props} />,
  TableBody: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...props} />,
  TableRow: (props: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...props} />,
  TableHead: (props: React.ThHTMLAttributes<HTMLTableCellElement>) => <th {...props} />,
  TableCell: (props: React.TdHTMLAttributes<HTMLTableCellElement>) => <td {...props} />,
}));
function Surface({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}
vi.mock("@/components/research/common/research-data-surface", () => {
  return {
    ResearchDetailHeader: Surface,
    ResearchDetailSurface: Surface,
    ResearchFilterToolbar: Surface,
    ResearchListSurface: Surface,
    ResearchTableSurface: Surface,
  };
});
vi.mock("@/components/research/common/research-list-state", () => ({ ResearchListState: () => <p>加载中</p> }));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/common/research-format", () => ({ formatResearchDateTime: () => "" }));
const { ApprovalSubmitForm } = await import("@/components/administrative/approval-submit-form");
const { IssueApprovalButton } = await import("@/components/administrative/issue-approval-button");
const { default: usePeekOutsideClick } = await import("@/hooks/use-peek-overview-outside-click");
const { AdministrativeApprovalPanel } = await import("@/components/administrative/approval-panel");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.allowed = true;
  mocks.setting.mockResolvedValue({
    can_submit: true,
    can_manage: true,
    organization_id: "org",
    flow_id: null,
    approvers: [{ id: "person", name: "审批人甲" }],
  });
  mocks.flows.mockResolvedValue([{ id: "flow", name: "采购流程", version: 2 }]);
  mocks.submit.mockResolvedValue({ id: "request" });
  mocks.requests.mockResolvedValue([]);
  mocks.getRequest.mockResolvedValue(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
async function changeSelect(index: number, value: string) {
  await act(async () => {
    const select = container.querySelectorAll("select")[index];
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
it("submits directly to a chosen approver without any configured template", async () => {
  mocks.flows.mockResolvedValue([]);
  const onSubmitted = vi.fn();
  await act(async () =>
    root.render(
      <ApprovalSubmitForm workspaceSlug="lab" projectId="project" issueId="issue" onSubmitted={onSubmitted} />
    )
  );
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await changeSelect(1, "person");
  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.submit).toHaveBeenCalledWith("lab", "project", "issue", { approver_id: "person" });
  expect(onSubmitted).toHaveBeenCalledWith({ id: "request" });
});
it("submits the selected fixed flow without sending a previously selected approver", async () => {
  await act(async () =>
    root.render(<ApprovalSubmitForm workspaceSlug="lab" projectId="project" issueId="issue" onSubmitted={vi.fn()} />)
  );
  await changeSelect(1, "person");
  await changeSelect(0, "FLOW");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await changeSelect(1, "flow");
  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.submit).toHaveBeenCalledWith("lab", "project", "issue", { flow_id: "flow" });
});
it("offers project approval filters without submission controls or project flow configuration", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdministrativeApprovalPanel workspaceSlug="lab" projectId="project" />
      </MemoryRouter>
    )
  );
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).not.toContain("项目审批配置");
  expect(container.textContent).not.toContain("发起行政审批");
  expect(container.querySelector("form")).toBeNull();
  expect(mocks.setting).not.toHaveBeenCalled();
  expect(container.textContent).toContain("本项目全部记录");
  expect(container.textContent).not.toContain("与我相关");
  expect(container.querySelectorAll("th")).toHaveLength(6);
  await changeSelect(0, "mine");
  await changeSelect(1, "completed");
  expect(mocks.requests).toHaveBeenLastCalledWith("lab", "mine", "project", "completed");
});

it("uses personal relationships and shows the source project in the approval center", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdministrativeApprovalPanel workspaceSlug="lab" />
      </MemoryRouter>
    )
  );
  expect(mocks.requests).toHaveBeenLastCalledWith("lab", "related", undefined, "");
  expect(container.textContent).toContain("与我的关系");
  expect(container.textContent).toContain("与我相关");
  expect(container.textContent).toContain("所属项目");
  expect(container.textContent).not.toContain("本项目全部记录");
  await changeSelect(0, "to_me");
  expect(mocks.requests).toHaveBeenLastCalledWith("lab", "to_me", undefined, "");
});

it.each([undefined, "project"])("loads detail using the current approval context (%s)", async (projectId) => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/?request=request"]}>
        <AdministrativeApprovalPanel workspaceSlug="lab" projectId={projectId} />
      </MemoryRouter>
    )
  );
  expect(mocks.getRequest).toHaveBeenCalledWith("lab", "request", projectId);
});

function PeekHarness() {
  const [open, setOpen] = React.useState(true);
  const ref = React.useRef<HTMLDivElement>(null);
  usePeekOutsideClick(ref, () => setOpen(false), "issue");
  return open ? (
    <div ref={ref}>
      <IssueApprovalButton workspaceSlug="lab" projectId="project" issueId="issue" />
    </div>
  ) : (
    <p>侧边栏已关闭</p>
  );
}
it("renders the approval button without fetching and keeps the peek open when selecting in its portal", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <PeekHarness />
      </MemoryRouter>
    )
  );
  expect(container.textContent).toContain("发起审批");
  expect(mocks.setting).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")?.click());
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  await act(async () => {
    const select = dialog?.querySelector("select");
    select?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    if (select) {
      select.value = "FLOW";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).not.toContain("侧边栏已关闭");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("采购流程");
});
it("hides the submit action when the cached project permission is read-only", async () => {
  mocks.allowed = false;
  await act(async () =>
    root.render(
      <MemoryRouter>
        <IssueApprovalButton workspaceSlug="lab" projectId="project" issueId="issue" />
      </MemoryRouter>
    )
  );
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.setting).not.toHaveBeenCalled();
});

function approvalDetail(overrides: Partial<TAdministrativeApproval> = {}): TAdministrativeApproval {
  return {
    id: "request",
    project_id: "project",
    project_name: "设备项目",
    issue_id: "issue",
    title: "采购审批",
    status: "PENDING",
    step: 1,
    flow_id: "flow",
    flow_name: "采购流程",
    flow_version: 1,
    approval_mode: "FLOW",
    requester: { id: "requester", display_name: "发起人" },
    approvers: [{ id: "approver", display_name: "审批人" }],
    can_act: false,
    can_withdraw: false,
    can_cancel: false,
    blocked: false,
    due_at: null,
    created_at: "2026-10-20T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    work_item: {
      id: "issue",
      workspace_id: "workspace",
      identifier: "ADM-1",
      name: "采购显微镜",
      description_html: "<p>采购一台显微镜用于检测，预算 3 万元。</p>",
      state: "进行中",
      priority: "high",
      start_date: "2026-10-20",
      target_date: "2026-10-30",
      assignees: [{ id: "owner", display_name: "负责人" }],
      attachments: [{ id: "attachment", name: "采购清单.pdf", url: "/api/assets/attachment/" }],
    },
    steps: [{ order: 1, approver_kind: "USER", approver_name: "审批人" }],
    history: [
      {
        id: "action",
        action: "SUBMIT",
        actor: "发起人",
        comment: "请审核采购清单",
        step: 1,
        created_at: "2026-10-20T00:00:00Z",
      },
    ],
    ...overrides,
  };
}
it.each([
  { role: "viewer", flags: {}, buttons: [] },
  { role: "requester", flags: { can_withdraw: true }, buttons: ["撤回"] },
  { role: "approver", flags: { can_act: true }, buttons: ["同意", "驳回"] },
  { role: "manager", flags: { can_cancel: true }, buttons: ["管理取消"] },
  ...["APPROVED", "REJECTED", "WITHDRAWN", "CANCELLED"].map((status) => ({
    role: status,
    flags: { status, can_act: true, can_cancel: true, can_withdraw: true },
    buttons: [],
  })),
])("shows appropriate detail controls for $role", async ({ flags, buttons }) => {
  mocks.getRequest.mockResolvedValue(approvalDetail(flags));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/?request=request"]}>
        <AdministrativeApprovalPanel workspaceSlug="lab" projectId="project" />
      </MemoryRouter>
    )
  );
  expect(container.querySelector('input[placeholder="搜索审批事项"]')).toBeNull();
  expect(container.textContent).toContain("返回审批列表");
  expect(container.textContent).toContain("采购显微镜");
  expect(container.textContent).toContain("预算 3 万元");
  expect(container.textContent).toContain("采购清单.pdf");
  expect(container.textContent).toContain("请审核采购清单");
  expect(Boolean(container.querySelector("textarea"))).toBe(buttons.includes("同意") || buttons.includes("管理取消"));
  for (const label of ["同意", "驳回", "撤回", "管理取消"]) {
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === label)).toBe(
      buttons.includes(label)
    );
  }
  expect(mocks.requests).not.toHaveBeenCalled();
});
it("requires a reason for rejection and returns to the filtered project list", async () => {
  mocks.getRequest.mockResolvedValue(approvalDetail({ can_act: true }));
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AdministrativeApprovalPanel workspaceSlug="lab" projectId="project" />
      </MemoryRouter>
    )
  );
  await changeSelect(0, "mine");
  mocks.requests.mockResolvedValue([approvalDetail({ can_act: true })]);
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新")?.click()
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "查看")?.click()
  );
  const reject = [...container.querySelectorAll("button")].find((button) => button.textContent === "驳回");
  expect(reject?.disabled).toBe(true);
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "同意")?.disabled).toBe(
    false
  );
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("返回审批列表"))?.click()
  );
  expect(container.querySelector("select")?.value).toBe("mine");
  expect(mocks.requests).toHaveBeenLastCalledWith("lab", "mine", "project", "");
});
