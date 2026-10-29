/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { isEqual } from "lodash-es";
// plane imports
import {
  EIssueFilterType,
  EUserPermissions,
  EUserPermissionsLevel,
  ISSUE_DISPLAY_FILTERS_BY_PAGE,
  DEFAULT_GLOBAL_VIEWS_LIST,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ViewsOutline } from "@makeplane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IIssueDisplayFilterOptions, IIssueDisplayProperties, ICustomSearchSelectOption } from "@plane/types";
import { EIssuesStoreType, EIssueLayoutTypes } from "@plane/types";
import { Breadcrumbs, Header, BreadcrumbNavigationSearchDropdown } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { DetailBackLink } from "@/components/common/detail-back-link";
import { SwitcherLabel } from "@/components/common/switcher-label";
import { DisplayFiltersSelection, FiltersDropdown } from "@/components/issues/issue-layouts/filters";
import { WorkItemFiltersToggle } from "@/components/work-item-filters/filters-toggle";
import { DefaultWorkspaceViewQuickActions } from "@/components/workspace/views/default-view-quick-action";
import { CreateUpdateWorkspaceViewModal } from "@/components/workspace/views/modal";
import { WorkspaceViewQuickActions } from "@/components/workspace/views/quick-action";
// hooks
import { useAdministrativeSettingsLock } from "@/hooks/use-administrative-settings-lock";
import { useGlobalView } from "@/hooks/store/use-global-view";
import { useIssues } from "@/hooks/store/use-issues";
import { useUserPermissions } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();

export const GlobalIssuesHeader = observer(function GlobalIssuesHeader() {
  // states
  const [createViewModal, setCreateViewModal] = useState(false);
  // router
  const router = useAppRouter();
  const { workspaceSlug, globalViewId: routerGlobalViewId } = useParams();
  const globalViewId = routerGlobalViewId ? routerGlobalViewId.toString() : undefined;
  // store hooks
  const {
    issuesFilter: { filters, updateFilters },
  } = useIssues(EIssuesStoreType.GLOBAL);
  const { getViewDetailsById, currentWorkspaceViews } = useGlobalView();
  const { allowPermissions } = useUserPermissions();
  const { t } = useTranslation();
  const [isSavingDefaultLayout, setIsSavingDefaultLayout] = useState(false);
  const isAdministrativeSettingsLocked = useAdministrativeSettingsLock();

  const issueFilters = globalViewId ? filters[globalViewId.toString()] : undefined;

  const activeLayout = issueFilters?.displayFilters?.layout;
  const viewDetails = globalViewId ? getViewDetailsById(globalViewId) : undefined;

  const handleDisplayFilters = useCallback(
    (updatedDisplayFilter: Partial<IIssueDisplayFilterOptions>) => {
      if (!workspaceSlug || !globalViewId) return;
      updateFilters(
        workspaceSlug.toString(),
        undefined,
        EIssueFilterType.DISPLAY_FILTERS,
        updatedDisplayFilter,
        globalViewId
      );
    },
    [workspaceSlug, updateFilters, globalViewId]
  );

  const handleDisplayProperties = useCallback(
    (property: Partial<IIssueDisplayProperties>) => {
      if (!workspaceSlug || !globalViewId) return;
      updateFilters(workspaceSlug.toString(), undefined, EIssueFilterType.DISPLAY_PROPERTIES, property, globalViewId);
    },
    [workspaceSlug, updateFilters, globalViewId]
  );

  const isLocked = viewDetails?.is_locked;

  const isDefaultView = DEFAULT_GLOBAL_VIEWS_LIST.find((view) => view.key === globalViewId);

  const defaultViewDetails = DEFAULT_GLOBAL_VIEWS_LIST.find((view) => view.key === globalViewId);
  const canManageDefaultLayout = Boolean(
    isDefaultView &&
    workspaceSlug &&
    allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE, workspaceSlug.toString())
  );
  const { data: savedDefaultLayout, mutate: mutateDefaultLayout } = useSWR(
    canManageDefaultLayout && workspaceSlug
      ? ["WORKSPACE_ADMINISTRATIVE_VIEW_DEFAULT", workspaceSlug.toString()]
      : null,
    ([, slug]) => workspaceService.fetchAdministrativeViewDefault(slug),
    { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const hasDefaultLayoutChanges = Boolean(
    canManageDefaultLayout &&
    savedDefaultLayout &&
    (!isEqual(issueFilters?.displayFilters, savedDefaultLayout.display_filters) ||
      !isEqual(issueFilters?.displayProperties, savedDefaultLayout.display_properties))
  );

  const defaultOptions = DEFAULT_GLOBAL_VIEWS_LIST.map((view) => ({
    value: view.key,
    query: view.key,
    content: <SwitcherLabel name={t(view.i18n_label)} LabelIcon={ViewsOutline} />,
  }));

  const workspaceOptions = (currentWorkspaceViews || []).map((view) => {
    const _view = getViewDetailsById(view);
    if (!_view) return;
    return {
      value: _view.id,
      query: _view.name,
      content: <SwitcherLabel name={_view.name} LabelIcon={ViewsOutline} />,
    };
  });

  const switcherOptions = [...defaultOptions, ...workspaceOptions].filter(
    (option) => option !== undefined
  ) as ICustomSearchSelectOption[];
  const currentLayoutFilters = useMemo(() => {
    const layout = activeLayout ?? EIssueLayoutTypes.SPREADSHEET;
    return ISSUE_DISPLAY_FILTERS_BY_PAGE.my_issues.layoutOptions[layout];
  }, [activeLayout]);

  const handleSaveDefaultLayout = useCallback(async () => {
    if (!workspaceSlug || !issueFilters) return;
    setIsSavingDefaultLayout(true);
    try {
      const savedLayout = await workspaceService.updateAdministrativeViewDefault(workspaceSlug.toString(), {
        display_filters: { ...issueFilters.displayFilters },
        display_properties: { ...issueFilters.displayProperties },
      });
      await mutateDefaultLayout(savedLayout, { revalidate: false });
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "已同步给全部成员",
        message: "成员下次进入或刷新系统默认视图时将使用该布局。",
      });
    } catch {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "保存失败",
        message: "全员默认布局未保存，请稍后重试。",
      });
    } finally {
      setIsSavingDefaultLayout(false);
    }
  }, [issueFilters, mutateDefaultLayout, workspaceSlug]);

  return (
    <>
      <CreateUpdateWorkspaceViewModal isOpen={createViewModal} onClose={() => setCreateViewModal(false)} />
      <Header>
        <Header.LeftItem>
          <div className="flex items-center gap-2">
            <DetailBackLink href={`/${workspaceSlug}/workspace-views`}>返回工作区视图列表</DetailBackLink>
            <Breadcrumbs>
              <Breadcrumbs.Item
                component={
                  <BreadcrumbLink label={t("views")} icon={<ViewsOutline className="h-4 w-4 text-tertiary" />} />
                }
              />
              <Breadcrumbs.Item
                component={
                  <BreadcrumbNavigationSearchDropdown
                    selectedItem={globalViewId?.toString() || ""}
                    navigationItems={switcherOptions}
                    onChange={(value: string) => {
                      router.push(`/${workspaceSlug}/workspace-views/${value}`);
                    }}
                    title={viewDetails?.name ?? t(defaultViewDetails?.i18n_label ?? "")}
                    icon={
                      <Breadcrumbs.Icon>
                        <ViewsOutline className="size-4 flex-shrink-0 text-tertiary" />
                      </Breadcrumbs.Icon>
                    }
                    isLast
                  />
                }
                isLast
              />
            </Breadcrumbs>
          </div>
        </Header.LeftItem>

        <Header.RightItem className="items-center">
          {globalViewId && <WorkItemFiltersToggle entityType={EIssuesStoreType.GLOBAL} entityId={globalViewId} />}
          {!isLocked && (!isDefaultView || canManageDefaultLayout) && (
            <FiltersDropdown title={t("common.display")} placement="bottom-end">
              <DisplayFiltersSelection
                layoutDisplayFiltersOptions={currentLayoutFilters}
                displayFilters={issueFilters?.displayFilters ?? {}}
                handleDisplayFiltersUpdate={handleDisplayFilters}
                displayProperties={issueFilters?.displayProperties ?? {}}
                handleDisplayPropertiesUpdate={handleDisplayProperties}
              />
            </FiltersDropdown>
          )}
          {isDefaultView && !canManageDefaultLayout && (
            <span className="text-12 text-tertiary">布局由工作区管理员统一设置</span>
          )}
          {hasDefaultLayoutChanges && (
            <Button variant="secondary" size="lg" onClick={handleSaveDefaultLayout} disabled={isSavingDefaultLayout}>
              {isSavingDefaultLayout ? "正在保存…" : "保存为全员默认布局"}
            </Button>
          )}
          {!isAdministrativeSettingsLocked && (
            <Button variant="primary" size="lg" onClick={() => setCreateViewModal(true)}>
              {t("workspace_views.add_view")}
            </Button>
          )}
          <div className="hidden md:block">
            {viewDetails && <WorkspaceViewQuickActions workspaceSlug={workspaceSlug?.toString()} view={viewDetails} />}
            {isDefaultView && defaultViewDetails && (
              <DefaultWorkspaceViewQuickActions workspaceSlug={workspaceSlug?.toString()} view={defaultViewDetails} />
            )}
          </div>
        </Header.RightItem>
      </Header>
    </>
  );
});
