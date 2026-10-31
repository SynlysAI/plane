import React from "react";
import { createRoot } from "react-dom/client";
import axios from "axios";
import { setLanguage, TranslationProvider } from "@plane/i18n";

import { ResearchChainKnowledgePanel } from "@/components/research/chains/research-chain-knowledge-panel";
import { useResearchChainKnowledge } from "@/components/research/chains/use-research-chain-knowledge";
import { ResearchChainService } from "@/services/research/chain.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收沿用应用真实样式。
import "../../styles/globals.css";

const scenarioName = new URLSearchParams(window.location.search).get("scenario") ?? "success";
const successfulUpload = {
  id: "fixture-upload",
  status: "SUCCESS" as const,
  knowledge_id: "fixture-knowledge",
  knowledge_base_id: "fixture-kb",
  file_name: "single-molecule-agent-mvp.pdf",
  file_type: "pdf",
  file_size: 977 * 1024,
  preview_url: "/fixture-preview/",
  download_url: "/attachment-preview.sample.pdf?download=1",
  error_code: "",
};
const failedUpload = {
  ...successfulUpload,
  id: "fixture-failed-upload",
  status: "FAILED" as const,
  file_name: `${"超长科研材料文件名用于窄屏截断验收".repeat(9)}.pdf`,
  error_code: "PARSE_FAILED",
};
const upload = scenarioName === "failed" ? failedUpload : successfulUpload;

Object.assign(axios, {
  post: async (url: string) => ({
    data: {
      status: "ready",
      kind: "pdf",
      content_url: "/attachment-preview.sample.pdf",
      url,
    },
  }),
});

ResearchChainService.prototype.getKnowledgeBases = async () => ({
  items: [{ external_id: "fixture-kb", title: "器件小组共享库" }],
  degraded: false,
  degraded_reason: "",
  state: "READY" as const,
  request_id: "",
  scope: "GROUP" as const,
  orgUnitId: "fixture-team",
  orgUnitName: "器件小组",
  connectionStatus: "connected" as const,
  candidates: [],
});
ResearchChainService.prototype.getKnowledgeUploads = async () => ({ data: [upload] });
ResearchChainService.prototype.getKnowledgeUpload = async () => ({ data: upload, degraded: false });
ResearchChainService.prototype.uploadKnowledgeFile = async () => ({
  data: { ...upload, id: "fixture-new-upload", status: "PROCESSING" as const },
  degraded: false,
});
ResearchChainService.prototype.confirmKnowledgeReference = async () => ({ ok: true });

/** 用共享资料控制器渲染真实面板，保持与节点详情一致。 */
function KnowledgeFixture() {
  const knowledge = useResearchChainKnowledge("fixture", "fixture-chain", "fixture-node");
  return <ResearchChainKnowledgePanel knowledge={knowledge} />;
}

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <main className="min-h-screen bg-canvas p-6 text-primary">
      <section className="mx-auto max-w-4xl overflow-hidden rounded-lg border border-subtle bg-surface-1">
        <KnowledgeFixture />
      </section>
    </main>
  </TranslationProvider>
);
