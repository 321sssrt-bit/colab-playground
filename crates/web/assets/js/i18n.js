const LANG_STORAGE_KEY = "cpg_language";
export const SUPPORTED_LOCALES = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR"];
export const LANGUAGE_PREFS = ["system", ...SUPPORTED_LOCALES];

const LANGUAGE_NAME_KEYS = {
  "en-US": "app.language.en_us",
  "zh-CN": "app.language.zh_cn",
  "zh-TW": "app.language.zh_tw",
  "ja-JP": "app.language.ja_jp",
  "ko-KR": "app.language.ko_kr",
};

const cache = new Map();
const listeners = new Set();

let preference = readStoredPreference();
let currentLocale = resolveLocale(preference);
let messages = {};

function readStoredPreference() {
  try {
    const value = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (value && LANGUAGE_PREFS.includes(value)) {
      return value;
    }
  } catch {
    // Ignore storage access restrictions.
  }
  return "system";
}

function storePreference(pref) {
  try {
    if (pref === "system") {
      window.localStorage.removeItem(LANG_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LANG_STORAGE_KEY, pref);
    }
  } catch {
    // Ignore storage access restrictions.
  }
}

export function browserLocale() {
  const candidates =
    Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language || "en-US"];
  for (const raw of candidates) {
    const mapped = mapLocaleTag(raw);
    if (mapped) {
      return mapped;
    }
  }
  return "en-US";
}

// Mirrors colab_playground_shared::i18n::Language::from_os_locale on browser tags.
function mapLocaleTag(locale) {
  if (!locale || typeof locale !== "string") {
    return null;
  }
  const clean = locale.split(/[._@]/)[0].replaceAll("_", "-");
  const parts = clean.split("-").filter(Boolean);
  const lang = (parts[0] || "").toLowerCase();
  if (lang === "ja") return "ja-JP";
  if (lang === "ko") return "ko-KR";
  if (lang === "en") return "en-US";
  if (lang !== "zh") return null;
  let script = null;
  let region = null;
  for (const part of parts.slice(1)) {
    if (!script && part.length === 4 && /^[a-zA-Z]+$/.test(part)) {
      script = part.toLowerCase();
    } else if (!region && (part.length === 2 || (part.length === 3 && /^\d+$/.test(part)))) {
      region = part.toUpperCase();
    }
  }
  if (script === "hant") return "zh-TW";
  if (script === "hans") return "zh-CN";
  if (region === "TW" || region === "HK" || region === "MO") return "zh-TW";
  return "zh-CN";
}

export function resolveLocale(pref) {
  if (pref && SUPPORTED_LOCALES.includes(pref)) {
    return pref;
  }
  return browserLocale();
}

export function getLanguagePreference() {
  return preference;
}

export function getLocale() {
  return currentLocale;
}

export function languageNameKey(locale) {
  return LANGUAGE_NAME_KEYS[locale] || LANGUAGE_NAME_KEYS["en-US"];
}

export function languageLabel(pref) {
  if (pref === "system") {
    const resolved = browserLocale();
    return t("app.settings.language.system", { language: t(languageNameKey(resolved)) });
  }
  return t(languageNameKey(pref));
}

async function fetchDictionary(locale) {
  if (cache.has(locale)) {
    return cache.get(locale);
  }
  const res = await fetch(`/assets/i18n/${encodeURIComponent(locale)}.json`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`i18n fetch failed: ${res.status}`);
  }
  const dict = await res.json();
  cache.set(locale, dict);
  return dict;
}

export async function initI18n() {
  const locale = resolveLocale(preference);
  messages = await fetchDictionary(locale);
  currentLocale = locale;
  document.documentElement.lang = locale;
  window.addEventListener("languagechange", () => {
    if (preference === "system") {
      void setLanguagePreference("system", { persist: false });
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === LANG_STORAGE_KEY) {
      const next = readStoredPreference();
      if (next !== preference) {
        void setLanguagePreference(next, { persist: false });
      }
    }
  });
}

export async function setLanguagePreference(pref, { persist = true } = {}) {
  const normalized = LANGUAGE_PREFS.includes(pref) ? pref : "system";
  preference = normalized;
  if (persist) {
    storePreference(normalized);
  }
  const nextLocale = resolveLocale(normalized);
  if (nextLocale !== currentLocale || Object.keys(messages).length === 0) {
    messages = await fetchDictionary(nextLocale);
    currentLocale = nextLocale;
    document.documentElement.lang = nextLocale;
  }
  for (const fn of listeners) {
    fn(currentLocale, preference);
  }
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, args = null) {
  const template = messages[key];
  if (typeof template !== "string") {
    return key;
  }
  if (!args) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined && args[name] !== null) {
      return String(args[name]);
    }
    return match;
  });
}

export function localized(map) {
  if (!map || typeof map !== "object") {
    return "";
  }
  const locale = currentLocale;
  if (typeof map[locale] === "string") {
    return map[locale];
  }
  const lower = locale.toLowerCase();
  const base = lower.split("-")[0];
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower && typeof v === "string") {
      return v;
    }
  }
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase().split("-")[0] === base && typeof v === "string") {
      return v;
    }
  }
  if (typeof map.en === "string") {
    return map.en;
  }
  const first = Object.values(map).find((v) => typeof v === "string");
  return first || "";
}
