/**
 * General settings card: immediate language and appearance preferences persisted
 * via `preferenceSync` to `/api/settings`, with explicit save error feedback.
 */

import { memo, useId } from "react";

import { AlertIcon, CloseIcon } from "../../components/Icons.tsx";
import { SUPPORTED_LOCALES, type Dictionary, type TranslateFn } from "../../lib/i18n.ts";
import { APPEARANCE_OPTIONS } from "../../lib/theme.ts";
import type { AppearancePref, LanguagePref, Locale } from "../../lib/types.ts";

const LOCALE_LABEL_KEYS = {
  "en-US": "app.language.en_us",
  "zh-CN": "app.language.zh_cn",
  "zh-TW": "app.language.zh_tw",
  "ja-JP": "app.language.ja_jp",
  "ko-KR": "app.language.ko_kr",
} as const;

const APPEARANCE_LABEL_KEYS = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
} as const;

export interface GeneralSectionProps {
  readonly language: LanguagePref;
  readonly browserLocale: Locale;
  readonly dict: Dictionary | null;
  readonly appearance: AppearancePref;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly t: TranslateFn;
  readonly onLanguageChange: (pref: LanguagePref) => void;
  readonly onAppearanceChange: (pref: AppearancePref) => void;
  readonly onRetrySave: () => void;
  readonly onDismissError: () => void;
}

export const GeneralSection = memo(function GeneralSection({
  language,
  browserLocale,
  appearance,
  saving,
  saveError,
  t,
  onLanguageChange,
  onAppearanceChange,
  onRetrySave,
  onDismissError,
}: GeneralSectionProps) {
  const languageId = useId();
  const appearanceLabelId = useId();
  const appearanceGroup = useId();

  return (
    <section className="card settings-section" data-settings-general="true">
      <div className="card-heading">
        <h2 className="card-title">{t("app.settings.general.title")}</h2>
        <p className="card-desc">{t("app.settings.general.description")}</p>
      </div>

      <div className="settings-list">
        <div className="settings-row">
          <div className="settings-row-info">
            <label className="settings-row-title" htmlFor={languageId}>
              {t("app.settings.language.title")}
            </label>
            <p className="settings-row-desc">{t("app.settings.language.description")}</p>
          </div>
          <div className="settings-row-control">
            <select
              id={languageId}
              name="language"
              className="select select-sm select-inline"
              value={language}
              onChange={(event) => onLanguageChange(event.target.value as LanguagePref)}
            >
              <option value="system">
                {t("app.settings.language.system", {
                  language: t(LOCALE_LABEL_KEYS[browserLocale]),
                })}
              </option>
              {SUPPORTED_LOCALES.map((loc) => (
                <option key={loc} value={loc}>
                  {t(LOCALE_LABEL_KEYS[loc])}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title" id={appearanceLabelId}>
              {t("app.settings.appearance.title")}
            </span>
            <p className="settings-row-desc">{t("app.settings.appearance.description")}</p>
          </div>
          <div className="settings-row-control">
            <fieldset className="settings-fieldset" aria-labelledby={appearanceLabelId}>
              <legend className="visually-hidden">{t("app.settings.appearance.title")}</legend>
              <div className="segmented">
                {APPEARANCE_OPTIONS.map((option) => {
                  const optionId = `${appearanceGroup}-${option}`;
                  return (
                    <span className="segmented-item" key={option}>
                      <input
                        id={optionId}
                        className="segmented-input"
                        type="radio"
                        name={appearanceGroup}
                        value={option}
                        checked={appearance === option}
                        onChange={() => onAppearanceChange(option)}
                      />
                      <label className="segmented-label" htmlFor={optionId}>
                        {t(APPEARANCE_LABEL_KEYS[option])}
                      </label>
                    </span>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </div>
      </div>

      {saveError !== null && (
        <div
          className="alert alert-danger settings-inline-alert"
          role="alert"
          data-settings-general-error="true"
        >
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{t("app.toast.save_failed.title")}</p>
            <p className="alert-body">{saveError}</p>
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={saving}
                data-settings-general-retry="true"
                onClick={onRetrySave}
              >
                {saving && <span className="spinner" aria-hidden="true" />}
                <span>{t("app.action.retry")}</span>
              </button>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon alert-dismiss"
            aria-label={t("app.action.dismiss")}
            onClick={onDismissError}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </section>
  );
});
