const THEME_STORAGE_KEY = "cpg_appearance";
export const APPEARANCE_PREFS = ["light", "dark", "system"];

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set();

let preference = readStoredPreference();

function readStoredPreference() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (value && APPEARANCE_PREFS.includes(value)) {
      return value;
    }
  } catch {
    // Ignore blocked storage.
  }
  return "system";
}

function writeStoredPreference(pref) {
  try {
    if (pref === "system") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref);
    }
  } catch {
    // Ignore blocked storage.
  }
}

function applyToDocument(pref) {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.content = pref === "system" ? "light dark" : pref;
  }
  document.documentElement.dataset.theme = pref;
}

export function getAppearancePreference() {
  return preference;
}

export function getResolvedAppearance() {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return media.matches ? "dark" : "light";
}

export function setAppearancePreference(pref, { persist = true } = {}) {
  const normalized = APPEARANCE_PREFS.includes(pref) ? pref : "system";
  preference = normalized;
  if (persist) {
    writeStoredPreference(normalized);
  }
  applyToDocument(normalized);
  notify();
}

function notify() {
  const resolved = getResolvedAppearance();
  for (const fn of listeners) {
    fn(preference, resolved);
  }
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  applyToDocument(preference);
  // Keep explicit overrides pinned even when the OS later matches them.
  media.addEventListener("change", () => {
    if (preference === "system") {
      notify();
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY) {
      const next = readStoredPreference();
      if (next !== preference) {
        preference = next;
        applyToDocument(next);
        notify();
      }
    }
  });
}
