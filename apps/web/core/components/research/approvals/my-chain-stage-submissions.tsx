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

/** Read the localized status label for one owner-facing chain stage. */
function businessStatusKey(status: string): string {
  if (["AWAITING_ADVISOR", "AWAITING_PI", "NEEDS_REVISION", "APPROVED"].includes(status)) {
    return `research.chains.workflow.stage_status.${status.toLowerCase()}`;
  }
  return "research.common.status_unknown";
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
                  <TableHead>{t("research.approvals.stage_queue_topic")}</TableHead>
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
                        {item.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-12 text-secondary">
                      {t(businessStatusKey(item.business_status))}
                    </TableCell>
                    <TableCell className="text-12 text-secondary">
                      {item.assignees.map((assignee) => assignee.display_name).join("、") || "-"}
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
