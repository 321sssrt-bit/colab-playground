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
import type { RuntimeDefaultsPatch } from "./api.ts";
import {
  defaultsToDraft,
  isDraftDirty,
  type DefaultsDraft,
  type DefaultsFieldKey,
  type DurationDraft,
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
  reconcileSavedDefaults(updatedDefaults: RuntimeDefaults, savedPatch: RuntimeDefaultsPatch): void;
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

function durationEqual(a: DurationDraft, b: DurationDraft, withSeconds: boolean): boolean {
  return (
    a.hours.trim() === b.hours.trim() &&
    a.minutes.trim() === b.minutes.trim() &&
    (!withSeconds || a.seconds.trim() === b.seconds.trim())
  );
}

function isFieldEdited(
  draft: DefaultsDraft,
  base: DefaultsDraft,
  field: DefaultsFieldKey,
): boolean {
  switch (field) {
    case "max_runtime":
      return (
        draft.max_runtime_enabled !== base.max_runtime_enabled ||
        (draft.max_runtime_enabled && !durationEqual(draft.max_runtime, base.max_runtime, false))
      );
    case "max_spend_cu":
      return (
        draft.max_spend_enabled !== base.max_spend_enabled ||
        (draft.max_spend_enabled && draft.max_spend_cu.trim() !== base.max_spend_cu.trim())
      );
    case "min_balance_cu":
      return (
        draft.min_balance_enabled !== base.min_balance_enabled ||
        (draft.min_balance_enabled && draft.min_balance_cu.trim() !== base.min_balance_cu.trim())
      );
    case "idle_timeout":
      return (
        draft.idle_timeout_enabled !== base.idle_timeout_enabled ||
        (draft.idle_timeout_enabled && !durationEqual(draft.idle_timeout, base.idle_timeout, false))
      );
    case "max_concurrent_sessions":
      return draft.max_concurrent_sessions.trim() !== base.max_concurrent_sessions.trim();
    case "max_attempts":
      return draft.max_attempts.trim() !== base.max_attempts.trim();
    case "retry_delay":
      return !durationEqual(draft.retry_delay, base.retry_delay, true);
    case "on_exhausted":
      return draft.on_exhausted !== base.on_exhausted;
    case "usage_poll_active":
      return !durationEqual(draft.usage_poll_active, base.usage_poll_active, true);
    case "usage_poll_idle":
      return !durationEqual(draft.usage_poll_idle, base.usage_poll_idle, true);
    case "accelerator":
      return draft.accelerator !== base.accelerator;
    case "high_mem":
      return draft.high_mem !== base.high_mem;
    case "min_vram_mib":
      return (
        draft.min_vram_enabled !== base.min_vram_enabled ||
        (draft.min_vram_enabled && draft.min_vram_gib.trim() !== base.min_vram_gib.trim())
      );
    case "winddown_grace":
      return !durationEqual(draft.winddown_grace, base.winddown_grace, true);
  }
}

function copyDraftField(
  target: { -readonly [K in keyof DefaultsDraft]: DefaultsDraft[K] },
  source: DefaultsDraft,
  field: DefaultsFieldKey,
): void {
  switch (field) {
    case "max_runtime":
      target.max_runtime_enabled = source.max_runtime_enabled;
      target.max_runtime = source.max_runtime;
      break;
    case "max_spend_cu":
      target.max_spend_enabled = source.max_spend_enabled;
      target.max_spend_cu = source.max_spend_cu;
      break;
    case "min_balance_cu":
      target.min_balance_enabled = source.min_balance_enabled;
      target.min_balance_cu = source.min_balance_cu;
      break;
    case "idle_timeout":
      target.idle_timeout_enabled = source.idle_timeout_enabled;
      target.idle_timeout = source.idle_timeout;
      break;
    case "min_vram_mib":
      target.min_vram_enabled = source.min_vram_enabled;
      target.min_vram_gib = source.min_vram_gib;
      break;
    case "max_concurrent_sessions":
      target.max_concurrent_sessions = source.max_concurrent_sessions;
      break;
    case "max_attempts":
      target.max_attempts = source.max_attempts;
      break;
    case "retry_delay":
      target.retry_delay = source.retry_delay;
      break;
    case "on_exhausted":
      target.on_exhausted = source.on_exhausted;
      break;
    case "accelerator":
      target.accelerator = source.accelerator;
      break;
    case "high_mem":
      target.high_mem = source.high_mem;
      break;
    case "winddown_grace":
      target.winddown_grace = source.winddown_grace;
      break;
    case "usage_poll_active":
      target.usage_poll_active = source.usage_poll_active;
      break;
    case "usage_poll_idle":
      target.usage_poll_idle = source.usage_poll_idle;
      break;
  }
}

const ALL_DEFAULT_KEYS: readonly DefaultsFieldKey[] = [
  "max_runtime",
  "max_spend_cu",
  "min_balance_cu",
  "idle_timeout",
  "max_concurrent_sessions",
  "max_attempts",
  "retry_delay",
  "on_exhausted",
  "usage_poll_active",
  "usage_poll_idle",
  "accelerator",
  "high_mem",
  "min_vram_mib",
  "winddown_grace",
];

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
    if (!entry) {
      return {
        draft: defaultsToDraft(serverDefaults),
        forceInclude: new Set<DefaultsFieldKey>(),
      };
    }
    if (runtimeDefaultsEqual(entry.baseServerDefaults, serverDefaults)) {
      return { draft: entry.draft, forceInclude: entry.forceInclude };
    }
    // Three-way merge: preserve unsaved user edits on fields untouched by the server update,
    // and adopt server values for fields that changed on the server unless still divergently edited.
    const oldBaseDraft = defaultsToDraft(entry.baseServerDefaults);
    const nextServerDraft = defaultsToDraft(serverDefaults);
    const mergedDraft: { -readonly [K in keyof DefaultsDraft]: DefaultsDraft[K] } = {
      ...nextServerDraft,
    };
    const mergedForce = new Set<DefaultsFieldKey>();

    for (const field of ALL_DEFAULT_KEYS) {
      const serverChanged = entry.baseServerDefaults[field] !== serverDefaults[field];
      const userEdited =
        entry.forceInclude.has(field) || isFieldEdited(entry.draft, oldBaseDraft, field);
      if (!userEdited) {
        continue;
      }
      if (!serverChanged || isFieldEdited(entry.draft, nextServerDraft, field)) {
        copyDraftField(mergedDraft, entry.draft, field);
        if (entry.forceInclude.has(field)) {
          mergedForce.add(field);
        }
      }
    }

    return { draft: mergedDraft, forceInclude: mergedForce };
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

    reconcileSavedDefaults(
      updatedDefaults: RuntimeDefaults,
      savedPatch: RuntimeDefaultsPatch,
    ): void {
      const entry = state.defaultsEntry;
      if (!entry) {
        return;
      }
      const savedDraft = defaultsToDraft(updatedDefaults);
      const nextDraft: { -readonly [K in keyof DefaultsDraft]: DefaultsDraft[K] } = {
        ...entry.draft,
      };
      const nextForce = new Set(entry.forceInclude);
      for (const key of Object.keys(savedPatch) as DefaultsFieldKey[]) {
        nextForce.delete(key);
        copyDraftField(nextDraft, savedDraft, key);
      }
      saveDefaultsDraft(updatedDefaults, nextDraft, nextForce);
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
