import { beforeEach, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => {
  const instance = {
    interceptors: { response: { use: vi.fn() } },
    delete: vi.fn(() => Promise.resolve({ data: null })),
  };
  return { create: vi.fn(() => instance), instance };
});

vi.mock("axios", () => ({ create: axiosMock.create }));

const { ResearchNavigationService } = await import("@/services/research/navigation.service");
const { researchEndpoints } = await import("@plane/constants");

beforeEach(() => {
  axiosMock.instance.delete.mockClear();
});

it("sends move_to as a query parameter when deleting an organization", async () => {
  const service = new ResearchNavigationService();
  await service.deleteAdministrativeOrganization("lab", "org-1", "target-1");

  expect(axiosMock.instance.delete).toHaveBeenCalledWith(researchEndpoints.administrativeOrganization("lab", "org-1"), {
    data: undefined,
    params: { move_to: "target-1" },
  });
});

it("sends the optional category move target as a query parameter", async () => {
  const service = new ResearchNavigationService();
  await service.deleteCategory("lab", "cat-1", "cat-2");
  expect(axiosMock.instance.delete).toHaveBeenCalledWith(researchEndpoints.navigationCategory("lab", "cat-1"), {
    data: undefined,
    params: { move_to: "cat-2" },
  });

  await service.deleteCategory("lab", "cat-3");
  expect(axiosMock.instance.delete).toHaveBeenLastCalledWith(researchEndpoints.navigationCategory("lab", "cat-3"), {
    data: undefined,
    params: undefined,
  });
});
