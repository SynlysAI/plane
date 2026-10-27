import { useId, useRef, useState } from "react";
import { observer } from "mobx-react";
import { MCPManagement } from "@/components/mcp/mcp-management";
import { WeeklyReportMCPSettings } from "@/components/mcp/weekly-report-settings";
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useWorkspace } from "@/hooks/store/use-workspace";

export const MCPProfileSettings = observer(function MCPProfileSettings({ inModal = false }: { inModal?: boolean }) {
  const { currentWorkspace } = useWorkspace();
  const workspaceSlug = currentWorkspace?.slug;
  return inModal ? (
    <ModalMCPSettings workspaceSlug={workspaceSlug} />
  ) : (
    <MCPSettingsTabs key={workspaceSlug} workspaceSlug={workspaceSlug} />
  );
});

// Unmount immediately when closing, including during the modal's exit animation.
const ModalMCPSettings = observer(function ModalMCPSettings({ workspaceSlug }: { workspaceSlug?: string }) {
  const { profileSettingsModal } = useCommandPalette();
  return profileSettingsModal.isOpen ? (
    <MCPSettingsTabs key={workspaceSlug} workspaceSlug={workspaceSlug} inModal />
  ) : null;
});

function MCPSettingsTabs({ workspaceSlug, inModal = false }: { workspaceSlug?: string; inModal?: boolean }) {
  const [tab, setTab] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="space-y-6">
      <div role="tablist" aria-label="MCP 连接类型" className="flex gap-2 border-b border-subtle">
        {["现有连接", "周报连接"].map((label, index) => (
          <button
            key={label}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            aria-controls={`${id}-panel-${index}`}
            aria-selected={tab === index}
            tabIndex={tab === index ? 0 : -1}
            className={`px-4 py-2 ${tab === index ? "border-accent-primary border-b-2 font-semibold" : "text-secondary"}`}
            onClick={() => setTab(index)}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : ["ArrowLeft", "ArrowRight"].includes(event.key)
                      ? 1 - index
                      : null;
              if (next === null) return;
              event.preventDefault();
              setTab(next);
              buttons.current[next]?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {[0, 1].map((index) => (
        <div
          key={index}
          role="tabpanel"
          id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`}
          hidden={tab !== index}
          tabIndex={0}
        >
          {tab === index &&
            (index === 0 ? (
              <MCPManagement workspaceSlug={workspaceSlug} inModal={inModal} />
            ) : (
              <WeeklyReportMCPSettings workspaceSlug={workspaceSlug} />
            ))}
        </div>
      ))}
    </div>
  );
}
