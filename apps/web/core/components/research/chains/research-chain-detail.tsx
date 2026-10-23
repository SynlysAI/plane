"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Skeleton } from "@plane/propel/skeleton";
import { TabNavigationList } from "@plane/propel/tab-navigation";
import { Table, TableBody, TableCell, TableRow, TableHead, TableHeader } from "@plane/propel/table";
import { ListFilterField, ListFilterSelect } from "@plane/ui";
import { ResearchFilterToolbar, ResearchTableSurface } from "@/components/research/common/research-data-surface";
import type {
  TResearchChain,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeAction,
  TResearchChainStageApprovalSummary,
} from "@plane/types";
// components
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { ResearchDeleteButton } from "@/components/research/common/research-delete-button";
import { useResearch } from "@/hooks/store/use-research";
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { pickCurrentNode } from "@/components/research/chains/research-selection";
import { ResearchChainWorkflowRail } from "@/components/research/chains/research-chain-workflow-rail";
import { ResearchChainStageApprovalPanel } from "@/components/research/chains/research-chain-stage-approval-panel";
import { ResearchChainKnowledgePanel } from "@/components/research/chains/research-chain-knowledge-panel";
import {
  buildResearchWorkflow,
  type TResearchWorkflowStage,
} from "@/components/research/chains/research-chain-workflow";
import {
  ResearchChainWorkflowStageDetail,
  type TResearchChainStageNodeDetail,
} from "@/components/research/chains/research-chain-workflow-stage-detail";
import { ResearchChainTaskPanel } from "@/components/research/chains/research-chain-task-panel";
import { ResearchPaperReviewPanel } from "@/components/research/chains/research-paper-review-panel";
// hooks
import { useMember } from "@/hooks/store/use-member";
// services
import { ResearchChainService } from "@/services/research/chain.service";
const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
  chainId: string;
};

type TChainTab = "overview" | "nodes" | "members";
type TRequestedChainTab = TChainTab | "replay" | "reports" | "experiments" | "references";

const MATERIAL_TABS = new Set(["materials", "reports", "experiments", "references"]);

/**
 * 将已移除的课题资料旧地址收回节点工作台。
 *
 * Args:
 *     requested: 地址栏中的 tab 参数。
 *
 * Returns:
 *     课题页实际展示的分区。旧资料页签地址回到节点工作台。
 */
export function resolveChainTab(requested: string | null): TChainTab {
  if (requested === "replay") return "nodes";
  if (requested && MATERIAL_TABS.has(requested)) return "nodes";
  if (requested === "overview" || requested === "nodes" || requested === "members") return requested;
  return "overview";
}

const ACTIONS_BY_STATUS: Record<TResearchChainNode["status"], TResearchChainNodeAction[]> = {
  DRAFT: ["START", "ARCHIVE"],
  ACTIVE: ["SUBMIT_REVIEW", "FAIL", "ARCHIVE"],
  WAITING_HUMAN: ["APPROVE", "RETURN"],
  NEEDS_REVISION: ["START", "ARCHIVE"],
  FAILED: ["START", "ARCHIVE"],
  COMPLETED: ["ARCHIVE"],
  ARCHIVED: [],
};

const NODE_TYPE_BY_STAGE: Record<TResearchWorkflowStage["id"], string> = {
  literature_review: "LITERATURE_REVIEW",
  topic_selection: "TOPIC_SELECTION",
  topic_evaluation: "TOPIC_EVALUATION",
  pre_experiment: "PRE_EXPERIMENT",
  analysis_pre_experiment: "ANALYSIS",
  opening: "OPENING",
  experiment: "EXPERIMENT",
  analysis_experiment: "ANALYSIS",
  iteration: "ITERATION",
  summary: "SUMMARY",
  paper_writing: "PAPER_WRITING",
  completion: "COMPLETION",
  transfer: "TRANSFER",
};

const MEMBER_ROLE_LABELS: Record<string, string> = {
  OWNER: "research.chains.members.role_owner",
  ADMIN: "research.chains.members.role_admin",
  MEMBER: "research.chains.members.role_member",
};

/** Research Chain topic page with fixed context, tabs, workflow evidence and members. */
export const ResearchChainDetail = function ResearchChainDetail({ workspaceSlug, chainId }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const assistant = useAIAssistant();
  const navigate = useNavigate();
  const memberStore = useMember();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as TRequestedChainTab | null;
  const requestedNodeId = searchParams.get("node");
  const activeTab = resolveChainTab(requestedTab);
  const [chain, setChain] = useState<TResearchChain | null>(null);
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [stageApprovalSummary, setStageApprovalSummary] = useState<TResearchChainStageApprovalSummary | null>(null);
  const [members, setMembers] = useState<TResearchChainMember[]>([]);
  const [stageDetails, setStageDetails] = useState<TResearchChainStageNodeDetail[]>([]);
  const [selected, setSelected] = useState<TResearchChainStageNodeDetail | null>(null);
  const [stageDetailLoading, setStageDetailLoading] = useState(false);
  const [stageDetailError, setStageDetailError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [nodeTitle, setNodeTitle] = useState("");
  const [creatingNodeInline, setCreatingNodeInline] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [reasonAction, setReasonAction] = useState<TResearchChainNodeAction | null>(null);
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"15" | "20">("15");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberError, setMemberError] = useState("");
  const current = useMemo(() => pickCurrentNode(nodes), [nodes]);
  const workflow = useMemo(
    () => buildResearchWorkflow(nodes, current?.id ?? null, stageApprovalSummary?.stages ?? []),
    [current, nodes, stageApprovalSummary]
  );
  const requestedStageId = searchParams.get("stage");
  const requestedNode = nodes.find((node) => node.id === requestedNodeId);
  const selectedStage =
    workflow.stages.find((stage) => stage.id === requestedStageId) ??
    workflow.stages.find(
      (stage) => requestedNode && [...stage.nodeIds, ...stage.associatedNodeIds].includes(requestedNode.id)
    ) ??
    workflow.stages.find((stage) => stage.isCurrent) ??
    workflow.stages[0];
  const stageNodes = useMemo(() => {
    if (!selectedStage) return [];
    const ids = [...selectedStage.nodeIds, ...selectedStage.associatedNodeIds];
    if (requestedNode && !ids.includes(requestedNode.id)) ids.push(requestedNode.id);
    return ids
      .map((nodeId) => nodes.find((node) => node.id === nodeId))
      .filter((node): node is TResearchChainNode => Boolean(node));
  }, [nodes, requestedNode, selectedStage]);
  const stageNodeIds = stageNodes.map((node) => node.id).join(",");
  const preferredNodeId = requestedNode?.id ?? selectedStage?.preferredNodeId ?? null;
  const selectedStageApproval = stageApprovalSummary?.stages.find(
    (stage) => stage.stage_code === selectedStage?.stageCode
  );

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    setStageDetails([]);
    setSelected(null);
    setStageDetailError(false);
    try {
      const [chainDetail, chainNodes, chainMembers, stageApprovals] = await Promise.all([
        chainService.getChain(workspaceSlug, chainId),
        chainService.getChainNodes(workspaceSlug, chainId),
        chainService.getChainMembers(workspaceSlug, chainId).catch(() => []),
        chainService.getChainStageApprovals(workspaceSlug, chainId),
      ]);
      setChain(chainDetail);
      setNodes(chainNodes);
      setMembers(chainMembers);
      setStageApprovalSummary(stageApprovals);
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setForbidden(errorCode === "research_permission_denied");
      setFailed(errorCode !== "research_permission_denied");
    } finally {
      setLoading(false);
    }
  }, [chainId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const nodeIds = stageNodeIds ? stageNodeIds.split(",") : [];
    if (activeTab !== "nodes" || !nodeIds.length) {
      setStageDetails([]);
      setSelected(null);
      setStageDetailLoading(false);
      setStageDetailError(false);
      return;
    }
    let active = true;
    setStageDetailLoading(true);
    setStageDetailError(false);
    void (async () => {
      const responses = await Promise.allSettled(
        nodeIds.map((nodeId) => chainService.getChainNodeDetail(workspaceSlug, nodeId))
      );
      if (!active) return;
      const details = responses.flatMap((response) => (response.status === "fulfilled" ? [response.value] : []));
      setStageDetails(details);
      setSelected(details.find((detail) => detail.node.id === preferredNodeId) ?? details[0] ?? null);
      setStageDetailError(responses.some((response) => response.status === "rejected"));
      setStageDetailLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [activeTab, preferredNodeId, stageNodeIds, workspaceSlug]);

  const selectStage = useCallback(
    (stage: TResearchWorkflowStage) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", "nodes");
      nextParams.set("stage", stage.id);
      if (stage.preferredNodeId) nextParams.set("node", stage.preferredNodeId);
      else nextParams.delete("node");
      setSearchParams(nextParams);
    },
    [searchParams, setSearchParams]
  );

  const selectNode = useCallback(
    (nodeId: string) => {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set("tab", "nodes");
      if (selectedStage) nextParams.set("stage", selectedStage.id);
      nextParams.set("node", nodeId);
      setSearchParams(nextParams);
    },
    [searchParams, selectedStage, setSearchParams]
  );

  useEffect(() => {
    void memberStore.workspace.fetchWorkspaceMembers(workspaceSlug).catch(() => undefined);
  }, [memberStore, workspaceSlug]);

  const createNode = async () => {
    if (!nodeTitle.trim() || creating) return;
    setCreating(true);
    setActionError("");
    try {
      await chainService.createChainNode(workspaceSlug, chainId, {
        node_type: NODE_TYPE_BY_STAGE[selectedStage?.id ?? "literature_review"],
        title: nodeTitle.trim(),
        ...(selected ? { parent_node_id: selected.node.id, loop_iteration: selected.node.loop_iteration + 1 } : {}),
      });
      setNodeTitle("");
      setCreatingNodeInline(false);
      await load();
    } catch {
      setActionError(t("research.chains.action_failed"));
    } finally {
      setCreating(false);
    }
  };

  const transition = async (node: TResearchChainNode, action: TResearchChainNodeAction) => {
    if ((action === "FAIL" || action === "RETURN") && !reason.trim()) {
      setReasonAction(action);
      setActionError(t("research.chains.reason_required"));
      return false;
    }
    setTransitioning(node.id);
    setActionError("");
    try {
      await chainService.transitionChainNode(workspaceSlug, node.id, action, reason.trim() || undefined);
      setReasonAction(null);
      await load();
      return true;
    } catch {
      setActionError(t("research.chains.action_failed"));
      return false;
    } finally {
      setTransitioning(null);
    }
  };

  const requestTransition = (node: TResearchChainNode, action: TResearchChainNodeAction) => {
    if (action === "FAIL" || action === "RETURN") {
      setReasonAction(action);
      if (!reason.trim()) setActionError(t("research.chains.reason_required"));
      else setActionError("");
      return;
    }
    void transition(node, action);
  };

  const addMember = async () => {
    if (!memberUserId.trim() || memberBusy) return;
    setMemberBusy(true);
    setMemberError("");
    try {
      const updated = await chainService.addChainMember(
        workspaceSlug,
        chainId,
        memberUserId.trim(),
        memberRole === "20" ? 20 : 15
      );
      setMembers(updated);
      setMemberUserId("");
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.chains.member_added_title"),
        message: t("research.chains.member_added_message"),
      });
    } catch {
      setMemberError(t("research.chains.member_action_failed"));
    } finally {
      setMemberBusy(false);
    }
  };

  const removeMember = async (userId: string) => {
    if (memberBusy) return;
    setMemberBusy(true);
    setMemberError("");
    try {
      await chainService.removeChainMember(workspaceSlug, chainId, userId);
      setMembers((latestMembers) => latestMembers.filter((member) => member.user_id !== userId));
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.chains.member_removed_title"),
        message: t("research.chains.member_removed_message"),
      });
    } catch {
      setMemberError(t("research.chains.member_action_failed"));
    } finally {
      setMemberBusy(false);
    }
  };

  const workspaceMembers = memberStore.workspace
    .getWorkspaceMemberIds(workspaceSlug)
    .map((userId) => memberStore.getUserDetails(userId))
    .filter((member): member is NonNullable<typeof member> => !!member)
    .filter((member) => !memberStore.workspace.isUserSuspended(member.id, workspaceSlug))
    .map((member) => ({
      id: member.id,
      display_name: member.display_name,
      email: member.email,
      first_name: member.first_name,
      last_name: member.last_name,
    }));
  const tabs: Array<{ id: TChainTab; labelKey: string }> = [
    { id: "overview", labelKey: "research.chains.tabs.overview" },
    { id: "nodes", labelKey: "research.chains.tabs.nodes" },
    { id: "members", labelKey: "research.chains.tabs.members" },
  ];
  const selectedNodeActions = selected ? (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => assistant.openWithLocal(String(selected.node.id))}
        aria-label={t("research.chains.open_agent")}
        className="inline-flex h-8 items-center rounded-md border border-subtle px-3 text-12 font-medium text-secondary hover:bg-surface-1 hover:text-accent-primary"
      >
        {t("research.chains.open_agent")}
      </button>
      {selected.node.capabilities?.actions.delete?.allowed && (
        <ResearchDeleteButton
          name={selected.node.title}
          disabled={transitioning !== null}
          onDelete={async () => {
            await chainService.deleteChainNode(workspaceSlug, selected.node.id);
            const nextParams = new URLSearchParams(searchParams);
            nextParams.delete("node");
            setSearchParams(nextParams);
            await load();
          }}
        />
      )}
      {ACTIONS_BY_STATUS[selected.node.status]
        .filter(() => {
          const capability = selected.node.capabilities?.actions.transition;
          return capability ? capability.allowed : true;
        })
        .filter(
          (action) =>
            !(
              Object.values(NODE_TYPE_BY_STAGE).includes(selected.node.node_type) &&
              ["SUBMIT_REVIEW", "APPROVE", "RETURN"].includes(action)
            )
        )
        .map((action) => (
          <Button
            key={action}
            variant={action === "APPROVE" ? "primary" : "secondary"}
            size="base"
            disabled={transitioning === selected.node.id}
            onClick={() => requestTransition(selected.node, action)}
          >
            {t(`research.chains.action_${action.toLowerCase()}`)}
          </Button>
        ))}
      {selected.node.capabilities?.actions.transition && !selected.node.capabilities.actions.transition.allowed && (
        <span className="text-12 text-secondary" role="status">
          {selected.node.capabilities.actions.transition.reason}
        </span>
      )}
      {reasonAction && (
        <div
          role="dialog"
          data-reason-dialog=""
          aria-label={t("research.chains.reason_label")}
          className="fixed inset-0 z-40 flex items-center justify-center bg-backdrop p-4"
        >
          <div className="w-full max-w-md rounded-lg border border-subtle bg-surface-1 p-5 shadow-[0_8px_24px_rgba(37,37,34,0.16)]">
            <h3 className="mb-4 text-16 font-semibold text-primary">{t("research.chains.reason_label")}</h3>
            <label className="flex flex-col gap-1 text-11 text-tertiary">
              <span>{t("research.chains.reason_label")}</span>
              <input
                value={reason}
                aria-invalid={Boolean(actionError === t("research.chains.reason_required"))}
                aria-describedby="chain-reason-error"
                onChange={(event) => setReason(event.target.value)}
                className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
              />
              <span id="chain-reason-error" className="text-11 text-danger-primary">
                {actionError === t("research.chains.reason_required") ? actionError : ""}
              </span>
            </label>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={transitioning === selected.node.id}
                onClick={() => void transition(selected.node, reasonAction)}
              >
                {t("research.chains.confirm_reason")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setReasonAction(null)}>
                {t("research.chain_tasks.cancel_edit")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="space-y-2 p-5" role="status" aria-busy="true">
        {[0, 1].map((row) => (
          <Skeleton.Item key={row} height="48px" width="100%" />
        ))}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="flex h-full items-center justify-center p-5">
        <section className="w-full max-w-xl rounded-lg border border-subtle bg-surface-1 p-6 text-center" role="alert">
          <h2 className="text-16 font-medium text-primary">{t("research.common.permission_denied")}</h2>
        </section>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex h-full items-center justify-center p-5">
        <section className="w-full max-w-xl rounded-lg border border-subtle bg-surface-1 p-6 text-center" role="alert">
          <h2 className="text-16 font-medium text-primary">{t("research.status.load_failed.title")}</h2>
          <Button variant="secondary" size="sm" className="mt-4" onClick={() => void load()}>
            {t("research.chains.refresh")}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <section className="shrink-0 border-b border-subtle bg-surface-1 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-20 font-semibold text-primary">{chain?.project_name ?? chain?.project}</h3>
              <ResearchStatusBadge status={chain?.status}>
                {t(`research.chains.chain_status.${chain?.status.toLowerCase()}`)}
              </ResearchStatusBadge>
              <ResearchStatusBadge status="visibility">
                {t(`research.projects.chain_visibility.${chain?.visibility.toLowerCase()}`)}
              </ResearchStatusBadge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-tertiary">
              <span>
                {t("research.chains.owner")}: {chain?.owner_name ?? "-"}
              </span>
              <span>
                {t("research.chains.project_identifier")}: {chain?.project_identifier ?? chain?.project ?? "-"}
              </span>
              <span>
                {t("research.chains.org_unit")}: {chain?.org_unit_name ?? "-"}
              </span>
              <span>{chain ? formatResearchDateTime(chain.updated_at, currentLocale) : "-"}</span>
            </div>
            {current && (
              <div className="border-accent-primary mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-l-2 pl-3">
                <span className="text-11 text-tertiary">{t("research.chains.current_node")}</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-13 font-medium text-primary">{current.title}</span>
                  <ResearchStatusBadge status={current.status} size="sm">
                    {t(`research.chains.node_status.${current.status.toLowerCase()}`)}
                  </ResearchStatusBadge>
                </div>
              </div>
            )}
            {stageApprovalSummary && (
              <div className="mt-3 border-t border-subtle pt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-12 font-medium text-primary">
                    {t("research.chains.stage_approval.progress", {
                      approved: stageApprovalSummary.progress.approved,
                      total: stageApprovalSummary.progress.total,
                    })}
                  </p>
                  <p className="text-11 text-tertiary">
                    {[
                      {
                        label: t("research.chains.workflow.stage_status.awaiting_advisor"),
                        count: stageApprovalSummary.progress.awaiting_advisor,
                      },
                      {
                        label: t("research.chains.workflow.stage_status.awaiting_pi"),
                        count: stageApprovalSummary.progress.awaiting_pi,
                      },
                      {
                        label: t("research.chains.workflow.stage_status.needs_revision"),
                        count: stageApprovalSummary.progress.needs_revision,
                      },
                    ]
                      .filter((item) => item.count > 0)
                      .map((item) => `${item.label} ${item.count}`)
                      .join(" · ") || t("research.chains.stage_approval.no_pending")}
                  </p>
                </div>
                <div className="mt-2 h-1 w-full max-w-md overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full bg-accent-primary"
                    style={{
                      width: `${(stageApprovalSummary.progress.approved / stageApprovalSummary.progress.total) * 100}%`,
                    }}
                  />
                </div>
                <p className="mt-1.5 text-11 text-tertiary">{t("research.chains.stage_approval.completion_rule")}</p>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {chain?.capabilities?.actions.delete?.allowed && (
              <ResearchDeleteButton
                name={chain.project_name ?? chain.project}
                onDelete={async () => {
                  await research.deleteResearchProject(workspaceSlug, chain.project);
                  navigate(`/${workspaceSlug}/research/chains?view=projects`);
                }}
              />
            )}
            <Button variant="secondary" size="sm" className="h-8" onClick={() => void load()}>
              {t("research.chains.refresh")}
            </Button>
          </div>
        </div>
      </section>

      <ResearchChainWorkflowRail
        nodes={nodes}
        stageApprovals={stageApprovalSummary?.stages ?? []}
        currentNodeId={current?.id ?? null}
        selectedStageId={selectedStage?.id ?? null}
        onSelectStage={(stage) => {
          setReason("");
          selectStage(stage);
        }}
      />

      <nav
        aria-label={t("research.chains.tabs.label")}
        className="sticky top-0 z-10 shrink-0 overflow-x-auto border-b border-subtle bg-surface-1 px-5"
      >
        <TabNavigationList className="py-2">
          {tabs.map((tab) => (
            <ResearchTabLink
              key={tab.id}
              href={`/${workspaceSlug}/research/chains/${chainId}?tab=${tab.id}`}
              isActive={tab.id === activeTab}
            >
              {t(tab.labelKey)}
            </ResearchTabLink>
          ))}
        </TabNavigationList>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        {actionError && (
          <p
            className="mx-5 mt-4 rounded-md border border-danger-subtle bg-danger-subtle px-3 py-2 text-12 text-danger-primary"
            role="alert"
          >
            {actionError}
          </p>
        )}

        {activeTab === "overview" && (
          <section className="grid grid-cols-1 gap-4 p-5 md:grid-cols-2">
            <article className="rounded-lg border border-subtle bg-surface-1 p-4">
              <h4 className="text-13 font-semibold text-primary">{t("research.chains.overview.meta")}</h4>
              <dl className="mt-3 space-y-2 text-12">
                <div className="flex justify-between gap-3">
                  <dt className="text-tertiary">{t("research.chains.status")}</dt>
                  <dd className="text-primary">{t(`research.chains.chain_status.${chain?.status.toLowerCase()}`)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-tertiary">{t("research.chains.visibility")}</dt>
                  <dd className="text-primary">
                    {t(`research.projects.chain_visibility.${chain?.visibility.toLowerCase()}`)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-tertiary">{t("research.chains.updated_at")}</dt>
                  <dd className="text-primary">
                    {chain ? formatResearchDateTime(chain.updated_at, currentLocale) : "-"}
                  </dd>
                </div>
              </dl>
            </article>
            <article className="rounded-lg border border-subtle bg-surface-1 p-4">
              <h4 className="text-13 font-semibold text-primary">{t("research.chains.overview.node_summary")}</h4>
              <p className="mt-2 text-12 text-secondary">
                {t("research.chains.overview.node_count", { count: nodes.length })}
              </p>
              <p className="mt-1 text-12 text-secondary">
                {t("research.chains.overview.member_count", { count: members.length })}
              </p>
            </article>
          </section>
        )}

        {activeTab === "nodes" && (
          <section>
            {selectedStage && (
              <ResearchChainWorkflowStageDetail
                stage={selectedStage}
                nodes={stageNodes}
                details={stageDetails}
                selectedNodeId={selected?.node.id ?? null}
                loading={stageDetailLoading}
                error={stageDetailError}
                onSelectNode={(nodeId) => {
                  setReason("");
                  setReasonAction(null);
                  selectNode(nodeId);
                }}
                actionSlot={selectedNodeActions}
                createSlot={
                  <>
                    <button
                      type="button"
                      aria-label={t("research.chains.create_node_title")}
                      title={t("research.chains.create_node_title")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-12 font-medium text-secondary hover:bg-surface-1 hover:text-accent-primary"
                      onClick={() => {
                        setCreatingNodeInline(true);
                        setNodeTitle("");
                      }}
                    >
                      <span className="text-16 leading-none">+</span>
                      新增节点
                    </button>
                    {creatingNodeInline && (
                      <div className="fixed inset-0 z-40 flex items-center justify-center bg-backdrop p-4">
                        <form
                          role="dialog"
                          aria-modal="true"
                          aria-label={t("research.chains.create_node_title")}
                          className="w-full max-w-md rounded-lg border border-subtle bg-surface-1 p-5 shadow-[0_8px_24px_rgba(37,37,34,0.16)]"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void createNode();
                          }}
                        >
                          <label className="flex flex-col gap-1 text-12 text-secondary">
                            <span>{t("research.chains.node_title")}</span>
                            <input
                              value={nodeTitle}
                              onChange={(event) => setNodeTitle(event.target.value)}
                              placeholder={t("research.chains.node_title_placeholder")}
                              className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
                            />
                          </label>
                          <div className="mt-3 flex justify-end gap-2">
                            <Button
                              type="button"
                              variant="secondary"
                              size="base"
                              onClick={() => setCreatingNodeInline(false)}
                            >
                              {t("research.chain_tasks.cancel_edit")}
                            </Button>
                            <Button
                              variant="primary"
                              size="base"
                              type="submit"
                              disabled={!nodeTitle.trim() || creating}
                            >
                              {t("research.chains.create_node")}
                            </Button>
                          </div>
                        </form>
                      </div>
                    )}
                  </>
                }
                detailSlot={
                  selected ? (
                    <>
                      {selectedStageApproval && (
                        <ResearchChainStageApprovalPanel
                          key={selectedStageApproval.id}
                          workspaceSlug={workspaceSlug}
                          chainId={chainId}
                          stage={selectedStageApproval}
                          nodes={nodes}
                          preferredNodeId={preferredNodeId}
                          onChanged={() => void load()}
                        />
                      )}
                      <ResearchChainTaskPanel
                        workspaceSlug={workspaceSlug}
                        chainId={chainId}
                        nodeId={selected.node.id}
                      />
                      <ResearchChainKnowledgePanel
                        workspaceSlug={workspaceSlug}
                        chainId={chainId}
                        nodeId={selected.node.id}
                      />
                      {selected.node.node_type === "PAPER_WRITING" && (
                        <details className="border-t border-subtle">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-13 font-medium text-primary">
                            {t("research.paper_reviews.panel_title")}
                          </summary>
                          <ResearchPaperReviewPanel
                            workspaceSlug={workspaceSlug}
                            chainId={chainId}
                            nodeId={selected.node.id}
                            events={selected.events}
                          />
                        </details>
                      )}
                    </>
                  ) : null
                }
              />
            )}
          </section>
        )}

        {activeTab === "members" && (
          <section className="p-5">
            <ResearchFilterToolbar>
              <ResearchPersonSelect
                people={workspaceMembers}
                value={memberUserId}
                onChange={setMemberUserId}
                label={t("research.chains.members.user_id")}
              />
              <ListFilterField label={t("research.chains.members.role")}>
                <ListFilterSelect
                  value={memberRole}
                  onChange={(event) => setMemberRole(event.target.value as "15" | "20")}
                >
                  <option value="15">{t("research.chains.members.role_member")}</option>
                  <option value="20">{t("research.chains.members.role_admin")}</option>
                </ListFilterSelect>
              </ListFilterField>
              <Button
                variant="primary"
                size="xl"
                onClick={() => void addMember()}
                disabled={!memberUserId.trim() || memberBusy}
              >
                {t("research.chains.members.add")}
              </Button>
            </ResearchFilterToolbar>
            {memberError && (
              <p className="mt-3 text-12 text-danger-primary" role="alert">
                {memberError}
              </p>
            )}
            <div className="mt-4">
              <ResearchTableSurface>
                <Table className="min-w-120">
                  <TableHeader>
                    <TableRow>
                      <TableHead>成员</TableHead>
                      <TableHead>{t("research.chains.members.role")}</TableHead>
                      <TableHead className="text-right">{t("research.approvals.columns.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((member) => (
                      <TableRow key={member.user_id}>
                        <TableCell className="font-medium text-primary">{member.display_name}</TableCell>
                        <TableCell className="text-tertiary">{t(MEMBER_ROLE_LABELS[member.role])}</TableCell>
                        <TableCell className="text-right">
                          {!member.is_owner && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => void removeMember(member.user_id)}
                              disabled={memberBusy}
                            >
                              {t("research.chains.members.remove")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                    {!members.length && (
                      <TableRow>
                        <TableCell colSpan={3} className="py-3 text-secondary">
                          {t("research.chains.members.empty")}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ResearchTableSurface>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
