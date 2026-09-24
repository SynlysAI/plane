"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "react-router";
// plane imports
import { REPORT_STATUS_LABELS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Badge } from "@plane/propel/badge";
import { Button, getButtonStyling } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import { TabNavigationItem, TabNavigationList } from "@plane/propel/tab-navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import type {
  TExternalReference,
  TPeriodicReport,
  TResearchChain,
  TResearchChainEvent,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeAction,
  TResearchChainSnapshot,
} from "@plane/types";
// components
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { ResearchChainGraph } from "@/components/research/chains/research-chain-graph";
import { ResearchChainNodeDetail } from "@/components/research/chains/research-chain-node-detail";
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

type TNodeDetail = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
};

type TChainTab = "overview" | "nodes" | "reports" | "experiments" | "references" | "members" | "replay";

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

const STATUS_PRIORITY: Record<TResearchChainNode["status"], number> = {
  WAITING_HUMAN: 0,
  NEEDS_REVISION: 1,
  FAILED: 2,
  ACTIVE: 3,
  DRAFT: 4,
  COMPLETED: 5,
  ARCHIVED: 6,
};

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

/** Low-saturation Badge variants for chain and node status (Phase 5 extracts the shared dictionary). */
const CHAIN_STATUS_VARIANTS = {
  ACTIVE: "brand",
  COMPLETED: "success",
  ARCHIVED: "neutral",
} as const;

const NODE_STATUS_VARIANTS = {
  DRAFT: "neutral",
  ACTIVE: "brand",
  WAITING_HUMAN: "warning",
  NEEDS_REVISION: "danger",
  COMPLETED: "success",
  FAILED: "danger",
  ARCHIVED: "neutral",
} as const;

/** Pick the node that should stay visible in the fixed context bar. */
function currentNode(nodes: TResearchChainNode[]) {
  // eslint-disable-next-line unicorn/no-array-sort
  return [...nodes].sort(
    (left, right) =>
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
      new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  )[0];
}

/** Research Chain topic page with fixed context, tabs, graph, evidence and members. */
export const ResearchChainDetail = function ResearchChainDetail({ workspaceSlug, chainId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const memberStore = useMember();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as TChainTab | null;
  const requestedNodeId = searchParams.get("node");
  const activeTab: TChainTab = requestedTab ?? "nodes";
  const [chain, setChain] = useState<TResearchChain | null>(null);
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [members, setMembers] = useState<TResearchChainMember[]>([]);
  const [selected, setSelected] = useState<TNodeDetail | null>(null);
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
  const agentEnabled = Boolean(research.identity?.sections?.research_agent);

  const loadNodeDetail = useCallback(
    async (nodeId: string) => {
      try {
        setSelected(await chainService.getChainNodeDetail(workspaceSlug, nodeId));
      } catch {
        setSelected(null);
      }
    },
    [workspaceSlug]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    setSelected(null);
    try {
      const [chainDetail, chainNodes, chainMembers] = await Promise.all([
        chainService.getChain(workspaceSlug, chainId),
        chainService.getChainNodes(workspaceSlug, chainId),
        chainService.getChainMembers(workspaceSlug, chainId).catch(() => []),
      ]);
      setChain(chainDetail);
      setNodes(chainNodes);
      setMembers(chainMembers);
      const current = chainNodes.find((node) => node.id === requestedNodeId) ?? currentNode(chainNodes);
      if (current) await loadNodeDetail(current.id);
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setForbidden(errorCode === "research_permission_denied");
      setFailed(errorCode !== "research_permission_denied");
    } finally {
      setLoading(false);
    }
  }, [chainId, loadNodeDetail, requestedNodeId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

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
      setMembers((current) => current.filter((member) => member.user_id !== userId));
    } catch {
      setMemberError(t("research.chains.member_action_failed"));
    } finally {
      setMemberBusy(false);
    }
  };

  const current = useMemo(() => currentNode(nodes), [nodes]);
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
    { id: "replay", labelKey: "research.chains.tabs.replay" },
  ];

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
      <section className="sticky top-0 z-10 border-b border-subtle bg-surface-1 px-5 py-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-16 font-semibold text-primary">{chain?.project_name ?? chain?.project}</h3>
              <Badge variant={CHAIN_STATUS_VARIANTS[chain?.status ?? "ARCHIVED"] ?? "neutral"}>
                {t(`research.chains.chain_status.${chain?.status.toLowerCase()}`)}
              </Badge>
              <Badge variant="neutral">{t(`research.chains.visibility.${chain?.visibility.toLowerCase()}`)}</Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-tertiary">
              <span>
                {t("research.chains.owner")}: {chain?.owner_name ?? "-"}
              </span>
              <span>{chain ? new Date(chain.updated_at).toLocaleString() : "-"}</span>
            </div>
            {current && (
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-12 text-tertiary">{t("research.chains.current_node")}:</span>
                <Badge variant={NODE_STATUS_VARIANTS[current.status] ?? "neutral"}>
                  {t(`research.chains.node_status.${current.status.toLowerCase()}`)}
                </Badge>
                <span className="truncate text-13 font-medium text-primary">{current.title}</span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("research.chains.refresh")}
            </Button>
            {agentEnabled && current && (
              <Link
                href={`/${workspaceSlug}/research/chains/${chainId}/nodes/${current.id}/agent`}
                className={getButtonStyling("primary", "base")}
              >
                {t("research.chains.open_agent")}
              </Link>
            )}
          </div>
        </div>
      </section>

      <nav aria-label={t("research.chains.tabs.label")} className="overflow-x-auto border-b border-subtle px-5">
        <TabNavigationList className="py-2">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={`/${workspaceSlug}/research/chains/${chainId}?tab=${tab.id}`}
              aria-current={tab.id === activeTab ? "page" : undefined}
              className="whitespace-nowrap"
            >
              <TabNavigationItem isActive={tab.id === activeTab}>{t(tab.labelKey)}</TabNavigationItem>
            </Link>
          ))}
        </TabNavigationList>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
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
                  <dd className="text-primary">{chain ? new Date(chain.updated_at).toLocaleString() : "-"}</dd>
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
            <ResearchChainGraph
              nodes={nodes}
              selectedNodeId={selected?.node.id ?? null}
              onSelect={(nodeId) => {
                setReason("");
                void loadNodeDetail(nodeId);
              }}
            />
            {selected && (
              <>
                <div className="flex flex-wrap items-center gap-2 border-y border-subtle bg-surface-1 px-5 py-3">
                  {ACTIONS_BY_STATUS[selected.node.status].map((action) => (
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
                <ResearchChainNodeDetail {...selected} />
              </>
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
                        {new Date(report.updated_at).toLocaleString()}
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

        {activeTab === "replay" && selected && (
          <section className="p-5">
            <ResearchChainNodeDetail {...selected} />
            <ol className="mt-4 space-y-0 border-l border-subtle pl-4" role="list">
              {selected.events.map((event) => (
                <li key={event.event_id} className="relative py-2 pl-4">
                  <span className="bg-border-strong absolute top-4 -left-[21px] size-2 rounded-full" aria-hidden />
                  <p className="text-12 font-medium text-primary">{event.summary || event.event_type}</p>
                  <p className="mt-1 text-11 text-tertiary">
                    {new Date(event.occurred_at).toLocaleString()} · {event.actor_type}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  );
};
