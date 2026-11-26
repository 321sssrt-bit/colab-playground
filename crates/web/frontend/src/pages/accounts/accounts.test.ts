import assert from "node:assert/strict";
import test, { after } from "node:test";

import { accountDialogsStore, createAccountDialogsStore } from "../../lib/accountDialogs.ts";
import { ApiError, type ApiClient, type AuthEvent } from "../../lib/api.ts";
import type { AppDataState } from "../../lib/appCache.ts";
import { buildUsageBadge, resolveActiveAccount } from "../../lib/format.ts";
import { i18nStore, type TranslateFn } from "../../lib/i18n.ts";

after(() => {
  accountDialogsStore.dispose();
  i18nStore.dispose();
});
import type { WebStore, WebStoreState } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Account, AccountsView, AccountUsageView, Snapshot, UsageSnapshot } from "../../lib/types.ts";
import {
  buildAccountRows,
  formatAccountTimeLeft,
  isServerLoginCancelling,
  type CancelLoginSettlement,
  type LoginPrompt,
} from "./model.ts";

const translate: TranslateFn = (key, args) => {
  if (!args || Object.keys(args).length === 0) {
    return key;
  }
  const suffix = Object.entries(args)
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
  return `${key}(${suffix})`;
};

function makeUsageSnapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    balance_cu: 10,
    rate_cu_per_hour: 2,
    assignments: 1,
    fetched_at: 1000,
    stale: false,
    ...overrides,
  };
}

function makeAccount(id: string, email: string, usage: UsageSnapshot | null = null): Account {
  return {
    id,
    email,
    created_at: 100,
    updated_at: 100,
    usage,
  };
}

function makeUsageView(
  account: string,
  email: string,
  overrides: Partial<AccountUsageView> = {},
): AccountUsageView {
  return {
    account,
    email,
    snapshot: makeUsageSnapshot(),
    eta: 18000,
    history: [],
    unmanaged_runtimes: 0,
    ownership_verified: true,
    session_rates: {},
    last_error: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const accounts: AccountsView = {
    accounts: [
      makeAccount("acct-1", "first@example.com"),
      makeAccount("acct-2", "second@example.com"),
    ],
    active: "acct-2",
    has_token: true,
    unadopted: false,
    active_email: "second@example.com",
    recovered_pending_add: false,
  };
  return {
    version: 1,
    server_now: 1050,
    backend: "mock",
    account: { revision: 1, active: "acct-2" },
    accounts,
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

interface RecordedRequest {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly signal?: AbortSignal;
}

function createHarness(initialSnapshot: Snapshot | null = makeSnapshot()) {
  let generation = 1;
  const authListeners = new Set<(event: AuthEvent) => void>();
  const storeListeners = new Set<() => void>();
  const requests: RecordedRequest[] = [];
  const toasts: ToastInput[] = [];
  let refreshCount = 0;

  let webState: WebStoreState = {
    authStatus: "authenticated",
    connectionStatus: "connected",
    snapshot: initialSnapshot,
    lastEventId: "1",
    reconnectAttempt: 0,
    nextRetryDelayMs: null,
    lastError: null,
    lastForwardEvent: null,
  };

  let appDataState: Pick<
    AppDataState,
    "overviewLoading" | "sessionsRefreshing" | "refreshingUsage" | "adopting"
  > = {
    overviewLoading: false,
    sessionsRefreshing: false,
    refreshingUsage: false,
    adopting: false,
  };

  let requestHandler: (
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => Promise<unknown> = async () => undefined;

  let refreshHandler: (signal?: AbortSignal) => Promise<Snapshot> = async () => {
    refreshCount += 1;
    return webState.snapshot ?? makeSnapshot();
  };

  const client = {
    isAuthenticated: () => true,
    getSessionGeneration: () => generation,
    subscribeAuth: (listener: (event: AuthEvent) => void) => {
      authListeners.add(listener);
      return () => {
        authListeners.delete(listener);
      };
    },
    request: async <T>(
      path: string,
      options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
    ): Promise<T> => {
      requests.push({
        path,
        method: options.method ?? "GET",
        body: options.body,
        signal: options.signal,
      });
      return (await requestHandler(path, options)) as T;
    },
  } as unknown as ApiClient;

  const store: WebStore = {
    getState: () => webState,
    subscribe: (listener) => {
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    },
    subscribeForwards: () => () => {},
    signIn: async () => {},
    signOut: () => {},
    refreshSnapshot: (signal?: AbortSignal) => refreshHandler(signal),
    reconnectNow: () => {},
    dispose: () => {},
  };

  const dialogStore = createAccountDialogsStore({
    client,
    store,
    appData: {
      getState: () => appDataState as AppDataState,
    },
    toast: {
      push: (item) => {
        toasts.push(item);
        return toasts.length;
      },
    },
    t: translate,
  });

  const pushSnapshot = (snapshot: Snapshot | null) => {
    webState = { ...webState, snapshot };
    for (const listener of storeListeners) {
      listener();
    }
  };

  const emitAuth = (type: "logged_out" | "unauthorized") => {
    generation += 1;
    const event: AuthEvent = { type, generation };
    for (const listener of authListeners) {
      listener(event);
    }
  };

  return {
    dialogStore,
    requests,
    toasts,
    getRefreshCount: () => refreshCount,
    setRequestHandler: (fn: typeof requestHandler) => {
      requestHandler = fn;
    },
    setRefreshHandler: (fn: typeof refreshHandler) => {
      refreshHandler = fn;
    },
    setAppDataState: (next: Partial<typeof appDataState>) => {
      appDataState = { ...appDataState, ...next };
    },
    pushSnapshot,
    emitAuth,
  };
}

test("buildAccountRows pins the active account first while preserving inactive order", () => {
  const accountsView: AccountsView = {
    accounts: [
      makeAccount("acct-1", "first@example.com"),
      makeAccount("acct-2", "second@example.com"),
      makeAccount("acct-3", "third@example.com"),
    ],
    active: "acct-2",
    has_token: true,
    unadopted: false,
    active_email: "second@example.com",
    recovered_pending_add: false,
  };
  const snapshot = makeSnapshot({ accounts: accountsView, account: { revision: 1, active: "acct-2" } });

  const rows = buildAccountRows(accountsView, snapshot, 1050, translate);
  assert.deepEqual(
    rows.map((row) => [row.account.id, row.active]),
    [
      ["acct-2", true],
      ["acct-1", false],
      ["acct-3", false],
    ],
  );
});

test("zero-balance idle account shows not burning without warning tone (both eta=null and core eta=0), while active depletion warns", () => {
  const zeroIdleSnap = makeUsageSnapshot({
    balance_cu: 0,
    rate_cu_per_hour: 0,
    assignments: 0,
    fetched_at: 1000,
    stale: false,
  });

  for (const eta of [null, 0] as const) {
    const zeroIdleUsage = makeUsageView("acct-2", "second@example.com", {
      snapshot: zeroIdleSnap,
      eta,
    });

    assert.equal(
      formatAccountTimeLeft(zeroIdleUsage, zeroIdleSnap, translate),
      "app.summary.not_burning",
    );
    assert.equal(formatAccountTimeLeft(null, zeroIdleSnap, translate), "app.summary.not_burning");

    const idleSnapshot = makeSnapshot({ usage: [zeroIdleUsage] });
    const idleActive = resolveActiveAccount(idleSnapshot, translate);
    const idleBadge = buildUsageBadge(idleActive, 1050, "en-US", translate);
    assert.equal(idleBadge.tone, "neutral");
    assert.equal(idleBadge.outdated, false);
    assert.ok(idleBadge.tooltip.startsWith("app.usage.tip.idle\n"));
  }

  const depletedSnap = makeUsageSnapshot({
    balance_cu: 0,
    rate_cu_per_hour: 2.5,
    assignments: 1,
    fetched_at: 1000,
    stale: false,
  });
  const depletedUsage = makeUsageView("acct-2", "second@example.com", {
    snapshot: depletedSnap,
    eta: 0,
  });

  assert.equal(formatAccountTimeLeft(depletedUsage, depletedSnap, translate), "app.summary.empty");
  assert.equal(formatAccountTimeLeft(null, depletedSnap, translate), "app.summary.empty");

  const depletedSnapshot = makeSnapshot({ usage: [depletedUsage] });
  const depletedActive = resolveActiveAccount(depletedSnapshot, translate);
  const depletedBadge = buildUsageBadge(depletedActive, 1050, "en-US", translate);
  assert.equal(depletedBadge.tone, "warning");
  assert.ok(depletedBadge.tooltip.startsWith("app.usage.tip.empty\n"));
});

test("AddAccountDialog intro watches multi-tab login_id and login operations", () => {
  const harness = createHarness();
  const { dialogStore } = harness;

  dialogStore.openAddAccount();
  assert.equal(dialogStore.getState().add.open, true);
  assert.deepEqual(dialogStore.getState().add.phase, { kind: "intro" });

  // Another tab creates a pending login prompt.
  harness.pushSnapshot(makeSnapshot({ version: 2, login_id: 77 }));
  assert.deepEqual(dialogStore.getState().add.phase, { kind: "other_active", loginId: 77 });

  // Prompt transitions to server-side submitting operation (login_id becomes null).
  harness.pushSnapshot(
    makeSnapshot({
      version: 3,
      login_id: null,
      operations: [{ id: 88, operation: { kind: "login", login_id: 77 }, cancelling: false }],
    }),
  );
  assert.deepEqual(dialogStore.getState().add.phase, { kind: "other_active", loginId: 77 });

  // Other tab's login settles and disappears -> returns to intro.
  harness.pushSnapshot(makeSnapshot({ version: 4, login_id: null, operations: [] }));
  assert.deepEqual(dialogStore.getState().add.phase, { kind: "intro" });

  dialogStore.dispose();
});

test("openAddAccount shows warning toast when blocked by non-login operation", () => {
  const harness = createHarness(
    makeSnapshot({
      operations: [{ id: 5, operation: { kind: "switch_account", to: "acct-1" }, cancelling: false }],
    }),
  );

  harness.dialogStore.openAddAccount();
  assert.equal(harness.dialogStore.getState().add.open, false);
  assert.deepEqual(harness.toasts, [{ tone: "warning", body: "app.b2.account_change_blocked" }]);

  harness.dialogStore.dispose();
});

test("cancelling AddAccountDialog during starting aborts own POST without deleting another tab's login", async () => {
  const harness = createHarness();
  const beginDeferred = createDeferred<LoginPrompt>();
  let beginAborted = false;

  harness.setRequestHandler((path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      options.signal?.addEventListener("abort", () => {
        beginAborted = true;
        beginDeferred.reject(
          new ApiError({ status: 0, kind: "cancelled", message: "aborted", isAbort: true }),
        );
      });
      return beginDeferred.promise;
    }
    return Promise.resolve(undefined);
  });

  harness.dialogStore.openAddAccount();
  const startPromise = harness.dialogStore.startAddLogin();
  assert.deepEqual(harness.dialogStore.getState().add.phase, { kind: "starting" });

  // Another tab's login operation appears in the shared snapshot before our POST returns.
  harness.pushSnapshot(
    makeSnapshot({
      version: 2,
      operations: [{ id: 55, operation: { kind: "login" }, cancelling: false }],
    }),
  );

  harness.dialogStore.cancelOrCloseAddAccount();
  assert.equal(beginAborted, true);
  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "cancelling",
    reopenIntroAfter: false,
  });

  // Esc/cancel while cancelling is ignored.
  harness.dialogStore.cancelOrCloseAddAccount();
  assert.equal(harness.dialogStore.getState().add.open, true);

  await startPromise;

  // Must NOT send DELETE using the shared snapshot's login id (55 could belong to another tab).
  assert.equal(
    harness.requests.some((req) => req.method === "DELETE"),
    false,
  );
  assert.equal(harness.dialogStore.getState().add.open, false);
  assert.deepEqual(harness.toasts, [{ tone: "info", body: "web.add.cancelled_notice" }]);

  harness.dialogStore.dispose();
});

test("409 busy conflict before SSE snapshot transitions to other_active without claiming rollback", async () => {
  const harness = createHarness();
  harness.setRequestHandler(async (path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      throw new ApiError({
        status: 409,
        kind: "busy",
        messageKey: "app.err.busy",
        message: "busy",
      });
    }
    return undefined;
  });

  harness.dialogStore.openAddAccount();
  await harness.dialogStore.startAddLogin();

  // Before the other tab's login snapshot arrives, busy failure does not claim rollback.
  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "failed",
    error: { message: "app.err.busy", hint: null },
    rolledBack: false,
    busyConflict: true,
  });

  // As soon as SSE delivers the other tab's login_id, the dialog automatically offers Cancel existing.
  harness.pushSnapshot(makeSnapshot({ version: 2, login_id: 88 }));
  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "other_active",
    loginId: 88,
  });

  harness.dialogStore.dispose();
});

test("409 busy ignores a stale deduplicated refreshSnapshot return value once SSE delivers active login", async () => {
  const staleV1 = makeSnapshot({ version: 1, login_id: null, operations: [] });
  const harness = createHarness(staleV1);
  const refreshDeferred = createDeferred<Snapshot>();

  harness.setRequestHandler(async (path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      throw new ApiError({
        status: 409,
        kind: "busy",
        messageKey: "app.err.busy",
        message: "busy",
      });
    }
    return undefined;
  });
  harness.setRefreshHandler(() => refreshDeferred.promise);

  harness.dialogStore.openAddAccount();
  const startPromise = harness.dialogStore.startAddLogin();
  await Promise.resolve();

  // SSE delivers the other tab's active login (v2) before the older deduplicated snapshot (v1) resolves.
  harness.pushSnapshot(makeSnapshot({ version: 2, login_id: 89 }));
  refreshDeferred.resolve(staleV1);
  await startPromise;

  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "other_active",
    loginId: 89,
  });

  harness.dialogStore.dispose();
});

test("submitting transport drop stays locked even when deduplicated refreshSnapshot returns an older pre-login snapshot", async () => {
  const staleV1 = makeSnapshot({ version: 1, login_id: null, operations: [] });
  const harness = createHarness(staleV1);
  const submitDeferred = createDeferred<Account>();
  let refreshCalls = 0;

  harness.setRequestHandler((path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      harness.pushSnapshot(makeSnapshot({ version: 2, login_id: 95 }));
      return Promise.resolve({ id: 95, auth_url: "https://accounts.google.com/o/oauth2/auth" });
    }
    if (path === "/api/accounts/login/95" && options.method === "POST") {
      return submitDeferred.promise;
    }
    return Promise.resolve(undefined);
  });

  harness.dialogStore.openAddAccount();
  await harness.dialogStore.startAddLogin();
  const submitPromise = harness.dialogStore.submitAddLoginCode("auth-code-drop");

  // SSE already moved the store to v3 with the running login operation, while an older
  // deduplicated refreshSnapshot call resolves with stale v1 (no login_id / no operations).
  const inFlightSubmitSnapshot = makeSnapshot({
    version: 3,
    login_id: null,
    operations: [{ id: 101, operation: { kind: "login", login_id: 95 }, cancelling: false }],
  });
  harness.pushSnapshot(inFlightSubmitSnapshot);
  harness.setRefreshHandler(async () => {
    refreshCalls += 1;
    return refreshCalls === 1 ? staleV1 : inFlightSubmitSnapshot;
  });

  submitDeferred.reject(
    new ApiError({
      status: 0,
      kind: "connection_lost",
      message: "network drop",
    }),
  );
  await submitPromise;

  // Dialog MUST remain locked in submitting despite stale v1 returning first from refreshSnapshot.
  assert.equal(refreshCalls, 2);
  assert.equal(harness.dialogStore.getState().add.open, true);
  assert.equal(harness.dialogStore.getState().add.phase.kind, "submitting");
  harness.dialogStore.cancelOrCloseAddAccount();
  assert.equal(harness.dialogStore.getState().add.open, true);

  // Server completes the sign-in and broadcasts the newly added active account.
  harness.pushSnapshot(
    makeSnapshot({
      version: 4,
      login_id: null,
      operations: [],
      account: { revision: 2, active: "acct-3" },
      accounts: {
        accounts: [
          makeAccount("acct-1", "first@example.com"),
          makeAccount("acct-2", "second@example.com"),
          makeAccount("acct-3", "recovered-submit@example.com"),
        ],
        active: "acct-3",
        has_token: true,
        unadopted: false,
        active_email: "recovered-submit@example.com",
        recovered_pending_add: false,
      },
    }),
  );

  assert.equal(harness.dialogStore.getState().add.open, false);
  assert.deepEqual(harness.toasts, [
    { tone: "success", body: "app.add.done(email=recovered-submit@example.com)" },
  ]);

  harness.dialogStore.dispose();
});

test("AddAccountDialog locks cancel during submitting and reflects server cancelling state", async () => {
  const harness = createHarness();
  const submitDeferred = createDeferred<Account>();

  harness.setRequestHandler((path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      harness.pushSnapshot(makeSnapshot({ version: 2, login_id: 91 }));
      return Promise.resolve({ id: 91, auth_url: "https://accounts.google.com/o/oauth2/auth" });
    }
    if (path === "/api/accounts/login/91" && options.method === "POST") {
      return submitDeferred.promise;
    }
    return Promise.resolve(undefined);
  });

  harness.dialogStore.openAddAccount();
  await harness.dialogStore.startAddLogin();
  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "code",
    loginId: 91,
    authUrl: "https://accounts.google.com/o/oauth2/auth",
  });

  const submitPromise = harness.dialogStore.submitAddLoginCode("auth-code-xyz");
  assert.deepEqual(harness.dialogStore.getState().add.phase, {
    kind: "submitting",
    loginId: 91,
    authUrl: "https://accounts.google.com/o/oauth2/auth",
  });

  // Cancel / Esc during submitting is strictly ignored and does not send DELETE.
  harness.dialogStore.cancelOrCloseAddAccount();
  assert.equal(harness.dialogStore.getState().add.open, true);
  assert.equal(harness.dialogStore.getState().add.phase.kind, "submitting");
  assert.equal(
    harness.requests.some((req) => req.method === "DELETE"),
    false,
  );

  // Server marking the login operation as cancelling is exposed to UI.
  const cancellingSnapshot = makeSnapshot({
    version: 3,
    operations: [{ id: 99, operation: { kind: "login", login_id: 91 }, cancelling: true }],
  });
  assert.equal(isServerLoginCancelling(cancellingSnapshot, 91), true);

  submitDeferred.resolve(makeAccount("acct-3", "new@example.com"));
  await submitPromise;

  assert.equal(harness.dialogStore.getState().add.open, false);
  assert.deepEqual(harness.toasts, [
    { tone: "success", body: "app.add.done(email=new@example.com)" },
  ]);

  harness.dialogStore.dispose();
});

test("DELETE /api/accounts/login/{id} consumes 200 settled completed, failed, and cancelled outcomes", async () => {
  // Outcome 1: completed -> success toast and closes dialog.
  {
    const harness = createHarness(makeSnapshot({ login_id: 12 }));
    harness.setRequestHandler(async (path, options) => {
      if (path === "/api/accounts/login/12" && options.method === "DELETE") {
        return {
          outcome: "completed",
          account: makeAccount("acct-3", "committed@example.com"),
        } satisfies CancelLoginSettlement;
      }
      return undefined;
    });

    harness.dialogStore.openAddAccount();
    assert.deepEqual(harness.dialogStore.getState().add.phase, { kind: "other_active", loginId: 12 });
    await harness.dialogStore.cancelExistingLogin();

    assert.equal(harness.dialogStore.getState().add.open, false);
    assert.deepEqual(harness.toasts, [
      { tone: "success", body: "app.add.done(email=committed@example.com)" },
    ]);
    harness.dialogStore.dispose();
  }

  // Outcome 2: failed -> transitions to failed phase with error message and rolledBack flag.
  {
    const harness = createHarness(makeSnapshot({ login_id: 13 }));
    harness.setRequestHandler(async (path, options) => {
      if (path === "/api/accounts/login/13" && options.method === "DELETE") {
        return {
          outcome: "failed",
          error: {
            kind: "login_invalid_code",
            message_key: "app.err.login_invalid_code",
            args: {},
            hint_key: null,
            action_key: null,
            operation_id: null,
          },
        } satisfies CancelLoginSettlement;
      }
      return undefined;
    });

    harness.dialogStore.openAddAccount();
    await harness.dialogStore.cancelExistingLogin();

    assert.equal(harness.dialogStore.getState().add.open, true);
    assert.deepEqual(harness.dialogStore.getState().add.phase, {
      kind: "failed",
      error: { message: "app.err.login_invalid_code", hint: null },
      rolledBack: true,
    });
    harness.dialogStore.dispose();
  }

  // Outcome 3: cancelled -> info toast and reopens intro.
  {
    const harness = createHarness(makeSnapshot({ login_id: 14 }));
    harness.setRequestHandler(async (path, options) => {
      if (path === "/api/accounts/login/14" && options.method === "DELETE") {
        return { outcome: "cancelled" } satisfies CancelLoginSettlement;
      }
      return undefined;
    });

    harness.dialogStore.openAddAccount();
    await harness.dialogStore.cancelExistingLogin();

    assert.equal(harness.dialogStore.getState().add.open, true);
    assert.deepEqual(harness.dialogStore.getState().add.phase, { kind: "intro" });
    assert.deepEqual(harness.toasts, [{ tone: "info", body: "web.add.cancelled_notice" }]);
    harness.dialogStore.dispose();
  }
});

test("RemoveAccountDialog controller preserves in-flight removal and delivers completion toast globally", async () => {
  const harness = createHarness();
  const deleteDeferred = createDeferred<void>();

  harness.setRequestHandler((path, options) => {
    if (path === "/api/accounts/acct-1" && options.method === "DELETE") {
      return deleteDeferred.promise;
    }
    return Promise.resolve(undefined);
  });

  harness.dialogStore.openRemoveAccount({ id: "acct-1", emailLabel: "first@example.com" });
  assert.equal(harness.dialogStore.getState().remove.target?.id, "acct-1");

  const confirmPromise = harness.dialogStore.confirmRemoveAccount();
  assert.equal(harness.dialogStore.getState().remove.removing, true);

  // Close attempts while removing are ignored.
  harness.dialogStore.closeRemoveAccount();
  assert.equal(harness.dialogStore.getState().remove.target?.id, "acct-1");

  // Even if the account disappears from a snapshot mid-flight, completion toast still fires.
  harness.pushSnapshot(
    makeSnapshot({
      version: 2,
      accounts: {
        accounts: [makeAccount("acct-2", "second@example.com")],
        active: "acct-2",
        has_token: true,
        unadopted: false,
        active_email: "second@example.com",
        recovered_pending_add: false,
      },
    }),
  );

  deleteDeferred.resolve(undefined);
  await confirmPromise;

  assert.equal(harness.dialogStore.getState().remove.target, null);
  assert.equal(harness.dialogStore.getState().remove.removing, false);
  assert.deepEqual(harness.toasts, [
    { tone: "success", body: "app.remove.done(email=first@example.com)" },
  ]);

  harness.dialogStore.dispose();
});

test("dismissRecoveredPendingAdd calls backend endpoint, hides banner, and re-arms if server clears", async () => {
  const recoveredAccounts: AccountsView = {
    accounts: [makeAccount("acct-2", "second@example.com")],
    active: "acct-2",
    has_token: true,
    unadopted: false,
    active_email: "second@example.com",
    recovered_pending_add: true,
  };
  const harness = createHarness(makeSnapshot({ accounts: recoveredAccounts }));

  await harness.dialogStore.dismissRecoveredPendingAdd();
  assert.equal(harness.dialogStore.getState().recoveredDismissed, true);
  assert.equal(
    harness.requests.some(
      (req) => req.method === "POST" && req.path === "/api/accounts/recovered/dismiss",
    ),
    true,
  );
  assert.equal(harness.getRefreshCount(), 1);

  // Once server broadcasts recovered_pending_add: false, local suppression resets cleanly.
  harness.pushSnapshot(
    makeSnapshot({
      version: 2,
      accounts: { ...recoveredAccounts, recovered_pending_add: false },
    }),
  );
  assert.equal(harness.dialogStore.getState().recoveredDismissed, false);

  // A failure to dismiss restores visibility so the user can retry.
  harness.pushSnapshot(makeSnapshot({ version: 3, accounts: recoveredAccounts }));
  harness.setRequestHandler(async () => {
    throw new ApiError({ status: 500, kind: "other", message: "boom" });
  });
  await harness.dialogStore.dismissRecoveredPendingAdd();
  assert.equal(harness.dialogStore.getState().recoveredDismissed, false);

  harness.dialogStore.dispose();
});

test("cancelling during starting rolls back a racing prompt and logout resets dialogs", async () => {
  const harness = createHarness();
  const beginDeferred = createDeferred<LoginPrompt>();

  harness.setRequestHandler((path, options) => {
    if (path === "/api/accounts/login" && options.method === "POST") {
      return beginDeferred.promise;
    }
    return Promise.resolve(undefined);
  });

  harness.dialogStore.openAddAccount();
  const startPromise = harness.dialogStore.startAddLogin();
  // User cancels before snapshot has a starting operation, and POST races to resolve.
  harness.dialogStore.cancelOrCloseAddAccount();
  beginDeferred.resolve({ id: 66, auth_url: "https://accounts.google.com/o/oauth2/auth" });
  await startPromise;

  assert.equal(
    harness.requests.some((req) => req.method === "DELETE" && req.path === "/api/accounts/login/66"),
    true,
  );
  assert.equal(harness.dialogStore.getState().add.open, false);

  // Opening a remove dialog and emitting logout resets all dialog state.
  harness.dialogStore.openRemoveAccount({ id: "acct-1", emailLabel: "first@example.com" });
  assert.equal(harness.dialogStore.getState().remove.target?.id, "acct-1");
  harness.emitAuth("logged_out");
  assert.equal(harness.dialogStore.getState().remove.target, null);

  harness.dialogStore.dispose();
});
