import { useEffect, useRef, useState } from "react";
import {
  type TWorkspaceNotificationCategory,
  type TWorkspaceNotificationPolicy,
  WorkspaceNotificationPolicyService,
} from "@/services/notification-policy.service";

type CategoryMetadata = {
  key: TWorkspaceNotificationCategory;
  label: string;
  description: string;
  emailAvailable: boolean;
};

const CATEGORY_GROUPS: Array<{ title: string; description: string; items: CategoryMetadata[] }> = [
  {
    title: "任务通知",
    description: "行政任务和项目协作产生的事件。",
    items: [
      { key: "property_change", label: "属性变更", description: "标题、日期、标签等字段更新", emailAvailable: true },
      { key: "state_change", label: "状态变更", description: "任务流转到未完成的其他状态", emailAvailable: true },
      { key: "completion", label: "任务完成", description: "任务进入完成状态", emailAvailable: true },
      { key: "assignment", label: "任务分派", description: "成员被加入或移出负责人", emailAvailable: true },
      { key: "comment", label: "任务评论", description: "任务下的新增与更新评论", emailAvailable: true },
      { key: "mention", label: "任务提及", description: "描述或评论中 @ 到成员", emailAvailable: true },
    ],
  },
  {
    title: "科研通知",
    description: "科研流程、报告与协作事件。",
    items: [
      {
        key: "research_property_change",
        label: "科研属性变更",
        description: "科研项目、阶段与任务的字段更新",
        emailAvailable: true,
      },
      {
        key: "research_state_change",
        label: "科研流程状态",
        description: "提交、退回、撤回等流程变化",
        emailAvailable: true,
      },
      { key: "research_completion", label: "科研完成", description: "验收通过或流程完成", emailAvailable: true },
      { key: "research_comment", label: "科研评论", description: "报告批注和反馈讨论", emailAvailable: true },
      { key: "research_mention", label: "科研提及", description: "科研内容中 @ 到成员", emailAvailable: true },
    ],
  },
  {
    title: "系统公告",
    description: "管理员在工作区发布的公告。",
    items: [
      {
        key: "system_announcement",
        label: "系统公告",
        description: "发布后进入成员通知中心",
        emailAvailable: false,
      },
    ],
  },
];

const service = new WorkspaceNotificationPolicyService();

/** Render workspace-level notification channel policies for administrators. */
export function WorkspaceNotificationSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const [policies, setPolicies] = useState<Record<string, TWorkspaceNotificationPolicy>>({});
  const [loading, setLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updateVersion = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    service
      .list(workspaceSlug)
      .then((response) => {
        if (!active) return null;
        setPolicies(Object.fromEntries(response.policies.map((policy) => [policy.category, policy])));
        return null;
      })
      .catch(() => {
        if (active) setError("通知策略加载失败，请稍后重试。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceSlug]);

  const updatePolicy = (
    category: TWorkspaceNotificationCategory,
    field: "in_app_enabled" | "email_enabled",
    enabled: boolean
  ) => {
    const version = ++updateVersion.current;
    setSavingCategory(category);
    setError(null);
    service
      .update(workspaceSlug, [{ category, [field]: enabled }])
      .then((response) => {
        if (version !== updateVersion.current) return null;
        setPolicies(Object.fromEntries(response.policies.map((policy) => [policy.category, policy])));
        return null;
      })
      .catch(() => {
        if (version !== updateVersion.current) return;
        setError("通知策略保存失败，已保留服务器上的当前设置。");
      })
      .finally(() => {
        if (version === updateVersion.current) setSavingCategory(null);
      });
  };

  return (
    <section className="space-y-6" aria-busy={loading} aria-live="polite">
      <header className="space-y-2">
        <h2 className="text-16 font-semibold">通知策略</h2>
        <p className="max-w-3xl text-13 leading-6 text-secondary">
          管理员策略决定各类通知是否生成。成员的个人偏好只能进一步收窄这里允许的范围；密码重置、邀请等账号安全邮件不在此处关闭。
        </p>
      </header>
      {loading ? (
        <p className="text-13 text-secondary">正在加载通知策略…</p>
      ) : (
        <div className="bg-surface divide-y divide-subtle rounded-xl border border-subtle">
          {CATEGORY_GROUPS.map((group) => (
            <section key={group.title} className="space-y-3 p-5">
              <div className="space-y-1">
                <h3 className="text-14 font-medium">{group.title}</h3>
                <p className="text-12 text-tertiary">{group.description}</p>
              </div>
              <div className="divide-y divide-subtle">
                {group.items.map((item) => {
                  const policy = policies[item.key];
                  const fixedMention = item.key === "mention" || item.key === "research_mention";
                  return (
                    <div
                      key={item.key}
                      className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="text-13 font-medium">{item.label}</p>
                        <p className="text-12 text-secondary">{item.description}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-5 text-13">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            name={`${item.key}-in-app`}
                            checked={fixedMention || (policy?.in_app_enabled ?? true)}
                            disabled={fixedMention || savingCategory === item.key}
                            onChange={(event) => updatePolicy(item.key, "in_app_enabled", event.target.checked)}
                          />
                          {fixedMention ? "站内（固定开启）" : "站内"}
                        </label>
                        {item.emailAvailable ? (
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              name={`${item.key}-email`}
                              checked={policy?.email_enabled ?? true}
                              disabled={savingCategory === item.key}
                              onChange={(event) => updatePolicy(item.key, "email_enabled", event.target.checked)}
                            />
                            邮件
                          </label>
                        ) : (
                          <span className="text-12 text-tertiary">邮件不适用</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
    </section>
  );
}
