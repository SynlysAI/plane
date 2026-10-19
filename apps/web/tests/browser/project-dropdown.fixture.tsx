import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TranslationProvider, setLanguage } from "@plane/i18n";
import { EModalWidth, ModalCore } from "@plane/ui";
import { ProjectDropdownBase } from "@/components/dropdowns/project/base";
// oxlint-disable-next-line import/no-unassigned-import -- Use application styles for browser verification.
import "../../styles/globals.css";

const projects = {
  first: { id: "first", name: "公共项目测试" },
  second: { id: "second", name: "设备采购" },
  third: { id: "third", name: "日常办公" },
};

function Fixture() {
  const [projectId, setProjectId] = useState("first");
  return (
    <ModalCore isOpen width={EModalWidth.XXL}>
      <form className="space-y-5 p-5" onSubmit={(event) => event.preventDefault()}>
        <h1 className="text-18 font-medium">创建新工作项</h1>
        <div className="h-7">
          <ProjectDropdownBase
            value={projectId}
            onChange={setProjectId}
            multiple={false}
            buttonVariant="border-with-text"
            projectIds={Object.keys(projects)}
            getProjectById={(id) => projects[id as keyof typeof projects]}
          />
        </div>
        <input aria-label="工作项标题" className="w-full border border-subtle p-2" defaultValue="待创建工作项" />
        <div className="h-48 border border-subtle" />
        <output data-testid="selected-project">{projectId}</output>
        <button type="button">放弃</button>
      </form>
    </ModalCore>
  );
}

await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>
  </TranslationProvider>
);
