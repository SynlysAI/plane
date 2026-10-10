/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TabNavigationList } from "@plane/propel/tab-navigation";
// components
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  activeTab: "projects" | "views" | "analytics" | "archives";
  /** 普通 Plane 页面主体；容器不复制页面数据与权限逻辑。 */
  children?: ReactNode;
};

const TABS = [
  {
    id: "projects" as const,
    labelKey: "administrative.projects.title",
    href: "/projects",
  },
  {
    id: "views" as const,
    labelKey: "administrative.views.title",
    href: "/workspace-views/all-issues/",
  },
  {
    id: "analytics" as const,
    labelKey: "administrative.analytics.title",
    href: "/analytics/overview/",
  },
  {
    id: "archives" as const,
    labelKey: "administrative.archives.title",
    href: "/projects/archives",
  },
];

/**
 * 行政项目通道容器：只包装普通 Plane 的四个既有能力入口。
 * IA v2 关闭时原样返回页面主体，保证旧信息架构可回退。
 */
export const AdministrativeProjectTabs = observer(function AdministrativeProjectTabs({
  workspaceSlug,
  activeTab,
  children,
}: Props) {
  const { t } = useTranslation();
  const research = useResearch();

  if (!research.isEnabled || !research.isIaV2Enabled) return <>{children}</>;

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col bg-surface-1">
      <div className="shrink-0 border-b border-subtle px-5 py-3.5">
        <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-22 truncate font-semibold text-primary">{t("administrative.projects.title")}</h2>
            <p className="mt-0.5 text-13 text-tertiary">{t("administrative.projects.description")}</p>
            <p className="text-12 text-tertiary">{t("administrative.projects.boundary")}</p>
          </div>
        </div>
      </div>
      <nav
        aria-label={t("administrative.projects.title")}
        className="shrink-0 overflow-x-auto border-b border-subtle px-5"
      >
        <TabNavigationList className="py-2">
          {TABS.map((tab) => (
            <ResearchTabLink key={tab.id} href={`/${workspaceSlug}${tab.href}`} isActive={tab.id === activeTab}>
              {t(tab.labelKey)}
            </ResearchTabLink>
          ))}
        </TabNavigationList>
      </nav>
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  );
});
