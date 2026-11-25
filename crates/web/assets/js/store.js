import { apiRequest, clearToken, hasToken, setUnauthorizedHandler, streamSse } from "./api.js";
import { setLanguagePreference } from "./i18n.js";
import { setAppearancePreference } from "./theme.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;

const listeners = new Set();
let sseController = null;
let reconnectTimer = null;
let sseGeneration = 0;
let authGeneration = 0;
let overviewPromise = null;
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
  accountsBusy: {
    refresh: false,
    adopt: false,
    switch: false,
    remove: false,
  },
  accountsUsageError: null,
  dismissedRecovered: false,
  accountNotice: null,
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
  authGeneration += 1;
  overviewPromise = null;
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
  state.accountsBusy = {
    refresh: false,
    adopt: false,
    switch: false,
    remove: false,
  };
  state.accountsUsageError = null;
  state.dismissedRecovered = false;
  state.accountNotice = null;
  emit("auth");
}

setUnauthorizedHandler(() => {
  if (state.authenticated) {
    handleSessionLost({ expired: true });
  }
});

export async function enterAuthenticatedSession() {
  authGeneration += 1;
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
  const gen = authGeneration;
  try {
    const snap = await apiRequest("/api/snapshot");
    if (gen !== authGeneration || !state.authenticated) return;
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
      if (generation !== sseGeneration || !state.authenticated) {
        return;
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
  if (overviewPromise) {
    return overviewPromise;
  }
  const gen = authGeneration;
  if (!silent) {
    state.overviewLoading = true;
    state.overviewError = null;
    emit("overview");
  }
  overviewPromise = (async () => {
    try {
      const data = await apiRequest("/api/overview");
      if (gen !== authGeneration || !state.authenticated) return;
      state.overview = data;
      state.overviewError = null;
    } catch (err) {
      if (gen !== authGeneration || (err && err.status === 401)) return;
      state.overviewError = err?.payload || { error: {} };
    } finally {
      if (gen === authGeneration) {
        overviewPromise = null;
        state.overviewLoading = false;
        emit("overview");
      }
    }
  })();
  return overviewPromise;
}

export async function loadPlugins() {
  if (!state.authenticated) return;
  const gen = authGeneration;
  try {
    const list = await apiRequest("/api/plugins");
    if (gen !== authGeneration || !state.authenticated) return;
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
  const gen = authGeneration;
  state.settingsLoading = true;
  emit("settings");
  try {
    let data = await apiRequest("/api/settings");
    if (gen !== authGeneration || !state.authenticated) return null;
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
          const patched = await apiRequest("/api/settings", { method: "PATCH", body: patch });
          if (gen !== authGeneration || !state.authenticated) return null;
          data = patched;
        } catch {
          if (gen !== authGeneration || !state.authenticated) return null;
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
    if (gen === authGeneration) {
      state.settingsLoading = false;
      emit("settings");
    }
  }
}

export async function patchSettings(patch) {
  const gen = authGeneration;
  const data = await apiRequest("/api/settings", { method: "PATCH", body: patch });
  if (gen === authGeneration && state.authenticated) {
    state.settings = data;
    emit("settings");
  }
  return data;
}

export async function loadUpdates() {
  if (!state.authenticated) return;
  const gen = authGeneration;
  state.updatesLoading = true;
  state.updatesError = null;
  emit("updates");
  try {
    const data = await apiRequest("/api/updates");
    if (gen !== authGeneration || !state.authenticated) return;
    state.updates = data;
  } catch (err) {
    if (gen !== authGeneration || (err && err.status === 401)) return;
    state.updatesError = err?.payload || { error: {} };
  } finally {
    if (gen === authGeneration) {
      state.updatesLoading = false;
      emit("updates");
    }
  }
}

export async function refreshUsage() {
  return refreshAccountsUsage();
}

export async function refreshAccountsUsage() {
  if (!state.authenticated || state.accountsBusy.refresh) return;
  const gen = authGeneration;
  state.accountsBusy.refresh = true;
  state.accountsUsageError = null;
  emit("accounts");
  try {
    await apiRequest("/api/accounts/usage/refresh", { method: "POST", body: {} });
    if (gen !== authGeneration || !state.authenticated) return;
    await fetchInitialSnapshot();
  } catch (err) {
    if (gen !== authGeneration || (err && err.status === 401)) return;
    state.accountsUsageError = err?.payload || { error: {} };
    throw err;
  } finally {
    if (gen === authGeneration) {
      state.accountsBusy.refresh = false;
      emit("accounts");
    }
  }
}

export async function adoptAccount() {
  if (!state.authenticated || state.accountsBusy.adopt) return;
  const gen = authGeneration;
  state.accountsBusy.adopt = true;
  emit("accounts");
  try {
    await apiRequest("/api/accounts/adopt", {
      method: "POST",
      body: { account_context: getAccountContext() },
    });
    if (gen !== authGeneration || !state.authenticated) return;
    await Promise.allSettled([fetchInitialSnapshot(), loadOverview({ silent: true })]);
  } finally {
    if (gen === authGeneration) {
      state.accountsBusy.adopt = false;
      emit("accounts");
    }
  }
}

export async function beginAccountLogin() {
  return apiRequest("/api/accounts/login", {
    method: "POST",
    body: { account_context: getAccountContext() },
  });
}

export async function submitAccountLogin(loginId, code) {
  const account = await apiRequest(`/api/accounts/login/${encodeURIComponent(loginId)}`, {
    method: "POST",
    body: { code },
  });
  void fetchInitialSnapshot();
  if (!state.overview?.accounts?.active) {
    void loadOverview({ silent: true });
  }
  return account;
}

export async function cancelAccountLogin(loginId) {
  await apiRequest(`/api/accounts/login/${encodeURIComponent(loginId)}`, {
    method: "DELETE",
    body: {},
  });
  void fetchInitialSnapshot();
}

export async function previewAccountSwitch(accountId) {
  return apiRequest(`/api/accounts/${encodeURIComponent(accountId)}/switch`);
}

export async function confirmAccountSwitch(accountId, approval) {
  const gen = authGeneration;
  state.accountsBusy.switch = true;
  emit("accounts");
  try {
    const view = await apiRequest(`/api/accounts/${encodeURIComponent(accountId)}/switch`, {
      method: "POST",
      body: {
        account_context: approval.account_context,
        confirmation: approval.confirmation,
      },
    });
    if (gen === authGeneration && state.authenticated) {
      void fetchInitialSnapshot();
    }
    return view;
  } finally {
    if (gen === authGeneration) {
      state.accountsBusy.switch = false;
      emit("accounts");
    }
  }
}

export async function removeAccount(accountId) {
  const gen = authGeneration;
  state.accountsBusy.remove = true;
  emit("accounts");
  try {
    await apiRequest(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      body: { account_context: getAccountContext() },
    });
    if (gen === authGeneration && state.authenticated) {
      void fetchInitialSnapshot();
    }
  } finally {
    if (gen === authGeneration) {
      state.accountsBusy.remove = false;
      emit("accounts");
    }
  }
}

export function dismissRecoveredNotice() {
  state.dismissedRecovered = true;
  emit("accounts");
}

export function setAccountNotice(notice) {
  state.accountNotice = notice;
  emit("accounts");
}

export function clearAccountNotice() {
  state.accountNotice = null;
  emit("accounts");
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

export function getAccountsView() {
  return state.snapshot?.accounts || state.overview?.accounts || null;
}

export function getAccountContext() {
  if (state.snapshot?.account) {
    return state.snapshot.account;
  }
  const view = getAccountsView();
  return { revision: 0, active: view?.active || null };
}

export function getUsageList() {
  if (Array.isArray(state.snapshot?.usage) && state.snapshot.usage.length > 0) {
    return state.snapshot.usage;
  }
  return Array.isArray(state.overview?.usage) ? state.overview.usage : [];
}

export function getUsageForAccount(accountId, accountRecord = null) {
  const entry = getUsageList().find((item) => item.account === accountId) || null;
  if (entry && (entry.snapshot || entry.last_error)) {
    return entry;
  }
  if (accountRecord?.usage) {
    return {
      account: accountId,
      email: accountRecord.email || null,
      snapshot: accountRecord.usage,
      eta: entry?.eta ?? null,
      unmanaged_runtimes: entry?.unmanaged_runtimes ?? 0,
      ownership_verified: entry?.ownership_verified ?? false,
      last_error: entry?.last_error ?? null,
    };
  }
  return entry;
}

export function getAccountTotals() {
  const view = getAccountsView();
  const accounts = Array.isArray(view?.accounts) ? view.accounts : [];
  let known = 0;
  let unknown = 0;
  let balanceCu = 0;
  let rateCuPerHour = 0;
  let runtimes = 0;

  for (const account of accounts) {
    const usage = getUsageForAccount(account.id, account);
    const snap = usage?.snapshot || null;
    if (snap) {
      known += 1;
      balanceCu += Number(snap.balance_cu) || 0;
      rateCuPerHour += Number(snap.rate_cu_per_hour) || 0;
      runtimes += Number(snap.assignments) || 0;
    } else {
      unknown += 1;
    }
  }

  return { known, unknown, balanceCu, rateCuPerHour, runtimes };
}

export function getRemoveBlock(accountId) {
  const view = getAccountsView();
  if (view?.active === accountId) {
    return "active";
  }
  const runtimesView = state.snapshot?.runtimes;
  const runtimes = runtimesView?.runtimes;
  if (Array.isArray(runtimes) && runtimes.some((rt) => rt?.id?.account === accountId)) {
    return "running";
  }
  const runtimesErrors = Array.isArray(runtimesView?.errors) ? runtimesView.errors : [];
  const runtimeListIncomplete =
    !Array.isArray(runtimes) ||
    Boolean(state.snapshot?.runtimes_error) ||
    runtimesErrors.some((err) => err?.account === accountId);
  if (runtimeListIncomplete) {
    const account = (view?.accounts || []).find((a) => a.id === accountId) || null;
    const usage = getUsageForAccount(accountId, account);
    if ((usage?.snapshot?.assignments || 0) > 0 || (usage?.unmanaged_runtimes || 0) > 0) {
      return "running";
    }
  }
  return null;
}

export function getUnmanagedAccounts() {
  const view = getAccountsView();
  const accounts = Array.isArray(view?.accounts) ? view.accounts : [];
  const items = [];
  for (const account of accounts) {
    const usage = getUsageForAccount(account.id, account);
    if (!usage) continue;
    const stale = Boolean(usage.snapshot?.stale);
    if (!usage.ownership_verified && usage.snapshot) {
      items.push({ email: account.email || usage.email || null, count: null, stale });
    } else if ((usage.unmanaged_runtimes || 0) > 0) {
      items.push({
        email: account.email || usage.email || null,
        count: usage.unmanaged_runtimes,
        stale,
      });
    }
  }
  return items;
}

export function getActiveUsage() {
  const usageList = getUsageList();
  const activeId = state.snapshot?.account?.active || state.overview?.accounts?.active || null;
  if (!activeId) return null;
  const view = getAccountsView();
  const record = (view?.accounts || []).find((a) => a.id === activeId) || null;
  return usageList.find((item) => item.account === activeId) || (record?.usage ? getUsageForAccount(activeId, record) : null);
}

export function getActiveEmail() {
  const accounts = getAccountsView();
  if (!accounts) return null;
  if (accounts.active_email) return accounts.active_email;
  if (!accounts.active) return null;
  const found = (accounts.accounts || []).find((a) => a.id === accounts.active);
  return found?.email || null;
}
