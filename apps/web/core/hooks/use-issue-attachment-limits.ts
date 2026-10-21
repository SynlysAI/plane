/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo } from "react";
import type { TCommentAttachmentLimits } from "@plane/types";
import { getCommentAttachmentLimitError } from "@/components/comments/comment-attachment-limits";
import { useCommentAttachmentLimits } from "@/components/comments/use-comment-attachment-limits";

type TReturnProps = {
  limits: TCommentAttachmentLimits | null;
  error: boolean;
  isLoading: boolean;
  maxFileSize: number;
  getLimitError: (file: { name: string; size: number; type?: string }) => string | null;
};

/** 读取工作项附件可复用的评论附件分类额度。
 *
 * @param workspaceSlug 工作区标识。
 * @param projectId 项目 ID。
 * @returns 四类额度、加载状态、Dropzone 最大值与单文件分类校验函数。
 */
export function useIssueAttachmentLimits(workspaceSlug?: string, projectId?: string): TReturnProps {
  const { limits, error } = useCommentAttachmentLimits(workspaceSlug, projectId);

  const maxFileSize = useMemo(() => {
    if (!limits) return 0;
    return Math.max(...Object.values(limits).map((limit) => limit.max_bytes));
  }, [limits]);

  const getLimitError = useCallback(
    (file: { name: string; size: number; type?: string }) => {
      if (!limits) return "无法获取当前工作区附件限制";
      return getCommentAttachmentLimitError(limits, file);
    },
    [limits]
  );

  return {
    limits,
    error,
    isLoading: !limits && !error,
    maxFileSize,
    getLimitError,
  };
}
