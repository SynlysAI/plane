import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@headlessui/react";
import { X } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { Button } from "@makeplane/propel/components/button";
import { Input } from "@makeplane/propel/components/input";
import { InputGroup } from "@makeplane/propel/elements/input";
import { Switch } from "@makeplane/propel/components/switch";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import type { TEmailRecipientFilterPolicy, TEmailRecipientFilterRule } from "@plane/types";
import type { InstanceService } from "@plane/services";
import { filterErrorMessage, filterFieldClass, filterIconButtonClass } from "./helpers";
import type { TFilterValidationError } from "./helpers";

type Props = {
  policy: TEmailRecipientFilterPolicy;
  rule?: TEmailRecipientFilterRule;
  service: InstanceService;
  onApply: (policy: TEmailRecipientFilterPolicy) => void;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
};

/** 编辑或批量新增规则，全部候选项由后端统一校验后才进入页面草稿。 */
export function EmailFilterRuleModal({ policy, rule, service, onApply, onClose, onDirtyChange }: Props) {
  const [type, setType] = useState<TEmailRecipientFilterRule["type"]>(rule?.type ?? "email");
  const [value, setValue] = useState(rule?.value ?? "");
  const [note, setNote] = useState(rule?.note ?? "");
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [batch, setBatch] = useState(false);
  const initialInput = useRef<HTMLInputElement>(null);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<{ index: number; message: string }[]>([]);
  const values = useMemo(
    () => (batch ? value.split(/[\n;；]/) : [value]).map((item) => item.trim()).filter(Boolean),
    [batch, value]
  );
  const dirty =
    type !== (rule?.type ?? "email") ||
    value !== (rule?.value ?? "") ||
    note !== (rule?.note ?? "") ||
    enabled !== (rule?.enabled ?? true);

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  /** 弹窗关闭前保护正在编辑的输入，确认后返回页面草稿。 */
  function close() {
    if (!validating && (!dirty || window.confirm("放弃尚未加入草稿的规则修改？"))) onClose();
  }

  /** 修改输入后清除旧结果，避免将上一批错误标到新内容上。 */
  function resetErrors() {
    setError("");
    setIssues([]);
  }

  /** 通过无副作用的草稿检查接口校验，可显式选择只加入有效项。 */
  async function validateAndApply(validOnly = false) {
    if (!values.length) {
      setError("请输入至少一个邮箱或域名。");
      return;
    }
    const accepted = values
      .map((target, index) => ({ target, index }))
      .filter(({ index }) => !validOnly || !issues.some((issue) => issue.index === index));
    if (!accepted.length) return;
    const candidates = accepted.map(({ target }) => ({ id: rule?.id ?? uuidv4(), type, value: target, note, enabled }));
    const next = {
      ...policy,
      rules: rule
        ? policy.rules.map((item) => (item.id === rule.id ? candidates[0]! : item))
        : [...policy.rules, ...candidates],
    };
    setValidating(true);
    setError("");
    try {
      await service.checkEmailRecipientFilters("rule-validation@ai4ms.local", next);
      onApply(next);
    } catch (failure) {
      const detail = (failure as TFilterValidationError)?.detail;
      if (detail && typeof detail === "object" && Array.isArray(detail.rules)) {
        const offset = rule ? policy.rules.findIndex((item) => item.id === rule.id) : policy.rules.length;
        setIssues(
          detail.rules.map((item) => ({ index: accepted[item.index - offset]?.index ?? 0, message: item.message }))
        );
        setError("部分规则无效或重复，请逐项修正。有效项尚未加入草稿。");
      } else setError(filterErrorMessage(failure, "无法校验规则，请稍后重试。输入内容已保留。"));
    } finally {
      setValidating(false);
    }
  }

  return (
    <Dialog open onClose={close} initialFocus={initialInput} className="relative z-50">
      <div className="fixed inset-0 bg-backdrop" aria-hidden="true" />
      <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
        <div className="flex min-h-full items-center justify-center">
          <Dialog.Panel className="w-full max-w-xl rounded-lg border border-subtle bg-surface-1 p-5 text-14 text-primary shadow-raised-100 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <Dialog.Title className="text-16 font-semibold">{rule ? "编辑规则" : "添加规则"}</Dialog.Title>
              <Tooltip label="关闭">
                <button
                  type="button"
                  aria-label="关闭规则弹窗"
                  className={filterIconButtonClass}
                  onClick={close}
                  disabled={validating}
                >
                  <X size={16} />
                </button>
              </Tooltip>
            </div>
            <Dialog.Description className="mt-1 text-12 leading-5 text-secondary">
              修改将加入页面草稿，保存更改后才会生效。域名仅精确匹配，不包含子域名。
            </Dialog.Description>
            <form
              className="mt-5 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void validateAndApply();
              }}
            >
              <fieldset disabled={validating} className="space-y-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <label className="flex flex-col gap-1.5" htmlFor="filter-rule-type">
                    类型
                    <select
                      id="filter-rule-type"
                      value={type}
                      className={filterFieldClass}
                      onChange={(event) => {
                        setType(event.target.value as typeof type);
                        resetErrors();
                      }}
                    >
                      <option value="email">具体邮箱</option>
                      <option value="domain">域名</option>
                    </select>
                  </label>
                  {!rule && (
                    <label className="flex min-h-9 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={batch}
                        onChange={(event) => {
                          setBatch(event.target.checked);
                          setValue("");
                          resetErrors();
                        }}
                      />
                      批量添加
                    </label>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="filter-rule-value">
                    {batch ? "批量目标地址" : "目标地址"} <span className="text-secondary">（必填）</span>
                  </label>
                  {batch ? (
                    <textarea
                      id="filter-rule-value"
                      rows={6}
                      className={`${filterFieldClass} w-full resize-y`}
                      value={value}
                      aria-describedby="rule-target-hint"
                      onChange={(event) => {
                        setValue(event.target.value);
                        resetErrors();
                      }}
                      placeholder={
                        type === "email" ? "admin@ai4ms.local\nmember@example.com" : "example.com\n@ai4ms.local"
                      }
                    />
                  ) : (
                    <InputGroup size="xl">
                      <Input
                        id="filter-rule-value"
                        size="xl"
                        ref={initialInput}
                        value={value}
                        aria-describedby="rule-target-hint"
                        onChange={(event) => {
                          setValue(event.target.value);
                          resetErrors();
                        }}
                        placeholder={type === "email" ? "admin@ai4ms.local" : "example.com"}
                      />
                    </InputGroup>
                  )}
                  <p id="rule-target-hint" className="text-12 text-secondary">
                    {batch
                      ? `每行一条，也可用分号分隔；当前 ${values.length} 项。`
                      : type === "email"
                        ? "支持带显示名称的邮箱，匹配时忽略大小写与首尾空格。"
                        : "可带前导 @，不支持通配符或正则表达式。"}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="filter-rule-note">
                    备注 <span className="text-secondary">（可选）</span>
                  </label>
                  <InputGroup size="xl">
                    <Input
                      id="filter-rule-note"
                      size="xl"
                      maxLength={500}
                      value={note}
                      onChange={(event) => {
                        setNote(event.target.value);
                        resetErrors();
                      }}
                      placeholder="说明屏蔽原因"
                    />
                  </InputGroup>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="filter-rule-enabled">启用{batch ? "这些规则" : "此规则"}</label>
                  <Switch
                    id="filter-rule-enabled"
                    size="sm"
                    checked={enabled}
                    onCheckedChange={(checked) => {
                      setEnabled(checked);
                      resetErrors();
                    }}
                    aria-label="启用规则"
                  />
                </div>
              </fieldset>
              {error && (
                <div role="alert" className="space-y-2 text-14">
                  <p>{error}</p>
                  {issues.length > 0 && (
                    <ul className="max-h-40 space-y-1 overflow-y-auto text-12 text-secondary">
                      {issues.map((issue) => (
                        <li key={issue.index} className="break-all">
                          第 {issue.index + 1} 项 · {values[issue.index]}：{issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2 border-t border-subtle pt-4">
                <Button
                  variant="secondary"
                  size="md"
                  stretch="auto"
                  label="取消"
                  onClick={close}
                  disabled={validating}
                />
                {batch && issues.length > 0 && issues.length < values.length && (
                  <Button
                    variant="secondary"
                    size="md"
                    stretch="auto"
                    label={`仅添加 ${values.length - issues.length} 条有效规则`}
                    disabled={validating}
                    onClick={() => void validateAndApply(true)}
                  />
                )}
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  stretch="auto"
                  label={rule ? "更新草稿" : "加入草稿"}
                  loading={validating}
                />
              </div>
            </form>
          </Dialog.Panel>
        </div>
      </div>
    </Dialog>
  );
}
