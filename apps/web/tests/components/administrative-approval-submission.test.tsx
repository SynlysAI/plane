// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ApprovalSubmitForm } from "@/components/administrative/approval-submit-form";
import { IssueApprovalButton } from "@/components/administrative/issue-approval-button";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("does not render an administrative approval submission form", async () => {
  await act(async () =>
    root.render(
      <ApprovalSubmitForm workspaceSlug="lab" projectId="project" issueId="issue" onSubmitted={() => undefined} />
    )
  );

  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toBe("");
});

it("does not render a separate approval action for an administrative work item", async () => {
  await act(async () => root.render(<IssueApprovalButton workspaceSlug="lab" projectId="project" issueId="issue" />));

  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toBe("");
});
