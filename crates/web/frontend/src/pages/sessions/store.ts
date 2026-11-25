/**
 * Session-scoped client state for Recently ended history, server-validated
 * Forward addresses (merged onto authoritative live `snapshot.tunnels`), and
 * the default rearm duration from Settings.
 *
 * Resets automatically when the Bearer auth session ends or rotates.
 */

import { useSyncExternalStore } from "react";

import { apiClient } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type {
  AccountId,
  Concern,
  Locale,
  Runtime,
  RuntimeRef,
  Snapshot,
  TunnelEvent,
  TunnelInfo,
  TunnelState,
} from "../../lib/types.ts";
import {
  fetchForwards,
  fetchSettings,
  type ForwardAddresses,
  type ForwardView,
} from "./api.ts";
import { formatConcern, formatRuntimeCardLabel, runtimeKey } from "./format.ts";

export const DEFAULT_REARM_SECS = 7200;
const ENDED_LIMIT = 20;

export type EndReason =
  | { readonly kind: "user" }
  | { readonly kind: "guard"; readonly concern: Concern }
  | { readonly kind: "vanished" };

export interface EndedRuntime {
  readonly runtime: RuntimeRef;
  readonly label: string;
  readonly email: string | null;
  readonly reason: EndReason;
}

interface ForwardLiveOverlay {
  readonly snapshotVersion: number;
  readonly state?: TunnelState;
  readonly healthy?: boolean | null;
}

export interface SessionsLocalState {
  readonly ended: readonly EndedRuntime[];
  readonly forwardAddressesById: Readonly<Record<number, ForwardAddresses>>;
  readonly forwardOverlaysById: Readonly<Record<number, ForwardLiveOverlay>>;
  readonly rearmDurationSecs: number;
  readonly cliInstalled: boolean | null;
}

const INITIAL_STATE: SessionsLocalState = {
  ended: [],
  forwardAddressesById: {},
  forwardOverlaysById: {},
  rearmDurationSecs: DEFAULT_REARM_SECS,
  cliInstalled: null,
};

let state: SessionsLocalState = INITIAL_STATE;
let seenGuardStoppedKeys = new Set<string>();
let seenVanishedKeys = new Set<string>();
let lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
let latestSnapshotVersion = 0;
let forwardsInFlight: Promise<ForwardView[]> | null = null;
let settingsInFlight: Promise<number> | null = null;
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

function resetLocalState(): void {
  seenGuardStoppedKeys = new Set<string>();
  seenVanishedKeys = new Set<string>();
  lastKnownRuntimesByAccount = new Map<AccountId, readonly Runtime[]>();
  latestSnapshotVersion = 0;
  forwardsInFlight = null;
  settingsInFlight = null;
  state = INITIAL_STATE;
  emit();
}

apiClient.subscribeAuth((event) => {
  if (event.type === "logged_out" || event.type === "unauthorized") {
    resetLocalState();
  }
});

export function recordEndedRuntime(entry: EndedRuntime): void {
  const key = runtimeKey(entry.runtime);
  const existing = state.ended.find((item) => runtimeKey(item.runtime) === key);
  // Keep a specific user/guard reason if a later generic vanished check sees the same runtime.
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

export function setCliInstalledHint(installed: boolean): void {
  if (state.cliInstalled === installed) {
    return;
  }
  setState({ cliInstalled: installed });
}

/**
 * Applies a live `forward` SSE transition over the current snapshot version.
 * Newer snapshots supersede any overlay from an older snapshot version.
 */
export function applyForwardEvent(event: TunnelEvent): void {
  const prev = state.forwardOverlaysById[event.id];
  const base: ForwardLiveOverlay =
    prev && prev.snapshotVersion === latestSnapshotVersion
      ? prev
      : { snapshotVersion: latestSnapshotVersion };
  const next: ForwardLiveOverlay =
    event.event === "state"
      ? { ...base, state: event.state }
      : { ...base, healthy: event.healthy };
  setState({
    forwardOverlaysById: {
      ...state.forwardOverlaysById,
      [event.id]: next,
    },
  });
}

export function refreshForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  if (forwardsInFlight) {
    return forwardsInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const promise = fetchForwards(signal)
    .then((list) => {
      if (apiClient.getSessionGeneration() === gen) {
        const nextAddresses: Record<number, ForwardAddresses> = {};
        for (const fw of list) {
          if (fw.addresses) {
            nextAddresses[fw.id] = fw.addresses;
          }
        }
        setState({ forwardAddressesById: nextAddresses });
      }
      return list;
    })
    .finally(() => {
      if (forwardsInFlight === promise) {
        forwardsInFlight = null;
      }
    });
  forwardsInFlight = promise;
  return promise;
}

export function refreshRearmDuration(signal?: AbortSignal): Promise<number> {
  if (settingsInFlight) {
    return settingsInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const promise = fetchSettings(signal)
    .then((settings) => {
      const configured = settings.defaults?.max_runtime;
      const secs =
        typeof configured === "number" && Number.isFinite(configured) && configured > 0
          ? Math.floor(configured)
          : DEFAULT_REARM_SECS;
      if (apiClient.getSessionGeneration() === gen && state.rearmDurationSecs !== secs) {
        setState({ rearmDurationSecs: secs });
      }
      return secs;
    })
    .catch(() => state.rearmDurationSecs)
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

  if (nextSnapshot.version > latestSnapshotVersion) {
    latestSnapshotVersion = nextSnapshot.version;
    if (Object.keys(state.forwardOverlaysById).length > 0) {
      setState({ forwardOverlaysById: {} });
    }
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
      lastKnownRuntimesByAccount.set(accountId, nextList);
    }
  }
}

/**
 * Selects live forwards for one runtime from the authoritative `snapshot.tunnels`,
 * enriched with server-validated `addresses` from `GET /api/forwards` and any
 * in-between `forward` SSE transitions for the current snapshot version.
 */
export function selectForwardsForRuntime(
  runtime: Runtime,
  localState: SessionsLocalState,
  snapshot: Snapshot,
): readonly ForwardView[] {
  if (!runtime.id.name) {
    return [];
  }
  const tunnels: readonly TunnelInfo[] = snapshot.tunnels;
  const out: ForwardView[] = [];
  for (const tunnel of tunnels) {
    if (tunnel.spec.account !== runtime.id.account || tunnel.spec.session !== runtime.id.name) {
      continue;
    }
    const overlay = localState.forwardOverlaysById[tunnel.id];
    const activeOverlay =
      overlay && overlay.snapshotVersion === snapshot.version ? overlay : null;
    out.push({
      ...tunnel,
      state: activeOverlay?.state ?? tunnel.state,
      healthy: activeOverlay?.healthy !== undefined ? activeOverlay.healthy : tunnel.healthy,
      addresses: localState.forwardAddressesById[tunnel.id] ?? null,
    });
  }
  return out;
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
