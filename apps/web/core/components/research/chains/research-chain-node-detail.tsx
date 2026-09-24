"use client";

// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainEvent, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";

type Props = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
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

/** Six-section Chain node detail with append-only evidence and immutable snapshots. */
export function ResearchChainNodeDetail({ node, events, snapshots }: Props) {
  const { t } = useTranslation();
  const sections = buildSections(node, events, snapshots);

  return (
    <section
      className="overflow-hidden rounded-xl border border-subtle bg-surface-1"
      aria-label={t("research.chains.detail_title")}
    >
      <header className="border-b border-subtle px-4 py-3">
        <h3 className="text-14 font-semibold text-primary">{node.title}</h3>
        <p className="mt-1 text-12 text-secondary">
          {t(NODE_TYPE_LABELS[node.node_type] ?? "research.chains.node_types.unknown")} ·{" "}
          {t(`research.chains.node_status.${node.status.toLowerCase()}`)} · {new Date(node.updated_at).toLocaleString()}
        </p>
      </header>
      <div className="grid grid-cols-1 xl:grid-cols-2">
        {sections.map((section) => (
          <article
            key={section.key}
            className="border-b border-subtle p-4 last:border-b-0 xl:border-b-0 xl:border-l xl:first:border-l-0"
          >
            <h4 className="text-12 font-semibold text-primary">{t(`research.chains.sections.${section.key}`)}</h4>
            <p className="mt-0.5 text-11 text-tertiary">{t(`research.chains.sections.${section.key}_hint`)}</p>
            <ul className="mt-3 space-y-2" role="list">
              {section.items.length ? (
                [...new Set(section.items)].map((item) => (
                  <li
                    key={`${section.key}-${item}`}
                    className="border-b border-subtle pb-2 text-12 text-secondary last:border-0"
                  >
                    {item}
                  </li>
                ))
              ) : (
                <li className="text-12 text-tertiary">{t("research.chains.sections.empty")}</li>
              )}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
