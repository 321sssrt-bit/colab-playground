/**
 * Global orchestration store for `StopAllDialog` and `StopRuntimeDialog`.
 *
 * Mounted at application scope in `App.tsx` so switching routes mid-stop never
 * unmounts the confirmation dialog, never discards a `verified: false` report,
 * and always falls back to a toast alert if a stop fails while the dialog is closed.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient } from "./api.ts";
import { appDataStore, type AppDataStore } from "./appCache.ts";
import { guardRuntimeKey, guardStore, type GuardStore } from "./guard.ts";
import { i18nStore, type TranslateFn } from "./i18n.ts";
import { webStore, type WebStore } from "./store.ts";
import { toastStore, type ToastStore } from "./toast.ts";
import type {
  Account,
  Runtime,
  RuntimeRef,
  Snapshot,
  StopAllResponse,
} from "./types.ts";

export interface GlobalStopRuntimeTarget {
  readonly target: RuntimeRef;
  readonly label: string;
  readonly email: string | null;
}

export type StopAllPhase = "confirm" | "submitting" | "result";

export interface StopAllDialogState {
  readonly open: boolean;
  readonly openId: number;
  readonly phase: StopAllPhase;
  readonly result: StopAllResponse | null;
  readonly submitError: unknown | null;
  readonly capturedRuntimes: readonly Runtime[];
  readonly capturedAccounts: readonly Account[];
}

export interface StopRuntimeDialogState {
  readonly open: boolean;
  readonly openId: number;
  readonly target: GlobalStopRuntimeTarget | null;
  readonly submitting: boolean;
  readonly submitError: unknown | null;
}

export interface StopDialogsState {
  readonly stopAll: StopAllDialogState;
  readonly stopRuntime: StopRuntimeDialogState;
}

export interface StopDialogsStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly appData?: Pick<AppDataStore, "ensureSessions" | "refreshSessions" | "getState">;
  readonly guard?: Pick<GuardStore, "beginStopAll" | "beginUserStop" | "recordEndedRuntime">;
  readonly toast?: ToastStore;
  readonly t?: TranslateFn;
}

export interface OpenStopRuntimeOptions {
  readonly onStopped?: (target: GlobalStopRuntimeTarget) => void;
  readonly onClose?: () => void;
}

export interface StopDialogsStore {
  getState(): StopDialogsState;
  subscribe(listener: () => void): () => void;
  openStopAll(): void;
  closeStopAll(): void;
  confirmStopAll(): Promise<void>;
  openStopRuntime(target: GlobalStopRuntimeTarget, options?: OpenStopRuntimeOptions): number;
  closeStopRuntime(): void;
  confirmStopRuntime(): Promise<void>;
  dispose(): void;
}

/**
 * Returns true when a runtime has an armed on-runtime watchdog that will stop
 * billing automatically even if the app closes (mirrors upstream `QUIT_WATCHED_*`).
 */
export function isRuntimeWatchdogProtected(runtime: Runtime): boolean {
  const watchdog = runtime.tracked?.watchdog;
  if (!watchdog) {
    return false;
  }
  return watchdog.armed && !watchdog.cancelled && watchdog.deadline !== null;
}

/**
 * Classifies live runtimes into watched (armed on-runtime auto-stop) and
 * unwatched (unmanaged, cancelled, or app-only) counts for the Stop All dialog.
 */
export function countStopAllProtection(runtimes: readonly Runtime[]): {
  readonly watched: number;
  readonly unwatched: number;
} {
  let watched = 0;
  for (const runtime of runtimes) {
    if (isRuntimeWatchdogProtected(runtime)) {
      watched += 1;
    }
  }
  return {
    watched,
    unwatched: runtimes.length - watched,
  };
}

/**
 * Returns true while the runtime listing has not yet loaded or is actively
 * refreshing, disabling Stop All confirmation until the runtime set is known.
 */
export function isStopAllRuntimesLoading(
  snapshot: Snapshot | null,
  sessionsRefreshing: boolean,
): boolean {
  if (sessionsRefreshing) {
    return true;
  }
  if (snapshot === null) {
    return true;
  }
  return snapshot.runtimes === null && snapshot.runtimes_error === null;
}

function runtimeCardLabel(runtime: Runtime): string {
  const name = runtime.id.name?.trim();
  return name && name.length > 0 ? name : runtime.hardware;
}

function formatFallbackError(error: unknown, t: TranslateFn): {
  readonly message: string;
  readonly hint: string | null;
} {
  if (error instanceof ApiError) {
    const serverKeys = {
      message_key: error.messageKey,
      hint_key: error.hintKey,
    };
    const message = serverKeys.message_key
      ? t(serverKeys.message_key, error.args)
      : t("app.err.other");
    const hint = serverKeys.hint_key ? t(serverKeys.hint_key) : null;
    return { message: message || t("app.err.other"), hint: hint || null };
  }
  return { message: t("app.err.other"), hint: null };
}

const INITIAL_STOP_ALL: StopAllDialogState = {
  open: false,
  openId: 0,
  phase: "confirm",
  result: null,
  submitError: null,
  capturedRuntimes: [],
  capturedAccounts: [],
};

const INITIAL_STOP_RUNTIME: StopRuntimeDialogState = {
  open: false,
  openId: 0,
  target: null,
  submitting: false,
  submitError: null,
};

const INITIAL_STATE: StopDialogsState = {
  stopAll: INITIAL_STOP_ALL,
  stopRuntime: INITIAL_STOP_RUNTIME,
};

/**
 * Creates an isolated global stop-dialog controller store.
 */
export function createStopDialogsStore(
  options: StopDialogsStoreOptions = {},
): StopDialogsStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const appData = options.appData ?? appDataStore;
  const guard = options.guard ?? guardStore;
  const toast = options.toast ?? toastStore;
  const translate = options.t ?? ((key, params) => i18nStore.t(key, params));

  let disposed = false;
  let seq = 0;
  let state: StopDialogsState = INITIAL_STATE;
  let stopRuntimeCallbacks: OpenStopRuntimeOptions | null = null;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all dialog consumers converge.
      }
    }
  };

  const setStopAll = (patch: Partial<StopAllDialogState>): void => {
    state = { ...state, stopAll: { ...state.stopAll, ...patch } };
    emit();
  };

  const setStopRuntime = (patch: Partial<StopRuntimeDialogState>): void => {
    state = { ...state, stopRuntime: { ...state.stopRuntime, ...patch } };
    emit();
  };

  const notifyStopRuntimeClosed = (): void => {
    const callbacks = stopRuntimeCallbacks;
    stopRuntimeCallbacks = null;
    try {
      callbacks?.onClose?.();
    } catch {
      // Isolate caller close callback failures.
    }
  };

  const reset = (): void => {
    stopRuntimeCallbacks = null;
    if (!state.stopAll.open && !state.stopRuntime.open && state.stopAll.result === null) {
      return;
    }
    state = INITIAL_STATE;
    emit();
  };

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (
      event.type === "logged_out" ||
      event.type === "unauthorized" ||
      event.type === "authenticated"
    ) {
      reset();
    }
  });

  return {
    getState(): StopDialogsState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    openStopAll(): void {
      if (disposed) {
        return;
      }
      // Preserve an active submission or unverified report instead of wiping it.
      if (
        state.stopAll.open &&
        (state.stopAll.phase === "submitting" ||
          (state.stopAll.result !== null && !state.stopAll.result.verified))
      ) {
        return;
      }
      seq += 1;
      setStopAll({
        open: true,
        openId: seq,
        phase: "confirm",
        result: null,
        submitError: null,
        capturedRuntimes: [],
        capturedAccounts: [],
      });
      const snapshot = store.getState().snapshot;
      if (snapshot !== null && snapshot.runtimes === null && snapshot.runtimes_error === null) {
        void appData.ensureSessions().catch(() => {});
      }
    },

    closeStopAll(): void {
      if (disposed || state.stopAll.phase === "submitting") {
        return;
      }
      setStopAll({ open: false });
    },

    async confirmStopAll(): Promise<void> {
      if (disposed || !state.stopAll.open || state.stopAll.phase === "submitting") {
        return;
      }
      const snapshot = store.getState().snapshot;
      const sessionsRefreshing = appData.getState().sessionsRefreshing;
      if (isStopAllRuntimesLoading(snapshot, sessionsRefreshing)) {
        return;
      }

      const requestOpenId = state.stopAll.openId;
      const sessionGeneration = client.getSessionGeneration();
      const liveRuntimes = snapshot?.runtimes?.runtimes ?? [];
      const liveAccounts = snapshot?.accounts?.accounts ?? [];
      const preStopRuntimes =
        liveRuntimes.length > 0 ? liveRuntimes : state.stopAll.capturedRuntimes;
      const preStopAccounts =
        liveAccounts.length > 0 ? liveAccounts : state.stopAll.capturedAccounts;

      // Preserve any existing unverified `result` while retrying so the remaining list never clears.
      setStopAll({
        phase: "submitting",
        submitError: null,
        capturedRuntimes: preStopRuntimes,
        capturedAccounts: preStopAccounts,
      });

      const releasePending = guard.beginStopAll();
      try {
        const report = await client.request<StopAllResponse>("/api/sessions/stop-all", {
          method: "POST",
          body: { confirmed: true },
        });
        if (disposed || client.getSessionGeneration() !== sessionGeneration) {
          return;
        }
        const remainingKeys = new Set(
          report.remaining.map((item) => guardRuntimeKey(item.target)),
        );
        const erroredAccounts = new Set(report.account_errors.map((item) => item.account));
        for (const rt of preStopRuntimes) {
          const key = guardRuntimeKey(rt.id);
          if (!remainingKeys.has(key) && !erroredAccounts.has(rt.id.account)) {
            guard.recordEndedRuntime({
              runtime: rt.id,
              label: runtimeCardLabel(rt),
              email: rt.account_email,
              reason: { kind: "user" },
            });
          }
        }
        void store.refreshSnapshot().catch(() => {});

        const dialogStillOpen =
          state.stopAll.open && state.stopAll.openId === requestOpenId;
        if (dialogStillOpen) {
          setStopAll({
            phase: "result",
            result: report,
            submitError: null,
          });
        }
        if (report.verified) {
          toast.push({
            tone: "success",
            body: translate("web.sessions.stop_all_verified"),
          });
        } else if (!dialogStillOpen) {
          toast.push({
            tone: "danger",
            title: translate("web.sessions.stop_all_title"),
            body: translate("web.sessions.stop_all_remaining"),
            durationMs: null,
          });
        }
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) {
          setStopAll({ open: false, phase: "confirm", submitError: null });
          return;
        }
        if (disposed || client.getSessionGeneration() !== sessionGeneration) {
          return;
        }
        void appData.refreshSessions().catch(() => {});

        const dialogStillOpen =
          state.stopAll.open && state.stopAll.openId === requestOpenId;
        if (dialogStillOpen) {
          // Stay on `result` when retrying from an unverified report so the remaining list stays visible.
          setStopAll({
            phase: state.stopAll.result !== null ? "result" : "confirm",
            submitError: error,
          });
        } else {
          const formatted = formatFallbackError(error, translate);
          toast.push({
            tone: "danger",
            title: translate("app.b9.quit_stop_all_failed", { why: formatted.message }),
            body: formatted.hint ?? formatted.message,
            durationMs: null,
          });
        }
      } finally {
        releasePending();
      }
    },

    openStopRuntime(
      target: GlobalStopRuntimeTarget,
      openOptions?: OpenStopRuntimeOptions,
    ): number {
      if (disposed) {
        return 0;
      }
      if (state.stopRuntime.open && state.stopRuntime.submitting) {
        return state.stopRuntime.openId;
      }
      seq += 1;
      stopRuntimeCallbacks = openOptions ?? null;
      setStopRuntime({
        open: true,
        openId: seq,
        target,
        submitting: false,
        submitError: null,
      });
      return seq;
    },

    closeStopRuntime(): void {
      if (disposed || state.stopRuntime.submitting) {
        return;
      }
      setStopRuntime({ open: false, target: null, submitError: null });
      notifyStopRuntimeClosed();
    },

    async confirmStopRuntime(): Promise<void> {
      if (
        disposed ||
        !state.stopRuntime.open ||
        !state.stopRuntime.target ||
        state.stopRuntime.submitting
      ) {
        return;
      }
      const requestOpenId = state.stopRuntime.openId;
      const stopTarget = state.stopRuntime.target;
      const sessionGeneration = client.getSessionGeneration();
      const releasePending = guard.beginUserStop(stopTarget.target);

      setStopRuntime({ submitting: true, submitError: null });
      try {
        await client.request<void>("/api/sessions/stop", {
          method: "POST",
          body: { target: stopTarget.target, confirmed: true },
        });
        if (disposed || client.getSessionGeneration() !== sessionGeneration) {
          return;
        }
        guard.recordEndedRuntime({
          runtime: stopTarget.target,
          label: stopTarget.label,
          email: stopTarget.email,
          reason: { kind: "user" },
        });
        toast.push({
          tone: "success",
          body: translate("app.b2.stop_done", { name: stopTarget.label }),
        });
        void store.refreshSnapshot().catch(() => {});
        if (state.stopRuntime.open && state.stopRuntime.openId === requestOpenId) {
          const callbacks = stopRuntimeCallbacks;
          stopRuntimeCallbacks = null;
          setStopRuntime({
            open: false,
            target: null,
            submitting: false,
            submitError: null,
          });
          try {
            callbacks?.onStopped?.(stopTarget);
            callbacks?.onClose?.();
          } catch {
            // Isolate caller completion callback failures.
          }
        }
      } catch (error) {
        if (error instanceof ApiError && error.isUnauthorized) {
          setStopRuntime({
            open: false,
            target: null,
            submitting: false,
            submitError: null,
          });
          notifyStopRuntimeClosed();
          return;
        }
        if (disposed || client.getSessionGeneration() !== sessionGeneration) {
          return;
        }
        if (error instanceof ApiError && error.kind === "session_gone") {
          void appData.refreshSessions().catch(() => {});
        }
        const dialogStillOpen =
          state.stopRuntime.open && state.stopRuntime.openId === requestOpenId;
        if (dialogStillOpen) {
          setStopRuntime({ submitting: false, submitError: error });
        } else {
          // Matches upstream `state/sessions.rs:265-267`: fallback to danger toast if dialog is closed.
          const formatted = formatFallbackError(error, translate);
          toast.push({
            tone: "danger",
            title: formatted.hint ? formatted.message : undefined,
            body: formatted.hint ?? formatted.message,
          });
        }
      } finally {
        releasePending();
      }
    },

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      listeners.clear();
    },
  };
}

/** Shared global stop-dialog controller store. */
export const stopDialogsStore: StopDialogsStore = createStopDialogsStore();

export function useStopDialogsStore(
  store: StopDialogsStore = stopDialogsStore,
): StopDialogsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
