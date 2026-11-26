import assert from "node:assert/strict";
import test, { after } from "node:test";

import { ApiError, type ApiClient, type AuthEvent, type EventStreamOptions } from "../../lib/api.ts";
import { appDataStore, type AppDataStore } from "../../lib/appCache.ts";
import { forwardsStore, type ForwardsStore } from "../../lib/forwards.ts";
import { i18nStore } from "../../lib/i18n.ts";
import type { SseFrame } from "../../lib/sse.ts";
import { webStore, type WebStore, type WebStoreState } from "../../lib/store.ts";
import { createToastStore, toastStore } from "../../lib/toast.ts";
import type {
  AccountContext,
  ForwardView,
  Runtime,
  SessionsListResponse,
  Snapshot,
  TunnelInfo,
} from "../../lib/types.ts";
import {
  buildGgufFitKey,
  cancelPluginPreview,
  findInspectPluginOpId,
  getHfTokenBadgeMeta,
  planGgufEstimateFetch,
  resolvePluginRunBannerPhase,
  shouldSendGlobalPreviewCancel,
} from "./api.ts";
import { selectEndpointTunnelByPort, stripAnsi } from "./endpoint.ts";
import { createPluginCacheStore, pluginCacheStore } from "./pluginCache.ts";
import {
  canRunPluginAgain,
  createPluginRunsStore,
  pluginRunsStore,
  resolveDeployOriginAccountContext,
  resolvePluginRunBillingState,
  submitPluginDeployRun,
} from "./runStore.ts";
import type { PluginInfo, PluginRunSummary, PluginRunTemplateSpec } from "./types.ts";

after(() => {
  pluginRunsStore.dispose();
  pluginCacheStore.dispose();
  appDataStore.dispose();
  forwardsStore.dispose();
  webStore.dispose();
  toastStore.dispose();
  i18nStore.dispose();
});

interface FakeClientHarness {
  readonly client: ApiClient;
  readonly calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }>;
  readonly streams: Map<
    string,
    {
      readonly signal: AbortSignal | undefined;
      readonly emitFrame: (frame: SseFrame) => void;
      readonly finish: () => void;
      readonly fail: (error: unknown) => void;
    }
  >;
  emitAuth(event: AuthEvent): void;
}

function createFakeClient(
  handler: (
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>,
): FakeClientHarness {
  let generation = 1;
  let authenticated = true;
  const authListeners = new Set<(event: AuthEvent) => void>();
  const calls: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> = [];
  const streams = new Map<
    string,
    {
      readonly signal: AbortSignal | undefined;
      readonly emitFrame: (frame: SseFrame) => void;
      readonly finish: () => void;
      readonly fail: (error: unknown) => void;
    }
  >();

  const client: ApiClient = {
    isAuthenticated: () => authenticated,
    getSessionGeneration: () => generation,
    getSessionExpiresAt: () => null,
    subscribeAuth: (listener) => {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    },
    onUnauthorized: () => () => {},
    checkSession: async () => {},
    login: async () => {
      throw new Error("not implemented");
    },
    logout: () => {
      authenticated = false;
      generation += 1;
      for (const listener of authListeners) {
        listener({ type: "logged_out", generation });
      }
    },
    request: async <T>(
      path: string,
      opts?: { readonly method?: string; readonly body?: unknown; readonly signal?: AbortSignal },
    ): Promise<T> => {
      const method = opts?.method ?? "GET";
      calls.push({ method, path, body: opts?.body });
      return (await handler(method, path, opts?.body, opts?.signal)) as T;
    },
    getSnapshot: async () => {
      throw new Error("not implemented");
    },
    openEventStream: (path: string, opts: EventStreamOptions): Promise<void> => {
      calls.push({ method: "SSE", path, body: opts.body });
      return new Promise<void>((resolve, reject) => {
        const entry = {
          signal: opts.signal,
          emitFrame: (frame: SseFrame) => opts.onFrame(frame),
          finish: () => {
            streams.delete(path);
            resolve();
          },
          fail: (error: unknown) => {
            streams.delete(path);
            reject(error);
          },
        };
        streams.set(path, entry);
        opts.onOpen?.();
        opts.signal?.addEventListener(
          "abort",
          () => {
            streams.delete(path);
            reject(
              new ApiError({
                status: 0,
                kind: "cancelled",
                message: "aborted",
                isAbort: true,
              }),
            );
          },
          { once: true },
        );
      });
    },
  };

  return {
    client,
    calls,
    streams,
    emitAuth(event: AuthEvent) {
      if (event.type === "logged_out" || event.type === "unauthorized") {
        authenticated = false;
      } else {
        authenticated = true;
      }
      generation = event.generation;
      for (const listener of authListeners) {
        listener(event);
      }
    },
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    server_now: 1_700_000_000,
    backend: "mock",
    account: { revision: 1, active: "acc-1" },
    accounts: {
      accounts: [],
      active: "acc-1",
      has_token: true,
      unadopted: false,
      active_email: "one@example.com",
      recovered_pending_add: false,
    },
    accounts_error: null,
    runtimes: { runtimes: [], errors: [] },
    runtimes_error: null,
    tunnels: [],
    usage: [],
    guard: null,
    guard_error: null,
    operations: [],
    login_id: null,
    shutting_down: false,
    ...overrides,
  };
}

function createFakeWebStore(initial: Snapshot | null): {
  readonly store: WebStore;
  setSnapshot(next: Snapshot | null): void;
  readonly refreshCount: () => number;
} {
  let state: WebStoreState = {
    authStatus: "authenticated",
    connectionStatus: "connected",
    snapshot: initial,
    lastEventId: null,
    reconnectAttempt: 0,
    nextRetryDelayMs: null,
    lastError: null,
    lastForwardEvent: null,
  };
  let refreshes = 0;
  const listeners = new Set<() => void>();

  const store: WebStore = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeForwards: () => () => {},
    signIn: async () => {},
    signOut: () => {},
    refreshSnapshot: async () => {
      refreshes += 1;
      return state.snapshot ?? makeSnapshot();
    },
    reconnectNow: () => {},
    dispose: () => {
      listeners.clear();
    },
  };

  return {
    store,
    setSnapshot(next) {
      state = { ...state, snapshot: next };
      for (const listener of listeners) {
        listener();
      }
    },
    refreshCount: () => refreshes,
  };
}

function makeRuntime(account: string, name: string, onActiveAccount = true): Runtime {
  return {
    id: { account, endpoint: `m-s-${name}`, name },
    account_email: `${account}@example.com`,
    on_active_account: onActiveAccount,
    accelerator: "T4",
    hardware: "T4",
    high_mem: false,
    managed: true,
    tracked: null,
    estimated_rate_cu_per_hour: null,
    estimated_spend_cu: null,
    auto_stop_at: null,
    tunnels: [],
  };
}

function makePlugin(id: string, enabled = true): PluginInfo {
  return {
    manifest: {
      api: 1,
      id,
      version: "1.0.0",
      name: { en: "llama.cpp", "zh-CN": "llama.cpp 模型" },
      description: { en: "Serve GGUF models" },
      inputs: [],
      run: { script: "run.sh" },
      stages: [],
      endpoints: [],
      needs: ["hf_token"],
    },
    source: { kind: "bundled" },
    enabled,
  };
}

function makeTunnel(
  id: number,
  account: string,
  session: string,
  remotePort: number,
  localPort: number,
  state: TunnelInfo["state"] = { state: "up" },
  healthy: boolean | null = true,
): TunnelInfo {
  return {
    id,
    spec: {
      account,
      session,
      bind: "loopback",
      local_port: localPort,
      remote_port: remotePort,
      health_path: "/health",
    },
    state,
    healthy,
  };
}

function makeFakeForwards(): {
  readonly forwards: ForwardsStore;
  readonly recorded: ForwardView[];
} {
  const recorded: ForwardView[] = [];
  const forwards: ForwardsStore = {
    getState: () => ({ snapshotVersion: 0, addressesById: {}, overlaysById: {} }),
    subscribe: () => () => {},
    refresh: async () => [],
    recordForward: (view) => {
      recorded.push(view);
    },
    applyEvent: () => {},
    getEffectiveTunnel: (tunnel) => tunnel,
    selectForwardsForRuntime: () => [],
    dispose: () => {},
  };
  return { forwards, recorded };
}

test("submitPluginDeployRun locks originAccountContext and clears secrets only after accept", async () => {
  const origin: AccountContext = { revision: 3, active: "acc-1" };
  let failNext = true;
  let clearedCount = 0;

  const harness = createFakeClient(async (_method, path, body) => {
    assert.equal(path, "/api/plugins/runs");
    const payload = body as { account_context: AccountContext };
    assert.deepEqual(payload.account_context, origin);
    if (failNext) {
      failNext = false;
      throw new ApiError({
        status: 409,
        kind: "account_not_active",
        message: "account changed",
      });
    }
    return { id: 42 };
  });

  const spec: PluginRunTemplateSpec = {
    plugin: "llama-cpp",
    inputs: { api_key: "sk-secret" },
    target: { kind: "existing", name: "sess-1" },
    stop_on_failure: true,
  };

  await assert.rejects(
    () =>
      submitPluginDeployRun({
        originAccountContext: origin,
        spec,
        existing: { account: "acc-1", endpoint: "m-s-1", name: "sess-1" },
        resolvedSessionName: "sess-1",
        clearSecrets: () => {
          clearedCount += 1;
        },
        client: harness.client,
      }),
    (err: unknown) => err instanceof ApiError && err.kind === "account_not_active",
  );
  assert.equal(clearedCount, 0, "failed submit must keep entered secret inputs intact");

  const result = await submitPluginDeployRun({
    originAccountContext: origin,
    spec,
    existing: { account: "acc-1", endpoint: "m-s-1", name: "sess-1" },
    resolvedSessionName: "sess-1",
    clearSecrets: () => {
      clearedCount += 1;
    },
    client: harness.client,
  });
  assert.equal(clearedCount, 1, "accepted submit clears secret inputs once");
  assert.equal(result.id, 42);
  assert.equal(result.summary.account, "acc-1");
  assert.equal(result.summary.phase, "running");

  const locked = resolveDeployOriginAccountContext(origin, { revision: 4, active: "acc-2" });
  assert.deepEqual(locked, origin, "subsequent account switch must not overwrite origin lock");
});

test("billing verification isolates checking without stale snapshot fallback and caches across route switches", async () => {
  const staleRuntime = makeRuntime("acc-1", "gpu-run-1");
  const web = createFakeWebStore(
    makeSnapshot({
      version: 5,
      runtimes: { runtimes: [staleRuntime], errors: [] },
    }),
  );

  let sessionsFetchCount = 0;
  let resolveSessions!: (value: SessionsListResponse) => void;
  const appData = {
    refreshSessions: () => {
      sessionsFetchCount += 1;
      return new Promise<SessionsListResponse>((resolve) => {
        resolveSessions = resolve;
      });
    },
  } as unknown as AppDataStore;

  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins/runs") {
      return [
        {
          id: 10,
          plugin: "llama-cpp",
          account: "acc-1",
          session: "gpu-run-1",
          provisions: true,
          finished: true,
          phase: "failed",
        } satisfies PluginRunSummary,
      ];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast: createToastStore(),
    t: (key) => key,
  });

  await runsStore.refreshPluginRuns({ autoAttach: false });
  const verifyPromise = runsStore.verifyRunBilling(10);

  // During checking, even though stale snapshot v5 still contains `staleRuntime`,
  // billing state MUST stay `checking` and never flash `billing`.
  const duringCheck = resolvePluginRunBillingState(
    {
      id: 10,
      account: "acc-1",
      session: "gpu-run-1",
      provisions: true,
      launched: true,
      provisionAllocated: true,
    },
    runsStore.getState().billingChecksByRunId[10],
    web.store.getState().snapshot,
  );
  assert.deepEqual(duringCheck, { phase: "checking", runtime: null });

  // Concurrent call deduplicates onto the in-flight check.
  const dedupPromise = runsStore.verifyRunBilling(10);
  assert.equal(sessionsFetchCount, 1);

  web.setSnapshot(makeSnapshot({ version: 6, runtimes: { runtimes: [staleRuntime], errors: [] } }));
  resolveSessions({
    account_context: { revision: 1, active: "acc-1" },
    sampled_at: 1_700_000_005,
    runtimes: [staleRuntime],
    errors: [],
    guard: null,
    guard_error: null,
  });
  await Promise.all([verifyPromise, dedupPromise]);

  // Verified result shows the still-billing runtime.
  const verifiedState = resolvePluginRunBillingState(
    {
      id: 10,
      account: "acc-1",
      session: "gpu-run-1",
      provisions: true,
      launched: true,
      provisionAllocated: true,
    },
    runsStore.getState().billingChecksByRunId[10],
    web.store.getState().snapshot,
  );
  assert.equal(verifiedState.phase, "billing");
  assert.equal(verifiedState.runtime?.id.name, "gpu-run-1");

  // Returning to the page reuses the cached check without hitting `/api/sessions` again.
  await runsStore.verifyRunBilling(10);
  assert.equal(sessionsFetchCount, 1);

  // Newer clean SSE snapshot after stopping in Sessions clears billing immediately.
  web.setSnapshot(makeSnapshot({ version: 7, runtimes: { runtimes: [], errors: [] } }));
  const afterExternalStop = resolvePluginRunBillingState(
    {
      id: 10,
      account: "acc-1",
      session: "gpu-run-1",
      provisions: true,
      launched: true,
      provisionAllocated: true,
    },
    runsStore.getState().billingChecksByRunId[10],
    web.store.getState().snapshot,
  );
  assert.deepEqual(afterExternalStop, { phase: "stopped", runtime: null });

  runsStore.dispose();
  pluginCache.dispose();
});

test("leaving run view keeps SSE stream alive, updates banner phase, and emits Ready toast exactly once", async () => {
  const web = createFakeWebStore(makeSnapshot());
  const toast = createToastStore();
  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins") {
      return [makePlugin("llama-cpp", true)];
    }
    if (path === "/api/plugins/runs") {
      return [
        {
          id: 7,
          plugin: "llama-cpp",
          account: "acc-1",
          session: "model-1",
          provisions: true,
          finished: false,
          phase: "running",
        } satisfies PluginRunSummary,
      ];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  await pluginCache.ensurePlugins();

  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData: {} as AppDataStore,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast,
    t: (key, args) => `${key}:${String(args?.name ?? "")}`,
    getLocale: () => "zh-CN",
  });

  await runsStore.refreshPluginRuns({ autoAttach: true });
  assert.equal(runsStore.getState().selectedRunId, 7);
  assert.equal(runsStore.isStreamActive(7), true);

  // Leave run detail to plugin list and open deploy form: SSE stream MUST stay open.
  runsStore.showPluginList();
  assert.equal(runsStore.getState().selectedRunId, null);
  assert.equal(runsStore.isStreamActive(7), true);

  runsStore.openPluginDeployForm("llama-cpp");
  assert.equal(runsStore.isStreamActive(7), true);

  const stream = harness.streams.get("/api/plugins/runs/7/events");
  assert.ok(stream, "SSE stream for run 7 must remain registered");

  stream.emitFrame({
    event: "log",
    data: JSON.stringify({
      lines: ["\x1b[32mready\x1b[0m \x1b]8;;https://hf.co\x1b\\link\x1b]8;;\x1b\\"],
    }),
    id: null,
  });
  stream.emitFrame({
    event: "finished",
    data: JSON.stringify({
      phase: "ready",
      run: { plugin: "llama-cpp", account: "acc-1", session: "model-1", provisions: true },
      outcome: {
        session: "model-1",
        account: "acc-1",
        run_id: "r7",
        status: { state: "ready", stage: "warm", progress: 1, message: null, outputs: {} },
      },
      endpoints: [],
      error: null,
    }),
    id: null,
  });
  stream.finish();
  await Promise.resolve();

  assert.equal(runsStore.getState().knownPhasesById[7], "ready");
  assert.equal(runsStore.getState().runs[0]?.phase, "ready");
  assert.equal(runsStore.getState().runs[0]?.finished, true);
  assert.deepEqual(runsStore.getState().detailsById[7]?.logEntries, [
    { kind: "line", text: "ready link" },
  ]);
  assert.equal(toast.getToasts().length, 1);
  assert.equal(toast.getToasts()[0]?.body, "app.b2.run_ready_toast:llama.cpp 模型");
  assert.equal(runsStore.hasToastedReadyRun(7), true);

  // Reopening run 7 reuses completed detail with no duplicate stream and no duplicate toast.
  const sseCallsBefore = harness.calls.filter((c) => c.method === "SSE").length;
  runsStore.openPluginRun(7);
  assert.equal(runsStore.getState().activeRun?.phase, "ready");
  assert.equal(harness.calls.filter((c) => c.method === "SSE").length, sseCallsBefore);
  assert.equal(toast.getToasts().length, 1);

  runsStore.dispose();
  pluginCache.dispose();
  toast.dispose();
});

test("selectEndpointTunnelByPort reconnects after Sessions closes and reopens a forward on the same port", () => {
  const initialTunnel = makeTunnel(5, "acc-1", "model-1", 8080, 8080);
  const matchedInitial = selectEndpointTunnelByPort(
    [initialTunnel],
    { account: "acc-1", session: "model-1", remotePort: 8080 },
    {},
    1,
    5,
  );
  assert.equal(matchedInitial?.id, 5);

  // Sessions closes tunnel #5 and opens tunnel #9 on a different local port for remote port 8080.
  const closedOld = makeTunnel(5, "acc-1", "model-1", 8080, 8080, { state: "stopped" }, null);
  const reopenedNew = makeTunnel(9, "acc-1", "model-1", 8080, 18080, { state: "up" }, true);
  const otherSession = makeTunnel(10, "acc-1", "other", 8080, 18081, { state: "up" }, true);

  const matchedReopened = selectEndpointTunnelByPort(
    [closedOld, otherSession, reopenedNew],
    { account: "acc-1", session: "model-1", remotePort: 8080 },
    {},
    2,
    5,
  );
  assert.equal(matchedReopened?.id, 9);
  assert.equal(matchedReopened?.spec.local_port, 18080);

  // Same-version SSE overlay marking #9 stopped excludes it immediately.
  const afterOverlayStop = selectEndpointTunnelByPort(
    [reopenedNew],
    { account: "acc-1", session: "model-1", remotePort: 8080 },
    { 9: { snapshotVersion: 2, state: { state: "stopped" } } },
    2,
    9,
  );
  assert.equal(afterOverlayStop, null);
});

test("deploy draft persists across navigations and HF token cache does not mask failures with stale saved=true", async () => {
  const web = createFakeWebStore(
    makeSnapshot({
      version: 1,
      account: { revision: 2, active: "acc-1" },
      runtimes: { runtimes: [makeRuntime("acc-1", "s1")], errors: [] },
    }),
  );

  let templateFetches = 0;
  let tokenFetches = 0;
  let failTokenNext = false;

  const harness = createFakeClient(async (method, path) => {
    if (method === "GET" && path === "/api/plugins/llama-cpp/template") {
      templateFetches += 1;
      return {
        plugin: "llama-cpp",
        inputs: { model: "unsloth/Qwen3-0.6B-GGUF" },
        target: { kind: "existing", name: "s1" },
        stop_on_failure: true,
      } satisfies PluginRunTemplateSpec;
    }
    if (method === "GET" && path === "/api/plugins/hf/token") {
      tokenFetches += 1;
      if (failTokenNext) {
        throw new ApiError({
          status: 503,
          kind: "keyring_unavailable",
          message: "keyring locked",
        });
      }
      return { saved: true };
    }
    if (method === "POST" && path === "/api/plugins/previews/cancel") {
      return undefined;
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData: {} as AppDataStore,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast: createToastStore(),
    t: (key) => key,
  });

  // 1. Deploy draft loads once and survives edits + account switch reconciliation.
  runsStore.openPluginDeployForm("llama-cpp");
  const openSeq = runsStore.getState().formOpenSeq;
  await runsStore.loadDeployFormTemplate("llama-cpp", openSeq, () => ({
    textValues: { model: "unsloth/Qwen3-0.6B-GGUF" },
    boolValues: {},
    baseProvisionSpec: null,
    provisionDraft: null,
    sessionName: "llama-cpp-run",
    retryDelaySecs: 20,
    stopOnFailure: true,
  }));
  runsStore.updateDeployDraft((prev) => ({
    ...prev,
    textValues: { ...prev.textValues, ctx: "8192" },
    selectedExisting: {
      name: "s1",
      account: "acc-1",
      runtime: { account: "acc-1", endpoint: "m-s-s1", name: "s1" },
    },
  }));

  // Remounting after visiting Settings skips template refetch and preserves edits + origin lock.
  await runsStore.loadDeployFormTemplate("llama-cpp", openSeq, () => {
    throw new Error("should not remap ready draft");
  });
  assert.equal(templateFetches, 1);
  assert.equal(runsStore.getState().deployDraft?.textValues.ctx, "8192");
  assert.deepEqual(runsStore.getState().deployDraft?.originAccountContext, {
    revision: 2,
    active: "acc-1",
  });

  // Switching account drops selectedExisting with `other_account` while preserving origin lock.
  runsStore.reconcileDeployTarget(
    makeSnapshot({
      version: 2,
      account: { revision: 3, active: "acc-2" },
      accounts: {
        accounts: [],
        active: "acc-2",
        has_token: true,
        unadopted: false,
        active_email: "two@example.com",
        recovered_pending_add: false,
      },
    }),
  );
  assert.equal(runsStore.getState().deployDraft?.selectedExisting, null);
  assert.deepEqual(runsStore.getState().deployDraft?.targetLost, {
    kind: "other_account",
    name: "s1",
  });
  assert.deepEqual(runsStore.getState().deployDraft?.originAccountContext, {
    revision: 2,
    active: "acc-1",
  });

  // 2. HF token cache deduplicates ready status and never masks failure with stale saved=true.
  const firstToken = await pluginCache.ensureHfTokenStatus();
  assert.deepEqual(firstToken, { kind: "ready", saved: true });
  const secondToken = await pluginCache.ensureHfTokenStatus();
  assert.deepEqual(secondToken, { kind: "ready", saved: true });
  assert.equal(tokenFetches, 1, "ensureHfTokenStatus must reuse cached ready state");

  failTokenNext = true;
  const failedToken = await pluginCache.refreshHfTokenStatus();
  assert.equal(failedToken.kind, "error");
  assert.equal(
    pluginCache.getState().hfToken.kind,
    "error",
    "keyring check failure must overwrite stale saved=true",
  );

  // 3. Preview cancel posts to `#82` cancel endpoint.
  await cancelPluginPreview(undefined, harness.client);
  assert.ok(
    harness.calls.some((c) => c.method === "POST" && c.path === "/api/plugins/previews/cancel"),
  );

  runsStore.dispose();
  pluginCache.dispose();
});

test("GGUF fetch planner avoids clearing on param changes, canRunPluginAgain guards disabled plugins, and stripAnsi handles OSC hyperlinks", () => {
  const keyA = buildGgufFitKey("unsloth/Qwen3-0.6B-GGUF", {
    accelerator: "T4",
    vramMib: null,
    ctx: 4096,
    quant: null,
    kv: null,
  });
  const keyB = buildGgufFitKey("unsloth/Qwen3-0.6B-GGUF", {
    accelerator: "A100",
    vramMib: null,
    ctx: 8192,
    quant: "Q4_K_M",
    kv: "q8_0",
  });

  assert.deepEqual(
    planGgufEstimateFetch({
      targetRepo: "unsloth/Qwen3-0.6B-GGUF",
      targetFitKey: keyA,
      currentKind: "ready",
      currentRepo: "unsloth/Qwen3-0.6B-GGUF",
      currentFitKey: keyA,
      forceRefresh: false,
    }),
    { action: "skip", showLoading: false, refresh: false },
  );

  assert.deepEqual(
    planGgufEstimateFetch({
      targetRepo: "unsloth/Qwen3-0.6B-GGUF",
      targetFitKey: keyB,
      currentKind: "ready",
      currentRepo: "unsloth/Qwen3-0.6B-GGUF",
      currentFitKey: keyA,
      forceRefresh: false,
    }),
    { action: "fetch", showLoading: false, refresh: false },
  );

  assert.deepEqual(
    planGgufEstimateFetch({
      targetRepo: "unsloth/Qwen3-0.6B-GGUF",
      targetFitKey: keyA,
      currentKind: "ready",
      currentRepo: "unsloth/Qwen3-0.6B-GGUF",
      currentFitKey: keyA,
      forceRefresh: true,
    }),
    { action: "fetch", showLoading: true, refresh: true },
  );

  assert.equal(canRunPluginAgain(makePlugin("llama-cpp", true), false), true);
  assert.equal(canRunPluginAgain(makePlugin("llama-cpp", false), false), false);
  assert.equal(canRunPluginAgain(makePlugin("llama-cpp", true), true), false);
  assert.equal(canRunPluginAgain(null, false), false);

  assert.equal(
    stripAnsi("\x1b[1;32mOK\x1b[0m \x9b31merr\x9b0m \x1b]8;;https://example.com\x1b\\open\x1b]8;;\x1b\\"),
    "OK err open",
  );
  assert.equal(stripAnsi("\x1b]0;window title\x07模型已就绪"), "模型已就绪");
});

test("replaying an already-finished ready run does not emit a stale Ready toast", async () => {
  const web = createFakeWebStore(makeSnapshot());
  const toast = createToastStore();
  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins/runs") {
      return [
        {
          id: 12,
          plugin: "llama-cpp",
          account: "acc-1",
          session: "old-run",
          provisions: true,
          finished: true,
          phase: "ready",
        } satisfies PluginRunSummary,
      ];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData: {} as AppDataStore,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast,
    t: (key) => key,
  });

  await runsStore.refreshPluginRuns({ autoAttach: false });
  assert.equal(runsStore.getState().knownPhasesById[12], "ready");

  runsStore.openPluginRun(12);
  const stream = harness.streams.get("/api/plugins/runs/12/events");
  assert.ok(stream);
  stream.emitFrame({
    event: "finished",
    data: JSON.stringify({
      phase: "ready",
      run: { plugin: "llama-cpp", account: "acc-1", session: "old-run", provisions: true },
      outcome: {
        session: "old-run",
        account: "acc-1",
        run_id: "r12",
        status: { state: "ready", stage: null, progress: null, message: null, outputs: {} },
      },
      endpoints: [],
      error: null,
    }),
    id: null,
  });
  stream.finish();
  await Promise.resolve();

  assert.equal(runsStore.getState().activeRun?.phase, "ready");
  assert.equal(runsStore.getState().activeRun?.finishedLive, false);
  assert.equal(toast.getToasts().length, 0);
  assert.equal(runsStore.hasToastedReadyRun(12), false);

  runsStore.dispose();
  pluginCache.dispose();
  toast.dispose();
});

test("verifyRunBilling waits for pre-finish /api/sessions to settle and fetches fresh post-finish sessions", async () => {
  const vmStillBilling = makeRuntime("acc-1", "gpu-leak");
  const web = createFakeWebStore(makeSnapshot({ version: 1 }));

  let sessionsRefreshing = true;
  let callCount = 0;
  let resolveStale!: (value: SessionsListResponse) => void;
  const stalePromise = new Promise<SessionsListResponse>((resolve) => {
    resolveStale = resolve;
  });

  const appData = {
    getState: () => ({ sessionsRefreshing }),
    refreshSessions: () => {
      callCount += 1;
      if (callCount === 1) {
        return stalePromise;
      }
      web.setSnapshot(
        makeSnapshot({ version: 2, runtimes: { runtimes: [vmStillBilling], errors: [] } }),
      );
      return Promise.resolve({
        account_context: { revision: 1, active: "acc-1" },
        sampled_at: 1_700_000_010,
        runtimes: [vmStillBilling],
        errors: [],
        guard: null,
        guard_error: null,
      } satisfies SessionsListResponse);
    },
  } as unknown as AppDataStore;

  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins/runs") {
      return [
        {
          id: 20,
          plugin: "llama-cpp",
          account: "acc-1",
          session: "gpu-leak",
          provisions: true,
          finished: true,
          phase: "failed",
        } satisfies PluginRunSummary,
      ];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast: createToastStore(),
    t: (key) => key,
  });

  await runsStore.refreshPluginRuns({ autoAttach: false });
  const verifyPromise = runsStore.verifyRunBilling(20);

  // Stale pre-finish request resolves empty (sampled before VM existed).
  sessionsRefreshing = false;
  resolveStale({
    account_context: { revision: 1, active: "acc-1" },
    sampled_at: 1_700_000_001,
    runtimes: [],
    errors: [],
    guard: null,
    guard_error: null,
  });

  const result = await verifyPromise;
  assert.equal(callCount, 2, "must issue a fresh post-finish /api/sessions call");
  assert.equal(result?.status, "verified");
  assert.equal(result?.runtime?.id.name, "gpu-leak");

  runsStore.dispose();
  pluginCache.dispose();
});

test("fast submitted run still emits Ready toast once even if /api/plugins/runs already returned finished=true", async () => {
  const web = createFakeWebStore(makeSnapshot());
  const toast = createToastStore();
  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins") {
      return [makePlugin("llama-cpp", true)];
    }
    if (path === "/api/plugins/runs") {
      return [
        {
          id: 42,
          plugin: "llama-cpp",
          account: "acc-1",
          session: "fast-run",
          provisions: false,
          finished: true,
          phase: "ready",
        } satisfies PluginRunSummary,
      ];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  await pluginCache.ensurePlugins();
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData: {} as AppDataStore,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast,
    t: (key, args) => `${key}:${String(args?.name ?? "")}`,
    getLocale: () => "en-US",
  });

  // Runs list already observed `finished: true, phase: "ready"` before submit 202 returned.
  await runsStore.refreshPluginRuns({ autoAttach: false });
  runsStore.openPluginRun(42, {
    id: 42,
    plugin: "llama-cpp",
    account: "acc-1",
    session: "fast-run",
    provisions: false,
    finished: false,
    phase: "running",
  });

  const stream = harness.streams.get("/api/plugins/runs/42/events");
  assert.ok(stream);
  stream.emitFrame({
    event: "finished",
    data: JSON.stringify({
      phase: "ready",
      run: { plugin: "llama-cpp", account: "acc-1", session: "fast-run", provisions: false },
      outcome: {
        session: "fast-run",
        account: "acc-1",
        run_id: "r42",
        status: { state: "ready", stage: null, progress: null, message: null, outputs: {} },
      },
      endpoints: [],
      error: null,
    }),
    id: null,
  });
  stream.finish();
  await Promise.resolve();

  assert.equal(toast.getToasts().length, 1);
  assert.equal(toast.getToasts()[0]?.body, "app.b2.run_ready_toast:llama.cpp");
  assert.equal(runsStore.hasToastedReadyRun(42), true);

  runsStore.dispose();
  pluginCache.dispose();
  toast.dispose();
});

test("volatile deploy secret stash survives React ref-detach-before-cleanup unmount and StrictMode remount, and wipes on close or logout", () => {
  const web = createFakeWebStore(makeSnapshot());
  const harness = createFakeClient(async () => []);
  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  const runsStore = createPluginRunsStore({
    client: harness.client,
    store: web.store,
    appData: {} as AppDataStore,
    forwards: makeFakeForwards().forwards,
    pluginCache,
    toast: createToastStore(),
    t: (key) => key,
  });

  runsStore.openPluginDeployForm("llama-cpp");
  const openSeq = runsStore.getState().formOpenSeq;

  // Simulate an uncontrolled masked <input> receiving user input (`onInput`),
  // then React detaching `ref(null)` BEFORE `useEffect` cleanup on unmount.
  const domRefs = new Map<string, { value: string }>();
  const mount1Input = { value: "" };
  domRefs.set("api_key", mount1Input);
  mount1Input.value = "sk-route-secret";
  runsStore.setStashedDeploySecret("llama-cpp", openSeq, "api_key", mount1Input.value);

  // Secrets must never appear in serialized store state / deployDraft.
  assert.equal(JSON.stringify(runsStore.getState()).includes("sk-route-secret"), false);

  // React unmount order: ref(null) deletes from Map before cleanup runs.
  domRefs.delete("api_key");
  assert.equal(domRefs.size, 0);

  // StrictMode double-mount / route return both restore the secret into the fresh DOM input.
  const firstRestore = runsStore.getStashedDeploySecrets("llama-cpp", openSeq);
  const secondRestore = runsStore.getStashedDeploySecrets("llama-cpp", openSeq);
  assert.equal(firstRestore?.get("api_key"), "sk-route-secret");
  assert.equal(secondRestore?.get("api_key"), "sk-route-secret");

  // Clearing input to empty removes it from stash; closing or logout wipes it unconditionally.
  runsStore.setStashedDeploySecret("llama-cpp", openSeq, "api_key", "");
  assert.equal(runsStore.getStashedDeploySecrets("llama-cpp", openSeq), null);

  runsStore.setStashedDeploySecret("llama-cpp", openSeq, "api_key", "sk-wiped");
  runsStore.closePluginDeployForm();
  assert.equal(runsStore.getStashedDeploySecrets("llama-cpp", openSeq), null);

  runsStore.openPluginDeployForm("llama-cpp");
  const openSeq2 = runsStore.getState().formOpenSeq;
  runsStore.setStashedDeploySecret("llama-cpp", openSeq2, "api_key", "sk-logout");
  harness.emitAuth({ type: "logged_out", generation: 2 });
  assert.equal(runsStore.getStashedDeploySecrets("llama-cpp", openSeq2), null);

  runsStore.dispose();
  pluginCache.dispose();
});

test("pluginCacheStore refreshes catalog after in-flight GET /api/plugins when cross-tab mutation completes mid-flight, and preview cancel respects op ownership", async () => {
  const web = createFakeWebStore(makeSnapshot({ version: 1 }));
  let enabledOnServer = true;
  let pluginListCalls = 0;
  let releaseMidFlightList: ((items: PluginInfo[]) => void) | null = null;

  const harness = createFakeClient(async (_method, path) => {
    if (path === "/api/plugins") {
      pluginListCalls += 1;
      if (pluginListCalls === 2) {
        return new Promise<PluginInfo[]>((resolve) => {
          releaseMidFlightList = resolve;
        });
      }
      return [makePlugin("llama-cpp", enabledOnServer)];
    }
    return [];
  });

  const pluginCache = createPluginCacheStore({ client: harness.client, store: web.store });
  await pluginCache.ensurePlugins();
  assert.equal(pluginCache.getPluginById("llama-cpp")?.enabled, true);

  // Start an in-flight refresh BEFORE the cross-tab mutation completes.
  const staleInFlight = pluginCache.refreshPlugins();
  assert.equal(pluginListCalls, 2);

  // While that older GET /api/plugins is still in flight, another tab disables `llama-cpp`.
  web.setSnapshot(
    makeSnapshot({
      version: 2,
      operations: [
        {
          id: 55,
          operation: { kind: "domain", name: "set_plugin_enabled", key: "llama-cpp" },
          cancelling: false,
        },
      ],
    }),
  );
  enabledOnServer = false;
  web.setSnapshot(makeSnapshot({ version: 3, operations: [] }));

  // Stale in-flight response resolves with `enabled: true`, triggering queued follow-up refresh.
  assert.ok(releaseMidFlightList);
  (releaseMidFlightList as (items: PluginInfo[]) => void)([makePlugin("llama-cpp", true)]);
  await staleInFlight;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(pluginListCalls, 3, "must issue follow-up refresh after stale in-flight settles");
  assert.equal(pluginCache.getPluginById("llama-cpp")?.enabled, false);

  // Preview cancel guard: Tab B observing Tab A's pre-existing `inspect_plugin` op must not send global cancel.
  const tabAOps = [
    {
      id: 77,
      operation: { kind: "domain", name: "inspect_plugin", key: "" } as const,
      cancelling: false,
    },
  ];
  assert.equal(findInspectPluginOpId(tabAOps), 77);
  assert.equal(shouldSendGlobalPreviewCancel(77, tabAOps), false);
  assert.equal(shouldSendGlobalPreviewCancel(null, tabAOps), true);
  assert.equal(shouldSendGlobalPreviewCancel(null, []), false);

  pluginCache.dispose();
});

test("resolvePluginRunBannerPhase reflects RunSummary.phase and getHfTokenBadgeMeta surfaces error states cleanly", () => {
  const t = (key: string) => key;

  assert.equal(
    resolvePluginRunBannerPhase({ phase: "running", finished: false }, undefined),
    "running",
  );
  assert.equal(
    resolvePluginRunBannerPhase({ phase: "ready", finished: true }, "running"),
    "ready",
  );
  assert.equal(
    resolvePluginRunBannerPhase({ phase: "failed", finished: true }, "running"),
    "failed",
  );
  assert.equal(
    resolvePluginRunBannerPhase({ phase: "cancelled", finished: true }, "running"),
    "cancelled",
  );
  assert.equal(
    resolvePluginRunBannerPhase({ phase: "running", finished: false }, "ready"),
    "ready",
  );

  assert.deepEqual(getHfTokenBadgeMeta({ kind: "idle" }, t), {
    status: "loading",
    className: "badge",
    text: "app.summary.unknown",
  });
  assert.deepEqual(getHfTokenBadgeMeta({ kind: "loading" }, t), {
    status: "loading",
    className: "badge",
    text: "app.summary.unknown",
  });
  assert.deepEqual(getHfTokenBadgeMeta({ kind: "ready", saved: true }, t), {
    status: "saved",
    className: "badge badge-success",
    text: "app.b2.hf_token_stored",
  });
  assert.deepEqual(getHfTokenBadgeMeta({ kind: "ready", saved: false }, t), {
    status: "none",
    className: "badge",
    text: "app.b2.hf_token_none",
  });
  assert.deepEqual(getHfTokenBadgeMeta({ kind: "error", error: new Error("keyring locked") }, t), {
    status: "error",
    className: "badge badge-warning",
    text: "app.b2.hf_token_unknown",
  });
});
