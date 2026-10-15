import { useState } from "react";
import type { TAccountProvisioningOptions, TUserImportBatch } from "@plane/types";
import { Button } from "@plane/propel/button";
import { ListFilterField, ListFilterInput, ListFilterSelect } from "@plane/ui";
import { ResearchPersonSelect } from "@/components/research/common/person-select";
import { ResearchAccountService } from "@/services/research/account.service";

const service = new ResearchAccountService();
export function SingleImportForm({
  workspaceSlug,
  options,
  onCreated,
  onBusy,
}: {
  workspaceSlug: string;
  options: TAccountProvisioningOptions | null;
  onCreated: (batch: TUserImportBatch) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [category, setCategory] = useState("STUDENT");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [advisors, setAdvisors] = useState([{ key: "primary", id: "", name: "", email: "", mode: "existing" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const student = category === "STUDENT";
  const unit = options?.org_units.find((item) => item.id === fields.org_unit);
  return (
    <form
      className="flex flex-col gap-3 rounded border border-subtle p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        onBusy?.(true);
        setError("");
        try {
          onCreated(
            await service.createSingleImport(workspaceSlug, {
              ...fields,
              category,
              advisors: student
                ? advisors.map(({ id, name, email, mode }) => (mode === "existing" ? { id } : { name, email }))
                : [],
            })
          );
        } catch (failure) {
          setError((failure as { message?: string })?.message || "录入失败，请重试。");
        } finally {
          setBusy(false);
          onBusy?.(false);
        }
      }}
    >
      <fieldset disabled={busy} className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <ListFilterField label="人员类别" className="w-full sm:w-full">
          <ListFilterSelect value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="STUDENT">学生</option>
            <option value="ADVISOR">导师</option>
          </ListFilterSelect>
        </ListFilterField>
        {[
          ["display_name", "姓名", true],
          ["email", "邮箱", true],
          ...(student
            ? [
                ["student_no", "学号", true],
                ["grade", "年级", false],
              ]
            : []),
          ["phone", "电话", false],
        ].map(([key, label, required]) => (
          <ListFilterField
            key={String(key)}
            label={`${String(label)}${required ? " *" : ""}`}
            className="w-full sm:w-full"
          >
            <ListFilterInput
              required={Boolean(required)}
              type={key === "email" ? "email" : "text"}
              value={fields[String(key)] || ""}
              onChange={(event) => setFields({ ...fields, [String(key)]: event.target.value })}
            />
          </ListFilterField>
        ))}
        <ListFilterField label={`${student ? "主归属小组" : "主归属组织"} *`} className="w-full sm:w-full">
          <ListFilterSelect
            required
            value={fields.org_unit || ""}
            onChange={(event) => setFields({ ...fields, org_unit: event.target.value })}
          >
            <option value="">请选择完整组织路径</option>
            {options?.org_units
              .filter((item) => !student || !("unit_type" in item) || item.unit_type === "TEAM")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_path}
                </option>
              ))}
          </ListFilterSelect>
        </ListFilterField>
        <p className="self-end text-12 text-tertiary">
          业务方向：
          {unit?.business_category === "BASIC_RESEARCH"
            ? "基础研究"
            : unit?.business_category === "INDUSTRIALIZATION"
              ? "产业化"
              : "随组织确定"}
        </p>
        {student && (
          <ListFilterField label="学位" className="w-full sm:w-full">
            <ListFilterSelect
              value={fields.degree || ""}
              onChange={(event) => setFields({ ...fields, degree: event.target.value })}
            >
              <option value="">暂未指定</option>
              <option value="BS">本科</option>
              <option value="MS">硕士</option>
              <option value="PHD">博士</option>
            </ListFilterSelect>
          </ListFilterField>
        )}
        <ListFilterField label="备注" className="w-full sm:w-full">
          <ListFilterInput
            maxLength={500}
            value={fields.review_note || ""}
            onChange={(event) => setFields({ ...fields, review_note: event.target.value })}
          />
        </ListFilterField>
      </fieldset>
      {student && (
        <fieldset disabled={busy} className="flex flex-col gap-3">
          {advisors.map((advisor, index) => (
            <div key={advisor.key} className="flex flex-wrap items-end gap-3">
              <ListFilterField label={index === 0 ? "主导师 *" : `联合导师 ${index}`} className="w-full sm:w-40">
                <ListFilterSelect
                  value={advisor.mode}
                  onChange={(event) =>
                    setAdvisors(
                      advisors.map((item, i) => (i === index ? { ...item, mode: event.target.value, id: "" } : item))
                    )
                  }
                >
                  <option value="existing">选择已有导师</option>
                  <option value="new">填写新导师</option>
                </ListFilterSelect>
              </ListFilterField>
              {advisor.mode === "existing" ? (
                <ResearchPersonSelect
                  people={options?.advisors ?? []}
                  value={advisor.id}
                  label="导师姓名 / 邮箱"
                  onChange={(id) => setAdvisors(advisors.map((item, i) => (i === index ? { ...item, id } : item)))}
                />
              ) : (
                <>
                  {["name", "email"].map((key) => (
                    <ListFilterField
                      key={key}
                      label={key === "name" ? "导师姓名" : "导师邮箱"}
                      className="w-full sm:w-48"
                    >
                      <ListFilterInput
                        required
                        type={key === "email" ? "email" : "text"}
                        value={advisor[key as "name" | "email"]}
                        onChange={(event) =>
                          setAdvisors(
                            advisors.map((item, i) => (i === index ? { ...item, [key]: event.target.value } : item))
                          )
                        }
                      />
                    </ListFilterField>
                  ))}
                </>
              )}
              {index > 0 && (
                <button
                  type="button"
                  className="text-12 text-danger-primary"
                  onClick={() => setAdvisors(advisors.filter((_, i) => i !== index))}
                >
                  移除联合导师
                </button>
              )}
            </div>
          ))}
          {advisors.length < 3 && (
            <button
              className="self-start text-12 text-accent-primary"
              type="button"
              onClick={() =>
                setAdvisors([...advisors, { key: crypto.randomUUID(), id: "", name: "", email: "", mode: "existing" }])
              }
            >
              添加联合导师
            </button>
          )}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-12 text-danger-primary">
          {error}
        </p>
      )}
      <p className="text-11 text-tertiary">提交后进入待审核，纳入并确认审批后才创建账号及关系。</p>
      <Button
        type="submit"
        variant="primary"
        size="xl"
        disabled={busy || !options || (student && advisors.some((item) => item.mode === "existing" && !item.id))}
      >
        {busy ? "提交中…" : "提交并预览"}
      </Button>
    </form>
  );
}
