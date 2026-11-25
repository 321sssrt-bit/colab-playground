/**
 * Language selector (5 locales + follow browser) and 3-state appearance
 * segmented control (Light / Dark / System) shared before and after sign-in.
 */

import { useId } from "react";

import { SUPPORTED_LOCALES, type TranslateFn } from "../lib/i18n.ts";
import { APPEARANCE_OPTIONS } from "../lib/theme.ts";
import type { AppearancePref, LanguagePref, Locale } from "../lib/types.ts";

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

export interface PreferenceBarProps {
  readonly language: LanguagePref;
  readonly browserLocale: Locale;
  readonly appearance: AppearancePref;
  readonly t: TranslateFn;
  readonly onLanguageChange: (pref: LanguagePref) => void;
  readonly onAppearanceChange: (pref: AppearancePref) => void;
}

export function PreferenceBar({
  language,
  browserLocale,
  appearance,
  t,
  onLanguageChange,
  onAppearanceChange,
}: PreferenceBarProps) {
  const languageId = useId();
  const appearanceGroup = useId();

  return (
    <>
      <div>
        <label className="visually-hidden" htmlFor={languageId}>
          {t("app.settings.language.title")}
        </label>
        <select
          id={languageId}
          name="language"
          className="select select-sm select-compact"
          value={language}
          onChange={(event) => onLanguageChange(event.target.value as LanguagePref)}
        >
          <option value="system">
            {t("app.settings.language.system", {
              language: t(LOCALE_LABEL_KEYS[browserLocale]),
            })}
          </option>
          {SUPPORTED_LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {t(LOCALE_LABEL_KEYS[locale])}
            </option>
          ))}
        </select>
      </div>

      <fieldset className="settings-fieldset">
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
    </>
  );
}
