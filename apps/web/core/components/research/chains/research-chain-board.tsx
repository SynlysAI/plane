/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChain } from "@plane/types";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
};

export const ResearchChainBoard = function ResearchChainBoard({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      setChains(await chainService.getChains(workspaceSlug));
    } catch (caught) {
      if ((caught as { error_code?: string })?.error_code === "research_permission_denied") {
        setForbidden(true);
      }
      setError("load_failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-2 p-5" role="status" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="h-12 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-5">
        <p className="rounded-lg border border-subtle bg-surface-1 p-6 text-13 text-primary" role="alert">
          {t("research.common.permission_denied")}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <p className="text-13 text-primary">{t("research.status.load_failed.title")}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
          >
            {t("research.chains.refresh")}
          </button>
        </div>
      </div>
    );
  }

  if (!chains.length) {
    return (
      <div className="p-5">
        <div className="rounded-lg border border-subtle bg-surface-1 p-8 text-center" role="status">
          <p className="text-13 text-primary">{t("research.chains.empty")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{t("research.nav.research_chain")}</caption>
        <thead>
          <tr className="border-b border-subtle text-11 tracking-wide text-tertiary uppercase">
            <th scope="col" className="font-normal py-2 pr-4">
              {t("research.chains.project")}
            </th>
            <th scope="col" className="font-normal py-2 pr-4">
              {t("research.chains.status")}
            </th>
            <th scope="col" className="font-normal py-2 pr-4">
              {t("research.chains.visibility")}
            </th>
            <th scope="col" className="font-normal py-2" />
          </tr>
        </thead>
        <tbody>
          {chains.map((chain) => (
            <tr key={chain.id} className="border-b border-subtle">
              <td className="py-3 pr-4 text-13 text-primary">{chain.project_name ?? chain.project}</td>
              <td className="py-3 pr-4 text-12 text-secondary">
                {t(`research.chains.chain_status.${chain.status.toLowerCase()}`)}
              </td>
              <td className="py-3 pr-4 text-12 text-secondary">
                {t(`research.chains.visibility.${chain.visibility.toLowerCase()}`)}
              </td>
              <td className="py-3 text-right">
                <Link
                  href={`/${workspaceSlug}/research/chains/${chain.id}`}
                  className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
                >
                  {t("research.chains.open")}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
