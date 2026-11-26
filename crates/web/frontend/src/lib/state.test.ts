import assert from "node:assert/strict";
import test, { after } from "node:test";

import { ApiError, createApiClient } from "./api.ts";
import {
  createAppDataStore,
  isAccountChangeBlocked,
  isCliInstalledFromSnapshot,
  resolveEffectiveOverview,
} from "./appCache.ts";
import { createServerClock } from "./clock.ts";
import { evaluateUsageSampleFreshness, USAGE_STALE_AFTER_SECS } from "./format.ts";
import { createForwardsStore } from "./forwards.ts";
import { createI18nStore, i18nStore } from "./i18n.ts";
import { createPreferenceSync } from "./preferences.ts";
import {
  createRouterStore,
  parseHashRoute,
  parseSettingsFocus,
  routeToHash,
} from "./router.ts";
import { createWebStore } from "./store.ts";
import { createThemeStore } from "./theme.ts";
import { createToastStore } from "./toast.ts";
import type {
  Account,
  AccountsApiResponse,
  ForwardView,
  OverviewResponse,
  PendingOperation,
  Runtime,
  SessionsListResponse,
  SettingsView,
  Snapshot,
  TunnelInfo,
  UpdateNoticeResponse,
  UsageSnapshot,
} from "./types.ts";
import { createUpdatesStore } from "./updates.ts";
import { CORE_DEFAULTS } from "./constants.ts";
import {
  buildOverviewUnmanagedWarning,
  deriveChecklist,
  selectQuickDeployPlugins,
} from "../pages/overview/api.ts";
import { createCliInstallStore } from "../pages/overview/installStore.ts";
import type { PluginInfo } from "../pages/plugins/types.ts";
import { createSettingsDraftStore } from "../pages/settings/draftStore.ts";
import { createSettingsNoticeStore } from "../pages/settings/noticeStore.ts";

// Stop the module-level i18n singleton's cold-start retry loop in headless Node test runs.
after(() => {
  i18nStore.dispose();
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    server_now: 1_700_000_000,
    backend: "mock",
    account: { revision: 3, active: "acct-1" },
    accounts: {
      accounts: [
        {
          id: "acct-1",
          email: "alice@example.com",
          created_at: 1_699_000_000,
          updated_at: 1_699_000_000,
          usage: null,
        },
      ],
      active: "acct-1",
      has_token: true,
      unadopted: false,
      active_email: "alice@example.com",
      recovered_pending_add: false,
    },
    accounts_error: null,
    runtimes: { runtimes: [], errors: [] },
    runtimes_error: null,
    tunnels: [],
    usage: [],
    measured_rates: [],
    guard: null,
    guard_events: [],
    guard_error: null,
    ended: [],
    operations: [],
    login_id: null,
    shutting_down: false,
    ...overrides,
  };
}

function makeOverview(overrides: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    environment: {
      wsl_installed: false,
      wsl_distros: [],
      bash: "/bin/bash",
      ssh: "/usr/bin/ssh",
      ssh_keygen: "/usr/bin/ssh-keygen",
      git: "/usr/bin/git",
      uv: "/usr/bin/uv",
      python3: "/usr/bin/python3",
      colab: "/usr/bin/colab",
      colab_version: "0.8.0",
      helper_python: "/usr/bin/python3",
      keyring_ok: true,
      ssh_key_present: true,
      home: "/home/demo",
      errors: [],
    },
    host: { kind: "shell_tools", ready: true, hint_key: null },
    forward_policy: { all_interfaces_allowed: false, restriction: "loopback_listener" },
    cli_installed: true,
    helper_available: true,
    keyring: { status: "ready", hint_key: null },
    accounts: makeSnapshot().accounts,
    accounts_error: null,
    usage: [],
    measured_rates: [],
    sampled_at: 1_700_000_000,
    unmanaged_runtimes: {
      count: 0,
      incomplete: false,
      unverified_accounts: [],
      warning_key: null,
    },
    install_methods: ["uv"],
    ...overrides,
  };
}

function makeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: { account: "acct-1", endpoint: "ep-1", name: "a100-1" },
    account_email: "alice@example.com",
    on_active_account: true,
    accelerator: "A100",
    hardware: "NVIDIA A100",
    high_mem: false,
    managed: true,
    tracked: null,
    estimated_rate_cu_per_hour: 5.3,
    estimated_spend_cu: 1.2,
    auto_stop_at: 1_700_003_600,
    tunnels: [],
    ...overrides,
  };
}

function makeTunnel(overrides: Partial<TunnelInfo> = {}): TunnelInfo {
  return {
    id: 7,
    spec: {
      account: "acct-1",
      session: "a100-1",
      bind: "loopback",
      local_port: 8000,
      remote_port: 8000,
      health_path: "/health",
    },
    state: { state: "starting" },
    healthy: null,
    ...overrides,
  };
}

function createSseControl() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    sendFrame(event: string, data: unknown, id?: string) {
      const lines = [`event: ${event}`];
      if (id !== undefined) {
        lines.push(`id: ${id}`);
      }
      lines.push(`data: ${JSON.stringify(data)}`, "", "");
      controller?.enqueue(encoder.encode(lines.join("\n")));
    },
    close() {
      try {
        controller?.close();
      } catch {
        // Stream may already be cancelled/closed by store.dispose().
      }
    },
  };
}

async function flushAsync(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

const noopTimers = {
  setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimer: () => {},
};

test("serverClock stays accurate under +2h browser wall-clock skew and preserves failure vs age", () => {
  // Browser clock is +2 hours ahead of backend clock.
  const serverEpoch = 1_700_000_000;
  let browserWallMs = (serverEpoch + 7200) * 1000;
  let monoMs = 10_000;
  const clock = createServerClock({
    wallNow: () => browserWallMs,
    monotonicNow: () => monoMs,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });

  assert.equal(clock.isAnchored(), false);
  assert.equal(clock.getNowSecs(), serverEpoch + 7200);

  // Sync with backend server_now; skewed browser clock is ignored.
  assert.equal(clock.sync(serverEpoch, { authoritative: true }), true);
  assert.equal(clock.isAnchored(), true);
  assert.equal(clock.getNowSecs(), serverEpoch);

  // Non-authoritative older sampled_at does not pull clock backwards.
  assert.equal(clock.sync(serverEpoch - 30), false);
  assert.equal(clock.getNowSecs(), serverEpoch);

  // Advance monotonic time 300s (and jump browser wall clock by 10 hours).
  monoMs += 300_000;
  browserWallMs += 36_000_000;
  assert.equal(clock.getNowSecs(), serverEpoch + 300);

  // Delayed HTTP sampled_at older than current projected server time does not pull clock backwards.
  assert.equal(clock.sync(serverEpoch + 10), false);
  assert.equal(clock.getNowSecs(), serverEpoch + 300);

  // Usage sample at serverEpoch: fresh at 300s, old at 301s, never overwrites failure flag.
  const sample: UsageSnapshot = {
    balance_cu: 50,
    rate_cu_per_hour: 5,
    assignments: 1,
    fetched_at: serverEpoch,
    stale: false,
  };
  assert.equal(USAGE_STALE_AFTER_SECS, 300);
  const atBoundary = evaluateUsageSampleFreshness(sample, null, clock.getNowSecs());
  assert.deepEqual(atBoundary, { ageSecs: 300, isStale: false, isOld: false, outdated: false });

  monoMs += 1_000;
  const aged = evaluateUsageSampleFreshness(sample, null, clock.getNowSecs());
  assert.deepEqual(aged, { ageSecs: 301, isStale: false, isOld: true, outdated: true });

  // Failed fetch remains isStale=true even at age 0.
  const failedSample: UsageSnapshot = { ...sample, fetched_at: clock.getNowSecs(), stale: true };
  const failed = evaluateUsageSampleFreshness(failedSample, null, clock.getNowSecs());
  assert.deepEqual(failed, { ageSecs: 0, isStale: true, isOld: false, outdated: true });

  // Auto-stop deadline 1 hour after serverEpoch still computes 3299s remaining despite +12h browser skew.
  const watchdogDeadline = serverEpoch + 3600;
  assert.equal(watchdogDeadline - clock.getNowSecs(), 3299);

  clock.reset();
  assert.equal(clock.isAnchored(), false);
  clock.dispose();
});

test("appDataStore deduplicates initial Overview, caches across route switches, and skips heavy /api/sessions when snapshot has runtimes", async (t) => {
  const counts = new Map<string, number>();
  const overviewDeferred = createDeferred<Response>();
  const sse = createSseControl();
  const clock = createServerClock({
    wallNow: () => 1_700_007_200_000,
    monotonicNow: () => 1_000,
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = `${init?.method ?? "GET"} ${url}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-1", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/overview") {
        return overviewDeferred.promise;
      }
      if (url === "/api/snapshot") {
        return jsonResponse(makeSnapshot({ version: 2, server_now: 1_700_000_050 }));
      }
      if (url === "/api/sessions") {
        const body: SessionsListResponse = {
          account_context: { revision: 3, active: "acct-1" },
          sampled_at: 1_700_000_060,
          runtimes: [],
          errors: [],
          guard: null,
          guard_events: [],
          guard_error: null,
          ended: [],
        };
        return jsonResponse(body);
      }
      throw new Error(`unexpected fetch: ${key}`);
    },
  });

  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({
    client,
    store,
    clock,
    toast,
    t: (key) => key,
  });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");

  // Simulate double mount + simultaneous Accounts/Overview callers during first login,
  // plus switching to Sessions while Overview probe is still in flight (snapshot.runtimes === null).
  const abort1 = new AbortController();
  const p1 = appData.ensureOverview(abort1.signal);
  const p2 = appData.ensureOverview();
  const pendingSessions = appData.ensureSessions();
  abort1.abort();
  await assert.rejects(p1, (err: unknown) => err instanceof ApiError && err.isAbort);

  // Underlying probe survived caller-1 abort and only fired once; Sessions waited instead of firing GET /api/sessions.
  assert.equal(counts.get("GET /api/overview"), 1);
  assert.equal(counts.get("GET /api/sessions") ?? 0, 0);

  overviewDeferred.resolve(jsonResponse(makeOverview({ sampled_at: 1_700_000_010 })));
  const overview = await p2;
  assert.equal(overview.cli_installed, true);
  assert.equal(clock.getNowSecs(), 1_700_000_010);

  // ensureSessions resolved via lightweight snapshot check without issuing GET /api/sessions.
  const awaitedSessions = await pendingSessions;
  assert.equal(awaitedSessions, null);
  assert.equal(counts.get("GET /api/sessions") ?? 0, 0);

  // Navigating back to Overview / Accounts / opening ForwardDialog hits cache with zero network calls.
  const cached = await appData.ensureOverview();
  assert.equal(cached, overview);
  assert.equal(counts.get("GET /api/overview"), 1);

  // Deliver live SSE snapshot with runtimes populated -> ensureSessions skips GET /api/sessions.
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 2, server_now: 1_700_000_050, runtimes: { runtimes: [makeRuntime()], errors: [] } }),
    "2",
  );
  await flushAsync();
  assert.equal(clock.getNowSecs(), 1_700_000_050);

  const skipped = await appData.ensureSessions();
  assert.equal(skipped, null);
  assert.equal(counts.get("GET /api/sessions") ?? 0, 0);

  // Concurrent refreshSnapshot calls deduplicate to one GET /api/snapshot (1 earlier from ensureSessions + 1 here = 2).
  const snapshotBefore = counts.get("GET /api/snapshot") ?? 0;
  await Promise.all([store.refreshSnapshot(), store.refreshSnapshot()]);
  assert.equal(counts.get("GET /api/snapshot"), snapshotBefore + 1);
});

test("forwardsStore keeps SSE forward state and health synchronized while away from Sessions", async (t) => {
  const counts = new Map<string, number>();
  const sse = createSseControl();
  const tunnel = makeTunnel({ id: 42, state: { state: "starting" }, healthy: null });
  const forwardView: ForwardView = {
    ...tunnel,
    state: { state: "up" },
    healthy: true,
    addresses: {
      open_url: "http://127.0.0.1:8000",
      copy_url: "http://127.0.0.1:8000",
      openai_base_url: "http://127.0.0.1:8000/v1",
      notice_key: null,
      warning_key: null,
    },
  };

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = `${init?.method ?? "GET"} ${url}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-fw", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/forwards") {
        return jsonResponse([forwardView]);
      }
      throw new Error(`unexpected fetch: ${key}`);
    },
  });

  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const forwards = createForwardsStore({ client, store });
  t.after(() => {
    forwards.dispose();
    store.dispose();
    sse.close();
    clock.dispose();
  });

  await store.signIn("secret-key");

  // No SessionsPage mounted: snapshot introduces tunnel #42, then forward SSE transitions arrive.
  const rt = makeRuntime({ tunnels: [42] });
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 5, runtimes: { runtimes: [rt], errors: [] }, tunnels: [tunnel] }),
    "5",
  );
  await flushAsync();

  // Global store automatically hydrated server-validated addresses once.
  assert.equal(counts.get("GET /api/forwards"), 1);

  sse.sendFrame("forward", { event: "state", id: 42, state: { state: "up" } });
  sse.sendFrame("forward", { event: "health", id: 42, healthy: true });
  await flushAsync();

  // Returning to Sessions immediately observes state=up, healthy=true, and open_url with zero delay.
  const liveSnap = store.getState().snapshot;
  assert.ok(liveSnap);
  const selected = forwards.selectForwardsForRuntime(rt, liveSnap);
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].state, { state: "up" });
  assert.equal(selected[0].healthy, true);
  assert.equal(selected[0].addresses?.open_url, "http://127.0.0.1:8000");

  // Newer snapshot version supersedes old overlays cleanly.
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 6,
      runtimes: { runtimes: [rt], errors: [] },
      tunnels: [{ ...tunnel, state: { state: "up" }, healthy: false }],
    }),
    "6",
  );
  await flushAsync();
  assert.deepEqual(forwards.getState().overlaysById, {});
  const afterNewSnap = forwards.selectForwardsForRuntime(rt, store.getState().snapshot!);
  assert.equal(afterNewSnap[0].healthy, false);
});

test("refreshUsage skips /api/overview and adoptAccount fetches real revision instead of fabricating 0 and survives unmount", async (t) => {
  const calls: string[] = [];
  const adoptBodies: unknown[] = [];
  const adoptCalled = createDeferred<void>();
  const usageDeferred = createDeferred<Response>();
  const adoptDeferred = createDeferred<Response>();
  const sse = createSseControl();

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-adopt", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/snapshot") {
        return jsonResponse(
          makeSnapshot({
            version: 4,
            server_now: 1_700_000_200,
            account: { revision: 9, active: null },
            accounts: {
              accounts: [],
              active: null,
              has_token: true,
              unadopted: true,
              active_email: "bob@example.com",
              recovered_pending_add: false,
            },
          }),
        );
      }
      if (url === "/api/accounts/adopt") {
        adoptBodies.push(JSON.parse(String(init?.body ?? "{}")));
        adoptCalled.resolve();
        return adoptDeferred.promise;
      }
      if (url === "/api/accounts/usage/refresh") {
        return usageDeferred.promise;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  });

  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({
    client,
    store,
    clock,
    toast,
    t: (key, params) => (params?.email ? `${key}:${params.email}` : key),
  });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");

  // Snapshot is still null before first SSE frame; adoptAccount must pull real snapshot (revision: 9), never fabricate 0.
  assert.equal(store.getState().snapshot, null);
  const unmountAbort = new AbortController();
  const adoptPromise = appData.adoptAccount(unmountAbort.signal);
  // Simulate user navigating away immediately while adopt is in flight.
  unmountAbort.abort();
  await assert.rejects(adoptPromise, (err: unknown) => err instanceof ApiError && err.isAbort);

  await adoptCalled.promise;
  assert.equal(adoptBodies.length, 1);
  assert.deepEqual(adoptBodies[0], { account_context: { revision: 9, active: null } });

  const adoptedAccount: Account = {
    id: "acct-bob",
    email: "bob@example.com",
    created_at: 1_700_000_200,
    updated_at: 1_700_000_200,
    usage: null,
  };
  adoptDeferred.resolve(jsonResponse(adoptedAccount));
  await flushAsync();

  // Toast still delivered globally even though the originating page aborted/unmounted.
  assert.equal(toast.getToasts().length, 1);
  assert.equal(toast.getToasts()[0].body, "app.adopt.done:bob@example.com");

  // refreshUsage settles after caller unmount and never calls GET /api/overview.
  const usageAbort = new AbortController();
  const usagePromise = appData.refreshUsage(usageAbort.signal);
  usageAbort.abort();
  await assert.rejects(usagePromise, (err: unknown) => err instanceof ApiError && err.isAbort);

  const usageResp: AccountsApiResponse = {
    account_context: { revision: 10, active: "acct-bob" },
    accounts: makeSnapshot().accounts!,
    usage: [],
    login_id: null,
    sampled_at: 1_700_000_350,
  };
  usageDeferred.resolve(jsonResponse(usageResp));
  await flushAsync();

  assert.equal(clock.getNowSecs(), 1_700_000_350);
  assert.equal(appData.getState().refreshingUsage, false);
  assert.equal(calls.includes("GET /api/overview"), false);
});

test("isAccountChangeBlocked covers all Slot::Exclusive conflicts and allows Slot::Independent domain ops", () => {
  assert.equal(isAccountChangeBlocked(null), false);
  assert.equal(isAccountChangeBlocked(makeSnapshot()), false);
  assert.equal(isAccountChangeBlocked(makeSnapshot({ login_id: 12 })), true);

  const blockingOps: PendingOperation[] = [
    { id: 1, operation: { kind: "provision", session: "s1" }, cancelling: false },
    { id: 2, operation: { kind: "plugin_run", plugin: "llama-cpp", session: "s1" }, cancelling: false },
    { id: 3, operation: { kind: "switch_account", to: "acct-2" }, cancelling: false },
    { id: 4, operation: { kind: "login", login_id: 5 }, cancelling: false },
    { id: 5, operation: { kind: "domain", name: "adopt_account", key: "" }, cancelling: false },
    { id: 6, operation: { kind: "domain", name: "remove_account", key: "acct-2" }, cancelling: false },
    { id: 7, operation: { kind: "domain", name: "install_cli", key: "" }, cancelling: false },
    { id: 8, operation: { kind: "domain", name: "stop_all_runtimes", key: "" }, cancelling: false },
    { id: 9, operation: { kind: "domain", name: "stop_runtime", key: "acct-1/ep-1" }, cancelling: false },
    { id: 10, operation: { kind: "domain", name: "auto_stop", key: "acct-1/ep-1" }, cancelling: false },
    { id: 11, operation: { kind: "domain", name: "open_forward", key: "acct-1/s1/8000" }, cancelling: false },
  ];
  for (const op of blockingOps) {
    assert.equal(
      isAccountChangeBlocked(makeSnapshot({ operations: [op] })),
      true,
      `expected ${JSON.stringify(op.operation)} to block account changes`,
    );
  }

  const independentOps: PendingOperation[] = [
    { id: 20, operation: { kind: "domain", name: "close_forward", key: "1" }, cancelling: false },
    { id: 21, operation: { kind: "domain", name: "hf_token", key: "" }, cancelling: false },
    { id: 22, operation: { kind: "domain", name: "inspect_plugin", key: "url" }, cancelling: false },
    { id: 23, operation: { kind: "domain", name: "install_plugin", key: "url" }, cancelling: false },
    { id: 24, operation: { kind: "domain", name: "set_plugin_enabled", key: "llama-cpp" }, cancelling: false },
    { id: 25, operation: { kind: "domain", name: "remove_plugin", key: "p1" }, cancelling: false },
  ];
  for (const op of independentOps) {
    assert.equal(
      isAccountChangeBlocked(makeSnapshot({ operations: [op] })),
      false,
      `expected ${JSON.stringify(op.operation)} not to block account changes`,
    );
  }

  // In-flight client Slot::Shared / Slot::Exclusive requests in appDataStore also block account writes.
  assert.equal(
    isAccountChangeBlocked(makeSnapshot(), {
      overviewLoading: false,
      sessionsRefreshing: false,
      refreshingUsage: true,
      adopting: false,
    }),
    true,
  );
  assert.equal(
    isAccountChangeBlocked(makeSnapshot(), {
      overviewLoading: true,
      sessionsRefreshing: false,
      refreshingUsage: false,
      adopting: false,
    }),
    true,
  );
  assert.equal(
    isAccountChangeBlocked(makeSnapshot(), {
      overviewLoading: false,
      sessionsRefreshing: true,
      refreshingUsage: false,
      adopting: false,
    }),
    true,
  );
  assert.equal(
    isAccountChangeBlocked(makeSnapshot(), {
      overviewLoading: false,
      sessionsRefreshing: false,
      refreshingUsage: false,
      adopting: false,
    }),
    false,
  );
});

test("resolveEffectiveOverview overlays live Snapshot state without re-probing /api/overview", () => {
  const initialOverview = makeOverview({
    accounts: {
      accounts: [],
      active: null,
      has_token: false,
      unadopted: false,
      active_email: null,
      recovered_pending_add: false,
    },
    keyring: { status: "unknown", hint_key: null },
  });

  // Cold-start snapshot with accounts=null, accounts_error=null, and runtimes=null does not clobber cached overview.
  const coldSnap = makeSnapshot({ accounts: null, accounts_error: null, runtimes: null });
  assert.equal(resolveEffectiveOverview(initialOverview, coldSnap), initialOverview);

  // Live snapshot after sign-in immediately updates accounts, usage, measured_rates, and keyring=ready.
  const signedInSnap = makeSnapshot({
    server_now: 1_700_000_999,
    measured_rates: [
      { accelerator: "A100", high_mem: false, reading: { cu_per_hour: 5.4, at: 1_700_000_900 } },
    ],
  });
  const effective = resolveEffectiveOverview(initialOverview, signedInSnap);
  assert.ok(effective);
  assert.equal(effective.accounts?.active, "acct-1");
  assert.equal(effective.keyring.status, "ready");
  assert.equal(effective.sampled_at, 1_700_000_999);
  assert.equal(effective.measured_rates?.length, 1);

  // Live keyring failure immediately marks keyring unavailable.
  const keyringErrSnap = makeSnapshot({
    accounts: null,
    accounts_error: "keyring_unavailable",
  });
  const locked = resolveEffectiveOverview(initialOverview, keyringErrSnap);
  assert.equal(locked?.keyring.status, "unavailable");
  assert.equal(locked?.accounts_error, "keyring_unavailable");

  // Cached cli_installed=false from before another browser installed CLI is overridden by live snapshot.
  const preInstallOverview = makeOverview({ cli_installed: false, accounts: null });
  const postInstall = resolveEffectiveOverview(preInstallOverview, signedInSnap);
  assert.equal(postInstall?.cli_installed, true);
  assert.equal(postInstall?.accounts?.active, "acct-1");

  // CLI-post-launch errors (keyring_unavailable / auth_required) prove CLI is installed;
  // transient or host errors (busy / cancelled / wsl_unavailable / not_installed) do NOT.
  const keyringOnlySnap = makeSnapshot({
    accounts: null,
    runtimes: null,
    accounts_error: "keyring_unavailable",
  });
  assert.equal(isCliInstalledFromSnapshot(keyringOnlySnap), true);
  assert.equal(resolveEffectiveOverview(preInstallOverview, keyringOnlySnap)?.cli_installed, true);
  assert.equal(
    isCliInstalledFromSnapshot(makeSnapshot({ accounts: null, runtimes: null, accounts_error: "auth_required" })),
    true,
  );
  for (const nonProofError of ["busy", "cancelled", "wsl_unavailable"] as const) {
    const snap = makeSnapshot({ accounts: null, runtimes: null, accounts_error: nonProofError });
    assert.equal(isCliInstalledFromSnapshot(snap), null);
    assert.equal(resolveEffectiveOverview(preInstallOverview, snap)?.cli_installed, false);
  }
  assert.equal(
    isCliInstalledFromSnapshot(makeSnapshot({ accounts: null, runtimes: null, accounts_error: "not_installed" })),
    false,
  );
});

test("forwardsStore re-hydrates when a new tunnel arrives during an in-flight GET /api/forwards", async (t) => {
  const firstFetch = createDeferred<Response>();
  let forwardsCalls = 0;
  const sse = createSseControl();
  const t1 = makeTunnel({ id: 101 });
  const t2 = makeTunnel({ id: 102, spec: { ...makeTunnel().spec, local_port: 8001, remote_port: 8001 } });
  const view1: ForwardView = {
    ...t1,
    addresses: {
      open_url: "http://127.0.0.1:8000",
      copy_url: "http://127.0.0.1:8000",
      openai_base_url: null,
      notice_key: null,
      warning_key: null,
    },
  };
  const view2: ForwardView = {
    ...t2,
    addresses: {
      open_url: "http://127.0.0.1:8001",
      copy_url: "http://127.0.0.1:8001",
      openai_base_url: null,
      notice_key: null,
      warning_key: null,
    },
  };

  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-rehydrate", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/forwards") {
        forwardsCalls += 1;
        return forwardsCalls === 1 ? firstFetch.promise : jsonResponse([view1, view2]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const forwards = createForwardsStore({ client, store });
  t.after(() => {
    forwards.dispose();
    store.dispose();
    sse.close();
    clock.dispose();
  });

  await store.signIn("secret-key");

  // Snapshot #1 triggers first GET /api/forwards (held in flight).
  sse.sendFrame("snapshot", makeSnapshot({ version: 1, tunnels: [t1] }), "1");
  await flushAsync();
  assert.equal(forwardsCalls, 1);

  // Snapshot #2 introduces tunnel #102 while first GET /api/forwards is still in flight.
  sse.sendFrame("snapshot", makeSnapshot({ version: 2, tunnels: [t1, t2] }), "2");
  await flushAsync();
  assert.equal(forwardsCalls, 1);

  // Completing first fetch (which only knew about #101) triggers follow-up hydration for #102.
  firstFetch.resolve(jsonResponse([view1]));
  await flushAsync();

  assert.equal(forwardsCalls, 2);
  assert.equal(forwards.getState().addressesById[101]?.open_url, "http://127.0.0.1:8000");
  assert.equal(forwards.getState().addressesById[102]?.open_url, "http://127.0.0.1:8001");
});

test("appDataStore clears stale sessionsAccountErrors when live snapshot failure set changes", async (t) => {
  const sse = createSseControl();
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-err", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/sessions") {
        const body: SessionsListResponse = {
          account_context: { revision: 3, active: "acct-1" },
          sampled_at: 1_700_000_060,
          runtimes: [],
          errors: [
            {
              account: "acct-a",
              error: {
                kind: "timeout",
                message_key: "err.timeout",
                args: {},
                hint_key: null,
                action_key: null,
                operation_id: null,
              },
            },
          ],
          guard: null,
          guard_events: [],
          guard_error: null,
          ended: [],
        };
        return jsonResponse(body);
      }
      if (url === "/api/snapshot") {
        return jsonResponse(
          makeSnapshot({
            version: 2,
            runtimes: {
              runtimes: [],
              errors: [
                {
                  account: "acct-a",
                  error: { kind: "timeout", params: {}, detail: "", next_step: "try_again" },
                },
              ],
            },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({ client, store, clock, toast, t: (k) => k });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  await appData.refreshSessions();
  await flushAsync();

  // Matching snapshot preserves the detailed HTTP error override for acct-a.
  assert.equal(appData.getState().sessionsAccountErrors?.[0]?.account, "acct-a");

  // Later background poll recovers acct-a and fails on acct-b -> stale override must clear.
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 3,
      runtimes: {
        runtimes: [],
        errors: [
          {
            account: "acct-b",
            error: { kind: "io", params: {}, detail: "", next_step: "check_network" },
          },
        ],
      },
    }),
    "3",
  );
  await flushAsync();

  assert.equal(appData.getState().sessionsAccountErrors, null);
});

test("ensureSessions checks lightweight /api/snapshot after Overview settles before SSE delivers runtimes", async (t) => {
  const counts = new Map<string, number>();
  const sse = createSseControl();
  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = `${init?.method ?? "GET"} ${url}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-post-ov", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/overview") {
        return jsonResponse(makeOverview());
      }
      if (url === "/api/snapshot") {
        return jsonResponse(
          makeSnapshot({ version: 2, runtimes: { runtimes: [makeRuntime()], errors: [] } }),
        );
      }
      throw new Error(`unexpected fetch: ${key}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({ client, store, clock, toast, t: (k) => k });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  // Overview finishes before SSE pushes any snapshot with runtimes.
  await appData.ensureOverview();
  assert.equal(store.getState().snapshot, null);

  // Navigating to Sessions after Overview already settled pulls memory /api/snapshot, NOT heavy /api/sessions.
  const result = await appData.ensureSessions();
  assert.equal(result, null);
  assert.equal(counts.get("GET /api/snapshot"), 1);
  assert.equal(counts.get("GET /api/sessions") ?? 0, 0);
});

test("slow HTTP /api/sessions arriving after SSE recovery never resurrects stale account errors", async (t) => {
  const sessionsDeferred = createDeferred<Response>();
  const sse = createSseControl();
  const recoveredSnap = makeSnapshot({
    version: 5,
    runtimes: { runtimes: [], errors: [] },
  });
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-slow-sess", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/sessions") {
        return sessionsDeferred.promise;
      }
      if (url === "/api/snapshot") {
        return jsonResponse(recoveredSnap);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({ client, store, clock, toast, t: (k) => k });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  const refreshPromise = appData.refreshSessions();

  // Recovery SSE snapshot arrives BEFORE the slow HTTP /api/sessions response finishes.
  sse.sendFrame("snapshot", recoveredSnap, "5");
  await flushAsync();

  const staleHttpBody: SessionsListResponse = {
    account_context: { revision: 3, active: "acct-1" },
    sampled_at: 1_700_000_010,
    runtimes: [],
    errors: [
      {
        account: "acct-a",
        error: {
          kind: "timeout",
          message_key: "err.timeout",
          args: {},
          hint_key: null,
          action_key: null,
          operation_id: null,
        },
      },
    ],
    guard: null,
    guard_events: [],
    guard_error: null,
    ended: [],
  };
  sessionsDeferred.resolve(jsonResponse(staleHttpBody));
  await refreshPromise;

  // Authoritative snapshot already recovered -> stale HTTP error must not be written back.
  assert.equal(appData.getState().sessionsAccountErrors, null);
});

test("appDataStore discards stale in-flight GET /api/settings after Settings saves new defaults", async (t) => {
  const staleSettings = createDeferred<Response>();
  const sse = createSseControl();
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-settings", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/settings") {
        return staleSettings.promise;
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({ client, store, clock, toast, t: (k) => k });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  const inFlight = appData.refreshSessionDefaults();

  // User navigates to Settings and saves max_runtime = 7200s while Sessions' older fetch is still in flight.
  appData.applySessionDefaults({ max_runtime: 7200, max_concurrent_sessions: 3 });
  assert.equal(appData.getState().rearmDurationSecs, 7200);
  assert.equal(appData.getState().maxConcurrentSessions, 3);

  // Older GET /api/settings returns stale 3600s -> must be discarded.
  const stalePayload: SettingsView = {
    language: "system",
    appearance: "system",
    defaults: { max_runtime: 3600, max_concurrent_sessions: 1 },
    config_dir: null,
    load_status: "loaded",
    corrupt_backup: null,
    reset_defaults: [],
  };
  staleSettings.resolve(jsonResponse(stalePayload));
  const resolved = await inFlight;
  assert.equal(resolved.rearmDurationSecs, 7200);
  assert.equal(appData.getState().rearmDurationSecs, 7200);
  assert.equal(appData.getState().maxConcurrentSessions, 3);
});

test("routerStore supports SettingsFocus pinning, canonicalization, and clearing on navigation", () => {
  assert.deepEqual(parseHashRoute("#/settings"), { route: "settings", canonical: true });
  assert.deepEqual(parseHashRoute("#/settings?focus=host"), { route: "settings", canonical: true });
  assert.deepEqual(parseHashRoute("#/settings?focus=limit"), { route: "settings", canonical: true });
  assert.deepEqual(parseHashRoute("#/settings?focus=unknown"), { route: "settings", canonical: false });
  assert.deepEqual(parseHashRoute("#/overview?focus=host"), { route: "overview", canonical: false });
  assert.equal(parseSettingsFocus("#/settings?focus=host"), "host");
  assert.equal(parseSettingsFocus("#/settings?focus=limit"), "limit");
  assert.equal(parseSettingsFocus("#/settings?focus=unknown"), null);
  assert.equal(parseSettingsFocus("#/overview?focus=host"), null);
  assert.equal(routeToHash("settings", "limit"), "#/settings?focus=limit");
  assert.equal(routeToHash("settings", "host"), "#/settings?focus=host");
  assert.equal(routeToHash("overview", "host"), "#/overview");

  const hashListeners = new Set<() => void>();
  const fakeWin = {
    location: {
      pathname: "/",
      search: "",
      hash: "#/overview",
    },
    history: {
      replaceState(_state: unknown, _unused: string, url?: string | URL | null) {
        if (typeof url === "string") {
          const idx = url.indexOf("#");
          fakeWin.location.hash = idx >= 0 ? url.slice(idx) : "";
        }
      },
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "hashchange" && typeof listener === "function") {
        hashListeners.add(listener as () => void);
      }
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type === "hashchange" && typeof listener === "function") {
        hashListeners.delete(listener as () => void);
      }
    },
  };

  const router = createRouterStore({ win: fakeWin as unknown as Window });
  assert.equal(router.getRoute(), "overview");
  assert.equal(router.getSettingsFocus(), null);

  router.navigate("settings", { settingsFocus: "limit" });
  assert.equal(router.getRoute(), "settings");
  assert.equal(router.getSettingsFocus(), "limit");
  assert.equal(fakeWin.location.hash, "#/settings?focus=limit");

  router.navigate("settings", { settingsFocus: "host" });
  assert.equal(router.getSettingsFocus(), "host");
  assert.equal(fakeWin.location.hash, "#/settings?focus=host");

  // Plain Settings navigation clears focus.
  router.navigate("settings");
  assert.equal(router.getRoute(), "settings");
  assert.equal(router.getSettingsFocus(), null);
  assert.equal(fakeWin.location.hash, "#/settings");

  // Hashchange into invalid focus normalizes cleanly.
  fakeWin.location.hash = "#/settings?focus=bogus";
  for (const fn of hashListeners) {
    fn();
  }
  assert.equal(router.getRoute(), "settings");
  assert.equal(router.getSettingsFocus(), null);
  assert.equal(fakeWin.location.hash, "#/settings");

  router.navigate("settings", { settingsFocus: "limit" });
  router.navigate("sessions");
  assert.equal(router.getRoute(), "sessions");
  assert.equal(router.getSettingsFocus(), null);
  assert.equal(fakeWin.location.hash, "#/sessions");
  router.dispose();
});

test("preferenceSync surfaces language/appearance save failures and clears after retry succeeds", async (t) => {
  let failPatch = true;
  const patchBodies: unknown[] = [];
  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-pref", expires_in: 3600 });
      }
      if (url === "/api/settings" && method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body ?? "{}")));
        if (failPatch) {
          return jsonResponse(
            {
              error: {
                kind: "io",
                message_key: "app.err.io",
                args: {},
                hint_key: null,
                action_key: null,
                operation_id: null,
              },
            },
            500,
          );
        }
        return jsonResponse({
          language: "zh-CN",
          appearance: "dark",
          defaults: { ...CORE_DEFAULTS },
          check_updates: true,
          wsl_distro: null,
          colab_path: null,
          colab_python: null,
          uses_wsl: false,
          config_dir: "/tmp/cfg",
          settings_file: "/tmp/cfg/settings.json",
          load_status: "loaded",
          corrupt_backup: null,
          reset_defaults: [],
          settings_notice: null,
        } satisfies SettingsView);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  });

  const i18n = createI18nStore({
    storage: null,
    fetchImpl: async () => jsonResponse({}),
  });
  const theme = createThemeStore({ storage: null, doc: null });
  const sync = createPreferenceSync(client, i18n, theme);
  t.after(() => {
    sync.cancelPending();
    i18n.dispose();
    theme.dispose();
  });

  await client.login("secret-key");
  sync.setLanguage("zh-CN");
  await flushAsync(6);

  assert.equal(patchBodies.length, 1);
  assert.deepEqual(patchBodies[0], { language: "zh-CN" });
  const failedState = sync.getState();
  assert.ok(failedState.lastError !== null);
  assert.deepEqual(failedState.lastError.fields, ["language"]);
  assert.equal(failedState.lastError.error instanceof ApiError, true);
  assert.equal((failedState.lastError.error as ApiError).messageKey, "app.err.io");

  // Changing appearance while language save failed bundles the unresolved language field too.
  sync.setAppearance("dark");
  await flushAsync(6);
  assert.equal(patchBodies.length, 2);
  assert.deepEqual(patchBodies[1], { language: "zh-CN", appearance: "dark" });
  assert.deepEqual(sync.getState().lastError?.fields, ["language", "appearance"]);

  // Retry succeeds for both fields and clears lastError.
  failPatch = false;
  sync.retryLastFailed();
  await flushAsync(6);
  assert.equal(patchBodies.length, 3);
  assert.deepEqual(patchBodies[2], { language: "zh-CN", appearance: "dark" });
  assert.equal(sync.getState().lastError, null);
});

test("updatesStore checkNow preserves current_version on offline failure, supersedes slower GET, and survives check_updates toggle", async (t) => {
  const slowGet = createDeferred<Response>();
  const manualDeferred = createDeferred<Response>();
  let manualCalls = 0;
  let failManualTransport = false;
  const baseNotice: UpdateNoticeResponse = {
    current_version: "0.5.0",
    update_available: false,
    releases_url: "https://github.com/321sssrt-bit/colab-playground/releases",
    release_url: null,
    latest_version: null,
    status: "failed",
    checked_at: null,
    check_updates: true,
    error: {
      kind: "http",
      message_key: "app.err.http",
      args: {},
      hint_key: "app.ns.check_network",
      action_key: null,
      operation_id: null,
    },
    persist_error: null,
  };

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-upd", expires_in: 3600 });
      }
      if (url === "/api/updates" && method === "GET") {
        return slowGet.promise;
      }
      if (url === "/api/updates/check" && method === "POST") {
        manualCalls += 1;
        if (failManualTransport) {
          throw new TypeError("network down");
        }
        if (manualCalls === 2) {
          return manualDeferred.promise;
        }
        return jsonResponse(baseNotice);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  });

  const updates = createUpdatesStore({
    client,
    storage: null,
    pollIntervalMs: 0,
  });
  t.after(() => {
    updates.dispose();
  });

  await client.login("secret-key");
  const autoPromise = updates.ensureChecked();
  const manualResult = await updates.checkNow();
  assert.equal(manualResult.current_version, "0.5.0");
  assert.equal(manualResult.status, "failed");
  assert.equal(updates.getState().notice?.current_version, "0.5.0");

  // Slower GET returning idle must NOT overwrite the newer manual POST result.
  slowGet.resolve(
    jsonResponse({
      ...baseNotice,
      status: "idle",
      error: null,
    } satisfies UpdateNoticeResponse),
  );
  await autoPromise;
  assert.equal(updates.getState().notice?.status, "failed");

  // Toggling auto-check while a manual check is in flight keeps both the toggle and the found release.
  const secondManual = updates.checkNow();
  updates.setCheckUpdates(false);
  assert.equal(updates.getState().notice?.check_updates, false);
  manualDeferred.resolve(
    jsonResponse({
      ...baseNotice,
      update_available: true,
      latest_version: "0.6.0",
      release_url: "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.6.0",
      status: "available",
      check_updates: true,
      error: null,
    } satisfies UpdateNoticeResponse),
  );
  await secondManual;
  assert.equal(updates.getState().notice?.status, "available");
  assert.equal(updates.getState().notice?.latest_version, "0.6.0");
  assert.equal(updates.getState().notice?.check_updates, false);

  // Even a transport error on manual check keeps the last known current_version intact.
  failManualTransport = true;
  await assert.rejects(() => updates.checkNow());
  assert.equal(updates.getState().notice?.current_version, "0.5.0");
  assert.ok(updates.getState().manualError !== null);
});

test("settingsDraftStore persists unsaved drafts across route changes, reconciles partial saves, and clears on sign-out", async (t) => {
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-draft", expires_in: 3600 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const drafts = createSettingsDraftStore(client);
  t.after(() => {
    drafts.dispose();
  });

  await client.login("secret-key");
  const initial = drafts.resolveDefaultsDraft(CORE_DEFAULTS);
  drafts.saveDefaultsDraft(
    CORE_DEFAULTS,
    { ...initial.draft, max_attempts: "5", max_concurrent_sessions: "4" },
    initial.forceInclude,
  );
  drafts.saveHostDraft(null, null, "/usr/local/bin/colab", "/usr/bin/python3");

  // Re-entering Settings with identical server values restores unsaved drafts.
  const restoredDefaults = drafts.resolveDefaultsDraft({ ...CORE_DEFAULTS });
  assert.equal(restoredDefaults.draft.max_attempts, "5");
  assert.equal(restoredDefaults.draft.max_concurrent_sessions, "4");
  const restoredHost = drafts.resolveHostDraft(null, null);
  assert.equal(restoredHost.colabPath, "/usr/local/bin/colab");
  assert.equal(restoredHost.colabPython, "/usr/bin/python3");

  // Reconciling a Defaults save for max_attempts keeps an in-flight max_concurrent_sessions edit.
  const serverAfterAttempts = { ...CORE_DEFAULTS, max_attempts: 5 };
  drafts.reconcileSavedDefaults(serverAfterAttempts, { max_attempts: 5 });
  const afterPartialDefaults = drafts.resolveDefaultsDraft(serverAfterAttempts);
  assert.equal(afterPartialDefaults.draft.max_attempts, "5");
  assert.equal(afterPartialDefaults.draft.max_concurrent_sessions, "4");

  // Saving concurrent limit from LimitFocusCard updates limit while keeping other unsaved Defaults fields.
  const withAnotherDraft = { ...afterPartialDefaults.draft, max_attempts: "7" };
  drafts.saveDefaultsDraft(serverAfterAttempts, withAnotherDraft, afterPartialDefaults.forceInclude);
  const serverAfterLimit = { ...serverAfterAttempts, max_concurrent_sessions: 4 };
  drafts.reconcileSavedConcurrentLimit(serverAfterLimit);
  const afterMerge = drafts.resolveDefaultsDraft(serverAfterLimit);
  assert.equal(afterMerge.draft.max_concurrent_sessions, "4");
  assert.equal(afterMerge.draft.max_attempts, "7");

  // Navigating away before a LimitFocusCard response returns (so reconcile did not run) still
  // preserves unsaved edits on other fields via three-way merge when returning with updated server state.
  const withUnsavedAttemptsAndLimit = {
    ...afterMerge.draft,
    max_attempts: "9",
    max_concurrent_sessions: "6",
  };
  drafts.saveDefaultsDraft(
    serverAfterLimit,
    withUnsavedAttemptsAndLimit,
    afterMerge.forceInclude,
  );
  const serverAfterOffPageLimitSave = { ...serverAfterLimit, max_concurrent_sessions: 6 };
  const afterReturn = drafts.resolveDefaultsDraft(serverAfterOffPageLimitSave);
  assert.equal(afterReturn.draft.max_concurrent_sessions, "6");
  assert.equal(afterReturn.draft.max_attempts, "9");

  // Sign-out wipes all unsaved drafts immediately.
  client.logout();
  const afterLogout = drafts.resolveDefaultsDraft(CORE_DEFAULTS);
  assert.equal(afterLogout.draft.max_attempts, String(CORE_DEFAULTS.max_attempts));
  assert.deepEqual(drafts.resolveHostDraft(null, null), { colabPath: "", colabPython: "" });
});

test("settingsNoticeStore displays once globally, survives background null updates until dismissed, and suppresses stale re-observations", async (t) => {
  let dismissCalls = 0;
  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-notice", expires_in: 3600 });
      }
      if (url === "/api/settings/notice/dismiss" && method === "POST") {
        dismissCalls += 1;
        return jsonResponse({ notice: null });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  });
  const notices = createSettingsNoticeStore(client);
  t.after(() => {
    notices.dispose();
  });

  await client.login("secret-key");
  const corruptNotice = {
    corrupt: true,
    corrupt_backup: "/tmp/cfg/settings.json.corrupt",
    reset_defaults: [],
  };

  notices.observe(corruptNotice);
  assert.equal(notices.getState().showCorrupt, true);
  assert.equal(notices.getState().showReset, false);

  // Automatic login-sync PATCH clearing server settings_notice must not hide the banner before user dismiss.
  notices.observe(null);
  assert.equal(notices.getState().showCorrupt, true);

  await notices.dismissPart("corrupt");
  assert.equal(dismissCalls, 1);
  assert.equal(notices.getState().notice, null);

  // Stale GET /api/settings re-observing the same notice does not re-open it.
  notices.observe(corruptNotice);
  assert.equal(notices.getState().notice, null);

  // A distinct reset_defaults notice displays until dismissed.
  notices.observe({
    corrupt: false,
    corrupt_backup: null,
    reset_defaults: ["max_runtime"],
  });
  assert.equal(notices.getState().showReset, true);
  await notices.dismissPart("reset");
  assert.equal(dismissCalls, 2);
  assert.equal(notices.getState().notice, null);
});

test("deriveChecklist follows upstream 3-step flow and routes NotInstalled and re-probe failures accurately", () => {
  const err = { message: "err", hint: null };
  assert.deepEqual(
    deriveChecklist(null, err, false, { probeErrorKind: "not_installed" }),
    {
      complete: false,
      hostStatus: "done",
      cliStatus: "todo",
      signinStatus: "waiting",
    },
  );
  assert.deepEqual(deriveChecklist(null, err, false, { probeErrorKind: "io" }), {
    complete: false,
    hostStatus: "failed",
    cliStatus: "waiting",
    signinStatus: "waiting",
  });

  // Re-probe failure with cached overview must still mark host failed and wait CLI.
  const staleNotReadyHost = makeOverview({
    host: { kind: "shell_tools", ready: false, hint_key: null },
    cli_installed: false,
  });
  assert.deepEqual(
    deriveChecklist(staleNotReadyHost, err, false, { probeErrorKind: "io" }),
    {
      complete: false,
      hostStatus: "failed",
      cliStatus: "waiting",
      signinStatus: "waiting",
    },
  );
  // New NotInstalled error overrides a stale host.ready=false cached report so Install is shown.
  assert.deepEqual(
    deriveChecklist(staleNotReadyHost, err, false, { probeErrorKind: "not_installed" }),
    {
      complete: false,
      hostStatus: "done",
      cliStatus: "todo",
      signinStatus: "waiting",
    },
  );

  const keyringFailed = makeOverview({
    accounts: null,
    accounts_error: "keyring_unavailable",
    keyring: { status: "unavailable", hint_key: "app.ns.unlock_keyring" },
  });
  assert.deepEqual(deriveChecklist(keyringFailed, null, false), {
    complete: false,
    hostStatus: "done",
    cliStatus: "done",
    signinStatus: "failed",
  });

  const signedOut = makeOverview({
    accounts: {
      accounts: [],
      active: null,
      has_token: false,
      unadopted: false,
      active_email: null,
      recovered_pending_add: false,
    },
  });
  assert.deepEqual(deriveChecklist(signedOut, null, false), {
    complete: false,
    hostStatus: "done",
    cliStatus: "done",
    signinStatus: "todo",
  });

  assert.deepEqual(deriveChecklist(makeOverview(), null, false), {
    complete: true,
    hostStatus: "done",
    cliStatus: "done",
    signinStatus: "done",
  });
});

test("cliInstallStore survives route-switch remount, recheck cycle with identical line_count, and >5000-line replay", async (t) => {
  const installSse = createSseControl();
  const replaySse = createSseControl();
  const eventsSse = createSseControl();
  const calls: string[] = [];
  let overviewRefreshes = 0;

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-install", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return eventsSse.response;
      }
      if (url === "/api/overview/cli/install" && method === "POST") {
        return installSse.response;
      }
      if (url === "/api/overview/cli/install/7/events" && method === "POST") {
        return replaySse.response;
      }
      if (url === "/api/overview/cli/install" && method === "GET") {
        return jsonResponse({
          id: 7,
          method: "uv",
          phase: "not_found",
          cli_installed: false,
          cancelling: false,
          lines: [{ stream: "stdout", text: "\u001B[32minstalled to ~/.local/bin\u001B[0m" }],
          warning_title_key: "app.install.not_found.title",
          warning_body_key: "app.install.not_found.body",
          error: null,
        });
      }
      if (url === "/api/snapshot") {
        return jsonResponse(makeSnapshot({ version: 99 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    },
  });

  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const installStore = createCliInstallStore({
    client,
    store,
    appData: {
      refreshOverview: async () => {
        overviewRefreshes += 1;
        return makeOverview();
      },
    },
  });
  t.after(() => {
    installStore.dispose();
    store.dispose();
    installSse.close();
    replaySse.close();
    eventsSse.close();
    clock.dispose();
  });

  await store.signIn("secret-key");

  // Deliver an initial pre-install snapshot at version 1 with idle cli_install.
  eventsSse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 1,
      cli_install: {
        id: null,
        method: null,
        phase: "idle",
        cancelling: false,
        line_count: 0,
        error_kind: null,
      },
    }),
    "1",
  );
  await flushAsync();

  // Initial overview hydrate before install starts.
  const cachedIdleView = {
    id: null,
    method: null,
    phase: "idle" as const,
    cli_installed: false,
    cancelling: false,
    lines: [],
    warning_title_key: null,
    warning_body_key: null,
    error: null,
  };
  installStore.hydrateFromOverview(cachedIdleView);

  // Start install -> ANSI codes stripped -> remounting Overview runs both syncWithServer() (still
  // observing pre-install version 1 idle snapshot) and hydrateFromOverview(cachedIdleView); neither
  // may abort the active install stream or wipe buffered logs.
  const startPromise = installStore.startInstall("uv");
  installSse.sendFrame("started", { id: 7, method: "uv" });
  installSse.sendFrame("line", { stream: "stdout", text: "\u001B[32minstalled to ~/.local/bin\u001B[0m" });
  await flushAsync();
  installStore.syncWithServer();
  installStore.hydrateFromOverview(cachedIdleView);
  installStore.hydrateFromOverview({ ...cachedIdleView });
  assert.equal(installStore.getState().id, 7);
  assert.equal(installStore.getState().phase, "running");
  assert.deepEqual(installStore.getState().lines, [
    { stream: "stdout", text: "installed to ~/.local/bin" },
  ]);

  // Backend moves into post-install probe -> UI shows checking immediately.
  eventsSse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 2,
      cli_install: {
        id: 7,
        method: "uv",
        phase: "checking",
        cancelling: false,
        line_count: 1,
        error_kind: null,
      },
    }),
    "2",
  );
  await flushAsync();
  assert.equal(installStore.getState().phase, "checking");

  // SSE finished frame carries legacy `status: "failed"` + `error`, but `phase: "not_found"` must win.
  installSse.sendFrame("finished", {
    status: "failed",
    phase: "not_found",
    cli_installed: false,
    warning_title_key: "app.install.not_found.title",
    warning_body_key: "app.install.not_found.body",
    error: {
      kind: "not_installed",
      message_key: "app.install.not_found.title",
      args: {},
      hint_key: "app.install.not_found.body",
      action_key: null,
      operation_id: null,
    },
  });
  installSse.close();
  await startPromise;

  assert.equal(installStore.getState().phase, "not_found");
  assert.equal(installStore.getState().error, null);
  assert.equal(installStore.getState().warningTitleKey, "app.install.not_found.title");
  assert.equal(installStore.getState().warningBodyKey, "app.install.not_found.body");
  assert.equal(overviewRefreshes, 0);

  // Recheck cycle: clicking Check again transitions not_found -> checking -> not_found with identical line_count=1.
  eventsSse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 3,
      cli_install: {
        id: 7,
        method: "uv",
        phase: "checking",
        cancelling: false,
        line_count: 1,
        error_kind: null,
      },
    }),
    "3",
  );
  await flushAsync();
  assert.equal(installStore.getState().phase, "checking");

  eventsSse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 4,
      cli_install: {
        id: 7,
        method: "uv",
        phase: "not_found",
        cancelling: false,
        line_count: 1,
        error_kind: null,
      },
    }),
    "4",
  );
  await flushAsync();
  assert.equal(installStore.getState().phase, "not_found");
  assert.equal(installStore.getState().lines.length, 1);

  // Changing host settings clears cli_install back to idle on backend -> store resets cleanly.
  eventsSse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 5,
      cli_install: {
        id: null,
        method: null,
        phase: "idle",
        cancelling: false,
        line_count: 0,
        error_kind: null,
      },
    }),
    "5",
  );
  await flushAsync();
  assert.equal(installStore.getState().phase, "idle");
  assert.equal(installStore.getState().lines.length, 0);

  // Hydrate an already-running session with >5000 lines, then replay stream without losing or duplicating lines.
  const manyLines = Array.from({ length: 5002 }, (_, i) => ({
    stream: "stdout" as const,
    text: `line-${i}`,
  }));
  installStore.hydrateFromOverview({
    id: 7,
    method: "uv",
    phase: "running",
    cli_installed: false,
    cancelling: false,
    lines: manyLines,
    warning_title_key: null,
    warning_body_key: null,
    error: null,
  });
  await flushAsync();
  assert.ok(calls.includes("POST /api/overview/cli/install/7/events"));
  assert.equal(installStore.getState().lines.length, 5000);
  assert.equal(installStore.getState().lines[0]?.text, "line-2");

  replaySse.sendFrame("started", { id: 7, method: "uv" });
  for (let i = 0; i < 5002; i += 1) {
    replaySse.sendFrame("line", { stream: "stdout", text: `line-${i}` });
  }
  replaySse.sendFrame("line", { stream: "stderr", text: "\u001B[31mline-5002\u001B[0m" });
  replaySse.sendFrame("finished", {
    status: "succeeded",
    phase: "succeeded",
    cli_installed: true,
    warning_title_key: null,
    warning_body_key: null,
    error: null,
  });
  replaySse.close();
  await flushAsync();

  assert.equal(installStore.getState().lines.length, 5000);
  assert.equal(installStore.getState().lines[0]?.text, "line-3");
  assert.deepEqual(installStore.getState().lines.at(-1), {
    stream: "stderr",
    text: "line-5002",
  });
  assert.equal(installStore.getState().phase, "succeeded");
  assert.equal(overviewRefreshes, 1);
});

test("buildOverviewUnmanagedWarning ignores first-run env errors, preserves count warnings, and selectQuickDeployPlugins keeps bundled only", () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;

  // First-run keyring_unavailable sets runtimes_error too -> must NOT emit false billing warning.
  const lockedKeyringSnap = makeSnapshot({
    accounts: null,
    accounts_error: "keyring_unavailable",
    runtimes: null,
    runtimes_error: "keyring_unavailable",
    usage: [],
  });
  assert.equal(
    buildOverviewUnmanagedWarning(
      null,
      lockedKeyringSnap,
      { count: null, incomplete: false, unverified_accounts: [], warning_key: null },
      1_700_000_000,
      t,
    ),
    null,
  );

  // Known overview unmanaged count is NOT downgraded to generic unknown when snapshot has runtimes_error and no accounts.
  const ioErrorSnap = makeSnapshot({
    accounts: null,
    accounts_error: null,
    runtimes: null,
    runtimes_error: "io",
    usage: [],
  });
  const preservedCount = buildOverviewUnmanagedWarning(
    null,
    ioErrorSnap,
    {
      count: 1,
      incomplete: false,
      unverified_accounts: [],
      warning_key: "app.b2.quit_unwatched_one",
    },
    1_700_000_000,
    t,
  );
  assert.deepEqual(preservedCount, {
    title: "app.unmanaged.title",
    body: 'app.b2.quit_unwatched_one:{"count":1}\nweb.runtimes.unmanaged_unknown',
  });

  const signedOutAccounts = {
    accounts: [],
    active: null,
    has_token: false,
    unadopted: false,
    active_email: null,
    recovered_pending_add: false,
  };

  // Checklist state with runtimes_error + overview warning_key surfaces unknown ownership warning.
  const runtimesFailSnap = makeSnapshot({
    accounts: signedOutAccounts,
    runtimes: null,
    runtimes_error: "io",
    usage: [],
  });
  const failWarning = buildOverviewUnmanagedWarning(
    signedOutAccounts,
    runtimesFailSnap,
    {
      count: null,
      incomplete: true,
      unverified_accounts: [],
      warning_key: "web.runtimes.unmanaged_unknown",
    },
    1_700_000_000,
    t,
  );
  assert.deepEqual(failWarning, {
    title: "app.unmanaged.unknown_title",
    body: "web.runtimes.unmanaged_unknown",
  });

  // Checklist state with unmanaged runtime in live snapshot (and empty usage) still warns.
  const unmanagedSnap = makeSnapshot({
    accounts: signedOutAccounts,
    runtimes: {
      runtimes: [makeRuntime({ managed: false, account_email: "alice@example.com" })],
      errors: [],
    },
    runtimes_error: null,
    usage: [],
  });
  const liveWarning = buildOverviewUnmanagedWarning(
    signedOutAccounts,
    unmanagedSnap,
    null,
    1_700_000_000,
    t,
  );
  assert.deepEqual(liveWarning, {
    title: "app.unmanaged.title",
    body: 'app.unmanaged.one:{"email":"alice@example.com"}',
  });

  // Quick-deploy filters strictly to enabled bundled plugins.
  const makePlugin = (id: string, source: PluginInfo["source"], enabled: boolean): PluginInfo => ({
    manifest: {
      api: 1,
      id,
      version: "0.1.0",
      name: { "en-US": id },
      description: {},
      inputs: [],
      run: { script: "run.sh" },
      stages: [],
      endpoints: [],
      needs: [],
    },
    source,
    enabled,
  });
  const filtered = selectQuickDeployPlugins([
    makePlugin("llama-cpp", { kind: "bundled" }, true),
    makePlugin("bundled-off", { kind: "bundled" }, false),
    makePlugin("third-party", { kind: "user" }, true),
  ]);
  assert.deepEqual(
    filtered.map((item) => item.manifest.id),
    ["llama-cpp"],
  );
});

test("appDataStore captures usesWsl from settings and clears cached overview when rebuild_backend finishes", async (t) => {
  const sse = createSseControl();
  let overviewCalls = 0;
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-rebuild", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/overview") {
        overviewCalls += 1;
        return jsonResponse(
          makeOverview({
            host: { kind: "wsl", ready: true, hint_key: null, wsl_distro: "Debian" },
          }),
        );
      }
      if (url === "/api/settings") {
        return jsonResponse({
          language: "system",
          appearance: "system",
          defaults: { ...CORE_DEFAULTS },
          uses_wsl: true,
          config_dir: null,
          load_status: "loaded",
          corrupt_backup: null,
          reset_defaults: [],
        } satisfies SettingsView);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
  const clock = createServerClock({
    setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearIntervalFn: () => {},
  });
  const store = createWebStore({ client, clock, ...noopTimers });
  const toast = createToastStore(noopTimers);
  const appData = createAppDataStore({ client, store, clock, toast, t: (k) => k });
  t.after(() => {
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  assert.equal(appData.getState().usesWslResolved, false);
  await appData.refreshSessionDefaults();
  assert.equal(appData.getState().usesWsl, true);
  assert.equal(appData.getState().usesWslResolved, true);

  await appData.ensureOverview();
  assert.equal(overviewCalls, 1);
  assert.equal(appData.getState().overview?.host.wsl_distro, "Debian");

  // Simulate cross-tab host change: rebuild_backend starts then completes.
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 2,
      operations: [{ id: 12, operation: { kind: "domain", name: "rebuild_backend", key: "" }, cancelling: false }],
    }),
    "2",
  );
  await flushAsync();
  assert.ok(appData.getState().overview !== null);

  sse.sendFrame("snapshot", makeSnapshot({ version: 3, operations: [] }), "3");
  await flushAsync();
  assert.equal(appData.getState().overview, null);
  assert.equal(appData.getState().usesWsl, true);
  assert.equal(appData.getState().usesWslResolved, true);

  await appData.ensureOverview();
  assert.equal(overviewCalls, 2);
});
