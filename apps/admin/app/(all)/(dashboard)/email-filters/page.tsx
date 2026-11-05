import { useCallback, useEffect, useRef, useState } from "react";
import { useBeforeUnload, useBlocker } from "react-router";
import { Dialog } from "@headlessui/react";
import { Check, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@makeplane/propel/components/button";
import { Input } from "@makeplane/propel/components/input";
import { InputGroup } from "@makeplane/propel/elements/input";
import { Switch } from "@makeplane/propel/components/switch";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { InstanceService } from "@plane/services";
import type { TEmailRecipientFilterCheck, TEmailRecipientFilterPolicy, TEmailRecipientFilterRule } from "@plane/types";
import { PageWrapper } from "@/components/common/page-wrapper";
import { EmailFilterRuleModal } from "./rule-modal";
import { filterErrorMessage, filterFieldClass, filterIconButtonClass, hasFilterChanges } from "./helpers";

const service = new InstanceService();

/** 维护实例邮件屏蔽规则；页面草稿与已保存策略独立，检查不发送邮件。 */
export default function EmailFiltersPage() {
  const [saved, setSaved] = useState<TEmailRecipientFilterPolicy | null>(null);
  const [draft, setDraft] = useState<TEmailRecipientFilterPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<TEmailRecipientFilterRule | "new" | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [deleting, setDeleting] = useState<TEmailRecipientFilterRule | null>(null);
  const [email, setEmail] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [result, setResult] = useState<TEmailRecipientFilterCheck | null>(null);
  const requestVersion = useRef(0);
  const loadVersion = useRef(0);
  const dirty = hasFilterChanges(saved, draft);
  const blocker = useBlocker(dirty || editorDirty || saving);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (dirty || editorDirty || saving) {
          event.preventDefault();
          event.returnValue = "";
        }
      },
      [dirty, editorDirty, saving]
    )
  );

  /** 初始读取和手动重试使用同一入口，不在后台刷新时覆盖草稿。 */
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const policy = await service.emailRecipientFilters();
      if (loadVersion.current !== version) return;
      setSaved(policy);
      setDraft(policy);
    } catch (error) {
      if (loadVersion.current === version) setLoadError(filterErrorMessage(error, "加载邮箱过滤规则失败，请重试。"));
    } finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
      requestVersion.current += 1;
    };
  }, [load]);

  /** 草稿变化时清除旧检查结论，同时使尚未完成的检查响应失效。 */
  function updateDraft(next: TEmailRecipientFilterPolicy) {
    requestVersion.current += 1;
    setDraft(next);
    setResult(null);
    setCheckError("");
    setSaveError("");
    setNotice("");
  }

  /** 保存成功后使用后端规范化结果作为新的基线；失败保留全部草稿。 */
  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const policy = await service.updateEmailRecipientFilters(draft);
      setSaved(policy);
      updateDraft(policy);
      setNotice("已保存。下一次发送检查将使用新规则。");
    } catch (error) {
      setSaveError(filterErrorMessage(error, "保存失败，草稿已保留，请重试。"));
    } finally {
      setSaving(false);
    }
  }

  /** 检查提交时的草稿，输入或规则变化后不展示过期结论。 */
  async function check() {
    if (!draft) return;
    const version = ++requestVersion.current;
    setChecking(true);
    setCheckError("");
    setResult(null);
    try {
      const checked = await service.checkEmailRecipientFilters(email, draft);
      if (requestVersion.current === version) setResult(checked);
    } catch (error) {
      if (requestVersion.current === version) setCheckError(filterErrorMessage(error, "规则检查失败，请重试。"));
    } finally {
      setChecking(false);
    }
  }

  const filtered =
    draft?.rules.filter(
      (rule) =>
        (type === "all" || rule.type === type) &&
        (status === "all" || rule.enabled === (status === "enabled")) &&
        `${rule.value} ${rule.note}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
    ) ?? [];

  return (
    <PageWrapper
      customHeader={
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h1 className="text-24 font-semibold text-primary">邮箱过滤</h1>
            <p className="text-14 text-secondary">按邮箱或精确域名屏蔽实例发出的邮件。</p>
          </div>
          {draft && !loadError && (
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="email-filter-enabled" className="flex items-center gap-2 text-14 text-primary">
                <Switch
                  id="email-filter-enabled"
                  size="sm"
                  checked={draft.enabled}
                  disabled={saving}
                  onCheckedChange={(enabled) => updateDraft({ ...draft, enabled })}
                  aria-label="启用邮箱过滤"
                />
                {draft.enabled ? "过滤已开启" : "过滤已关闭"}
              </label>
              <Button
                variant="secondary"
                size="md"
                stretch="auto"
                label="取消"
                disabled={!dirty || saving}
                onClick={() => {
                  if (saved) updateDraft(saved);
                }}
              />
              <Button
                variant="primary"
                size="md"
                stretch="auto"
                label="保存更改"
                disabled={!dirty}
                loading={saving}
                onClick={() => void save()}
              />
            </div>
          )}
        </div>
      }
    >
      <div className="space-y-6 text-14 text-primary">
        {loading ? (
          <p role="status" className="py-10 text-secondary">
            正在加载邮箱过滤规则…
          </p>
        ) : loadError ? (
          <div role="alert" className="space-y-3 py-6">
            <p>{loadError}</p>
            <Button variant="secondary" size="md" stretch="auto" label="重新加载" onClick={() => void load()} />
          </div>
        ) : (
          draft && (
            <>
              <div className="space-y-1 text-12 leading-5 text-secondary">
                <p role="status">{dirty ? "有未保存更改 · 当前规则仅为草稿" : notice || "所有更改已保存"}</p>
                <p>规则适用于通知、账号验证、邀请、导出和测试邮件。关闭过滤后不再屏蔽任何收件人。</p>
                {!draft.enabled && <p>过滤总开关已关闭，规则会保留；重新开启并保存后恢复过滤。</p>}
              </div>
              {saveError && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 border-l-2 border-strong pl-3"
                >
                  <p>{saveError}</p>
                  <Button
                    variant="secondary"
                    size="md"
                    stretch="auto"
                    label="重试保存"
                    onClick={() => void save()}
                    loading={saving}
                  />
                </div>
              )}
              <section aria-labelledby="filter-rules-title" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="filter-rules-title" className="text-16 font-semibold">
                    屏蔽规则 <span className="font-normal ml-1 text-12 text-secondary">{draft.rules.length} 条</span>
                  </h2>
                  <Button
                    variant="secondary"
                    size="md"
                    stretch="auto"
                    icon={<Plus size={16} />}
                    label="添加规则"
                    disabled={saving}
                    onClick={() => setEditing("new")}
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1 basis-56">
                    <label className="mb-1.5 block text-12 text-secondary" htmlFor="email-filter-search">
                      搜索规则
                    </label>
                    <div className="relative">
                      <Search
                        aria-hidden
                        size={16}
                        className="pointer-events-none absolute top-2.5 left-3 text-tertiary"
                      />
                      <input
                        id="email-filter-search"
                        className={`${filterFieldClass} w-full pl-9`}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="搜索邮箱、域名或备注"
                      />
                    </div>
                  </div>
                  <label className="flex min-w-28 flex-col gap-1.5 text-12 text-secondary" htmlFor="email-filter-type">
                    类型
                    <select
                      id="email-filter-type"
                      className={filterFieldClass}
                      value={type}
                      onChange={(event) => setType(event.target.value)}
                    >
                      <option value="all">全部类型</option>
                      <option value="email">具体邮箱</option>
                      <option value="domain">域名</option>
                    </select>
                  </label>
                  <label
                    className="flex min-w-28 flex-col gap-1.5 text-12 text-secondary"
                    htmlFor="email-filter-status"
                  >
                    状态
                    <select
                      id="email-filter-status"
                      className={filterFieldClass}
                      value={status}
                      onChange={(event) => setStatus(event.target.value)}
                    >
                      <option value="all">全部状态</option>
                      <option value="enabled">已启用</option>
                      <option value="disabled">已停用</option>
                    </select>
                  </label>
                </div>
                <table
                  className="block w-full border-collapse text-left md:table md:table-fixed"
                  aria-label="邮箱过滤规则"
                >
                  <thead className="font-normal hidden border-b border-subtle text-12 text-secondary md:table-header-group">
                    <tr>
                      <th scope="col" className="w-24 py-3 pr-3 font-medium">
                        类型
                      </th>
                      <th scope="col" className="w-[30%] py-3 pr-3 font-medium">
                        邮箱或域名
                      </th>
                      <th scope="col" className="py-3 pr-3 font-medium">
                        备注
                      </th>
                      <th scope="col" className="w-28 py-3 pr-3 font-medium">
                        启用状态
                      </th>
                      <th scope="col" className="w-20 py-3 text-right font-medium">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="block md:table-row-group">
                    {filtered.map((rule) => (
                      <tr
                        key={rule.id}
                        className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 border-b border-subtle py-3 md:table-row md:hover:bg-layer-2"
                      >
                        <td className="self-center text-12 text-secondary md:py-3 md:pr-3">
                          {rule.type === "email" ? "具体邮箱" : "域名"}
                        </td>
                        <td className="col-start-1 row-start-2 min-w-0 break-all md:py-3 md:pr-3">{rule.value}</td>
                        <td className="col-start-1 row-start-3 min-w-0 text-12 break-words text-secondary md:py-3 md:pr-3">
                          {rule.note || "—"}
                        </td>
                        <td className="col-start-2 row-start-1 md:py-3 md:pr-3">
                          <label className="flex items-center gap-2 text-12 whitespace-nowrap">
                            <Switch
                              size="sm"
                              checked={rule.enabled}
                              disabled={saving}
                              aria-label={`${rule.enabled ? "停用" : "启用"} ${rule.value}`}
                              onCheckedChange={(enabled) =>
                                updateDraft({
                                  ...draft,
                                  rules: draft.rules.map((item) => (item.id === rule.id ? { ...item, enabled } : item)),
                                })
                              }
                            />
                            {rule.enabled ? "已启用" : "已停用"}
                          </label>
                        </td>
                        <td className="col-start-2 row-span-2 row-start-2 md:py-2">
                          <div className="flex justify-end">
                            <Tooltip label="编辑规则">
                              <button
                                type="button"
                                className={filterIconButtonClass}
                                aria-label={`编辑 ${rule.value}`}
                                disabled={saving}
                                onClick={() => setEditing(rule)}
                              >
                                <Pencil size={16} />
                              </button>
                            </Tooltip>
                            <Tooltip label="删除规则">
                              <button
                                type="button"
                                className={filterIconButtonClass}
                                aria-label={`删除 ${rule.value}`}
                                disabled={saving}
                                onClick={() => setDeleting(rule)}
                              >
                                <Trash2 size={16} />
                              </button>
                            </Tooltip>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && (
                  <div className="space-y-2 border-b border-subtle py-8 text-center text-secondary">
                    <p>{draft.rules.length ? "没有符合筛选条件的规则" : "尚无屏蔽规则"}</p>
                    {draft.rules.length ? (
                      <Button
                        variant="ghost"
                        size="md"
                        stretch="auto"
                        label="清除筛选"
                        onClick={() => {
                          setSearch("");
                          setType("all");
                          setStatus("all");
                        }}
                      />
                    ) : (
                      <p className="text-12">空列表不会屏蔽任何邮箱，可添加具体邮箱或域名。</p>
                    )}
                  </div>
                )}
                <p className="text-12 leading-5 text-secondary">
                  域名规则不包含子域名。删除或停用规则不会自动重发历史上已抑制的邮件。
                </p>
              </section>
              <section className="space-y-3 border-t border-subtle pt-5" aria-labelledby="filter-check-title">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 id="filter-check-title" className="text-16 font-semibold">
                    规则检查
                  </h2>
                  <p className="text-12 text-secondary">按当前草稿检查，不发送邮件。</p>
                </div>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void check();
                  }}
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <label htmlFor="email-filter-check" className="sr-only">
                      待检查邮箱
                    </label>
                    <InputGroup size="xl">
                      <Input
                        id="email-filter-check"
                        size="xl"
                        value={email}
                        onChange={(event) => {
                          requestVersion.current += 1;
                          setEmail(event.target.value);
                          setResult(null);
                          setCheckError("");
                        }}
                        placeholder="输入邮箱，例如 member@example.com"
                      />
                    </InputGroup>
                  </div>
                  <Button
                    type="submit"
                    variant="secondary"
                    size="md"
                    stretch="auto"
                    label="检查规则"
                    loading={checking}
                    disabled={!email.trim()}
                    icon={<Check size={16} />}
                  />
                </form>
                {checkError && <p role="alert">{checkError}</p>}
                {result && (
                  <p role="status" className="text-14 break-all">
                    {result.blocked
                      ? `将被屏蔽 · 命中${result.matched_rule?.type === "domain" ? "域名" : "邮箱"}规则：${result.matched_rule?.value}`
                      : `允许发送 · ${draft.enabled ? "未命中启用的规则" : "过滤总开关已关闭"}`}
                    <span className="ml-2 text-12 text-secondary">{result.email}</span>
                  </p>
                )}
              </section>
            </>
          )
        )}
      </div>
      {editing && draft && (
        <EmailFilterRuleModal
          onDirtyChange={setEditorDirty}
          policy={draft}
          rule={editing === "new" ? undefined : editing}
          service={service}
          onApply={(next) => {
            updateDraft(next);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} className="relative z-50">
        <div className="fixed inset-0 bg-backdrop" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="w-full max-w-md space-y-4 rounded-lg border border-subtle bg-surface-1 p-6 text-14 text-primary">
            <Dialog.Title className="text-16 font-semibold">删除规则</Dialog.Title>
            <Dialog.Description className="leading-6 break-all">
              确认从草稿中删除 {deleting?.value}？保存后生效，不会重发历史邮件。
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="md" stretch="auto" label="保留规则" onClick={() => setDeleting(null)} />
              <Button
                variant="primary"
                size="md"
                stretch="auto"
                label="删除规则"
                onClick={() => {
                  if (draft && deleting)
                    updateDraft({ ...draft, rules: draft.rules.filter((rule) => rule.id !== deleting.id) });
                  setDeleting(null);
                }}
              />
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
      <Dialog
        open={blocker.state === "blocked"}
        onClose={() => blocker.state === "blocked" && blocker.reset()}
        className="relative z-50"
      >
        <div className="fixed inset-0 bg-backdrop" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="w-full max-w-md space-y-4 rounded-lg border border-subtle bg-surface-1 p-6 text-14 text-primary">
            <Dialog.Title className="text-16 font-semibold">有未保存的更改</Dialog.Title>
            <Dialog.Description>
              {saving ? "正在保存，请完成保存后再离开。" : "离开将丢失邮箱过滤草稿。是否继续？"}
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                size="md"
                stretch="auto"
                label="继续编辑"
                onClick={() => blocker.state === "blocked" && blocker.reset()}
              />
              <Button
                variant="primary"
                size="md"
                stretch="auto"
                label="放弃并离开"
                disabled={saving}
                onClick={() => blocker.state === "blocked" && blocker.proceed()}
              />
            </div>
          </Dialog.Panel>
        </div>
      </Dialog>
    </PageWrapper>
  );
}

export const meta = () => [{ title: "邮箱过滤 - God Mode" }];
