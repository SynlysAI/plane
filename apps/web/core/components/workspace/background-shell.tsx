/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { observer } from "mobx-react";
import { useTheme } from "next-themes";
// plane imports
import { cn, getFileURL } from "@plane/utils";
// hooks
import { useUserProfile } from "@/hooks/store/user";

type Props = {
  children: ReactNode;
};

/** 渲染个人全局工作台背景，并保持内容位于背景之上。 */
export const WorkspaceBackgroundShell = observer(function WorkspaceBackgroundShell(props: Props) {
  const { children } = props;
  const { data: userProfile } = useUserProfile();
  const { resolvedTheme } = useTheme();
  const background = userProfile?.theme?.backgroundImage ?? null;
  const backgroundMode =
    userProfile?.theme?.theme === "custom"
      ? userProfile.theme.darkPalette
        ? "dark"
        : "light"
      : resolvedTheme?.includes("dark")
        ? "dark"
        : "light";

  return (
    <div
      data-background-mode={background ? backgroundMode : undefined}
      className={cn(
        "relative flex h-screen w-full flex-col overflow-hidden",
        background ? "workspace-background-enabled" : "bg-canvas",
        "desktop-app-container"
      )}
    >
      {background && (
        <div aria-hidden="true" className="workspace-background-layer">
          <img src={getFileURL(background)} alt="" className="workspace-background-image" />
          <div className="workspace-background-scrim" />
        </div>
      )}
      <main className="relative z-10 h-full w-full overflow-hidden">{children}</main>
    </div>
  );
});
