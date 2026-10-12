/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import { useNavigate } from "react-router";
// plane imports
import { RESEARCH_PROJECT_TYPE_LABELS, RESEARCH_PROJECT_TYPES } from "@plane/constants";
import type { TResearchProjectType } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  currentUserId: string;
  isOpen: boolean;
  onClose: () => void;
};

/** 打开创建科研项目弹窗，供项目列表和研究链工作台共用。 */
export const ResearchProjectCreateDialog = observer(function ResearchProjectCreateDialog({
  workspaceSlug,
  currentUserId,
  isOpen,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [researchType, setResearchType] = useState<TResearchProjectType>("RESEARCH_PROJECT");
  const [chainKind, setChainKind] = useState<"LEGACY_TRAINING" | "RESEARCH_CHAIN">("RESEARCH_CHAIN");
  const [chainVisibility, setChainVisibility] = useState<"PRIVATE" | "MEMBERS" | "ORG" | "WORKSPACE">("PRIVATE");
  const [orgUnit, setOrgUnit] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const researchChainEnabled = Boolean(research.identity?.sections?.research_chain);
  const orgUnits = research.getOrgUnits(workspaceSlug);
  const memberOrgUnitIds = useMemo(
    () => new Set(research.identity?.user.org_units.map((membership) => membership.org_unit) ?? []),
    [research.identity]
  );
  const availableOrgUnits = useMemo(
    () =>
      research.identity?.user.is_workspace_admin ? orgUnits : orgUnits.filter((unit) => memberOrgUnitIds.has(unit.id)),
    [memberOrgUnitIds, orgUnits, research.identity?.user.is_workspace_admin]
  );
  const primaryOrgUnit = useMemo(
    () => research.identity?.user.org_units.find((membership) => membership.is_primary)?.org_unit ?? "",
    [research.identity]
  );
  const isTeamProject = researchType === "RESEARCH_PROJECT";
  const requiresOrgUnit = !isTeamProject || !research.isWorkspaceAdmin;

  useEffect(() => {
    if (!isOpen || orgUnits.length) return;
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
    // Store-derived org units are intentionally omitted from this fetch effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, orgUnits.length, workspaceSlug]);

  useEffect(() => {
    if (!orgUnit && primaryOrgUnit) setOrgUnit(primaryOrgUnit);
  }, [orgUnit, primaryOrgUnit]);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || (requiresOrgUnit && !orgUnit)) return;
    setIsCreating(true);
    try {
      const project = await research.createResearchProject(workspaceSlug, {
        name: name.trim(),
        owner: currentUserId,
        research_type: researchType,
        org_unit: orgUnit || null,
        chain_kind: chainKind,
        ...(chainKind === "RESEARCH_CHAIN" ? { chain_visibility: chainVisibility } : {}),
      });
      setName("");
      onClose();
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.project_created.title"),
        message: t("research.feedback.project_created.message"),
      });
      navigate(
        chainKind === "RESEARCH_CHAIN" && project.research?.chain_id
          ? `/${workspaceSlug}/research/chains/${project.research.chain_id}`
          : researchType === "RESEARCH_PROJECT"
            ? `/${workspaceSlug}/projects/${project.id}/issues`
            : `/${workspaceSlug}/research/projects/${project.id}/stages`
      );
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setIsCreating(false);
    }
  }, [
    chainKind,
    chainVisibility,
    currentUserId,
    navigate,
    name,
    onClose,
    orgUnit,
    requiresOrgUnit,
    research,
    researchType,
    t,
    workspaceSlug,
  ]);

  return (
    <ModalCore
      isOpen={isOpen}
      handleClose={() => !isCreating && onClose()}
      position={EModalPosition.CENTER}
      width={EModalWidth.LG}
    >
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <div>
          <h2 className="text-16 font-semibold text-primary">{t("research.projects.create_title")}</h2>
          <p className="mt-1 text-12 text-tertiary">{t("research.projects.create_hint")}</p>
        </div>
        {errorKey && (
          <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
            {t(errorKey)}
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.projects.fields.name")}</span>
            <Input
              placeholder={t("research.projects.name_placeholder")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.projects.fields.type")}</span>
            <select
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={researchType}
              onChange={(event) => setResearchType(event.target.value as TResearchProjectType)}
            >
              <optgroup label={t("research.projects.type_groups.cultivation")}>
                {RESEARCH_PROJECT_TYPES.filter((type) => type !== "RESEARCH_PROJECT").map((type) => (
                  <option key={type} value={type}>
                    {t(RESEARCH_PROJECT_TYPE_LABELS[type])}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("research.projects.type_groups.team")}>
                <option value="RESEARCH_PROJECT">{t(RESEARCH_PROJECT_TYPE_LABELS.RESEARCH_PROJECT)}</option>
              </optgroup>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.projects.fields.org_unit")}</span>
            <select
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={orgUnit}
              onChange={(event) => setOrgUnit(event.target.value)}
            >
              <option value="">{t("research.projects.org_unit_placeholder")}</option>
              {availableOrgUnits.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name}
                </option>
              ))}
            </select>
          </label>
          {researchChainEnabled && researchType !== "RESEARCH_PROJECT" && (
            <label className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t("research.projects.fields.chain_kind")}</span>
              <select
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                value={chainKind}
                onChange={(event) => setChainKind(event.target.value as "LEGACY_TRAINING" | "RESEARCH_CHAIN")}
              >
                <option value="LEGACY_TRAINING">{t("research.projects.chain_kinds.legacy_training")}</option>
                <option value="RESEARCH_CHAIN">{t("research.projects.chain_kinds.research_chain")}</option>
              </select>
            </label>
          )}
          {researchChainEnabled && chainKind === "RESEARCH_CHAIN" && (
            <label className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t("research.projects.fields.chain_visibility")}</span>
              <select
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                value={chainVisibility}
                onChange={(event) =>
                  setChainVisibility(event.target.value as "PRIVATE" | "MEMBERS" | "ORG" | "WORKSPACE")
                }
              >
                {(["PRIVATE", "MEMBERS", "ORG", "WORKSPACE"] as const).map((visibility) => (
                  <option key={visibility} value={visibility}>
                    {t(`research.projects.chain_visibility.${visibility.toLowerCase()}`)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {!primaryOrgUnit && requiresOrgUnit && (
          <p className="mt-2 text-11 text-warning-primary">{t("research.projects.missing_primary_org")}</p>
        )}
        {!orgUnit && isTeamProject && research.isWorkspaceAdmin && (
          <p className="mt-2 text-11 text-tertiary">{t("research.projects.team_org_optional")}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={isCreating} onClick={onClose}>
            {t("research.common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isCreating}
            disabled={!name.trim() || (requiresOrgUnit && !orgUnit) || !currentUserId}
          >
            {t("research.projects.create")}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
});
