/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import type { TCommentAttachmentLimits } from "@plane/types";
import { FileService } from "@/services/file.service";

const fileService = new FileService();

/** 加载项目级评论附件额度；失败时保持为空以便前端阻止新增附件。
 *
 * @param workspaceSlug 工作区标识。
 * @param projectId 项目 ID。
 * @param enabled 当前表单是否支持评论附件。
 * @returns 四类额度及加载失败标记。
 */
export function useCommentAttachmentLimits(workspaceSlug?: string, projectId?: string, enabled = true) {
  const [limits, setLimits] = useState<TCommentAttachmentLimits | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLimits(null);
      setError(false);
      return;
    }
    if (!workspaceSlug || !projectId) {
      setLimits(null);
      setError(true);
      return;
    }

    let active = true;
    setLimits(null);
    setError(false);
    fileService
      .getCommentAttachmentLimits(workspaceSlug, projectId)
      .then((response) => {
        if (active) setLimits(response);
        return undefined;
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [enabled, projectId, workspaceSlug]);

  return { limits, error };
}
