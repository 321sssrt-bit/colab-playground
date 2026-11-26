/**
 * Application-wide cache for the installed plugins catalog and Hugging Face token
 * status. Persists across route switches so revisiting Plugins or opening deploy/token
 * dialogs does not re-spawn Python keyring checks, while ensuring failed checks always
 * transition to an explicit `error` state instead of retaining a stale `saved: true`.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, attachAbortSignal, type ApiClient } from "../../lib/api.ts";
import { webStore, type WebStore } from "../../lib/store.ts";
import type { Locale, PendingOperation } from "../../lib/types.ts";
import {
  deleteHfToken as apiDeleteHfToken,
  getHfTokenStatus as apiGetHfTokenStatus,
  listPlugins as apiListPlugins,
  resolveLocalizedText,
  saveHfToken as apiSaveHfToken,
} from "./api.ts";
import type { HfTokenState, HfTokenStatus, PluginInfo } from "./types.ts";

export interface PluginCacheState {
  readonly plugins: readonly PluginInfo[] | null;
  readonly pluginsLoading: boolean;
  readonly pluginsError: unknown | null;
  readonly hfToken: HfTokenState;
}

export interface PluginCacheStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
}

export interface PluginCacheStore {
  getState(): PluginCacheState;
  subscribe(listener: () => void): () => void;
  /** Returns cached plugins when present; otherwise deduplicates a single `GET /api/plugins`. */
  ensurePlugins(signal?: AbortSignal): Promise<readonly PluginInfo[]>;
  /** Forces a fresh deduplicated `GET /api/plugins`, preserving existing items while loading. */
  refreshPlugins(signal?: AbortSignal): Promise<readonly PluginInfo[]>;
  /** Optimistically reflects a committed enable/disable toggle in the cached list. */
  setPluginEnabledLocal(id: string, enabled: boolean): void;
  /** Looks up a cached plugin manifest by ID. */
  getPluginById(id: string): PluginInfo | null;
  /** Resolves the localized display name for `id` from the cached catalog (falls back to `id`). */
  resolvePluginName(id: string, locale: Locale): string;
  /** Returns cached ready HF token state without touching the keyring; fetches when idle or errored. */
  ensureHfTokenStatus(signal?: AbortSignal): Promise<HfTokenState>;
  /** Forces a fresh `GET /api/plugins/hf/token`; failures overwrite any stale `saved: true`. */
  refreshHfTokenStatus(options?: {
    readonly silent?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<HfTokenState>;
  /** Persists a Hugging Face token via `PUT /api/plugins/hf/token` and updates the global cache. */
  saveHfToken(token: string, signal?: AbortSignal): Promise<HfTokenStatus>;
  /** Deletes the stored Hugging Face token via `DELETE /api/plugins/hf/token` and updates cache. */
  deleteHfToken(signal?: AbortSignal): Promise<HfTokenStatus>;
  dispose(): void;
}

interface InFlight<T> {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
}

const INITIAL_STATE: PluginCacheState = {
  plugins: null,
  pluginsLoading: false,
  pluginsError: null,
  hfToken: { kind: "idle" },
};

function hasHfTokenOp(operations: readonly PendingOperation[] | undefined): boolean {
  if (!operations) {
    return false;
  }
  return operations.some(
    ({ operation }) => operation.kind === "domain" && operation.name === "hf_token",
  );
}

/**
 * Creates an isolated global cache for the installed plugins list and HF token status.
 */
export function createPluginCacheStore(
  options: PluginCacheStoreOptions = {},
): PluginCacheStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;

  let state: PluginCacheState = INITIAL_STATE;
  let disposed = false;
  let pluginsSeq = 0;
  let tokenSeq = 0;
  let localTokenMutationActive = false;
  let prevExternalHfTokenBusy = hasHfTokenOp(store.getState().snapshot?.operations);

  let pluginsInFlight: InFlight<readonly PluginInfo[]> | null = null;
  let tokenCheckInFlight: InFlight<HfTokenState> | null = null;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all plugin consumers stay synchronized.
      }
    }
  };

  const setState = (patch: Partial<PluginCacheState>): void => {
    const next: PluginCacheState = { ...state, ...patch };
    if (
      next.plugins === state.plugins &&
      next.pluginsLoading === state.pluginsLoading &&
      next.pluginsError === state.pluginsError &&
      next.hfToken === state.hfToken
    ) {
      return;
    }
    state = next;
    emit();
  };

  const abortAllInFlight = (): void => {
    pluginsInFlight?.controller.abort();
    pluginsInFlight = null;
    tokenCheckInFlight?.controller.abort();
    tokenCheckInFlight = null;
    pluginsSeq += 1;
    tokenSeq += 1;
  };

  const reset = (): void => {
    abortAllInFlight();
    localTokenMutationActive = false;
    prevExternalHfTokenBusy = false;
    setState(INITIAL_STATE);
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

  const refreshPlugins = (signal?: AbortSignal): Promise<readonly PluginInfo[]> => {
    const generation = client.getSessionGeneration();
    if (pluginsInFlight !== null && pluginsInFlight.generation === generation) {
      return attachAbortSignal(pluginsInFlight.promise, signal);
    }
    const seq = ++pluginsSeq;
    const controller = new AbortController();
    setState({ pluginsLoading: true, pluginsError: null });
    const promise = apiListPlugins(controller.signal, client)
      .then((items) => {
        if (!disposed && client.getSessionGeneration() === generation && seq === pluginsSeq) {
          setState({
            plugins: items,
            pluginsLoading: false,
            pluginsError: null,
          });
        }
        return items;
      })
      .catch((error: unknown) => {
        if (!disposed && client.getSessionGeneration() === generation && seq === pluginsSeq) {
          if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
            setState({ pluginsLoading: false });
          } else {
            setState({
              pluginsLoading: false,
              pluginsError: error,
            });
          }
        }
        throw error;
      })
      .finally(() => {
        if (pluginsInFlight?.promise === promise) {
          pluginsInFlight = null;
        }
      });
    pluginsInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const refreshHfTokenStatus = (opts?: {
    readonly silent?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<HfTokenState> => {
    const generation = client.getSessionGeneration();
    if (tokenCheckInFlight !== null && tokenCheckInFlight.generation === generation) {
      return attachAbortSignal(tokenCheckInFlight.promise, opts?.signal);
    }
    const seq = ++tokenSeq;
    const controller = new AbortController();
    if (!opts?.silent) {
      setState({ hfToken: { kind: "loading" } });
    }
    const promise = apiGetHfTokenStatus(controller.signal, client)
      .then((res): HfTokenState => {
        const next: HfTokenState = { kind: "ready", saved: res.saved };
        if (!disposed && client.getSessionGeneration() === generation && seq === tokenSeq) {
          setState({ hfToken: next });
        }
        return next;
      })
      .catch((error: unknown): HfTokenState => {
        if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
          throw error;
        }
        // Explicitly overwrite any prior `ready` state so a failed keyring check is never masked
        // by a stale `saved: true`.
        const next: HfTokenState = { kind: "error", error };
        if (!disposed && client.getSessionGeneration() === generation && seq === tokenSeq) {
          setState({ hfToken: next });
        }
        return next;
      })
      .finally(() => {
        if (tokenCheckInFlight?.promise === promise) {
          tokenCheckInFlight = null;
        }
      });
    tokenCheckInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, opts?.signal);
  };

  const unsubscribeStore = store.subscribe(() => {
    if (disposed) {
      return;
    }
    const busy = hasHfTokenOp(store.getState().snapshot?.operations);
    const finishedExternally = prevExternalHfTokenBusy && !busy && !localTokenMutationActive;
    prevExternalHfTokenBusy = busy;
    if (finishedExternally && state.hfToken.kind !== "idle" && client.isAuthenticated()) {
      void refreshHfTokenStatus({ silent: true }).catch(() => {});
    }
  });

  return {
    getState(): PluginCacheState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ensurePlugins(signal?: AbortSignal): Promise<readonly PluginInfo[]> {
      if (state.plugins !== null) {
        return Promise.resolve(state.plugins);
      }
      return refreshPlugins(signal);
    },

    refreshPlugins,

    setPluginEnabledLocal(id: string, enabled: boolean): void {
      if (state.plugins === null) {
        return;
      }
      setState({
        plugins: state.plugins.map((item) =>
          item.manifest.id === id ? { ...item, enabled } : item,
        ),
      });
    },

    getPluginById(id: string): PluginInfo | null {
      return state.plugins?.find((item) => item.manifest.id === id) ?? null;
    },

    resolvePluginName(id: string, locale: Locale): string {
      const matched = state.plugins?.find((item) => item.manifest.id === id) ?? null;
      return matched ? resolveLocalizedText(matched.manifest.name, locale, matched.manifest.id) : id;
    },

    ensureHfTokenStatus(signal?: AbortSignal): Promise<HfTokenState> {
      if (state.hfToken.kind === "ready") {
        return Promise.resolve(state.hfToken);
      }
      return refreshHfTokenStatus({ signal });
    },

    refreshHfTokenStatus,

    async saveHfToken(token: string, signal?: AbortSignal): Promise<HfTokenStatus> {
      const generation = client.getSessionGeneration();
      tokenCheckInFlight?.controller.abort();
      tokenCheckInFlight = null;
      const seq = ++tokenSeq;
      localTokenMutationActive = true;
      try {
        const result = await apiSaveHfToken(token, signal, client);
        if (!disposed && client.getSessionGeneration() === generation && seq === tokenSeq) {
          setState({ hfToken: { kind: "ready", saved: result.saved } });
        }
        return result;
      } catch (error) {
        if (
          !disposed &&
          client.getSessionGeneration() === generation &&
          seq === tokenSeq &&
          !(error instanceof ApiError && (error.isAbort || error.isUnauthorized)) &&
          state.hfToken.kind === "loading"
        ) {
          void refreshHfTokenStatus().catch(() => {});
        }
        throw error;
      } finally {
        localTokenMutationActive = false;
      }
    },

    async deleteHfToken(signal?: AbortSignal): Promise<HfTokenStatus> {
      const generation = client.getSessionGeneration();
      tokenCheckInFlight?.controller.abort();
      tokenCheckInFlight = null;
      const seq = ++tokenSeq;
      localTokenMutationActive = true;
      try {
        const result = await apiDeleteHfToken(signal, client);
        if (!disposed && client.getSessionGeneration() === generation && seq === tokenSeq) {
          setState({ hfToken: { kind: "ready", saved: result.saved } });
        }
        return result;
      } finally {
        localTokenMutationActive = false;
      }
    },

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      unsubscribeStore();
      abortAllInFlight();
      listeners.clear();
    },
  };
}

/** Shared global cache for installed plugins and Hugging Face token status. */
export const pluginCacheStore: PluginCacheStore = createPluginCacheStore();

/** React hook subscribing a component to the global plugins and HF token cache. */
export function usePluginCacheStore(
  store: PluginCacheStore = pluginCacheStore,
): PluginCacheState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
