import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import { AIAssistantPanel } from "@/components/assistant/ai-assistant-panel";
import { StoreProvider, store } from "@/lib/store-context";
import { AssistantService } from "@/services/assistant";
// oxlint-disable-next-line import/no-unassigned-import -- Use the application's actual layout styles.
import "../../styles/globals.css";

const params = new URLSearchParams(window.location.search);
const theme = ["light", "dark", "light-contrast", "dark-contrast"].includes(params.get("theme") ?? "")
  ? (params.get("theme") as "light" | "dark" | "light-contrast" | "dark-contrast")
  : "light";

// Keep the browser fixture isolated from backend services.
AssistantService.prototype.getHistory = async () => [
  { role: "user", content: "请用表格展示这些能力" },
  {
    role: "assistant",
    content: [
      "## 能力概览",
      "下面是**示例表格**：",
      "",
      "| 能力类别 | 具体能力 | 适用场景 | 典型产出 |",
      "| :--- | :--- | :--- | ---: |",
      "| 文献检索 | 全文读取与结构化检索 | 阅读工作目录中的文献 | 文献清单 |",
      "| 数据分析 | `SQL` 查询与统计 | 分析实验数据 | 统计报表 |",
      "",
      "- 支持 **Markdown** 格式",
      "- [参考链接](https://example.com)",
      "",
      "```sql",
      "SELECT category, COUNT(*) FROM results GROUP BY category;",
      "```",
    ].join("\n"),
  },
];

store.aiAssistant.hydrate("assistant-fixture");
store.aiAssistant.setThreadId("assistant-fixture", "fixture-thread");
store.aiAssistant.setProvider("cloud");
store.aiAssistant.open();

await setLanguage("zh-CN");
document.documentElement.dataset.theme = theme;
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter>
        <AIAssistantPanel workspaceSlug="assistant-fixture" />
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
