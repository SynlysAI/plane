import { expect, it, vi } from "vitest";
import type { TResearchIdentity } from "@plane/types";
import { ResearchStore } from "@/store/research/research.store";
import type { CoreRootStore } from "@/store/root.store";
import { ResearchPlatformService } from "@/services/research/platform.service";

it("deduplicates concurrent requests and ignores obsolete workspace responses", async () => {
  const pending: ((value: TResearchIdentity) => void)[] = [];
  const spy = vi.spyOn(ResearchPlatformService.prototype, "getIdentity").mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  try {
    const store = new ResearchStore({} as CoreRootStore);
    const first = store.fetchIdentity("a");
    expect(store.fetchIdentity("a")).toBe(first);
    const second = store.fetchIdentity("b");
    const current = store.fetchIdentity("a");
    expect(current).not.toBe(first);
    pending[0]({ workspace_enabled: false } as TResearchIdentity); await first;
    expect(store.identity).toBeNull();
    pending[2]({ workspace_enabled: true } as TResearchIdentity); await current;
    pending[1]({ workspace_enabled: false } as TResearchIdentity); await second;
    expect(store.identityWorkspaceSlug).toBe("a");
    expect(store.identity?.workspace_enabled).toBe(true);
  } finally { spy.mockRestore(); }
});
