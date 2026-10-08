import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { observer } from "mobx-react";
import {
  API_BASE_URL,
  OUTCOME_TYPES,
  OUTCOME_TYPE_LABELS,
  OUTCOME_STATUSES,
  OUTCOME_STATUS_LABELS,
} from "@plane/constants";
import type { TResearchOutcome } from "@plane/types";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";
import { ResearchOutcomeService } from "@/services/research/outcome.service";
import { useResearch } from "@/hooks/store/use-research";
import { useResearchBrowseQuery } from "@/components/research/common/browse-query";
import { ResearchBrowseFilters } from "@/components/research/common/browse-filters";

const service = new ResearchOutcomeService();
type Page = {
  results: TResearchOutcome[];
  next_cursor: string;
  prev_cursor: string;
  next_page_results: boolean;
  prev_page_results: boolean;
  create_projects: { id: string; name: string }[];
};

/** 报告入口中的成果视图，沿用项目成果登记与 ACL。 */
export const WorkspaceOutcomes = observer(function WorkspaceOutcomes({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const query = useResearchBrowseQuery("outcome_");
  const research = useResearch();
  const request = useRef(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("PAPER");
  const [status, setStatus] = useState("DRAFT");
  const [publishedAt, setPublishedAt] = useState("");
  const [venue, setVenue] = useState("");
  const [doi, setDoi] = useState("");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const queryString = new URLSearchParams(
    Array.from(query.params).flatMap(([key, value]) => (key.startsWith("outcome_") ? [[key.slice(8), value]] : []))
  ).toString();
  useEffect(() => {
    const version = ++request.current;
    setLoading(true);
    void service
      .get(`${API_BASE_URL}/api/research/workspaces/${workspaceSlug}/outcomes/?${queryString}`)
      .then((response) => {
        if (version !== request.current) return undefined;
        const data = response.data as Page;
        setPage(data);
        setError("");
        return undefined;
      })
      .catch((failure) => {
        if (version === request.current)
          setError(failure?.response?.status === 403 ? "权限不足" : "成果加载失败，请重试。");
      })
      .finally(() => {
        if (version === request.current) setLoading(false);
      });
    return () => {
      request.current += 1;
    };
  }, [workspaceSlug, queryString, refresh]);
  useEffect(() => {
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
  }, [research, workspaceSlug]);
  const selectStyle = "rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary";
  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto bg-canvas p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-16 font-semibold">成果</h2>
        <Button
          variant="primary"
          size="sm"
          disabled={!page?.create_projects.length}
          onClick={() => {
            setProject(page?.create_projects[0]?.id ?? "");
            setTitle("");
            setStatus("DRAFT");
            setPublishedAt("");
            setVenue("");
            setDoi("");
            setDialogError("");
            setDialog(true);
          }}
        >
          登记成果
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <select
          aria-label="课题组"
          className={selectStyle}
          value={query.get("org_unit")}
          onChange={(event) => query.set("org_unit", event.target.value)}
        >
          <option value="">全部课题组</option>
          {research.getOrgUnits(workspaceSlug).map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
        <ResearchBrowseFilters workspaceSlug={workspaceSlug} query={query} kind="outcomes" />
        <select
          aria-label="成果类型"
          className={selectStyle}
          value={query.get("output_type")}
          onChange={(event) => query.set("output_type", event.target.value)}
        >
          <option value="">全部类型</option>
          {OUTCOME_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(OUTCOME_TYPE_LABELS[value])}
            </option>
          ))}
        </select>
        <select
          aria-label="成果状态"
          className={selectStyle}
          value={query.get("status")}
          onChange={(event) => query.set("status", event.target.value)}
        >
          <option value="">全部状态</option>
          {OUTCOME_STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(OUTCOME_STATUS_LABELS[value])}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => setRefresh((value) => value + 1)}>
          刷新
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status" className="text-13 text-secondary">
          加载中
        </p>
      ) : !page?.results.length ? (
        <p className="text-13 text-secondary">{queryString ? "当前筛选无结果" : "尚无可见成果"}</p>
      ) : (
        <div className="max-w-full overflow-x-auto border-y border-subtle">
          <table className="w-full min-w-160 text-left text-13">
            <thead className="text-secondary">
              <tr>
                <th className="p-3">名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>期刊/会议</th>
                <th>发表/授权日期</th>
              </tr>
            </thead>
            <tbody>
              {page.results.map((outcome) => (
                <tr key={outcome.id} className="border-t border-subtle">
                  <td className="p-3">
                    <Link href={`/${workspaceSlug}/research/projects/${outcome.project}/outcomes`}>
                      {outcome.title}
                    </Link>
                  </td>
                  <td>{t(OUTCOME_TYPE_LABELS[outcome.output_type])}</td>
                  <td>{t(OUTCOME_STATUS_LABELS[outcome.status])}</td>
                  <td>{outcome.venue || "—"}</td>
                  <td>{outcome.published_at ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!page?.prev_page_results}
          onClick={() => query.set("cursor", page?.prev_cursor ?? "")}
        >
          上一页
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!page?.next_page_results}
          onClick={() => query.set("cursor", page?.next_cursor ?? "")}
        >
          下一页
        </Button>
      </div>
      <ModalCore isOpen={dialog} handleClose={() => !saving && setDialog(false)}>
        <form
          className="flex flex-col gap-4 bg-surface-1 p-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving || !project || !title.trim()) return;
            setSaving(true);
            try {
              await service.createOutcome(workspaceSlug, project, {
                title: title.trim(),
                output_type: type,
                status,
                published_at: publishedAt || null,
                venue: venue.trim(),
                doi: doi.trim(),
              });
              setDialog(false);
              setTitle("");
              setRefresh((value) => value + 1);
              setError("");
            } catch {
              setDialogError("成果登记失败，请检查项目权限后重试。");
            } finally {
              setSaving(false);
            }
          }}
        >
          <h3 className="text-16 font-semibold">登记成果</h3>
          <label>
            所属项目
            <select
              aria-label="所属项目"
              value={project}
              onChange={(event) => setProject(event.target.value)}
              className={`${selectStyle} w-full`}
            >
              {page?.create_projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            成果名称
            <input
              aria-label="成果名称"
              required
              maxLength={255}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={`${selectStyle} w-full`}
            />
          </label>
          <label>
            成果类型
            <select value={type} onChange={(event) => setType(event.target.value)} className={`${selectStyle} w-full`}>
              {OUTCOME_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(OUTCOME_TYPE_LABELS[value])}
                </option>
              ))}
            </select>
          </label>
          <label>
            成果状态
            <select
              aria-label="成果状态"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className={`${selectStyle} w-full`}
            >
              {OUTCOME_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(OUTCOME_STATUS_LABELS[value])}
                </option>
              ))}
            </select>
          </label>
          <label>
            发表/授权日期
            <input
              aria-label="发表/授权日期"
              type="date"
              value={publishedAt}
              onChange={(event) => setPublishedAt(event.target.value)}
              className={`${selectStyle} w-full`}
            />
          </label>
          <label>
            期刊/会议
            <input
              aria-label="期刊/会议"
              value={venue}
              onChange={(event) => setVenue(event.target.value)}
              className={`${selectStyle} w-full`}
            />
          </label>
          <label>
            DOI
            <input
              aria-label="DOI"
              value={doi}
              onChange={(event) => setDoi(event.target.value)}
              className={`${selectStyle} w-full`}
            />
          </label>
          {dialogError && (
            <p role="alert" className="text-13 text-danger-primary">
              {dialogError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDialog(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={saving || !title.trim()}>
              登记
            </Button>
          </div>
        </form>
      </ModalCore>
    </div>
  );
});
