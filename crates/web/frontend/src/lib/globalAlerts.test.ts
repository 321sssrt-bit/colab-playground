import assert from "node:assert/strict";
import test, { after } from "node:test";

import { createApiClient } from "./api.ts";
import { createAppDataStore } from "./appCache.ts";
import { createServerClock } from "./clock.ts";
import {
  createGuardStore,
  guardStore,
  isKeyringLockedOrAccountsMissing,
} from "./guard.ts";
import { i18nStore, type I18nState, type I18nParams } from "./i18n.ts";
import {
  countStopAllProtection,
  createStopDialogsStore,
  isRuntimeWatchdogProtected,
  isStopAllRuntimesLoading,
  stopDialogsStore,
} from "./stopDialogs.ts";
import { createWebStore } from "./store.ts";
import { createToastStore } from "./toast.ts";
import type {
  GuardEvent,
  Runtime,
  Snapshot,
  StopAllResponse,
  UpdateNoticeResponse,
} from "./types.ts";
import {
  createUpdatesStore,
  isSafeHttpsUrl,
  UPDATE_DISMISSED_STORAGE_KEY,
  updatesStore,
} from "./updates.ts";

after(() => {
  guardStore.dispose();
  updatesStore.dispose();
  stopDialogsStore.dispose();
  i18nStore.dispose();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
        // Stream may already be closed by dispose().
      }
    },
  };
}

function createFakeI18n() {
  const listeners = new Set<() => void>();
  const state: I18nState = {
    preference: "en-US",
    browserLocale: "en-US",
    locale: "en-US",
    dict: { "app.name": "Colab Playground" },
    loading: false,
    loadFailed: false,
  };
  const t = (key: string, params?: I18nParams): string => {
    if (!params || Object.keys(params).length === 0) {
      return key;
    }
    const entries = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${key}[${entries}]`;
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    t,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    server_now: 1_700_000_000,
    backend: "mock",
    account: { revision: 1, active: "acct-1" },
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

function makeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: { account: "acct-1", endpoint: "ep-1", name: "a100-1" },
    account_email: "alice@example.com",
    on_active_account: true,
    accelerator: "A100",
    hardware: "NVIDIA A100",
    high_mem: false,
    managed: true,
    tracked: {
      name: "a100-1",
      account: "acct-1",
      endpoint: "ep-1",
      accelerator: "A100",
      high_mem: false,
      gpu: "NVIDIA A100",
      vram_mib: 40_960,
      policy: {
        max_runtime: 7200,
        max_spend_cu: 10,
        min_balance_cu: null,
        idle_timeout: null,
      },
      spend: {
        started_at: 1_700_000_000,
        spend_cu: 1.5,
        rate_known: true,
        estimated: false,
        integrated_to: 1_700_000_000,
        last_share_cu_per_hour: 5.3,
        last_observed: 1_700_000_000,
      },
      watchdog: {
        deadline: 1_700_007_200,
        idle_timeout: null,
        cancelled: false,
        armed: true,
      },
      stopped: null,
      measured_rate: null,
    },
    estimated_rate_cu_per_hour: 5.3,
    estimated_spend_cu: 1.5,
    auto_stop_at: 1_700_007_200,
    tunnels: [],
    ...overrides,
  };
}

async function flushAsync(turns = 5): Promise<void> {
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

test("toastStore keeps persistent alerts alive and evicts transient toasts first", () => {
  const callbacks: Array<() => void> = [];
  let dismissedCount = 0;
  const store = createToastStore({
    maxItems: 3,
    setTimer: (cb) => {
      callbacks.push(cb);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });

  const persistentId = store.push({
    tone: "danger",
    title: "still billing",
    body: "guard stop failed",
    durationMs: null,
    onDismiss: () => {
      dismissedCount += 1;
    },
  });
  store.push({ tone: "info", body: "transient-1" });
  store.push({ tone: "info", body: "transient-2" });
  store.push({ tone: "info", body: "transient-3" });

  // Transient-1 was evicted instead of the persistent danger alert.
  const bodies = store.getToasts().map((item) => item.body);
  assert.deepEqual(bodies, ["guard stop failed", "transient-2", "transient-3"]);
  assert.equal(store.getToasts()[0]?.durationMs, null);

  // Silent dismiss and clear do not invoke user onDismiss callback.
  const silentId = store.push({
    tone: "warning",
    body: "warn",
    durationMs: null,
    onDismiss: () => {
      dismissedCount += 100;
    },
  });
  store.dismiss(silentId, { notify: false });
  assert.equal(dismissedCount, 0);

  // Explicit user dismiss invokes onDismiss exactly once.
  store.dismiss(persistentId);
  assert.equal(dismissedCount, 1);

  store.dispose();
});

test("guardStore consumes Warn, Stopped, StopFailed persistently across pages and acks on dismiss", async (t) => {
  const sse = createSseControl();
  const ackPayloads: unknown[] = [];

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-guard", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/sessions/guard/ack") {
        ackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(null, { status: 204 });
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
  const i18n = createFakeI18n();
  const guard = createGuardStore({ client, store, toast, i18n });

  t.after(() => {
    guard.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");

  const events: GuardEvent[] = [
    {
      id: 10,
      at: 1_700_000_010,
      session: { account: "acct-1", endpoint: "ep-1", name: "a100-1" },
      label: "a100-1",
      email: "alice@example.com",
      kind: "warn",
      concerns: [
        { kind: "limit", limit: "spend", current: 8.5, threshold: 10, estimated: true },
      ],
    },
    {
      id: 11,
      at: 1_700_000_011,
      session: { account: "acct-1", endpoint: "ep-2", name: "t4-1" },
      label: "t4-1",
      email: "alice@example.com",
      kind: "stop_failed",
      concern: { kind: "limit", limit: "runtime", current: 7200, threshold: 7200, estimated: false },
      error: { kind: "connection_lost", params: {}, detail: "drop", next_step: "try_again" },
    },
    {
      id: 12,
      at: 1_700_000_012,
      session: { account: "acct-1", endpoint: "ep-3", name: "l4-1" },
      label: "l4-1",
      email: "alice@example.com",
      kind: "stopped",
      concern: { kind: "limit", limit: "balance", current: 4.5, threshold: 5, estimated: false },
    },
    {
      id: 13,
      at: 1_700_000_013,
      session: { account: "acct-1", endpoint: "ep-4", name: "cpu-1" },
      label: "cpu-1",
      email: "alice@example.com",
      kind: "warn",
      concerns: [{ kind: "usage_unknown", limit: "spend" }],
    },
  ];

  sse.sendFrame("snapshot", makeSnapshot({ version: 2, guard_events: events }), "2");
  await flushAsync();

  // Event 13 (usage_unknown only) did not toast and was auto-acked; 10, 11, 12 became persistent toasts.
  assert.deepEqual(ackPayloads, [{ ids: [13] }]);
  const toasts = toast.getToasts();
  assert.equal(toasts.length, 3);
  assert.equal(toasts[0]?.tone, "warning");
  assert.equal(toasts[0]?.durationMs, null);
  assert.equal(toasts[0]?.title, "app.b2.guard_warn_title[name=a100-1]");
  assert.equal(toasts[1]?.tone, "danger");
  assert.equal(toasts[1]?.durationMs, null);
  assert.equal(toasts[1]?.title, "app.b2.guard_stop_failed_title[name=t4-1]");
  assert.equal(toasts[1]?.body, "app.err.connection_lost");
  assert.equal(toasts[2]?.tone, "danger");
  assert.equal(toasts[2]?.durationMs, null);
  assert.equal(toasts[2]?.title, "app.b2.guard_stopped_title[name=l4-1]");

  // Guard-stopped runtime was recorded into Ended recently globally.
  assert.equal(guard.getState().ended.length, 1);
  assert.equal(guard.getState().ended[0]?.label, "l4-1");
  assert.equal(guard.getState().ended[0]?.reason.kind, "guard");

  // Dismissing event 11 sends POST /api/sessions/guard/ack with { ids: [11] }.
  toast.dismiss(toasts[1]!.id);
  await flushAsync();
  assert.deepEqual(ackPayloads[1], { ids: [11] });

  // Cross-tab sync: when event 10 disappears from snapshot.guard_events, its toast is dismissed silently.
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 3, guard_events: [events[2]!] }),
    "3",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);
  assert.equal(toast.getToasts()[0]?.title, "app.b2.guard_stopped_title[name=l4-1]");
  assert.equal(ackPayloads.length, 2);
});

test("guardStore deduplicates repeated stop_failed poll events and resets warn on Decision::Ok", async (t) => {
  const sse = createSseControl();
  const ackPayloads: unknown[] = [];

  const client = createApiClient({
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-dedupe", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/sessions/guard/ack") {
        ackPayloads.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(null, { status: 204 });
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
  const i18n = createFakeI18n();
  const guard = createGuardStore({ client, store, toast, i18n });

  t.after(() => {
    guard.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  const rt = makeRuntime();

  // Two consecutive poll rounds emit distinct stop_failed event IDs (20 & 21) for the same runtime.
  const fail1: GuardEvent = {
    id: 20,
    at: 1_700_000_020,
    session: rt.id,
    label: "a100-1",
    email: "alice@example.com",
    kind: "stop_failed",
    concern: { kind: "limit", limit: "runtime", current: 7200, threshold: 7200, estimated: false },
    error: { kind: "connection_lost", params: {}, detail: "drop", next_step: "try_again" },
  };
  const fail2: GuardEvent = {
    ...fail1,
    id: 21,
    at: 1_700_000_050,
    concern: { kind: "limit", limit: "runtime", current: 7230, threshold: 7200, estimated: false },
  };
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 2, runtimes: { runtimes: [rt], errors: [] }, guard_events: [fail1] }),
    "2",
  );
  await flushAsync();
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 3,
      runtimes: { runtimes: [rt], errors: [] },
      guard_events: [fail1, fail2],
    }),
    "3",
  );
  await flushAsync();

  // Only ONE persistent danger toast is shown, and dismissing it acks BOTH event IDs [20, 21].
  assert.equal(toast.getToasts().length, 1);

  // Transient per-account listing error omits acct-1 from runtimes; must NOT clear stop_failed dedupe!
  const fail3: GuardEvent = { ...fail1, id: 22, at: 1_700_000_055 };
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 4,
      runtimes: {
        runtimes: [],
        errors: [
          {
            account: "acct-1",
            error: { kind: "http", params: {}, detail: "transient", next_step: "try_again" },
          },
        ],
      },
      guard_events: [fail1, fail2],
    }),
    "4",
  );
  await flushAsync();
  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 5,
      runtimes: { runtimes: [rt], errors: [] },
      guard_events: [fail1, fail2, fail3],
    }),
    "5",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);

  toast.dismiss(toast.getToasts()[0]!.id);
  await flushAsync();
  assert.deepEqual(ackPayloads[0], { ids: [20, 21, 22] });

  // Warn -> Decision::Ok -> Warn (same limit kind) raises a fresh warning toast.
  const warn1: GuardEvent = {
    id: 30,
    at: 1_700_000_060,
    session: rt.id,
    label: "a100-1",
    email: "alice@example.com",
    kind: "warn",
    concerns: [{ kind: "limit", limit: "runtime", current: 6600, threshold: 7200, estimated: false }],
  };
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 6, runtimes: { runtimes: [rt], errors: [] }, guard_events: [warn1] }),
    "6",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);

  sse.sendFrame(
    "snapshot",
    makeSnapshot({
      version: 7,
      runtimes: { runtimes: [rt], errors: [] },
      guard: {
        decisions: [{ session: rt.id, decision: { decision: "ok" }, stopped: false, error: null }],
        vanished: [],
        usage: [],
      },
      guard_events: [],
    }),
    "7",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 0);

  const warn2: GuardEvent = { ...warn1, id: 31, at: 1_700_000_090 };
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 8, runtimes: { runtimes: [rt], errors: [] }, guard_events: [warn2] }),
    "8",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);
});

test("stopDialogsStore preserves unverified report across retries, blocks while loading, and falls back to toast if closed", async (t) => {
  const sse = createSseControl();
  let stopAllAttempt = 0;

  const watchedRt = makeRuntime();
  const unwatchedRt = makeRuntime({
    id: { account: "acct-1", endpoint: "ep-2", name: null },
    hardware: "NVIDIA T4",
    managed: false,
    tracked: null,
    auto_stop_at: null,
  });

  // Protection breakdown matches upstream watched (armed watchdog) vs unwatched counts.
  assert.equal(isRuntimeWatchdogProtected(watchedRt), true);
  assert.equal(isRuntimeWatchdogProtected(unwatchedRt), false);
  assert.deepEqual(countStopAllProtection([watchedRt, unwatchedRt]), {
    watched: 1,
    unwatched: 1,
  });
  assert.equal(isStopAllRuntimesLoading(null, false), true);
  assert.equal(
    isStopAllRuntimesLoading(makeSnapshot({ runtimes: null, runtimes_error: null }), false),
    true,
  );
  assert.equal(isStopAllRuntimesLoading(makeSnapshot(), true), true);
  assert.equal(isStopAllRuntimesLoading(makeSnapshot(), false), false);

  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-stop", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
      }
      if (url === "/api/snapshot") {
        return jsonResponse(makeSnapshot({ version: 4, runtimes: { runtimes: [unwatchedRt], errors: [] } }));
      }
      if (url === "/api/sessions") {
        return jsonResponse({
          account_context: { revision: 1, active: "acct-1" },
          sampled_at: 1_700_000_050,
          runtimes: [unwatchedRt],
          errors: [],
          guard: null,
          guard_events: [],
          guard_error: null,
          ended: [],
        });
      }
      if (url === "/api/sessions/stop-all") {
        stopAllAttempt += 1;
        if (stopAllAttempt === 1) {
          const unverified: StopAllResponse = {
            verified: false,
            remaining: [{ target: unwatchedRt.id, error: null }],
            account_errors: [],
          };
          return jsonResponse(unverified);
        }
        return jsonResponse(
          {
            error: {
              kind: "http",
              message_key: "app.err.http",
              args: {},
              hint_key: "app.ns.try_again",
              action_key: null,
              operation_id: null,
            },
          },
          503,
        );
      }
      if (url === "/api/sessions/stop") {
        return jsonResponse(
          {
            error: {
              kind: "connection_lost",
              message_key: "app.err.connection_lost",
              args: {},
              hint_key: "app.ns.try_again",
              action_key: null,
              operation_id: null,
            },
          },
          500,
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
  const i18n = createFakeI18n();
  const appData = createAppDataStore({ client, store, clock, toast, t: i18n.t });
  const guard = createGuardStore({ client, store, toast, i18n });
  const stopDialogs = createStopDialogsStore({
    client,
    store,
    appData,
    guard,
    toast,
    t: i18n.t,
  });

  t.after(() => {
    stopDialogs.dispose();
    guard.dispose();
    appData.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  sse.sendFrame(
    "snapshot",
    makeSnapshot({ version: 2, runtimes: { runtimes: [watchedRt, unwatchedRt], errors: [] } }),
    "2",
  );
  await flushAsync();

  // Attempt 1: returns verified=false with remaining error=null.
  stopDialogs.openStopAll();
  await stopDialogs.confirmStopAll();

  assert.equal(stopDialogs.getState().stopAll.phase, "result");
  assert.equal(stopDialogs.getState().stopAll.result?.verified, false);
  assert.equal(stopDialogs.getState().stopAll.result?.remaining.length, 1);
  assert.equal(stopDialogs.getState().stopAll.result?.remaining[0]?.error, null);
  // Stopped watched runtime was recorded into Ended recently.
  assert.equal(guard.getState().ended[0]?.label, "a100-1");

  // Attempt 2 (retry): fails with 503 yet preserves the existing unverified remaining list!
  await stopDialogs.confirmStopAll();
  assert.equal(stopDialogs.getState().stopAll.phase, "result");
  assert.equal(stopDialogs.getState().stopAll.result?.remaining.length, 1);
  assert.notEqual(stopDialogs.getState().stopAll.submitError, null);

  // While background sessions refresh is running after a failed retry, another retry is blocked.
  const stopAllCallsBeforeRefresh = stopAllAttempt;
  const blockedAppData = {
    ...appData,
    getState: () => ({ ...appData.getState(), sessionsRefreshing: true }),
  };
  const guardedStopDialogs = createStopDialogsStore({
    client,
    store,
    appData: blockedAppData,
    guard,
    toast,
    t: i18n.t,
  });
  guardedStopDialogs.openStopAll();
  await guardedStopDialogs.confirmStopAll();
  assert.equal(stopAllAttempt, stopAllCallsBeforeRefresh);
  guardedStopDialogs.dispose();

  // Stop Runtime: open dialog receives inline error; callbacks fire on close.
  let closeNotified = 0;
  stopDialogs.openStopRuntime(
    {
      target: unwatchedRt.id,
      label: "NVIDIA T4",
      email: "alice@example.com",
    },
    {
      onClose: () => {
        closeNotified += 1;
      },
    },
  );
  await stopDialogs.confirmStopRuntime();
  assert.notEqual(stopDialogs.getState().stopRuntime.submitError, null);
  assert.equal(toast.getToasts().length, 0);
  stopDialogs.closeStopRuntime();
  assert.equal(closeNotified, 1);
});

test("guardStore fallback report handles Warn deduplication and StopFailed without guard_events", async (t) => {
  const sse = createSseControl();
  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-fallback", expires_in: 3600 });
      }
      if (url === "/api/events") {
        return sse.response;
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
  const i18n = createFakeI18n();
  const guard = createGuardStore({ client, store, toast, i18n });

  t.after(() => {
    guard.dispose();
    store.dispose();
    sse.close();
    toast.dispose();
    clock.dispose();
  });

  await store.signIn("secret-key");
  const rt = makeRuntime();
  const snapWithWarn: Snapshot = {
    ...makeSnapshot({
      version: 2,
      runtimes: { runtimes: [rt], errors: [] },
      guard: {
        decisions: [
          {
            session: rt.id,
            decision: {
              decision: "warn",
              concerns: [{ kind: "limit", limit: "runtime", current: 6600, threshold: 7200, estimated: false }],
            },
            stopped: false,
            error: null,
          },
        ],
        vanished: [],
        usage: [],
      },
    }),
    guard_events: undefined,
  };
  sse.sendFrame("snapshot", snapWithWarn, "2");
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);
  assert.equal(toast.getToasts()[0]?.tone, "warning");
  assert.equal(toast.getToasts()[0]?.durationMs, null);

  // Repeating the same warn limit kind does not spam another toast.
  sse.sendFrame("snapshot", { ...snapWithWarn, version: 3 }, "3");
  await flushAsync();
  assert.equal(toast.getToasts().length, 1);

  // Stop failed with error=null falls back to guard_still_billing persistent danger toast.
  sse.sendFrame(
    "snapshot",
    {
      ...snapWithWarn,
      version: 4,
      guard: {
        decisions: [
          {
            session: rt.id,
            decision: {
              decision: "stop",
              concerns: { kind: "limit", limit: "runtime", current: 7200, threshold: 7200, estimated: false },
            },
            stopped: false,
            error: null,
          },
        ],
        vanished: [],
        usage: [],
      },
    },
    "4",
  );
  await flushAsync();
  assert.equal(toast.getToasts().length, 2);
  assert.equal(toast.getToasts()[1]?.tone, "danger");
  assert.equal(toast.getToasts()[1]?.durationMs, null);
  assert.equal(toast.getToasts()[1]?.body, "app.b2.guard_still_billing");
});

test("updatesStore shows banner and persistent sidebar badge, keeps badge after dismiss, and rejects unsafe URLs", async (t) => {
  const storageMap = new Map<string, string>();
  const storage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storageMap.set(key, value);
    },
  };

  let fetchCount = 0;
  const noticeV06: UpdateNoticeResponse = {
    current_version: "0.5.0",
    update_available: true,
    releases_url: "https://github.com/321sssrt-bit/colab-playground/releases",
    release_url: "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.6.0",
    latest_version: "0.6.0",
    status: "available",
    checked_at: 1_700_000_000,
    check_updates: true,
    error: null,
    persist_error: null,
  };

  const client = createApiClient({
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/login") {
        return jsonResponse({ token: "tok-upd", expires_in: 3600 });
      }
      if (url === "/api/updates") {
        fetchCount += 1;
        return jsonResponse(noticeV06);
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  let intervalCallback: (() => void) | null = null;
  const updates = createUpdatesStore({
    client,
    storage,
    setIntervalFn: (cb) => {
      intervalCallback = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearIntervalFn: () => {
      intervalCallback = null;
    },
  });
  t.after(() => {
    updates.dispose();
  });

  assert.equal(isSafeHttpsUrl("https://github.com/321sssrt-bit/colab-playground/releases"), true);
  assert.equal(isSafeHttpsUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpsUrl("http://example.com"), false);

  await client.login("secret-key");
  await Promise.all([updates.ensureChecked(), updates.ensureChecked()]);
  assert.equal(fetchCount, 1);
  assert.notEqual(intervalCallback, null);

  // Periodic background tick re-queries /api/updates while authenticated.
  (intervalCallback as (() => void) | null)?.();
  await flushAsync();
  assert.equal(fetchCount, 2);

  assert.deepEqual(updates.getState().bannerUpdate, {
    version: "0.6.0",
    url: "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.6.0",
  });
  assert.equal(updates.getState().badgeVersion, "0.6.0");

  // Dismiss hides the top banner for 0.6.0 while preserving the sidebar Settings badge.
  updates.dismiss("0.6.0");
  assert.equal(storageMap.get(UPDATE_DISMISSED_STORAGE_KEY), "0.6.0");
  assert.equal(updates.getState().bannerUpdate, null);
  assert.equal(updates.getState().badgeVersion, "0.6.0");

  // A newer version (0.7.0) re-surfaces the top banner.
  updates.applyNotice({
    ...noticeV06,
    latest_version: "0.7.0",
    release_url: "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.7.0",
  });
  assert.deepEqual(updates.getState().bannerUpdate, {
    version: "0.7.0",
    url: "https://github.com/321sssrt-bit/colab-playground/releases/tag/v0.7.0",
  });
  assert.equal(updates.getState().badgeVersion, "0.7.0");
});

test("isKeyringLockedOrAccountsMissing collapses sidebar even when stale account.active remains", () => {
  assert.equal(isKeyringLockedOrAccountsMissing(null), true);
  assert.equal(isKeyringLockedOrAccountsMissing(makeSnapshot()), false);
  assert.equal(
    isKeyringLockedOrAccountsMissing(
      makeSnapshot({
        account: { revision: 4, active: "acct-1" },
        accounts: null,
        accounts_error: "keyring_unavailable",
      }),
    ),
    true,
  );
  assert.equal(
    isKeyringLockedOrAccountsMissing(
      makeSnapshot({
        accounts_error: "keyring_unavailable",
      }),
    ),
    true,
  );
});
