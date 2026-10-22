import { useCallback, useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import {
  ResearchDetailSurface,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import {
  AdministrativeOrganizationManager,
  type AdministrativeOrganizationManagerAction,
} from "@/components/research/navigation/administrative-organization-manager";
import { ResearchNavigationService, type TAdministrativeOrganization } from "@/services/research/navigation.service";
import { domainError } from "@/services/project-domains.service";

const navigation = new ResearchNavigationService();

type TManagerState = { id: string; action: AdministrativeOrganizationManagerAction } | null;

export function AdministrativeOrganizationSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const [organizations, setOrganizations] = useState<TAdministrativeOrganization[]>([]);
  const [manager, setManager] = useState<TManagerState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const nextOrganizations = await navigation.getAdministrativeOrganizations(workspaceSlug);
    setOrganizations(nextOrganizations);
    window.dispatchEvent(new CustomEvent("administrative-organizations-updated"));
  }, [workspaceSlug]);

  useEffect(() => {
    void load().catch((cause) => setError(domainError(cause)));
  }, [load]);

  return (
    <ResearchListSurface>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary"
        >
          {error}
        </div>
      )}

      <ResearchDetailSurface title="行政组织" hint="组织成员继承下属公开项目的参与权限，私有项目需单独授权。">
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
                          <Button
                            key={action}
                            variant="ghost"
                            size="sm"
                            onClick={() => setManager({ id: organization.id, action })}
                          >
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
                  <TableCell colSpan={5} className="py-10 text-center text-tertiary">
                    暂无可管理的行政组织
                  </TableCell>
                </TableRow>
              )}
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
    </ResearchListSurface>
  );
}
