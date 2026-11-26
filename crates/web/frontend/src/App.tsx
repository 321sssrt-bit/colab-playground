import { useCallback, useEffect, useRef, useState } from "react";

import {
  AppShell,
  type AccountSlotActions,
  type AccountSlotPlacement,
} from "./components/AppShell.tsx";
import { BrandIcon } from "./components/Icons.tsx";
import { ToastViewport } from "./components/ToastViewport.tsx";
import {
  accountDialogsStore,
  openAddAccountDialog,
  useAccountDialogsStore,
} from "./lib/accountDialogs.ts";
import { useAppDataStore } from "./lib/appCache.ts";
// Ensure the global Cost Guard observer is initialized at application scope across all routes.
import "./lib/guard.ts";
import { useI18n } from "./lib/i18n.ts";
import { preferenceSync, usePreferenceSync } from "./lib/preferences.ts";
import {
  formatDocumentTitle,
  routerStore,
  useRouter,
  type RouteId,
  type SettingsFocus,
} from "./lib/router.ts";
import { stopDialogsStore, useStopDialogsStore } from "./lib/stopDialogs.ts";
import { useWebStore, webStore } from "./lib/store.ts";
import { useTheme } from "./lib/theme.ts";
import { dismissToast, pushToast, toastStore, useToasts } from "./lib/toast.ts";
import type { AppearancePref, LanguagePref } from "./lib/types.ts";
import { updatesStore, useUpdatesStore } from "./lib/updates.ts";
import { AccountsPage, type AccountsPageProps } from "./pages/AccountsPage.tsx";
import { AccountSwitcherMenu } from "./pages/accounts/AccountSwitcherMenu.tsx";
import { AddAccountDialog } from "./pages/accounts/AddAccountDialog.tsx";
import type { SwitchTarget } from "./pages/accounts/model.ts";
import { RemoveAccountDialog } from "./pages/accounts/RemoveAccountDialog.tsx";
import { SwitchAccountDialog } from "./pages/accounts/SwitchAccountDialog.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { PluginsPage } from "./pages/PluginsPage.tsx";
import { SessionsPage } from "./pages/SessionsPage.tsx";
import { StopAllDialog } from "./pages/sessions/StopAllDialog.tsx";
import { StopRuntimeDialog } from "./pages/sessions/StopRuntimeDialog.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { formatSettingsError } from "./pages/settings/api.ts";
import {
  settingsNoticeStore,
  useSettingsNoticeStore,
  type NoticePart,
} from "./pages/settings/noticeStore.ts";
import { SettingsNoticeBanner } from "./pages/settings/SettingsNoticeBanner.tsx";
import "./pages/settings/settings.css";
import type { PageProps } from "./pages/types.ts";

type AccountDialogCallbacks = Pick<AccountsPageProps, "onRequestSwitchAccount">;

function renderRoutePage(
  route: RouteId,
  settingsFocus: SettingsFocus | null,
  pageProps: PageProps,
  accountCallbacks: AccountDialogCallbacks,
) {
  switch (route) {
    case "overview":
      return <OverviewPage {...pageProps} />;
    case "sessions":
      return <SessionsPage {...pageProps} />;
    case "plugins":
      return <PluginsPage {...pageProps} />;
    case "accounts":
      return <AccountsPage {...pageProps} {...accountCallbacks} />;
    case "settings":
      return <SettingsPage {...pageProps} settingsFocus={settingsFocus} />;
  }
}

export function App() {
  const storeState = useWebStore();
  const appData = useAppDataStore();
  const updatesState = useUpdatesStore();
  const preferenceState = usePreferenceSync();
  const settingsNoticeState = useSettingsNoticeStore();
  const stopDialogsState = useStopDialogsStore();
  const accountDialogsState = useAccountDialogsStore();
  const i18n = useI18n();
  const theme = useTheme();
  const { route, settingsFocus, navigate } = useRouter();
  const toasts = useToasts();
  const [modalDrawerOpen, setModalDrawerOpen] = useState(false);
  const [switchTarget, setSwitchTarget] = useState<SwitchTarget | null>(null);
  const lastPrefErrorIdRef = useRef(0);
  const { t } = i18n;

  useEffect(() => {
    if (storeState.authStatus !== "authenticated") {
      preferenceSync.cancelPending();
      lastPrefErrorIdRef.current = 0;
      toastStore.clear();
      setModalDrawerOpen(false);
      setSwitchTarget(null);
      return;
    }

    routerStore.ensureCanonicalHash();
    const controller = new AbortController();
    preferenceSync.syncSession(controller.signal, {
      onSettingsLoaded: (view) => {
        settingsNoticeStore.observe(view.settings_notice);
      },
    });
    void updatesStore.ensureChecked(controller.signal);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void updatesStore.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      preferenceSync.cancelPending();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [storeState.authStatus]);

  useEffect(() => {
    if (storeState.authStatus !== "authenticated" || storeState.snapshot === null) {
      return;
    }
    if (storeState.snapshot.settings_notice !== undefined) {
      settingsNoticeStore.observe(storeState.snapshot.settings_notice);
    }
  }, [storeState.authStatus, storeState.snapshot]);

  useEffect(() => {
    const err = preferenceState.lastError;
    if (storeState.authStatus !== "authenticated" || err === null) {
      return;
    }
    if (err.id === lastPrefErrorIdRef.current) {
      return;
    }
    lastPrefErrorIdRef.current = err.id;
    pushToast({
      tone: "danger",
      title: t("app.toast.save_failed.title"),
      body: formatSettingsError(err.error, t),
    });
  }, [storeState.authStatus, preferenceState.lastError, t]);

  useEffect(() => {
    if (storeState.authStatus !== "authenticated") {
      return;
    }
    void updatesStore.ensureChecked();
  }, [storeState.authStatus, route]);

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
    setSwitchTarget(null);
    webStore.signOut();
  }, []);

  const handleRequestSwitchAccount = useCallback((target: SwitchTarget) => {
    setSwitchTarget(target);
  }, []);

  const handleRequestAddAccount = useCallback(() => {
    openAddAccountDialog();
  }, []);

  const handleStartAddLogin = useCallback(() => {
    void accountDialogsStore.startAddLogin();
  }, []);

  const handleSubmitAddLoginCode = useCallback((code: string) => {
    void accountDialogsStore.submitAddLoginCode(code);
  }, []);

  const handleCancelExistingLogin = useCallback(() => {
    void accountDialogsStore.cancelExistingLogin();
  }, []);

  const handleCancelOrCloseAddAccount = useCallback(() => {
    accountDialogsStore.cancelOrCloseAddAccount();
  }, []);

  const handleCloseRemoveAccount = useCallback(() => {
    accountDialogsStore.closeRemoveAccount();
  }, []);

  const handleConfirmRemoveAccount = useCallback(() => {
    void accountDialogsStore.confirmRemoveAccount();
  }, []);

  const handleNavigateAccounts = useCallback(() => {
    navigate("accounts");
  }, [navigate]);

  const renderAccountSlot = useCallback(
    (placement: AccountSlotPlacement, actions: AccountSlotActions) => (
      <AccountSwitcherMenu
        placement={placement}
        snapshot={storeState.snapshot}
        t={t}
        drawerOpen={actions.drawerOpen}
        onNavigateAccounts={handleNavigateAccounts}
        onRequestSwitch={handleRequestSwitchAccount}
        onRequestAddAccount={handleRequestAddAccount}
        onCloseDrawer={actions.closeDrawer}
      />
    ),
    [
      handleNavigateAccounts,
      handleRequestAddAccount,
      handleRequestSwitchAccount,
      storeState.snapshot,
      t,
    ],
  );

  const handleDismissUpdate = useCallback((version: string) => {
    updatesStore.dismiss(version);
  }, []);

  const handleDismissSettingsNotice = useCallback((part: NoticePart) => {
    void settingsNoticeStore.dismissPart(part);
  }, []);

  const handleCloseStopAll = useCallback(() => {
    stopDialogsStore.closeStopAll();
  }, []);

  const handleConfirmStopAll = useCallback(() => {
    void stopDialogsStore.confirmStopAll();
  }, []);

  const handleCloseStopRuntime = useCallback(() => {
    stopDialogsStore.closeStopRuntime();
  }, []);

  const handleConfirmStopRuntime = useCallback(() => {
    void stopDialogsStore.confirmStopRuntime();
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

  const accountCallbacks: AccountDialogCallbacks = {
    onRequestSwitchAccount: handleRequestSwitchAccount,
  };

  const stopRuntimeRequest =
    stopDialogsState.stopRuntime.open && stopDialogsState.stopRuntime.target
      ? {
          id: stopDialogsState.stopRuntime.openId,
          ...stopDialogsState.stopRuntime.target,
        }
      : null;

  return (
    <div className="app-root">
      <AppShell
        route={route}
        snapshot={storeState.snapshot}
        connectionStatus={storeState.connectionStatus}
        reconnectAttempt={storeState.reconnectAttempt}
        locale={i18n.locale}
        t={t}
        onNavigate={navigate}
        onSignOut={handleSignOut}
        updateBanner={updatesState.bannerUpdate}
        updateBadge={updatesState.badgeVersion !== null}
        onDismissUpdate={handleDismissUpdate}
        onModalDrawerChange={setModalDrawerOpen}
        renderAccountSlot={renderAccountSlot}
      >
        <SettingsNoticeBanner
          state={settingsNoticeState}
          t={t}
          onDismiss={handleDismissSettingsNotice}
        />
        {renderRoutePage(route, settingsFocus, pageProps, accountCallbacks)}
      </AppShell>
      {storeState.snapshot !== null && (
        <SwitchAccountDialog
          target={switchTarget}
          snapshot={storeState.snapshot}
          t={t}
          pushToast={pushToast}
          onClose={() => setSwitchTarget(null)}
        />
      )}
      <AddAccountDialog
        state={accountDialogsState.add}
        snapshot={storeState.snapshot}
        t={t}
        pushToast={pushToast}
        onStartLogin={handleStartAddLogin}
        onSubmitCode={handleSubmitAddLoginCode}
        onCancelExisting={handleCancelExistingLogin}
        onCancelOrClose={handleCancelOrCloseAddAccount}
      />
      <RemoveAccountDialog
        state={accountDialogsState.remove}
        snapshot={storeState.snapshot}
        t={t}
        onClose={handleCloseRemoveAccount}
        onConfirm={handleConfirmRemoveAccount}
      />
      <StopRuntimeDialog
        request={stopRuntimeRequest}
        t={t}
        pushToast={pushToast}
        submitting={stopDialogsState.stopRuntime.submitting}
        submitError={stopDialogsState.stopRuntime.submitError}
        onClose={handleCloseStopRuntime}
        onConfirm={handleConfirmStopRuntime}
      />
      <StopAllDialog
        state={stopDialogsState.stopAll}
        snapshot={storeState.snapshot}
        sessionsRefreshing={appData.sessionsRefreshing}
        t={t}
        onClose={handleCloseStopAll}
        onConfirm={handleConfirmStopAll}
      />
      <ToastViewport toasts={toasts} t={t} inert={modalDrawerOpen} onDismiss={dismissToast} />
    </div>
  );
}
