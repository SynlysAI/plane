import { observer } from "mobx-react";
import { MCPManagement } from "@/components/mcp/mcp-management";
import { useWorkspace } from "@/hooks/store/use-workspace";

export const MCPProfileSettings = observer(function MCPProfileSettings({ inModal = false }: { inModal?: boolean }) {
  const { currentWorkspace } = useWorkspace();
  return <MCPManagement workspaceSlug={currentWorkspace?.slug} inModal={inModal} />;
});
