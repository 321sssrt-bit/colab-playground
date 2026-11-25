import { useCallback, useEffect } from "react";

import { AppShell } from "./components/AppShell.tsx";
import { BrandIcon } from "./components/Icons.tsx";
import { ToastViewport } from "./components/ToastViewport.tsx";
import { useI18n } from "./lib/i18n.ts";
import { preferenceSync } from "./lib/preferences.ts";
import { formatDocumentTitle, routerStore, useRouter, type RouteId } from "./lib/router.ts";
import { useWebStore, webStore } from "./lib/store.ts";
import { useTheme } from "./lib/theme.ts";
import { dismissToast, pushToast, toastStore, useToasts } from "./lib/toast.ts";
import type { AppearancePref, LanguagePref } from "./lib/types.ts";
import { AccountsPage } from "./pages/AccountsPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { PluginsPage } from "./pages/PluginsPage.tsx";
import { SessionsPage } from "./pages/SessionsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import type { PageProps } from "./pages/types.ts";

function renderRoutePage(route: RouteId, pageProps: PageProps) {
  switch (route) {
    case "overview":
      return <OverviewPage {...pageProps} />;
    case "sessions":
      return <SessionsPage {...pageProps} />;
    case "plugins":
      return <PluginsPage {...pageProps} />;
    case "accounts":
      return <AccountsPage {...pageProps} />;
    case "settings":
      return <SettingsPage {...pageProps} />;
  }
}

export function App() {
  const storeState = useWebStore();
  const i18n = useI18n();
  const theme = useTheme();
  const { route, navigate } = useRouter();
  const toasts = useToasts();
  const { t } = i18n;

  useEffect(() => {
    if (storeState.authStatus !== "authenticated") {
      preferenceSync.cancelPending();
      toastStore.clear();
      return;
    }

    routerStore.ensureCanonicalHash();
    const controller = new AbortController();
    preferenceSync.syncSession(controller.signal);
    return () => {
      controller.abort();
      preferenceSync.cancelPending();
    };
  }, [storeState.authStatus]);

  useEffect(() => {
    if (i18n.dict === null) {
      return;
    }
    if (storeState.authStatus === "authenticated") {
      document.title = formatDocumentTitle(route, t);
    } else {
      document.title = t("app.name");
    }
  }, [storeState.authStatus, route, i18n.dict, i18n.locale, i18n.preference, t]);

  const handleLanguageChange = useCallback((pref: LanguagePref) => {
    preferenceSync.setLanguage(pref);
  }, []);

  const handleAppearanceChange = useCallback((pref: AppearancePref) => {
    preferenceSync.setAppearance(pref);
  }, []);

  const handleSignIn = useCallback(async (accessKey: string, signal: AbortSignal) => {
    await webStore.signIn(accessKey, signal);
  }, []);

  const handleSignOut = useCallback(() => {
    toastStore.clear();
    webStore.signOut();
  }, []);

  // Avoid rendering unlabeled form controls before the first dictionary loads.
  if (i18n.dict === null) {
    return (
      <div className="app-root">
        <main className="login-page" aria-busy="true">
          <div className="login-shell">
            <section className="card login-card">
              <div className="busy-line">
                <BrandIcon />
                <span className="spinner" aria-hidden="true" />
              </div>
            </section>
          </div>
        </main>
      </div>
    );
  }

  if (storeState.authStatus !== "authenticated") {
    return (
      <div className="app-root">
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
      </div>
    );
  }

  const pageProps: PageProps = {
    snapshot: storeState.snapshot,
    locale: i18n.locale,
    t,
    navigate,
    pushToast,
  };

  return (
    <div className="app-root">
      <AppShell
        route={route}
        snapshot={storeState.snapshot}
        connectionStatus={storeState.connectionStatus}
        locale={i18n.locale}
        t={t}
        onNavigate={navigate}
        onSignOut={handleSignOut}
      >
        {renderRoutePage(route, pageProps)}
      </AppShell>
      <ToastViewport toasts={toasts} t={t} onDismiss={dismissToast} />
    </div>
  );
}
