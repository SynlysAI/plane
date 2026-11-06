import { expect, it, vi } from "vitest";

vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: vi.fn(),
}));

const { WorkspaceMemberStore } = await import("@/store/member/workspace/workspace-member.store");

it("updates member and current-user email caches after a successful request", async () => {
  const cachedMember = { id: "user-1", email: "old@example.com" };
  const currentUser = { id: "user-1", email: "old@example.com", is_email_verified: true };
  const memberRoot = { memberMap: { "user-1": cachedMember } };
  const rootStore = { router: {}, user: { data: currentUser } };
  const store = new WorkspaceMemberStore(memberRoot as never, rootStore as never);
  const updateRequest = vi.fn().mockResolvedValue({ email: "new@example.com" });
  store.workspaceService = { updateWorkspaceMemberEmail: updateRequest } as never;

  const email = await store.updateMemberEmail("lab", "user-1", "new@example.com");

  expect(email).toBe("new@example.com");
  expect(updateRequest).toHaveBeenCalledWith("lab", "user-1", "new@example.com");
  expect(cachedMember.email).toBe("new@example.com");
  expect(currentUser.email).toBe("new@example.com");
  expect(currentUser.is_email_verified).toBe(false);
});
