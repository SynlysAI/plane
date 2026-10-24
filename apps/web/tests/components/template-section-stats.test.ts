import { describe, expect, it } from "vitest";
import type { JSONContent } from "@plane/types";
import { templateSectionStats } from "@/components/research/common/template-section-stats";

describe("templateSectionStats", () => {
  it("按章节统计作者输入并排除模板说明文字", () => {
    const document: JSONContent = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2, id: "progress" },
          content: [{ type: "text", text: "本周进展" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "请填写本周进展。（100 字以内）" }] },
        { type: "paragraph", content: [{ type: "text", text: "完成 器件 制备" }] },
        {
          type: "heading",
          attrs: { level: 2, id: "risk" },
          content: [{ type: "text", text: "风险" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "无" }] },
      ],
    };

    const stats = templateSectionStats(document, [
      { id: "progress", title: "本周进展", guidance: "请填写本周进展。", required: true, max_chars: 100 },
      { id: "risk", title: "风险", guidance: "请填写风险。", required: false },
    ]);

    expect(stats.map((item) => item.count)).toEqual([6, 1]);
  });
});
