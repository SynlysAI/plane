import { useState } from "react";
import { observer } from "mobx-react";
import { Link, useParams, useSearchParams } from "react-router";
import { RESEARCH_SETTINGS_NAVIGATION_ITEMS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";
import { useResearch } from "@/hooks/store/use-research";
import { AdministrativeOrganizationSettings } from "@/components/administrative/organization-settings";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";
import { ProjectDomainsService, domainError } from "@/services/project-domains.service";

const service = new ProjectDomainsService();

/** 工作区级设置、行政管理、科研管理与反馈管理的统一入口。 */
export default observer(function WorkspaceManagementPage() {
  const { workspaceSlug } = useParams();
  const [params, setParams] = useSearchParams();
  const { context, error, retry } = useWorkspaceContext();
  const research = useResearch();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!context || !workspaceSlug) {
    return (
      <div className="p-5" role={error ? "alert" : "status"}>
        {error ? (
          <button type="button" onClick={retry}>
            配置加载失败，点击重试
          </button>
        ) : (
          "正在加载管理权限…"
        )}
      </div>
    );
  }
  if (!context.navigation?.management) return <p className="p-5">没有管理权限。</p>;

  const canManageFeedback = Boolean(
    context.user?.is_main_pi ||
    context.user?.is_research_admin ||
    context.user?.is_workspace_admin ||
    context.user?.is_system_admin
  );
  const tabs = [
    ...(context.navigation.workspace_settings ? [{ key: "workspace", label: "工作区设置" }] : []),
    ...(context.navigation.administrative_organizations ? [{ key: "administrative", label: "行政组织与审批" }] : []),
    ...(context.workspace_enabled &&
    context.capabilities?.nav.some((key) => RESEARCH_SETTINGS_NAVIGATION_ITEMS.some((item) => item.key === key))
      ? [{ key: "research", label: "科研管理" }]
      : []),
    ...(canManageFeedback ? [{ key: "feedback", label: t("research.nav.feedback") }] : []),
  ];
  const active = tabs.some((tab) => tab.key === params.get("tab")) ? params.get("tab") : tabs[0]?.key;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <h1 className="text-22 shrink-0 px-5 py-4 font-semibold">管理</h1>
      <nav className="flex shrink-0 gap-4 border-b border-subtle px-5" aria-label="管理分类">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.key}
            aria-current={active === tab.key ? "page" : undefined}
            className={`border-b-2 px-2 py-2 text-13 ${
              active === tab.key ? "border-accent-strong" : "border-transparent text-secondary"
            }`}
            onClick={() => setParams({ tab: tab.key })}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {active === "workspace" && (
        <div className="flex-1 overflow-auto p-5">
          <div className="space-y-4">
            <h2 className="text-16 font-medium">科研模块</h2>
            <p className="text-13 text-secondary">
              启用后，有科研权限的成员可使用科研项目。停用保留已有数据，行政项目继续可用。
            </p>
            {saveError && (
              <p role="alert" className="text-13 text-danger-primary">
                {saveError}
              </p>
            )}
            <label className="flex items-center gap-2 text-13">
              <input
                type="checkbox"
                checked={Boolean(context.workspace?.research_enabled)}
                disabled={saving || context.workspace?.purpose === "PI_PRIVATE"}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setSaving(true);
                  setSaveError(null);
                  void service
                    .setResearchEnabled(workspaceSlug, enabled)
                    .then(() => research.fetchIdentity(workspaceSlug))
                    .catch((cause) => setSaveError(domainError(cause)))
                    .finally(() => setSaving(false));
                }}
              />
              启用科研模块
            </label>
            {context.workspace?.purpose === "PI_PRIVATE" && (
              <p className="text-12 text-secondary">主 PI 私有工作区用于行政协作。</p>
            )}
            <Link to={`/${workspaceSlug}/settings/`} className="text-13 text-accent-primary">
              工作区成员与常规设置
            </Link>
          </div>
        </div>
      )}
      {active === "administrative" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <AdministrativeOrganizationSettings key={workspaceSlug} workspaceSlug={workspaceSlug} />
        </div>
      )}
      {active === "research" && (
        <div className="flex-1 overflow-auto p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {RESEARCH_SETTINGS_NAVIGATION_ITEMS.filter((item) => context.capabilities?.nav.includes(item.key)).map(
              (item) => (
                <Link
                  className="rounded border border-subtle p-4 text-13 hover:bg-surface-2"
                  key={item.key}
                  to={`/${workspaceSlug}/research/${item.path}`}
                >
                  {t(item.labelKey)}
                </Link>
              )
            )}
          </div>
        </div>
      )}
      {active === "feedback" && canManageFeedback && (
        <div className="min-h-0 flex-1 overflow-hidden">
          <FeedbackDialog workspaceSlug={workspaceSlug} managementOnly />
        </div>
      )}
    </div>
  );
});
