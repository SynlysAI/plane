/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
// lib
import { storage } from "@/lib/local-storage";
import type { TAssistantStatus } from "@/services/assistant";

const THREAD_KEY_PREFIX = "PLANE_AI_ASSISTANT_THREAD_";
const PREFERENCES_KEY_PREFIX = "PLANE_AGENT_DOCK_PREFERENCES_";
export const AGENT_DOCK_MIN_WIDTH = 320;
export const AGENT_DOCK_MAX_WIDTH = 560;
export const AGENT_DOCK_DEFAULT_WIDTH = 420;

export type TAssistantProvider = "cloud" | "local";
export type TAgentDockMode = "floating" | "docked";
export type TAgentDockView = "conversation" | "context" | "runtime";

type TAgentDockPreferences = {
  dockMode: TAgentDockMode;
  width: number;
  expanded: boolean;
  isOpen: boolean;
  activeView: TAgentDockView;
  activeSessionId: string | null;
};

export interface IAIAssistantStore {
  // observables
  isOpen: boolean;
  threadWorkspaceSlug: string | null;
  threadOwnerKey: string | null;
  threadId: string | null;
  status: TAssistantStatus | null;
  activeProvider: TAssistantProvider;
  contextNodeId: string | null;
  expanded: boolean;
  dockMode: TAgentDockMode;
  width: number;
  activeView: TAgentDockView;
  // actions
  open: () => void;
  close: () => void;
  toggle: (value?: boolean) => void;
  openWithLocal: (nodeId: string) => void;
  hydrate: (workspaceSlug: string, ownerKey?: string) => void;
  setStatus: (status: TAssistantStatus | null) => void;
  setThreadId: (workspaceSlug: string, threadId: string) => void;
  clearThreadId: (workspaceSlug: string) => void;
  setProvider: (provider: TAssistantProvider) => void;
  setContextNodeId: (nodeId: string | null) => void;
  toggleExpanded: (value?: boolean) => void;
  setDockMode: (mode: TAgentDockMode) => void;
  setWidth: (width: number) => void;
  setActiveView: (view: TAgentDockView) => void;
}

export class AIAssistantStore implements IAIAssistantStore {
  isOpen: boolean = false;
  threadWorkspaceSlug: string | null = null;
  threadOwnerKey: string | null = null;
  threadId: string | null = null;
  status: TAssistantStatus | null = null;
  activeProvider: TAssistantProvider = "cloud";
  contextNodeId: string | null = null;
  expanded: boolean = false;
  dockMode: TAgentDockMode = "floating";
  width: number = AGENT_DOCK_DEFAULT_WIDTH;
  activeView: TAgentDockView = "conversation";

  constructor() {
    makeObservable(this, {
      isOpen: observable.ref,
      threadWorkspaceSlug: observable.ref,
      threadOwnerKey: observable.ref,
      threadId: observable.ref,
      status: observable.ref,
      activeProvider: observable.ref,
      contextNodeId: observable.ref,
      expanded: observable.ref,
      dockMode: observable.ref,
      width: observable.ref,
      activeView: observable.ref,
      open: action,
      close: action,
      toggle: action,
      openWithLocal: action,
      hydrate: action,
      setStatus: action,
      setThreadId: action,
      clearThreadId: action,
      setProvider: action,
      setContextNodeId: action,
      toggleExpanded: action,
      setDockMode: action,
      setWidth: action,
      setActiveView: action,
    });
  }

  open = () => {
    this.isOpen = true;
    this.persistCurrentPreferences();
  };

  close = () => {
    this.isOpen = false;
    this.persistCurrentPreferences();
  };

  toggle = (value?: boolean) => {
    this.isOpen = value ?? !this.isOpen;
    this.persistCurrentPreferences();
  };

  openWithLocal = (nodeId: string) => {
    this.contextNodeId = nodeId;
    this.activeProvider = "local";
    this.activeView = "conversation";
    this.isOpen = true;
    this.persistCurrentPreferences();
  };

  hydrate = (workspaceSlug: string, ownerKey?: string) => {
    const nextOwnerKey = ownerKey ?? null;
    if (this.threadWorkspaceSlug === workspaceSlug && this.threadOwnerKey === nextOwnerKey) return;
    this.threadWorkspaceSlug = workspaceSlug;
    this.threadOwnerKey = nextOwnerKey;
    this.activeProvider = "cloud";
    this.contextNodeId = null;
    this.threadId = storage.get(this.threadStorageKey(workspaceSlug, nextOwnerKey)) ?? null;
    const raw = storage.get(`${PREFERENCES_KEY_PREFIX}${workspaceSlug}`);
    try {
      const parsed = typeof raw === "string" ? (JSON.parse(raw) as Partial<TAgentDockPreferences>) : raw;
      this.dockMode = parsed?.dockMode === "docked" ? "docked" : "floating";
      this.expanded = Boolean(parsed?.expanded);
      this.isOpen = Boolean(parsed?.isOpen);
      this.activeView = ["conversation", "context", "runtime"].includes(String(parsed?.activeView))
        ? (parsed?.activeView as TAgentDockView)
        : "conversation";
      const storedWidth = Number(parsed?.width);
      this.width = Number.isFinite(storedWidth)
        ? Math.min(AGENT_DOCK_MAX_WIDTH, Math.max(AGENT_DOCK_MIN_WIDTH, storedWidth))
        : AGENT_DOCK_DEFAULT_WIDTH;
    } catch {
      this.dockMode = "floating";
      this.expanded = false;
      this.isOpen = false;
      this.activeView = "conversation";
      this.width = AGENT_DOCK_DEFAULT_WIDTH;
    }
  };

  setStatus = (status: TAssistantStatus | null) => {
    this.status = status;
  };

  setThreadId = (workspaceSlug: string, threadId: string) => {
    runInAction(() => {
      this.threadWorkspaceSlug = workspaceSlug;
      this.threadId = threadId;
    });
    storage.set(this.threadStorageKey(workspaceSlug, this.threadOwnerKey), threadId);
    this.persistPreferences(workspaceSlug, { activeSessionId: threadId });
  };

  setProvider = (provider: TAssistantProvider) => {
    this.activeProvider = provider;
    if (provider === "cloud") this.contextNodeId = null;
  };

  setContextNodeId = (nodeId: string | null) => {
    this.contextNodeId = nodeId;
  };

  toggleExpanded = (value?: boolean) => {
    this.expanded = value ?? !this.expanded;
    this.persistCurrentPreferences();
  };

  setDockMode = (mode: TAgentDockMode) => {
    this.dockMode = mode;
    if (mode === "docked") this.expanded = false;
    this.persistCurrentPreferences();
  };

  setWidth = (width: number) => {
    const nextWidth = Number(width);
    if (!Number.isFinite(nextWidth)) return;
    this.width = Math.min(AGENT_DOCK_MAX_WIDTH, Math.max(AGENT_DOCK_MIN_WIDTH, nextWidth));
    this.persistCurrentPreferences();
  };

  setActiveView = (view: TAgentDockView) => {
    this.activeView = view;
    this.persistCurrentPreferences();
  };

  clearThreadId = (workspaceSlug: string) => {
    runInAction(() => {
      this.threadWorkspaceSlug = workspaceSlug;
      this.threadId = null;
    });
    storage.remove(this.threadStorageKey(workspaceSlug, this.threadOwnerKey));
    this.persistPreferences(workspaceSlug, { activeSessionId: null });
  };

  private persistCurrentPreferences() {
    if (this.threadWorkspaceSlug) this.persistPreferences(this.threadWorkspaceSlug);
  }

  private threadStorageKey(workspaceSlug: string, ownerKey: string | null) {
    return ownerKey
      ? `${THREAD_KEY_PREFIX}${workspaceSlug}:${ownerKey}`
      : `${THREAD_KEY_PREFIX}${workspaceSlug}`;
  }

  private persistPreferences(workspaceSlug: string, overrides: Partial<TAgentDockPreferences> = {}) {
    const preferences: TAgentDockPreferences = {
      dockMode: this.dockMode,
      width: this.width,
      expanded: this.expanded,
      isOpen: this.isOpen,
      activeView: this.activeView,
      activeSessionId: this.threadWorkspaceSlug === workspaceSlug ? this.threadId : null,
      ...overrides,
    };
    storage.set(`${PREFERENCES_KEY_PREFIX}${workspaceSlug}`, JSON.stringify(preferences));
  }
}
