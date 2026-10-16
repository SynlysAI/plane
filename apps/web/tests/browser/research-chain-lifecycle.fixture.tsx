/** 使用内存数据验证科研列表的归档、删除与重新激活，不访问真实项目。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TranslationProvider } from "@plane/i18n";
import type { TResearchChain } from "@plane/types";
import { StoreProvider } from "@/lib/store-context";
import { ResearchChainBoard } from "@/components/research/chains/research-chain-board";
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchOrgService } from "@/services/research/org.service";
// oxlint-disable-next-line import/no-unassigned-import -- 使用实际页面样式验证布局。
import "./research-home-workbench.fixture.css";

const chains: TResearchChain[] = [
  {
    schema_version: "research-chain.v1",
    id: "lifecycle-chain",
    project: "lifecycle-project",
    project_name: "科研项目删除恢复验证",
    workspace: "isolated-test",
    owner: "owner-1",
    owner_name: "科研负责人",
    status: "ACTIVE",
    visibility: "PRIVATE",
    open_task_count: 2,
    next_due_at: null,
    created_at: "2026-10-12T00:00:00Z",
    updated_at: "2026-10-12T00:00:00Z",
  },
];

/** 生成隔离验收使用的权限决策。 */
const decision = (allowed: boolean) => ({ allowed, reason_code: "fixture", reason: "隔离测试" });

/** 为隔离数据补充与当前状态一致的管理权限。 */
function withCapabilities(chain: TResearchChain): TResearchChain {
  const hidden = chain.status === "ARCHIVED" || chain.status === "DELETED";
  return {
    ...chain,
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        archive: decision(!hidden),
        delete: decision(chain.status !== "DELETED"),
        restore: decision(hidden),
      },
    },
  };
}

ResearchOrgService.prototype.getOrgUnits = async () => ({ results: [], count: 0 });
ResearchChainService.prototype.getChainPage = async (_workspaceSlug, params = {}) => ({
  results: chains
    .filter((chain) =>
      params.status ? chain.status === params.status : !["ARCHIVED", "DELETED"].includes(chain.status)
    )
    .map(withCapabilities),
  next_cursor: "",
  prev_cursor: "",
  next_page_results: false,
  prev_page_results: false,
});
ResearchChainService.prototype.deleteChain = async () => {
  chains[0].status = "DELETED";
};
ResearchChainService.prototype.archiveChain = async () => {
  chains[0].status = "ARCHIVED";
  return withCapabilities(chains[0]);
};
ResearchChainService.prototype.restoreChain = async () => {
  chains[0].status = "ACTIVE";
  return withCapabilities(chains[0]);
};

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/isolated-test/research/chains"]}>
        <main className="min-h-screen bg-canvas p-4">
          <h1 className="text-22 mb-4 font-semibold text-primary">科研项目</h1>
          <ResearchChainBoard workspaceSlug="isolated-test" />
        </main>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
