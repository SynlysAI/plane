/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type TOfflinePageDocument = {
  binary: Uint8Array | null;
  html: string;
  json: object | null;
};

export type TOfflineSaveOutcome = "saved" | "unchanged" | "empty" | "failed";

type TSaveDisconnectedDescriptionArgs = {
  getLocal: () => TOfflinePageDocument;
  fetchServer: () => Promise<ArrayBuffer>;
  readServerHtml: (binary: Uint8Array) => string;
  fallbackHtml: string;
  encodeBinary: (binary: Uint8Array) => string;
  update: (payload: {
    description_binary: string;
    description_html: string;
    description_json: object;
  }) => Promise<void>;
};

/**
 * 把正文 HTML 收成可比较的单行文本。
 */
export function normalizePageHtml(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

/**
 * 判断两份正文是否相同，避免把同一段再写回一次。
 */
export function pageDescriptionsMatch(localHtml: string, serverHtml: string): boolean {
  return normalizePageHtml(localHtml) === normalizePageHtml(serverHtml);
}

/**
 * 断开后手动保存一次正文。先比较服务端版本，相同则不写，也不把服务端文档套回编辑器。
 */
export async function saveDisconnectedDescription(
  args: TSaveDisconnectedDescriptionArgs
): Promise<TOfflineSaveOutcome> {
  const local = args.getLocal();
  if (!local.binary || !local.json) return "empty";

  let serverHtml = args.fallbackHtml ?? "";
  try {
    const serverBinary = await args.fetchServer();
    if (serverBinary.byteLength > 0) {
      serverHtml = args.readServerHtml(new Uint8Array(serverBinary));
    }
  } catch {
    return "failed";
  }

  if (pageDescriptionsMatch(local.html, serverHtml)) return "unchanged";

  try {
    await args.update({
      description_binary: args.encodeBinary(local.binary),
      description_html: local.html,
      description_json: local.json,
    });
  } catch {
    return "failed";
  }
  return "saved";
}
