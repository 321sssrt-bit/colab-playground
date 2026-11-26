/**
 * Session-scoped draft persistence for Settings forms (Defaults and Host CLI paths).
 *
 * Preserves unsaved form edits when navigating between pages, keeps the pinned
 * LimitFocusCard and DefaultsSection synchronized, and clears all drafts on
 * sign-out or session expiration.
 */

import { useSyncExternalStore } from "react";

import { apiClient, type ApiClient } from "../../lib/api.ts";
import type { RuntimeDefaults } from "../../lib/constants.ts";
import {
  defaultsToDraft,
  isDraftDirty,
  type DefaultsDraft,
  type DefaultsFieldKey,
} from "./draft.ts";

export interface DefaultsDraftEntry {
  readonly baseServerDefaults: RuntimeDefaults;
  readonly draft: DefaultsDraft;
  readonly forceInclude: ReadonlySet<DefaultsFieldKey>;
}

export interface HostDraftEntry {
  readonly baseColabPath: string;
  readonly baseColabPython: string;
  readonly colabPath: string;
  readonly colabPython: string;
}

export interface SettingsDraftState {
  readonly defaultsEntry: DefaultsDraftEntry | null;
  readonly hostEntry: HostDraftEntry | null;
}

export interface SettingsDraftStore {
  getState(): SettingsDraftState;
  subscribe(listener: () => void): () => void;
  resolveDefaultsDraft(serverDefaults: RuntimeDefaults): {
    readonly draft: DefaultsDraft;
    readonly forceInclude: ReadonlySet<DefaultsFieldKey>;
  };
  saveDefaultsDraft(
    serverDefaults: RuntimeDefaults,
    draft: DefaultsDraft,
    forceInclude: ReadonlySet<DefaultsFieldKey>,
  ): void;
  updateConcurrentLimitDraft(serverDefaults: RuntimeDefaults, value: string): void;
  reconcileSavedConcurrentLimit(updatedDefaults: RuntimeDefaults): void;
  clearDefaultsDraft(): void;
  resolveHostDraft(
    serverColabPath: string | null,
    serverColabPython: string | null,
  ): { readonly colabPath: string; readonly colabPython: string };
  saveHostDraft(
    serverColabPath: string | null,
    serverColabPython: string | null,
    colabPath: string,
    colabPython: string,
  ): void;
  clearHostDraft(): void;
  clearAll(): void;
  dispose(): void;
}

function runtimeDefaultsEqual(a: RuntimeDefaults, b: RuntimeDefaults): boolean {
  return (
    a.max_runtime === b.max_runtime &&
    a.max_spend_cu === b.max_spend_cu &&
    a.min_balance_cu === b.min_balance_cu &&
    a.idle_timeout === b.idle_timeout &&
    a.max_concurrent_sessions === b.max_concurrent_sessions &&
    a.max_attempts === b.max_attempts &&
    a.retry_delay === b.retry_delay &&
    a.on_exhausted === b.on_exhausted &&
    a.usage_poll_active === b.usage_poll_active &&
    a.usage_poll_idle === b.usage_poll_idle &&
    a.accelerator === b.accelerator &&
    a.high_mem === b.high_mem &&
    a.min_vram_mib === b.min_vram_mib &&
    a.winddown_grace === b.winddown_grace
  );
}

/**
 * Creates a session-scoped Settings draft store bound to an API client's auth lifecycle.
 */
export function createSettingsDraftStore(client: ApiClient = apiClient): SettingsDraftStore {
  let disposed = false;
  let state: SettingsDraftState = {
    defaultsEntry: null,
    hostEntry: null,
  };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all Settings controls stay synchronized.
      }
    }
  };

  const setState = (next: SettingsDraftState): void => {
    if (next.defaultsEntry === state.defaultsEntry && next.hostEntry === state.hostEntry) {
      return;
    }
    state = next;
    emit();
  };

  const clearAll = (): void => {
    setState({ defaultsEntry: null, hostEntry: null });
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
      clearAll();
    }
  });

  const resolveDefaultsDraft = (
    serverDefaults: RuntimeDefaults,
  ): {
    readonly draft: DefaultsDraft;
    readonly forceInclude: ReadonlySet<DefaultsFieldKey>;
  } => {
    const entry = state.defaultsEntry;
    if (entry && runtimeDefaultsEqual(entry.baseServerDefaults, serverDefaults)) {
      return { draft: entry.draft, forceInclude: entry.forceInclude };
    }
    return {
      draft: defaultsToDraft(serverDefaults),
      forceInclude: new Set<DefaultsFieldKey>(),
    };
  };

  const saveDefaultsDraft = (
    serverDefaults: RuntimeDefaults,
    draft: DefaultsDraft,
    forceInclude: ReadonlySet<DefaultsFieldKey>,
  ): void => {
    if (!isDraftDirty(draft, serverDefaults, forceInclude)) {
      if (state.defaultsEntry !== null) {
        setState({ ...state, defaultsEntry: null });
      }
      return;
    }
    setState({
      ...state,
      defaultsEntry: {
        baseServerDefaults: serverDefaults,
        draft,
        forceInclude,
      },
    });
  };

  return {
    getState(): SettingsDraftState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    resolveDefaultsDraft,

    saveDefaultsDraft,

    updateConcurrentLimitDraft(serverDefaults: RuntimeDefaults, value: string): void {
      const current = resolveDefaultsDraft(serverDefaults);
      const nextDraft: DefaultsDraft = {
        ...current.draft,
        max_concurrent_sessions: value,
      };
      const nextForce = new Set(current.forceInclude);
      nextForce.delete("max_concurrent_sessions");
      saveDefaultsDraft(serverDefaults, nextDraft, nextForce);
    },

    reconcileSavedConcurrentLimit(updatedDefaults: RuntimeDefaults): void {
      const entry = state.defaultsEntry;
      if (!entry) {
        return;
      }
      const nextDraft: DefaultsDraft = {
        ...entry.draft,
        max_concurrent_sessions: String(updatedDefaults.max_concurrent_sessions),
      };
      const nextForce = new Set(entry.forceInclude);
      nextForce.delete("max_concurrent_sessions");
      saveDefaultsDraft(updatedDefaults, nextDraft, nextForce);
    },

    clearDefaultsDraft(): void {
      if (state.defaultsEntry !== null) {
        setState({ ...state, defaultsEntry: null });
      }
    },

    resolveHostDraft(
      serverColabPath: string | null,
      serverColabPython: string | null,
    ): { readonly colabPath: string; readonly colabPython: string } {
      const basePath = serverColabPath ?? "";
      const basePython = serverColabPython ?? "";
      const entry = state.hostEntry;
      if (entry && entry.baseColabPath === basePath && entry.baseColabPython === basePython) {
        return { colabPath: entry.colabPath, colabPython: entry.colabPython };
      }
      return { colabPath: basePath, colabPython: basePython };
    },

    saveHostDraft(
      serverColabPath: string | null,
      serverColabPython: string | null,
      colabPath: string,
      colabPython: string,
    ): void {
      const basePath = serverColabPath ?? "";
      const basePython = serverColabPython ?? "";
      if (colabPath === basePath && colabPython === basePython) {
        if (state.hostEntry !== null) {
          setState({ ...state, hostEntry: null });
        }
        return;
      }
      setState({
        ...state,
        hostEntry: {
          baseColabPath: basePath,
          baseColabPython: basePython,
          colabPath,
          colabPython,
        },
      });
    },

    clearHostDraft(): void {
      if (state.hostEntry !== null) {
        setState({ ...state, hostEntry: null });
      }
    },

    clearAll,

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      listeners.clear();
    },
  };
}

/** Shared Settings draft store for the Browser Client. */
export const settingsDraftStore: SettingsDraftStore = createSettingsDraftStore();

export function useSettingsDraftStore(
  store: SettingsDraftStore = settingsDraftStore,
): SettingsDraftState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
