import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { createApiClient, type EventStreamOptions } from "../../lib/api.ts";
import { createServerClock } from "../../lib/clock.ts";
import { i18nStore, type I18nState, type TranslateFn } from "../../lib/i18n.ts";
import type { SseFrame } from "../../lib/sse.ts";
import { createToastStore } from "../../lib/toast.ts";
import type {
  AccountContext,
  EndedRuntime,
  HardwareRate,
  Runtime,
  Snapshot,
} from "../../lib/types.ts";
import type { ProvisionSpec } from "./api.ts";
import { endedRuntimeRowKey, isSessionsEnvironmentReady } from "./format.ts";
import {
  buildProvisionSpecFromDraft,
  computeUnansweredForSecs,
  findMeasuredRate,
  resolveNextSuggestedName,
  SLOW_ANSWER_SECS,
  specToProvisionDraft,
} from "./provision.ts";
import {
  createSessionsStore,
  sessionsStore,
  type SubmittedProvisionForm,
} from "./store.ts";

after(() => {
  sessionsStore.dispose();
  i18nStore.dispose();
});

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

function makeBaseSpec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    name: "a100-amber-42",
    accelerator: "A100",
    high_mem: true,
    min_vram_mib: null,
    max_attempts: 3,
    retry_delay: 20,
    on_exhausted: "stop_and_fail",
    guard: {
      max_runtime: 3600,
      max_spend_cu: null,
      min_balance_cu: null,
      idle_timeout: null,
    },
    ...overrides,
  };
}

function makeFakeI18n(dictLoaded = true) {
  const listeners = new Set<() => void>();
  let state: I18nState = {
    preference: "en-US",
    browserLocale: "en-US",
    locale: "en-US",
    dict: dictLoaded ? { "app.b2.new_failed": "Failed" } : null,
    loading: false,
    loadFailed: false,
  };
  const t: TranslateFn = (key, params) => {
    if (!params) {
      return key;
    }
    const pairs = Object.entries(params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(",");
    return `${key}(${pairs})`;
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
    loadDict: () => {
      state = { ...state, dict: { loaded: "1" } };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function makeFakeWebStore(initial: Snapshot | null = null) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => ({
      authStatus: "authenticated" as const,
      connectionStatus: "connected" as const,
      snapshot,
      lastEventId: snapshot ? String(snapshot.version) : null,
      reconnectAttempt: 0,
      nextRetryDelayMs: null,
      lastError: null,
      lastForwardEvent: null,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeForwards: () => () => {},
    signIn: async () => {},
    signOut: () => {},
    refreshSnapshot: async () => snapshot ?? makeSnapshot(),
    reconnectNow: () => {},
    dispose: () => {
      listeners.clear();
    },
    pushSnapshot: (next: Snapshot | null) => {
      snapshot = next;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("isSessionsEnvironmentReady", () => {
  it("returns false when snapshot is missing or keyring is unavailable", () => {
    assert.equal(isSessionsEnvironmentReady(null, true), false);
    assert.equal(
      isSessionsEnvironmentReady(
        makeSnapshot({ accounts: null, accounts_error: "keyring_unavailable" }),
        true,
      ),
      false,
    );
    assert.equal(
      isSessionsEnvironmentReady(makeSnapshot({ accounts: null, accounts_error: null }), true),
      false,
    );
  });

  it("returns false when CLI is missing or no saved accounts exist", () => {
    assert.equal(
      isSessionsEnvironmentReady(
        makeSnapshot({ accounts: null, accounts_error: "not_installed" }),
        false,
      ),
      false,
    );
    assert.equal(
      isSessionsEnvironmentReady(
        makeSnapshot({
          accounts: {
            accounts: [],
            active: null,
            has_token: false,
            unadopted: false,
            active_email: null,
            recovered_pending_add: false,
          },
        }),
        true,
      ),
      false,
    );
  });

  it("returns true when CLI is installed and at least one saved account exists", () => {
    assert.equal(isSessionsEnvironmentReady(makeSnapshot(), true), true);
  });
});

describe("findMeasuredRate", () => {
  it("retains historical measured rates after all runtimes are stopped", () => {
    const historical: HardwareRate[] = [
      {
        accelerator: "A100",
        high_mem: true,
        reading: { cu_per_hour: 6.42, at: 1_700_000_100 },
      },
      {
        accelerator: "L4",
        high_mem: false,
        reading: { cu_per_hour: 1.48, at: 1_700_000_200 },
      },
    ];

    const a100 = findMeasuredRate([], "A100", true, historical);
    assert.deepEqual(a100, { cu_per_hour: 6.42, at: 1_700_000_100 });

    // Single-shape accelerators normalize high_mem to false.
    const l4 = findMeasuredRate([], "L4", true, historical);
    assert.deepEqual(l4, { cu_per_hour: 1.48, at: 1_700_000_200 });

    // Mismatched shape returns null so caller falls back to published rate.
    assert.equal(findMeasuredRate([], "A100", false, historical), null);
  });

  it("picks the newest reading across historical measured_rates and live runtimes", () => {
    const historical: HardwareRate[] = [
      {
        accelerator: "T4",
        high_mem: false,
        reading: { cu_per_hour: 1.05, at: 1_700_000_050 },
      },
    ];
    const liveRuntime = {
      id: { account: "acct-1", endpoint: "ep-1", name: "t4-one" },
      account_email: "alice@example.com",
      on_active_account: true,
      accelerator: "T4",
      hardware: "Tesla T4",
      high_mem: false,
      managed: true,
      tracked: {
        name: "t4-one",
        account: "acct-1",
        endpoint: "ep-1",
        accelerator: "T4",
        high_mem: false,
        gpu: "Tesla T4",
        vram_mib: 15360,
        policy: { max_runtime: null, max_spend_cu: null, min_balance_cu: null, idle_timeout: null },
        spend: {
          started_at: 1_700_000_000,
          spend_cu: 0.2,
          rate_known: true,
          estimated: false,
          integrated_to: 1_700_000_100,
          last_share_cu_per_hour: 1.12,
          last_observed: 1_700_000_100,
        },
        watchdog: null,
        stopped: null,
        measured_rate: { cu_per_hour: 1.12, at: 1_700_000_300 },
      },
      estimated_rate_cu_per_hour: 1.12,
      estimated_spend_cu: 0.2,
      auto_stop_at: null,
      tunnels: [],
    } satisfies Runtime;

    const latest = findMeasuredRate([liveRuntime], "T4", false, historical);
    assert.deepEqual(latest, { cu_per_hour: 1.12, at: 1_700_000_300 });
  });
});

describe("session name fallback and accelerator prefix sync", () => {
  it("falls back to suggested name when user clears custom input before submit", () => {
    const base = makeBaseSpec({ name: "a100-amber-42" });
    const draft = specToProvisionDraft(base);

    const builtEmpty = buildProvisionSpecFromDraft("", draft, 20, base, "a100-amber-42");
    assert.equal(builtEmpty.ok, true);
    if (builtEmpty.ok) {
      assert.equal(builtEmpty.spec.name, "a100-amber-42");
    }

    const builtWhitespace = buildProvisionSpecFromDraft("   ", draft, 20, base, "t4-amber-42");
    assert.equal(builtWhitespace.ok, true);
    if (builtWhitespace.ok) {
      assert.equal(builtWhitespace.spec.name, "t4-amber-42");
    }

    const builtInvalid = buildProvisionSpecFromDraft("bad name!", draft, 20, base, "a100-amber-42");
    assert.equal(builtInvalid.ok, false);
    if (!builtInvalid.ok) {
      assert.equal(builtInvalid.invalidFields.has("name"), true);
    }
  });

  it("updates suggested name on accelerator change and fills empty or untouched inputs", () => {
    const untouched = resolveNextSuggestedName("a100-amber-42", "a100-amber-42", "A100", "T4");
    assert.deepEqual(untouched, {
      suggestedName: "t4-amber-42",
      nextDraft: "t4-amber-42",
    });

    const cleared = resolveNextSuggestedName("   ", "a100-amber-42", "A100", "NONE");
    assert.deepEqual(cleared, {
      suggestedName: "cpu-amber-42",
      nextDraft: "cpu-amber-42",
    });

    const custom = resolveNextSuggestedName("my-train-job", "a100-amber-42", "A100", "L4");
    assert.deepEqual(custom, {
      suggestedName: "l4-amber-42",
      nextDraft: "my-train-job",
    });
  });
});

describe("computeUnansweredForSecs", () => {
  it("counts elapsed seconds on server clock once overdue and resets when answered", () => {
    const allocating = [{ event: "allocating" as const, attempt: 1, max_attempts: 3 }];
    const start = 1_700_000_000;

    assert.equal(computeUnansweredForSecs(allocating, start, start + 30), null);
    assert.equal(
      computeUnansweredForSecs(allocating, start, start + SLOW_ANSWER_SECS),
      SLOW_ANSWER_SECS,
    );
    assert.equal(computeUnansweredForSecs(allocating, start, start + 200), 200);
    assert.equal(computeUnansweredForSecs(allocating, start, start - 5), null);

    const answered = [...allocating, { event: "allocated" as const, attempt: 1 }];
    assert.equal(computeUnansweredForSecs(answered, start, start + 600), null);
    assert.equal(computeUnansweredForSecs(allocating, null, start + 600), null);
  });
});

describe("endedRuntimeRowKey", () => {
  it("avoids collisions when runtime endpoints are empty", () => {
    const first: EndedRuntime = {
      runtime: { account: "acct-1", endpoint: "", name: "alpha" },
      label: "Tesla T4",
      email: "alice@example.com",
      reason: { kind: "user" },
      at: 1_700_000_000,
    };
    const second: EndedRuntime = {
      runtime: { account: "acct-1", endpoint: "", name: "beta" },
      label: "Tesla T4",
      email: "alice@example.com",
      reason: { kind: "user" },
      at: 1_700_000_000,
    };
    const unnamedA: EndedRuntime = {
      runtime: { account: "acct-1", endpoint: "", name: null },
      label: "Tesla T4",
      email: "alice@example.com",
      reason: { kind: "vanished" },
      at: null,
    };
    const unnamedB: EndedRuntime = { ...unnamedA };

    assert.notEqual(endedRuntimeRowKey(first, 0), endedRuntimeRowKey(second, 1));
    assert.notEqual(endedRuntimeRowKey(unnamedA, 0), endedRuntimeRowKey(unnamedB, 1));
  });
});

describe("createSessionsStore off-page provision tracking and serverClock timing", () => {
  it("delivers ready, below_spec, and failed toasts while away and keeps submittedForm", async () => {
    let monoMs = 10_000;
    const clock = createServerClock({
      wallNow: () => 0,
      monotonicNow: () => monoMs,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => {},
    });
    clock.sync(1_700_000_000, { authoritative: true });

    const client = createApiClient({ fetchImpl: async () => new Response() });
    const web = makeFakeWebStore();
    const toast = createToastStore({
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    const i18n = makeFakeI18n(true);

    let sessionsRefreshed = 0;
    let forwardsRefreshed = 0;
    const streams = new Map<
      number,
      { onFrame?: (frame: SseFrame) => void; resolve: () => void }
    >();

    const store = createSessionsStore({
      client,
      store: web,
      appData: {
        refreshSessions: async () => {
          sessionsRefreshed += 1;
          return {
            account_context: { revision: 1, active: "acct-1" },
            sampled_at: clock.getNowSecs(),
            runtimes: [],
            errors: [],
            guard: null,
            guard_error: null,
          };
        },
        refreshSessionDefaults: async () => ({
          rearmDurationSecs: 3600,
          maxConcurrentSessions: 2,
        }),
      },
      forwards: {
        refresh: async () => {
          forwardsRefreshed += 1;
          return [];
        },
        recordForward: () => {},
      },
      guard: {
        getState: () => ({ ended: [], reconcileSeq: 0 }),
        subscribe: () => () => {},
        clearEndedRuntimes: () => {},
      },
      toast,
      i18n,
      clock,
      openStream: (id: number, opts: Omit<EventStreamOptions, "body">) =>
        new Promise<void>((resolve) => {
          streams.set(id, { onFrame: opts.onFrame, resolve });
          opts.onOpen?.();
        }),
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });

    const ctx: AccountContext = { revision: 1, active: "acct-1" };
    const spec = makeBaseSpec();
    const submittedForm: SubmittedProvisionForm = {
      name: spec.name,
      suggestedName: spec.name,
      draft: specToProvisionDraft(spec),
      baseTemplate: spec,
      retryDelaySecs: spec.retry_delay,
      measuredRates: [],
      accountContext: ctx,
    };

    // 1. Background provision detected via snapshot push while off `#/sessions` -> below_spec warning toast.
    web.pushSnapshot(
      makeSnapshot({
        operations: [
          { id: 10, operation: { kind: "provision", session: "a100-amber-42" }, cancelling: false },
        ],
      }),
    );
    const stream10 = streams.get(10);
    assert.ok(stream10);

    stream10.onFrame?.({
      id: null,
      event: "progress",
      data: JSON.stringify({ event: "allocating", attempt: 1, max_attempts: 2 }),
    });
    assert.equal(store.getState().trackedProvision?.waitingSinceSecs, 1_700_000_000);

    // Advance clock 90s; replayed allocating frame on same attempt must not reset waitingSinceSecs.
    monoMs += 90_000;
    stream10.onFrame?.({
      id: null,
      event: "progress",
      data: JSON.stringify({ event: "allocating", attempt: 1, max_attempts: 2 }),
    });
    assert.equal(store.getState().trackedProvision?.waitingSinceSecs, 1_700_000_000);

    stream10.onFrame?.({
      id: null,
      event: "finished",
      data: JSON.stringify({
        phase: "ready",
        outcome: {
          name: "a100-amber-42",
          hardware: { gpu: "A100", vram_mib: 40960 },
          attempts: 2,
          below_spec: true,
          watchdog: null,
          started_at: 1_700_000_090,
        },
      }),
    });
    stream10.resolve();

    assert.equal(sessionsRefreshed, 1);
    assert.equal(forwardsRefreshed, 1);
    assert.equal(toast.getToasts().length, 1);
    assert.equal(toast.getToasts()[0]?.tone, "warning");
    assert.equal(
      toast.getToasts()[0]?.title,
      "app.b2.provision_ready_toast(name=a100-amber-42)",
    );

    // 2. Hidden/reopened provision failure preserves submittedForm and suppresses duplicate toast when dialog is open.
    store.setDialogOperationId(11);
    store.trackProvision(11, spec.name, ctx, submittedForm);
    const stream11 = streams.get(11);
    assert.ok(stream11);
    stream11.onFrame?.({
      id: null,
      event: "finished",
      data: JSON.stringify({
        phase: "failed",
        error: {
          kind: "not_entitled",
          message_key: "app.err.not_entitled",
          args: {},
          hint_key: null,
          action_key: null,
          operation_id: null,
        },
      }),
    });
    stream11.resolve();

    assert.equal(toast.getToasts().length, 1);
    assert.deepEqual(store.getState().trackedProvision?.submittedForm, submittedForm);

    // 3. Off-page failure delivers danger toast immediately.
    store.setDialogOperationId(null);
    store.trackProvision(12, spec.name, ctx, submittedForm);
    const stream12 = streams.get(12);
    assert.ok(stream12);
    stream12.onFrame?.({
      id: null,
      event: "finished",
      data: JSON.stringify({
        phase: "failed",
        error: {
          kind: "not_entitled",
          message_key: "app.err.not_entitled",
          args: {},
          hint_key: null,
          action_key: null,
          operation_id: null,
        },
      }),
    });
    stream12.resolve();

    assert.equal(toast.getToasts().length, 2);
    assert.equal(toast.getToasts()[1]?.tone, "danger");
    assert.equal(toast.getToasts()[1]?.title, "app.b2.new_failed");

    store.dispose();
    toast.dispose();
    clock.dispose();
  });
});
