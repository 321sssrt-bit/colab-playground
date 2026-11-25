/**
 * Light / Dark / Follow-system appearance store synchronized with the
 * synchronous pre-paint `public/theme-init.js` script and `tokens.css`.
 */

import { useSyncExternalStore } from "react";

import type { AppearancePref } from "./types.ts";

export type { AppearancePref } from "./types.ts";

export const APPEARANCE_STORAGE_KEY = "cpg_appearance";

export const APPEARANCE_OPTIONS: readonly AppearancePref[] = ["light", "dark", "system"];

export interface ThemeState {
  readonly preference: AppearancePref;
}

export interface ThemeStoreOptions {
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly doc?: Pick<Document, "documentElement" | "querySelector"> | null;
  readonly win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
}

export interface ThemeStore {
  getState(): ThemeState;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
  setPreference(pref: AppearancePref, options?: { readonly userInitiated?: boolean }): void;
  adoptFromServer(pref: AppearancePref): void;
  shouldPushToServer(): boolean;
  markSynced(expectedVersion?: number): void;
  dispose(): void;
}

export function isAppearancePref(value: unknown): value is AppearancePref {
  return value === "light" || value === "dark" || value === "system";
}

function applyAppearanceToDocument(
  pref: AppearancePref,
  doc: Pick<Document, "documentElement" | "querySelector"> | null,
): void {
  if (!doc) {
    return;
  }
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = pref === "system" ? "light dark" : pref;
  }
  doc.documentElement.dataset.theme = pref;
}

function resolveDefaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Storage may be blocked in restricted browser contexts.
    return null;
  }
}

function readStoredAppearance(
  storage: Pick<Storage, "getItem"> | null,
): { pref: AppearancePref; stored: boolean } {
  if (!storage) {
    return { pref: "system", stored: false };
  }
  try {
    const raw = storage.getItem(APPEARANCE_STORAGE_KEY);
    if (isAppearancePref(raw)) {
      return { pref: raw, stored: raw !== "system" };
    }
  } catch {
    // Ignore storage read failures in restricted browser contexts.
  }
  return { pref: "system", stored: false };
}

function writeStoredAppearance(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  pref: AppearancePref,
): void {
  if (!storage) {
    return;
  }
  try {
    if (pref === "system") {
      storage.removeItem(APPEARANCE_STORAGE_KEY);
    } else {
      storage.setItem(APPEARANCE_STORAGE_KEY, pref);
    }
  } catch {
    // Apply the theme to the page even if persistence is blocked.
  }
}

/**
 * Creates a live appearance store with localStorage persistence and cross-tab sync.
 */
export function createThemeStore(options: ThemeStoreOptions = {}): ThemeStore {
  const storage = options.storage !== undefined ? options.storage : resolveDefaultStorage();
  const doc =
    options.doc !== undefined
      ? options.doc
      : typeof document !== "undefined"
        ? document
        : null;
  const win =
    options.win !== undefined
      ? options.win
      : typeof window !== "undefined"
        ? window
        : null;

  const initial = readStoredAppearance(storage);
  let state: ThemeState = { preference: initial.pref };
  let hasStoredPreference = initial.stored;
  let dirtyBeforeSync = false;
  let preferenceVersion = 0;
  let disposed = false;

  const listeners = new Set<() => void>();

  applyAppearanceToDocument(initial.pref, doc);

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so every consumer observes theme changes.
      }
    }
  };

  const update = (
    pref: AppearancePref,
    opts: { persist: boolean; userInitiated: boolean },
  ): void => {
    if (disposed) {
      return;
    }
    if (opts.persist) {
      writeStoredAppearance(storage, pref);
    }
    hasStoredPreference = pref !== "system";
    if (opts.userInitiated) {
      preferenceVersion += 1;
      dirtyBeforeSync = true;
    }
    applyAppearanceToDocument(pref, doc);
    if (state.preference !== pref) {
      state = { preference: pref };
      emit();
    }
  };

  const onStorage = (event: StorageEvent): void => {
    if (disposed || event.key !== APPEARANCE_STORAGE_KEY) {
      return;
    }
    const nextPref = isAppearancePref(event.newValue) ? event.newValue : "system";
    update(nextPref, { persist: false, userInitiated: false });
  };

  win?.addEventListener("storage", onStorage);

  return {
    getState(): ThemeState {
      return state;
    },

    getVersion(): number {
      return preferenceVersion;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setPreference(pref: AppearancePref, opts: { readonly userInitiated?: boolean } = {}): void {
      update(pref, {
        persist: true,
        userInitiated: opts.userInitiated ?? true,
      });
    },

    adoptFromServer(pref: AppearancePref): void {
      dirtyBeforeSync = false;
      update(pref, { persist: true, userInitiated: false });
    },

    shouldPushToServer(): boolean {
      return dirtyBeforeSync || hasStoredPreference;
    },

    markSynced(expectedVersion?: number): void {
      if (expectedVersion !== undefined && expectedVersion !== preferenceVersion) {
        return;
      }
      dirtyBeforeSync = false;
    },

    dispose(): void {
      disposed = true;
      win?.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}

/** Shared appearance store for the Browser Client. */
export const themeStore: ThemeStore = createThemeStore();

/**
 * React hook subscribing to live appearance preference state.
 */
export function useTheme(store: ThemeStore = themeStore): ThemeState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
