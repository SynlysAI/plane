// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";

const mocks = vi.hoisted(() => ({
  createIssue: vi.fn(),
  handleCreateUpdatePropertyValues: vi.fn(),
  onChange: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        error: "错误",
        success: "成功",
      })[key] ?? key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error", SUCCESS: "success" },
  setToast: vi.fn(),
}));
vi.mock("@plane/utils", () => ({ isEmptyHtmlString: () => true }));
vi.mock("@/components/issues/issue-modal/form", () => ({
  IssueFormRoot: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      open discard
    </button>
  ),
}));
vi.mock("@/hooks/context/use-issue-modal", () => ({
  useIssueModal: () => ({
    handleCreateUpdatePropertyValues: mocks.handleCreateUpdatePropertyValues,
  }),
}));
vi.mock("@/hooks/store/workspace-draft", () => ({
  useWorkspaceDraftIssues: () => ({ createIssue: mocks.createIssue }),
}));
vi.mock("@plane/ui", () => ({
  EModalPosition: { TOP: "top" },
  EModalWidth: { XXL: "xxl" },
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}));

const { DraftIssueLayout } = await import("@/components/issues/issue-modal/draft-issue-layout");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

it("does not save a draft through the fallback project after the project is cleared", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <DraftIssueLayout
          changesMade={{ name: "保留这条输入", project_id: null } as Partial<TIssue>}
          data={undefined}
          onChange={mocks.onChange}
          onClose={mocks.onClose}
          projectId="fallback-project"
          issueTitleRef={{ current: null }}
          isCreateMoreToggleEnabled={false}
          onAssetUpload={vi.fn()}
          onCreateMoreToggleChange={vi.fn()}
          onSubmit={vi.fn()}
          isDraft={false}
          isDuplicateModalOpen={false}
          handleDuplicateIssueModal={vi.fn()}
        />
      )
    );

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "open discard")!
        .click();
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save to Drafts"
    );
    expect(saveButton?.disabled).toBe(true);

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Discard")!
        .click();
    });

    expect(mocks.createIssue).not.toHaveBeenCalled();
    expect(mocks.handleCreateUpdatePropertyValues).not.toHaveBeenCalled();
    expect(mocks.onChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(mocks.onClose).toHaveBeenCalledExactlyOnceWith();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  }
});
