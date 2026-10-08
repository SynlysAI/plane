import { useEffect } from "react";
import { observer } from "mobx-react";
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { useMember } from "@/hooks/store/use-member";
import { useResearchBrowseQuery } from "./browse-query";

type Query = ReturnType<typeof useResearchBrowseQuery>;

/** 将日期格式化为本地 YYYY-MM-DD 字符串。 */
const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** 报告、成果、项目与研究链复用范围、人员、关键词及日期预设。 */
export const ResearchBrowseFilters = observer(function ResearchBrowseFilters({
  workspaceSlug,
  query,
  kind,
}: {
  workspaceSlug: string;
  query: Query;
  kind: "reports" | "projects" | "outcomes";
}) {
  const members = useMember();
  useEffect(() => {
    void members.workspace.fetchWorkspaceMembers(workspaceSlug).catch(() => undefined);
  }, [members, workspaceSlug]);
  const people =
    members.workspace.getWorkspaceMemberIds(workspaceSlug)?.flatMap((id) => {
      const person = members.getUserDetails(id);
      return person ? [person] : [];
    }) ?? [];
  const scopes =
    kind === "projects"
      ? [
          ["all", "全部可见"],
          ["owned", "我负责"],
          ["participating", "我参与"],
        ]
      : kind === "reports"
        ? [
            ["all", "全部可见"],
            ["mine", "仅我创建"],
            ["review", "我需审核"],
          ]
        : [
            ["all", "全部可见"],
            ["mine", "仅我创建"],
          ];
  const style = "rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary";
  return (
    <>
      <select
        aria-label="范围"
        className={style}
        value={query.get("scope", query.get("mine") === "true" ? "mine" : "all")}
        onChange={(event) => query.patch({ scope: event.target.value, mine: "" })}
      >
        {scopes.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <ResearchPersonSelect
        label="责任人"
        value={query.get("owner")}
        people={people}
        onChange={(value) => query.set("owner", value)}
      />
      <label className="text-12 text-secondary">
        关键词
        <input
          aria-label="关键词"
          className={style}
          value={query.get("q")}
          maxLength={200}
          onChange={(event) => query.set("q", event.target.value)}
        />
      </label>
      <label className="text-12 text-secondary">
        日期
        <select
          aria-label="日期范围"
          className={style}
          value={query.get("date_preset", "any")}
          onChange={(event) => {
            const preset = event.target.value;
            const today = new Date();
            const start = new Date(today);
            start.setDate(start.getDate() - (preset === "7" ? 6 : 29));
            query.patch({
              date_preset: preset,
              date_from: ["7", "30"].includes(preset) ? toLocalDateString(start) : "",
              date_to: ["7", "30"].includes(preset) ? toLocalDateString(today) : "",
            });
          }}
        >
          <option value="any">任意</option>
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="custom">自定义区间</option>
        </select>
      </label>
      {query.get("date_preset") === "custom" && (
        <>
          <input
            aria-label="开始日期"
            type="date"
            className={style}
            value={query.get("date_from")}
            onChange={(event) => query.set("date_from", event.target.value)}
          />
          <input
            aria-label="结束日期"
            type="date"
            className={style}
            value={query.get("date_to")}
            onChange={(event) => query.set("date_to", event.target.value)}
          />
        </>
      )}
    </>
  );
});
