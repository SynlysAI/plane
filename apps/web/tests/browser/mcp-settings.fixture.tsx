// oxlint-disable-next-line import/no-unassigned-import -- 先隔离全部网络请求。
import "./mcp-settings.fixture-api";
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { action } from "mobx";
import { TranslationProvider, initPromise, setLanguage } from "@plane/i18n";
import { StoreProvider, store } from "@/lib/store-context";
import { MCPProfileSettings } from "@/components/settings/profile/content/pages/mcp";
// oxlint-disable-next-line import/no-unassigned-import -- 使用产品样式与真实组件。
import "./workspace-background.fixture.css";

action(() => {
  store.user.userProfile.data = { ...store.user.userProfile.data, id: "fixture-profile" };
  store.router.setQuery({ workspaceSlug: "lab" });
  store.workspaceRoot.workspaces = { fixture: { id: "fixture", slug: "lab", name: "材料科学研究工作区" } as never };
})();

void initPromise.then(async () => {
  await setLanguage("zh-CN");
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/settings/profile/mcp"]}>
      <TranslationProvider>
        <StoreProvider>
          <main className="mx-auto min-h-screen w-full max-w-5xl bg-surface-1 px-4 py-6 text-13 text-primary md:px-8">
            <MCPProfileSettings />
          </main>
        </StoreProvider>
      </TranslationProvider>
    </MemoryRouter>
  );
  return;
});
