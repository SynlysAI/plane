import { observer } from "mobx-react";
import { Link, useLocation } from "react-router";
import type { EUserPermissions } from "@plane/constants";
import type { EUserProjectRoles } from "@plane/types";
import { useTranslation } from "@plane/i18n";
import { useProject } from "@/hooks/store/use-project";
import { useUserPermissions } from "@/hooks/store/user";
import { useNavigationItems } from "./use-navigation-items";
import { ProjectHeader } from "./project-header";

export type TNavigationItem = {
  name: string;
  href: string;
  icon: React.ElementType;
  access: EUserPermissions[] | EUserProjectRoles[];
  shouldRender: boolean;
  sortOrder: number;
  i18n_key: string;
  key: string;
};

export const TabNavigationRoot = observer(function TabNavigationRoot({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug: string;
  projectId: string;
}) {
  const { getPartialProjectById } = useProject();
  const { allowPermissions } = useUserPermissions();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const project = getPartialProjectById(projectId);
  const items = useNavigationItems({ workspaceSlug, projectId, project, allowPermissions });
  if (!project) return null;
  return (
    <div className="flex h-full min-w-0 flex-1 items-center gap-3">
      <ProjectHeader workspaceSlug={workspaceSlug} projectId={projectId} />
      <nav aria-label="项目功能" className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto whitespace-nowrap">
        {items.map((item) => (
          <Link
            key={item.key}
            to={item.href}
            aria-current={pathname.startsWith(item.href) ? "page" : undefined}
            className={`border-b-2 py-2 text-13 ${pathname.startsWith(item.href) ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}
          >
            {item.key === "work_items" ? "任务" : item.key === "approvals" ? "审批" : t(item.i18n_key)}
          </Link>
        ))}
        <Link
          to={`/${workspaceSlug}/projects/${projectId}/archives/issues`}
          aria-current={pathname.startsWith(`/${workspaceSlug}/projects/${projectId}/archives/`) ? "page" : undefined}
          className={`border-b-2 py-2 text-13 ${pathname.startsWith(`/${workspaceSlug}/projects/${projectId}/archives/`) ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}
        >
          归档
        </Link>
        <Link to={`/${workspaceSlug}/settings/projects/${projectId}`} className="text-13 text-secondary">
          设置
        </Link>
      </nav>
    </div>
  );
});
