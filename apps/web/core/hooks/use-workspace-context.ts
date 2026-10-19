import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useResearch } from "@/hooks/store/use-research";

/** Resolve the current workspace, sharing in-flight requests across consumers. */
export function useWorkspaceContext() {
  const { workspaceSlug } = useParams();
  const research = useResearch();
  const slug = workspaceSlug?.toString();
  useEffect(() => {
    if (slug && (research.identityWorkspaceSlug !== slug || !research.identity)) {
      void research.fetchIdentity(slug).catch(() => undefined);
    }
  }, [slug, research]);
  const current = research.identityWorkspaceSlug === slug;
  return {
    context: current ? research.identity : null,
    loading: !current || research.identityLoader,
    error: current ? research.identityErrorCode : null,
    retry: () => { if (slug) void research.fetchIdentity(slug).catch(() => undefined); },
  };
}
