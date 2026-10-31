import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { useTranslation } from "@plane/i18n";
import type { TResearchTodoEnvelope } from "@plane/types";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";

import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchBrowseRefresh } from "@/components/research/common/research-browse-toolbar";
import { ResearchTodoService } from "@/services/research/research-todo.service";

type Props = {
  workspaceSlug: string;
};

const todoService = new ResearchTodoService();

/** Split the stable todo title into a topic and localized stage name. */
function splitStageTitle(title: string): { topic: string; stage: string } {
  const separatorIndex = title.lastIndexOf(" · ");
  if (separatorIndex === -1) return { topic: title, stage: "-" };
  return { topic: title.slice(0, separatorIndex), stage: title.slice(separatorIndex + 3) };
}

/** Read the localized status label for one owner-facing chain stage. */
function businessStatusKey(status: string): string {
  if (status === "AWAITING_ADVISOR") return "research.approvals.my_chain_stage_status_advisor";
  if (status === "AWAITING_PI") return "research.approvals.my_chain_stage_status_pi";
  if (status === "NEEDS_REVISION") return "research.approvals.my_chain_stage_status_returned";
  if (status === "APPROVED") return "research.approvals.my_chain_stage_status_approved";
  return "research.common.status_unknown";
}

/** Read the owner-facing current-handler conclusion. */
function currentHandlerText(
  assignees: Array<{ display_name?: string | null }>,
  businessStatus: string,
  fallback: string
): string {
  if (businessStatus === "APPROVED") return fallback;
  return (
    assignees
      .map((assignee) => assignee.display_name)
      .filter(Boolean)
      .join("、") || "-"
  );
}

/** Read the stage label from a stable todo title. */
function stageTitle(title: string): string {
  return splitStageTitle(title).stage;
}

/** Read the topic label from a stable todo title. */
function topicTitle(title: string): string {
  return splitStageTitle(title).topic;
}

/** List the current owner's submitted chain stages without exposing review actions. */
export function MyChainStageSubmissions({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const [items, setItems] = useState<TResearchTodoEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  /** Load only the authenticated owner's stage submissions. */
  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const payload = await todoService.getResearchTodos(workspaceSlug, { scope: "mine", limit: 100 });
      setItems(payload.results.filter((item) => item.source === "CHAIN_STAGE_APPROVAL"));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex h-full flex-col overflow-hidden" aria-label={t("research.approvals.my_chain_stage")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-5 py-3">
        <p className="text-12 text-secondary">{t("research.approvals.my_chain_stage_description")}</p>
        <ResearchBrowseRefresh disabled={loading} onRefresh={() => void load()} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="text-12 text-tertiary" role="status">
            {t("research.common.loading")}
          </p>
        ) : failed ? (
          <div className="rounded-lg border border-dashed border-subtle p-6 text-center" role="alert">
            <p className="text-13 font-medium text-primary">{t("research.status.load_failed.title")}</p>
            <p className="mt-1 text-12 text-tertiary">{t("research.approvals.my_chain_stage_load_failed")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-subtle p-6 text-center" role="status">
            <p className="text-13 font-medium text-primary">{t("research.approvals.my_chain_stage_empty")}</p>
            <p className="mt-1 text-12 text-tertiary">{t("research.approvals.my_chain_stage_empty_description")}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-subtle bg-surface-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("research.approvals.my_chain_stage_topic")}</TableHead>
                  <TableHead>{t("research.approvals.my_chain_stage_stage")}</TableHead>
                  <TableHead>{t("research.approvals.my_chain_stage_status")}</TableHead>
                  <TableHead>{t("research.approvals.my_chain_stage_handler")}</TableHead>
                  <TableHead>{t("research.approvals.stage_queue_updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link to={item.href} className="text-13 font-medium text-primary hover:text-accent-primary">
                        {topicTitle(item.title)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-12 text-secondary">{stageTitle(item.title)}</TableCell>
                    <TableCell className="text-12 text-secondary">
                      {t(businessStatusKey(item.business_status))}
                    </TableCell>
                    <TableCell className="text-12 text-secondary">
                      {currentHandlerText(
                        item.assignees,
                        item.business_status,
                        t("research.approvals.my_chain_stage_status_done")
                      )}
                    </TableCell>
                    <TableCell className="text-12 text-tertiary">
                      {formatResearchDateTime(item.updated_at, currentLocale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
