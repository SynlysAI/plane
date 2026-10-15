/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
// lib
import { storage } from "@/lib/local-storage";

const THREAD_KEY_PREFIX = "PLANE_AI_ASSISTANT_THREAD_";

export type TAssistantProvider = "cloud" | "local";

export interface IAIAssistantStore {
  // observables
  isOpen: boolean;
  threadWorkspaceSlug: string | null;
  threadId: string | null;
  status: { enabled: boolean; ready: boolean } | null;
  activeProvider: TAssistantProvider;
  contextNodeId: string | null;
  expanded: boolean;
  // actions
  open: () => void;
  close: () => void;
  toggle: (value?: boolean) => void;
  openWithLocal: (nodeId: string) => void;
  hydrate: (workspaceSlug: string) => void;
  setStatus: (status: { enabled: boolean; ready: boolean } | null) => void;
  setThreadId: (workspaceSlug: string, threadId: string) => void;
  clearThreadId: (workspaceSlug: string) => void;
  setProvider: (provider: TAssistantProvider) => void;
  setContextNodeId: (nodeId: string | null) => void;
  toggleExpanded: (value?: boolean) => void;
}

export class AIAssistantStore implements IAIAssistantStore {
  isOpen: boolean = false;
  threadWorkspaceSlug: string | null = null;
  threadId: string | null = null;
  status: { enabled: boolean; ready: boolean } | null = null;
  activeProvider: TAssistantProvider = "cloud";
  contextNodeId: string | null = null;
  expanded: boolean = false;

  constructor() {
    makeObservable(this, {
      isOpen: observable.ref,
      threadWorkspaceSlug: observable.ref,
      threadId: observable.ref,
      status: observable.ref,
      activeProvider: observable.ref,
      contextNodeId: observable.ref,
      expanded: observable.ref,
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
    });
  }

  open = () => {
    this.isOpen = true;
  };

  close = () => {
    this.isOpen = false;
  };

  toggle = (value?: boolean) => {
    this.isOpen = value ?? !this.isOpen;
  };

  openWithLocal = (nodeId: string) => {
    this.contextNodeId = nodeId;
    this.activeProvider = "local";
    this.isOpen = true;
  };

  hydrate = (workspaceSlug: string) => {
    if (this.threadWorkspaceSlug === workspaceSlug) return;
    this.threadWorkspaceSlug = workspaceSlug;
    this.threadId = storage.get(`${THREAD_KEY_PREFIX}${workspaceSlug}`) ?? null;
  };

  setStatus = (status: { enabled: boolean; ready: boolean } | null) => {
    this.status = status;
  };

  setThreadId = (workspaceSlug: string, threadId: string) => {
    runInAction(() => {
      this.threadWorkspaceSlug = workspaceSlug;
      this.threadId = threadId;
    });
    storage.set(`${THREAD_KEY_PREFIX}${workspaceSlug}`, threadId);
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
  };

  clearThreadId = (workspaceSlug: string) => {
    runInAction(() => {
      this.threadWorkspaceSlug = workspaceSlug;
      this.threadId = null;
    });
    storage.remove(`${THREAD_KEY_PREFIX}${workspaceSlug}`);
  };
}
