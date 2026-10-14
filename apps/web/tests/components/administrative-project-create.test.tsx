// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getAdministrativeOrganizations: vi.fn(),
  isWorkspaceAdmin: true,
}));

vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "en",
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
}));
vi.mock("@/components/project/create/common-attributes", () => ({ default: () => <div /> }));
vi.mock("@/components/project/create/header", () => ({ default: () => <div /> }));
vi.mock("@/components/project/create/project-create-buttons", () => ({
  default: ({ disabled, handleClose }: { disabled?: boolean; handleClose: () => void }) => (
    <div>
      <button type="button" onClick={handleClose}>
        取消
      </button>
      <button type="submit" disabled={disabled}>
        创建项目
      </button>
    </div>
  ),
}));
vi.mock("../../helpers/cover-image.helper", () => ({
  getCoverImageType: () => "external",
  uploadCoverImage: vi.fn(),
  getRandomCoverImage: () => null,
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    addProjectToFavorites: vi.fn(),
    createProject: mocks.createProject,
    updateProject: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({ isWorkspaceAdmin: mocks.isWorkspaceAdmin }),
}));
vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    getAdministrativeOrganizations = mocks.getAdministrativeOrganizations;
  },
}));

const { CreateProjectForm } = await import("@/components/projects/create/root");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const organizations = [
  { id: "public-id", name: "公共", is_default: true, can_manage: true },
  { id: "managed-id", name: "可管理组织", is_default: false, can_manage: true },
  { id: "readonly-id", name: "无权限组织", is_default: false, can_manage: false },
];

function renderForm() {
  root.render(
    <CreateProjectForm
      workspaceSlug="lab"
      onClose={() => undefined}
      handleNextStep={() => undefined}
      updateCoverImageStatus={async () => undefined}
      administrative
    />
  );
}

function submitButton() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "创建项目")!;
}

function selectOrganization(value: string) {
  const select = container.querySelector("#administrative-organization") as HTMLSelectElement;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  act(() => select.dispatchEvent(new Event("change", { bubbles: true })));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.createProject.mockReset().mockResolvedValue({ id: "new-project" });
  mocks.getAdministrativeOrganizations.mockReset().mockResolvedValue(organizations);
  mocks.isWorkspaceAdmin = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("defaults to the public organization and enforces organization manageability", async () => {
  await act(async () => renderForm());
  await act(async () => undefined);

  const select = container.querySelector("#administrative-organization") as HTMLSelectElement;
  expect(select.value).toBe("public-id");
  expect([...select.options].map((option) => [option.value, option.disabled])).toEqual([
    ["managed-id", false],
    ["readonly-id", true],
    ["public-id", false],
    ["new", false],
  ]);
});

it("submits the explicitly selected organization", async () => {
  await act(async () => renderForm());
  await act(async () => undefined);
  selectOrganization("managed-id");
  await act(async () => submitButton().click());

  expect(mocks.createProject).toHaveBeenCalledWith(
    "lab",
    expect.objectContaining({ administrative_organization: "managed-id" })
  );
});

it("creates a new organization only for workspace administrators", async () => {
  mocks.isWorkspaceAdmin = false;
  await act(async () => renderForm());
  await act(async () => undefined);
  expect(container.textContent).not.toContain("新建组织");

  mocks.isWorkspaceAdmin = true;
  await act(async () => root.render(<div />));
  await act(async () => renderForm());
  await act(async () => undefined);
  selectOrganization("new");
  const input = container.querySelector("#new-administrative-organization") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "综合保障部");
  act(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  await act(async () => submitButton().click());

  expect(mocks.createProject).toHaveBeenCalledWith(
    "lab",
    expect.objectContaining({ new_administrative_organization: "综合保障部" })
  );
});

it("blocks submission while organizations cannot be loaded", async () => {
  mocks.getAdministrativeOrganizations.mockRejectedValue(new Error("failed"));
  await act(async () => renderForm());
  await act(async () => undefined);

  expect(submitButton().disabled).toBe(true);
  await act(async () => submitButton().click());
  expect(mocks.createProject).not.toHaveBeenCalled();
});
