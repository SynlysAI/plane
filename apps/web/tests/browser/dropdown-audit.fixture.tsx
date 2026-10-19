import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { runInAction } from "mobx";
import { MemoryRouter, Route, Routes } from "react-router";
import { TranslationProvider, setLanguage } from "@plane/i18n";
import { EModalWidth, ModalCore, CustomSelect } from "@plane/ui";
import { EEstimateSystem } from "@plane/types";
import { StoreProvider, store } from "@/lib/store-context";
import { Estimate } from "@/store/estimates/estimate";
import { EstimateDropdown } from "@/components/dropdowns/estimate";
import { WorkItemStateDropdownBase } from "@/components/dropdowns/intake-state/base";
import { DateDropdown } from "@/components/dropdowns/date";
import { DateRangeDropdown } from "@/components/dropdowns/date-range";
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { ProjectMultiSelectModal } from "@/components/project/multi-select-modal";
import { ExistingIssuesListModal } from "@/components/core/modals/existing-issues-list-modal";
import { AdministrativeOrganizationManager } from "@/components/research/navigation/administrative-organization-manager";
import { ResearchNavigationService } from "@/services/research/navigation.service";
// oxlint-disable-next-line import/no-unassigned-import -- Verify actual styles and stacking inside dialogs.
import "../../styles/globals.css";

const scenario = new URLSearchParams(window.location.search).get("scenario") ?? "estimate";
const issue = {
  id: "issue-1",
  name: "采购申请",
  project_id: "project-1",
  project__identifier: "EQ",
  sequence_id: 1,
} as never;
const states = {
  pending: { id: "pending", name: "待处理", group: "pending", color: "#999999" },
  accepted: { id: "accepted", name: "已接受", group: "accepted", color: "#00aa55" },
};
runInAction(() => {
  store.projectRoot.project.projectMap["project-1"] = {
    id: "project-1",
    name: "设备采购",
    identifier: "EQ",
    logo_props: {},
  } as never;
  store.projectEstimate.estimates["estimate-1"] = new Estimate(store, {
    id: "estimate-1",
    name: "Points",
    project: "project-1",
    last_used: true,
    type: EEstimateSystem.POINTS,
    points: [{ id: "point-1", estimate: "estimate-1", value: "5", key: 1 }],
  } as never);
});
ResearchNavigationService.prototype.getAssignableAdministrativeOrganizationMembers = async () => [
  { id: "user-1", name: "Alice", email: "alice@example.test" },
];
ResearchNavigationService.prototype.addAdministrativeOrganizationMember = async () => ({}) as never;

function Fixture() {
  const [value, setValue] = useState<string | undefined>();
  const [date, setDate] = useState<Date | null>(null);
  const [range, setRange] = useState<{ from: Date | undefined; to: Date | undefined }>({
    from: undefined,
    to: undefined,
  });
  const [submitted, setSubmitted] = useState("");
  const result = <output data-testid="result">{submitted}</output>;
  if (scenario === "projects")
    return (
      <>
        {result}
        <ProjectMultiSelectModal
          isOpen
          onClose={() => {}}
          projectIds={["project-1"]}
          selectedProjectIds={[]}
          onSubmit={async (ids) => setSubmitted(ids.join(","))}
        />
      </>
    );
  if (scenario === "members")
    return (
      <>
        {result}
        <AdministrativeOrganizationManager
          action="members"
          organizationId="org"
          workspaceSlug="lab"
          organizations={[{ id: "org", name: "Office", members: [] } as never]}
          onClose={() => {}}
          onUpdated={async () => setSubmitted("added")}
        />
      </>
    );
  if (scenario === "related")
    return (
      <>
        {result}
        <ExistingIssuesListModal
          isOpen
          workspaceSlug="lab"
          projectId="project-1"
          handleClose={() => {}}
          handleOnSubmit={async (items) => setSubmitted(items.map((item) => item.id).join(","))}
          searchParams={{}}
          workspaceLevelToggle
          workItemSearchServiceCallback={async () => [issue]}
        />
      </>
    );
  return (
    <ModalCore isOpen width={EModalWidth.XXL}>
      <div className="space-y-5 p-5">
        <h1 className="text-18">下拉控件验收</h1>
        <div className="h-8">
          {scenario === "estimate" && (
            <EstimateDropdown
              projectId="project-1"
              value={value}
              onChange={setValue}
              buttonVariant="border-with-text"
              placeholder="工作量估算"
            />
          )}
          {scenario === "intake" && (
            <WorkItemStateDropdownBase
              projectId="project-1"
              value={value}
              onChange={setValue}
              stateIds={Object.keys(states)}
              getStateById={(id) => states[id as keyof typeof states] as never}
              buttonVariant="border-with-text"
            />
          )}
          {scenario === "date" && (
            <DateDropdown value={date} onChange={setDate} placeholder="选择日期" buttonVariant="border-with-text" />
          )}
          {scenario === "range" && (
            <DateRangeDropdown
              value={range}
              onSelect={(next) => setRange({ from: next?.from, to: next?.to })}
              buttonVariant="border-with-text"
            />
          )}
          {scenario === "custom" && (
            <CustomSelect value={value} onChange={setValue} label="普通选项">
              <CustomSelect.Option value="first">选项一</CustomSelect.Option>
              <CustomSelect.Option value="second">选项二</CustomSelect.Option>
            </CustomSelect>
          )}
          {scenario === "person" && (
            <ResearchPersonSelect
              label="负责人"
              value={value ?? ""}
              onChange={setValue}
              people={[{ id: "user-1", display_name: "Alice", email: "alice@example.test" }]}
            />
          )}
        </div>
        <output data-testid="value">{value ?? (date ? date.toISOString() : range.from?.toISOString())}</output>
        <input aria-label="工作项标题" defaultValue="采购申请" className="w-full border border-subtle p-2" />
        <div className="h-48" />
        <button type="button">关闭</button>
      </div>
    </ModalCore>
  );
}

await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/lab"]}>
        <Routes>
          <Route path="/:workspaceSlug" element={<Fixture />} />
        </Routes>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
