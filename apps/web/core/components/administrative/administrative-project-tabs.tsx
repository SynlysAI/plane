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
import { Button } from "@plane/propel/button";
import { ModalCore, EModalWidth, Input } from "@plane/ui";
import { useEffect, useState } from "react";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
// components
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { useProject } from "@/hooks/store/use-project";
import { ResearchNavigationService } from "@/services/research/navigation.service";

const navigationService = new ResearchNavigationService();

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
  const [isOrganizationOpen, setIsOrganizationOpen] = useState(false);
  const [organizationName, setOrganizationName] = useState("");
  const [isSavingOrganization, setIsSavingOrganization] = useState(false);
  const { fetchProjects } = useProject();

  useEffect(() => {
    if (activeTab !== "projects") return;

    const openOrganizationModal = () => setIsOrganizationOpen(true);
    window.addEventListener("administrative-organization-create", openOrganizationModal);
    return () => window.removeEventListener("administrative-organization-create", openOrganizationModal);
  }, [activeTab]);

  if (!research.isEnabled || !research.isIaV2Enabled) return <>{children}</>;

  return (
    <div className="flex min-h-full w-full min-w-0 flex-col bg-surface-1">
      <div className="shrink-0 border-b border-subtle px-5 py-3.5">
        <div className="min-w-0">
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
      <ModalCore
        isOpen={isOrganizationOpen}
        handleClose={() => !isSavingOrganization && setIsOrganizationOpen(false)}
        width={EModalWidth.SM}
      >
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            const name = organizationName.trim();
            if (!name || isSavingOrganization) return;
            setIsSavingOrganization(true);
            void navigationService
              .createAdministrativeOrganization(workspaceSlug, name)
              .then(async () => {
                setOrganizationName("");
                setIsOrganizationOpen(false);
                setToast({ type: TOAST_TYPE.SUCCESS, title: "组织已创建", message: "新组织已可用于归属行政项目。" });
                await fetchProjects(workspaceSlug, "administrative");
                window.dispatchEvent(new CustomEvent("administrative-organizations-updated"));
                return undefined;
              })
              .catch((error) => {
                const message =
                  error?.message === "An organization with this name already exists."
                    ? "组织名称已存在，请更换名称。"
                    : (error?.message ?? "请稍后重试");
                setToast({ type: TOAST_TYPE.ERROR, title: "组织创建失败", message });
              })
              .finally(() => setIsSavingOrganization(false));
          }}
        >
          <h3 className="text-15 font-semibold">新建行政组织</h3>
          <p className="mt-1 text-12 text-secondary">组织成员会继承组织内行政项目的只读访问权限。</p>
          <label htmlFor="administrative-organization-name" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            组织名称
            <Input
              id="administrative-organization-name"
              value={organizationName}
              maxLength={255}
              onChange={(event) => setOrganizationName(event.target.value)}
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setIsOrganizationOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={isSavingOrganization}>
              创建组织
            </Button>
          </div>
        </form>
      </ModalCore>
    </div>
  );
});
