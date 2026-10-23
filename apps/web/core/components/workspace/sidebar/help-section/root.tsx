/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import { ChatOutline, HelpOutline, PagesOutline, UserOutline } from "@makeplane/propel/icons";
import { DOCUMENTATION_URL, FEEDBACK_URL, SUPPORT_EMAIL, SUPPORT_URL, VERSION_NOTES_URL } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// ui
import { CustomMenu } from "@plane/ui";
// components
import { AppSidebarItem } from "@/components/sidebar/sidebar-item";
import { PlaneVersionNumber } from "@/components/global/version-number";
// hooks
import { usePowerK } from "@/hooks/store/use-power-k";

export const HelpMenuRoot = observer(function HelpMenuRoot() {
  // store hooks
  const { t } = useTranslation();
  const { toggleShortcutsListModal } = usePowerK();
  // states
  const [isNeedHelpOpen, setIsNeedHelpOpen] = React.useState(false);

  return (
    <>
      <CustomMenu
        customButton={<AppSidebarItem.Icon icon={<HelpOutline className="size-5" />} highlight={isNeedHelpOpen} />}
        customButtonClassName="group flex flex-col items-center justify-center gap-0.5 text-tertiary"
        ariaLabel="Help"
        menuButtonOnClick={() => !isNeedHelpOpen && setIsNeedHelpOpen(true)}
        onMenuClose={() => setIsNeedHelpOpen(false)}
        placement="bottom-end"
        maxHeight="lg"
        closeOnSelect
      >
        {DOCUMENTATION_URL && (
          <CustomMenu.MenuItem onClick={() => window.open(DOCUMENTATION_URL, "_blank")}>
            <div className="flex items-center gap-x-2 rounded-sm text-11">
              <PagesOutline className="h-3.5 w-3.5 text-secondary" height={14} width={14} />
              <span className="text-11">{t("documentation")}</span>
            </div>
          </CustomMenu.MenuItem>
        )}
        {(SUPPORT_URL || SUPPORT_EMAIL) && (
          <CustomMenu.MenuItem onClick={() => window.open(SUPPORT_URL || `mailto:${SUPPORT_EMAIL}`, "_blank")}>
            <div className="flex items-center gap-x-2 rounded-sm text-11">
              <UserOutline className="h-3.5 w-3.5 text-secondary" width={14} height={14} />
              <span className="text-11">Support</span>
            </div>
          </CustomMenu.MenuItem>
        )}
        {FEEDBACK_URL && (
          <CustomMenu.MenuItem onClick={() => window.open(FEEDBACK_URL, "_blank", "noopener,noreferrer")}>
            <div className="flex items-center gap-x-2 rounded-sm text-11">
              <ChatOutline className="h-3.5 w-3.5 text-secondary" width={14} height={14} />
              <span className="text-11">{t("power_k.help_actions.report_bug")}</span>
            </div>
          </CustomMenu.MenuItem>
        )}
        <div className="my-1 border-t border-subtle" />
        <CustomMenu.MenuItem
          onClick={() => toggleShortcutsListModal(true)}
          className="justify-sbg-layer-211 flex w-full items-center hover:bg-layer-1"
        >
          <span className="text-11">{t("keyboard_shortcuts")}</span>
        </CustomMenu.MenuItem>
        <CustomMenu.MenuItem
          onClick={() => window.open(VERSION_NOTES_URL, "_blank", "noopener,noreferrer")}
          className="justify-sbg-layer-211 flex w-full items-center hover:bg-layer-1"
        >
          <span className="text-11">{t("whats_new")}</span>
        </CustomMenu.MenuItem>
        <div className="mt-1 border-t border-subtle px-1 pt-2 text-11 text-secondary">
          <PlaneVersionNumber />
        </div>
      </CustomMenu>
    </>
  );
});
