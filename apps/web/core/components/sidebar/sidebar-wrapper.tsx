/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { observer } from "mobx-react";
// plane helpers
import { useTranslation } from "@plane/i18n";
import { useOutsideClickDetector } from "@plane/hooks";
import { cn } from "@plane/utils";
import { SettingsOutline } from "@makeplane/propel/icons";
import { ScrollArea } from "@plane/propel/scrollarea";
// hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import useSize from "@/hooks/use-window-size";
import { useInstanceAdmin } from "@/hooks/use-instance-admin";
import { getGodModeUrl } from "@/helpers/admin-url.helper";
// plane web components
import { WorkspaceEditionBadge } from "@/components/workspace/edition-badge";
import { AppSidebarToggleButton } from "./sidebar-toggle-button";

type TSidebarWrapperProps = {
  title: string;
  children: React.ReactNode;
  quickActions?: React.ReactNode;
  contentLayout?: "scroll" | "fill";
};

export const SidebarWrapper = observer(function SidebarWrapper(props: TSidebarWrapperProps) {
  const { title, children, quickActions, contentLayout = "scroll" } = props;
  const fillsAvailableHeight = contentLayout === "fill";
  // store hooks
  const { toggleSidebar, sidebarCollapsed } = useAppTheme();
  const isInstanceAdmin = useInstanceAdmin();
  const { t } = useTranslation();
  const windowSize = useSize();
  // refs
  const ref = useRef<HTMLDivElement>(null);

  useOutsideClickDetector(ref, () => {
    if (sidebarCollapsed === false && window.innerWidth < 768) {
      toggleSidebar();
    }
  });

  useEffect(() => {
    if (windowSize[0] < 768 && !sidebarCollapsed) toggleSidebar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSize]);

  return (
    <>
      <div ref={ref} className="flex h-full w-full animate-fade-in flex-col">
        <div className={cn("flex flex-col gap-3 px-3", { "shrink-0": fillsAvailableHeight })}>
          {/* Workspace switcher and settings */}

          <div className="flex items-center justify-between gap-2 px-2">
            <span className="pt-1 text-16 font-medium text-primary">{title}</span>
            <div className="flex items-center gap-2">
              <AppSidebarToggleButton />
            </div>
          </div>
          {/* Quick actions */}
          {quickActions}
        </div>

        <ScrollArea
          orientation="vertical"
          scrollType="hover"
          size="sm"
          rootClassName={cn(
            "overflow-x-hidden overflow-y-auto",
            fillsAvailableHeight ? "min-h-0 w-full flex-1" : "size-full"
          )}
          viewportClassName={cn(
            "flex h-full w-full flex-col overflow-x-hidden overflow-y-auto px-3 pt-3 pb-0.5",
            fillsAvailableHeight ? "gap-0" : "gap-3"
          )}
        >
          {children}
        </ScrollArea>
        {isInstanceAdmin && (
          <a
            href={getGodModeUrl()}
            className={cn(
              "mx-3 my-2 flex items-center gap-2 rounded-md border border-subtle px-3 py-2 text-13 font-medium text-primary hover:bg-layer-transparent-hover focus-visible:outline-2 focus-visible:outline-offset-2",
              { "shrink-0": fillsAvailableHeight }
            )}
          >
            <SettingsOutline className="size-4 shrink-0" />
            {t("enter_god_mode")}
          </a>
        )}
        {/* Help Section */}
        <div
          className={cn("flex h-12 items-center justify-between border-t border-subtle bg-surface-1 p-3", {
            "shrink-0": fillsAvailableHeight,
          })}
        >
          <WorkspaceEditionBadge />
          {/* TODO: To be checked if we need this */}
          {/* <div className="flex items-center gap-2">
          {!shouldRenderAppRail && <HelpMenu />}
          {!isAppRailEnabled && <AppSidebarToggleButton />}
        </div> */}
        </div>
      </div>
    </>
  );
});
