import React from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceNotificationSettings } from "@/components/workspace/workspace-notification-settings";
import { WorkspaceNotificationPolicyService } from "@/services/notification-policy.service";
// oxlint-disable-next-line import/no-unassigned-import -- 浏览器验收使用真实应用样式。
import "../../styles/globals.css";

WorkspaceNotificationPolicyService.prototype.list = async () => ({
  policies: [
    { category: "mention", in_app_enabled: false, email_enabled: false },
    { category: "research_mention", in_app_enabled: false, email_enabled: true },
  ],
});

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto min-h-screen max-w-5xl bg-canvas p-4 text-primary sm:p-8">
    <WorkspaceNotificationSettings workspaceSlug="isolated-test" />
  </main>
);
