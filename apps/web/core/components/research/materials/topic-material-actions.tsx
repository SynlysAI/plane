/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ResearchOutcomeService, type TTopicMaterial } from "@/services/research/outcome.service";

const materialService = new ResearchOutcomeService();
const TOPIC_FILE_SUFFIXES = [".pdf", ".md", ".markdown"];

type ProjectOption = {
  id: string;
  name: string;
};

type Props = {
  workspaceSlug: string;
  projectId?: string;
  projects?: ProjectOption[];
  showRegister?: boolean;
};

/**
 * 判断文件是否为 PDF 或 Markdown。
 */
function isTopicMaterialFile(fileName: string) {
  const normalized = fileName.toLowerCase();
  return TOPIC_FILE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * 课题资料上传和成果登记。资料直接挂在课题上，不先创建成果行。
 */
export function ResearchTopicMaterialActions({ workspaceSlug, projectId, projects = [], showRegister = true }: Props) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const projectIds = projects.map((project) => project.id).join(",");
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? projects[0]?.id ?? "");
  const [materials, setMaterials] = useState<TTopicMaterial[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const available = projectIds ? projectIds.split(",") : [];
    const fallback = projectId ?? available[0] ?? "";
    setSelectedProjectId((current) => (current && available.includes(current) ? current : fallback));
  }, [projectId, projectIds]);

  useEffect(() => {
    if (!selectedProjectId) {
      setMaterials([]);
      return;
    }
    let active = true;
    void (async () => {
      try {
        const response = await materialService.listTopicMaterials(workspaceSlug, selectedProjectId);
        if (active) setMaterials(response.results);
      } catch {
        if (active) setMaterials([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedProjectId, workspaceSlug]);

  const upload = async (file: File) => {
    if (!selectedProjectId) return;
    if (!isTopicMaterialFile(file.name)) {
      setError(t("research.topic_materials.type_rejected"));
      return;
    }
    setError("");
    const presigned = await materialService.presignTopicMaterial(workspaceSlug, selectedProjectId, {
      file_name: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
    });
    const form = new FormData();
    Object.entries(presigned.upload_data.fields).forEach(([key, value]) => form.append(key, value));
    form.append("file", file);
    const response = await fetch(presigned.upload_data.url, { method: "POST", body: form });
    if (!response.ok) throw new Error("upload_failed");
    await materialService.confirmTopicMaterial(workspaceSlug, selectedProjectId, presigned.asset_id);
    const listed = await materialService.listTopicMaterials(workspaceSlug, selectedProjectId);
    setMaterials(listed.results);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {projects.length > 1 && (
          <label className="flex items-center gap-2 text-12 text-secondary">
            <span>{t("research.topic_materials.choose_project")}</span>
            <select
              aria-label={t("research.topic_materials.choose_project")}
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button variant="secondary" size="sm" disabled={!selectedProjectId} onClick={() => fileRef.current?.click()}>
          {t("research.topic_materials.upload")}
        </Button>
        {showRegister &&
          (selectedProjectId ? (
            <Link
              href={`/${workspaceSlug}/research/projects/${selectedProjectId}/outcomes`}
              className="text-12 text-secondary"
            >
              {t("research.outcomes.register")}
            </Link>
          ) : (
            <Button variant="secondary" size="sm" disabled>
              {t("research.outcomes.register")}
            </Button>
          ))}
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.md,.markdown,application/pdf,text/markdown"
          className="hidden"
          aria-label={t("research.topic_materials.upload")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void upload(file).catch(() => setError(t("research.topic_materials.type_rejected")));
          }}
        />
      </div>
      {error && (
        <p className="text-12 text-danger-primary" role="alert">
          {error}
        </p>
      )}
      {materials.length ? (
        <ul className="flex flex-col gap-1" role="list">
          {materials.map((material) => (
            <li key={material.id} className="text-12 text-tertiary">
              {material.file_name}
              <span className="mx-1">·</span>
              {t("research.topic_materials.project")} {material.project_name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-12 text-tertiary">{t("research.topic_materials.empty")}</p>
      )}
    </div>
  );
}
