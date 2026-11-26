/**
 * Serialized preference synchronization between browser stores and `/api/settings`.
 *
 * All login-sync and post-login preference writes flow through one ordered
 * pipeline per auth session so an older login-sync PATCH can never land on the
 * server after a newer user change. Save failures are surfaced to subscribers
 * so the UI reports persistence errors instead of swallowing them.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient } from "./api.ts";
import { i18nStore, isLanguagePref, type I18nStore } from "./i18n.ts";
import { isAppearancePref, themeStore, type ThemeStore } from "./theme.ts";
import type { AppearancePref, LanguagePref, SettingsPatch, SettingsView } from "./types.ts";

export type PreferenceField = "language" | "appearance";

export interface PreferenceSaveError {
  readonly id: number;
  readonly fields: readonly PreferenceField[];
  readonly error: unknown;
}

export interface PreferenceSyncState {
  readonly saving: boolean;
  readonly lastError: PreferenceSaveError | null;
}

export interface PreferenceSyncOptions {
  readonly onSettingsLoaded?: (view: SettingsView) => void;
}

export interface PreferenceSync {
  getState(): PreferenceSyncState;
  subscribe(listener: () => void): () => void;
  syncSession(signal?: AbortSignal, options?: PreferenceSyncOptions): void;
  cancelPending(): void;
  setLanguage(pref: LanguagePref): void;
  setAppearance(pref: AppearancePref): void;
  retryLastFailed(): void;
  clearError(): void;
}

function isIgnorableSaveError(error: unknown): boolean {
  return error instanceof ApiError && (error.isAbort || error.isUnauthorized);
}

/**
 * Creates a serialized preference synchronizer bound to an API client and local stores.
 */
export function createPreferenceSync(
  client: ApiClient = apiClient,
  i18n: I18nStore = i18nStore,
  theme: ThemeStore = themeStore,
): PreferenceSync {
  let queue: Promise<void> = Promise.resolve();
  let activeController: AbortController | null = null;
  let pendingLanguage = false;
  let pendingAppearance = false;
  let flushScheduled = false;
  let errorSeq = 0;
  let state: PreferenceSyncState = {
    saving: false,
    lastError: null,
  };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so preference state listeners converge.
      }
    }
  };

  const setState = (next: PreferenceSyncState): void => {
    if (next.saving === state.saving && next.lastError === state.lastError) {
      return;
    }
    state = next;
    emit();
  };

  const isGenerationLive = (generation: number, signal?: AbortSignal): boolean => {
    return (
      !signal?.aborted &&
      client.isAuthenticated() &&
      client.getSessionGeneration() === generation
    );
  };

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(task, task);
  };

  const patchPreferences = async (
    generation: number,
    signal: AbortSignal | undefined,
    patch: SettingsPatch,
    langVersion: number | undefined,
    appearanceVersion: number | undefined,
    onSettingsLoaded?: (view: SettingsView) => void,
  ): Promise<void> => {
    const fields: PreferenceField[] = [];
    if (patch.language !== undefined) {
      fields.push("language");
    }
    if (patch.appearance !== undefined) {
      fields.push("appearance");
    }
    if (fields.length === 0) {
      return;
    }

    setState({ saving: true, lastError: null });
    try {
      const updated = await client.request<SettingsView>("/api/settings", {
        method: "PATCH",
        body: patch,
        signal,
      });
      if (isGenerationLive(generation, signal)) {
        if (langVersion !== undefined) {
          i18n.markSynced(langVersion);
        }
        if (appearanceVersion !== undefined) {
          theme.markSynced(appearanceVersion);
        }
        onSettingsLoaded?.(updated);
        setState({ saving: false, lastError: null });
      }
    } catch (error: unknown) {
      if (!isGenerationLive(generation, signal) || isIgnorableSaveError(error)) {
        if (state.saving) {
          setState({ saving: false, lastError: state.lastError });
        }
        return;
      }
      // Keep the browser choice active locally while surfacing the persistence failure.
      errorSeq += 1;
      setState({
        saving: false,
        lastError: {
          id: errorSeq,
          fields,
          error,
        },
      });
    }
  };

  const scheduleFlush = (generation: number): void => {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;

    enqueue(async () => {
      flushScheduled = false;
      const signal = activeController?.signal;
      if (!isGenerationLive(generation, signal)) {
        pendingLanguage = false;
        pendingAppearance = false;
        return;
      }

      const patch: SettingsPatch = {};
      let langVersion: number | undefined;
      let appearanceVersion: number | undefined;

      if (pendingLanguage) {
        pendingLanguage = false;
        langVersion = i18n.getVersion();
        patch.language = i18n.getState().preference;
      }
      if (pendingAppearance) {
        pendingAppearance = false;
        appearanceVersion = theme.getVersion();
        patch.appearance = theme.getState().preference;
      }

      await patchPreferences(generation, signal, patch, langVersion, appearanceVersion);
    });
  };

  const resetController = (externalSignal?: AbortSignal): AbortController => {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    return controller;
  };

  return {
    getState(): PreferenceSyncState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    syncSession(externalSignal?: AbortSignal, options?: PreferenceSyncOptions): void {
      if (!client.isAuthenticated()) {
        return;
      }
      const generation = client.getSessionGeneration();
      const controller = resetController(externalSignal);
      const startLangVersion = i18n.getVersion();
      const startAppearanceVersion = theme.getVersion();
      setState({ saving: false, lastError: null });

      enqueue(async () => {
        const signal = controller.signal;
        if (!isGenerationLive(generation, signal)) {
          return;
        }

        let server: SettingsView;
        try {
          server = await client.request<SettingsView>("/api/settings", {
            method: "GET",
            signal,
          });
        } catch {
          return;
        }

        if (!isGenerationLive(generation, signal)) {
          return;
        }

        options?.onSettingsLoaded?.(server);

        const patch: SettingsPatch = {};
        let pushLangVersion: number | undefined;
        let pushAppearanceVersion: number | undefined;

        if (i18n.getVersion() === startLangVersion) {
          const localLanguage = i18n.getState().preference;
          if (i18n.shouldPushToServer()) {
            if (server.language !== localLanguage) {
              patch.language = localLanguage;
              pushLangVersion = startLangVersion;
            } else {
              i18n.markSynced(startLangVersion);
            }
          } else if (isLanguagePref(server.language) && server.language !== localLanguage) {
            i18n.adoptFromServer(server.language);
          } else {
            i18n.markSynced(startLangVersion);
          }
        }

        if (theme.getVersion() === startAppearanceVersion) {
          const localAppearance = theme.getState().preference;
          if (theme.shouldPushToServer()) {
            if (server.appearance !== localAppearance) {
              patch.appearance = localAppearance;
              pushAppearanceVersion = startAppearanceVersion;
            } else {
              theme.markSynced(startAppearanceVersion);
            }
          } else if (isAppearancePref(server.appearance) && server.appearance !== localAppearance) {
            theme.adoptFromServer(server.appearance);
          } else {
            theme.markSynced(startAppearanceVersion);
          }
        }

        await patchPreferences(
          generation,
          signal,
          patch,
          pushLangVersion,
          pushAppearanceVersion,
          options?.onSettingsLoaded,
        );
      });
    },

    cancelPending(): void {
      pendingLanguage = false;
      pendingAppearance = false;
      flushScheduled = false;
      activeController?.abort();
      activeController = null;
      setState({ saving: false, lastError: null });
    },

    setLanguage(pref: LanguagePref): void {
      i18n.setPreference(pref, { userInitiated: true });
      if (!client.isAuthenticated()) {
        return;
      }
      pendingLanguage = true;
      scheduleFlush(client.getSessionGeneration());
    },

    setAppearance(pref: AppearancePref): void {
      theme.setPreference(pref, { userInitiated: true });
      if (!client.isAuthenticated()) {
        return;
      }
      pendingAppearance = true;
      scheduleFlush(client.getSessionGeneration());
    },

    retryLastFailed(): void {
      const failed = state.lastError;
      if (!failed || !client.isAuthenticated()) {
        return;
      }
      if (failed.fields.includes("language")) {
        pendingLanguage = true;
      }
      if (failed.fields.includes("appearance")) {
        pendingAppearance = true;
      }
      scheduleFlush(client.getSessionGeneration());
    },

    clearError(): void {
      if (state.lastError !== null) {
        setState({ saving: state.saving, lastError: null });
      }
    },
  };
}

/** Shared preference synchronizer for the Browser Client. */
export const preferenceSync: PreferenceSync = createPreferenceSync();

export function usePreferenceSync(sync: PreferenceSync = preferenceSync): PreferenceSyncState {
  return useSyncExternalStore(sync.subscribe, sync.getState, sync.getState);
}
