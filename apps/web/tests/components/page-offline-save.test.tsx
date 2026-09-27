// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CollaborationState, EditorRefApi } from "@plane/editor";
import { saveDisconnectedDescription } from "@/hooks/page-description-save";
import { usePageFallback } from "@/hooks/use-page-fallback";
import { nextPageSyncStatus } from "@/lib/page-sync-status";
import type { TPageInstance } from "@/store/pages/base-page";

vi.mock("@plane/editor", () => ({
  convertBinaryDataToBase64String: () => "encoded",
  getAllDocumentFormatsFromDocumentEditorBinaryData: () => ({ contentHTML: "<p>server</p>" }),
}));

const disconnected: CollaborationState = {
  stage: { kind: "disconnected", error: { type: "network-error", message: "down" } },
  isServerSynced: false,
  isServerDisconnected: true,
};

/**
 * 挂上断开中的页面保存，并交出手动保存动作。
 */
function OfflineProbe({
  onSaveReady,
  update,
}: {
  onSaveReady: (save: () => Promise<void>) => void;
  update: () => Promise<void>;
}) {
  const editorRef = useRef<EditorRefApi>({
    getDocument: () => ({ binary: new Uint8Array([1]), html: "<p>local</p>", json: { type: "doc" } }),
    setProviderDocument: vi.fn(),
  } as unknown as EditorRefApi);
  const fallback = usePageFallback({
    editorRef,
    fetchPageDescription: async () => new Uint8Array([2]).buffer,
    collaborationState: disconnected,
    updatePageDescription: update,
    page: { description_html: "<p>server</p>", name: "weekly" } as TPageInstance,
  });
  onSaveReady(fallback.savePageDescription);
  return null;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("does not write a matching server body or touch the editor document", async () => {
  const update = vi.fn();
  const outcome = await saveDisconnectedDescription({
    getLocal: () => ({ binary: new Uint8Array([1]), html: "<p>test</p>", json: { type: "doc" } }),
    fetchServer: async () => new Uint8Array([9]).buffer,
    readServerHtml: () => " <p>test</p> ",
    fallbackHtml: "",
    encodeBinary: () => "encoded",
    update,
  });

  expect(outcome).toBe("unchanged");
  expect(update).not.toHaveBeenCalled();
});

it("writes the local body once when the server copy differs", async () => {
  const update = vi.fn(async () => undefined);
  const outcome = await saveDisconnectedDescription({
    getLocal: () => ({ binary: new Uint8Array([1, 2]), html: "<p>local</p>", json: { type: "doc" } }),
    fetchServer: async () => new Uint8Array([3]).buffer,
    readServerHtml: () => "<p>server</p>",
    fallbackHtml: "",
    encodeBinary: () => "encoded",
    update,
  });

  expect(outcome).toBe("saved");
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]?.[0]).toMatchObject({ description_html: "<p>local</p>", description_binary: "encoded" });
});

it("stays on connection lost while later attempts still report connecting", () => {
  const failed = nextPageSyncStatus(false, "disconnected");
  const retry = nextPageSyncStatus(failed.latchedOffline, "connecting");
  const restored = nextPageSyncStatus(retry.latchedOffline, "synced");

  expect(failed).toMatchObject({ syncStatus: "error", reportDisconnected: true });
  expect(retry).toMatchObject({ syncStatus: "error", latchedOffline: true, reportDisconnected: true });
  expect(restored).toMatchObject({ syncStatus: "synced", latchedOffline: false, reportDisconnected: false });
});

it("does not autosave after the collaboration socket drops", async () => {
  vi.useFakeTimers();
  const update = vi.fn(async () => undefined);
  let savePageDescription: (() => Promise<void>) | null = null;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <OfflineProbe
        onSaveReady={(save) => {
          savePageDescription = save;
        }}
        update={update}
      />
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(35000);
  });

  expect(update).not.toHaveBeenCalled();

  await act(async () => {
    if (!savePageDescription) throw new Error("保存动作没有挂上");
    await savePageDescription();
  });
  expect(update).toHaveBeenCalledTimes(1);
  root.unmount();
  vi.useRealTimers();
});
