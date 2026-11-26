/**
 * Global read-only release update notice store backed by `GET /api/updates`.
 *
 * Mirrors upstream `crates/app/src/state/updates.rs`, `ui/pages/mod.rs`, and
 * `ui/sidebar.rs` for the Web read-only release link contract: dismissing a
 * version hides the global top banner for that version while keeping the
 * sidebar Settings badge marked until the server runs at least that version.
 */

import { useSyncExternalStore } from "react";

import { apiClient, attachAbortSignal, type ApiClient } from "./api.ts";
import type { UpdateNoticeResponse } from "./types.ts";

export const UPDATE_DISMISSED_STORAGE_KEY = "cpg_update_dismissed_version";
/** Matches backend `UPDATE_RETRY_INTERVAL` (1 hour); server enforces the 24h GitHub throttle. */
const UPDATE_POLL_INTERVAL_MS = 3_600_000;

export interface BannerUpdate {
  readonly version: string;
  readonly url: string;
}

export interface UpdatesState {
  readonly notice: UpdateNoticeResponse | null;
  readonly loading: boolean;
  readonly dismissedVersion: string | null;
  readonly bannerUpdate: BannerUpdate | null;
  readonly badgeVersion: string | null;
}

export interface UpdatesStoreOptions {
  readonly client?: ApiClient;
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  readonly pollIntervalMs?: number;
  readonly setIntervalFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

export interface UpdatesStore {
  getState(): UpdatesState;
  subscribe(listener: () => void): () => void;
  ensureChecked(signal?: AbortSignal): Promise<UpdateNoticeResponse | null>;
  refresh(signal?: AbortSignal): Promise<UpdateNoticeResponse | null>;
  applyNotice(notice: UpdateNoticeResponse): void;
  dismiss(version: string): void;
  dispose(): void;
}

interface InFlightUpdate {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<UpdateNoticeResponse | null>;
}

/**
 * Validates that an external release link uses HTTPS so untrusted or script URLs
 * can never be rendered as clickable anchors.
 */
export function isSafeHttpsUrl(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveDefaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readDismissedVersion(storage: Pick<Storage, "getItem"> | null): string | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(UPDATE_DISMISSED_STORAGE_KEY);
    return raw && raw.trim().length > 0 ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeDismissedVersion(
  storage: Pick<Storage, "setItem"> | null,
  version: string,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(UPDATE_DISMISSED_STORAGE_KEY, version);
  } catch {
    // Keep dismissal active in memory when browser storage is restricted.
  }
}

function deriveUpdateFields(
  notice: UpdateNoticeResponse | null,
  dismissedVersion: string | null,
): Pick<UpdatesState, "bannerUpdate" | "badgeVersion"> {
  if (!notice || !notice.update_available || !notice.latest_version) {
    return { bannerUpdate: null, badgeVersion: null };
  }
  const version = notice.latest_version;
  const url = isSafeHttpsUrl(notice.release_url)
    ? notice.release_url
    : isSafeHttpsUrl(notice.releases_url)
      ? notice.releases_url
      : null;
  return {
    badgeVersion: version,
    bannerUpdate: url && dismissedVersion !== version ? { version, url } : null,
  };
}

/**
 * Creates an isolated global update notice store.
 */
export function createUpdatesStore(options: UpdatesStoreOptions = {}): UpdatesStore {
  const client = options.client ?? apiClient;
  const storage = options.storage !== undefined ? options.storage : resolveDefaultStorage();
  const pollIntervalMs = options.pollIntervalMs ?? UPDATE_POLL_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
  const clearIntervalFn = options.clearIntervalFn ?? globalThis.clearInterval.bind(globalThis);

  let disposed = false;
  let checkedGeneration: number | null = null;
  let inFlight: InFlightUpdate | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let state: UpdatesState = {
    notice: null,
    loading: false,
    dismissedVersion: readDismissedVersion(storage),
    bannerUpdate: null,
    badgeVersion: null,
  };

  const listeners = new Set<() => void>();

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = (): void => {
    stopPolling();
    if (disposed || pollIntervalMs <= 0 || !client.isAuthenticated()) {
      return;
    }
    pollTimer = setIntervalFn(() => {
      if (!disposed && client.isAuthenticated()) {
        void startFetch();
      }
    }, pollIntervalMs);
  };

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber failures so all shell listeners converge.
      }
    }
  };

  const updateState = (patch: {
    notice?: UpdateNoticeResponse | null;
    loading?: boolean;
    dismissedVersion?: string | null;
  }): void => {
    const notice = patch.notice !== undefined ? patch.notice : state.notice;
    const loading = patch.loading !== undefined ? patch.loading : state.loading;
    const dismissedVersion =
      patch.dismissedVersion !== undefined ? patch.dismissedVersion : state.dismissedVersion;
    const derived = deriveUpdateFields(notice, dismissedVersion);
    if (
      notice === state.notice &&
      loading === state.loading &&
      dismissedVersion === state.dismissedVersion &&
      derived.badgeVersion === state.badgeVersion &&
      derived.bannerUpdate?.version === state.bannerUpdate?.version &&
      derived.bannerUpdate?.url === state.bannerUpdate?.url
    ) {
      return;
    }
    state = {
      notice,
      loading,
      dismissedVersion,
      bannerUpdate: derived.bannerUpdate,
      badgeVersion: derived.badgeVersion,
    };
    emit();
  };

  const resetSession = (): void => {
    stopPolling();
    inFlight?.controller.abort();
    inFlight = null;
    checkedGeneration = null;
    updateState({ notice: null, loading: false });
  };

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (event.type === "logged_out" || event.type === "unauthorized") {
      resetSession();
    } else if (event.type === "authenticated") {
      resetSession();
      startPolling();
    }
  });

  if (client.isAuthenticated()) {
    startPolling();
  }

  const startFetch = (signal?: AbortSignal): Promise<UpdateNoticeResponse | null> => {
    if (disposed || !client.isAuthenticated()) {
      return Promise.resolve(null);
    }
    const generation = client.getSessionGeneration();
    if (inFlight !== null && inFlight.generation === generation) {
      return attachAbortSignal(inFlight.promise, signal);
    }
    const controller = new AbortController();
    updateState({ loading: true });
    const promise = client
      .request<UpdateNoticeResponse>("/api/updates", {
        method: "GET",
        signal: controller.signal,
      })
      .then((notice) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          checkedGeneration = generation;
          updateState({ notice, loading: false });
        }
        return notice;
      })
      .catch(() => {
        if (!disposed && client.getSessionGeneration() === generation) {
          // Automatic update checks fail quietly outside Settings → About.
          checkedGeneration = generation;
          updateState({ loading: false });
        }
        return null;
      })
      .finally(() => {
        if (inFlight?.promise === promise) {
          inFlight = null;
        }
      });
    inFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  return {
    getState(): UpdatesState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ensureChecked(signal?: AbortSignal): Promise<UpdateNoticeResponse | null> {
      if (disposed || !client.isAuthenticated()) {
        return Promise.resolve(null);
      }
      const generation = client.getSessionGeneration();
      if (checkedGeneration === generation && state.notice !== null) {
        return Promise.resolve(state.notice);
      }
      return startFetch(signal);
    },

    refresh(signal?: AbortSignal): Promise<UpdateNoticeResponse | null> {
      return startFetch(signal);
    },

    applyNotice(notice: UpdateNoticeResponse): void {
      if (disposed) {
        return;
      }
      checkedGeneration = client.getSessionGeneration();
      updateState({ notice, loading: false });
    },

    dismiss(version: string): void {
      if (disposed || !version.trim()) {
        return;
      }
      const trimmed = version.trim();
      writeDismissedVersion(storage, trimmed);
      updateState({ dismissedVersion: trimmed });
    },

    dispose(): void {
      disposed = true;
      stopPolling();
      unsubscribeAuth();
      inFlight?.controller.abort();
      inFlight = null;
      listeners.clear();
    },
  };
}

/** Shared global update notice store for the Browser Client. */
export const updatesStore: UpdatesStore = createUpdatesStore();

export function useUpdatesStore(store: UpdatesStore = updatesStore): UpdatesState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
