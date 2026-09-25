"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
// plane imports
import { REPORT_STATUS_LABELS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import { TabNavigationList } from "@plane/propel/tab-navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import type {
  TExternalReference,
  TPeriodicReport,
  TResearchChain,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeAction,
} from "@plane/types";
// components
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { pickCurrentNode } from "@/components/research/chains/research-selection";
import { ResearchAgentSidePanel } from "@/components/research/agent/research-agent-side-panel";
import { ResearchChainWorkflowRail } from "@/components/research/chains/research-chain-workflow-rail";
import { ResearchChainKnowledgePanel } from "@/components/research/chains/research-chain-knowledge-panel";
import {
  buildResearchWorkflow,
  type TResearchWorkflowStage,
} from "@/components/research/chains/research-chain-workflow";
import {
  ResearchChainWorkflowStageDetail,
  type TResearchChainStageNodeDetail,
} from "@/components/research/chains/research-chain-workflow-stage-detail";
import { ExperimentList } from "@/components/research/experiments/experiment-list";
import { OutcomeList } from "@/components/research/outcomes/outcome-list";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchIntegrationService } from "@/services/research/integration.service";
import { ResearchReportService } from "@/services/research/report.service";

const chainService = new ResearchChainService();
const integrationService = new ResearchIntegrationService();
const reportService = new ResearchReportService();

type Props = {
  workspaceSlug: string;
  chainId: string;
};

type TChainTab = "overview" | "nodes" | "reports" | "experiments" | "references" | "members";
type TRequestedChainTab = TChainTab | "replay";

const ACTIONS_BY_STATUS: Record<TResearchChainNode["status"], TResearchChainNodeAction[]> = {
  DRAFT: ["START", "ARCHIVE"],
  ACTIVE: ["SUBMIT_REVIEW", "FAIL", "ARCHIVE"],
  WAITING_HUMAN: ["APPROVE", "RETURN"],
  NEEDS_REVISION: ["START", "ARCHIVE"],
  FAILED: ["START", "ARCHIVE"],
  COMPLETED: ["ARCHIVE"],
  ARCHIVED: [],
};

const NODE_TYPE_OPTIONS = [
  "RESEARCH",
  "LITERATURE_REVIEW",
  "TOPIC_EVALUATION",
  "PRE_EXPERIMENT",
  "PLAN",
  "OPENING",
  "EXPERIMENT",
  "ANALYSIS",
  "ITERATION",
  "SUMMARY",
  "PAPER_WRITING",
  "COMPLETION",
  "TRANSFER",
] as const;

const NODE_TYPE_LABELS: Record<string, string> = {
  RESEARCH: "research.chains.node_types.research",
  LITERATURE_REVIEW: "research.chains.node_types.literature_review",
  TOPIC_EVALUATION: "research.chains.node_types.topic_evaluation",
  PRE_EXPERIMENT: "research.chains.node_types.pre_experiment",
  PLAN: "research.chains.node_types.plan",
  OPENING: "research.chains.node_types.opening",
  EXPERIMENT: "research.chains.node_types.experiment",
  ANALYSIS: "research.chains.node_types.analysis",
  ITERATION: "research.chains.node_types.iteration",
  SUMMARY: "research.chains.node_types.summary",
  PAPER_WRITING: "research.chains.node_types.paper_writing",
  COMPLETION: "research.chains.node_types.completion",
  TRANSFER: "research.chains.node_types.transfer",
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
  const memberStore = useMember();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as TRequestedChainTab | null;
  const requestedNodeId = searchParams.get("node");
  const activeTab: TChainTab = requestedTab === "replay" ? "nodes" : (requestedTab ?? "nodes");
  const [chain, setChain] = useState<TResearchChain | null>(null);
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [members, setMembers] = useState<TResearchChainMember[]>([]);
  const [stageDetails, setStageDetails] = useState<TResearchChainStageNodeDetail[]>([]);
  const [selected, setSelected] = useState<TResearchChainStageNodeDetail | null>(null);
  const [stageDetailLoading, setStageDetailLoading] = useState(false);
  const [stageDetailError, setStageDetailError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [nodeType, setNodeType] = useState("LITERATURE_REVIEW");
  const [nodeTitle, setNodeTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"15" | "20">("15");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [contextReports, setContextReports] = useState<TPeriodicReport[] | null>(null);
  const [contextReferences, setContextReferences] = useState<TExternalReference[] | null>(null);
  const [contextError, setContextError] = useState(false);
  const [agentNodeId, setAgentNodeId] = useState<string | null>(null);
  const agentEnabled = Boolean(research.identity?.sections?.research_agent);
  const current = useMemo(() => pickCurrentNode(nodes), [nodes]);
  const workflow = useMemo(() => buildResearchWorkflow(nodes, current?.id ?? null), [current, nodes]);
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

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    setStageDetails([]);
    setSelected(null);
    setStageDetailError(false);
    try {
      const [chainDetail, chainNodes, chainMembers] = await Promise.all([
        chainService.getChain(workspaceSlug, chainId),
        chainService.getChainNodes(workspaceSlug, chainId),
        chainService.getChainMembers(workspaceSlug, chainId).catch(() => []),
      ]);
      setChain(chainDetail);
      setNodes(chainNodes);
      setMembers(chainMembers);
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

  useEffect(() => {
    if (!chain || (activeTab !== "reports" && activeTab !== "references")) return;
    let active = true;
    setContextError(false);
    void (async () => {
      try {
        const reports = await reportService.getReports(workspaceSlug, { per_page: "100" });
        const references = await integrationService.getReferences(workspaceSlug);
        if (!active) return;
        setContextReports(
          reports.results.filter(
            (report) => report.project === chain.project || report.team_projects?.includes(chain.project)
          )
        );
        setContextReferences(
          references.results.filter(
            (reference) =>
              reference.links?.some((link) => link.target_id === chain.project) ||
              reference.metadata?.chain_id === chain.id ||
              reference.metadata?.project === chain.project
          )
        );
      } catch {
        if (active) {
          setContextError(true);
          setContextReports([]);
          setContextReferences([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [activeTab, chain, workspaceSlug]);

  const createNode = async () => {
    if (!nodeTitle.trim() || creating) return;
    setCreating(true);
    setActionError("");
    try {
      await chainService.createChainNode(workspaceSlug, chainId, {
        node_type: nodeType,
        title: nodeTitle.trim(),
      });
      setNodeTitle("");
      await load();
    } catch {
      setActionError(t("research.chains.action_failed"));
    } finally {
      setCreating(false);
    }
  };

  const transition = async (node: TResearchChainNode, action: TResearchChainNodeAction) => {
    if ((action === "FAIL" || action === "RETURN") && !reason.trim()) {
      setActionError(t("research.chains.reason_required"));
      return;
    }
    setTransitioning(node.id);
    setActionError("");
    try {
      await chainService.transitionChainNode(workspaceSlug, node.id, action, reason.trim() || undefined);
      await load();
    } catch {
      setActionError(t("research.chains.action_failed"));
    } finally {
      setTransitioning(null);
    }
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
    { id: "reports", labelKey: "research.chains.tabs.reports" },
    { id: "experiments", labelKey: "research.chains.tabs.experiments" },
    { id: "references", labelKey: "research.chains.tabs.references" },
    { id: "members", labelKey: "research.chains.tabs.members" },
  ];
  const selectedNodeActions = selected ? (
    <div className="flex flex-wrap items-center gap-2 bg-surface-1 px-5 py-3">
      {ACTIONS_BY_STATUS[selected.node.status]
        .filter(() => {
          const capability = selected.node.capabilities?.actions.transition;
          return capability ? capability.allowed : true;
        })
        .map((action) => (
          <Button
            key={action}
            variant={action === "APPROVE" ? "primary" : "secondary"}
            size="sm"
            disabled={transitioning === selected.node.id}
            onClick={() => void transition(selected.node, action)}
          >
            {t(`research.chains.action_${action.toLowerCase()}`)}
          </Button>
        ))}
      {selected.node.capabilities?.actions.transition && !selected.node.capabilities.actions.transition.allowed && (
        <span className="text-12 text-secondary" role="status">
          {selected.node.capabilities.actions.transition.reason}
        </span>
      )}
      <span className="bg-border-subtle mx-1 h-5 w-px" aria-hidden="true" />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set("tab", "references");
          nextParams.set("node", selected.node.id);
          setSearchParams(nextParams);
        }}
      >
        {t("research.chains.open_knowledge")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set("tab", "reports");
          nextParams.set("node", selected.node.id);
          setSearchParams(nextParams);
        }}
      >
        {t("research.chains.open_reports")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.set("tab", "experiments");
          nextParams.set("node", selected.node.id);
          setSearchParams(nextParams);
        }}
      >
        {t("research.chains.open_experiments")}
      </Button>
      {agentEnabled && (
        <Button variant="secondary" size="sm" onClick={() => setAgentNodeId(selected.node.id)}>
          {t("research.chains.open_agent")}
        </Button>
      )}
      {(selected.node.status === "ACTIVE" || selected.node.status === "WAITING_HUMAN") && (
        <label className="flex flex-1 flex-col gap-1 text-11 text-tertiary">
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
      <section className="shrink-0 border-b border-subtle bg-surface-1 px-5 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-20 font-semibold text-primary">{chain?.project_name ?? chain?.project}</h3>
              <ResearchStatusBadge status={chain?.status}>
                {t(`research.chains.chain_status.${chain?.status.toLowerCase()}`)}
              </ResearchStatusBadge>
              <ResearchStatusBadge status="visibility">
                {t(`research.chains.visibility.${chain?.visibility.toLowerCase()}`)}
              </ResearchStatusBadge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-tertiary">
              <span>
                {t("research.chains.owner")}: {chain?.owner_name ?? "-"}
              </span>
              <span>{chain ? formatResearchDateTime(chain.updated_at, currentLocale) : "-"}</span>
            </div>
            {current && (
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
                <span className="text-11 text-tertiary">{t("research.chains.current_node")}</span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-13 font-medium text-primary">{current.title}</span>
                  <ResearchStatusBadge status={current.status} size="sm">
                    {t(`research.chains.node_status.${current.status.toLowerCase()}`)}
                  </ResearchStatusBadge>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("research.chains.refresh")}
            </Button>
            {agentEnabled && research.canSee("research_chain") && current && (
              <Button variant="primary" size="base" onClick={() => setAgentNodeId(current.id)}>
                {t("research.chains.open_agent")}
              </Button>
            )}
          </div>
        </div>
      </section>

      <ResearchChainWorkflowRail
        nodes={nodes}
        currentNodeId={current?.id ?? null}
        selectedStageId={selectedStage?.id ?? null}
        onSelectStage={(stage) => {
          setReason("");
          selectStage(stage);
        }}
      />

      <nav
        aria-label={t("research.chains.tabs.label")}
        className="shrink-0 overflow-x-auto border-b border-subtle bg-surface-1 px-5"
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

      {agentNodeId && (
        <ResearchAgentSidePanel
          workspaceSlug={workspaceSlug}
          chainNodeId={agentNodeId}
          onClose={() => setAgentNodeId(null)}
        />
      )}

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
                  <dd className="text-primary">{t(`research.chains.visibility.${chain?.visibility.toLowerCase()}`)}</dd>
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
                  selectNode(nodeId);
                }}
                actionSlot={selectedNodeActions}
              />
            )}
            <section className="border-t border-subtle p-5">
              <h4 className="text-13 font-semibold text-primary">{t("research.chains.create_node_title")}</h4>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
                <label className="flex flex-col gap-1 text-12 text-secondary">
                  <span>{t("research.chains.node_type")}</span>
                  <select
                    value={nodeType}
                    onChange={(event) => setNodeType(event.target.value)}
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
                  >
                    {NODE_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>
                        {t(NODE_TYPE_LABELS[type])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-12 text-secondary">
                  <span>{t("research.chains.node_title")}</span>
                  <input
                    value={nodeTitle}
                    onChange={(event) => setNodeTitle(event.target.value)}
                    placeholder={t("research.chains.node_title_placeholder")}
                    className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary"
                  />
                </label>
                <Button
                  variant="primary"
                  size="lg"
                  className="mt-auto"
                  onClick={() => void createNode()}
                  disabled={!nodeTitle.trim() || creating}
                >
                  {t("research.chains.create_node")}
                </Button>
              </div>
            </section>
          </section>
        )}

        {activeTab === "reports" && chain && (
          <section className="p-5">
            <p className="text-11 text-tertiary">{t("research.chains.context_filter")}</p>
            {contextError && (
              <p className="mt-3 text-12 text-secondary" role="alert">
                {t("research.chains.context_load_failed")}
              </p>
            )}
            {contextReports && (
              <Table className="mt-4">
                <caption className="sr-only">{t("research.chains.tabs.reports")}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("research.chains.context.report_period")}</TableHead>
                    <TableHead>{t("research.chains.status")}</TableHead>
                    <TableHead className="text-right">{t("research.chains.updated_at")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {contextReports.map((report) => (
                    <TableRow key={report.id}>
                      <TableCell className="font-medium text-primary">{report.period_key}</TableCell>
                      <TableCell className="text-secondary">{t(REPORT_STATUS_LABELS[report.status])}</TableCell>
                      <TableCell className="text-right text-tertiary tabular-nums">
                        {formatResearchDateTime(report.updated_at, currentLocale)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!contextReports.length && (
                    <TableRow>
                      <TableCell colSpan={3} className="py-3 text-secondary">
                        {t("research.chains.context.report_empty")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
            <div className="mt-6">
              <h4 className="text-13 font-semibold text-primary">{t("research.chains.tabs.reports")}</h4>
              <OutcomeList workspaceSlug={workspaceSlug} projectId={chain.project} />
            </div>
          </section>
        )}

        {activeTab === "experiments" && chain && (
          <ExperimentList workspaceSlug={workspaceSlug} projectId={chain.project} />
        )}

        {activeTab === "references" && (
          <section className="p-5">
            <p className="text-11 text-tertiary">{t("research.chains.context.external_hint")}</p>
            {current && (
              <div className="mt-4">
                <ResearchChainKnowledgePanel workspaceSlug={workspaceSlug} chainId={chainId} nodeId={current.id} />
              </div>
            )}
            <ul className="mt-4 divide-y divide-subtle rounded-lg border border-subtle bg-surface-1" role="list">
              {(contextReferences ?? []).map((reference) => (
                <li key={reference.id} className="px-4 py-3">
                  <p className="text-12 font-medium text-primary">{reference.title}</p>
                  <p className="mt-1 text-11 text-tertiary">{reference.summary || reference.system}</p>
                  {reference.source_url && (
                    <a
                      href={reference.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-11 text-accent-primary"
                    >
                      {t("research.chains.context.open_source")}
                    </a>
                  )}
                </li>
              ))}
              {contextReferences?.length === 0 && (
                <li className="px-4 py-3 text-12 text-secondary">{t("research.chains.context.external_empty")}</li>
              )}
            </ul>
          </section>
        )}

        {activeTab === "members" && (
          <section className="p-5">
            <div className="flex flex-wrap items-end gap-3">
              <ResearchPersonSelect
                people={workspaceMembers}
                value={memberUserId}
                onChange={setMemberUserId}
                label={t("research.chains.members.user_id")}
              />
              <label className="flex flex-col gap-1 text-12 text-secondary">
                <span>{t("research.chains.members.role")}</span>
                <select
                  value={memberRole}
                  onChange={(event) => setMemberRole(event.target.value as "15" | "20")}
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-2 text-12 text-primary"
                >
                  <option value="15">{t("research.chains.members.role_member")}</option>
                  <option value="20">{t("research.chains.members.role_admin")}</option>
                </select>
              </label>
              <Button
                variant="primary"
                size="lg"
                onClick={() => void addMember()}
                disabled={!memberUserId.trim() || memberBusy}
              >
                {t("research.chains.members.add")}
              </Button>
            </div>
            {memberError && (
              <p className="mt-3 text-12 text-danger-primary" role="alert">
                {memberError}
              </p>
            )}
            <Table className="mt-4">
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
                    <TableCell className="py-3 text-secondary">{t("research.chains.members.empty")}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
    </div>
  );
};
