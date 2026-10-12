/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
// plane types
import { PagesOutline, ProjectsOutline, WorkItemsOutline } from "@makeplane/propel/icons";
import type { TActivityEntityData, THomeWidgetProps, TRecentActivityFilterKeys } from "@plane/types";
// plane ui
// components
import { ContentOverflowWrapper } from "@/components/core/content-overflow-HOC";
// plane web services
import { WorkspaceService } from "@/services/workspace.service";
import { RecentsEmptyState } from "../empty-states";
import { EWidgetKeys, WidgetLoader } from "../loaders";
import { FiltersDropdown } from "./filters";
import { RecentIssue } from "./issue";
import { RecentPage } from "./page";
import { RecentProject } from "./project";

const WIDGET_KEY = EWidgetKeys.RECENT_ACTIVITY;
const workspaceService = new WorkspaceService();
const filters: { name: TRecentActivityFilterKeys; icon?: React.ReactNode; i18n_key: string }[] = [
  { name: "all item", i18n_key: "home.recents.filters.all" },
  { name: "issue", icon: <WorkItemsOutline className="h-4 w-4" />, i18n_key: "home.recents.filters.issues" },
  { name: "page", icon: <PagesOutline height={16} width={16} />, i18n_key: "home.recents.filters.pages" },
  { name: "project", icon: <ProjectsOutline height={16} width={16} />, i18n_key: "home.recents.filters.projects" },
];

type TRecentWidgetProps = THomeWidgetProps & {
  presetFilter?: TRecentActivityFilterKeys;
  showFilterSelect?: boolean;
  title?: string;
  /** 首页卡片内嵌模式：隐藏自身标题与展开容器，滚动交由外层卡片管理。 */
  embedded?: boolean;
  /** 仅展示行政项目及相关内容；省略时保持通用最近访问行为。 */
  scope?: "administrative";
  /** 首页刷新序号，变化时重新验证缓存中的访问记录。 */
  refreshToken?: number;
  /** 科研项目 ID 到研究链 ID 的映射。最近动态里的研究链应进入课题，而不是行政工作项。 */
  researchChainByProject?: Record<string, string>;
};

export const RecentActivityWidget = observer(function RecentActivityWidget(props: TRecentWidgetProps) {
  const {
    presetFilter,
    showFilterSelect = true,
    title,
    workspaceSlug,
    embedded = false,
    scope,
    refreshToken = 0,
    researchChainByProject,
  } = props;
  // states
  const [filter, setFilter] = useState<TRecentActivityFilterKeys>(presetFilter ?? filters[0].name);
  const { t } = useTranslation();
  // ref
  const ref = useRef<HTMLDivElement>(null);
  const previousRefresh = useRef(refreshToken);

  const {
    data: recents,
    isLoading,
    error,
    mutate,
  } = useSWR(
    workspaceSlug ? ["WORKSPACE_RECENT_ACTIVITY", workspaceSlug, filter, scope ?? "all"] : null,
    workspaceSlug
      ? () =>
          workspaceService.fetchWorkspaceRecents(
            workspaceSlug.toString(),
            filter === filters[0].name ? undefined : filter,
            scope
          )
      : null,
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      revalidateOnMount: scope === "administrative" ? true : undefined,
    }
  );

  useEffect(() => {
    if (previousRefresh.current === refreshToken) return;
    previousRefresh.current = refreshToken;
    void mutate();
  }, [mutate, refreshToken]);

  const visibleRecents = recents?.filter((recent) => recent.entity_data) ?? [];
  const resolveRecent = (activity: TActivityEntityData) => {
    switch (activity.entity_name) {
      case "page":
      case "workspace_page":
        return <RecentPage activity={activity} ref={ref} workspaceSlug={workspaceSlug} />;
      case "project":
        return (
          <RecentProject
            activity={activity}
            ref={ref}
            workspaceSlug={workspaceSlug}
            researchChainByProject={researchChainByProject}
          />
        );
      case "issue":
        return <RecentIssue activity={activity} ref={ref} workspaceSlug={workspaceSlug} />;
      default:
        return <></>;
    }
  };

  if (embedded) {
    if (isLoading)
      return (
        <div className="p-4" role="status" aria-busy="true">
          <WidgetLoader widgetKey={WIDGET_KEY} />
        </div>
      );
    if (error && visibleRecents.length === 0)
      return (
        <p className="p-4 text-12 text-secondary" role="alert">
          {t("research.home_workbench.recent_error")}
        </p>
      );
    if (visibleRecents.length === 0) return <RecentsEmptyState type={filter} />;
    return (
      <div className="flex min-h-0 flex-col divide-y divide-subtle">
        {visibleRecents.map((activity) => (
          <div key={activity.id}>{resolveRecent(activity)}</div>
        ))}
      </div>
    );
  }

  if (!isLoading && recents?.length === 0)
    return (
      <div ref={ref} className="max-h-[500px] overflow-y-scroll">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-14 font-semibold text-tertiary">{title ?? t("home.recents.title")}</div>
          {showFilterSelect && <FiltersDropdown filters={filters} activeFilter={filter} setActiveFilter={setFilter} />}
        </div>
        <div className="flex flex-col items-center justify-center">
          <RecentsEmptyState type={filter} />
        </div>
      </div>
    );

  return (
    <ContentOverflowWrapper
      maxHeight={415}
      containerClassName="box-border min-h-[250px]"
      fallback={<></>}
      buttonClassName="bg-surface-2/20"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="text-14 font-semibold text-tertiary">{title ?? t("home.recents.title")}</div>
        {showFilterSelect && <FiltersDropdown filters={filters} activeFilter={filter} setActiveFilter={setFilter} />}
      </div>
      <div className="flex min-h-[250px] flex-col">
        {isLoading && <WidgetLoader widgetKey={WIDGET_KEY} />}
        {!isLoading &&
          recents
            ?.filter((recent) => recent.entity_data)
            .map((activity) => <div key={activity.id}>{resolveRecent(activity)}</div>)}
      </div>
    </ContentOverflowWrapper>
  );
});
