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

type TSynloraStreamEvent = {
  type?: string;
  content?: string;
  reasoning_content?: string;
};

type TSynloraFrameData = {
  payload?: {
    items?: Array<{ stream_event?: TSynloraStreamEvent }>;
    chunk?: { stream_event?: TSynloraStreamEvent };
    status?: string;
    reason?: string;
    retryable?: boolean;
    name?: string;
  };
};

const CUSTOM_STATUS_LABELS: Record<string, string> = {
  "yuxi.init": "started",
  "yuxi.agent_state": "working",
};

/** Map one Synlora SSE frame onto zero or more UI stream events. */
export const reduceSynloraFrame = (frame: TSSEFrame): TAssistantStreamEvent[] => {
  if (frame.event === "end") {
    let status = "completed";
    try {
      const payload = (JSON.parse(frame.data) as TSynloraFrameData)?.payload;
      if (payload?.status) status = payload.status;
    } catch {
      /* keep the default terminal status */
    }
    return [{ type: "end", status }];
  }
  if (frame.event === "error") {
    let retryable = true;
    try {
      const payload = (JSON.parse(frame.data) as TSynloraFrameData)?.payload;
      if (payload && typeof payload.retryable === "boolean") retryable = payload.retryable;
    } catch {
      /* default to retryable */
    }
    return [{ type: "error", retryable }];
  }
  if (frame.event === "interrupt") {
    let reason = "interrupted";
    try {
      const payload = (JSON.parse(frame.data) as TSynloraFrameData)?.payload;
      if (payload?.reason) reason = payload.reason;
    } catch {
      /* keep the default reason */
    }
    return [{ type: "interrupt", reason }];
  }
  if (frame.event === "messages") {
    let parsed: TSynloraFrameData | undefined;
    try {
      parsed = JSON.parse(frame.data) as TSynloraFrameData;
    } catch {
      return [];
    }
    const chunks = [...(parsed?.payload?.items ?? [])];
    if (parsed?.payload?.chunk) chunks.push(parsed.payload.chunk);
    const events: TAssistantStreamEvent[] = [];
    for (const item of chunks) {
      const streamEvent = item.stream_event;
      if (!streamEvent) continue;
      if (streamEvent.type === "message_delta") {
        if (streamEvent.content) events.push({ type: "answer_delta", content: streamEvent.content });
        if (streamEvent.reasoning_content)
          events.push({ type: "reasoning_delta", content: streamEvent.reasoning_content });
      }
    }
    return events;
  }
  if (frame.event === "custom") {
    let name = "";
    try {
      name = (JSON.parse(frame.data) as TSynloraFrameData)?.payload?.name ?? "";
    } catch {
      return [];
    }
    const label = CUSTOM_STATUS_LABELS[name];
    return label ? [{ type: "status", label }] : [];
  }
  return [];
};
