/**
 * Session-scoped client state for Provision progress streaming and thin
 * delegates to the global `guardStore`, `forwardsStore`, and `appDataStore`.
 *
 * Resets automatically when the Bearer auth session ends or rotates.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError } from "../../lib/api.ts";
import { appDataStore, type SessionSettingsSummary } from "../../lib/appCache.ts";
import { forwardsStore } from "../../lib/forwards.ts";
import { guardStore } from "../../lib/guard.ts";
import type {
  AccountContext,
  ApiErrorPayload,
  Concern,
  EndedRuntime as GlobalEndedRuntime,
  ForwardView,
  RuntimeRef,
} from "../../lib/types.ts";
import {
  openProvisionEventStream,
  type ProvisionOutcome,
  type ProvisionProgressEvent,
} from "./api.ts";
import { parseFinishedEvent, parseProvisionEvent } from "./ProvisionProgress.tsx";

const PROVISION_RECONNECT_BASE_MS = 1000;
const PROVISION_RECONNECT_MAX_MS = 5000;
const PROVISION_RECONNECT_MAX_EXP = 3;

export type { SessionSettingsSummary };

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
  readonly ended: readonly GlobalEndedRuntime[];
  readonly reconcileSeq: number;
  readonly trackedProvision: TrackedProvision | null;
}

let trackedProvision: TrackedProvision | null = null;
let cachedSnapshot: SessionsLocalState = {
  ended: guardStore.getState().ended,
  reconcileSeq: guardStore.getState().reconcileSeq,
  trackedProvision: null,
};

let provisionStreamController: AbortController | null = null;
let provisionReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let provisionStreamSeq = 0;
let handledProvisionIds = new Set<number>();
const listeners = new Set<() => void>();

function refreshSnapshot(): void {
  const guardState = guardStore.getState();
  if (
    cachedSnapshot.ended === guardState.ended &&
    cachedSnapshot.reconcileSeq === guardState.reconcileSeq &&
    cachedSnapshot.trackedProvision === trackedProvision
  ) {
    return;
  }
  cachedSnapshot = {
    ended: guardState.ended,
    reconcileSeq: guardState.reconcileSeq,
    trackedProvision,
  };
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Isolate subscriber exceptions so all Sessions consumers converge cleanly.
    }
  }
}

guardStore.subscribe(() => {
  refreshSnapshot();
});

function setTrackedProvision(next: TrackedProvision | null): void {
  trackedProvision = next;
  refreshSnapshot();
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
  setTrackedProvision(null);
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
    trackedProvision?.operationId === operationId &&
    trackedProvision.phase === "running";

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
    const cur = trackedProvision;
    if (cur) {
      setTrackedProvision({ ...cur, reconnecting: true });
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
      const cur = trackedProvision;
      if (cur?.reconnecting) {
        setTrackedProvision({ ...cur, reconnecting: false });
      }
    },
    onFrame: (frame) => {
      if (!isCurrent()) {
        return;
      }
      const cur = trackedProvision;
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
        setTrackedProvision({
          ...cur,
          events: nextEvents,
          waitingAttempt,
          waitingSinceMs,
          reconnecting: false,
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
        setTrackedProvision({
          ...cur,
          events: baseEvents,
          waitingAttempt: null,
          waitingSinceMs: null,
          phase: finished.phase,
          outcome: finished.outcome ?? null,
          finishedError: finished.error ?? null,
          reconnecting: false,
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
        const cur = trackedProvision;
        if (cur) {
          setTrackedProvision({
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
  const existing = trackedProvision;
  if (existing && existing.operationId === operationId) {
    const nextName =
      sessionName && existing.sessionName !== sessionName ? sessionName : existing.sessionName;
    const nextAccountContext =
      existing.accountContext === null && accountContext ? accountContext : existing.accountContext;
    if (nextName !== existing.sessionName || nextAccountContext !== existing.accountContext) {
      setTrackedProvision({
        ...existing,
        sessionName: nextName,
        accountContext: nextAccountContext,
      });
    }
    return;
  }
  stopProvisionStream();
  const seq = provisionStreamSeq;
  const gen = apiClient.getSessionGeneration();
  setTrackedProvision({
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

export function clearEndedRuntimes(): void {
  guardStore.clearEndedRuntimes();
}

export function recordForwardAddresses(view: ForwardView): void {
  forwardsStore.recordForward(view);
}

export function refreshRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary> {
  return appDataStore.refreshSessionDefaults(signal);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): SessionsLocalState {
  return cachedSnapshot;
}

export function useSessionsLocalState(): SessionsLocalState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
