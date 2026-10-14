/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, makeObservable, observable, runInAction } from "mobx";
// lib
import { storage } from "@/lib/local-storage";

const THREAD_KEY_PREFIX = "PLANE_AI_ASSISTANT_THREAD_";

export interface IAIAssistantStore {
  // observables
  isOpen: boolean;
  threadWorkspaceSlug: string | null;
  threadId: string | null;
  status: { enabled: boolean; ready: boolean } | null;
  // actions
  open: () => void;
  close: () => void;
  toggle: (value?: boolean) => void;
  hydrate: (workspaceSlug: string) => void;
  setStatus: (status: { enabled: boolean; ready: boolean } | null) => void;
  setThreadId: (workspaceSlug: string, threadId: string) => void;
  clearThreadId: (workspaceSlug: string) => void;
}

export class AIAssistantStore implements IAIAssistantStore {
  isOpen: boolean = false;
  threadWorkspaceSlug: string | null = null;
  threadId: string | null = null;
  status: { enabled: boolean; ready: boolean } | null = null;

  constructor() {
    makeObservable(this, {
      isOpen: observable.ref,
      threadWorkspaceSlug: observable.ref,
      threadId: observable.ref,
      status: observable.ref,
      open: action,
      close: action,
      toggle: action,
      hydrate: action,
      setStatus: action,
      setThreadId: action,
      clearThreadId: action,
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

  clearThreadId = (workspaceSlug: string) => {
    runInAction(() => {
      this.threadWorkspaceSlug = workspaceSlug;
      this.threadId = null;
    });
    storage.remove(`${THREAD_KEY_PREFIX}${workspaceSlug}`);
  };
}
