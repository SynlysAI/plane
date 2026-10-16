// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getWorkspaceMemberInvitationTemplateUrl: vi.fn().mockReturnValue("/template.xlsx"),
  importWorkspaceMemberInvitations: vi.fn(),
}));

const memberStore = vi.hoisted(() => ({
  fetchWorkspaceMemberInvitations: vi.fn(),
  inviteMembersToWorkspace: vi.fn(),
  workspaceMemberInvitations: {} as Record<string, unknown[]>,
}));

vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    getWorkspaceMemberInvitationTemplateUrl = service.getWorkspaceMemberInvitationTemplateUrl;
    importWorkspaceMemberInvitations = service.importWorkspaceMemberInvitations;
  },
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: memberStore }),
}));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick, disabled, type = "button" }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { SUCCESS: "success" }, setToast: vi.fn() }));

import { PlainWorkspaceMemberImportPanel } from "@/components/workspace/settings/member-invitation-import-panel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.resetAllMocks();
  service.getWorkspaceMemberInvitationTemplateUrl.mockReturnValue("/template.xlsx");
  memberStore.fetchWorkspaceMemberInvitations.mockResolvedValue([]);
  memberStore.inviteMembersToWorkspace.mockResolvedValue(undefined);
  memberStore.workspaceMemberInvitations = {};
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
});

function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label)!;
}

function labeledControl(label: string) {
  const element = Array.from(container.querySelectorAll("label")).find(
    (item) => item.firstChild?.textContent?.trim().replace(/\s*\*$/, "") === label.replace(/\s*\*$/, "")
  );
  return element!.querySelector("input,select") as HTMLInputElement | HTMLSelectElement;
}

function labeledCheckbox(label: string) {
  const element = Array.from(container.querySelectorAll("label")).find((item) => item.textContent?.includes(label));
  return element!.querySelector("input") as HTMLInputElement;
}

async function change(input: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function renderPanel() {
  root = createRoot(container);
  await act(async () => root.render(<PlainWorkspaceMemberImportPanel workspaceSlug="plain-ws" />));
}

describe("plain workspace member import", () => {
  it("renders pending invitations and keeps research organization fields out of the form", async () => {
    memberStore.workspaceMemberInvitations = {
      "plain-ws": [
        {
          id: "invite-1",
          display_name: "张三",
          email: "zhang@example.com",
          role: 15,
          research_profile_enabled: true,
          research_profile_category: "STUDENT",
        },
      ],
    };
    await renderPanel();
    expect(container.textContent).toContain("张三");
    expect(container.textContent).toContain("zhang@example.com");
    expect(container.textContent).toContain("基础科研档案 · 学生");
    expect([...container.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual([
      "名称",
      "邮箱",
      "工作区角色",
      "科研档案",
    ]);
    expect([...container.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual([
      "张三",
      "zhang@example.com",
      "成员",
      "基础科研档案 · 学生",
    ]);
    const invitations = container.querySelector('section[aria-label="待处理邀请"]');
    expect(container.firstElementChild?.lastElementChild).toBe(invitations);
    expect(button("发送邀请").compareDocumentPosition(invitations!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => button("Excel 导入").click());
    expect(button("上传并发送邀请").compareDocumentPosition(invitations!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelector("table")).not.toBeNull();
    const fieldLabels = [...container.querySelectorAll("label")].map((label) => label.textContent).join(" ");
    expect(fieldLabels).not.toContain("主归属组织");
    expect(fieldLabels).not.toContain("主导师");
    expect(fieldLabels).not.toContain("学号");
  });

  it("shows the three-column template with Excel import and preserves profile options between modes", async () => {
    await renderPanel();
    expect(container.querySelector('a[href="/template.xlsx"]')).toBeNull();
    expect(labeledControl("科研档案类别").disabled).toBe(true);
    await act(async () => labeledCheckbox("同步创建基础科研档案").click());
    await change(labeledControl("科研档案类别"), "STAFF");
    await act(async () => button("Excel 导入").click());
    expect(container.querySelector('a[href="/template.xlsx"]')?.textContent).toContain("下载三列模板");
    expect(labeledCheckbox("同步创建基础科研档案").checked).toBe(true);
    expect(labeledControl("科研档案类别").value).toBe("STAFF");
    expect(labeledControl("科研档案类别").disabled).toBe(false);
    await act(async () => button("单个邀请").click());
    expect(labeledControl("科研档案类别").value).toBe("STAFF");
  });

  it("places the empty invitation state below the form", async () => {
    await renderPanel();
    const section = container.querySelector('section[aria-label="待处理邀请"]');
    expect(section?.textContent).toContain("0 条");
    expect(section?.textContent).toContain("暂无待处理邀请。");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("keeps invitation loading and failures in the bottom section", async () => {
    let rejectLoading!: (reason: Error) => void;
    memberStore.fetchWorkspaceMemberInvitations.mockReturnValueOnce(
      new Promise((_, reject) => {
        rejectLoading = reject;
      })
    );
    await renderPanel();
    const section = container.querySelector('section[aria-label="待处理邀请"]');
    expect(section?.querySelector('[role="status"]')?.textContent).toBe("加载中…");
    expect(section?.textContent).not.toContain("0 条");
    await act(async () => rejectLoading(new Error("Failed to fetch invitations")));
    expect(section?.querySelector('[role="alert"]')?.textContent).toBe("待处理邀请加载失败，请刷新重试。");
    expect(container.querySelector("form")).not.toBeNull();
    expect(button("发送邀请").disabled).toBe(false);
  });

  it("submits one invitation with basic research profile options", async () => {
    await renderPanel();
    await change(labeledControl("名称"), "张三");
    await change(labeledControl("邮箱"), "zhang@example.com");
    await act(async () => labeledCheckbox("同步创建基础科研档案").click());
    await change(labeledControl("科研档案类别"), "ADVISOR");
    const form = container.querySelector("form")!;
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(memberStore.inviteMembersToWorkspace).toHaveBeenCalledWith("plain-ws", {
      emails: [
        {
          display_name: "张三",
          email: "zhang@example.com",
          role: 15,
          research_profile_enabled: true,
          research_profile_category: "ADVISOR",
        },
      ],
    });
  });

  it("uploads one workbook with the global basic profile option", async () => {
    service.importWorkspaceMemberInvitations.mockResolvedValueOnce({ created: 2, invitations: [], message: "ok" });
    await renderPanel();
    await act(async () => button("Excel 导入").click());
    await act(async () => labeledCheckbox("同步创建基础科研档案").click());
    await change(labeledControl("科研档案类别"), "PI");
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["name,email,role"], "members.csv", { type: "text/csv" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    await act(async () => button("上传并发送邀请").click());
    expect(service.importWorkspaceMemberInvitations).toHaveBeenCalledWith("plain-ws", {
      file,
      research_profile_enabled: true,
      research_profile_category: "PI",
    });
    expect(memberStore.fetchWorkspaceMemberInvitations).toHaveBeenCalledWith("plain-ws");
  });

  it("shows row-level errors without clearing the selected workbook", async () => {
    service.importWorkspaceMemberInvitations.mockRejectedValueOnce({
      error: "成员导入表存在无效行。",
      rows: [{ row_number: 3, email: "bad@example.com", message: "不是有效邮箱。" }],
    });
    await renderPanel();
    await act(async () => button("Excel 导入").click());
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [new File(["x"], "members.csv")] });
    await act(async () => button("上传并发送邀请").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("第 3 行 · bad@example.com");
    expect(fileInput.files?.length).toBe(1);
  });
});
