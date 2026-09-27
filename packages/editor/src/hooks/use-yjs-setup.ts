/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
// react
import { useCallback, useEffect, useRef, useState } from "react";
// indexeddb
import { IndexeddbPersistence } from "y-indexeddb";
// yjs
import type * as Y from "yjs";
// types
import type { CollaborationState, CollabStage, CollaborationError } from "@/types/collaboration";

// Helper to check if a close code indicates a forced close
const isForcedCloseCode = (code: number | undefined): boolean => {
  if (!code) return false;
  // All custom close codes (4000-4003) are treated as forced closes
  return code >= 4000 && code <= 4003;
};

type UseYjsSetupArgs = {
  docId: string;
  serverUrl: string;
  authToken: string;
  onStateChange?: (state: CollaborationState) => void;
  options?: {
    maxConnectionAttempts?: number;
  };
};

const DEFAULT_MAX_RETRIES = 3;
const OFFLINE_DEADLINE_MS = 8000;

export const useYjsSetup = ({ docId, serverUrl, authToken, onStateChange }: UseYjsSetupArgs) => {
  // Current collaboration stage
  const [stage, setStage] = useState<CollabStage>({ kind: "initial" });

  // Cache readiness state
  const [hasCachedContent, setHasCachedContent] = useState(false);
  const [isCacheReady, setIsCacheReady] = useState(false);

  // Provider and Y.Doc in state (nullable until effect runs)
  const [yjsSession, setYjsSession] = useState<{ provider: HocuspocusProvider; ydoc: Y.Doc } | null>(null);

  // Use refs for values that need to be mutated from callbacks
  const retryCountRef = useRef(0);
  const forcedCloseSignalRef = useRef(false);
  const isDisposedRef = useRef(false);
  const stageRef = useRef<CollabStage>({ kind: "initial" });
  const lastReconnectTimeRef = useRef(0);
  const offlineLockedRef = useRef(false);
  const failureStartedAtRef = useRef<number | null>(null);

  // Create/destroy provider in effect (not during render)
  useEffect(() => {
    // Reset refs when creating new provider (e.g., document switch)
    retryCountRef.current = 0;
    isDisposedRef.current = false;
    forcedCloseSignalRef.current = false;
    offlineLockedRef.current = false;
    failureStartedAtRef.current = null;
    stageRef.current = { kind: "initial" };

    const websocketProvider = new HocuspocusProviderWebsocket({
      url: serverUrl,
      connect: true,
      delay: 1000,
      initialDelay: 0,
      factor: 1,
      maxAttempts: 2,
      minDelay: 1000,
      maxDelay: 1000,
      jitter: false,
      timeout: OFFLINE_DEADLINE_MS,
    });
    const provider = new HocuspocusProvider({
      name: docId,
      token: authToken,
      websocketProvider,
      onAuthenticationFailed: () => {
        if (isDisposedRef.current) return;
        offlineLockedRef.current = true;
        const error: CollaborationError = { type: "auth-failed", message: "Authentication failed" };
        const newStage = { kind: "disconnected" as const, error };
        stageRef.current = newStage;
        setStage(newStage);
        queueMicrotask(() => {
          if (!isDisposedRef.current) pauseProvider();
        });
      },
      onConnect: () => {
        if (isDisposedRef.current) {
          provider?.disconnect();
          return;
        }
        if (offlineLockedRef.current || failureStartedAtRef.current != null) {
          const retrying = { kind: "reconnecting" as const, attempt: retryCountRef.current };
          stageRef.current = retrying;
          setStage(retrying);
          return;
        }
        const newStage = { kind: "awaiting-sync" as const };
        stageRef.current = newStage;
        setStage(newStage);
      },
      onStatus: ({ status: providerStatus }) => {
        if (isDisposedRef.current) return;
        if (providerStatus === "connecting") {
          if (offlineLockedRef.current) {
            queueMicrotask(() => {
              if (!isDisposedRef.current) pauseProvider();
            });
            return;
          }
          const isReconnecting = retryCountRef.current > 0 || failureStartedAtRef.current != null;
          const newStage = isReconnecting
            ? { kind: "reconnecting" as const, attempt: retryCountRef.current }
            : { kind: "connecting" as const };
          stageRef.current = newStage;
          setStage(newStage);
        } else if (providerStatus === "disconnected") {
          // Do not transition here; let handleClose decide the final stage
        } else if (providerStatus === "connected") {
          if (offlineLockedRef.current || failureStartedAtRef.current != null) return;
          const newStage = { kind: "awaiting-sync" as const };
          stageRef.current = newStage;
          setStage(newStage);
        }
      },
      onSynced: () => {
        if (isDisposedRef.current) return;
        retryCountRef.current = 0;
        failureStartedAtRef.current = null;
        offlineLockedRef.current = false;
        clearOfflineTimer();
        const newStage = { kind: "synced" as const };
        stageRef.current = newStage;
        setStage(newStage);
      },
    });

    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    const clearOfflineTimer = () => {
      if (!offlineTimer) return;
      clearTimeout(offlineTimer);
      offlineTimer = null;
    };

    const pauseProvider = () => {
      const wsProvider = provider.configuration.websocketProvider;
      if (wsProvider) {
        try {
          wsProvider.shouldConnect = false;
          wsProvider.disconnect();
        } catch (error) {
          console.error(`Error pausing websocketProvider:`, error);
        }
      }
    };

    const permanentlyStopProvider = () => {
      isDisposedRef.current = true;

      const wsProvider = provider.configuration.websocketProvider;
      if (wsProvider) {
        try {
          wsProvider.shouldConnect = false;
          wsProvider.disconnect();
          wsProvider.destroy();
        } catch (error) {
          console.error(`Error tearing down websocketProvider:`, error);
        }
      }
      try {
        provider.destroy();
      } catch (error) {
        console.error(`Error destroying provider:`, error);
      }
    };

    const enterStableOffline = (error: CollaborationError) => {
      const alreadyOffline = offlineLockedRef.current && stageRef.current.kind === "disconnected";
      offlineLockedRef.current = true;
      failureStartedAtRef.current = null;
      clearOfflineTimer();
      pauseProvider();
      try {
        provider.configuration.websocketProvider.cancelWebsocketRetry?.();
      } catch (cancelError) {
        console.error("Error cancelling websocket retry:", cancelError);
      }
      if (alreadyOffline) return;
      const newStage = { kind: "disconnected" as const, error };
      stageRef.current = newStage;
      setStage(newStage);
    };

    const armOfflineDeadline = () => {
      if (failureStartedAtRef.current != null) return;
      failureStartedAtRef.current = Date.now();
      offlineTimer = setTimeout(() => {
        enterStableOffline({ type: "max-retries", message: "Connection stayed offline" });
      }, OFFLINE_DEADLINE_MS);
    };

    const handleClose = (closeEvent: { event?: { code?: number; reason?: string } }) => {
      if (isDisposedRef.current) return;
      if (offlineLockedRef.current) {
        pauseProvider();
        return;
      }

      const closeCode = closeEvent.event?.code;
      const wsProvider = provider.configuration.websocketProvider;
      const shouldConnect = wsProvider.shouldConnect;
      const isForcedClose = isForcedCloseCode(closeCode) || forcedCloseSignalRef.current || shouldConnect === false;

      if (isForcedClose) {
        const isManualDisconnect = shouldConnect === false;
        const error: CollaborationError = {
          type: "forced-close",
          code: closeCode || 0,
          message: isManualDisconnect ? "Manually disconnected" : "Server forced connection close",
        };
        forcedCloseSignalRef.current = false;
        enterStableOffline(error);
        return;
      }

      armOfflineDeadline();
      retryCountRef.current += 1;
      const elapsed = Date.now() - (failureStartedAtRef.current ?? Date.now());
      if (retryCountRef.current >= DEFAULT_MAX_RETRIES || elapsed >= OFFLINE_DEADLINE_MS) {
        enterStableOffline({
          type: "max-retries",
          message: `Failed to connect after ${DEFAULT_MAX_RETRIES} attempts`,
        });
        return;
      }
      const newStage = { kind: "reconnecting" as const, attempt: retryCountRef.current };
      stageRef.current = newStage;
      setStage(newStage);
    };

    provider.on("close", handleClose);

    setYjsSession({ provider, ydoc: provider.document });

    const releaseOfflineLock = () => {
      offlineLockedRef.current = false;
      failureStartedAtRef.current = null;
      retryCountRef.current = 0;
      clearOfflineTimer();
    };

    const handleVisibilityChange = () => {
      if (isDisposedRef.current || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastReconnectTimeRef.current < 1000) return;
      const wsProvider = provider.configuration.websocketProvider;
      if (!wsProvider) return;
      const ws = wsProvider.webSocket;
      const isStale = !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
      if (!isStale && stageRef.current.kind !== "disconnected") return;
      lastReconnectTimeRef.current = now;
      releaseOfflineLock();
      wsProvider.shouldConnect = true;
      const newStage = { kind: "connecting" as const };
      stageRef.current = newStage;
      setStage(newStage);
      wsProvider.disconnect();
      wsProvider.connect();
    };

    const handleOnline = () => {
      if (isDisposedRef.current) return;
      const wsProvider = provider.configuration.websocketProvider;
      if (!wsProvider) return;
      releaseOfflineLock();
      wsProvider.shouldConnect = true;
      const newStage = { kind: "connecting" as const };
      stageRef.current = newStage;
      setStage(newStage);
      wsProvider.disconnect();
      wsProvider.connect();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    return () => {
      try {
        provider.off("close", handleClose);
      } catch (error) {
        console.error(`Error unregistering close handler:`, error);
      }

      clearOfflineTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);

      permanentlyStopProvider();
    };
  }, [docId, serverUrl, authToken]);

  // IndexedDB persistence lifecycle
  useEffect(() => {
    if (!yjsSession) return;

    const idbPersistence = new IndexeddbPersistence(docId, yjsSession.provider.document);

    const onIdbSynced = () => {
      const yFragment = idbPersistence.doc.getXmlFragment("default");
      const docLength = yFragment?.length ?? 0;
      setIsCacheReady(true);
      setHasCachedContent(docLength > 0);
    };

    idbPersistence.on("synced", onIdbSynced);

    return () => {
      idbPersistence.off("synced", onIdbSynced);
      try {
        idbPersistence.destroy();
      } catch (error) {
        console.error(`Error destroying local provider:`, error);
      }
    };
  }, [docId, yjsSession]);

  // Observe Y.Doc content changes to update hasCachedContent (catches fallback scenario)
  useEffect(() => {
    if (!yjsSession || !isCacheReady) return;

    const fragment = yjsSession.ydoc.getXmlFragment("default");
    let lastHasContent = false;

    const updateCachedContentFlag = () => {
      const len = fragment?.length ?? 0;
      const hasContent = len > 0;

      // Only update state if the boolean value actually changed
      if (hasContent !== lastHasContent) {
        lastHasContent = hasContent;
        setHasCachedContent(hasContent);
      }
    };
    // Initial check (handles fallback content loaded before this effect runs)
    updateCachedContentFlag();

    // Use observeDeep to catch nested changes (keystrokes modify Y.XmlText inside Y.XmlElement)
    fragment.observeDeep(updateCachedContentFlag);

    return () => {
      try {
        fragment.unobserveDeep(updateCachedContentFlag);
      } catch (error) {
        console.error("Error unobserving fragment:", error);
      }
    };
  }, [yjsSession, isCacheReady]);

  // Notify state changes callback (use ref to avoid dependency on handler)
  const stateChangeCallbackRef = useRef(onStateChange);
  stateChangeCallbackRef.current = onStateChange;

  useEffect(() => {
    if (!stateChangeCallbackRef.current) return;

    const isServerSynced = stage.kind === "synced";
    const isServerDisconnected = stage.kind === "disconnected";

    const state: CollaborationState = {
      stage,
      isServerSynced,
      isServerDisconnected,
    };

    stateChangeCallbackRef.current(state);
  }, [stage]);

  // Derived values for convenience
  const isServerSynced = stage.kind === "synced";
  const isServerDisconnected = stage.kind === "disconnected";
  const isDocReady = isServerSynced || isServerDisconnected || (isCacheReady && hasCachedContent);

  const signalForcedClose = useCallback((value: boolean) => {
    forcedCloseSignalRef.current = value;
  }, []);

  // Don't return anything until provider is ready - guarantees non-null provider
  if (!yjsSession) {
    return null;
  }

  return {
    provider: yjsSession.provider,
    ydoc: yjsSession.ydoc,
    state: {
      stage,
      hasCachedContent,
      isCacheReady,
      isServerSynced,
      isServerDisconnected,
      isDocReady,
    },
    actions: {
      signalForcedClose,
    },
  };
};
