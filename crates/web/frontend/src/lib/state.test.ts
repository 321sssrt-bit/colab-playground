import assert from "node:assert/strict";
import test, { after } from "node:test";

import { ApiError, createApiClient } from "./api.ts";
import {
  createAppDataStore,
  isAccountChangeBlocked,
  resolveEffectiveOverview,
} from "./appCache.ts";
import { createServerClock } from "./clock.ts";
import { evaluateUsageSampleFreshness, USAGE_STALE_AFTER_SECS } from "./format.ts";
import { createForwardsStore } from "./forwards.ts";
import { i18nStore } from "./i18n.ts";
import { createWebStore } from "./store.ts";
import { createToastStore } from "./toast.ts";

// Stop the module-level i18n singleton's cold-start retry loop in headless Node test runs.
after(() => {
  i18nStore.dispose();
});
import type {
  Account,
  AccountsApiResponse,
  ForwardView,
  OverviewResponse,
  PendingOperation,
  Runtime,
  SessionsListResponse,
  Snapshot,
  TunnelInfo,
  UsageSnapshot,
} from "./types.ts";

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
