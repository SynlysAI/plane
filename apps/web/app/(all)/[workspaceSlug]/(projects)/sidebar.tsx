import { observer } from "mobx-react";
import { SidebarWrapper } from "@/components/sidebar/sidebar-wrapper";
import { SidebarQuickActions } from "@/components/workspace/sidebar/quick-actions";
import { SidebarMenuItems } from "@/components/workspace/sidebar/sidebar-menu-items";
import { ResearchSidebarItems } from "@/components/research/navigation/research-sidebar-items";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";

export const AppSidebar = observer(function AppSidebar() {
  const { context, error, retry } = useWorkspaceContext();
  return (
    <SidebarWrapper title="项目" quickActions={<SidebarQuickActions />} contentLayout="fill">
      <SidebarMenuItems />
      {context ? (
        <ResearchSidebarItems />
      ) : error ? (
        <div role="alert" className="mt-2 space-y-2 border-t border-subtle px-2 pt-2 text-13 text-secondary">
          <p>导航加载失败。</p>
          <button type="button" className="text-accent-primary" onClick={retry}>
            重试
          </button>
        </div>
      ) : (
        <div
          role="status"
          aria-busy="true"
          className="mt-2 space-y-2 border-t border-subtle pt-2"
          aria-label="正在加载导航"
        >
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="h-8 animate-pulse rounded bg-surface-2" />
          ))}
        </div>
      )}
    </SidebarWrapper>
  );
});
