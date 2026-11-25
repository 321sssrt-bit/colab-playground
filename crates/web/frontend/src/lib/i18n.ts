/**
 * 5-locale merged dictionary loader, browser language mapping, preference
 * persistence, and message interpolation backed by `/assets/i18n/{locale}.json`.
 */

import { useSyncExternalStore } from "react";

import type { LanguagePref, Locale } from "./types.ts";

export type { LanguagePref, Locale } from "./types.ts";

export type Dictionary = Readonly<Record<string, string>>;

export type I18nParams = Readonly<Record<string, string | number>>;

export type TranslateFn = (key: string, params?: I18nParams) => string;

export const SUPPORTED_LOCALES: readonly Locale[] = [
  "en-US",
  "zh-CN",
  "zh-TW",
  "ja-JP",
  "ko-KR",
];

export const LANGUAGE_STORAGE_KEY = "cpg_language";

const DEFAULT_LOCALE: Locale = "en-US";
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5000;
const MAX_RETRY_EXPONENT = 4;

export interface I18nState {
  readonly preference: LanguagePref;
  readonly browserLocale: Locale;
  readonly locale: Locale;
  readonly dict: Dictionary | null;
  readonly loading: boolean;
  readonly loadFailed: boolean;
}

export interface I18nStoreOptions {
  readonly fetchImpl?: typeof fetch;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly getBrowserLanguages?: () => readonly string[];
  readonly doc?: Pick<Document, "documentElement" | "title" | "visibilityState" | "addEventListener" | "removeEventListener"> | null;
  readonly win?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface SetPreferenceOptions {
  readonly userInitiated?: boolean;
}

export interface I18nStore {
  getState(): I18nState;
  getVersion(): number;
  subscribe(listener: () => void): () => void;
  t: TranslateFn;
  setPreference(pref: LanguagePref, options?: SetPreferenceOptions): void;
  adoptFromServer(pref: LanguagePref): void;
  shouldPushToServer(): boolean;
  markSynced(expectedVersion?: number): void;
  dispose(): void;
}

function isLocale(value: unknown): value is Locale {
  return (
    value === "en-US" ||
    value === "zh-CN" ||
    value === "zh-TW" ||
    value === "ja-JP" ||
    value === "ko-KR"
  );
}

export function isLanguagePref(value: unknown): value is LanguagePref {
  return value === "system" || isLocale(value);
}

function matchLocaleTag(rawTag: string): Locale | null {
  const tag = rawTag.trim().toLowerCase().replaceAll("_", "-");
  if (!tag) {
    return null;
  }
  if (
    tag.startsWith("zh-tw") ||
    tag.startsWith("zh-hk") ||
    tag.startsWith("zh-mo") ||
    (tag.startsWith("zh") && tag.includes("hant"))
  ) {
    return "zh-TW";
  }
  if (tag.startsWith("zh")) {
    return "zh-CN";
  }
  if (tag.startsWith("ja")) {
    return "ja-JP";
  }
  if (tag.startsWith("ko")) {
    return "ko-KR";
  }
  if (tag.startsWith("en")) {
    return "en-US";
  }
  return null;
}

function defaultBrowserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [DEFAULT_LOCALE];
  }
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : [DEFAULT_LOCALE];
}

/**
 * Maps browser language tags to one of the five supported locales.
 */
export function detectBrowserLocale(languages?: readonly string[]): Locale {
  const candidates = languages ?? defaultBrowserLanguages();
  for (const tag of candidates) {
    const matched = matchLocaleTag(tag);
    if (matched !== null) {
      return matched;
    }
  }
  return DEFAULT_LOCALE;
}

export function resolveLocale(pref: LanguagePref, browserLocale?: Locale): Locale {
  return pref === "system" ? (browserLocale ?? detectBrowserLocale()) : pref;
}

/**
 * Substitutes `{name}` placeholders in one pass so inserted values are never re-expanded.
 */
export function formatMessage(template: string, params?: I18nParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export async function loadDictionary(
  locale: Locale,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<Dictionary> {
  const fn = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fn(`/assets/i18n/${locale}.json`, {
    headers: { Accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const raw: unknown = await response.json();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid dictionary payload");
  }
  return raw as Dictionary;
}

function resolveDefaultStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Storage may be blocked in restricted browser contexts.
    return null;
  }
}

function readStoredLanguage(
  storage: Pick<Storage, "getItem"> | null,
): { pref: LanguagePref; stored: boolean } {
  if (!storage) {
    return { pref: "system", stored: false };
  }
  try {
    const raw = storage.getItem(LANGUAGE_STORAGE_KEY);
    if (isLanguagePref(raw)) {
      // Distinguish an explicit stored "system" choice from an untouched fresh browser.
      return { pref: raw, stored: true };
    }
  } catch {
    // Ignore storage read failures in restricted browser contexts.
  }
  return { pref: "system", stored: false };
}

function writeStoredLanguage(
  storage: Pick<Storage, "setItem" | "removeItem"> | null,
  pref: LanguagePref,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // Apply the preference in memory even when persistence is unavailable.
  }
}

/**
 * Creates a live localization store with dictionary caching, cold-load recovery,
 * and cross-tab sync.
 */
export function createI18nStore(options: I18nStoreOptions = {}): I18nStore {
  const storage = options.storage !== undefined ? options.storage : resolveDefaultStorage();
  const getBrowserLanguages = options.getBrowserLanguages ?? defaultBrowserLanguages;
  const doc =
    options.doc !== undefined
      ? options.doc
      : typeof document !== "undefined"
        ? document
        : null;
  const win =
    options.win !== undefined
      ? options.win
      : typeof window !== "undefined"
        ? window
        : null;
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

  const initial = readStoredLanguage(storage);
  const initialBrowserLocale = detectBrowserLocale(getBrowserLanguages());
  const initialLocale = resolveLocale(initial.pref, initialBrowserLocale);

  const cache = new Map<Locale, Dictionary>();
  const listeners = new Set<() => void>();

  let hasStoredPreference = initial.stored;
  let dirtyBeforeSync = false;
  let preferenceVersion = 0;
  let disposed = false;
  let requestSeq = 0;
  let retryAttempt = 0;
  let activeController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let state: I18nState = {
    preference: initial.pref,
    browserLocale: initialBrowserLocale,
    locale: initialLocale,
    dict: null,
    loading: true,
    loadFailed: false,
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const applyDocumentMeta = (locale: Locale, dict: Dictionary | null): void => {
    if (!doc) {
      return;
    }
    doc.documentElement.lang = locale;
    const appName = dict?.["app.name"];
    if (appName) {
      doc.title = appName;
    }
  };

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so all consumers stay in sync.
      }
    }
  };

  const setState = (patch: Partial<I18nState>): void => {
    const next: I18nState = { ...state, ...patch };
    if (
      next.preference === state.preference &&
      next.browserLocale === state.browserLocale &&
      next.locale === state.locale &&
      next.dict === state.dict &&
      next.loading === state.loading &&
      next.loadFailed === state.loadFailed
    ) {
      return;
    }
    state = next;
    emit();
  };

  const scheduleColdStartRetry = (locale: Locale): void => {
    if (disposed || state.dict !== null) {
      return;
    }
    clearRetryTimer();
    const exponent = Math.min(retryAttempt, MAX_RETRY_EXPONENT);
    const delayMs = Math.min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2 ** exponent);
    retryAttempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (disposed || state.dict !== null || state.locale !== locale) {
        return;
      }
      ensureLocaleLoaded(locale, true);
    }, delayMs);
  };

  const ensureLocaleLoaded = (locale: Locale, forceFetch = false): void => {
    if (disposed) {
      return;
    }
    clearRetryTimer();
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }

    const cached = !forceFetch ? cache.get(locale) : undefined;
    if (cached) {
      retryAttempt = 0;
      applyDocumentMeta(locale, cached);
      setState({
        locale,
        dict: cached,
        loading: false,
        loadFailed: false,
      });
      return;
    }

    const seq = ++requestSeq;
    const controller = new AbortController();
    activeController = controller;
    applyDocumentMeta(locale, state.dict);
    setState({
      locale,
      loading: true,
      loadFailed: false,
    });

    loadDictionary(locale, controller.signal, options.fetchImpl)
      .then((loaded) => {
        if (disposed || seq !== requestSeq) {
          return;
        }
        activeController = null;
        retryAttempt = 0;
        cache.set(locale, loaded);
        applyDocumentMeta(locale, loaded);
        setState({
          locale,
          dict: loaded,
          loading: false,
          loadFailed: false,
        });
      })
      .catch(() => {
        if (disposed || seq !== requestSeq || controller.signal.aborted) {
          return;
        }
        activeController = null;
        setState({
          loading: false,
          loadFailed: true,
        });
        scheduleColdStartRetry(locale);
      });
  };

  const updatePreference = (
    pref: LanguagePref,
    opts: { persist: boolean; userInitiated: boolean; stored: boolean },
  ): void => {
    if (disposed) {
      return;
    }
    if (opts.persist) {
      writeStoredLanguage(storage, pref);
    }
    hasStoredPreference = opts.stored;
    if (opts.userInitiated) {
      preferenceVersion += 1;
      dirtyBeforeSync = true;
    }
    retryAttempt = 0;
    const nextLocale = resolveLocale(pref, state.browserLocale);
    setState({ preference: pref, locale: nextLocale });
    ensureLocaleLoaded(nextLocale);
  };

  const onStorage = (event: StorageEvent): void => {
    if (disposed || event.key !== LANGUAGE_STORAGE_KEY) {
      return;
    }
    const stored = isLanguagePref(event.newValue);
    const nextPref = stored ? event.newValue : "system";
    updatePreference(nextPref, { persist: false, userInitiated: false, stored });
  };

  const onLanguageChange = (): void => {
    if (disposed) {
      return;
    }
    const nextBrowserLocale = detectBrowserLocale(getBrowserLanguages());
    const nextLocale = resolveLocale(state.preference, nextBrowserLocale);
    setState({ browserLocale: nextBrowserLocale, locale: nextLocale });
    if (state.preference === "system") {
      retryAttempt = 0;
      ensureLocaleLoaded(nextLocale);
    }
  };

  const retryIfFailed = (): void => {
    if (disposed || !state.loadFailed || state.loading) {
      return;
    }
    retryAttempt = 0;
    ensureLocaleLoaded(state.locale, true);
  };

  const onVisibilityChange = (): void => {
    if (doc && doc.visibilityState === "visible") {
      retryIfFailed();
    }
  };

  win?.addEventListener("storage", onStorage);
  win?.addEventListener("languagechange", onLanguageChange);
  win?.addEventListener("online", retryIfFailed);
  doc?.addEventListener("visibilitychange", onVisibilityChange);
  ensureLocaleLoaded(initialLocale);

  return {
    getState(): I18nState {
      return state;
    },

    getVersion(): number {
      return preferenceVersion;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    t(key: string, params?: I18nParams): string {
      const template = state.dict?.[key];
      if (template === undefined) {
        return "";
      }
      return formatMessage(template, params);
    },

    setPreference(pref: LanguagePref, opts: SetPreferenceOptions = {}): void {
      updatePreference(pref, {
        persist: true,
        userInitiated: opts.userInitiated ?? true,
        stored: true,
      });
    },

    adoptFromServer(pref: LanguagePref): void {
      dirtyBeforeSync = false;
      updatePreference(pref, { persist: true, userInitiated: false, stored: true });
    },

    shouldPushToServer(): boolean {
      return dirtyBeforeSync || hasStoredPreference;
    },

    markSynced(expectedVersion?: number): void {
      if (expectedVersion !== undefined && expectedVersion !== preferenceVersion) {
        return;
      }
      dirtyBeforeSync = false;
    },

    dispose(): void {
      disposed = true;
      clearRetryTimer();
      if (activeController !== null) {
        activeController.abort();
        activeController = null;
      }
      win?.removeEventListener("storage", onStorage);
      win?.removeEventListener("languagechange", onLanguageChange);
      win?.removeEventListener("online", retryIfFailed);
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      listeners.clear();
    },
  };
}

/** Shared localization store for the Browser Client. */
export const i18nStore: I18nStore = createI18nStore();

/**
 * React hook subscribing to live localization state and translator function.
 */
export function useI18n(store: I18nStore = i18nStore): I18nState & { readonly t: TranslateFn } {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { ...snapshot, t: store.t };
}
