// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useParams: () => ({ workspaceSlug: "public" }) };
});

const FeedbackManagementPage = (
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/settings/feedback/page")
).default;

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

it("将历史反馈管理地址重定向到工作区管理页签", async () => {
  function Probe() {
    const location = useLocation();
    return <output aria-label="location">{`${location.pathname}${location.search}`}</output>;
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/public/research/settings/feedback"]}>
        <FeedbackManagementPage />
        <Probe />
      </MemoryRouter>
    )
  );

  expect(container.querySelector("output[aria-label='location']")?.textContent).toBe("/public/management?tab=feedback");
});
