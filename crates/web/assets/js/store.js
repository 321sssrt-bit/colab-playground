import { apiRequest, clearToken, hasToken, setUnauthorizedHandler, streamSse } from "./api.js";
import { formatConcern, formatHardware, formatRuntimeCardLabel } from "./format.js";
import { setLanguagePreference, t } from "./i18n.js";
import { setAppearancePreference } from "./theme.js";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;
const ENDED_LIMIT = 20;
const DEFAULT_REARM_SECS = 7200;

const listeners = new Set();
let sseController = null;
let reconnectTimer = null;
let sseGeneration = 0;
let authGeneration = 0;
let overviewPromise = null;
let sessionsPromise = null;
let forwardsPromise = null;
let provisionStreamController = null;
let provisionRetryTimer = null;
let provisionBackoffMs = INITIAL_BACKOFF_MS;
let lastForwardsSignature = "";
let seenGuardReportKey = "";
let pendingLoginLanguage = null;
let pendingLoginAppearance = null;

function emptyProvisionState() {
  return {
    id: null,
    sessionName: "",
    spec: null,
    phase: "idle", // idle | running | ready | failed | cancelled
    events: [],
    latestAtMs: null,
    outcome: null,
    error: null,
    cancelling: false,
  };
}

function runtimeKey(ref) {
  if (!ref) return "";
  return `${ref.account}/${ref.endpoint || ""}`;
}

function tunnelsSignature(tunnels) {
  if (!Array.isArray(tunnels) || tunnels.length === 0) {
    return "";
  }
  return tunnels
    .map((item) => `${item.id}:${item.state?.state || ""}:${item.healthy ?? ""}:${item.spec?.bind || ""}`)
    .join("|");
}

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
  sessionsSampledAt: null,
  sessionsLoading: false,
  sessionsRefreshing: false,
  sessionsError: null,
  sessionsAccountErrors: null,
  sessionsEnded: [],
  forwards: [],
  forwardsLoaded: false,
  provision: emptyProvisionState(),
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

function stopProvisionStream() {
  if (provisionRetryTimer !== null) {
    window.clearTimeout(provisionRetryTimer);
    provisionRetryTimer = null;
  }
  provisionBackoffMs = INITIAL_BACKOFF_MS;
  if (provisionStreamController) {
    provisionStreamController.abort();
    provisionStreamController = null;
  }
}

export function handleSessionLost({ expired = true } = {}) {
  authGeneration += 1;
  overviewPromise = null;
  sessionsPromise = null;
  forwardsPromise = null;
  lastForwardsSignature = "";
  seenGuardReportKey = "";
  stopProvisionStream();
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
  state.sessionsSampledAt = null;
  state.sessionsLoading = false;
  state.sessionsRefreshing = false;
  state.sessionsError = null;
  state.sessionsAccountErrors = null;
  state.sessionsEnded = [];
  state.forwards = [];
  state.forwardsLoaded = false;
  state.provision = emptyProvisionState();
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
    loadForwards(),
    loadPlugins(),
    loadUpdates(),
  ]);
}

function recordEndedRuntime({ target, label, email, reason }) {
  if (!target) return;
  const key = runtimeKey(target);
  const next = state.sessionsEnded.filter((item) => runtimeKey(item.runtime) !== key);
  next.unshift({
    runtime: target,
    label: label || target.name || target.endpoint || "",
    email: email || null,
    reason,
  });
  state.sessionsEnded = next.slice(0, ENDED_LIMIT);
}

function observeGuardReport(prevSnapshot, nextSnapshot) {
  const report = nextSnapshot?.guard;
  if (!report || typeof report !== "object") {
    return;
  }
  const decisions = Array.isArray(report.decisions) ? report.decisions : [];
  const vanished = Array.isArray(report.vanished) ? report.vanished : [];
  const signature = JSON.stringify({
    stopped: decisions
      .filter((d) => d?.stopped)
      .map((d) => `${runtimeKey(d.session)}:${d.decision?.concerns?.limit || ""}`),
    vanished: vanished.map((v) => runtimeKey(v)),
  });
  if (!signature || signature === seenGuardReportKey) {
    return;
  }
  seenGuardReportKey = signature;

  const prevRuntimes = Array.isArray(prevSnapshot?.runtimes?.runtimes)
    ? prevSnapshot.runtimes.runtimes
    : [];
  const accounts = nextSnapshot?.accounts?.accounts || prevSnapshot?.accounts?.accounts || [];
  const lookupInfo = (ref) => {
    const matched = prevRuntimes.find((rt) => runtimeKey(rt.id) === runtimeKey(ref));
    const acct = accounts.find((a) => a.id === ref?.account);
    return {
      label: matched ? formatRuntimeCardLabel(matched) : ref?.name || ref?.endpoint || "",
      email: matched?.account_email || acct?.email || null,
    };
  };

  for (const item of decisions) {
    if (item?.decision?.decision === "stop" && item.stopped && item.session) {
      const info = lookupInfo(item.session);
      const concern = item.decision.concerns;
      recordEndedRuntime({
        target: item.session,
        label: info.label,
        email: info.email,
        reason: { kind: "guard", concern },
      });
      setNotice({
        tone: "danger",
        title: t("app.b2.guard_stopped_title", { name: info.label }),
        message: formatConcern(concern),
      });
    }
  }
  for (const ref of vanished) {
    const info = lookupInfo(ref);
    recordEndedRuntime({
      target: ref,
      label: info.label,
      email: info.email,
      reason: { kind: "vanished" },
    });
    setNotice({
      tone: "info",
      title: t("app.b2.vanished_title", { name: info.label }),
      message: t("app.b2.ended_vanished"),
    });
  }
}

function syncProvisionWithOperations(snapshot) {
  const ops = Array.isArray(snapshot?.operations) ? snapshot.operations : [];
  const activeOp = ops.find((entry) => entry?.operation?.kind === "provision") || null;
  if (activeOp) {
    if (state.provision.id === activeOp.id) {
      if (state.provision.cancelling !== Boolean(activeOp.cancelling)) {
        state.provision.cancelling = Boolean(activeOp.cancelling);
        emit("provision");
      }
      if (
        state.provision.phase === "running" &&
        !provisionStreamController &&
        provisionRetryTimer === null
      ) {
        void consumeProvisionStream(activeOp.id, authGeneration);
      }
    } else if (state.provision.phase !== "running") {
      void attachSessionProvision(activeOp.id, activeOp.operation.session || "");
    }
  }
}

function applySnapshot(next) {
  if (!next || typeof next !== "object") {
    return;
  }
  if (state.snapshot && typeof next.version === "number" && next.version < state.snapshot.version) {
    return;
  }
  const prev = state.snapshot;
  state.snapshot = next;
  if (
    next.runtimes &&
    !next.runtimes_error &&
    (!prev || typeof next.version !== "number" || next.version > prev.version)
  ) {
    state.sessionsError = null;
  }
  observeGuardReport(prev, next);
  syncProvisionWithOperations(next);
  const nextSig = tunnelsSignature(next.tunnels);
  if (nextSig !== lastForwardsSignature) {
    lastForwardsSignature = nextSig;
    void loadForwards();
  }
  emit("snapshot");
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
          void loadForwards();
          if (
            state.provision.phase === "running" &&
            state.provision.id !== null &&
            !provisionStreamController
          ) {
            if (provisionRetryTimer !== null) {
              window.clearTimeout(provisionRetryTimer);
              provisionRetryTimer = null;
            }
            provisionBackoffMs = INITIAL_BACKOFF_MS;
            void consumeProvisionStream(state.provision.id, authGeneration);
          }
        }
      },
      onEvent: ({ event, data }) => {
        if (generation !== sseGeneration) return;
        if (event === "snapshot") {
          applySnapshot(data);
        } else if (event === "forward") {
          void loadForwards();
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

export function setNotice(notice) {
  state.accountNotice = notice;
  emit("notice");
}

export function clearNotice() {
  state.accountNotice = null;
  emit("notice");
}

export function setAccountNotice(notice) {
  setNotice(notice);
}

export function clearAccountNotice() {
  clearNotice();
}

export function clearEndedSessions() {
  state.sessionsEnded = [];
  emit("sessions");
}

export function getBackendNowSecs() {
  if (state.sessionsSampledAt) {
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - state.sessionsSampledAt.localMs) / 1000));
    return state.sessionsSampledAt.serverSecs + elapsedSecs;
  }
  return Math.floor(Date.now() / 1000);
}

export function getRearmDurationSecs() {
  const configured = state.settings?.defaults?.max_runtime;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_REARM_SECS;
}

export function getMaxConcurrentSessions() {
  const configured = state.settings?.defaults?.max_concurrent_sessions;
  if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
    return Math.floor(configured);
  }
  return 2;
}

export function getSessionLimitReached() {
  const runtimes = state.snapshot?.runtimes?.runtimes;
  if (!Array.isArray(runtimes)) {
    return null;
  }
  const limit = getMaxConcurrentSessions();
  const counted = runtimes
    .filter((rt) => rt?.on_active_account && rt?.id?.name)
    .map((rt) => rt.id.name);
  if (counted.length >= limit) {
    return {
      limit,
      email: getActiveEmail(),
      counted,
    };
  }
  return null;
}

export function isRuntimeStopping(ref) {
  const key = runtimeKey(ref);
  const ops = state.snapshot?.operations;
  return (
    Array.isArray(ops) &&
    ops.some(
      (entry) =>
        entry?.operation?.kind === "domain" &&
        entry.operation.name === "stop_runtime" &&
        entry.operation.key === key
    )
  );
}

export function isRuntimeAutoStopBusy(ref) {
  const key = runtimeKey(ref);
  const ops = state.snapshot?.operations;
  return (
    Array.isArray(ops) &&
    ops.some(
      (entry) =>
        entry?.operation?.kind === "domain" &&
        entry.operation.name === "auto_stop" &&
        entry.operation.key === key
    )
  );
}

export function isStopAllRunning() {
  const ops = state.snapshot?.operations;
  return (
    Array.isArray(ops) &&
    ops.some(
      (entry) =>
        entry?.operation?.kind === "domain" && entry.operation.name === "stop_all_runtimes"
    )
  );
}

export function isProvisionRunning() {
  if (state.provision.phase === "running") {
    return true;
  }
  const ops = state.snapshot?.operations;
  return Array.isArray(ops) && ops.some((entry) => entry?.operation?.kind === "provision");
}

export function getForwardsForRuntime(runtime) {
  if (!runtime?.id?.name) return [];
  const account = runtime.id.account;
  const session = runtime.id.name;
  const list = state.forwardsLoaded ? state.forwards : state.snapshot?.tunnels || [];
  return list.filter(
    (item) => item?.spec?.account === account && item?.spec?.session === session
  );
}

export async function loadSessions({ silent = false } = {}) {
  if (!state.authenticated) return null;
  if (sessionsPromise) {
    return sessionsPromise;
  }
  const gen = authGeneration;
  if (silent) {
    state.sessionsRefreshing = true;
  } else {
    state.sessionsLoading = true;
    state.sessionsError = null;
  }
  emit("sessions");
  sessionsPromise = (async () => {
    try {
      const data = await apiRequest("/api/sessions");
      if (gen !== authGeneration || !state.authenticated) return null;
      if (typeof data?.sampled_at === "number" && Number.isFinite(data.sampled_at)) {
        state.sessionsSampledAt = { serverSecs: data.sampled_at, localMs: Date.now() };
      }
      state.sessionsAccountErrors = Array.isArray(data?.errors) ? data.errors : [];
      state.sessionsError = null;
      void loadForwards();
      void fetchInitialSnapshot();
      return data;
    } catch (err) {
      if (gen !== authGeneration || (err && err.status === 401)) return null;
      state.sessionsError = err?.payload || { error: {} };
      return null;
    } finally {
      if (gen === authGeneration) {
        sessionsPromise = null;
        state.sessionsLoading = false;
        state.sessionsRefreshing = false;
        emit("sessions");
      }
    }
  })();
  return sessionsPromise;
}

export async function loadForwards() {
  if (!state.authenticated) return null;
  if (forwardsPromise) {
    return forwardsPromise;
  }
  const gen = authGeneration;
  forwardsPromise = (async () => {
    try {
      const list = await apiRequest("/api/forwards");
      if (gen !== authGeneration || !state.authenticated) return null;
      if (Array.isArray(list)) {
        state.forwards = list;
        state.forwardsLoaded = true;
        emit("forwards");
      }
      return list;
    } catch {
      return null;
    } finally {
      if (gen === authGeneration) {
        forwardsPromise = null;
      }
    }
  })();
  return forwardsPromise;
}

export async function fetchSessionTemplate() {
  return apiRequest("/api/sessions/template");
}

async function consumeProvisionStream(id, gen) {
  if (provisionRetryTimer !== null) {
    window.clearTimeout(provisionRetryTimer);
    provisionRetryTimer = null;
  }
  if (provisionStreamController) {
    provisionStreamController.abort();
    provisionStreamController = null;
  }
  const controller = new AbortController();
  provisionStreamController = controller;
  const streamEvents = [];
  const result = await streamSse(
    `/api/sessions/${encodeURIComponent(id)}/events`,
    {},
    {
      signal: controller.signal,
      onOpen: () => {
        if (gen !== authGeneration || state.provision.id !== id) return;
        provisionBackoffMs = INITIAL_BACKOFF_MS;
      },
      onEvent: ({ event, data }) => {
        if (gen !== authGeneration || state.provision.id !== id) return;
        if (event === "progress" && data) {
          streamEvents.push(data);
          // Reconnecting replays the server journal from index 0; only advance on new or equal length.
          if (streamEvents.length >= state.provision.events.length) {
            const grew = streamEvents.length > state.provision.events.length;
            state.provision.events = [...streamEvents];
            if (grew) {
              state.provision.latestAtMs = Date.now();
            }
            emit("provision");
          }
        } else if (event === "finished" && data) {
          state.provision.cancelling = false;
          if (data.phase === "ready") {
            state.provision.phase = "ready";
            state.provision.outcome = data.outcome || null;
            state.provision.error = null;
            const readyName = data.outcome?.name || state.provision.sessionName;
            if (data.outcome?.below_spec) {
              const hardware =
                formatHardware(data.outcome.hardware?.gpu, data.outcome.hardware?.vram_mib) ||
                t("app.b2.prov_no_gpu");
              setNotice({
                tone: "warning",
                title: t("app.b2.provision_ready_toast", { name: readyName }),
                message: t("app.b2.prov_ready_below", { hardware }),
              });
            } else {
              setNotice({
                tone: "success",
                message: t("app.b2.provision_ready_toast", { name: readyName }),
              });
            }
          } else if (data.phase === "cancelled") {
            state.provision.phase = "cancelled";
            state.provision.error = null;
          } else {
            state.provision.phase = "failed";
            state.provision.error = data.error ? { error: data.error } : { error: {} };
          }
          emit("provision");
          void Promise.allSettled([
            loadSessions({ silent: true }),
            refreshAccountsUsage().catch(() => {}),
          ]);
        }
      },
    }
  );
  if (provisionStreamController === controller) {
    provisionStreamController = null;
  }
  if (gen !== authGeneration || state.provision.id !== id || state.provision.phase !== "running") {
    return;
  }
  if (result.outcome === "aborted" || result.outcome === "unauthorized") {
    return;
  }
  if (result.outcome === "http_error") {
    state.provision.phase = "failed";
    state.provision.cancelling = false;
    state.provision.error = result.payload || { error: {} };
    emit("provision");
    void loadSessions({ silent: true });
    return;
  }
  // Keep transient network/stream drops in the running state and retry the retained server journal.
  const delay = provisionBackoffMs;
  provisionBackoffMs = Math.min(provisionBackoffMs * 2, MAX_BACKOFF_MS);
  provisionRetryTimer = window.setTimeout(() => {
    provisionRetryTimer = null;
    if (
      gen === authGeneration &&
      state.authenticated &&
      state.provision.id === id &&
      state.provision.phase === "running"
    ) {
      void consumeProvisionStream(id, gen);
    }
  }, delay);
}

export async function attachSessionProvision(id, sessionName = "") {
  if (!state.authenticated || id === null || id === undefined) return;
  const gen = authGeneration;
  if (state.provision.id === id) {
    if (sessionName && !state.provision.sessionName) {
      state.provision.sessionName = sessionName;
      emit("provision");
    }
    if (
      state.provision.phase === "running" &&
      !provisionStreamController &&
      provisionRetryTimer === null
    ) {
      await consumeProvisionStream(id, gen);
    }
    return;
  }
  state.provision = {
    id,
    sessionName,
    spec: state.provision.spec,
    phase: "running",
    events: [],
    latestAtMs: Date.now(),
    outcome: null,
    error: null,
    cancelling: false,
  };
  emit("provision");
  await consumeProvisionStream(id, gen);
}

export async function startSessionProvision(spec, accountContext = null) {
  const gen = authGeneration;
  const accepted = await apiRequest("/api/sessions", {
    method: "POST",
    body: {
      account_context: accountContext || getAccountContext(),
      spec,
    },
  });
  if (gen !== authGeneration || !state.authenticated) return null;
  const id = accepted?.id;
  if (id === null || id === undefined) {
    return null;
  }
  if (state.provision.id === id) {
    if (!state.provision.sessionName) {
      state.provision.sessionName = spec.name;
    }
    if (!state.provision.spec) {
      state.provision.spec = JSON.parse(JSON.stringify(spec));
    }
    emit("provision");
    if (
      state.provision.phase === "running" &&
      !provisionStreamController &&
      provisionRetryTimer === null
    ) {
      void consumeProvisionStream(id, gen);
    }
    return id;
  }
  if (
    state.provision.phase === "running" &&
    state.provision.id !== null &&
    (provisionStreamController || provisionRetryTimer !== null)
  ) {
    const ops = Array.isArray(state.snapshot?.operations) ? state.snapshot.operations : [];
    const currentStillActive = ops.some(
      (entry) => entry?.operation?.kind === "provision" && entry.id === state.provision.id
    );
    const returnedActive = ops.some(
      (entry) => entry?.operation?.kind === "provision" && entry.id === id
    );
    if (currentStillActive && !returnedActive) {
      return state.provision.id;
    }
  }
  state.provision = {
    id,
    sessionName: spec.name,
    spec: JSON.parse(JSON.stringify(spec)),
    phase: "running",
    events: [],
    latestAtMs: Date.now(),
    outcome: null,
    error: null,
    cancelling: false,
  };
  emit("provision");
  void consumeProvisionStream(id, gen);
  return id;
}

export async function cancelSessionProvision() {
  const id = state.provision.id;
  if (id === null || id === undefined || state.provision.phase !== "running" || state.provision.cancelling) {
    return;
  }
  state.provision.cancelling = true;
  emit("provision");
  try {
    await apiRequest(`/api/sessions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: {},
    });
  } catch {
    if (state.provision.id === id && state.provision.phase === "running") {
      state.provision.cancelling = false;
      emit("provision");
    }
  }
}

export function resetProvisionState() {
  if (state.provision.phase === "running") {
    return;
  }
  state.provision = emptyProvisionState();
  emit("provision");
}

export function notifyProvisionView() {
  emit("sessions");
}

export async function stopRuntime(target, { label, email } = {}) {
  await apiRequest("/api/sessions/stop", {
    method: "POST",
    body: { target, confirmed: true },
  });
  recordEndedRuntime({
    target,
    label: label || target?.name || target?.endpoint || "",
    email: email || null,
    reason: { kind: "user" },
  });
  setNotice({
    tone: "success",
    message: t("app.b2.stop_done", { name: label || target?.name || target?.endpoint || "" }),
  });
  void Promise.allSettled([
    loadSessions({ silent: true }),
    loadForwards(),
    refreshAccountsUsage().catch(() => {}),
  ]);
}

export async function changeAutoStop(target, action) {
  const result = await apiRequest("/api/sessions/auto-stop", {
    method: "POST",
    body: {
      account_context: getAccountContext(),
      target,
      action,
    },
  });
  void loadSessions({ silent: true });
  return result;
}

export async function stopAllRuntimes() {
  const report = await apiRequest("/api/sessions/stop-all", {
    method: "POST",
    body: { confirmed: true },
  });
  void Promise.allSettled([
    loadSessions({ silent: true }),
    loadForwards(),
    refreshAccountsUsage().catch(() => {}),
  ]);
  return report;
}

export async function openForward(spec, accountContext = null) {
  const view = await apiRequest("/api/forwards", {
    method: "POST",
    body: {
      account_context: accountContext || getAccountContext(),
      account: spec.account,
      session: spec.session,
      bind: spec.bind,
      local_port: spec.local_port,
      remote_port: spec.remote_port,
      health_path: spec.health_path,
    },
  });
  if (view && view.id !== undefined) {
    state.forwards = [...state.forwards.filter((item) => item.id !== view.id), view];
    state.forwardsLoaded = true;
    emit("forwards");
  }
  void Promise.allSettled([loadForwards(), fetchInitialSnapshot()]);
  return view;
}

export async function closeForward(id) {
  const resp = await apiRequest(`/api/forwards/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: {},
  });
  state.forwards = state.forwards.filter((item) => item.id !== id);
  emit("forwards");
  setNotice({
    tone: "info",
    title: t("app.b2.forward_closed"),
    message: t(resp?.notice_key || "app.b2.forward_closed_billing"),
  });
  void Promise.allSettled([loadForwards(), fetchInitialSnapshot()]);
  return resp;
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
