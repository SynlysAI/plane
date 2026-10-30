// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: {
    id: "project-1",
    is_research_project: false,
    administrative_settings_admin_only: true,
    member_role: 15,
  },
  context: {
    user: {
      is_workspace_admin: false,
      is_system_admin: false,
    },
  },
}));

vi.mock("@plane/constants", () => ({
  EUserProjectRoles: { ADMIN: 20 },
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: (projectId: string) => (projectId === "project-1" ? mocks.project : null) }),
}));
vi.mock("@/hooks/use-workspace-context", () => ({
  useWorkspaceContext: () => ({ context: mocks.context }),
}));

const { useAdministrativeSettingsLock } = await import("@/hooks/use-administrative-settings-lock");

function LockProbe({ projectId }: { projectId?: string }) {
  return <output>{String(useAdministrativeSettingsLock(projectId))}</output>;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.project = {
    id: "project-1",
    is_research_project: false,
    administrative_settings_admin_only: true,
    member_role: 15,
  };
  mocks.context = { user: { is_workspace_admin: false, is_system_admin: false } };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderLock(projectId?: string) {
  await act(async () => root.render(<LockProbe projectId={projectId} />));
  return container.textContent;
}

it("locks project members in a locked administrative project", async () => {
  expect(await renderLock("project-1")).toBe("true");
});

it("keeps project administrators unlocked", async () => {
  mocks.project.member_role = 20;
  expect(await renderLock("project-1")).toBe("false");
});

it("keeps workspace and system administrators unlocked", async () => {
  mocks.context.user.is_workspace_admin = true;
  expect(await renderLock("project-1")).toBe("false");

  mocks.context.user.is_workspace_admin = false;
  mocks.context.user.is_system_admin = true;
  expect(await renderLock("project-1")).toBe("false");
});

it("ignores unlocked and research projects", async () => {
  mocks.project.administrative_settings_admin_only = false;
  expect(await renderLock("project-1")).toBe("false");

  mocks.project.administrative_settings_admin_only = true;
  mocks.project.is_research_project = true;
  expect(await renderLock("project-1")).toBe("false");
});
