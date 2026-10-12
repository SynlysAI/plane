/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { ResearchBackLink } from "@/components/research/common/research-back-link";
import { ResearchTodoEnvelopeList } from "@/components/research/common/research-todo-index";

/** 跨组件待办中心：承接首页待办卡片的“查看全部”入口，展示完整聚合列表。 */
function WorkspaceResearchTodosPage() {
  const { workspaceSlug } = useParams();
  const { t } = useTranslation();
  if (!workspaceSlug) return null;

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-5 px-6 py-8">
      <ResearchBackLink href={`/${workspaceSlug}`}>{t("research.home_workbench.title")}</ResearchBackLink>
      <ResearchTodoEnvelopeList workspaceSlug={workspaceSlug} />
    </div>
  );
}

export default observer(WorkspaceResearchTodosPage);
