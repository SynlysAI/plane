import { useParams } from "react-router";
import { WorkspaceTodos } from "@/components/home/workspace-todos";
export default function WorkspaceTodoPage() {
  const { workspaceSlug } = useParams();
  return (
    <div className="workspace-content-inset h-full overflow-auto bg-surface-1">
      <h1 className="text-22 border-b border-subtle px-5 py-4 font-semibold">我的待办</h1>
      {workspaceSlug && <WorkspaceTodos key={workspaceSlug} workspaceSlug={workspaceSlug} />}
    </div>
  );
}
