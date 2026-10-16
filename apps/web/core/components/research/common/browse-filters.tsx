import { useEffect } from "react";
import type { ReactNode } from "react";
import { observer } from "mobx-react";
import { ListFilterField, ListFilterInput, ListFilterSelect } from "@plane/ui";
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { useMember } from "@/hooks/store/use-member";
import { useResearchBrowseQuery } from "./browse-query";

type Query = ReturnType<typeof useResearchBrowseQuery>;

function BrowseField({
  label,
  appearance,
  children,
  className,
  legacyLabel = true,
}: {
  label: string;
  appearance: "default" | "list";
  children: ReactNode;
  className?: string;
  legacyLabel?: boolean;
}) {
  if (appearance === "list")
    return (
      <ListFilterField label={label} className={className}>
        {children}
      </ListFilterField>
    );
  return legacyLabel ? (
    <label className="text-12 text-secondary">
      {label}
      {children}
    </label>
  ) : (
    <>{children}</>
  );
}

/** 将日期格式化为本地 YYYY-MM-DD 字符串。 */
const toLocalDateString = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** 报告、成果、项目与研究链复用范围、人员、关键词及日期预设。 */
export const ResearchBrowseFilters = observer(function ResearchBrowseFilters({
  workspaceSlug,
  query,
  kind,
  appearance = "list",
}: {
  workspaceSlug: string;
  query: Query;
  kind: "reports" | "projects" | "outcomes";
  appearance?: "default" | "list";
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
  const Select = appearance === "list" ? ListFilterSelect : "select";
  const Input = appearance === "list" ? ListFilterInput : "input";
  const controlStyle = appearance === "list" ? undefined : style;
  return (
    <>
      <BrowseField label="范围" appearance={appearance} legacyLabel={false}>
        <Select
          aria-label="范围"
          className={controlStyle}
          value={query.get("scope", query.get("mine") === "true" ? "mine" : "all")}
          onChange={(event) => query.patch({ scope: event.target.value, mine: "" })}
        >
          {scopes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </BrowseField>
      <ResearchPersonSelect
        label="责任人"
        value={query.get("owner")}
        people={people}
        onChange={(value) => query.set("owner", value)}
        appearance={appearance}
      />
      <BrowseField label="关键词" appearance={appearance} className="w-full sm:w-44">
        <Input
          aria-label="关键词"
          className={controlStyle}
          placeholder={appearance === "list" ? "搜索关键词" : undefined}
          value={query.get("q")}
          maxLength={200}
          onChange={(event) => query.set("q", event.target.value)}
        />
      </BrowseField>
      <BrowseField label="日期" appearance={appearance}>
        <Select
          aria-label="日期范围"
          className={controlStyle}
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
        </Select>
      </BrowseField>
      {query.get("date_preset") === "custom" && (
        <>
          <BrowseField label="开始日期" appearance={appearance} legacyLabel={false} className="sm:w-36">
            <Input
              aria-label="开始日期"
              type="date"
              className={controlStyle}
              value={query.get("date_from")}
              onChange={(event) => query.set("date_from", event.target.value)}
            />
          </BrowseField>
          <BrowseField label="结束日期" appearance={appearance} legacyLabel={false} className="sm:w-36">
            <Input
              aria-label="结束日期"
              type="date"
              className={controlStyle}
              value={query.get("date_to")}
              onChange={(event) => query.set("date_to", event.target.value)}
            />
          </BrowseField>
        </>
      )}
    </>
  );
});
