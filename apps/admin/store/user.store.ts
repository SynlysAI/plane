/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, observable, runInAction, makeObservable } from "mobx";
// plane internal packages
import type { TUserStatus } from "@plane/constants";
import { EUserStatus } from "@plane/constants";
import { AuthService, UserService } from "@plane/services";
import type { IUser } from "@plane/types";
// root store
import type { RootStore } from "@/store/root.store";

export const ADMIN_CURRENT_USER_PATH = "/api/instances/admins/me/";
export const ADMIN_INSTANCE_ADMINS_PATH = "/api/instances/admins/";
export const ADMIN_SESSION_TIMEOUT_MS = 8000;

export type TAdminSessionFailure = {
  path: string;
  status: number | null;
};

export interface IUserStore {
  // observables
  isLoading: boolean;
  userStatus: TUserStatus | undefined;
  isUserLoggedIn: boolean | undefined;
  currentUser: IUser | undefined;
  sessionFailure: TAdminSessionFailure | undefined;
  // fetch actions
  hydrate: (data: any) => void;
  fetchCurrentUser: () => Promise<IUser>;
  reset: () => void;
  signOut: () => void;
}

/** 在固定时间内没有结果时失败，避免管理端一直停在标志。 */
export function withAdminSessionTimeout<T>(work: Promise<T>, timeoutMs: number, path: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const timeoutError = new Error("admin session timeout");
      Object.assign(timeoutError, { status: null, path: path(), code: "TIMEOUT" });
      reject(timeoutError);
    }, timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 401 和 403 回到登录；超时、断网和 5xx 进入失败页。 */
export function adminSessionStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: unknown; response?: { status?: unknown } };
  const status = candidate.status ?? candidate.response?.status;
  return typeof status === "number" ? status : null;
}

export function isAdminSessionUnauthenticated(error: unknown) {
  const status = adminSessionStatus(error);
  return status === 401 || status === 403;
}

export class UserStore implements IUserStore {
  // observables
  isLoading: boolean = true;
  userStatus: TUserStatus | undefined = undefined;
  isUserLoggedIn: boolean | undefined = undefined;
  currentUser: IUser | undefined = undefined;
  sessionFailure: TAdminSessionFailure | undefined = undefined;
  private sessionRequestId = 0;
  // services
  userService;
  authService;

  constructor(private store: RootStore) {
    makeObservable(this, {
      // observables
      isLoading: observable.ref,
      userStatus: observable,
      isUserLoggedIn: observable.ref,
      currentUser: observable,
      sessionFailure: observable.ref,
      // action
      fetchCurrentUser: action,
      reset: action,
      signOut: action,
    });
    this.userService = new UserService();
    this.authService = new AuthService();
  }

  hydrate = (data: any) => {
    if (data) this.currentUser = data;
  };

  /**
   * @description Fetches the current user
   * @returns Promise<IUser>
   */
  fetchCurrentUser = async () => {
    const requestId = ++this.sessionRequestId;
    const isCurrent = () => requestId === this.sessionRequestId;
    let path = ADMIN_CURRENT_USER_PATH;
    this.sessionFailure = undefined;
    try {
      if (this.currentUser === undefined) this.isLoading = true;
      const currentUser = await withAdminSessionTimeout(
        (async () => {
          const user = await this.userService.adminDetails();
          path = ADMIN_INSTANCE_ADMINS_PATH;
          await this.store.instance.fetchInstanceAdmins();
          return user;
        })(),
        ADMIN_SESSION_TIMEOUT_MS,
        () => path
      );
      if (!isCurrent()) return currentUser;
      if (currentUser) {
        runInAction(() => {
          this.isUserLoggedIn = true;
          this.currentUser = currentUser;
          this.sessionFailure = undefined;
          this.isLoading = false;
        });
      } else {
        runInAction(() => {
          this.isUserLoggedIn = false;
          this.currentUser = undefined;
          this.sessionFailure = undefined;
          this.isLoading = false;
        });
      }
      return currentUser;
    } catch (error: any) {
      if (!isCurrent()) throw error;
      const statusCode = adminSessionStatus(error);
      const failurePath = typeof error?.path === "string" ? error.path : path;
      runInAction(() => {
        this.isLoading = false;
        if (isAdminSessionUnauthenticated(error)) {
          this.isUserLoggedIn = false;
          this.currentUser = undefined;
          this.sessionFailure = undefined;
          this.userStatus = {
            status: statusCode === 403 ? EUserStatus.AUTHENTICATION_NOT_DONE : EUserStatus.ERROR,
            message: "",
          };
          return;
        }
        this.sessionFailure = { path: failurePath, status: statusCode };
        this.userStatus = {
          status: EUserStatus.ERROR,
          message: "",
        };
      });
      throw error;
    }
  };

  reset = async () => {
    this.isUserLoggedIn = false;
    this.currentUser = undefined;
    this.sessionFailure = undefined;
    this.isLoading = false;
    this.userStatus = undefined;
  };

  signOut = async () => {
    this.store.resetOnSignOut();
  };
}
