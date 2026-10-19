import { useEffect, useRef, useState } from "react";
import type { TResearchChain, TResearchChainNode } from "@plane/types";
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";
import { ResearchAgentOperations } from "@/components/research/chains/research-agent-operations";
import type { TMCPContext } from "./mcp-context";

const chainsService = new ResearchChainService();
const tasksService = new ResearchChainTaskService();
const selectClass = "w-full rounded border border-subtle bg-surface-1 px-3 py-2 text-primary";

export function ResearchMCPManager({
  workspaceSlug,
  context,
  onContextChange,
}: {
  workspaceSlug: string;
  context: TMCPContext;
  onContextChange: (context: TMCPContext) => void;
}) {
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [verified, setVerified] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const listGeneration = useRef(0);
  const identity = JSON.stringify([workspaceSlug, context.chain, context.node, context.task]);

  useEffect(() => {
    let active = true;
    const expected = ++listGeneration.current;
    setChains([]);
    setCursor("");
    void chainsService
      .getChainPage(workspaceSlug)
      .then(async (page) => {
        // A historical deep link may point beyond the first page of chains.
        const items = [...page.results];
        if (context.chain && !items.some((item) => item.id === context.chain)) {
          items.unshift(await chainsService.getChain(workspaceSlug, context.chain));
        }
        if (active) {
          setChains(items);
          setCursor(page.next_page_results ? page.next_cursor : "");
        }
        return page;
      })
      .catch(() => {
        if (active) setError("无法读取科研链，请检查权限后重试。");
      });
    return () => {
      active = false;
      listGeneration.current = expected + 1;
    };
  }, [workspaceSlug, context.chain]);

  useEffect(() => {
    let active = true;
    setVerified("");
    setNodes([]);
    setTaskTitle("");
    setError("");
    setLoading(Boolean(context.chain));
    if (!context.chain) return;
    void (async () => {
      const items = await chainsService.getChainNodes(workspaceSlug, context.chain!);
      if (!active) return;
      setNodes(items);
      if (context.node) {
        if (!items.some((node) => node.id === context.node && node.chain === context.chain)) {
          throw new Error("所选节点不属于当前科研链，或你没有访问权限。请重新选择。");
        }
        if (context.task) {
          const tasks = await tasksService.getNodeTasks(workspaceSlug, context.chain!, context.node);
          const task = tasks.find((item) => item.id === context.task);
          if (!task) throw new Error("任务不属于当前节点，或已不可访问。请从节点重新进入。");
          if (active) setTaskTitle(task.title);
        }
        if (active) setVerified(identity);
      }
    })()
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : "无法读取节点，请检查权限后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceSlug, context.chain, context.node, context.task, identity]);

  return (
    <div className="space-y-4">
      <p className="text-secondary">
        读取科研链与节点证据，准备五类受控变更。连接仅覆盖选定节点，默认有效 7 天；每项提案仍需本人确认，有效期 24
        小时。文件和外部引用仅提供允许的元数据。
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          科研链
          <select
            aria-label="科研链"
            className={selectClass}
            value={context.chain ?? ""}
            onChange={(event) => onContextChange({ chain: event.target.value })}
          >
            <option value="">请选择科研链</option>
            {chains.map((chain) => (
              <option key={chain.id} value={chain.id}>
                {chain.project_name || chain.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          科研节点
          <select
            aria-label="科研节点"
            className={selectClass}
            value={context.node ?? ""}
            disabled={!context.chain || loading}
            onChange={(event) => onContextChange({ chain: context.chain, node: event.target.value })}
          >
            <option value="">请选择节点</option>
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.title} · {node.status}
              </option>
            ))}
          </select>
        </label>
      </div>
      {cursor && (
        <button
          className="text-accent-primary"
          onClick={() => {
            const requestedWorkspace = workspaceSlug;
            const expected = listGeneration.current;
            void chainsService
              .getChainPage(requestedWorkspace, { cursor })
              .then((page) => {
                if (expected !== listGeneration.current) return page;
                setChains((items) => [
                  ...items,
                  ...page.results.filter((item) => !items.some((old) => old.id === item.id)),
                ]);
                setCursor(page.next_page_results ? page.next_cursor : "");
                return page;
              })
              .catch(() => {
                if (expected === listGeneration.current) setError("加载更多科研链失败，请重试。");
              });
          }}
        >
          加载更多科研链
        </button>
      )}
      {loading && <p role="status">正在核对节点上下文…</p>}
      {error && (
        <p role="alert" className="text-danger-primary">
          {error}
        </p>
      )}
      {verified === identity && context.chain && context.node && (
        <>
          <a
            className="text-accent-primary"
            href={`/${encodeURIComponent(workspaceSlug)}/research/chains/${encodeURIComponent(context.chain)}/?tab=nodes&node=${encodeURIComponent(context.node)}`}
          >
            返回节点工作台
          </a>
          {taskTitle && <p>来源科研任务：{taskTitle}。此连接仍覆盖整个节点。</p>}
          <ResearchAgentOperations
            key={`${workspaceSlug}:${context.node}`}
            workspaceSlug={workspaceSlug}
            nodeId={context.node}
            operationId={context.operation}
          />
        </>
      )}
    </div>
  );
}
