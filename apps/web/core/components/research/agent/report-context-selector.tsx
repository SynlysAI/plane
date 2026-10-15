import { useEffect, useState } from "react";
import { ResearchAgentService } from "@/services/research/agent.service";
import type { TResearchAgentSessionApi } from "./use-research-agent-session";

const service = new ResearchAgentService();
type Option = { report_id: string; version_no: number; title: string; characters: number };

/** 选择当前课题可见正式报告，显示固定版本及读取失败原因。 */
export function ReportContextSelector({ api }: { api: TResearchAgentSessionApi }) {
  const [options, setOptions] = useState<Option[]>([]);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [refresh, setRefresh] = useState(0);
  const session = api.session;
  useEffect(() => {
    if (!session) return;
    let active = true;
    void service
      .getFormalReports(api.workspaceSlug, session.chain_node)
      .then((response) => {
        if (!active) return undefined;
        setOptions(response.results);
        setHint(response.association_hint);
        setError("");
        return undefined;
      })
      .catch(() => {
        if (active) setError("正式报告读取失败，请刷新或检查课题权限。");
      });
    return () => {
      active = false;
    };
  }, [session, api.workspaceSlug, refresh]);
  const total = options
    .filter((option) => api.reports?.some((item) => item.report_id === option.report_id))
    .reduce((sum, option) => sum + option.characters, 0);
  return (
    <details className="mb-3 border-b border-subtle pb-3 text-12">
      <summary className="cursor-pointer font-medium text-secondary">
        正式报告上下文 · {api.reports?.length ?? 0} 份
      </summary>
      <p className="mt-2 text-tertiary">{hint || "无项目报告需先关联当前课题。办公附件仅列元数据，尚未解析。"}</p>
      {options.map((option) => (
        <label key={option.report_id} className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            disabled={api.sending}
            checked={api.reports?.some((item) => item.report_id === option.report_id) ?? false}
            onChange={(event) =>
              api.setReports?.((current) =>
                event.target.checked
                  ? [...current, { report_id: option.report_id, version_no: option.version_no }]
                  : current.filter((item) => item.report_id !== option.report_id)
              )
            }
          />
          {option.title} · 正式版本 v{option.version_no} · {option.characters.toLocaleString()} 字符
        </label>
      ))}
      {!options.length && !error && <p className="mt-2 text-tertiary">当前课题没有可见正式报告。</p>}
      {(error || api.reportError) && (
        <p role="alert" className="mt-2 text-danger-primary">
          {api.reportError || error}
        </p>
      )}
      {total > 50000 && (
        <p role="alert" className="mt-2 text-danger-primary">
          正文超过 50,000 字符，请减少选择。
        </p>
      )}
      <button type="button" className="mt-2 text-secondary" onClick={() => setRefresh((value) => value + 1)}>
        刷新正式报告
      </button>
    </details>
  );
}
