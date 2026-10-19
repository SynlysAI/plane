import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { ResearchDetailSurface, ResearchFilterToolbar, ResearchListSurface, ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { AdministrativeOrganizationManager, type AdministrativeOrganizationManagerAction } from "@/components/research/navigation/administrative-organization-manager";
import { ResearchNavigationService, type TAdministrativeOrganization } from "@/services/research/navigation.service";
import { ProjectDomainsService, domainError, type TAdministrativeApprovalStep, type TAdministrativeFlow } from "@/services/project-domains.service";

const navigation = new ResearchNavigationService();
const approvals = new ProjectDomainsService();
const newStep = (order = 1): TAdministrativeApprovalStep => ({ order, approver_kind: "ORG_ADMIN", approver_id: null });

type TManagerState = { id: string; action: AdministrativeOrganizationManagerAction } | null;
type TFlowEditorState = { id?: string; organizationId: string; name: string; steps: TAdministrativeApprovalStep[] };

export function AdministrativeOrganizationSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const [organizations, setOrganizations] = useState<TAdministrativeOrganization[]>([]);
  const [flows, setFlows] = useState<TAdministrativeFlow[]>([]);
  const [editor, setEditor] = useState<TFlowEditorState | null>(null);
  const [members, setMembers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [manager, setManager] = useState<TManagerState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [nextOrganizations, nextFlows] = await Promise.all([
      navigation.getAdministrativeOrganizations(workspaceSlug),
      approvals.flows(workspaceSlug),
    ]);
    setOrganizations(nextOrganizations);
    setFlows(nextFlows);
    window.dispatchEvent(new CustomEvent("administrative-organizations-updated"));
  }, [workspaceSlug]);

  useEffect(() => {
    void load().catch((cause) => setError(domainError(cause)));
  }, [load]);

  useEffect(() => {
    let active = true;
    setMembers([]);
    if (!editor?.organizationId) return undefined;
    void approvals
      .approvers(workspaceSlug, editor.organizationId)
      .then((items) => {
        if (active) setMembers(items);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => {
      active = false;
    };
  }, [editor?.organizationId, workspaceSlug]);

  const editableOrganizations = useMemo(() => organizations.filter((organization) => organization.can_manage), [organizations]);

  const run = async (mutation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await mutation();
      await load();
    } catch (cause) {
      setError(domainError(cause));
    } finally {
      setBusy(false);
    }
  };

  const openNewFlow = () => {
    const organization = editableOrganizations.find((item) => !item.is_default) ?? editableOrganizations[0];
    setEditor({ organizationId: organization?.id ?? "", name: "", steps: [newStep()] });
  };

  const openEditFlow = (flow: TAdministrativeFlow) => {
    setEditor({ id: flow.id, organizationId: flow.organization_id, name: flow.name, steps: flow.steps });
  };

  const updateStep = (index: number, patch: Partial<TAdministrativeApprovalStep>) => {
    setEditor((current) =>
      current
        ? { ...current, steps: current.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)) }
        : current
    );
  };

  const saveFlow = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor?.organizationId || !editor.name.trim() || editor.steps.some((step) => step.approver_kind === "USER" && !step.approver_id)) return;
    await run(async () => {
      await approvals.saveFlow(
        workspaceSlug,
        { organization_id: editor.organizationId, name: editor.name.trim(), steps: editor.steps },
        editor.id
      );
      setEditor(null);
    });
  };

  return (
    <ResearchListSurface>
      {error && <div role="alert" className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">{error}</div>}

      <ResearchDetailSurface
        title="行政组织"
        hint="组织只负责成员归属和项目范围。新建组织请在行政项目页完成。"
      >
        <ResearchTableSurface>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>组织名称</TableHead>
                <TableHead>项目数</TableHead>
                <TableHead>成员数</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {organizations.map((organization) => (
                <TableRow key={organization.id} className="align-top">
                  <TableCell className="font-medium text-primary">{organization.name}</TableCell>
                  <TableCell className="text-secondary">{organization.project_ids.length}</TableCell>
                  <TableCell className="text-secondary">{organization.members.length}</TableCell>
                  <TableCell>
                    <ResearchStatusBadge status={organization.is_default ? "active" : "neutral"} size="sm">
                      {organization.is_default ? "公共组织" : "自定义组织"}
                    </ResearchStatusBadge>
                  </TableCell>
                  <TableCell className="text-right">
                    {organization.can_manage && !organization.is_default ? (
                      <div className="flex justify-end gap-1">
                        {(["members", "rename", "delete"] as const).map((action) => (
                          <Button key={action} variant="ghost" size="sm" onClick={() => setManager({ id: organization.id, action })}>
                            {{ members: "成员", rename: "重命名", delete: "删除" }[action]}
                          </Button>
                        ))}
                      </div>
                    ) : (
                      <span className="text-12 text-tertiary">由工作区统一维护</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {organizations.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-tertiary">暂无可管理的行政组织</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResearchTableSurface>
      </ResearchDetailSurface>

      <ResearchDetailSurface
        title="行政审批流程"
        hint="流程按组织隔离。已发起的审批固定使用创建时的流程版本。"
        actions={<Button variant="primary" size="sm" disabled={editableOrganizations.length === 0} onClick={openNewFlow}>新建审批流程</Button>}
      >
        <ResearchFilterToolbar>
          <span className="text-12 text-tertiary">共 {flows.length} 个流程</span>
        </ResearchFilterToolbar>
        <ResearchTableSurface>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>流程名称</TableHead>
                <TableHead>所属组织</TableHead>
                <TableHead>步骤</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flows.map((flow) => {
                const organization = organizations.find((item) => item.id === flow.organization_id);
                return (
                  <TableRow key={flow.id} className="align-top">
                    <TableCell className="font-medium text-primary">{flow.name}</TableCell>
                    <TableCell className="text-secondary">{organization?.name ?? "-"}</TableCell>
                    <TableCell className="text-secondary">{flow.steps.length} 步</TableCell>
                    <TableCell className="text-tertiary">v{flow.version}</TableCell>
                    <TableCell>
                      <ResearchStatusBadge status={flow.is_active ? "active" : "archived"} size="sm">
                        {flow.is_active ? "启用" : "历史版本"}
                      </ResearchStatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {organization?.can_manage && flow.is_active && <Button variant="ghost" size="sm" onClick={() => openEditFlow(flow)}>编辑新版本</Button>}
                    </TableCell>
                  </TableRow>
                );
              })}
              {flows.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-tertiary">暂无审批流程</TableCell></TableRow>}
            </TableBody>
          </Table>
        </ResearchTableSurface>
      </ResearchDetailSurface>

      {manager && (
        <AdministrativeOrganizationManager
          action={manager.action}
          organizationId={manager.id}
          workspaceSlug={workspaceSlug}
          organizations={organizations}
          defaultOrganization={organizations.find((organization) => organization.is_default)}
          onClose={() => setManager(null)}
          onUpdated={load}
        />
      )}

      <ModalCore isOpen={editor !== null} handleClose={() => !busy && setEditor(null)} position={EModalPosition.CENTER} width={EModalWidth.LG}>
        {editor && (
          <form className="space-y-5 p-5" onSubmit={(event) => void saveFlow(event)}>
            <div>
              <h2 className="text-16 font-semibold text-primary">{editor.id ? "编辑审批流程" : "新建审批流程"}</h2>
              <p className="mt-1 text-12 text-tertiary">每一步按顺序执行，可指定组织管理员或具体成员。</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-12 text-secondary">所属组织
                <select required disabled={Boolean(editor.id)} className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13" value={editor.organizationId} onChange={(event) => setEditor({ ...editor, organizationId: event.target.value, steps: [newStep()] })}>
                  <option value="">请选择组织</option>
                  {editableOrganizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-12 text-secondary">流程名称
                <input required maxLength={255} className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
              </label>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-13 font-semibold text-primary">审批步骤</h3>
                <Button type="button" variant="secondary" size="sm" disabled={editor.steps.length >= 20} onClick={() => setEditor({ ...editor, steps: [...editor.steps, newStep(editor.steps.length + 1)] })}>增加步骤</Button>
              </div>
              <div className="space-y-2 rounded-lg bg-surface-2 p-3">
                {editor.steps.map((step, index) => (
                  <div key={step.order} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-1 p-2 text-13">
                    <span className="w-12 text-secondary">第 {index + 1} 步</span>
                    <select className="h-8 rounded-md border border-subtle bg-surface-1 px-2" value={step.approver_kind} onChange={(event) => updateStep(index, { approver_kind: event.target.value as TAdministrativeApprovalStep["approver_kind"], approver_id: null })}>
                      <option value="ORG_ADMIN">组织管理员</option>
                      <option value="USER">指定成员</option>
                    </select>
                    {step.approver_kind === "USER" && (
                      <select required className="h-8 min-w-48 rounded-md border border-subtle bg-surface-1 px-2" value={step.approver_id ?? ""} onChange={(event) => updateStep(index, { approver_id: event.target.value })}>
                        <option value="">选择审批人</option>
                        {members.map((member) => <option key={member.id} value={member.id}>{member.name || member.email}</option>)}
                      </select>
                    )}
                    {editor.steps.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setEditor({ ...editor, steps: editor.steps.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, order: itemIndex + 1 })) })}>移除</Button>}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-subtle pt-4">
              <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => setEditor(null)}>取消</Button>
              <Button type="submit" variant="primary" size="sm" loading={busy}>保存流程</Button>
            </div>
          </form>
        )}
      </ModalCore>
    </ResearchListSurface>
  );
}

