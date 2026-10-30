/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import BackgroundImage1 from "@/app/assets/cover-images/image_1.jpg?url";
import BackgroundImage12 from "@/app/assets/cover-images/image_12.jpg?url";
import BackgroundImage15 from "@/app/assets/cover-images/image_15.jpg?url";
import BackgroundImage21 from "@/app/assets/cover-images/image_21.jpg?url";
import BackgroundImage27 from "@/app/assets/cover-images/image_27.jpg?url";
import BackgroundImage4 from "@/app/assets/cover-images/image_4.jpg?url";

export const DEFAULT_CONTENT_BACKGROUND_OPACITY = 0.85;

/**
 * 读取并约束内容底色不透明度，兼容没有该偏好的历史账号。
 *
 * @param value 保存的偏好或临时预览值。
 * @returns 范围为 0-1 的有效不透明度。
 */
export function getContentBackgroundOpacity(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_CONTENT_BACKGROUND_OPACITY;
}

/** 内置工作台背景，数量刻意保持少，降低长时间使用的视觉干扰。 */
export const WORKSPACE_BACKGROUND_IMAGES = [
  BackgroundImage1,
  BackgroundImage4,
  BackgroundImage12,
  BackgroundImage15,
  BackgroundImage21,
  BackgroundImage27,
] as const;
