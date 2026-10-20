import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { NativeMCPManager } from "./native-mcp-manager";

export const MCPManagement = observer(function MCPManagement({
  workspaceSlug: defaultWorkspaceSlug,
  inModal = false,
}: {
  workspaceSlug?: string;
  inModal?: boolean;
}) {
  const workspaceStore = useWorkspace();
  const [routeParams, setRouteParams] = useSearchParams();
  // A settings modal must not reuse or rewrite the underlying workbench URL.
  const [modalParams, setModalParams] = useState(() => new URLSearchParams());
  const params = inModal ? modalParams : routeParams;
  const setParams = (next: URLSearchParams) => (inModal ? setModalParams(next) : setRouteParams(next));
  const workspaceSlug = params.get("workspace") ?? defaultWorkspaceSlug;
  const [workspaceError, setWorkspaceError] = useState("");
  useEffect(() => {
    void workspaceStore.fetchWorkspaces().catch(() => setWorkspaceError("无法加载工作区，请刷新重试。"));
  }, [workspaceStore]);
  const workspaces = Object.values(workspaceStore.workspaces);

  return (
    <div className="text-13 text-primary">
      <PageHead title="MCP 配置" />
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-24 font-semibold">MCP 配置</h1>
          <p className="text-secondary">管理行政项目 Agent 的 MCP 连接。</p>
        </header>
        {workspaceError && <p role="alert">{workspaceError}</p>}
        <label className="block max-w-md">
          工作区
          <select
            aria-label="MCP 工作区"
            className="mt-1 w-full rounded border border-subtle bg-surface-1 px-3 py-2"
            value={workspaceSlug ?? ""}
            onChange={(event) => {
              if (event.target.value) setParams(new URLSearchParams({ workspace: event.target.value }));
            }}
          >
            <option value="">请选择工作区</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.slug}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
        {workspaceSlug ? (
          <div className="rounded-lg border border-subtle bg-surface-1 p-4 sm:p-6">
            <h2 className="mb-4 text-16 font-semibold text-primary">行政项目接入</h2>
            <NativeMCPManager key={`native:${workspaceSlug}`} workspaceSlug={workspaceSlug} />
          </div>
        ) : (
          <p>选择工作区后，可以管理行政项目 MCP 连接。</p>
        )}
      </div>
    </div>
  );
});
