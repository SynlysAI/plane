/** Isolated browser fixture for theme preferences and the workspace background shell. */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { action } from "mobx";
import { ThemeProvider } from "next-themes";
import { TranslationProvider } from "@plane/i18n";
import { applyCustomTheme } from "@plane/utils";
import { StoreProvider, store } from "@/lib/store-context";
import { ProfileSettingsDefaultPreferencesList } from "../../core/components/settings/profile/content/pages/preferences/default-list";
import { WorkspaceBackgroundShell } from "../../core/components/workspace/background-shell";
import { WORKSPACE_BACKGROUND_IMAGES } from "../../helpers/workspace-backgrounds";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./workspace-background.fixture.css";

const backgroundMode = new URLSearchParams(window.location.search).get("mode") === "light" ? "light" : "dark";

action(() => {
  store.user.userProfile.data = {
    ...store.user.userProfile.data,
    id: "fixture-profile",
    theme: {
      theme: "custom",
      primary: "#426b67",
      background: backgroundMode === "light" ? "#f7f7f5" : "#1a1a1a",
      darkPalette: backgroundMode === "dark",
      backgroundImage: WORKSPACE_BACKGROUND_IMAGES[0],
    },
  };
})();

function Fixture() {
  useEffect(() => {
    applyCustomTheme("#426b67", backgroundMode === "light" ? "#f7f7f5" : "#1a1a1a", backgroundMode);
  }, []);

  return (
    <ThemeProvider
      attribute="data-theme"
      themes={["light", "dark", "light-contrast", "dark-contrast", "custom"]}
      defaultTheme="custom"
    >
      <TranslationProvider>
        <StoreProvider>
          <WorkspaceBackgroundShell>
            <div className="flex size-full gap-2 overflow-hidden p-2">
              <aside className="flex w-56 shrink-0 flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-4">
                <div className="text-h6-medium text-primary">项目</div>
                <div className="rounded border border-subtle bg-layer-1 px-3 py-2 text-body-sm-regular text-secondary">
                  侧边栏
                </div>
              </aside>
              <main className="flex-1 overflow-y-auto rounded-lg border border-subtle bg-surface-1 p-6">
                <ProfileSettingsDefaultPreferencesList />
              </main>
            </div>
          </WorkspaceBackgroundShell>
        </StoreProvider>
      </TranslationProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
