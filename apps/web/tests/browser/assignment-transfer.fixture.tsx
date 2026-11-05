import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import { AssignmentTransferConfirmation } from "@/components/email-actions/assignment-transfer-confirmation";
// oxlint-disable-next-line import/no-unassigned-import -- Use app styles in browser verification.
import "../../styles/globals.css";

const preview = {
  status: "ready",
  entity_type: "research_work_item",
  title: "JACS 审稿意见回复",
  workspace_slug: "lab",
  route: "/lab/research/chains/chain-1?node=node-1&task=task-1",
  expires_at: "2026-11-12T03:00:00.000Z",
  current_assignee: { id: "owner", display_name: "当前负责人" },
  candidate: { id: "next", display_name: "下一位负责人" },
};

window.history.replaceState(null, "", "/email-actions/assignment-transfer/?token=fixture&candidate=next");
window.fetch = async () =>
  new Response(JSON.stringify(preview), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

createRoot(document.getElementById("root")!).render(
  <MemoryRouter initialEntries={["/email-actions/assignment-transfer/?token=fixture&candidate=next"]}>
    <AssignmentTransferConfirmation />
  </MemoryRouter>
);
