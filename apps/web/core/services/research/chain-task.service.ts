/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type {
  TResearchAssignableUser,
  TResearchChainEvent,
  TResearchChainNodeTask,
  TResearchChainNodeTaskCreatePayload,
  TResearchChainNodeTaskUpdatePayload,
  TResearchTaskInstructionAttachment,
  TResearchTaskComment,
  TCommentAttachment,
  TCommentAttachmentLimits,
  TTaskNotificationRecipients,
} from "@plane/types";
import { APIService } from "@/services/api.service";
import { notifyWorkspaceTodosUpdated } from "@/helpers/workspace-todos.helper";

type TResearchEnvelope<T> = {
  success: boolean;
  data: T;
  error: unknown;
  request_id: string | null;
  schema_version: string;
};

export type TResearchChainTaskAction = "complete" | "reopen" | "cancel";

export type TResearchChainTaskActionPayload = {
  reason?: string;
  comment?: string;
};

type TResearchTaskUploadSlot = {
  asset_id: string;
  upload_data: { url: string; fields: Record<string, string> };
};

/** 任务评论附件确认接口返回的服务端契约。 */
type TResearchTaskCommentAttachmentConfirm = {
  asset_id: string;
  name: string;
  type: string;
  size: number;
};

/** 任务描述附件确认接口返回的服务端契约。 */
type TResearchTaskInstructionAttachmentConfirm = {
  asset_id: string;
  name: string;
  type: string;
  size: number;
};

/** Generate a best-effort client request id for task idempotency. */
function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Read a research API envelope or throw the server-provided error body. */
function unwrap<T>(response: unknown): T {
  const payload = response as TResearchEnvelope<T> | undefined;
  if (!payload?.data) throw payload ?? {};
  return payload.data;
}

/** Upload a browser file to a presigned object-storage slot. */
async function uploadToSlot(slot: TResearchTaskUploadSlot, file: File) {
  const formData = new FormData();
  Object.entries(slot.upload_data.fields ?? {}).forEach(([key, value]) => formData.append(key, value));
  formData.append("file", file);
  const response = await fetch(slot.upload_data.url, { method: "POST", body: formData });
  if (!response.ok) throw { error_code: "research_upload_storage_failed" };
}

/** Service for the Phase 1.6 Research Chain node-task collaboration API. */
export class ResearchChainTaskService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getTaskComments(workspaceSlug: string, chainId: string, nodeId: string, taskId: string) {
    return this.get(`${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comments/`)
      .then((response) => response.data as { results: TResearchTaskComment[]; can_comment: boolean })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createTaskComment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    payload: { comment_html: string; request_id: string; attachment_ids?: string[] }
  ) {
    return this.post(`${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comments/`, payload)
      .then((response) => response.data as TResearchTaskComment)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async updateTaskComment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    commentId: string,
    payload: { comment_html: string; attachment_ids?: string[] }
  ) {
    return this.patch(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comments/${commentId}/`,
      payload
    )
      .then((response) => response.data as TResearchTaskComment)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 读取研究任务评论使用的工作区四类附件额度。 */
  async getTaskCommentAttachmentLimits(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string
  ): Promise<TCommentAttachmentLimits> {
    return this.get(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comment-attachment-limits/`
    )
      .then((response) => response.data as TCommentAttachmentLimits)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 直传并确认一个任务评论文件附件。 */
  async uploadTaskCommentAttachment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    file: File
  ): Promise<TCommentAttachment> {
    const base = researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId);
    const slot = await this.post(`${base}comment-attachments/presign/`, {
      file_name: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
    })
      .then((response) => response.data as TResearchTaskUploadSlot)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
    await uploadToSlot(slot, file);
    return await this.post(`${base}comment-attachments/${slot.asset_id}/confirm/`, {})
      .then((response) => {
        const payload = response.data as TResearchTaskCommentAttachmentConfirm | undefined;
        if (!payload?.asset_id) {
          throw { error_code: "research_task_comment_attachment_confirm_invalid" };
        }
        return {
          id: payload.asset_id,
          name: payload.name,
          type: payload.type,
          size: payload.size,
          download_url: `${base}comment-attachments/${payload.asset_id}/download/`,
        } satisfies TCommentAttachment;
      })
      .catch(async (error) => {
        await this.deleteTaskCommentAttachment(workspaceSlug, chainId, nodeId, taskId, slot.asset_id).catch(
          () => undefined
        );
        throw error?.response?.data ?? error;
      });
  }

  /** 删除尚未保存到评论的任务评论文件草稿。 */
  async deleteTaskCommentAttachment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.delete(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comment-attachments/${assetId}/`
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 直传、校验并返回任务评论正文图片的认证读取地址。 */
  async uploadTaskCommentImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    file: File
  ): Promise<string> {
    const base = researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId);
    const slot = await this.post(`${base}comment-images/`, {
      file_name: file.name,
      content_type: file.type,
      size: file.size,
    })
      .then((response) => response.data as TResearchTaskUploadSlot)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
    await uploadToSlot(slot, file);
    return await this.post(`${base}comment-images/${slot.asset_id}/`, {})
      .then(() => `${base}comment-images/${slot.asset_id}/`)
      .catch(async (error) => {
        await this.deleteTaskCommentImage(workspaceSlug, chainId, nodeId, taskId, slot.asset_id).catch(() => undefined);
        throw error?.response?.data ?? error;
      });
  }

  /** 删除任务评论正文图片草稿。 */
  async deleteTaskCommentImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.delete(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comment-images/${assetId}/`
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 恢复刚从评论草稿中移除的正文图片。 */
  async restoreTaskCommentImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.post(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comment-images/${assetId}/`,
      { restore: true }
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 直传、校验并返回任务描述正文图片的认证读取地址。 */
  async uploadTaskInstructionImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    file: File
  ): Promise<string> {
    const base = `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}instruction-images/`;
    const slot = await this.post(base, {
      file_name: file.name,
      content_type: file.type,
      size: file.size,
    })
      .then((response) => response.data as TResearchTaskUploadSlot)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
    await uploadToSlot(slot, file);
    return await this.post(`${base}${slot.asset_id}/`, {})
      .then(() => `${base}${slot.asset_id}/`)
      .catch(async (error) => {
        await this.deleteTaskInstructionImage(workspaceSlug, chainId, nodeId, taskId, slot.asset_id).catch(
          () => undefined
        );
        throw error?.response?.data ?? error;
      });
  }

  /** 删除任务描述正文图片。 */
  async deleteTaskInstructionImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.delete(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}instruction-images/${assetId}/`
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 恢复刚从任务描述中移除的正文图片。 */
  async restoreTaskInstructionImage(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.post(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}instruction-images/${assetId}/`,
      { restore: true }
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 直传并确认一个任务描述文件附件。 */
  async uploadTaskInstructionAttachment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    file: File
  ): Promise<TResearchTaskInstructionAttachment> {
    const base = `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}instruction-attachments/`;
    const slot = await this.post(`${base}presign/`, {
      file_name: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
    })
      .then((response) => response.data as TResearchTaskUploadSlot)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
    await uploadToSlot(slot, file);
    return await this.post(`${base}${slot.asset_id}/confirm/`, {})
      .then((response) => {
        const payload = response.data as TResearchTaskInstructionAttachmentConfirm | undefined;
        if (!payload?.asset_id) {
          throw { error_code: "research_task_instruction_attachment_confirm_invalid" };
        }
        return {
          id: payload.asset_id,
          name: payload.name,
          type: payload.type,
          size: payload.size,
          download_url: `${base}${payload.asset_id}/download/`,
        } satisfies TResearchTaskInstructionAttachment;
      })
      .catch(async (error) => {
        await this.deleteTaskInstructionAttachment(workspaceSlug, chainId, nodeId, taskId, slot.asset_id).catch(
          () => undefined
        );
        throw error?.response?.data ?? error;
      });
  }

  /** 删除一个任务描述文件附件。 */
  async deleteTaskInstructionAttachment(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    assetId: string
  ) {
    return await this.delete(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}instruction-attachments/${assetId}/`
    )
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async deleteTaskComment(workspaceSlug: string, chainId: string, nodeId: string, taskId: string, commentId: string) {
    return this.delete(
      `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}comments/${commentId}/`
    ).catch((error) => {
      throw error?.response?.data ?? error;
    });
  }

  async getNodeTasks(workspaceSlug: string, chainId: string, nodeId: string) {
    return this.get(researchEndpoints.chainNodeTasks(workspaceSlug, chainId, nodeId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchChainNodeTask[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /**
   * 读取节点 Chain Event，供任务详情过滤出本任务的活动。
   *
   * Args:
   *   workspaceSlug: 工作区标识。
   *   nodeId: 任务所属节点。
   *
   * Returns:
   *   该节点的不可变事件列表；接口失败时抛出服务端错误体。
   */
  async getNodeEvents(workspaceSlug: string, nodeId: string) {
    return this.get(researchEndpoints.chainNodeEvents(workspaceSlug, nodeId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchChainEvent[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getAssignableUsers(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainAssignableUsers(workspaceSlug, chainId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchAssignableUser[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 读取科研任务的抄送与自我订阅成员。 */
  async getNotificationRecipients(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string
  ): Promise<TTaskNotificationRecipients> {
    const base = `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}notification-recipients/`;
    return this.get(base)
      .then((response) => unwrap<TTaskNotificationRecipients>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 全量保存科研任务的抄送成员。 */
  async updateNotificationRecipients(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    userIds: string[]
  ): Promise<TTaskNotificationRecipients> {
    const base = `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}notification-recipients/`;
    return this.put(base, { user_ids: userIds })
      .then((response) => unwrap<TTaskNotificationRecipients>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 切换当前用户对科研任务的新动态通知。 */
  async updateNotificationSelfSubscription(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    subscribed: boolean
  ): Promise<TTaskNotificationRecipients> {
    const base = `${researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId)}notification-recipients/me/`;
    const request = subscribed ? this.post(base, {}) : this.delete(base);
    return request
      .then((response) => unwrap<TTaskNotificationRecipients>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createNodeTask(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    payload: TResearchChainNodeTaskCreatePayload
  ) {
    return this.post(researchEndpoints.chainNodeTasks(workspaceSlug, chainId, nodeId), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => {
        notifyWorkspaceTodosUpdated();
        return unwrap<TResearchChainNodeTask>(response?.data);
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async updateNodeTask(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    payload: TResearchChainNodeTaskUpdatePayload
  ) {
    return this.patch(researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId), payload)
      .then((response) => {
        notifyWorkspaceTodosUpdated();
        return unwrap<TResearchChainNodeTask>(response?.data);
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async runNodeTaskAction(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    action: TResearchChainTaskAction,
    payload: TResearchChainTaskActionPayload = {}
  ) {
    return this.post(researchEndpoints.chainNodeTaskAction(workspaceSlug, chainId, nodeId, taskId, action), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => {
        notifyWorkspaceTodosUpdated();
        return unwrap<TResearchChainNodeTask>(response?.data);
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
