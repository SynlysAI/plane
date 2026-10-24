// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const swrMocks = vi.hoisted(() => ({
  useSWR: vi.fn(() => ({ isLoading: false, error: undefined })),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("swr", () => ({ default: swrMocks.useSWR }));
vi.mock("@/components/common/logo-spinner", () => ({ LogoSpinner: () => <div>Loading</div> }));
vi.mock("@/components/instance", () => ({
  InstanceNotReady: () => <div>Not ready</div>,
  MaintenanceView: () => <div>Maintenance</div>,
}));
vi.mock("@/hooks/store/use-instance", () => ({
  useInstance: () => ({
    isLoading: false,
    instance: { is_setup_done: true },
    error: undefined,
    fetchInstanceInfo: vi.fn(),
  }),
}));

const { default: InstanceWrapper } = await import("@/lib/wrappers/instance-wrapper");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  swrMocks.useSWR.mockReturnValue({ isLoading: false, error: undefined });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("retries transient instance startup failures without waiting for browser focus", async () => {
  await act(async () => root.render(<InstanceWrapper>Application</InstanceWrapper>));

  expect(container.textContent).toBe("Application");
  expect(swrMocks.useSWR).toHaveBeenCalledTimes(1);
  const options = swrMocks.useSWR.mock.calls[0]?.[2];
  expect(options).toEqual(
    expect.objectContaining({
      revalidateOnFocus: false,
      shouldRetryOnError: true,
      errorRetryCount: 10,
      errorRetryInterval: 2_000,
    })
  );
});
