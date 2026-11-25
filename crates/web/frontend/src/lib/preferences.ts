/**
 * Synchronizes browser language and appearance preferences with `/api/settings`
 * after Bearer sign-in and on subsequent authenticated preference changes.
 */

import type { ApiClient } from "./api.ts";
import { isLanguagePref, type I18nStore } from "./i18n.ts";
import { isAppearancePref, type ThemeStore } from "./theme.ts";
import type { SettingsPatch, SettingsView } from "./types.ts";

/**
 * Reconciles browser preferences against server settings immediately after login:
 * pre-login browser choices win and are PATCHed to the server; untouched defaults
 * adopt the server's persisted settings and cache them locally for future reloads.
 */
export async function syncPreferencesOnLogin(
  client: ApiClient,
  i18n: I18nStore,
  theme: ThemeStore,
  signal?: AbortSignal,
): Promise<void> {
  if (!client.isAuthenticated()) {
    return;
  }

  const startLangVersion = i18n.getVersion();
  const startAppearanceVersion = theme.getVersion();

  let server: SettingsView;
  try {
    server = await client.request<SettingsView>("/api/settings", {
      method: "GET",
      signal,
    });
  } catch {
    return;
  }

  if (signal?.aborted || !client.isAuthenticated()) {
    return;
  }

  const patch: SettingsPatch = {};

  if (i18n.getVersion() === startLangVersion) {
    const localLanguage = i18n.getState().preference;
    if (i18n.shouldPushToServer()) {
      if (server.language !== localLanguage) {
        patch.language = localLanguage;
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
    if (!signal?.aborted) {
      if (patch.language !== undefined) {
        i18n.markSynced(startLangVersion);
      }
      if (patch.appearance !== undefined) {
        theme.markSynced(startAppearanceVersion);
      }
    }
  } catch {
    // Keep the browser choice active even if the server settings write fails.
  }
}

/**
 * Persists a single preference change to `/api/settings` when authenticated.
 */
export async function persistPreferencePatch(
  client: ApiClient,
  patch: SettingsPatch,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!client.isAuthenticated()) {
    return false;
  }
  try {
    await client.request<SettingsView>("/api/settings", {
      method: "PATCH",
      body: patch,
      signal,
    });
    return true;
  } catch {
    return false;
  }
}
