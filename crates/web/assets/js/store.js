import { apiRequest, clearToken, hasToken, setUnauthorizedHandler, streamSse } from "./api.js";
import { setLanguagePreference } from "./i18n.js";
import { setAppearancePreference } from "./theme.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

const listeners = new Set();
let sseController = null;
let reconnectTimer = null;
let sseGeneration = 0;
let pendingLoginLanguage = null;
let pendingLoginAppearance = null;

export function recordLoginLanguageChoice(pref) {
  pendingLoginLanguage = pref;
}

export function recordLoginAppearanceChoice(pref) {
  pendingLoginAppearance = pref;
}

export const state = {
  authenticated: false,
  sessionExpired: false,
  connection: "idle", // idle | connecting | connected | reconnecting
  snapshot: null,
  overview: null,
  overviewLoading: false,
  overviewError: null,
  plugins: [],
  settings: null,
  settingsLoading: false,
  updates: null,
  updatesLoading: false,
  updatesError: null,
  install: {
    id: null,
    running: false,
    cancelling: false,
    phase: "idle", // idle | running | succeeded | failed | cancelled
    error: null,
    lines: [],
  },
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(reason) {
  for (const fn of listeners) {
    fn(state, reason);
  }
}

export function notifyState(reason) {
  emit(reason);
}

function stopSse() {
  sseGeneration += 1;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (sseController) {
    sseController.abort();
    sseController = null;
  }
}

export function handleSessionLost({ expired = true } = {}) {
  stopSse();
  clearToken();
  state.authenticated = false;
  state.sessionExpired = expired;
  state.connection = "idle";
  state.snapshot = null;
  state.overview = null;
  state.overviewError = null;
  state.plugins = [];
  state.settings = null;
  state.updates = null;
  state.updatesError = null;
  state.install = {
    id: null,
    running: false,
    cancelling: false,
    phase: "idle",
    error: null,
    lines: [],
  };
  emit("auth");
}

setUnauthorizedHandler(() => {
  if (state.authenticated) {
    handleSessionLost({ expired: true });
  }
});

export async function enterAuthenticatedSession() {
  state.authenticated = true;
  state.sessionExpired = false;
  state.connection = "connecting";
  emit("auth");

  // Start SSE immediately so slow startup probes or update checks never block live snapshots.
  startSseLoop();
  void Promise.allSettled([
    fetchInitialSnapshot(),
    loadSettings({ applyPrefs: true }),
    loadOverview(),
    loadPlugins(),
    loadUpdates(),
  ]);
}

export async function fetchInitialSnapshot() {
  try {
    const snap = await apiRequest("/api/snapshot");
    applySnapshot(snap);
  } catch {
    // 401 is handled globally; transient failure recovers via SSE loop.
  }
}

function applySnapshot(next) {
  if (!next || typeof next !== "object") {
    return;
  }
  if (state.snapshot && typeof next.version === "number" && next.version < state.snapshot.version) {
    return;
  }
  state.snapshot = next;
  emit("snapshot");
}

async function startSseLoop() {
  stopSse();
  const generation = sseGeneration;
  let backoff = INITIAL_BACKOFF_MS;
  let needsRecoverySnapshot = false;

  const run = async () => {
    if (generation !== sseGeneration || !state.authenticated || !hasToken()) {
      return;
    }
    sseController = new AbortController();
    const result = await streamSse("/api/events", {}, {
      signal: sseController.signal,
      onOpen: () => {
        if (generation !== sseGeneration) return;
        const recovered = needsRecoverySnapshot;
        backoff = INITIAL_BACKOFF_MS;
        needsRecoverySnapshot = false;
        state.connection = "connected";
        emit("connection");
        if (recovered) {
          void fetchInitialSnapshot();
          void loadOverview({ silent: true });
        }
      },
      onEvent: ({ event, data }) => {
        if (generation !== sseGeneration) return;
        if (event === "snapshot") {
          applySnapshot(data);
        }
      },
    });

    if (generation !== sseGeneration || !state.authenticated) {
      return;
    }
    if (result.outcome === "unauthorized" || result.outcome === "aborted") {
      return;
    }

    // Stream closed cleanly (e.g. token expiry, key rotation, or server shutdown): probe session.
    if (result.outcome === "closed") {
      try {
        await apiRequest("/api/session");
      } catch (err) {
        if (err && err.status === 401) {
          return;
        }
      }
    }

    needsRecoverySnapshot = true;
    state.connection = "reconnecting";
    emit("connection");
    const delay = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void run();
    }, delay);
  };

  void run();
}

export async function loadOverview({ silent = false } = {}) {
  if (!state.authenticated) return;
  if (!silent) {
    state.overviewLoading = true;
    state.overviewError = null;
    emit("overview");
  }
  try {
    const data = await apiRequest("/api/overview");
    state.overview = data;
    state.overviewError = null;
  } catch (err) {
    if (err && err.status === 401) return;
    state.overviewError = err?.payload || { error: {} };
  } finally {
    state.overviewLoading = false;
    emit("overview");
  }
}

export async function loadPlugins() {
  if (!state.authenticated) return;
  try {
    const list = await apiRequest("/api/plugins");
    if (Array.isArray(list)) {
      state.plugins = list;
      emit("plugins");
    }
  } catch {
    // Non-fatal; quick-deploy list simply stays empty.
  }
}

export async function loadSettings({ applyPrefs = false } = {}) {
  if (!state.authenticated) return null;
  state.settingsLoading = true;
  emit("settings");
  try {
    let data = await apiRequest("/api/settings");
    if (applyPrefs && data) {
      const loginLang = pendingLoginLanguage;
      const loginAppearance = pendingLoginAppearance;
      pendingLoginLanguage = null;
      pendingLoginAppearance = null;

      const patch = {};
      if (loginLang && loginLang !== data.language) {
        patch.language = loginLang;
      }
      if (loginAppearance && loginAppearance !== data.appearance) {
        patch.appearance = loginAppearance;
      }
      if (Object.keys(patch).length > 0) {
        try {
          data = await apiRequest("/api/settings", { method: "PATCH", body: patch });
        } catch {
          data = { ...data, ...patch };
        }
      }
      state.settings = data;
      if (!loginAppearance && data.appearance) {
        setAppearancePreference(data.appearance, { persist: true });
      }
      if (!loginLang && data.language) {
        await setLanguagePreference(data.language, { persist: true });
      }
    } else {
      state.settings = data;
    }
    return state.settings;
  } catch {
    return null;
  } finally {
    state.settingsLoading = false;
    emit("settings");
  }
}

export async function patchSettings(patch) {
  const data = await apiRequest("/api/settings", { method: "PATCH", body: patch });
  state.settings = data;
  emit("settings");
  return data;
}

export async function loadUpdates() {
  if (!state.authenticated) return;
  state.updatesLoading = true;
  state.updatesError = null;
  emit("updates");
  try {
    state.updates = await apiRequest("/api/updates");
  } catch (err) {
    if (err && err.status === 401) return;
    state.updatesError = err?.payload || { error: {} };
  } finally {
    state.updatesLoading = false;
    emit("updates");
  }
}

export async function refreshUsage() {
  if (!state.authenticated) return;
  await apiRequest("/api/accounts/usage/refresh", { method: "POST", body: {} });
  await loadOverview({ silent: true });
}

export async function adoptAccount() {
  if (!state.authenticated || !state.snapshot) return;
  await apiRequest("/api/accounts/adopt", {
    method: "POST",
    body: { account_context: state.snapshot.account },
  });
  await loadOverview({ silent: true });
}

export async function startCliInstall(method) {
  if (!state.authenticated || state.install.running) return;
  state.install = {
    id: null,
    running: true,
    cancelling: false,
    phase: "running",
    error: null,
    lines: [],
  };
  emit("install");

  const result = await streamSse(
    "/api/overview/cli/install",
    { method },
    {
      onEvent: ({ event, data }) => {
        if (event === "started" && data && typeof data.id === "number") {
          state.install.id = data.id;
          emit("install");
        } else if (event === "line" && data) {
          state.install.lines.push(data);
          emit("install");
        } else if (event === "finished" && data) {
          state.install.running = false;
          state.install.cancelling = false;
          state.install.phase = data.status || "failed";
          state.install.error = data.error ? { error: data.error } : null;
          emit("install");
        }
      },
    }
  );

  if (state.install.running) {
    state.install.running = false;
    state.install.cancelling = false;
    state.install.phase = "failed";
    state.install.error = result.payload || { error: {} };
    emit("install");
  }
  if (state.install.phase === "succeeded") {
    await loadOverview({ silent: true });
  }
}

export async function cancelCliInstall() {
  if (!state.install.running || state.install.id === null || state.install.cancelling) {
    return;
  }
  state.install.cancelling = true;
  emit("install");
  try {
    await apiRequest(`/api/overview/cli/install/${state.install.id}/cancel`, {
      method: "POST",
      body: {},
    });
  } catch {
    state.install.cancelling = false;
    emit("install");
  }
}

export function getActiveUsage() {
  const usageList = state.snapshot?.usage?.length ? state.snapshot.usage : state.overview?.usage || [];
  const activeId = state.snapshot?.account?.active || state.overview?.accounts?.active || null;
  if (!activeId) return null;
  return usageList.find((item) => item.account === activeId) || null;
}

export function getActiveEmail() {
  const accounts = state.snapshot?.accounts || state.overview?.accounts;
  if (!accounts) return null;
  if (accounts.active_email) return accounts.active_email;
  if (!accounts.active) return null;
  const found = (accounts.accounts || []).find((a) => a.id === accounts.active);
  return found?.email || null;
}
