/**
 * Application-scoped Provision progress tracker and thin delegates to the global
 * `guardStore`, `forwardsStore`, and `appDataStore`.
 *
 * Subscribes continuously to `webStore` across all routes so in-flight session
 * creation survives route switches, anchors `unanswered_for` timing to
 * `serverClock`, retains the submitted draft for retry after hiding/reopening,
 * and delivers real-time `ready` / `below_spec` / `failed` / `cancelled` toasts
 * immediately while the user is away from `#/sessions`.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient, type EventStreamOptions } from "../../lib/api.ts";
import {
  appDataStore,
  type AppDataStore,
  type SessionSettingsSummary,
} from "../../lib/appCache.ts";
import { serverClock, type ServerClock } from "../../lib/clock.ts";
import { forwardsStore, type ForwardsStore } from "../../lib/forwards.ts";
import { guardStore, type GuardStore } from "../../lib/guard.ts";
import { i18nStore, type I18nStore } from "../../lib/i18n.ts";
import { webStore, type WebStore } from "../../lib/store.ts";
import { toastStore, type ToastStore } from "../../lib/toast.ts";
import type {
  AccountContext,
  ApiErrorPayload,
  EndedRuntime,
  ForwardView,
  HardwareRate,
  Snapshot,
  UnixSecs,
} from "../../lib/types.ts";
import {
  openProvisionEventStream,
  type ProvisionOutcome,
  type ProvisionProgressEvent,
  type ProvisionSpec,
} from "./api.ts";
import { formatErrorMessage, formatHardware } from "./format.ts";
import {
  parseFinishedEvent,
  parseProvisionEvent,
  type ProvisionDraft,
} from "./provision.ts";

const PROVISION_RECONNECT_BASE_MS = 1000;
const PROVISION_RECONNECT_MAX_MS = 5000;
const PROVISION_RECONNECT_MAX_EXP = 3;

export type { EndedRuntime, SessionSettingsSummary };

export interface SubmittedProvisionForm {
  readonly name: string;
  readonly suggestedName: string;
  readonly draft: ProvisionDraft;
  readonly baseTemplate: ProvisionSpec | null;
  readonly retryDelaySecs: number;
  readonly measuredRates: readonly HardwareRate[];
  readonly accountContext: AccountContext;
}

export interface TrackedProvision {
  readonly operationId: number;
  readonly sessionName: string;
  readonly accountContext: AccountContext | null;
  readonly submittedForm: SubmittedProvisionForm | null;
  readonly events: readonly ProvisionProgressEvent[];
  readonly waitingAttempt: number | null;
  readonly waitingSinceSecs: UnixSecs | null;
  readonly phase: "running" | "ready" | "cancelled" | "failed";
  readonly outcome: ProvisionOutcome | null;
  readonly finishedError: ApiErrorPayload | null;
  readonly reconnecting: boolean;
}

export interface SessionsLocalState {
  readonly ended: readonly EndedRuntime[];
  readonly reconcileSeq: number;
  readonly trackedProvision: TrackedProvision | null;
}

export interface SessionsStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly appData?: Pick<AppDataStore, "refreshSessions" | "refreshSessionDefaults">;
  readonly forwards?: Pick<ForwardsStore, "refresh" | "recordForward">;
  readonly guard?: Pick<GuardStore, "getState" | "subscribe" | "clearEndedRuntimes">;
  readonly toast?: ToastStore;
  readonly i18n?: Pick<I18nStore, "getState" | "subscribe" | "t">;
  readonly clock?: Pick<ServerClock, "getNowSecs">;
  readonly openStream?: (
    id: number,
    options: Omit<EventStreamOptions, "body">,
  ) => Promise<void>;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface SessionsStore {
  getState(): SessionsLocalState;
  subscribe(listener: () => void): () => void;
  trackProvision(
    operationId: number,
    sessionName: string,
    accountContext?: AccountContext | null,
    submittedForm?: SubmittedProvisionForm | null,
  ): void;
  setDialogOperationId(operationId: number | null): void;
  claimProvisionHandled(operationId: number): boolean;
  clearEndedRuntimes(): void;
  recordForwardAddresses(view: ForwardView): void;
  refreshRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary>;
  dispose(): void;
}

/**
 * Creates an isolated application-scoped Sessions provision store.
 */
export function createSessionsStore(options: SessionsStoreOptions = {}): SessionsStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const appData = options.appData ?? appDataStore;
  const forwards = options.forwards ?? forwardsStore;
  const guard = options.guard ?? guardStore;
  const toast = options.toast ?? toastStore;
  const i18n = options.i18n ?? i18nStore;
  const clock = options.clock ?? serverClock;
  const openStream = options.openStream ?? openProvisionEventStream;
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

  let disposed = false;
  let trackedProvision: TrackedProvision | null = null;
  let activeDialogOperationId: number | null = null;
  let pendingToastProvision: TrackedProvision | null = null;
  let cachedSnapshot: SessionsLocalState = {
    ended: guard.getState().ended,
    reconcileSeq: guard.getState().reconcileSeq,
    trackedProvision: null,
  };

  let provisionStreamController: AbortController | null = null;
  let provisionReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribePendingI18n: (() => void) | null = null;
  let provisionStreamSeq = 0;
  let handledProvisionIds = new Set<number>();
  const listeners = new Set<() => void>();

  const clearPendingI18n = (): void => {
    pendingToastProvision = null;
    if (unsubscribePendingI18n !== null) {
      unsubscribePendingI18n();
      unsubscribePendingI18n = null;
    }
  };

  const refreshSnapshot = (): void => {
    const guardState = guard.getState();
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
  };

  const setTrackedProvision = (next: TrackedProvision | null): void => {
    trackedProvision = next;
    refreshSnapshot();
  };

  const stopProvisionStream = (): void => {
    provisionStreamSeq += 1;
    if (provisionReconnectTimer !== null) {
      clearTimer(provisionReconnectTimer);
      provisionReconnectTimer = null;
    }
    if (provisionStreamController !== null) {
      provisionStreamController.abort();
      provisionStreamController = null;
    }
  };

  const claimProvisionHandled = (operationId: number): boolean => {
    if (handledProvisionIds.has(operationId)) {
      return false;
    }
    handledProvisionIds.add(operationId);
    return true;
  };

  const deliverTerminalToast = (terminal: TrackedProvision): boolean => {
    const i18nState = i18n.getState();
    if (i18nState.dict === null) {
      return false;
    }
    const t = i18n.t;
    const { locale } = i18nState;

    if (terminal.phase === "ready") {
      const name = terminal.outcome?.name ?? terminal.sessionName;
      if (terminal.outcome?.below_spec) {
        const hardware =
          formatHardware(
            terminal.outcome.hardware?.gpu,
            terminal.outcome.hardware?.vram_mib,
            locale,
            t,
          ) ?? t("app.b2.prov_no_gpu");
        toast.push({
          tone: "warning",
          title: t("app.b2.provision_ready_toast", { name }),
          body: t("app.b2.prov_ready_below", { hardware }),
        });
      } else {
        toast.push({
          tone: "success",
          body: t("app.b2.provision_ready_toast", { name }),
        });
      }
    } else if (terminal.phase === "failed") {
      const formatted = formatErrorMessage(terminal.finishedError, t);
      toast.push({
        tone: "danger",
        title: t("app.b2.new_failed"),
        body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
      });
    } else if (terminal.phase === "cancelled") {
      toast.push({
        tone: "info",
        body: t("app.b2.new_cancelled"),
      });
    }
    return true;
  };

  const finalizeProvision = (terminal: TrackedProvision): void => {
    if (disposed || terminal.phase === "running") {
      return;
    }
    if (!claimProvisionHandled(terminal.operationId)) {
      return;
    }
    void appData.refreshSessions().catch(() => {});
    void forwards.refresh().catch(() => {});

    // Suppress duplicate toast while the New Session dialog is visibly displaying this operation.
    if (activeDialogOperationId === terminal.operationId) {
      return;
    }
    if (!deliverTerminalToast(terminal)) {
      pendingToastProvision = terminal;
      if (unsubscribePendingI18n === null) {
        unsubscribePendingI18n = i18n.subscribe(() => {
          if (disposed || pendingToastProvision === null) {
            clearPendingI18n();
            return;
          }
          const pending = pendingToastProvision;
          if (activeDialogOperationId === pending.operationId) {
            clearPendingI18n();
            return;
          }
          if (deliverTerminalToast(pending)) {
            clearPendingI18n();
          }
        });
      }
    }
  };

  const resetLocalState = (): void => {
    stopProvisionStream();
    activeDialogOperationId = null;
    clearPendingI18n();
    handledProvisionIds = new Set<number>();
    setTrackedProvision(null);
  };

  const connectProvisionStream = (
    operationId: number,
    seq: number,
    gen: number,
    attempt: number,
  ): void => {
    const isCurrent = (): boolean =>
      !disposed &&
      seq === provisionStreamSeq &&
      client.getSessionGeneration() === gen &&
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
      provisionReconnectTimer = setTimer(() => {
        provisionReconnectTimer = null;
        connectProvisionStream(operationId, seq, gen, attempt + 1);
      }, delayMs);
    };

    void openStream(operationId, {
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
          let waitingSinceSecs = cur.waitingSinceSecs;
          if (last?.event === "allocating") {
            if (cur.waitingAttempt !== last.attempt || cur.waitingSinceSecs === null) {
              waitingAttempt = last.attempt;
              waitingSinceSecs = clock.getNowSecs();
            }
          } else {
            waitingAttempt = null;
            waitingSinceSecs = null;
          }
          setTrackedProvision({
            ...cur,
            events: nextEvents,
            waitingAttempt,
            waitingSinceSecs,
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
          const terminal: TrackedProvision = {
            ...cur,
            events: baseEvents,
            waitingAttempt: null,
            waitingSinceSecs: null,
            phase: finished.phase,
            outcome: finished.outcome ?? null,
            finishedError: finished.error ?? null,
            reconnecting: false,
          };
          setTrackedProvision(terminal);
          finalizeProvision(terminal);
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
            const terminal: TrackedProvision = {
              ...cur,
              waitingAttempt: null,
              waitingSinceSecs: null,
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
            };
            setTrackedProvision(terminal);
            finalizeProvision(terminal);
          }
          return;
        }
        scheduleReconnect();
      });
  };

  const trackProvision = (
    operationId: number,
    sessionName: string,
    accountContext?: AccountContext | null,
    submittedForm?: SubmittedProvisionForm | null,
  ): void => {
    if (disposed) {
      return;
    }
    const existing = trackedProvision;
    if (existing && existing.operationId === operationId) {
      const nextName =
        sessionName && existing.sessionName !== sessionName ? sessionName : existing.sessionName;
      const nextAccountContext =
        existing.accountContext === null && accountContext
          ? accountContext
          : existing.accountContext;
      const nextSubmittedForm = submittedForm ?? existing.submittedForm;
      if (
        nextName !== existing.sessionName ||
        nextAccountContext !== existing.accountContext ||
        nextSubmittedForm !== existing.submittedForm
      ) {
        setTrackedProvision({
          ...existing,
          sessionName: nextName,
          accountContext: nextAccountContext,
          submittedForm: nextSubmittedForm,
        });
      }
      return;
    }
    stopProvisionStream();
    const seq = provisionStreamSeq;
    const gen = client.getSessionGeneration();
    setTrackedProvision({
      operationId,
      sessionName,
      accountContext: accountContext ?? null,
      submittedForm: submittedForm ?? null,
      events: [],
      waitingAttempt: null,
      waitingSinceSecs: null,
      phase: "running",
      outcome: null,
      finishedError: null,
      reconnecting: false,
    });
    connectProvisionStream(operationId, seq, gen, 0);
  };

  const syncFromWebSnapshot = (snapshot: Snapshot | null): void => {
    if (disposed || !snapshot) {
      return;
    }
    for (const op of snapshot.operations) {
      if (op.operation.kind === "provision") {
        trackProvision(op.id, op.operation.session, snapshot.account);
        return;
      }
    }
  };

  const unsubscribeGuard = guard.subscribe(() => {
    refreshSnapshot();
  });

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (
      event.type === "logged_out" ||
      event.type === "unauthorized" ||
      event.type === "authenticated"
    ) {
      resetLocalState();
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    syncFromWebSnapshot(store.getState().snapshot);
  });

  syncFromWebSnapshot(store.getState().snapshot);

  return {
    getState(): SessionsLocalState {
      return cachedSnapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    trackProvision,

    setDialogOperationId(operationId: number | null): void {
      activeDialogOperationId = operationId;
    },

    claimProvisionHandled,

    clearEndedRuntimes(): void {
      guard.clearEndedRuntimes();
    },

    recordForwardAddresses(view: ForwardView): void {
      forwards.recordForward(view);
    },

    refreshRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary> {
      return appData.refreshSessionDefaults(signal);
    },

    dispose(): void {
      disposed = true;
      stopProvisionStream();
      clearPendingI18n();
      unsubscribeGuard();
      unsubscribeAuth();
      unsubscribeStore();
      listeners.clear();
    },
  };
}

/** Shared application-scoped Sessions provision store. */
export const sessionsStore: SessionsStore = createSessionsStore();

/**
 * Ensures a single session-scoped SSE subscription tracks `operationId` until its
 * `finished` frame arrives, surviving dialog hide/show toggles, route switches,
 * snapshot operation removal ahead of journal completion, and transient disconnects.
 */
export function trackProvision(
  operationId: number,
  sessionName: string,
  accountContext?: AccountContext | null,
  submittedForm?: SubmittedProvisionForm | null,
): void {
  sessionsStore.trackProvision(operationId, sessionName, accountContext, submittedForm);
}

/**
 * Records which provision operation is currently visible inside `NewSessionDialog`
 * so terminal toasts fire immediately whenever the dialog is hidden or unmounted.
 */
export function setProvisionDialogOperationId(operationId: number | null): void {
  sessionsStore.setDialogOperationId(operationId);
}

/**
 * Claims one-time completion handling for `operationId` so returning to `#/sessions`
 * never replays an already-delivered ready, failed, or cancelled toast.
 */
export function claimProvisionHandled(operationId: number): boolean {
  return sessionsStore.claimProvisionHandled(operationId);
}

export function clearEndedRuntimes(): void {
  sessionsStore.clearEndedRuntimes();
}

export function recordForwardAddresses(view: ForwardView): void {
  sessionsStore.recordForwardAddresses(view);
}

export function refreshRearmDuration(signal?: AbortSignal): Promise<SessionSettingsSummary> {
  return sessionsStore.refreshRearmDuration(signal);
}

export function useSessionsLocalState(
  store: SessionsStore = sessionsStore,
): SessionsLocalState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
