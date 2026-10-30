// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: "",
  setParams: vi.fn(),
  context: {
    navigation: {
      management: true,
      workspace_settings: true,
      administrative_organizations: true,
    },
    workspace_enabled: true,
    capabilities: { nav: ["org"] },
    workspace: { research_enabled: true, purpose: "PUBLIC_RESEARCH" },
    user: {
      is_main_pi: false,
      is_research_admin: false,
      is_workspace_admin: false,
      is_system_admin: false,
    },
  },
  fetchIdentity: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("@plane/propel/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@plane/constants", () => ({
  RESEARCH_SETTINGS_NAVIGATION_ITEMS: [{ key: "org", labelKey: "research.nav.org_settings", path: "settings/org" }],
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => ({ "research.nav.feedback": "反馈管理" })[key] ?? key,
  }),
}));
vi.mock("@/hooks/use-workspace-context", () => ({
  useWorkspaceContext: () => ({ context: mocks.context, error: null, retry: vi.fn() }),
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    fetchIdentity: mocks.fetchIdentity,
    fetchSettings: mocks.fetchSettings,
    updateSettings: mocks.updateSettings,
  }),
}));
vi.mock("@/components/administrative/organization-settings", () => ({
  AdministrativeOrganizationSettings: () => <div data-testid="administrative-settings" />,
}));
vi.mock("@/components/research/feedback/feedback-dialog", () => ({
  FeedbackDialog: ({ managementOnly }: { managementOnly?: boolean }) => (
    <div data-testid="feedback-management" data-management-only={String(managementOnly)} />
  ),
}));
vi.mock("@/services/project-domains.service", () => ({
  ProjectDomainsService: class {
    setResearchEnabled = vi.fn();
  },
  domainError: () => "保存失败",
}));
vi.mock("react-router", () => ({
  Link: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
  useParams: () => ({ workspaceSlug: "public" }),
  useSearchParams: () => [new URLSearchParams(mocks.query), mocks.setParams],
}));

const { default: WorkspaceManagementPage } = await import("@/app/(all)/[workspaceSlug]/(projects)/management/page");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => root.render(<WorkspaceManagementPage />));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query = "";
  mocks.context = {
    navigation: {
      management: true,
      workspace_settings: true,
      administrative_organizations: true,
    },
    workspace_enabled: true,
    capabilities: { nav: ["org"] },
    workspace: {
      research_enabled: true,
      purpose: "PUBLIC_RESEARCH",
    },
    user: {
      is_main_pi: false,
      is_research_admin: false,
      is_workspace_admin: false,
      is_system_admin: false,
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchSettings.mockResolvedValue({
    research_mcp_write_enabled: false,
    research_mcp_write_available: true,
  });
  mocks.updateSettings.mockReset();
});

it("keeps the administrative lock outside workspace management settings", async () => {
  await render();
  expect(container.querySelector('input[name="administrative-settings-admin-only"]')).toBeNull();
  expect(container.textContent).not.toContain("行政项目配置权限");
  expect(container.textContent).toContain("科研模块");
});

it("shows and saves the research MCP write policy", async () => {
  mocks.context.user.is_workspace_admin = true;
  mocks.updateSettings.mockResolvedValue({
    research_mcp_write_enabled: true,
    research_mcp_write_available: true,
  });

  await render();
  await act(async () => undefined);
  const checkbox = container.querySelector<HTMLInputElement>('input[name="research-mcp-write-enabled"]');
  expect(checkbox).not.toBeNull();
  expect(checkbox?.checked).toBe(false);
  expect(mocks.fetchSettings).toHaveBeenCalledWith("public");
  expect(container.textContent).toContain("科研 MCP 写入");

  await act(async () => {
    checkbox?.click();
  });

  expect(mocks.updateSettings).toHaveBeenCalledWith("public", { research_mcp_write_enabled: true });
  expect(checkbox?.checked).toBe(true);
});

it("keeps research MCP write disabled when the deployment switch is unavailable", async () => {
  mocks.context.user.is_workspace_admin = true;
  mocks.fetchSettings.mockResolvedValue({
    research_mcp_write_enabled: false,
    research_mcp_write_available: false,
  });

  await render();
  await act(async () => undefined);
  const checkbox = container.querySelector<HTMLInputElement>('input[name="research-mcp-write-enabled"]');
  expect(checkbox?.disabled).toBe(true);
  expect(container.textContent).toContain("服务器全局科研 MCP 读写开关未开启");

  await act(async () => {
    checkbox?.click();
  });

  expect(mocks.updateSettings).not.toHaveBeenCalled();
});

it("keeps the old research MCP write state when saving fails", async () => {
  mocks.context.user.is_workspace_admin = true;
  mocks.updateSettings.mockRejectedValue({ message: "全局科研 MCP 读写开关未开启。" });

  await render();
  await act(async () => undefined);
  const checkbox = container.querySelector<HTMLInputElement>('input[name="research-mcp-write-enabled"]');
  await act(async () => {
    checkbox?.click();
  });

  expect(checkbox?.checked).toBe(false);
  expect(container.textContent).toContain("全局科研 MCP 读写开关未开启。");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it.each(["is_main_pi", "is_research_admin", "is_workspace_admin", "is_system_admin"] as const)(
  "%s 可见反馈管理入口",
  async (role) => {
    mocks.context.user[role] = true;

    await render();

    expect(container.textContent).toContain("反馈管理");
  }
);

it("将反馈管理置于科研管理之后，并在打开时渲染独立管理视图", async () => {
  mocks.context.user.is_main_pi = true;
  mocks.query = "tab=feedback";

  await render();

  expect(
    Array.from(container.querySelectorAll('nav[aria-label="管理分类"] button')).map((button) => button.textContent)
  ).toEqual(["工作区设置", "行政组织", "科研管理", "反馈管理"]);
  expect(container.querySelector('[data-testid="feedback-management"]')?.getAttribute("data-management-only")).toBe(
    "true"
  );
});

it("点击反馈管理时写入反馈页签查询参数", async () => {
  mocks.context.user.is_workspace_admin = true;

  await render();
  await act(async () => {
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "反馈管理")
      ?.click();
  });

  expect(mocks.setParams).toHaveBeenCalledWith({ tab: "feedback" });
});

it("没有反馈处置权限时隐藏入口，并将直达反馈页签回退到首个可访问页签", async () => {
  mocks.query = "tab=feedback";

  await render();

  expect(container.textContent).not.toContain("反馈管理");
  expect(container.querySelector('[data-testid="feedback-management"]')).toBeNull();
  expect(container.textContent).toContain("科研模块");
});
