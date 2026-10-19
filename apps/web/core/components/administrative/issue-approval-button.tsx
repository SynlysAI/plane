import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "@plane/propel/button";
import { ProjectDomainsService, domainError } from "@/services/project-domains.service";
const service = new ProjectDomainsService();
export function IssueApprovalButton({ workspaceSlug, projectId, issueId }: { workspaceSlug: string; projectId: string; issueId: string }) {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let active = true; setAllowed(false); void service.projectSetting(workspaceSlug, projectId).then((value) => {
    if (active) setAllowed(value.can_submit);
  }).catch(() => undefined); return () => { active = false; }; }, [workspaceSlug, projectId]);
  if (!allowed) return null;
  return <div className="flex items-center gap-2"><Button variant="secondary" size="sm" disabled={busy} onClick={() => {
    setBusy(true); setError(null); void service.submit(workspaceSlug, projectId, issueId).then((result) => {
      window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
      navigate(`/${workspaceSlug}/projects/${projectId}/approvals?request=${result.id}`);
    }).catch((cause) => setError(domainError(cause))).finally(() => setBusy(false));
  }}>发起审批</Button>{error && <span role="alert" className="max-w-72 text-12 text-danger-primary">{error}</span>}</div>;
}
