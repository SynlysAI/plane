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
    parse('event: messages\ndata: {"a":1}\nid: 100-0\n\n');
    expect(frames).toEqual([{ event: "messages", data: '{"a":1}', id: "100-0" }]);
  });

  it("buffers partial lines across chunks", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse("event: messages\nda");
    parse('ta: {"payload":{"items":[{"stream_event":{"type":"mes');
    parse('sage_delta","content":"你好"}}]}}\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("messages");
    expect(() => JSON.parse(frames[0].data)).not.toThrow();
    expect(JSON.parse(frames[0].data).payload.items[0].stream_event.content).toBe("你好");
  });

  it("handles CRLF line endings and heartbeats", () => {
    const frames: TSSEFrame[] = [];
    const parse = createSSEParser((frame) => frames.push(frame));
    parse(": heartbeat\r\n\r\n");
    parse("event: end\r\ndata: {}\r\n\r\n");
    expect(frames).toEqual([{ event: "end", data: "{}" }]);
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
    parse("event: messages\n\n");
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe("reduceSynloraFrame", () => {
  it("maps message_delta content and reasoning", () => {
    const frame: TSSEFrame = {
      event: "messages",
      data: JSON.stringify({
        payload: {
          items: [
            { stream_event: { type: "message_delta", content: "你好" } },
            { stream_event: { type: "message_delta", reasoning_content: "思考" } },
          ],
        },
      }),
    };
    expect(reduceSynloraFrame(frame)).toEqual([
      { type: "answer_delta", content: "你好" },
      { type: "reasoning_delta", content: "思考" },
    ]);
  });

  it("maps terminal frames", () => {
    expect(reduceSynloraFrame({ event: "end", data: '{"payload":{"status":"completed"}}' })).toEqual([
      { type: "end", status: "completed" },
    ]);
    expect(reduceSynloraFrame({ event: "error", data: '{"payload":{"retryable":false}}' })).toEqual([
      { type: "error", retryable: false },
    ]);
    expect(reduceSynloraFrame({ event: "interrupt", data: '{"payload":{"reason":"human_approval"}}' })).toEqual([
      { type: "interrupt", reason: "human_approval" },
    ]);
  });

  it("maps known custom events to status labels and skips unknown ones", () => {
    expect(reduceSynloraFrame({ event: "custom", data: '{"payload":{"name":"yuxi.init"}}' })).toEqual([
      { type: "status", label: "started" },
    ]);
    expect(reduceSynloraFrame({ event: "custom", data: '{"payload":{"name":"yuxi.unknown"}}' })).toEqual([]);
  });

  it("is resilient to malformed json", () => {
    expect(reduceSynloraFrame({ event: "messages", data: "not-json" })).toEqual([]);
    expect(reduceSynloraFrame({ event: "end", data: "not-json" })).toEqual([{ type: "end", status: "completed" }]);
  });
});
