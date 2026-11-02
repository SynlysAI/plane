/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, vi } from "vitest";
// assistant
import { createSSEParser, reduceSynloraFrame, type TSSEFrame } from "@/components/assistant/lib/parse-sse";

describe("createSSEParser", () => {
  it("dispatches complete frames", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse('event: llm/delta\ndata: {"a":1}\nid: 100\n\n');
    expect(frames).toEqual([{ event: "llm/delta", data: '{"a":1}', id: "100" }]);
  });

  it("buffers partial lines across chunks", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse("event: llm/delta\nda");
    parse('ta: {"payload":{"text":"你好"}}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("llm/delta");
    expect(() => JSON.parse(frames[0].data)).not.toThrow();
    expect(JSON.parse(frames[0].data).payload.text).toBe("你好");
  });

  it("handles CRLF line endings and heartbeats", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse(": heartbeat\r\n\r\n");
    parse("event: turn/end\r\ndata: {}\r\n\r\n");
    expect(frames).toEqual([{ event: "turn/end", data: "{}" }]);
  });

  it("joins multiple data lines with newlines", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse("data: line1\ndata: line2\n\n");
    expect(frames).toEqual([{ data: "line1\nline2" }]);
  });

  it("ignores frames without data lines", () => {
    const onFrame = vi.fn();
    const parse = createSSEParser(onFrame);
    parse("event: llm/delta\n\n");
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe("reduceSynloraFrame", () => {
  it("maps durable answer events and ignores reasoning content", () => {
    const frame: TSSEFrame = {
      event: "assistant/message",
      data: JSON.stringify({ payload: { content: "你好" } }),
    };
    expect(reduceSynloraFrame(frame)).toEqual([{ type: "answer_delta", content: "你好" }]);
    expect(
      reduceSynloraFrame({ event: "assistant/reasoning", data: JSON.stringify({ payload: { content: "思考" } }) })
    ).toEqual([]);
  });

  it("maps terminal frames", () => {
    expect(reduceSynloraFrame({ event: "turn/end", data: "{}" })).toEqual([{ type: "end", status: "completed" }]);
    expect(reduceSynloraFrame({ event: "turn/aborted", data: '{"payload":{"reason":"user_cancel"}}' })).toEqual([
      { type: "interrupt", reason: "user_cancel" },
    ]);
  });

  it("maps tool and approval statuses without exposing arguments", () => {
    expect(
      reduceSynloraFrame({ event: "tool/call", data: JSON.stringify({ payload: { name: "knowledge.search" } }) })
    ).toEqual([{ type: "status", label: "knowledge.search:running" }]);
    expect(
      reduceSynloraFrame({ event: "tool/result", data: JSON.stringify({ payload: { name: "knowledge.search" } }) })
    ).toEqual([{ type: "status", label: "knowledge.search:completed" }]);
    expect(reduceSynloraFrame({ event: "ask/user", data: JSON.stringify({ payload: { kind: "approval" } }) })).toEqual([
      { type: "status", label: "approval_pending" },
    ]);
  });

  it("is resilient to malformed json", () => {
    expect(reduceSynloraFrame({ event: "llm/delta", data: "not-json" })).toEqual([]);
    expect(reduceSynloraFrame({ event: "unknown", data: "not-json" })).toEqual([]);
  });
});
