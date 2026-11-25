/**
 * Settings route entry module (live language & appearance controls; isolated for Wave 5).
 */

import { useCallback } from "react";

import { PreferenceBar } from "../components/PreferenceBar.tsx";
import { useI18n } from "../lib/i18n.ts";
import { preferenceSync } from "../lib/preferences.ts";
import { useTheme } from "../lib/theme.ts";
import type { AppearancePref, LanguagePref } from "../lib/types.ts";
import type { PageProps } from "./types.ts";

export function SettingsPage({ snapshot, t }: PageProps) {
  const i18n = useI18n();
  const theme = useTheme();

  const handleLanguageChange = useCallback((pref: LanguagePref) => {
    preferenceSync.setLanguage(pref);
  }, []);

  const handleAppearanceChange = useCallback((pref: AppearancePref) => {
    preferenceSync.setAppearance(pref);
  }, []);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.settings")}</h1>
        <p className="page-subtitle">{t("app.settings.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.settings.loading")}</span>
            </div>
          </section>
        ) : (
          <section className="card settings-section">
            <div className="card-heading">
              <h2 className="card-title">{t("app.settings.general.title")}</h2>
              <p className="card-desc">{t("app.settings.general.description")}</p>
            </div>
            <div className="card-actions">
              <PreferenceBar
                language={i18n.preference}
                browserLocale={i18n.browserLocale}
                appearance={theme.preference}
                t={t}
                onLanguageChange={handleLanguageChange}
                onAppearanceChange={handleAppearanceChange}
              />
            </div>
          </section>
        )}
      </div>
    </>
  );
}
