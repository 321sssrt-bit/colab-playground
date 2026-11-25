/**
 * Serialized preference synchronization between browser stores and `/api/settings`.
 *
 * All login-sync and post-login preference writes flow through one ordered
 * pipeline per auth session so an older login-sync PATCH can never land on the
 * server after a newer user change.
 */

import { apiClient, type ApiClient } from "./api.ts";
import { i18nStore, isLanguagePref, type I18nStore } from "./i18n.ts";
import { isAppearancePref, themeStore, type ThemeStore } from "./theme.ts";
import type { AppearancePref, LanguagePref, SettingsPatch, SettingsView } from "./types.ts";

export interface PreferenceSync {
  syncSession(signal?: AbortSignal): void;
  cancelPending(): void;
  setLanguage(pref: LanguagePref): void;
  setAppearance(pref: AppearancePref): void;
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

      if (patch.language === undefined && patch.appearance === undefined) {
        return;
      }

      try {
        await client.request<SettingsView>("/api/settings", {
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
        }
      } catch {
        // Keep the browser choice active even if the server settings write fails.
      }
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
    syncSession(externalSignal?: AbortSignal): void {
      if (!client.isAuthenticated()) {
        return;
      }
      const generation = client.getSessionGeneration();
      const controller = resetController(externalSignal);
      const startLangVersion = i18n.getVersion();
      const startAppearanceVersion = theme.getVersion();

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

        if (patch.language === undefined && patch.appearance === undefined) {
          return;
        }

        try {
          await client.request<SettingsView>("/api/settings", {
            method: "PATCH",
            body: patch,
            signal,
          });
          if (isGenerationLive(generation, signal)) {
            if (pushLangVersion !== undefined) {
              i18n.markSynced(pushLangVersion);
            }
            if (pushAppearanceVersion !== undefined) {
              theme.markSynced(pushAppearanceVersion);
            }
          }
        } catch {
          // Keep the browser choice active even if the server settings write fails.
        }
      });
    },

    cancelPending(): void {
      pendingLanguage = false;
      pendingAppearance = false;
      flushScheduled = false;
      activeController?.abort();
      activeController = null;
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
  };
}

/** Shared preference synchronizer for the Browser Client. */
export const preferenceSync: PreferenceSync = createPreferenceSync();
