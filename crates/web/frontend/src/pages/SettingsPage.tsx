/**
 * Settings route: immediate persisted language & appearance controls, isolated
 * Defaults form protected from SSE snapshot re-renders, corrupt/reset notices,
 * and read-only About card.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { AlertIcon, CloseIcon } from "../components/Icons.tsx";
import { useI18n } from "../lib/i18n.ts";
import { preferenceSync } from "../lib/preferences.ts";
import { useTheme } from "../lib/theme.ts";
import type { AppearancePref, LanguagePref } from "../lib/types.ts";
import { applySessionDefaults } from "./sessions/store.ts";
import { AboutSection } from "./settings/AboutSection.tsx";
import {
  fetchSettings,
  fetchUpdates,
  formatSettingsError,
  isAbortError,
  patchDefaults,
  type LoadedSettings,
  type RuntimeDefaultsPatch,
  type UpdateNotice,
} from "./settings/api.ts";
import { DefaultsSection } from "./settings/DefaultsSection.tsx";
import { GeneralSection } from "./settings/GeneralSection.tsx";
import type { PageProps } from "./types.ts";

const RESET_FIELD_LABEL_KEYS = {
  max_runtime: "app.def.max_runtime",
  max_spend_cu: "app.def.max_spend",
  min_balance_cu: "app.def.min_balance",
  idle_timeout: "app.def.idle",
  max_concurrent_sessions: "app.def.concurrent",
  max_attempts: "app.def.attempts",
  retry_delay: "app.def.retry_delay",
  on_exhausted: "app.def.on_exhausted",
  usage_poll_active: "app.def.poll_active",
  usage_poll_idle: "app.def.poll_idle",
  accelerator: "app.def.accelerator",
  high_mem: "app.def.high_mem",
  min_vram_mib: "app.def.min_vram",
  winddown_grace: "app.def.winddown",
} as const;

type KnownResetField = keyof typeof RESET_FIELD_LABEL_KEYS;

function isKnownResetField(name: string): name is KnownResetField {
  return Object.prototype.hasOwnProperty.call(RESET_FIELD_LABEL_KEYS, name);
}

export function SettingsPage({ snapshot, t, pushToast }: PageProps) {
  const i18n = useI18n();
  const theme = useTheme();

  const [settings, setSettings] = useState<LoadedSettings | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [savingDefaults, setSavingDefaults] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const [corruptDismissed, setCorruptDismissed] = useState(false);
  const [resetDismissed, setResetDismissed] = useState(false);

  const [updateNotice, setUpdateNotice] = useState<UpdateNotice | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateError, setUpdateError] = useState<unknown>(null);

  const loadAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const updateAbortRef = useRef<AbortController | null>(null);

  const loadSettings = useCallback(() => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoadingSettings(true);
    setLoadError(null);

    void fetchSettings(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) {
          return;
        }
        setSettings(loaded);
        setCorruptDismissed(false);
        setResetDismissed(false);
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

  const checkUpdates = useCallback(() => {
    updateAbortRef.current?.abort();
    const controller = new AbortController();
    updateAbortRef.current = controller;

    setCheckingUpdates(true);
    setUpdateError(null);

    void fetchUpdates(controller.signal)
      .then((notice) => {
        if (controller.signal.aborted) {
          return;
        }
        setUpdateNotice(notice);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) {
          return;
        }
        setUpdateError(error);
      })
      .finally(() => {
        if (updateAbortRef.current === controller) {
          updateAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setCheckingUpdates(false);
        }
      });
  }, []);

  useEffect(() => {
    loadSettings();
    checkUpdates();
    return () => {
      loadAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      updateAbortRef.current?.abort();
    };
  }, [loadSettings, checkUpdates]);

  const handleLanguageChange = useCallback((pref: LanguagePref) => {
    preferenceSync.setLanguage(pref);
  }, []);

  const handleAppearanceChange = useCallback((pref: AppearancePref) => {
    preferenceSync.setAppearance(pref);
  }, []);

  const handleClearFeedback = useCallback(() => {
    setSaveError(null);
    setSavedNotice(false);
  }, []);

  const handleSaveDefaults = useCallback(
    async (patch: RuntimeDefaultsPatch): Promise<boolean> => {
      saveAbortRef.current?.abort();
      const controller = new AbortController();
      saveAbortRef.current = controller;

      setSavingDefaults(true);
      setSaveError(null);
      setSavedNotice(false);

      try {
        const updated = await patchDefaults(patch, controller.signal);
        if (controller.signal.aborted) {
          return false;
        }
        setSettings(updated);
        applySessionDefaults(updated.defaults);
        setSavedNotice(true);
        pushToast({ tone: "success", body: t("web.settings.saved") });
        return true;
      } catch (error: unknown) {
        if (controller.signal.aborted || isAbortError(error)) {
          return false;
        }
        setSaveError(error);
        pushToast({
          tone: "danger",
          title: t("app.toast.save_failed.title"),
          body: formatSettingsError(error, t),
        });
        return false;
      } finally {
        if (saveAbortRef.current === controller) {
          saveAbortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setSavingDefaults(false);
        }
      }
    },
    [pushToast, t],
  );

  const showCorruptAlert = settings !== null && settings.loadStatus === "corrupt" && !corruptDismissed;
  const showResetAlert =
    settings !== null && settings.resetDefaults.length > 0 && !resetDismissed;

  const resetFieldNames = showResetAlert
    ? settings.resetDefaults
        .map((field) => (isKnownResetField(field) ? t(RESET_FIELD_LABEL_KEYS[field]) : field))
        .join(t("app.fmt.list_separator"))
    : "";

  const loadErrorText = loadError !== null ? formatSettingsError(loadError, t) : null;
  const saveErrorText = saveError !== null ? formatSettingsError(saveError, t) : null;
  const updateErrorText = updateError !== null ? formatSettingsError(updateError, t) : null;

  const backendKind = snapshot?.backend ?? null;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.settings")}</h1>
        <p className="page-subtitle">{t("app.settings.subtitle")}</p>
      </header>

      <div className="page-sections">
        {showCorruptAlert && (
          <div className="alert alert-warning" role="status">
            <span className="alert-icon icon-warning">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{t("app.toast.settings_reset.title")}</p>
              <p className="alert-body">
                {settings.corruptBackup !== null
                  ? t("app.toast.settings_reset.body", { file: settings.corruptBackup })
                  : t("app.toast.settings_reset.body_lost")}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon alert-dismiss"
              aria-label={t("app.action.dismiss")}
              onClick={() => setCorruptDismissed(true)}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        {showResetAlert && (
          <div className="alert alert-warning" role="status">
            <span className="alert-icon icon-warning">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{t("app.toast.defaults_reset.title")}</p>
              <p className="alert-body">
                {t("app.toast.defaults_reset.body", { fields: resetFieldNames })}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon alert-dismiss"
              aria-label={t("app.action.dismiss")}
              onClick={() => setResetDismissed(true)}
            >
              <CloseIcon />
            </button>
          </div>
        )}

        <GeneralSection
          language={i18n.preference}
          browserLocale={i18n.browserLocale}
          dict={i18n.dict}
          appearance={theme.preference}
          t={t}
          onLanguageChange={handleLanguageChange}
          onAppearanceChange={handleAppearanceChange}
        />

        {settings !== null ? (
          <DefaultsSection
            serverDefaults={settings.defaults}
            dict={i18n.dict}
            t={t}
            saving={savingDefaults}
            saveError={saveErrorText}
            savedNotice={savedNotice}
            onSave={handleSaveDefaults}
            onClearFeedback={handleClearFeedback}
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

        <AboutSection
          backendKind={backendKind}
          configDir={settings?.configDir ?? null}
          updateNotice={updateNotice}
          checkingUpdates={checkingUpdates}
          updateError={updateErrorText}
          dict={i18n.dict}
          t={t}
          onCheckUpdates={checkUpdates}
          pushToast={pushToast}
        />
      </div>
    </>
  );
}
