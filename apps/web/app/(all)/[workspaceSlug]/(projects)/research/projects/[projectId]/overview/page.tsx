import { useEffect, useState } from "react";
import { useParams, Link, Navigate, useSearchParams } from "react-router";
import { ResearchProjectService, type TResearchProject } from "@/services/research/project.service";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ProjectAuthWrapper } from "@/layouts/auth-layout/project-wrapper";
import { ProjectLayoutRoot } from "@/components/issues/issue-layouts/roots/project-layout-root";
import { PagesListRoot } from "@/components/pages/list/root";
import { EPageStoreType } from "@/hooks/store";
import { ResearchProjectNav } from "@/components/research/navigation/research-project-nav";
import { domainError } from "@/services/project-domains.service";

const service = new ResearchProjectService();
export default function ResearchProjectOverviewPage() {
  const { workspaceSlug, projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const detailTab = params.get("detail") ?? "overview";
  const [project, setProject] = useState<TResearchProject | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setProject(null); setError(null);
    if (workspaceSlug && projectId) void service.getProject(workspaceSlug, projectId).then((value) => { if (active) setProject(value); }).catch((cause) => { if (active) setError(domainError(cause)); });
    return () => { active = false; };
  }, [workspaceSlug, projectId]);
  if (!workspaceSlug || !projectId) return null;
  if (project?.research?.chain_id) return <Navigate replace to={`/${workspaceSlug}/research/chains/${project.research.chain_id}`} />;
  return <ResearchPageShell titleKey="research.nav.research_chain_v2" section="stages">
    <div className="h-full overflow-auto"><ResearchProjectNav workspaceSlug={workspaceSlug} projectId={projectId} />
      <nav aria-label="历史科研项目内容" className="flex gap-4 border-b border-subtle px-5 py-2">
        {[{ key: "overview", label: "概览" }, { key: "tasks", label: "任务" }, { key: "pages", label: "资料页面" }].map((tab) => <button key={tab.key} type="button" className="text-13" aria-current={detailTab === tab.key ? "page" : undefined} onClick={() => setParams({ detail: tab.key })}>{tab.label}</button>)}
      </nav>
      {detailTab !== "overview" && project && <ProjectAuthWrapper workspaceSlug={workspaceSlug} projectId={projectId}><div className="h-[70vh]">
        {detailTab === "tasks" ? <ProjectLayoutRoot /> : <PagesListRoot pageType="public" storeType={EPageStoreType.PROJECT} />}
      </div></ProjectAuthWrapper>}
      {detailTab === "overview" && <div className="space-y-4 p-5">{error ? <p role="alert">{error}</p> : !project ? <p role="status">正在加载科研项目…</p> : <>
        <h1 className="text-22 font-semibold">{project.name}</h1>
        <p className="text-13 text-secondary">历史科研项目 · {project.research?.workflow_status}</p>
        <p className="text-13 text-secondary">该项目继续使用已有阶段与资料流程。</p>
        <div className="flex flex-wrap gap-4 text-13">
          <Link className="text-accent-primary" to={`/${workspaceSlug}/research/projects/${projectId}/stages`}>阶段与评审</Link>
          <Link className="text-accent-primary" to={`/${workspaceSlug}/research/chains?view=reports&project_id=${projectId}`}>项目报告</Link>
          <Link className="text-accent-primary" to={`/${workspaceSlug}/research/projects/${projectId}/timeline`}>项目动态</Link>
          <Link className="text-accent-primary" to={`/${workspaceSlug}/research/projects/${projectId}/outcomes`}>论文与成果</Link>
        </div>
      </>}</div>}
    </div>
  </ResearchPageShell>;
}
