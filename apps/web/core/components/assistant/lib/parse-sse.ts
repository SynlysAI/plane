/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * Incremental SSE parser and Synlora run-event reducer.
 *
 * Pure functions on purpose: the parser is fed decoded text chunks from the
 * fetch stream reader and buffers partial lines across chunk boundaries; the
 * reducer maps Synlora's `event:`/`data:` frames onto the UI stream states.
 */

export type TSSEFrame = {
  event?: string;
  data: string;
  id?: string;
};

/** Build a chunk consumer that dispatches complete SSE frames. */
export const createSSEParser = (onFrame: (frame: TSSEFrame) => void): ((chunk: string) => void) => {
  let buffer = "";
  let event: string | undefined;
  let dataLines: string[] = [];
  let id: string | undefined;

  const dispatch = () => {
    if (dataLines.length > 0) {
      onFrame({ event, data: dataLines.join("\n"), id });
    }
    event = undefined;
    dataLines = [];
    id = undefined;
  };

  const consumeLine = (line: string) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return; // heartbeat comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  };

  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      consumeLine(line);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    // any trailing partial line stays buffered until the next chunk completes it
  };
};

export type TAssistantStreamEvent =
  | { type: "answer_delta"; content: string }
  | { type: "reasoning_delta"; content: string }
  | { type: "status"; label: string }
  | { type: "interrupt"; reason: string }
  | { type: "end"; status: string }
  | { type: "error"; retryable: boolean };

type TSynloraEvent = {
  type?: string;
  payload?: {
    text?: string;
    content?: string;
    name?: string;
    ok?: boolean;
    kind?: string;
    reason?: string;
    code?: string;
    message?: string;
  };
};

/** Map one durable/live Synlora v1 SSE frame onto zero or more UI events. */
export const reduceSynloraFrame = (frame: TSSEFrame): TAssistantStreamEvent[] => {
  let parsed: TSynloraEvent | undefined;
  try {
    parsed = JSON.parse(frame.data) as TSynloraEvent;
  } catch {
    parsed = undefined;
  }
  const payload = parsed?.payload ?? {};
  const eventName = frame.event;

  if (eventName === "llm/delta") {
    return payload.text ? [{ type: "answer_delta", content: payload.text }] : [];
  }
  if (eventName === "assistant/message") {
    return payload.content ? [{ type: "answer_delta", content: payload.content }] : [];
  }
  if (eventName === "tool/call") {
    return [{ type: "status", label: `${payload.name ?? "tool"}:running` }];
  }
  if (eventName === "tool/result") {
    const state = payload.ok === false ? "failed" : "completed";
    return [{ type: "status", label: `${payload.name ?? "tool"}:${state}` }];
  }
  if (eventName === "ask/user") {
    return [{ type: "status", label: payload.kind === "approval" ? "approval_pending" : "waiting_for_user" }];
  }
  if (eventName === "turn/end") {
    return [{ type: "end", status: "completed" }];
  }
  if (eventName === "turn/aborted") {
    return [{ type: "interrupt", reason: payload.reason ?? "interrupted" }];
  }
  if (eventName === "error") {
    return [{ type: "error", retryable: !["unauthorized", "forbidden"].includes(payload.code ?? "") }];
  }
  return [];
};
