// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchProject } from "@/services/research/project.service";

const mocks = vi.hoisted(() => ({
  updateResearchProject: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { SUCCESS: "SUCCESS" }, setToast: vi.fn() }));
vi.mock("@plane/ui", () => ({
  EModalPosition: { CENTER: "center" },
  EModalWidth: { LG: "lg" },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/research/common/error-messages", () => ({ getResearchErrorKey: () => "error" }));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: {
      sections: { research_chain: true },
      user: { org_units: [{ org_unit: "unit-1", is_primary: true }] },
    },
    isResearchAdmin: false,
    getOrgUnits: () => [{ id: "unit-1", name: "材料课题组" }],
    updateResearchProject: mocks.updateResearchProject,
  }),
}));

const { ResearchProjectDialog } = await import("@/components/research/projects/research-project-create-dialog");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const project = {
  id: "project-1",
  name: "旧科研课题",
  research: {
    owner: "user-1",
    org_unit: "unit-1",
    research_type: "RESEARCH_PROJECT",
    chain_kind: "RESEARCH_CHAIN",
    chain_visibility: "PRIVATE",
  },
} as TResearchProject;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.updateResearchProject.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("编辑弹窗预填创建信息并提交去空格后的更新载荷", async () => {
  const onClose = vi.fn();
  const onUpdated = vi.fn();
  mocks.updateResearchProject.mockResolvedValue({ ...project, name: "新科研课题" });

  await act(async () =>
    root.render(
      <MemoryRouter>
        <ResearchProjectDialog
          currentUserId="user-1"
          isOpen
          project={project}
          onClose={onClose}
          onUpdated={onUpdated}
          workspaceSlug="lab"
        />
      </MemoryRouter>
    )
  );

  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("research.projects.edit_title");
  const field = (label: string) =>
    [...container.querySelectorAll("label")].find((item) => item.textContent?.includes(label));
  const nameInput = field("research.projects.fields.name")?.querySelector("input");
  const typeSelect = field("research.projects.fields.type")?.querySelector("select");
  const orgSelect = field("research.projects.fields.org_unit")?.querySelector("select");
  const visibilitySelect = field("research.projects.fields.chain_visibility")?.querySelector("select");
  expect(nameInput?.value).toBe("旧科研课题");
  expect(typeSelect?.value).toBe("RESEARCH_PROJECT");
  expect(orgSelect?.value).toBe("unit-1");
  expect(visibilitySelect?.value).toBe("PRIVATE");

  await act(async () => {
    if (!nameInput || !typeSelect || !visibilitySelect) throw new Error("编辑字段不存在");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(nameInput, "  新科研课题  ");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    typeSelect.value = "MASTER";
    typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    visibilitySelect.value = "WORKSPACE";
    visibilitySelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "research.projects.save")
      ?.click()
  );

  expect(mocks.updateResearchProject).toHaveBeenCalledWith("lab", "project-1", {
    name: "新科研课题",
    research_type: "MASTER",
    org_unit: "unit-1",
    chain_visibility: "WORKSPACE",
  });
  expect(onUpdated).toHaveBeenCalledWith({ ...project, name: "新科研课题" });
  expect(onClose).toHaveBeenCalled();
});

it("编辑失败时保留弹窗并显示错误", async () => {
  const onClose = vi.fn();
  mocks.updateResearchProject.mockRejectedValue(new Error("conflict"));

  await act(async () =>
    root.render(
      <MemoryRouter>
        <ResearchProjectDialog currentUserId="user-1" isOpen project={project} onClose={onClose} workspaceSlug="lab" />
      </MemoryRouter>
    )
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "research.projects.save")
      ?.click()
  );

  expect(mocks.updateResearchProject).toHaveBeenCalled();
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("error");
  expect(onClose).not.toHaveBeenCalled();
});
