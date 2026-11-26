/**
 * Settings route: focused limit/host jump cards, persisted language & appearance
 * controls with save-error feedback, isolated Defaults form with cross-route
 * draft preservation, Host/WSL/CLI path settings, and complete About section.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { AlertIcon } from "../components/Icons.tsx";
import { apiClient } from "../lib/api.ts";
import { appDataStore, useAppDataStore } from "../lib/appCache.ts";
import { useI18n } from "../lib/i18n.ts";
import { preferenceSync, usePreferenceSync } from "../lib/preferences.ts";
import type { SettingsFocus } from "../lib/router.ts";
import { useTheme } from "../lib/theme.ts";
import type { AppearancePref, LanguagePref } from "../lib/types.ts";
import { updatesStore, useUpdatesStore } from "../lib/updates.ts";
import { AboutSection } from "./settings/AboutSection.tsx";
import {
  fetchSettings,
  formatApiErrorPayload,
  formatSettingsError,
  isAbortError,
  isHostInterpreterAloneError,
  patchCheckUpdates,
  patchDefaults,
  patchHostSettings,
  type LoadedSettings,
  type RuntimeDefaultsPatch,
} from "./settings/api.ts";
import { DefaultsSection } from "./settings/DefaultsSection.tsx";
import { settingsDraftStore, useSettingsDraftStore } from "./settings/draftStore.ts";
import { GeneralSection } from "./settings/GeneralSection.tsx";
import { HostSection, type HostSaveError } from "./settings/HostSection.tsx";
import { LimitFocusCard } from "./settings/LimitFocusCard.tsx";
import { settingsNoticeStore } from "./settings/noticeStore.ts";
import "./settings/settings.css";
import type { PageProps } from "./types.ts";

export interface SettingsPageProps extends PageProps {
  readonly settingsFocus?: SettingsFocus | null;
}

function normalizePathInput(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mergeMetadata(prev: LoadedSettings, updated: LoadedSettings): LoadedSettings {
  return {
    ...prev,
    configDir: updated.configDir,
    settingsFile: updated.settingsFile,
    loadStatus: updated.loadStatus,
    corruptBackup: updated.corruptBackup,
    resetDefaults: updated.resetDefaults,
    settingsNotice: updated.settingsNotice,
  };
}

export function SettingsPage({
  snapshot,
  t,
  pushToast,
  settingsFocus = null,
}: SettingsPageProps) {
  const i18n = useI18n();
  const theme = useTheme();
  const appData = useAppDataStore();
  const updatesState = useUpdatesStore();
  const preferenceState = usePreferenceSync();
  useSettingsDraftStore();

  const [settings, setSettings] = useState<LoadedSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [savingDefaults, setSavingDefaults] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [savingLimit, setSavingLimit] = useState(false);
  const [limitSaveError, setLimitSaveError] = useState<unknown>(null);
  const [limitSavedNotice, setLimitSavedNotice] = useState(false);

  const [savingHost, setSavingHost] = useState(false);
  const [hostError, setHostError] = useState<HostSaveError | null>(null);
  const [hostSavedNotice, setHostSavedNotice] = useState(false);

  const [savingCheckUpdates, setSavingCheckUpdates] = useState(false);
  const [checkUpdatesError, setCheckUpdatesError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  const mutationSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const defaultsAbortRef = useRef<AbortController | null>(null);
  const hostAbortRef = useRef<AbortController | null>(null);
  const checkUpdatesAbortRef = useRef<AbortController | null>(null);
  const updateCheckAbortRef = useRef<AbortController | null>(null);

  const loadSettings = useCallback(() => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const startMutationSeq = mutationSeqRef.current;

    setLoadingSettings(true);
    setLoadError(null);

    void fetchSettings(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        settingsNoticeStore.observe(loaded.settingsNotice);
        if (mutationSeqRef.current !== startMutationSeq) {
          setSettings((prev) => (prev === null ? loaded : prev));
          return;
        }
        setSettings(loaded);
        updatesStore.setCheckUpdates(loaded.checkUpdates);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setLoadError(error);
      })
      .finally(() => {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setLoadingSettings(false);
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadSettings();
    const updatesController = new AbortController();
    void updatesStore.ensureChecked(updatesController.signal);
    return () => {
      mountedRef.current = false;
      updatesController.abort();
      loadAbortRef.current?.abort();
      updateCheckAbortRef.current?.abort();
    };
  }, [loadSettings]);

  // Populate WSL distributions on Windows/WSL when Overview has not loaded yet.
  useEffect(() => {
    if (!settings?.usesWsl || appData.overview !== null) {
      return;
    }
    const controller = new AbortController();
    void appDataStore.ensureOverview(controller.signal).catch(() => {});
    return () => {
      controller.abort();
    };
  }, [settings?.usesWsl, appData.overview]);

  const handleLanguageChange = useCallback((pref: LanguagePref) => {
    preferenceSync.setLanguage(pref);
  }, []);

  const handleAppearanceChange = useCallback((pref: AppearancePref) => {
    preferenceSync.setAppearance(pref);
  }, []);

  const handleRetryPreferenceSave = useCallback(() => {
    preferenceSync.retryLastFailed();
  }, []);

  const handleDismissPreferenceError = useCallback(() => {
    preferenceSync.clearError();
  }, []);

  const handleClearDefaultsFeedback = useCallback(() => {
    setSaveError(null);
    setSavedNotice(false);
  }, []);

  const handleClearLimitFeedback = useCallback(() => {
    setLimitSaveError(null);
    setLimitSavedNotice(false);
  }, []);

  const handleSaveDefaults = useCallback(
    async (patch: RuntimeDefaultsPatch): Promise<boolean> => {
      defaultsAbortRef.current?.abort();
      const controller = new AbortController();
      defaultsAbortRef.current = controller;
      const gen = apiClient.getSessionGeneration();
      mutationSeqRef.current += 1;

      setSavingDefaults(true);
      setSaveError(null);
      setSavedNotice(false);

      try {
        const updated = await patchDefaults(patch, controller.signal);
        if (controller.signal.aborted || apiClient.getSessionGeneration() !== gen) {
          return false;
        }
        settingsDraftStore.reconcileSavedDefaults(updated.defaults, patch);
        appDataStore.applySessionDefaults(updated.defaults);
        pushToast({ tone: "success", body: t("web.settings.saved") });
        if (mountedRef.current) {
          mutationSeqRef.current += 1;
          setSettings((prev) =>
            prev === null
              ? updated
              : { ...mergeMetadata(prev, updated), defaults: updated.defaults },
          );
          setSavedNotice(true);
        }
        return true;
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          isAbortError(error) ||
          apiClient.getSessionGeneration() !== gen
        ) {
          return false;
        }
        if (mountedRef.current) {
          setSaveError(error);
        }
        pushToast({
          tone: "danger",
          title: t("app.toast.save_failed.title"),
          body: formatSettingsError(error, t),
        });
        return false;
      } finally {
        if (defaultsAbortRef.current === controller) {
          defaultsAbortRef.current = null;
        }
        if (!controller.signal.aborted && mountedRef.current) {
          setSavingDefaults(false);
        }
      }
    },
    [pushToast, t],
  );

  const handleSaveLimitFocus = useCallback(
    async (limit: number): Promise<boolean> => {
      defaultsAbortRef.current?.abort();
      const controller = new AbortController();
      defaultsAbortRef.current = controller;
      const gen = apiClient.getSessionGeneration();
      mutationSeqRef.current += 1;

      setSavingLimit(true);
      setLimitSaveError(null);
      setLimitSavedNotice(false);

      try {
        const updated = await patchDefaults({ max_concurrent_sessions: limit }, controller.signal);
        if (controller.signal.aborted || apiClient.getSessionGeneration() !== gen) {
          return false;
        }
        settingsDraftStore.reconcileSavedConcurrentLimit(updated.defaults);
        appDataStore.applySessionDefaults(updated.defaults);
        pushToast({ tone: "success", body: t("web.settings.saved") });
        if (mountedRef.current) {
          mutationSeqRef.current += 1;
          setSettings((prev) =>
            prev === null
              ? updated
              : { ...mergeMetadata(prev, updated), defaults: updated.defaults },
          );
          setLimitSavedNotice(true);
        }
        return true;
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          isAbortError(error) ||
          apiClient.getSessionGeneration() !== gen
        ) {
          return false;
        }
        if (mountedRef.current) {
          setLimitSaveError(error);
        }
        pushToast({
          tone: "danger",
          title: t("app.toast.save_failed.title"),
          body: formatSettingsError(error, t),
        });
        return false;
      } finally {
        if (defaultsAbortRef.current === controller) {
          defaultsAbortRef.current = null;
        }
        if (!controller.signal.aborted && mountedRef.current) {
          setSavingLimit(false);
        }
      }
    },
    [pushToast, t],
  );

  const handleHostDraftChange = useCallback(
    (colabPath: string, colabPython: string) => {
      settingsDraftStore.saveHostDraft(
        settings?.colabPath ?? null,
        settings?.colabPython ?? null,
        colabPath,
        colabPython,
      );
      if (hostError !== null) {
        setHostError(null);
      }
      if (hostSavedNotice) {
        setHostSavedNotice(false);
      }
    },
    [hostError, hostSavedNotice, settings?.colabPath, settings?.colabPython],
  );

  const handleWslDistroChange = useCallback(
    (distro: string | null) => {
      if (!settings || settings.wslDistro === distro) {
        return;
      }
      hostAbortRef.current?.abort();
      const controller = new AbortController();
      hostAbortRef.current = controller;
      const gen = apiClient.getSessionGeneration();
      mutationSeqRef.current += 1;

      setSavingHost(true);
      setHostError(null);
      setHostSavedNotice(false);

      void patchHostSettings({ wsl_distro: distro }, controller.signal)
        .then((updated) => {
          if (controller.signal.aborted || apiClient.getSessionGeneration() !== gen) {
            return;
          }
          pushToast({ tone: "success", body: t("web.settings.saved") });
          if (snapshot?.backend === "real") {
            void appDataStore.refreshOverview().catch(() => {});
          }
          if (mountedRef.current) {
            mutationSeqRef.current += 1;
            setSettings((prev) =>
              prev === null
                ? updated
                : { ...mergeMetadata(prev, updated), wslDistro: updated.wslDistro },
            );
            setHostSavedNotice(true);
          }
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            isAbortError(error) ||
            apiClient.getSessionGeneration() !== gen
          ) {
            return;
          }
          const message = formatSettingsError(error, t);
          if (mountedRef.current) {
            setHostError({ message, interpreterAlone: false });
          }
          pushToast({
            tone: "danger",
            title: t("app.toast.save_failed.title"),
            body: message,
          });
        })
        .finally(() => {
          if (hostAbortRef.current === controller) {
            hostAbortRef.current = null;
          }
          if (!controller.signal.aborted && mountedRef.current) {
            setSavingHost(false);
          }
        });
    },
    [pushToast, settings, snapshot?.backend, t],
  );

  const handleApplyHostPaths = useCallback(
    async (colabPathRaw: string, colabPythonRaw: string): Promise<boolean> => {
      if (!settings) {
        return false;
      }
      const nextColab = normalizePathInput(colabPathRaw);
      const nextPython = normalizePathInput(colabPythonRaw);
      if (nextColab === settings.colabPath && nextPython === settings.colabPython) {
        settingsDraftStore.clearHostDraft();
        setHostError(null);
        return true;
      }

      hostAbortRef.current?.abort();
      const controller = new AbortController();
      hostAbortRef.current = controller;
      const gen = apiClient.getSessionGeneration();
      mutationSeqRef.current += 1;

      setSavingHost(true);
      setHostError(null);
      setHostSavedNotice(false);

      try {
        const updated = await patchHostSettings(
          { colab_path: nextColab, colab_python: nextPython },
          controller.signal,
        );
        if (controller.signal.aborted || apiClient.getSessionGeneration() !== gen) {
          return false;
        }
        settingsDraftStore.clearHostDraft();
        pushToast({ tone: "success", body: t("web.settings.saved") });
        if (snapshot?.backend === "real") {
          void appDataStore.refreshOverview().catch(() => {});
        }
        if (mountedRef.current) {
          mutationSeqRef.current += 1;
          setSettings((prev) =>
            prev === null
              ? updated
              : {
                  ...mergeMetadata(prev, updated),
                  colabPath: updated.colabPath,
                  colabPython: updated.colabPython,
                },
          );
          setHostSavedNotice(true);
        }
        return true;
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          isAbortError(error) ||
          apiClient.getSessionGeneration() !== gen
        ) {
          return false;
        }
        const interpreterAlone = isHostInterpreterAloneError(error);
        const message = formatSettingsError(error, t);
        if (mountedRef.current) {
          setHostError({ message, interpreterAlone });
        }
        if (interpreterAlone) {
          pushToast({ tone: "warning", body: message });
        } else {
          pushToast({
            tone: "danger",
            title: t("app.toast.save_failed.title"),
            body: message,
          });
        }
        return false;
      } finally {
        if (hostAbortRef.current === controller) {
          hostAbortRef.current = null;
        }
        if (!controller.signal.aborted && mountedRef.current) {
          setSavingHost(false);
        }
      }
    },
    [pushToast, settings, snapshot?.backend, t],
  );

  const handleCheckUpdatesNow = useCallback(() => {
    updateCheckAbortRef.current?.abort();
    const controller = new AbortController();
    updateCheckAbortRef.current = controller;

    void updatesStore
      .checkNow(controller.signal)
      .then((notice) => {
        if (controller.signal.aborted) {
          return;
        }
        if (notice.status === "failed") {
          pushToast({
            tone: "warning",
            title: t("app.b7.update_failed_title"),
            body: formatApiErrorPayload(notice.error, t),
          });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        pushToast({
          tone: "warning",
          title: t("app.b7.update_failed_title"),
          body: formatSettingsError(error, t),
        });
      })
      .finally(() => {
        if (updateCheckAbortRef.current === controller) {
          updateCheckAbortRef.current = null;
        }
      });
  }, [pushToast, t]);

  const handleToggleCheckUpdates = useCallback(
    (enabled: boolean) => {
      checkUpdatesAbortRef.current?.abort();
      const controller = new AbortController();
      checkUpdatesAbortRef.current = controller;
      const gen = apiClient.getSessionGeneration();
      mutationSeqRef.current += 1;

      setSavingCheckUpdates(true);
      setCheckUpdatesError(null);

      void patchCheckUpdates(enabled, controller.signal)
        .then((updated) => {
          if (controller.signal.aborted || apiClient.getSessionGeneration() !== gen) {
            return;
          }
          updatesStore.setCheckUpdates(updated.checkUpdates);
          if (mountedRef.current) {
            mutationSeqRef.current += 1;
            setSettings((prev) =>
              prev === null
                ? updated
                : { ...mergeMetadata(prev, updated), checkUpdates: updated.checkUpdates },
            );
          }
        })
        .catch((error: unknown) => {
          if (
            controller.signal.aborted ||
            isAbortError(error) ||
            apiClient.getSessionGeneration() !== gen
          ) {
            return;
          }
          if (mountedRef.current) {
            setCheckUpdatesError(error);
          }
          pushToast({
            tone: "danger",
            title: t("app.toast.save_failed.title"),
            body: formatSettingsError(error, t),
          });
        })
        .finally(() => {
          if (checkUpdatesAbortRef.current === controller) {
            checkUpdatesAbortRef.current = null;
          }
          if (!controller.signal.aborted && mountedRef.current) {
            setSavingCheckUpdates(false);
          }
        });
    },
    [pushToast, t],
  );

  const loadErrorText = loadError !== null ? formatSettingsError(loadError, t) : null;
  const saveErrorText = saveError !== null ? formatSettingsError(saveError, t) : null;
  const limitSaveErrorText =
    limitSaveError !== null ? formatSettingsError(limitSaveError, t) : null;
  const generalSaveErrorText =
    preferenceState.lastError !== null
      ? formatSettingsError(preferenceState.lastError.error, t)
      : null;
  const updateErrorText =
    updatesState.manualError !== null ? formatSettingsError(updatesState.manualError, t) : null;
  const checkUpdatesErrorText =
    checkUpdatesError !== null ? formatSettingsError(checkUpdatesError, t) : null;

  const backendKind = snapshot?.backend ?? null;
  const simulated = backendKind === "mock";
  const hostBusy = Boolean(
    snapshot?.shutting_down ||
      snapshot?.login_id !== null ||
      (snapshot?.operations.length ?? 0) > 0,
  );
  const wslDistros = appData.overview?.environment.wsl_distros ?? [];
  const hostFirst = settingsFocus === "host";
  const limitFirst = settingsFocus === "limit";
  const savingAnyDefaults = savingDefaults || savingLimit;

  const resolvedDefaultsDraft = settings
    ? settingsDraftStore.resolveDefaultsDraft(settings.defaults)
    : null;
  const resolvedHostDraft = settings
    ? settingsDraftStore.resolveHostDraft(settings.colabPath, settings.colabPython)
    : null;

  const hostSectionNode =
    settings !== null && resolvedHostDraft !== null ? (
      <HostSection
        usesWsl={settings.usesWsl}
        wslDistro={settings.wslDistro}
        wslDistros={wslDistros}
        colabPathDraft={resolvedHostDraft.colabPath}
        colabPythonDraft={resolvedHostDraft.colabPython}
        simulated={simulated}
        busy={hostBusy}
        saving={savingHost}
        focused={hostFirst}
        hostError={hostError}
        savedNotice={hostSavedNotice}
        dict={i18n.dict}
        t={t}
        onWslDistroChange={handleWslDistroChange}
        onDraftChange={handleHostDraftChange}
        onApplyPaths={handleApplyHostPaths}
      />
    ) : null;

  const effectiveCheckUpdates =
    settings?.checkUpdates ?? updatesState.notice?.check_updates ?? true;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.settings")}</h1>
        <p className="page-subtitle">{t("app.settings.subtitle")}</p>
      </header>

      <div className="page-sections">
        {limitFirst && settings !== null && resolvedDefaultsDraft !== null && (
          <LimitFocusCard
            serverDefaults={settings.defaults}
            draftValue={resolvedDefaultsDraft.draft.max_concurrent_sessions}
            dict={i18n.dict}
            saving={savingAnyDefaults}
            saveError={limitSaveErrorText}
            savedNotice={limitSavedNotice}
            t={t}
            onChange={(value) => {
              settingsDraftStore.updateConcurrentLimitDraft(settings.defaults, value);
            }}
            onSave={handleSaveLimitFocus}
            onClearFeedback={handleClearLimitFeedback}
          />
        )}

        {hostFirst && hostSectionNode}

        <GeneralSection
          language={i18n.preference}
          browserLocale={i18n.browserLocale}
          dict={i18n.dict}
          appearance={theme.preference}
          saving={preferenceState.saving}
          saveError={generalSaveErrorText}
          t={t}
          onLanguageChange={handleLanguageChange}
          onAppearanceChange={handleAppearanceChange}
          onRetrySave={handleRetryPreferenceSave}
          onDismissError={handleDismissPreferenceError}
        />

        {settings !== null ? (
          <DefaultsSection
            serverDefaults={settings.defaults}
            dict={i18n.dict}
            t={t}
            saving={savingAnyDefaults}
            saveError={saveErrorText}
            savedNotice={savedNotice}
            onSave={handleSaveDefaults}
            onClearFeedback={handleClearDefaultsFeedback}
          />
        ) : loadingSettings ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.settings.loading")}</span>
            </div>
          </section>
        ) : loadErrorText !== null ? (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-body">{loadErrorText}</p>
              <div className="alert-actions">
                <button type="button" className="btn btn-sm" onClick={loadSettings}>
                  {t("app.action.retry")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!hostFirst && hostSectionNode}

        <AboutSection
          backendKind={backendKind}
          settingsFile={settings?.settingsFile ?? null}
          configDir={settings?.configDir ?? null}
          checkUpdates={effectiveCheckUpdates}
          savingCheckUpdates={savingCheckUpdates}
          checkUpdatesError={checkUpdatesErrorText}
          updateNotice={updatesState.notice}
          checkingUpdates={updatesState.checkingManual}
          updateError={updateErrorText}
          dict={i18n.dict}
          t={t}
          onCheckUpdates={handleCheckUpdatesNow}
          onToggleCheckUpdates={handleToggleCheckUpdates}
          pushToast={pushToast}
        />
      </div>
    </>
  );
}
