import { observer } from "mobx-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Home, ClipboardCheck, Settings } from "lucide-react";
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
import { useResearch } from "@/hooks/store/use-research";
import { useAppTheme } from "@/hooks/store/use-app-theme";

export const SidebarMenuItems = observer(function SidebarMenuItems() {
  const { workspaceSlug } = useParams();
  const pathname = usePathname();
  const research = useResearch();
  const { toggleSidebar } = useAppTheme();
  if (research.identityWorkspaceSlug !== workspaceSlug || !research.identity) return null;
  const items = [
    { name: "首页", path: "", icon: Home },
    { name: "审批中心", path: "/approvals", icon: ClipboardCheck },
    ...(research.identity.navigation?.management ? [{ name: "管理", path: "/management", icon: Settings }] : []),
  ];
  return <nav aria-label="工作区导航" className="flex shrink-0 flex-col gap-0.5">
    {items.map(({ name, path, icon: Icon }) => {
      const href = `/${workspaceSlug}${path}`;
      const active = path ? pathname.startsWith(href) : pathname.replace(/\/$/, "") === href;
      return <Link key={name} href={href} aria-current={active ? "page" : undefined}
        onClick={() => { if (window.innerWidth < 768) toggleSidebar(); }}>
        <SidebarNavItem isActive={active} className="h-8 gap-2">
          <Icon className="size-4" /><span className="flex-1 text-13 font-medium">{name}</span>
        </SidebarNavItem>
      </Link>;
    })}
  </nav>;
});
