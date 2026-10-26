import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import axios from "axios";
import { AttachmentPreviewLink } from "@/components/attachments/preview";
import { ResearchChainWorkbenchPeek } from "@/components/research/chains/research-chain-workbench-peek";
// oxlint-disable-next-line import/no-unassigned-import -- 验收沿用应用真实样式。
import "../../styles/globals.css";

Object.assign(axios, {
  post: async (url: string) => ({
    data: {
      status: "ready",
      kind: url.includes("pdf") ? "pdf" : "table",
      content_url: url.includes("pdf") ? "/attachment-preview.sample.pdf" : "/preview/content/",
    },
  }),
  get: async () => ({
    data: {
      rows: [
        ["指标", "数值"],
        ["样本数", "12"],
      ],
    },
  }),
});

/** 在科研工作台 Peek 内渲染三类附件入口，供真实浏览器验证统一预览行为。 */
function Fixture() {
  const [peekOpen, setPeekOpen] = useState(true);

  return (
    <main className="min-h-screen bg-canvas p-6 text-primary">
      {!peekOpen && (
        <button
          type="button"
          className="rounded border border-subtle px-3 py-1.5 text-13"
          onClick={() => setPeekOpen(true)}
        >
          重新打开科研工作台
        </button>
      )}
      {peekOpen && (
        <ResearchChainWorkbenchPeek title="科研工作台" onClose={() => setPeekOpen(false)}>
          <div className="mx-auto max-w-3xl">
            <h1 className="text-22 mb-6 font-semibold">附件预览验收</h1>
            <ul className="divide-y divide-subtle border-y border-subtle bg-surface-1 text-14">
              <li className="py-3">
                <AttachmentPreviewLink
                  name="中文报告.pdf"
                  previewUrl="/preview/pdf/"
                  downloadUrl="/download/report.pdf"
                  label="中文报告.pdf"
                />
              </li>
              <li className="py-3">
                <AttachmentPreviewLink
                  name="数据.csv"
                  previewUrl="/preview/csv/"
                  downloadUrl="/download/data.csv"
                  label="数据.csv"
                />
              </li>
              <li className="py-3">
                <AttachmentPreviewLink
                  name="结构图.svg"
                  previewUrl={null}
                  downloadUrl="/download/diagram.svg"
                  label="结构图.svg"
                />
              </li>
            </ul>
          </div>
        </ResearchChainWorkbenchPeek>
      )}
    </main>
  );
}

document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<Fixture />);
