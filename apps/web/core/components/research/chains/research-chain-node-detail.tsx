"use client";

// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainEvent, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
import { formatResearchDateTime } from "@/components/research/common/research-format";

type Props = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
  embedded?: boolean;
};

export type TNodeEvidenceSummary = {
  recordCount: number;
  emptyCount: number;
  emptyKeys: TNodeSection["key"][];
};

type TNodeSection = {
  key: "input" | "ai_action" | "intermediate" | "validation" | "human_decision" | "output";
  items: string[];
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

/** Normalize event type codes before matching evidence sections. */
function eventType(value: string) {
  return value.toUpperCase();
}

/** Convert an event reference to a human-readable label without dumping JSON. */
function referenceLabel(reference: Record<string, unknown>) {
  const title = reference.title ?? reference.name ?? reference.display_name;
  if (typeof title === "string" && title.trim()) return title;
  const identity = reference.id ?? reference.knowledge_id ?? reference.external_id;
  return typeof identity === "string" ? identity : "";
}

/** Build the six evidence sections required by the Phase 1 UX prototype. */
function buildSections(
  _node: TResearchChainNode,
  events: TResearchChainEvent[],
  snapshots: TResearchChainSnapshot[]
): TNodeSection[] {
  const byTypes = (...values: string[]) =>
    events.filter((event) => values.some((value) => eventType(event.event_type).includes(value)));
  const references = events.flatMap((event) => event.refs.map(referenceLabel).filter(Boolean));
  const decisions = byTypes("HUMAN_DECISION", "APPROVAL").map((event) => event.summary || event.event_type);
  const validations = byTypes("VALIDATION").map((event) => event.summary || event.event_type);
  const outputs = byTypes("OUTPUT", "DATA_CHANGE").map((event) => event.summary || event.event_type);

  return [
    {
      key: "input",
      items: [...new Set(references)].slice(0, 8),
    },
    {
      key: "ai_action",
      items: byTypes("AI_ACTION", "TOOL_CALL")
        .map((event) => event.summary || event.event_type)
        .slice(0, 8),
    },
    {
      key: "intermediate",
      items: byTypes("INTERMEDIATE_ARTIFACT")
        .map((event) => event.summary || event.event_type)
        .slice(0, 8),
    },
    {
      key: "validation",
      items: [
        ...validations.slice(0, 6),
        ...snapshots.flatMap((snapshot) => snapshot.source_versions.map((item) => referenceLabel(item))).slice(0, 4),
      ].filter(Boolean),
    },
    {
      key: "human_decision",
      items: decisions.length ? decisions.slice(0, 8) : [],
    },
    {
      key: "output",
      items: outputs.length ? outputs.slice(0, 8) : snapshots.map((snapshot) => snapshot.summary).slice(0, 8),
    },
  ];
}

/**
 * 统计六段证据的记录数和空项，供工作台计数使用。
 *
 * Args:
 *   node: 当前研究节点。
 *   events: 节点事件。
 *   snapshots: 节点快照。
 *
 * Returns:
 *   非空记录数、空项数和空项键。
 */
export function summarizeNodeEvidence(
  node: TResearchChainNode,
  events: TResearchChainEvent[],
  snapshots: TResearchChainSnapshot[]
): TNodeEvidenceSummary {
  const sections = buildSections(node, events, snapshots);
  return {
    recordCount: sections.reduce((sum, section) => sum + new Set(section.items).size, 0),
    emptyCount: sections.filter((section) => section.items.length === 0).length,
    emptyKeys: sections.filter((section) => section.items.length === 0).map((section) => section.key),
  };
}

/** 六段节点证据。嵌入 Peek 时不再重复节点标题。 */
export function ResearchChainNodeDetail({ node, events, snapshots, embedded = false }: Props) {
  const { t, currentLocale } = useTranslation();
  const sections = buildSections(node, events, snapshots);
  const visibleSections = sections.filter((section) => section.items.length);
  const emptySections = sections.filter((section) => !section.items.length);

  return (
    <section aria-label={t("research.chains.detail_title")}>
      {!embedded && (
        <header className="border-b border-subtle px-4 py-3">
          <h3 className="text-14 font-semibold text-primary">
            {node.title}
            <span className="font-normal ml-2 text-12 text-secondary">
              {t(NODE_TYPE_LABELS[node.node_type] ?? "research.chains.node_types.unknown")} ·{" "}
              {t(`research.chains.node_status.${node.status.toLowerCase()}`)} ·{" "}
              {formatResearchDateTime(node.updated_at, currentLocale)}
            </span>
          </h3>
        </header>
      )}
      {visibleSections.map((section) => (
        <details key={section.key} className="border-b border-subtle">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5">
            <h4 className="text-12 font-medium text-primary">{t(`research.chains.sections.${section.key}`)}</h4>
            <span className="font-normal text-11 text-tertiary">{section.items.length}</span>
          </summary>
          <div className="border-t border-subtle px-4 py-3">
            <p className="text-11 text-tertiary">{t(`research.chains.sections.${section.key}_hint`)}</p>
            <ul className="mt-2 space-y-2" role="list">
              {[...new Set(section.items)].map((item) => (
                <li key={`${section.key}-${item}`} className="text-12 text-secondary">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </details>
      ))}
      {emptySections.length > 0 && (
        <details className="border-b border-subtle">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5">
            <h4 className="text-12 font-medium text-tertiary">{t("research.chains.sections.empty_group")}</h4>
            <span className="font-normal text-11 text-tertiary">{emptySections.length}</span>
          </summary>
          <ul className="space-y-1 border-t border-subtle px-4 py-3 text-11 text-tertiary" role="list">
            {emptySections.map((section) => (
              <li key={`${section.key}-empty`}>{t(`research.chains.sections.${section.key}`)}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
