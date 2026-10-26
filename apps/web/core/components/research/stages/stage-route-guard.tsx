/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Spinner } from "@plane/ui";
import { ResearchProjectService, type TResearchProject } from "@/services/research/project.service";
import { getResearchErrorKey } from "@/components/research/common/error-messages";

type Props = {
  workspaceSlug: string;
  projectId: string;
  children: ReactNode;
};

const projectService = new ResearchProjectService();

/** 旧四阶段路由守卫：研究链项目重定向到课题概览，旧培养项目继续渲染阶段工作台。 */
export function ResearchStageRouteGuard({ workspaceSlug, projectId, children }: Props) {
  const { t } = useTranslation();
  const [project, setProject] = useState<TResearchProject | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setProject(null);
    setError(null);
    void (async () => {
      try {
        const value = await projectService.getProject(workspaceSlug, projectId);
        if (active) setProject(value);
      } catch (cause: unknown) {
        if (active) setError(cause);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, workspaceSlug]);

  if (error) {
    return (
      <p role="alert" className="p-5 text-13 text-danger-primary">
        {t(getResearchErrorKey(error))}
      </p>
    );
  }
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (project.research?.chain_kind === "RESEARCH_CHAIN" && project.research.chain_id) {
    return <Navigate replace to={`/${workspaceSlug}/research/chains/${project.research.chain_id}?tab=overview`} />;
  }
  return <>{children}</>;
}
