import { useCallback, useEffect, useRef } from "react";

import { AlertIcon, BrandIcon } from "./components/Icons.tsx";
import { PreferenceBar } from "./components/PreferenceBar.tsx";
import { apiClient } from "./lib/api.ts";
import { i18nStore, useI18n } from "./lib/i18n.ts";
import { persistPreferencePatch, syncPreferencesOnLogin } from "./lib/preferences.ts";
import { useWebStore, webStore } from "./lib/store.ts";
import { themeStore, useTheme } from "./lib/theme.ts";
import type { AppearancePref, LanguagePref } from "./lib/types.ts";
import { LoginPage } from "./pages/LoginPage.tsx";

export function App() {
  const storeState = useWebStore();
  const i18n = useI18n();
  const theme = useTheme();
  const { t } = i18n;

  const langPatchAbortRef = useRef<AbortController | null>(null);
  const appearancePatchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (storeState.authStatus !== "authenticated") {
      langPatchAbortRef.current?.abort();
      langPatchAbortRef.current = null;
      appearancePatchAbortRef.current?.abort();
      appearancePatchAbortRef.current = null;
      return;
    }

    const controller = new AbortController();
    void syncPreferencesOnLogin(apiClient, i18nStore, themeStore, controller.signal);
    return () => controller.abort();
  }, [storeState.authStatus]);

  const handleLanguageChange = useCallback((pref: LanguagePref) => {
    i18nStore.setPreference(pref, { userInitiated: true });
    if (!apiClient.isAuthenticated()) {
      return;
    }
    const version = i18nStore.getVersion();
    langPatchAbortRef.current?.abort();
    const controller = new AbortController();
    langPatchAbortRef.current = controller;
    void persistPreferencePatch(apiClient, { language: pref }, controller.signal).then((saved) => {
      if (saved && !controller.signal.aborted) {
        i18nStore.markSynced(version);
      }
    });
  }, []);

  const handleAppearanceChange = useCallback((pref: AppearancePref) => {
    themeStore.setPreference(pref, { userInitiated: true });
    if (!apiClient.isAuthenticated()) {
      return;
    }
    const version = themeStore.getVersion();
    appearancePatchAbortRef.current?.abort();
    const controller = new AbortController();
    appearancePatchAbortRef.current = controller;
    void persistPreferencePatch(apiClient, { appearance: pref }, controller.signal).then(
      (saved) => {
        if (saved && !controller.signal.aborted) {
          themeStore.markSynced(version);
        }
      },
    );
  }, []);

  const handleSignIn = useCallback(async (accessKey: string, signal: AbortSignal) => {
    await webStore.signIn(accessKey, signal);
  }, []);

  const handleSignOut = useCallback(() => {
    webStore.signOut();
  }, []);

  if (storeState.authStatus !== "authenticated") {
    return (
      <LoginPage
        language={i18n.preference}
        browserLocale={i18n.browserLocale}
        appearance={theme.preference}
        sessionExpired={storeState.authStatus === "expired"}
        dictionaryLoadFailed={i18n.loadFailed}
        t={t}
        onLanguageChange={handleLanguageChange}
        onAppearanceChange={handleAppearanceChange}
        onSignIn={handleSignIn}
      />
    );
  }

  const isMock = storeState.snapshot?.backend === "mock";
  const isShuttingDown = storeState.snapshot?.shutting_down === true;
  const isReconnecting = storeState.connectionStatus === "reconnecting";

  return (
    <main className="login-page">
      <div className="login-shell">
        <div className="login-topbar">
          <PreferenceBar
            language={i18n.preference}
            browserLocale={i18n.browserLocale}
            appearance={theme.preference}
            t={t}
            onLanguageChange={handleLanguageChange}
            onAppearanceChange={handleAppearanceChange}
          />
        </div>

        <section className="card login-card">
          <div className="card-header">
            <div className="card-heading">
              <div className="brand-mark login-brand">
                <BrandIcon />
                <span className="brand-name">{t("app.name")}</span>
              </div>
              <h1 className="login-title">{t("app.nav.overview")}</h1>
            </div>
            {isMock && <span className="badge badge-warning">{t("app.shell.backend.mock")}</span>}
          </div>

          {isShuttingDown && (
            <div className="alert alert-warning" role="alert">
              <span className="alert-icon icon-warning">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{t("web.shell.shutting_down")}</p>
              </div>
            </div>
          )}

          {isReconnecting && (
            <div className="alert alert-warning" role="status" aria-live="polite">
              <span className="alert-icon icon-warning">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{t("web.shell.reconnecting")}</p>
              </div>
            </div>
          )}

          {storeState.snapshot === null && (
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.overview.loading")}</span>
            </div>
          )}

          <div className="card-actions">
            <button type="button" className="btn" onClick={handleSignOut}>
              {t("web.shell.sign_out")}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
