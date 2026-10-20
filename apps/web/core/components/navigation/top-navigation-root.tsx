/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// components
import { observer } from "mobx-react";
import { useParams, usePathname } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
import { TopNavPowerK } from "@/components/navigation";
import { HelpMenuRoot } from "@/components/workspace/sidebar/help-section/root";
import { UserMenuRoot } from "@/components/workspace/sidebar/user-menu-root";
import { WorkspaceMenuRoot } from "@/components/workspace/sidebar/workspace-menu-root";
import { useAppRailPreferences } from "@/hooks/use-navigation-preferences";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { AppSidebarItem } from "@/components/sidebar/sidebar-item";
import { InboxOutline } from "@makeplane/propel/icons";
import useSWR from "swr";
import { Sparkles } from "lucide-react";
import { useWorkspaceNotifications } from "@/hooks/store/notifications";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";
import { AssistantService } from "@/services/assistant";
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";
import { getNotificationBadgeState, workspaceUnreadNotificationKey } from "@/lib/notification-counts";

const assistantService = new AssistantService();

export const TopNavigationRoot = observer(function TopNavigationRoot() {
  // router
  const { workspaceSlug } = useParams();
  const pathname = usePathname();
  const { t } = useTranslation();

  // store hooks
  const { unreadNotificationsCount, getUnreadNotificationsCount } = useWorkspaceNotifications();
  const { preferences } = useAppRailPreferences();
  const assistant = useAIAssistant();

  const showLabel = preferences.displayMode === "icon_with_label";

  // Fetch notification count
  const activeWorkspaceSlug = workspaceSlug?.toString();
  const unreadNotificationKey = workspaceUnreadNotificationKey(activeWorkspaceSlug);
  useSWR(unreadNotificationKey, activeWorkspaceSlug ? () => getUnreadNotificationsCount(activeWorkspaceSlug) : null);

  // Fetch assistant availability
  const { data: assistantStatus } = useSWR(
    workspaceSlug ? `AI_ASSISTANT_STATUS_${workspaceSlug}` : null,
    workspaceSlug ? () => assistantService.getStatus(workspaceSlug.toString()) : null
  );

  // Calculate notification count
  const { count: totalNotifications } = getNotificationBadgeState(unreadNotificationsCount);

  return (
    <div
      className={cn("z-[27] flex min-h-10 w-full items-center bg-canvas px-3.5 transition-all duration-300", {
        "px-2": !showLabel,
      })}
    >
      {/* Workspace Menu */}
      <div className="flex-1 shrink-0">
        <WorkspaceMenuRoot variant="top-navigation" />
      </div>
      {/* Power K Search */}
      <div className="shrink-0">
        <TopNavPowerK />
      </div>
      {/* Additional Actions */}
      <div className="flex flex-1 shrink-0 items-center justify-end gap-1">
        {workspaceSlug && <FeedbackDialog workspaceSlug={workspaceSlug.toString()} />}
        {workspaceSlug && assistantStatus?.enabled && (
          <Tooltip label={t("aiAssistant.open")} side="bottom">
            <button
              type="button"
              onClick={() => assistant.toggle()}
              aria-label={t("aiAssistant.open")}
              className="flex size-8 items-center justify-center rounded-md text-secondary transition hover:bg-layer-1-hover hover:text-primary"
            >
              <Sparkles className="size-4" />
            </button>
          </Tooltip>
        )}
        <Tooltip label="Inbox" side="bottom">
          <AppSidebarItem
            variant="link"
            item={{
              href: `/${workspaceSlug?.toString()}/notifications/`,
              icon: (
                <div className="relative">
                  <InboxOutline className="size-5" />
                  {totalNotifications > 0 && (
                    <span className="absolute top-0 right-0 size-2 rounded-full bg-danger-primary" />
                  )}
                </div>
              ),
              isActive: pathname?.includes("/notifications/"),
            }}
          />
        </Tooltip>
        <HelpMenuRoot />
        <div className="flex size-8 items-center justify-center rounded-md hover:bg-layer-1-hover">
          <UserMenuRoot />
        </div>
      </div>
    </div>
  );
});
