/**
 * Global Cost Guard observer, backend event acknowledgement (`POST /api/sessions/guard/ack`),
 * pending user-stop coordination, and Ended recently history store.
 *
 * Mirrors upstream `crates/app/src/state/sessions.rs` (`apply_guard` + `record_ended`)
 * at application scope so Cost Guard warnings, automatic stops, still-billing stop
 * failures, and vanished runtimes remain persistent and visible on every route.
 */

import { apiClient, type ApiClient } from "./api.ts";
import { formatCu, formatDuration } from "./format.ts";
import { i18nStore, type I18nStore, type TranslateFn } from "./i18n.ts";
import { webStore, type WebStore } from "./store.ts";
import { toastStore, type ToastStore } from "./toast.ts";
import type {
  AccountId,
  Concern,
  CoreError,
  EndedRuntime,
  ErrorKind,
  GuardEvent,
  Limit,
  Locale,
  Runtime,
  RuntimeRef,
  Snapshot,
} from "./types.ts";

const ENDED_LIMIT = 20;

const LIMIT_NAME_KEYS: Readonly<Record<Limit, string>> = {
  runtime: "app.b2.limit_runtime",
  spend: "app.b2.limit_spend",
  balance: "app.b2.limit_balance",
};

const CORE_ERROR_KIND_KEYS: Readonly<Record<ErrorKind, string>> = {
  not_installed: "app.err.not_installed",
  auth_required: "app.err.auth_required",
  not_entitled: "app.err.not_entitled",
  capacity_refused: "app.err.capacity_refused",
  allocation_timeout: "app.err.allocation_timeout",
  ssh_busy: "app.err.ssh_busy",
  session_gone: "app.err.session_gone",
  connection_lost: "app.err.connection_lost",
  exec_timeout: "app.err.exec_timeout",
  port_in_use: "app.err.port_in_use",
  port_reserved: "app.err.port_reserved",
  invalid_input: "app.err.invalid_input",
  no_active_account: "app.err.no_active_account",
  active_account_not_adopted: "app.err.active_not_adopted",
  account_not_active: "app.err.account_not_active",
  account_not_found: "app.err.account_not_found",
  keyring_unavailable: "app.err.keyring_unavailable",
  add_in_progress: "app.err.add_in_progress",
  legacy_token_present: "app.err.legacy_token",
  login_cancelled: "app.err.login_cancelled",
  login_invalid_code: "app.err.login_invalid_code",
  login_verification_failed: "app.err.login_unverified",
  cancelled: "app.err.cancelled",
  unsupported: "app.err.unsupported",
  wsl_unavailable: "app.err.wsl_unavailable",
  command_too_long: "app.err.command_too_long",
  session_limit_reached: "app.err.session_limit",
  busy: "app.err.busy",
  data_dir_in_use: "app.err.data_dir_in_use",
  provision_exhausted: "app.err.provision_exhausted",
  orphan_suspected: "app.err.orphan_suspected",
  manifest_invalid: "app.err.manifest_invalid",
  plugin_exists: "app.err.plugin_exists",
  plugin_not_found: "app.err.plugin_not_found",
  plugin_run_failed: "app.err.plugin_run_failed",
  health_check_failed: "app.err.health_check_failed",
  git_failed: "app.err.git_failed",
  install_failed: "app.err.install_failed",
  http: "app.err.http",
  http_unavailable: "app.err.http_unavailable",
  rate_limited: "app.b7.err_rate_limited",
  parse: "app.err.parse",
  io: "app.err.io",
  timeout: "app.err.timeout",
  unsupported_cli_version: "app.err.unsupported_cli",
  update_unverified: "app.b12.err_update_unverified",
  update_unavailable: "app.b12.err_update_unavailable",
  other: "app.err.other",
};

export interface GuardState {
  readonly ended: readonly EndedRuntime[];
  readonly reconcileSeq: number;
}

export interface GuardStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly toast?: ToastStore;
  readonly i18n?: Pick<I18nStore, "getState" | "subscribe" | "t">;
}

export interface GuardStore {
  getState(): GuardState;
  subscribe(listener: () => void): () => void;
  beginUserStop(target: RuntimeRef): () => void;
  beginStopAll(): () => void;
  recordEndedRuntime(entry: Omit<EndedRuntime, "at"> & { readonly at?: number | null }): void;
  clearEndedRuntimes(): void;
  dispose(): void;
}

interface TrackedGuardToast {
  readonly toastId: number;
  readonly eventIds: Set<number>;
  readonly kind: "warn" | "stopped" | "stop_failed";
  readonly rtKey: string;
}

export function guardRuntimeKey(ref: RuntimeRef): string {
  return `${ref.account}/${ref.endpoint}`;
}

/**
 * Returns true when live account data is unavailable or the OS keyring is locked,
 * so the shell immediately collapses any signed-in sidebar account menu.
 */
export function isKeyringLockedOrAccountsMissing(snapshot: Snapshot | null): boolean {
  return (
    snapshot === null ||
    snapshot.accounts === null ||
    snapshot.accounts_error === "keyring_unavailable"
  );
}

function formatGuardConcern(concern: Concern, locale: Locale, t: TranslateFn): string {
  if (concern.kind === "usage_unknown") {
    return t("app.b2.guard_unknown", { limit: t(LIMIT_NAME_KEYS[concern.limit]) });
  }
  if (concern.limit === "runtime") {
    return t("app.b2.guard_runtime", {
      current: formatDuration(concern.current, t),
      limit: formatDuration(concern.threshold, t),
    });
  }
  if (concern.limit === "spend") {
    const current = formatCu(concern.current, locale, t);
    return t("app.b2.guard_spend", {
      current: concern.estimated ? `≈ ${current}` : current,
      limit: formatCu(concern.threshold, locale, t),
    });
  }
  return t("app.b2.guard_balance", {
    current: formatCu(concern.current, locale, t),
    limit: formatCu(concern.threshold, locale, t),
  });
}

function formatGuardConcerns(
  concerns: readonly Concern[],
  locale: Locale,
  t: TranslateFn,
): string {
  return concerns.map((item) => formatGuardConcern(item, locale, t)).join("; ");
}

function formatCoreErrorText(error: CoreError | null | undefined, t: TranslateFn): string {
  if (!error) {
    return t("app.err.other");
  }
  const key = CORE_ERROR_KIND_KEYS[error.kind] ?? "app.err.other";
  const text = t(key, error.params);
  return text || t("app.err.other");
}

function hasLimitConcern(concerns: readonly Concern[]): boolean {
  return concerns.some((item) => item.kind === "limit");
}

function sameLimitKinds(a: readonly Concern[], b: readonly Concern[]): boolean {
  const limitsA = a.filter((item) => item.kind === "limit");
  const limitsB = b.filter((item) => item.kind === "limit");
  if (limitsA.length !== limitsB.length) {
    return false;
  }
  return limitsA.every((item, idx) => item.limit === limitsB[idx]?.limit);
}

function runtimeCardLabel(runtime: Runtime): string {
  const name = runtime.id.name?.trim();
  return name && name.length > 0 ? name : runtime.hardware;
}

const INITIAL_STATE: GuardState = {
  ended: [],
  reconcileSeq: 0,
};

/**
 * Creates an isolated global Cost Guard observer and Ended recently store.
 */
export function createGuardStore(options: GuardStoreOptions = {}): GuardStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const toast = options.toast ?? toastStore;
  const i18n = options.i18n ?? i18nStore;

  let disposed = false;
  let state: GuardState = INITIAL_STATE;

  let seenEventIds = new Set<number>();
  let trackedToasts = new Set<TrackedGuardToast>();
  let activeStopFailureToasts = new Map<string, TrackedGuardToast>();
  let activeWarnToasts = new Map<string, TrackedGuardToast>();
  // Mirrors upstream `SessionsState.warnings` and `stop_failures` per runtime so
  // ongoing failures across poll rounds toast once rather than spamming every tick.
  let activeWarnings = new Map<string, readonly Concern[]>();
  let activeStopFailures = new Set<string>();
  let fallbackStoppedKeys = new Set<string>();
  let seenVanishedKeys = new Set<string>();
  let userStoppedKeys = new Set<string>();
  let clearedBackendEndedKeys = new Set<string>();
  let pendingUserStopCounts = new Map<string, number>();
  let pendingStopAllCount = 0;
  let deferredPendingKeys = new Set<string>();
  let lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
  let prevSnapshot: Snapshot | null = null;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all consumers converge.
      }
    }
  };

  const setState = (patch: Partial<GuardState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const isStopPending = (key: string): boolean =>
    pendingStopAllCount > 0 || pendingUserStopCounts.has(key);

  const ackEventIds = (ids: readonly number[]): void => {
    if (disposed || ids.length === 0 || !client.isAuthenticated()) {
      return;
    }
    const unique = Array.from(new Set(ids));
    void client
      .request<void>("/api/sessions/guard/ack", {
        method: "POST",
        body: { ids: unique },
      })
      .catch(() => {
        // Leave server event intact if ack fails transiently; local seenEventIds prevents spam.
      });
  };

  const untrackToast = (tracked: TrackedGuardToast): void => {
    trackedToasts.delete(tracked);
    if (tracked.kind === "stop_failed" && activeStopFailureToasts.get(tracked.rtKey) === tracked) {
      activeStopFailureToasts.delete(tracked.rtKey);
    }
    if (tracked.kind === "warn" && activeWarnToasts.get(tracked.rtKey) === tracked) {
      activeWarnToasts.delete(tracked.rtKey);
    }
  };

  const recordEnded = (entry: EndedRuntime, opts?: { fromBackend?: boolean }): void => {
    const key = guardRuntimeKey(entry.runtime);
    if (key) {
      deferredPendingKeys.delete(key);
    }
    if (entry.reason.kind === "user" && key) {
      userStoppedKeys.add(key);
      seenVanishedKeys.add(key);
    }
    if (opts?.fromBackend && key && clearedBackendEndedKeys.has(key)) {
      return;
    }
    if (!opts?.fromBackend && key) {
      clearedBackendEndedKeys.delete(key);
    }
    const existing = state.ended.find((item) => guardRuntimeKey(item.runtime) === key);
    if (existing && existing.reason.kind === "guard" && entry.reason.kind !== "guard") {
      return;
    }
    if (existing && entry.reason.kind === "vanished" && existing.reason.kind !== "vanished") {
      return;
    }
    if (
      existing &&
      existing.reason.kind === entry.reason.kind &&
      existing.label === entry.label &&
      existing.email === entry.email
    ) {
      return;
    }
    const filtered = state.ended.filter((item) => guardRuntimeKey(item.runtime) !== key);
    setState({ ended: [entry, ...filtered].slice(0, ENDED_LIMIT) });
  };

  const lookupRuntimeInfo = (
    ref: RuntimeRef,
    snapshot: Snapshot,
  ): { readonly label: string; readonly email: string | null } => {
    const key = guardRuntimeKey(ref);
    const nextRuntimes = snapshot.runtimes?.runtimes ?? [];
    const prevRuntimes = prevSnapshot?.runtimes?.runtimes ?? [];
    const accounts = snapshot.accounts?.accounts ?? prevSnapshot?.accounts?.accounts ?? [];
    let matched =
      nextRuntimes.find((rt) => guardRuntimeKey(rt.id) === key) ??
      prevRuntimes.find((rt) => guardRuntimeKey(rt.id) === key);
    if (!matched) {
      matched = lastKnownRuntimesByAccount
        .get(ref.account)
        ?.find((rt) => guardRuntimeKey(rt.id) === key);
    }
    const acct = accounts.find((a) => a.id === ref.account);
    return {
      label: matched ? runtimeCardLabel(matched) : (ref.name ?? ref.endpoint),
      email: matched?.account_email ?? acct?.email ?? null,
    };
  };

  const syncOkDecisions = (snapshot: Snapshot): void => {
    const decisions = snapshot.guard?.decisions;
    if (!decisions) {
      return;
    }
    for (const item of decisions) {
      if (item.decision.decision === "ok") {
        const rtKey = guardRuntimeKey(item.session);
        activeWarnings.delete(rtKey);
        activeStopFailures.delete(rtKey);
      }
    }
  };

  const consumeGuardEvent = (
    event: GuardEvent,
    locale: Locale,
    t: TranslateFn,
    immediateAckIds: number[],
    handledRuntimeKeys: Set<string>,
  ): void => {
    const rtKey = guardRuntimeKey(event.session);
    const label = event.label || event.session.name || event.session.endpoint;

    if (event.kind === "vanished") {
      if (isStopPending(rtKey)) {
        deferredPendingKeys.add(rtKey);
        return;
      }
      handledRuntimeKeys.add(rtKey);
      activeWarnings.delete(rtKey);
      activeStopFailures.delete(rtKey);
      if (seenEventIds.has(event.id)) {
        return;
      }
      seenEventIds.add(event.id);
      immediateAckIds.push(event.id);
      if (userStoppedKeys.has(rtKey) || seenVanishedKeys.has(rtKey)) {
        return;
      }
      seenVanishedKeys.add(rtKey);
      recordEnded({
        runtime: event.session,
        label,
        email: event.email,
        reason: { kind: "vanished" },
        at: event.at,
      });
      toast.push({
        tone: "info",
        title: t("app.b2.vanished_title", { name: label }),
        body: t("app.b2.ended_vanished"),
      });
      return;
    }

    if (seenEventIds.has(event.id)) {
      if (event.kind === "stopped") {
        handledRuntimeKeys.add(rtKey);
      }
      return;
    }
    seenEventIds.add(event.id);

    if (event.kind === "warn") {
      const previous = activeWarnings.get(rtKey) ?? [];
      activeWarnings.set(rtKey, event.concerns);
      // Upstream `apply_guard` only toasts when at least one `Limit` concern is active and changed.
      if (!hasLimitConcern(event.concerns)) {
        immediateAckIds.push(event.id);
        return;
      }
      if (sameLimitKinds(event.concerns, previous)) {
        const existingToast = activeWarnToasts.get(rtKey);
        if (existingToast) {
          existingToast.eventIds.add(event.id);
        } else {
          immediateAckIds.push(event.id);
        }
        return;
      }
      const eventIds = new Set<number>([event.id]);
      let tracked: TrackedGuardToast | null = null;
      const toastId = toast.push({
        tone: "warning",
        title: t("app.b2.guard_warn_title", { name: label }),
        body: formatGuardConcerns(event.concerns, locale, t),
        durationMs: null,
        onDismiss: () => {
          if (tracked) {
            untrackToast(tracked);
          }
          ackEventIds(Array.from(eventIds));
        },
      });
      if (toastId > 0) {
        tracked = { toastId, eventIds, kind: "warn", rtKey };
        trackedToasts.add(tracked);
        activeWarnToasts.set(rtKey, tracked);
      }
      return;
    }

    if (event.kind === "stopped") {
      handledRuntimeKeys.add(rtKey);
      activeWarnings.delete(rtKey);
      activeStopFailures.delete(rtKey);
      recordEnded({
        runtime: event.session,
        label,
        email: event.email,
        reason: { kind: "guard", concern: event.concern },
        at: event.at,
      });
      const eventIds = new Set<number>([event.id]);
      let tracked: TrackedGuardToast | null = null;
      const toastId = toast.push({
        tone: "danger",
        title: t("app.b2.guard_stopped_title", { name: label }),
        body: formatGuardConcern(event.concern, locale, t),
        durationMs: null,
        onDismiss: () => {
          if (tracked) {
            untrackToast(tracked);
          }
          ackEventIds(Array.from(eventIds));
        },
      });
      if (toastId > 0) {
        tracked = { toastId, eventIds, kind: "stopped", rtKey };
        trackedToasts.add(tracked);
      }
      return;
    }

    if (event.kind === "stop_failed") {
      // Upstream only raises one persistent toast per ongoing stop failure for a runtime.
      if (activeStopFailures.has(rtKey)) {
        const existingToast = activeStopFailureToasts.get(rtKey);
        if (existingToast) {
          existingToast.eventIds.add(event.id);
        } else {
          immediateAckIds.push(event.id);
        }
        return;
      }
      activeStopFailures.add(rtKey);
      const errorText = formatCoreErrorText(event.error, t);
      const eventIds = new Set<number>([event.id]);
      let tracked: TrackedGuardToast | null = null;
      const toastId = toast.push({
        tone: "danger",
        title: t("app.b2.guard_stop_failed_title", { name: label }),
        body: errorText || t("app.b2.guard_still_billing"),
        durationMs: null,
        onDismiss: () => {
          if (tracked) {
            untrackToast(tracked);
          }
          ackEventIds(Array.from(eventIds));
        },
      });
      if (toastId > 0) {
        tracked = { toastId, eventIds, kind: "stop_failed", rtKey };
        trackedToasts.add(tracked);
        activeStopFailureToasts.set(rtKey, tracked);
      }
    }
  };

  const consumeFallbackReport = (
    snapshot: Snapshot,
    locale: Locale,
    t: TranslateFn,
    handledRuntimeKeys: Set<string>,
  ): void => {
    const report = snapshot.guard;
    if (!report) {
      return;
    }
    for (const item of report.decisions) {
      const rtKey = guardRuntimeKey(item.session);
      const info = lookupRuntimeInfo(item.session, snapshot);
      if (item.decision.decision === "ok") {
        activeWarnings.delete(rtKey);
        activeStopFailures.delete(rtKey);
        continue;
      }
      if (item.decision.decision === "warn") {
        const concerns = item.decision.concerns;
        const previous = activeWarnings.get(rtKey) ?? [];
        if (hasLimitConcern(concerns) && !sameLimitKinds(concerns, previous)) {
          toast.push({
            tone: "warning",
            title: t("app.b2.guard_warn_title", { name: info.label }),
            body: formatGuardConcerns(concerns, locale, t),
            durationMs: null,
          });
        }
        activeWarnings.set(rtKey, concerns);
        continue;
      }
      const concern = item.decision.concerns;
      if (item.stopped) {
        handledRuntimeKeys.add(rtKey);
        activeWarnings.delete(rtKey);
        activeStopFailures.delete(rtKey);
        const eventKey = `${rtKey}:${concern.kind}:${concern.limit}`;
        if (fallbackStoppedKeys.has(eventKey)) {
          continue;
        }
        fallbackStoppedKeys.add(eventKey);
        recordEnded({
          runtime: item.session,
          label: info.label,
          email: info.email,
          reason: { kind: "guard", concern },
          at: snapshot.server_now ?? null,
        });
        toast.push({
          tone: "danger",
          title: t("app.b2.guard_stopped_title", { name: info.label }),
          body: formatGuardConcern(concern, locale, t),
          durationMs: null,
        });
      } else if (!activeStopFailures.has(rtKey)) {
        activeStopFailures.add(rtKey);
        const body = item.error
          ? formatCoreErrorText(item.error, t)
          : t("app.b2.guard_still_billing");
        toast.push({
          tone: "danger",
          title: t("app.b2.guard_stop_failed_title", { name: info.label }),
          body,
          durationMs: null,
        });
      }
    }

    for (const ref of report.vanished) {
      const rtKey = guardRuntimeKey(ref);
      if (isStopPending(rtKey)) {
        deferredPendingKeys.add(rtKey);
        continue;
      }
      handledRuntimeKeys.add(rtKey);
      activeWarnings.delete(rtKey);
      activeStopFailures.delete(rtKey);
      if (userStoppedKeys.has(rtKey) || seenVanishedKeys.has(rtKey)) {
        continue;
      }
      seenVanishedKeys.add(rtKey);
      const info = lookupRuntimeInfo(ref, snapshot);
      recordEnded({
        runtime: ref,
        label: info.label,
        email: info.email,
        reason: { kind: "vanished" },
        at: snapshot.server_now ?? null,
      });
      toast.push({
        tone: "info",
        title: t("app.b2.vanished_title", { name: info.label }),
        body: t("app.b2.ended_vanished"),
      });
    }
  };

  const processSnapshot = (snapshot: Snapshot | null): void => {
    if (disposed || !snapshot) {
      return;
    }
    const i18nState = i18n.getState();
    // Wait until the i18n dictionary is loaded so persistent toasts never render empty strings.
    if (i18nState.dict === null) {
      return;
    }
    const { locale } = i18nState;
    const t = i18n.t;

    const handledRuntimeKeys = new Set<string>();
    const immediateAckIds: number[] = [];

    if (Array.isArray(snapshot.ended)) {
      // Sync authoritative backend ended list (oldest-to-newest so newest ends up first).
      for (let i = snapshot.ended.length - 1; i >= 0; i -= 1) {
        const entry = snapshot.ended[i];
        if (entry) {
          recordEnded(entry, { fromBackend: true });
        }
      }
    }

    if (Array.isArray(snapshot.guard_events)) {
      syncOkDecisions(snapshot);
      const liveEventIds = new Set<number>();
      for (const event of snapshot.guard_events) {
        liveEventIds.add(event.id);
        consumeGuardEvent(event, locale, t, immediateAckIds, handledRuntimeKeys);
      }
      // Keep multiple browser tabs synchronized when another tab dismisses & acks an event.
      for (const tracked of Array.from(trackedToasts)) {
        const anyStillLive = Array.from(tracked.eventIds).some((id) => liveEventIds.has(id));
        if (!anyStillLive) {
          untrackToast(tracked);
          toast.dismiss(tracked.toastId, { notify: false });
        }
      }
      if (immediateAckIds.length > 0) {
        ackEventIds(immediateAckIds);
      }
    } else {
      consumeFallbackReport(snapshot, locale, t, handledRuntimeKeys);
    }

    const nextRuntimes = snapshot.runtimes?.runtimes ?? [];
    const accounts = snapshot.accounts?.accounts ?? prevSnapshot?.accounts?.accounts ?? [];
    const hasAccountsList = snapshot.accounts !== null;
    const savedAccounts = new Set(accounts.map((a) => a.id));
    if (hasAccountsList) {
      for (const accountId of lastKnownRuntimesByAccount.keys()) {
        if (!savedAccounts.has(accountId)) {
          lastKnownRuntimesByAccount.delete(accountId);
        }
      }
    }

    if (snapshot.runtimes && snapshot.runtimes_error === null) {
      const erroredAccounts = new Set(snapshot.runtimes.errors.map((e) => e.account));
      const liveKeysAll = new Set(nextRuntimes.map((rt) => guardRuntimeKey(rt.id)));
      const belongsToErroredAccount = (key: string): boolean => {
        const slash = key.indexOf("/");
        return slash > 0 && erroredAccounts.has(key.slice(0, slash));
      };
      for (const key of Array.from(activeWarnings.keys())) {
        if (!liveKeysAll.has(key) && !belongsToErroredAccount(key)) {
          activeWarnings.delete(key);
        }
      }
      for (const key of Array.from(activeStopFailures)) {
        if (!liveKeysAll.has(key) && !belongsToErroredAccount(key)) {
          activeStopFailures.delete(key);
        }
      }

      const nextByAccount = new Map<AccountId, Runtime[]>();
      for (const rt of nextRuntimes) {
        const list = nextByAccount.get(rt.id.account);
        if (list) {
          list.push(rt);
        } else {
          nextByAccount.set(rt.id.account, [rt]);
        }
      }

      const accountsToCompare = new Set<AccountId>([
        ...savedAccounts,
        ...nextByAccount.keys(),
      ]);
      for (const accountId of accountsToCompare) {
        if (erroredAccounts.has(accountId)) {
          continue;
        }
        const nextList = nextByAccount.get(accountId) ?? [];
        const prevList = lastKnownRuntimesByAccount.get(accountId);
        const retainedForAccount: Runtime[] = [];
        if (prevList !== undefined) {
          const liveKeys = new Set(nextList.map((rt) => guardRuntimeKey(rt.id)));
          for (const prevRt of prevList) {
            const rtKey = guardRuntimeKey(prevRt.id);
            if (
              liveKeys.has(rtKey) ||
              handledRuntimeKeys.has(rtKey) ||
              userStoppedKeys.has(rtKey) ||
              seenVanishedKeys.has(rtKey)
            ) {
              continue;
            }
            if (isStopPending(rtKey)) {
              deferredPendingKeys.add(rtKey);
              retainedForAccount.push(prevRt);
              continue;
            }
            seenVanishedKeys.add(rtKey);
            const label = runtimeCardLabel(prevRt);
            recordEnded({
              runtime: prevRt.id,
              label,
              email:
                prevRt.account_email ??
                accounts.find((a) => a.id === prevRt.id.account)?.email ??
                null,
              reason: { kind: "vanished" },
              at: snapshot.server_now ?? null,
            });
            toast.push({
              tone: "info",
              title: t("app.b2.vanished_title", { name: label }),
              body: t("app.b2.ended_vanished"),
            });
          }
        }
        lastKnownRuntimesByAccount.set(
          accountId,
          retainedForAccount.length > 0 ? [...nextList, ...retainedForAccount] : nextList,
        );
      }
    }

    prevSnapshot = snapshot;
  };

  const flushReleasedDeferredKeys = (): void => {
    let hasUnblocked = false;
    for (const key of Array.from(deferredPendingKeys)) {
      if (!isStopPending(key)) {
        deferredPendingKeys.delete(key);
        hasUnblocked = true;
      }
    }
    if (hasUnblocked) {
      setState({ reconcileSeq: state.reconcileSeq + 1 });
      processSnapshot(store.getState().snapshot);
    }
  };

  const reset = (): void => {
    seenEventIds = new Set<number>();
    trackedToasts = new Set<TrackedGuardToast>();
    activeStopFailureToasts = new Map<string, TrackedGuardToast>();
    activeWarnToasts = new Map<string, TrackedGuardToast>();
    activeWarnings = new Map<string, readonly Concern[]>();
    activeStopFailures = new Set<string>();
    fallbackStoppedKeys = new Set<string>();
    seenVanishedKeys = new Set<string>();
    userStoppedKeys = new Set<string>();
    clearedBackendEndedKeys = new Set<string>();
    pendingUserStopCounts = new Map<string, number>();
    pendingStopAllCount = 0;
    deferredPendingKeys = new Set<string>();
    lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
    prevSnapshot = null;
    if (state.ended.length > 0 || state.reconcileSeq !== 0) {
      state = INITIAL_STATE;
      emit();
    }
  };

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (
      event.type === "logged_out" ||
      event.type === "unauthorized" ||
      event.type === "authenticated"
    ) {
      reset();
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    processSnapshot(store.getState().snapshot);
  });

  const unsubscribeI18n = i18n.subscribe(() => {
    if (i18n.getState().dict !== null) {
      processSnapshot(store.getState().snapshot);
    }
  });

  processSnapshot(store.getState().snapshot);

  return {
    getState(): GuardState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    beginUserStop(target: RuntimeRef): () => void {
      const key = guardRuntimeKey(target);
      const gen = client.getSessionGeneration();
      let released = false;
      if (key) {
        pendingUserStopCounts.set(key, (pendingUserStopCounts.get(key) ?? 0) + 1);
      }
      return () => {
        if (released || !key || client.getSessionGeneration() !== gen) {
          return;
        }
        released = true;
        const remaining = (pendingUserStopCounts.get(key) ?? 0) - 1;
        if (remaining <= 0) {
          pendingUserStopCounts.delete(key);
        } else {
          pendingUserStopCounts.set(key, remaining);
        }
        flushReleasedDeferredKeys();
      };
    },

    beginStopAll(): () => void {
      const gen = client.getSessionGeneration();
      let released = false;
      pendingStopAllCount += 1;
      return () => {
        if (released || client.getSessionGeneration() !== gen) {
          return;
        }
        released = true;
        pendingStopAllCount = Math.max(0, pendingStopAllCount - 1);
        flushReleasedDeferredKeys();
      };
    },

    recordEndedRuntime(entry: Omit<EndedRuntime, "at"> & { readonly at?: number | null }): void {
      recordEnded({
        runtime: entry.runtime,
        label: entry.label,
        email: entry.email,
        reason: entry.reason,
        at: entry.at ?? null,
      });
    },

    clearEndedRuntimes(): void {
      for (const item of state.ended) {
        clearedBackendEndedKeys.add(guardRuntimeKey(item.runtime));
      }
      if (state.ended.length === 0) {
        return;
      }
      setState({ ended: [] });
    },

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      unsubscribeStore();
      unsubscribeI18n();
      listeners.clear();
    },
  };
}

/** Shared global Cost Guard observer and Ended recently store. */
export const guardStore: GuardStore = createGuardStore();
