/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { usePathname } from "next/navigation";
// i18n
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// ui
import { Button } from "@plane/propel/button";
import { ProjectsOutline } from "@makeplane/propel/icons";
import { Breadcrumbs, Header } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useResearch } from "@/hooks/store/use-research";
import { useUserPermissions } from "@/hooks/store/user";
// plane web constants
// components
import HeaderFilters from "./filters";
import { ProjectSearch } from "./search-projects";

export const ProjectsBaseHeader = observer(function ProjectsBaseHeader() {
  // i18n
  const { t } = useTranslation();
  // store hooks
  const { toggleCreateProjectModal } = useCommandPalette();
  const research = useResearch();
  const { allowPermissions } = useUserPermissions();

  const pathname = usePathname();
  // auth
  const isAuthorizedUser = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE
  );
  const isArchived = pathname.includes("/archives");
  const usesAdministrativeChannel = true;
  const titleKey = usesAdministrativeChannel ? "administrative.projects.title" : "workspace_projects.label";
  const createKey = usesAdministrativeChannel ? "administrative.projects.create" : "workspace_projects.create.label";

  return (
    <Header>
      <Header.LeftItem>
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink
                label={t(titleKey, { count: 2 })}
                icon={<ProjectsOutline className="h-4 w-4 text-tertiary" />}
              />
            }
          />
          {isArchived && <Breadcrumbs.Item component={<BreadcrumbLink label="Archived" />} />}
        </Breadcrumbs>
      </Header.LeftItem>
      <Header.RightItem>
        <ProjectSearch />
        <div className="hidden md:flex">
          <HeaderFilters />
        </div>
        {isAuthorizedUser && usesAdministrativeChannel && !isArchived && (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => window.dispatchEvent(new CustomEvent("administrative-organization-create"))}
          >
            新建组织
          </Button>
        )}
        {isAuthorizedUser && !isArchived ? (
          <Button
            variant="primary"
            size="lg"
            onClick={() => {
              toggleCreateProjectModal(true);
            }}
            className="items-center gap-1"
          >
            <span className="hidden sm:inline-block">{t(createKey)}</span>
            <span className="inline-block sm:hidden">{t(createKey)}</span>
          </Button>
        ) : (
          <></>
        )}
      </Header.RightItem>
    </Header>
  );
});
