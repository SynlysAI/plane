import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { NativeMCPManager } from "./native-mcp-manager";
import { ResearchMCPManager } from "./research-mcp-manager";
import { mcpSettingsPath, type TMCPContext } from "./mcp-context";

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
  const mode = params.get("mode") === "research" || params.has("node") ? "research" : "native";
  const context = {
    chain: params.get("chain"),
    node: params.get("node"),
    task: params.get("task"),
    operation: params.get("operation"),
  };
  useEffect(() => {
    void workspaceStore.fetchWorkspaces().catch(() => setWorkspaceError("无法加载工作区，请刷新重试。"));
  }, [workspaceStore]);
  const workspaces = Object.values(workspaceStore.workspaces);
  const changeContext = (next: TMCPContext) =>
    setParams(new URLSearchParams(mcpSettingsPath(workspaceSlug, next, "research").split("?")[1]));

  return (
    <div className="text-13 text-primary">
      <PageHead title="MCP 连接与操作" />
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-24 font-semibold">MCP 连接与操作</h1>
          <p className="text-secondary">管理个人 Agent 的连接、节点授权和变更提案。</p>
        </header>
        {workspaceError && <p role="alert">{workspaceError}</p>}
        <label className="block max-w-md">
          工作区
          <select
            aria-label="MCP 工作区"
            className="mt-1 w-full rounded border border-subtle bg-surface-1 px-3 py-2"
            value={workspaceSlug ?? ""}
            onChange={(event) => {
              if (event.target.value) setParams(new URLSearchParams({ mode, workspace: event.target.value }));
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
          <>
            <div role="tablist" aria-label="MCP 接入类型" className="flex gap-2 border-b border-subtle pb-3">
              {(
                [
                  ["native", "行政项目接入"],
                  ["research", "科研链节点接入"],
                ] as const
              ).map(([value, text]) => (
                <button
                  key={value}
                  role="tab"
                  id={`mcp-tab-${value}`}
                  aria-controls="mcp-panel"
                  aria-selected={mode === value}
                  className={`rounded px-4 py-2 ${mode === value ? "bg-layer-2 font-semibold" : "text-secondary"}`}
                  onClick={() => setParams(new URLSearchParams({ mode: value, workspace: workspaceSlug }))}
                >
                  {text}
                </button>
              ))}
            </div>
            <div
              role="tabpanel"
              id="mcp-panel"
              aria-labelledby={`mcp-tab-${mode}`}
              className="rounded-lg border border-subtle bg-surface-1 p-4 sm:p-6"
            >
              {mode === "research" ? (
                <ResearchMCPManager
                  key={`research:${workspaceSlug}`}
                  workspaceSlug={workspaceSlug}
                  context={context}
                  onContextChange={changeContext}
                />
              ) : (
                <NativeMCPManager key={`native:${workspaceSlug}`} workspaceSlug={workspaceSlug} />
              )}
            </div>
          </>
        ) : (
          <p>选择工作区后，可以管理行政项目连接或科研节点的 Agent 授权。</p>
        )}
      </div>
    </div>
  );
});
