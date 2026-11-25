/**
 * Session-scoped client state for Recently ended history, enriched Forward rows
 * with server-validated addresses, and the default rearm duration from Settings.
 *
 * Resets automatically when the Bearer auth session ends or rotates.
 */

import { useSyncExternalStore } from "react";

import { apiClient } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type {
  Concern,
  Locale,
  Runtime,
  RuntimeRef,
  Snapshot,
  TunnelEvent,
  TunnelInfo,
} from "../../lib/types.ts";
import { fetchForwards, fetchSettings, type ForwardView } from "./api.ts";
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

export interface SessionsLocalState {
  readonly ended: readonly EndedRuntime[];
  readonly forwards: readonly ForwardView[];
  readonly forwardsLoaded: boolean;
  readonly rearmDurationSecs: number;
  readonly cliInstalled: boolean | null;
}

const INITIAL_STATE: SessionsLocalState = {
  ended: [],
  forwards: [],
  forwardsLoaded: false,
  rearmDurationSecs: DEFAULT_REARM_SECS,
  cliInstalled: null,
};

let state: SessionsLocalState = INITIAL_STATE;
let seenGuardSignature = "";
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
  seenGuardSignature = "";
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

export function applyForwardEvent(event: TunnelEvent): void {
  if (!state.forwardsLoaded) {
    return;
  }
  let changed = false;
  const next = state.forwards.map((fw) => {
    if (fw.id !== event.id) {
      return fw;
    }
    changed = true;
    if (event.event === "state") {
      return { ...fw, state: event.state };
    }
    return { ...fw, healthy: event.healthy };
  });
  if (changed) {
    setState({ forwards: next });
  }
}

export function refreshForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  if (forwardsInFlight) {
    return forwardsInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const promise = fetchForwards(signal)
    .then((list) => {
      if (apiClient.getSessionGeneration() === gen) {
        setState({ forwards: list, forwardsLoaded: true });
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
 * Observes Guard report transitions across snapshots, recording newly stopped or
 * vanished runtimes into Recently ended and notifying the user once per transition.
 */
export function observeGuardTransitions(
  prevSnapshot: Snapshot | null,
  nextSnapshot: Snapshot | null,
  locale: Locale,
  t: TranslateFn,
  pushToast: (toast: ToastInput) => number,
): void {
  const report = nextSnapshot?.guard;
  if (!report) {
    return;
  }
  const stoppedDecisions = report.decisions.filter(
    (d) => d.decision.decision === "stop" && d.stopped,
  );
  const vanished = report.vanished;
  const signature = JSON.stringify({
    stopped: stoppedDecisions.map((d) => {
      const concern = d.decision.decision === "stop" ? d.decision.concerns : null;
      return `${runtimeKey(d.session)}:${concern?.limit ?? ""}`;
    }),
    vanished: vanished.map((v) => runtimeKey(v)),
  });
  if (signature === seenGuardSignature) {
    return;
  }
  seenGuardSignature = signature;

  if (stoppedDecisions.length === 0 && vanished.length === 0) {
    return;
  }

  const prevRuntimes = prevSnapshot?.runtimes?.runtimes ?? [];
  const accounts = nextSnapshot.accounts?.accounts ?? prevSnapshot?.accounts?.accounts ?? [];
  const lookupInfo = (ref: RuntimeRef): { label: string; email: string | null } => {
    const matched = prevRuntimes.find((rt) => runtimeKey(rt.id) === runtimeKey(ref));
    const acct = accounts.find((a) => a.id === ref.account);
    return {
      label: matched ? formatRuntimeCardLabel(matched) : (ref.name ?? ref.endpoint),
      email: matched?.account_email ?? acct?.email ?? null,
    };
  };

  for (const item of stoppedDecisions) {
    if (item.decision.decision !== "stop") {
      continue;
    }
    const info = lookupInfo(item.session);
    const concern = item.decision.concerns;
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

  for (const ref of vanished) {
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

export function selectForwardsForRuntime(
  runtime: Runtime,
  localState: SessionsLocalState,
  snapshotTunnels: readonly TunnelInfo[],
): readonly ForwardView[] {
  if (!runtime.id.name) {
    return [];
  }
  const source: readonly ForwardView[] = localState.forwardsLoaded
    ? localState.forwards
    : snapshotTunnels;
  return source.filter(
    (item) => item.spec.account === runtime.id.account && item.spec.session === runtime.id.name,
  );
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
