import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useResearch } from "@/hooks/store/use-research";
import useLocalStorage from "@/hooks/use-local-storage";
import { ResearchProjectTree } from "./research-project-tree";

export const ResearchSidebarItems = observer(function ResearchSidebarItems() {
  const { workspaceSlug } = useParams();
  const research = useResearch();
  const { storedValue: researchOpen } = useLocalStorage<boolean>("research_navigation_research_open", true);
  if (!workspaceSlug || research.identityWorkspaceSlug !== workspaceSlug || !research.identity) return null;
  const canResearch = research.isEnabled && research.canSee("research_chain");
  return (
    <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2 border-t border-subtle pt-2">
      {canResearch && (
        <ResearchProjectTree
          scope="RESEARCH"
          title="科研项目"
          canManage={research.isResearchAdmin}
          fillAvailableSpace
        />
      )}
      <ResearchProjectTree
        scope="ADMINISTRATIVE"
        title="行政项目"
        canManage={Boolean(research.identity.navigation?.administrative_organizations)}
        fillAvailableSpace={!canResearch || !(researchOpen ?? true)}
      />
    </div>
  );
});
