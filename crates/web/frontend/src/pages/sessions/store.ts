/**
 * Session-scoped client state for Recently ended history, server-validated
 * Forward addresses (merged onto authoritative live `snapshot.tunnels`), and
 * the default rearm duration from Settings.
 *
 * Resets automatically when the Bearer auth session ends or rotates.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError } from "../../lib/api.ts";
import {
  CORE_DEFAULTS,
  MIN_CONCURRENT_SESSIONS,
  START_MAX_RUNTIME_SECS,
} from "../../lib/constants.ts";
import { forwardsStore } from "../../lib/forwards.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type {
  AccountContext,
  AccountId,
  ApiErrorPayload,
  Concern,
  ForwardView,
  Locale,
  Runtime,
  RuntimeRef,
  Snapshot,
} from "../../lib/types.ts";
import {
  fetchSettings,
  openProvisionEventStream,
  type ProvisionOutcome,
  type ProvisionProgressEvent,
} from "./api.ts";
import { formatConcern, formatRuntimeCardLabel, runtimeKey } from "./format.ts";
import { parseFinishedEvent, parseProvisionEvent } from "./ProvisionProgress.tsx";

const ENDED_LIMIT = 20;
const PROVISION_RECONNECT_BASE_MS = 1000;
const PROVISION_RECONNECT_MAX_MS = 5000;
const PROVISION_RECONNECT_MAX_EXP = 3;

export interface SessionSettingsSummary {
  readonly rearmDurationSecs: number;
  readonly maxConcurrentSessions: number;
}

export interface TrackedProvision {
  readonly operationId: number;
  readonly sessionName: string;
  readonly accountContext: AccountContext | null;
  readonly events: readonly ProvisionProgressEvent[];
  readonly waitingAttempt: number | null;
  readonly waitingSinceMs: number | null;
  readonly phase: "running" | "ready" | "cancelled" | "failed";
  readonly outcome: ProvisionOutcome | null;
  readonly finishedError: ApiErrorPayload | null;
  readonly reconnecting: boolean;
}

type EndReason =
  | { readonly kind: "user" }
  | { readonly kind: "guard"; readonly concern: Concern }
  | { readonly kind: "vanished" };

export interface EndedRuntime {
  readonly runtime: RuntimeRef;
  readonly label: string;
  readonly email: string | null;
  readonly reason: EndReason;
}

interface SessionsLocalState {
  readonly ended: readonly EndedRuntime[];
  readonly rearmDurationSecs: number;
  readonly maxConcurrentSessions: number;
  readonly reconcileSeq: number;
  readonly trackedProvision: TrackedProvision | null;
}

const INITIAL_STATE: SessionsLocalState = {
  ended: [],
  rearmDurationSecs: START_MAX_RUNTIME_SECS,
  maxConcurrentSessions: CORE_DEFAULTS.max_concurrent_sessions,
  reconcileSeq: 0,
  trackedProvision: null,
};

let state: SessionsLocalState = INITIAL_STATE;
let seenGuardStoppedKeys = new Set<string>();
let seenVanishedKeys = new Set<string>();
let pendingUserStopCounts = new Map<string, number>();
let pendingStopAllCount = 0;
let deferredPendingKeys = new Set<string>();
let lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
let settingsLoaded = false;
let settingsInFlight: Promise<SessionSettingsSummary> | null = null;
let provisionStreamController: AbortController | null = null;
let provisionReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let provisionStreamSeq = 0;
let handledProvisionIds = new Set<number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Isolate subscriber exceptions so all Sessions consumers converge cleanly.
    }
  }
}

function setState(patch: Partial<SessionsLocalState>): void {
  state = { ...state, ...patch };
  emit();
}

function stopProvisionStream(): void {
  provisionStreamSeq += 1;
  if (provisionReconnectTimer !== null) {
    clearTimeout(provisionReconnectTimer);
    provisionReconnectTimer = null;
  }
  if (provisionStreamController !== null) {
    provisionStreamController.abort();
    provisionStreamController = null;
  }
}

function resetLocalState(): void {
  stopProvisionStream();
  handledProvisionIds = new Set<number>();
  seenGuardStoppedKeys = new Set<string>();
  seenVanishedKeys = new Set<string>();
  pendingUserStopCounts = new Map<string, number>();
  pendingStopAllCount = 0;
  deferredPendingKeys = new Set<string>();
  lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
  settingsLoaded = false;
  settingsInFlight = null;
  state = INITIAL_STATE;
  emit();
}

function connectProvisionStream(
  operationId: number,
  seq: number,
  gen: number,
  attempt: number,
): void {
  const isCurrent = (): boolean =>
    seq === provisionStreamSeq &&
    apiClient.getSessionGeneration() === gen &&
    state.trackedProvision?.operationId === operationId &&
    state.trackedProvision.phase === "running";

  if (!isCurrent()) {
    return;
  }

  const controller = new AbortController();
  provisionStreamController = controller;
  const replayed: ProvisionProgressEvent[] = [];
  let sawFinished = false;

  const scheduleReconnect = () => {
    if (!isCurrent()) {
      return;
    }
    const cur = state.trackedProvision;
    if (cur) {
      setState({ trackedProvision: { ...cur, reconnecting: true } });
    }
    const delayMs = Math.min(
      PROVISION_RECONNECT_MAX_MS,
      PROVISION_RECONNECT_BASE_MS * 2 ** Math.min(attempt, PROVISION_RECONNECT_MAX_EXP),
    );
    provisionReconnectTimer = setTimeout(() => {
      provisionReconnectTimer = null;
      connectProvisionStream(operationId, seq, gen, attempt + 1);
    }, delayMs);
  };

  void openProvisionEventStream(operationId, {
    signal: controller.signal,
    onOpen: () => {
      if (!isCurrent()) {
        return;
      }
      const cur = state.trackedProvision;
      if (cur?.reconnecting) {
        setState({ trackedProvision: { ...cur, reconnecting: false } });
      }
    },
    onFrame: (frame) => {
      if (!isCurrent()) {
        return;
      }
      const cur = state.trackedProvision;
      if (!cur) {
        return;
      }
      if (frame.event === "progress") {
        const parsed = parseProvisionEvent(frame.data);
        if (!parsed) {
          return;
        }
        replayed.push(parsed);
        // Backend replays from cursor 0 on reconnect; keep the longer list so UI never flickers.
        const nextEvents = replayed.length >= cur.events.length ? [...replayed] : cur.events;
        const last = nextEvents.length > 0 ? nextEvents[nextEvents.length - 1] : null;
        let waitingAttempt = cur.waitingAttempt;
        let waitingSinceMs = cur.waitingSinceMs;
        if (last?.event === "allocating") {
          if (cur.waitingAttempt !== last.attempt || cur.waitingSinceMs === null) {
            waitingAttempt = last.attempt;
            waitingSinceMs = Date.now();
          }
        } else {
          waitingAttempt = null;
          waitingSinceMs = null;
        }
        setState({
          trackedProvision: {
            ...cur,
            events: nextEvents,
            waitingAttempt,
            waitingSinceMs,
            reconnecting: false,
          },
        });
      } else if (frame.event === "finished") {
        const finished = parseFinishedEvent(frame.data);
        if (!finished) {
          return;
        }
        sawFinished = true;
        const baseEvents = replayed.length >= cur.events.length ? [...replayed] : [...cur.events];
        if (finished.phase === "ready" && finished.outcome) {
          const readyEvent: ProvisionProgressEvent = {
            event: "ready",
            name: finished.outcome.name,
            gpu: finished.outcome.hardware?.gpu ?? null,
            vram_mib: finished.outcome.hardware?.vram_mib ?? null,
            below_spec: Boolean(finished.outcome.below_spec),
          };
          if (!baseEvents.some((item) => item.event === "ready")) {
            baseEvents.push(readyEvent);
          }
        }
        if (provisionStreamController === controller) {
          provisionStreamController = null;
        }
        setState({
          trackedProvision: {
            ...cur,
            events: baseEvents,
            waitingAttempt: null,
            waitingSinceMs: null,
            phase: finished.phase,
            outcome: finished.outcome ?? null,
            finishedError: finished.error ?? null,
            reconnecting: false,
          },
        });
      }
    },
  })
    .then(() => {
      if (provisionStreamController === controller) {
        provisionStreamController = null;
      }
      if (!controller.signal.aborted && !sawFinished) {
        scheduleReconnect();
      }
    })
    .catch((error: unknown) => {
      if (provisionStreamController === controller) {
        provisionStreamController = null;
      }
      if (controller.signal.aborted || sawFinished || !isCurrent()) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (error instanceof ApiError && error.kind === "provision_not_found") {
        const cur = state.trackedProvision;
        if (cur) {
          setState({
            trackedProvision: {
              ...cur,
              waitingAttempt: null,
              waitingSinceMs: null,
              phase: "failed",
              finishedError: {
                kind: error.kind,
                message_key: error.messageKey ?? "app.err.other",
                args: error.args,
                hint_key: error.hintKey,
                action_key: error.actionKey,
                operation_id: null,
              },
              reconnecting: false,
            },
          });
        }
        return;
      }
      scheduleReconnect();
    });
}

/**
 * Ensures a single session-scoped SSE subscription tracks `operationId` until its
 * `finished` frame arrives, surviving dialog hide/show toggles, snapshot operation
 * removal ahead of journal completion, and transient network disconnects.
 */
export function trackProvision(
  operationId: number,
  sessionName: string,
  accountContext?: AccountContext | null,
): void {
  const existing = state.trackedProvision;
  if (existing && existing.operationId === operationId) {
    const nextName = sessionName && existing.sessionName !== sessionName ? sessionName : existing.sessionName;
    const nextAccountContext =
      existing.accountContext === null && accountContext ? accountContext : existing.accountContext;
    if (nextName !== existing.sessionName || nextAccountContext !== existing.accountContext) {
      setState({
        trackedProvision: {
          ...existing,
          sessionName: nextName,
          accountContext: nextAccountContext,
        },
      });
    }
    return;
  }
  stopProvisionStream();
  const seq = provisionStreamSeq;
  const gen = apiClient.getSessionGeneration();
  setState({
    trackedProvision: {
      operationId,
      sessionName,
      accountContext: accountContext ?? null,
      events: [],
      waitingAttempt: null,
      waitingSinceMs: null,
      phase: "running",
      outcome: null,
      finishedError: null,
      reconnecting: false,
    },
  });
  connectProvisionStream(operationId, seq, gen, 0);
}

/**
 * Claims one-time completion handling for `operationId` so returning to `#/sessions`
 * never replays an already-delivered ready, failed, or cancelled toast.
 */
export function claimProvisionHandled(operationId: number): boolean {
  if (handledProvisionIds.has(operationId)) {
    return false;
  }
  handledProvisionIds.add(operationId);
  return true;
}

apiClient.subscribeAuth((event) => {
  if (event.type === "logged_out" || event.type === "unauthorized") {
    resetLocalState();
  }
});

function isStopPending(key: string): boolean {
  return pendingStopAllCount > 0 || pendingUserStopCounts.has(key);
}

function flushReleasedDeferredKeys(): void {
  let hasUnblocked = false;
  for (const key of deferredPendingKeys) {
    if (!isStopPending(key)) {
      deferredPendingKeys.delete(key);
      hasUnblocked = true;
    }
  }
  if (hasUnblocked) {
    setState({ reconcileSeq: state.reconcileSeq + 1 });
  }
}

/**
 * Suppresses generic "vanished" notifications while a user-initiated stop for `target`
 * is in flight, since SSE broadcasts the updated runtime list before the HTTP response returns.
 */
export function beginUserStop(target: RuntimeRef): () => void {
  const key = runtimeKey(target);
  const gen = apiClient.getSessionGeneration();
  let released = false;
  if (key) {
    pendingUserStopCounts.set(key, (pendingUserStopCounts.get(key) ?? 0) + 1);
  }
  return () => {
    if (released || !key || apiClient.getSessionGeneration() !== gen) {
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
}

/**
 * Suppresses generic "vanished" notifications while a user-initiated Stop all is in flight.
 */
export function beginStopAll(): () => void {
  const gen = apiClient.getSessionGeneration();
  let released = false;
  pendingStopAllCount += 1;
  return () => {
    if (released || apiClient.getSessionGeneration() !== gen) {
      return;
    }
    released = true;
    pendingStopAllCount = Math.max(0, pendingStopAllCount - 1);
    flushReleasedDeferredKeys();
  };
}

export function recordEndedRuntime(entry: EndedRuntime): void {
  const key = runtimeKey(entry.runtime);
  if (key) {
    deferredPendingKeys.delete(key);
  }
  if (entry.reason.kind === "user" && key) {
    // Prevent later SSE/Guard vanished checks from replaying a vanished toast for a user stop.
    seenVanishedKeys.add(key);
  }
  const existing = state.ended.find((item) => runtimeKey(item.runtime) === key);
  // Keep a specific guard reason intact, and keep user/guard reasons over later generic vanished checks.
  if (existing && existing.reason.kind === "guard" && entry.reason.kind !== "guard") {
    return;
  }
  if (existing && entry.reason.kind === "vanished" && existing.reason.kind !== "vanished") {
    return;
  }
  const filtered = state.ended.filter((item) => runtimeKey(item.runtime) !== key);
  setState({ ended: [entry, ...filtered].slice(0, ENDED_LIMIT) });
}

export function clearEndedRuntimes(): void {
  if (state.ended.length === 0) {
    return;
  }
  setState({ ended: [] });
}

/**
 * Caches server-validated addresses immediately from a `POST /api/forwards` response
 * in the global `forwardsStore`.
 */
export function recordForwardAddresses(view: ForwardView): void {
  forwardsStore.recordForward(view);
}

export function refreshForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  return forwardsStore.refresh(signal);
}

export function ensureRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary> {
  if (settingsLoaded) {
    return Promise.resolve({
      rearmDurationSecs: state.rearmDurationSecs,
      maxConcurrentSessions: state.maxConcurrentSessions,
    });
  }
  return refreshRearmDuration(signal);
}

export function refreshRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary> {
  if (settingsInFlight) {
    return settingsInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const promise = fetchSettings(signal)
    .then((settings) => {
      const configuredRearm = settings.defaults?.max_runtime;
      const rearmDurationSecs =
        typeof configuredRearm === "number" &&
        Number.isFinite(configuredRearm) &&
        configuredRearm > 0
          ? Math.floor(configuredRearm)
          : START_MAX_RUNTIME_SECS;
      const configuredMaxConcurrent = settings.defaults?.max_concurrent_sessions;
      const maxConcurrentSessions =
        typeof configuredMaxConcurrent === "number" &&
        Number.isFinite(configuredMaxConcurrent) &&
        configuredMaxConcurrent >= MIN_CONCURRENT_SESSIONS
          ? Math.floor(configuredMaxConcurrent)
          : CORE_DEFAULTS.max_concurrent_sessions;
      if (apiClient.getSessionGeneration() === gen) {
        settingsLoaded = true;
        if (
          state.rearmDurationSecs !== rearmDurationSecs ||
          state.maxConcurrentSessions !== maxConcurrentSessions
        ) {
          setState({ rearmDurationSecs, maxConcurrentSessions });
        }
      }
      return { rearmDurationSecs, maxConcurrentSessions };
    })
    .catch(() => ({
      rearmDurationSecs: state.rearmDurationSecs,
      maxConcurrentSessions: state.maxConcurrentSessions,
    }))
    .finally(() => {
      if (settingsInFlight === promise) {
        settingsInFlight = null;
      }
    });
  settingsInFlight = promise;
  return promise;
}

/**
 * Observes Guard reports and runtime list removals across snapshots, deduplicating
 * per runtime event so new events never replay earlier notifications and manual
 * refreshes that reconcile the ledger ahead of a Guard round still record vanished
 * runtimes into Recently ended.
 */
export function observeSnapshotTransitions(
  prevSnapshot: Snapshot | null,
  nextSnapshot: Snapshot | null,
  locale: Locale,
  t: TranslateFn,
  pushToast: (toast: ToastInput) => number,
): void {
  if (!nextSnapshot) {
    return;
  }

  const prevRuntimes = prevSnapshot?.runtimes?.runtimes ?? [];
  const nextRuntimes = nextSnapshot.runtimes?.runtimes ?? [];
  const accounts = nextSnapshot.accounts?.accounts ?? prevSnapshot?.accounts?.accounts ?? [];
  const lookupInfo = (ref: RuntimeRef): { label: string; email: string | null } => {
    const key = runtimeKey(ref);
    let matched = prevRuntimes.find((rt) => runtimeKey(rt.id) === key);
    if (!matched) {
      const baseline = lastKnownRuntimesByAccount.get(ref.account);
      matched = baseline?.find((rt) => runtimeKey(rt.id) === key);
    }
    const acct = accounts.find((a) => a.id === ref.account);
    return {
      label: matched ? formatRuntimeCardLabel(matched) : (ref.name ?? ref.endpoint),
      email: matched?.account_email ?? acct?.email ?? null,
    };
  };

  const guardHandledRuntimeKeys = new Set<string>();
  const report = nextSnapshot.guard;
  if (report) {
    for (const item of report.decisions) {
      if (item.decision.decision !== "stop" || !item.stopped) {
        continue;
      }
      const rtKey = runtimeKey(item.session);
      guardHandledRuntimeKeys.add(rtKey);
      const concern = item.decision.concerns;
      const eventKey = `${rtKey}:${concern.kind}:${concern.limit}`;
      if (seenGuardStoppedKeys.has(eventKey)) {
        continue;
      }
      seenGuardStoppedKeys.add(eventKey);
      const info = lookupInfo(item.session);
      recordEndedRuntime({
        runtime: item.session,
        label: info.label,
        email: info.email,
        reason: { kind: "guard", concern },
      });
      pushToast({
        tone: "danger",
        title: t("app.b2.guard_stopped_title", { name: info.label }),
        body: formatConcern(concern, locale, t),
      });
    }

    for (const ref of report.vanished) {
      const rtKey = runtimeKey(ref);
      if (isStopPending(rtKey)) {
        deferredPendingKeys.add(rtKey);
        continue;
      }
      guardHandledRuntimeKeys.add(rtKey);
      if (seenVanishedKeys.has(rtKey)) {
        continue;
      }
      seenVanishedKeys.add(rtKey);
      const info = lookupInfo(ref);
      recordEndedRuntime({
        runtime: ref,
        label: info.label,
        email: info.email,
        reason: { kind: "vanished" },
      });
      pushToast({
        tone: "info",
        title: t("app.b2.vanished_title", { name: info.label }),
        body: t("app.b2.ended_vanished"),
      });
    }
  }

  // Keep each account's last successful runtime list so a transient per-account
  // listing error does not drop the baseline needed to detect vanished runtimes
  // when a subsequent manual refresh reconciles the ledger ahead of a Guard round.
  const hasAccountsList = nextSnapshot.accounts !== null;
  const savedAccounts = new Set(accounts.map((a) => a.id));
  if (hasAccountsList) {
    for (const accountId of lastKnownRuntimesByAccount.keys()) {
      if (!savedAccounts.has(accountId)) {
        lastKnownRuntimesByAccount.delete(accountId);
      }
    }
  }

  if (nextSnapshot.runtimes && nextSnapshot.runtimes_error === null) {
    const erroredAccounts = new Set(nextSnapshot.runtimes.errors.map((e) => e.account));
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
        const liveKeys = new Set(nextList.map((rt) => runtimeKey(rt.id)));
        for (const prevRt of prevList) {
          const rtKey = runtimeKey(prevRt.id);
          if (
            liveKeys.has(rtKey) ||
            guardHandledRuntimeKeys.has(rtKey) ||
            seenVanishedKeys.has(rtKey)
          ) {
            continue;
          }
          if (isStopPending(rtKey)) {
            // Keep the baseline intact until the in-flight stop settles so a failed or dropped
            // response still reconciles any already-stopped runtime into Recently ended.
            deferredPendingKeys.add(rtKey);
            retainedForAccount.push(prevRt);
            continue;
          }
          seenVanishedKeys.add(rtKey);
          const label = formatRuntimeCardLabel(prevRt);
          recordEndedRuntime({
            runtime: prevRt.id,
            label,
            email:
              prevRt.account_email ??
              accounts.find((a) => a.id === prevRt.id.account)?.email ??
              null,
            reason: { kind: "vanished" },
          });
          pushToast({
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
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SessionsLocalState {
  return state;
}

export function useSessionsLocalState(): SessionsLocalState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
