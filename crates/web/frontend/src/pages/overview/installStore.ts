/**
 * Persistent application-scope store for Colab CLI installation, server log
 * replay across route switches or browser reloads, and `fa25d8c` post-install
 * not-found / rechecking state transitions.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient } from "../../lib/api.ts";
import { appDataStore, type AppDataStore } from "../../lib/appCache.ts";
import { webStore, type WebStore } from "../../lib/store.ts";
import type {
  ApiErrorPayload,
  CliInstallLine,
  CliInstallPhase,
  CliInstallSummary,
  CliInstallView,
  InstallMethod,
} from "../../lib/types.ts";
import {
  cancelCliInstall,
  findRunningInstallOp,
  getCliInstallStatus,
  INSTALL_LOG_MAX_LINES,
  sanitizeInstallLines,
  startCliInstallStream,
  subscribeCliInstallEvents,
  type InstallFinishedEvent,
} from "./api.ts";

export interface CliInstallStoreState {
  readonly id: number | null;
  readonly method: InstallMethod | null;
  readonly preferredMethod: InstallMethod | null;
  readonly phase: CliInstallPhase;
  readonly cancelling: boolean;
  readonly lines: readonly CliInstallLine[];
  readonly warningTitleKey: string | null;
  readonly warningBodyKey: string | null;
  readonly error: ApiErrorPayload | null;
  readonly streamError: unknown | null;
}

export interface CliInstallStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly appData?: Pick<AppDataStore, "refreshOverview">;
}

export interface CliInstallStore {
  getState(): CliInstallStoreState;
  subscribe(listener: () => void): () => void;
  /** Remembers the user's chosen install method across route switches. */
  setPreferredMethod(method: InstallMethod): void;
  /** Hydrates state from `OverviewResponse.cli_install` without clobbering an active stream. */
  hydrateFromOverview(view: CliInstallView | null | undefined): void;
  /** Reconciles with live snapshot / server status when Overview mounts. */
  syncWithServer(): void;
  /** Starts `POST /api/overview/cli/install` and streams logs persistently in the store. */
  startInstall(method: InstallMethod): Promise<void>;
  /** Requests cancellation of the active server install operation. */
  cancelInstall(): Promise<void>;
  dispose(): void;
}

const INITIAL_STATE: CliInstallStoreState = {
  id: null,
  method: null,
  preferredMethod: null,
  phase: "idle",
  cancelling: false,
  lines: [],
  warningTitleKey: null,
  warningBodyKey: null,
  error: null,
  streamError: null,
};

function isTerminalPhase(phase: CliInstallPhase): boolean {
  return (
    phase === "succeeded" ||
    phase === "not_found" ||
    phase === "probe_failed" ||
    phase === "cancelled" ||
    phase === "failed"
  );
}

/**
 * Creates an isolated CLI install controller that survives Overview unmounts
 * and keeps logs synchronized with backend replay streams and live snapshots.
 */
export function createCliInstallStore(options: CliInstallStoreOptions = {}): CliInstallStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const appData = options.appData ?? appDataStore;

  let state: CliInstallStoreState = INITIAL_STATE;
  let disposed = false;

  let streamSeq = 0;
  let activeStream: {
    readonly seq: number;
    readonly id: number | null;
    readonly controller: AbortController;
  } | null = null;
  let startingLocal = false;
  let totalLinesSeen = 0;
  let hydratedTerminalKey: string | null = null;
  let lastHydratedOverviewView: CliInstallView | null = null;
  let minSnapshotVersionForIdleReset = 0;
  let refreshedSucceededId: number | null = null;
  let statusFetchInFlight: {
    readonly generation: number;
    readonly controller: AbortController;
    readonly promise: Promise<CliInstallView | null>;
  } | null = null;
  let prevConnectionStatus = store.getState().connectionStatus;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all consumers stay synchronized.
      }
    }
  };

  const setState = (patch: Partial<CliInstallStoreState>): void => {
    const next: CliInstallStoreState = { ...state, ...patch };
    if (
      next.id === state.id &&
      next.method === state.method &&
      next.preferredMethod === state.preferredMethod &&
      next.phase === state.phase &&
      next.cancelling === state.cancelling &&
      next.lines === state.lines &&
      next.warningTitleKey === state.warningTitleKey &&
      next.warningBodyKey === state.warningBodyKey &&
      next.error === state.error &&
      next.streamError === state.streamError
    ) {
      return;
    }
    state = next;
    emit();
  };

  const abortStream = (): void => {
    streamSeq += 1;
    if (activeStream !== null) {
      activeStream.controller.abort();
      activeStream = null;
    }
    startingLocal = false;
  };

  const abortStatusFetch = (): void => {
    if (statusFetchInFlight !== null) {
      statusFetchInFlight.controller.abort();
      statusFetchInFlight = null;
    }
  };

  const bumpIdleResetWatermark = (): void => {
    const nextVersion = (store.getState().snapshot?.version ?? 0) + 1;
    if (nextVersion > minSnapshotVersionForIdleReset) {
      minSnapshotVersionForIdleReset = nextVersion;
    }
  };

  const reset = (keepPreferredMethod = false): void => {
    abortStream();
    abortStatusFetch();
    totalLinesSeen = 0;
    hydratedTerminalKey = null;
    minSnapshotVersionForIdleReset = 0;
    if (!keepPreferredMethod) {
      lastHydratedOverviewView = null;
    }
    refreshedSucceededId = null;
    setState({
      ...INITIAL_STATE,
      preferredMethod: keepPreferredMethod ? state.preferredMethod : null,
    });
  };

  const triggerOverviewRefresh = (installId: number | null): void => {
    if (installId !== null && refreshedSucceededId === installId) {
      return;
    }
    if (installId !== null) {
      refreshedSucceededId = installId;
    }
    void appData.refreshOverview().catch(() => {});
    void store.refreshSnapshot().catch(() => {});
  };

  const appendLine = (line: CliInstallLine): void => {
    totalLinesSeen += 1;
    const prev = state.lines;
    const nextLines =
      prev.length >= INSTALL_LOG_MAX_LINES
        ? [...prev.slice(prev.length - INSTALL_LOG_MAX_LINES + 1), line]
        : [...prev, line];
    setState({ lines: nextLines });
  };

  const applyView = (view: CliInstallView): void => {
    const sameSession = view.id !== null && view.id === state.id;
    // Never regress an already-captured log buffer when a stale GET lags behind the live stream.
    const keepCurrentLines = sameSession && view.lines.length < totalLinesSeen;
    const incomingLines = keepCurrentLines ? state.lines : sanitizeInstallLines(view.lines);
    if (!keepCurrentLines) {
      totalLinesSeen = view.lines.length;
    }
    if (view.phase !== "idle" || view.id !== null) {
      bumpIdleResetWatermark();
    } else {
      minSnapshotVersionForIdleReset = 0;
    }
    const notFound = view.phase === "not_found";
    if (isTerminalPhase(view.phase)) {
      hydratedTerminalKey = `${view.id ?? "none"}:${view.phase}:${totalLinesSeen}`;
    } else {
      hydratedTerminalKey = null;
    }
    setState({
      id: view.id,
      method: view.method,
      phase: view.phase,
      cancelling: view.cancelling,
      lines: incomingLines,
      warningTitleKey: notFound ? (view.warning_title_key ?? "app.install.not_found.title") : null,
      warningBodyKey: notFound ? (view.warning_body_key ?? "app.install.not_found.body") : null,
      error: notFound ? null : view.error,
      streamError: null,
    });
    if (view.phase === "succeeded") {
      triggerOverviewRefresh(view.id);
    }
  };

  const applyFinishedEvent = (event: InstallFinishedEvent, installId: number | null): void => {
    const resolvedId = installId ?? state.id;
    hydratedTerminalKey = `${resolvedId ?? "none"}:${event.phase}:${totalLinesSeen}`;

    if (event.phase === "not_found") {
      setState({
        phase: "not_found",
        cancelling: false,
        warningTitleKey: event.warning_title_key ?? "app.install.not_found.title",
        warningBodyKey: event.warning_body_key ?? "app.install.not_found.body",
        error: null,
        streamError: null,
      });
      return;
    }
    if (event.phase === "succeeded") {
      setState({
        phase: "succeeded",
        cancelling: false,
        warningTitleKey: null,
        warningBodyKey: null,
        error: null,
        streamError: null,
      });
      triggerOverviewRefresh(resolvedId);
      return;
    }
    if (event.phase === "cancelled") {
      setState({
        phase: "cancelled",
        cancelling: false,
        warningTitleKey: null,
        warningBodyKey: null,
        error: null,
        streamError: null,
      });
      return;
    }
    setState({
      phase: event.phase === "probe_failed" ? "probe_failed" : "failed",
      cancelling: false,
      warningTitleKey: null,
      warningBodyKey: null,
      error: event.error,
      streamError: null,
    });
  };

  const fetchInstallStatus = (): Promise<CliInstallView | null> => {
    const generation = client.getSessionGeneration();
    if (statusFetchInFlight !== null && statusFetchInFlight.generation === generation) {
      return statusFetchInFlight.promise;
    }
    const controller = new AbortController();
    const promise = getCliInstallStatus(controller.signal, client)
      .then((view) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          applyView(view);
          if (view.phase === "running" && activeStream === null) {
            void attachToInstallStream(view.id, false);
          }
          return view;
        }
        return null;
      })
      .catch(() => null)
      .finally(() => {
        if (statusFetchInFlight?.promise === promise) {
          statusFetchInFlight = null;
        }
      });
    statusFetchInFlight = { generation, controller, promise };
    return promise;
  };

  const reconcileAfterStreamDrop = async (
    generation: number,
    seq: number,
    allowReattach: boolean,
  ): Promise<void> => {
    try {
      const view = await getCliInstallStatus(undefined, client);
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      applyView(view);
      if (view.phase === "running" && allowReattach) {
        void attachToInstallStream(view.id, false);
      }
    } catch (error) {
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      setState({
        phase: "failed",
        cancelling: false,
        error: null,
        streamError: new ApiError({
          status: 0,
          kind: "connection_lost",
          message: "install stream closed unexpectedly",
        }),
      });
    }
  };

  const attachToInstallStream = async (
    targetId: number | null,
    allowDropReattach = true,
  ): Promise<void> => {
    if (disposed || !client.isAuthenticated()) {
      return;
    }
    if (
      activeStream !== null &&
      (targetId === null || activeStream.id === null || activeStream.id === targetId)
    ) {
      return;
    }
    const generation = client.getSessionGeneration();
    abortStream();
    bumpIdleResetWatermark();
    const seq = ++streamSeq;
    const controller = new AbortController();
    activeStream = { seq, id: targetId, controller };

    if (targetId !== null && state.id !== targetId) {
      totalLinesSeen = 0;
      hydratedTerminalKey = null;
      setState({
        id: targetId,
        phase: state.phase === "checking" ? "checking" : "running",
        lines: [],
        warningTitleKey: null,
        warningBodyKey: null,
        error: null,
        streamError: null,
      });
    }

    let receivedFinished = false;
    let streamLineIndex = 0;
    let streamSessionId = targetId;

    try {
      await subscribeCliInstallEvents(
        targetId,
        {
          signal: controller.signal,
          onStarted: (startedId, method) => {
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            streamSessionId = startedId;
            if (activeStream?.seq === seq) {
              activeStream = { seq, id: startedId, controller };
            }
            if (state.id !== startedId) {
              totalLinesSeen = 0;
              hydratedTerminalKey = null;
              setState({
                id: startedId,
                method: method ?? state.method,
                phase: state.phase === "checking" ? "checking" : "running",
                lines: [],
                warningTitleKey: null,
                warningBodyKey: null,
                error: null,
                streamError: null,
              });
            } else if (method !== null && state.method !== method) {
              setState({ method });
            }
          },
          onLine: (line) => {
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            const idx = streamLineIndex;
            streamLineIndex += 1;
            // Replay streams resend from line 0; skip lines already captured for this session.
            if (idx < totalLinesSeen) {
              return;
            }
            appendLine(line);
          },
          onFinished: (event) => {
            receivedFinished = true;
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            applyFinishedEvent(event, streamSessionId);
          },
        },
        client,
      );

      if (activeStream?.seq === seq) {
        activeStream = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      if (!receivedFinished) {
        await reconcileAfterStreamDrop(generation, seq, allowDropReattach);
      }
    } catch (error) {
      if (activeStream?.seq === seq) {
        activeStream = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        void fetchInstallStatus();
        return;
      }
      if (!receivedFinished) {
        await reconcileAfterStreamDrop(generation, seq, false);
      }
    }
  };

  const applySummary = (summary: CliInstallSummary, snapshotVersion: number): void => {
    if (summary.phase === "idle" && summary.id === null) {
      // Ignore pre-install snapshots whose version predates this install session so returning
      // to Overview before `/api/events` advances never aborts an active stream or clears logs.
      if (startingLocal || snapshotVersion < minSnapshotVersionForIdleReset) {
        return;
      }
      if (state.phase !== "idle" || state.id !== null || state.lines.length > 0) {
        reset(true);
      }
      return;
    }

    if (summary.phase === "running") {
      const sameSession = summary.id !== null && summary.id === state.id;
      if (!sameSession && !startingLocal) {
        totalLinesSeen = 0;
        hydratedTerminalKey = null;
      }
      setState({
        id: summary.id,
        method: summary.method ?? state.method,
        phase: "running",
        cancelling: summary.cancelling || (sameSession && state.cancelling),
        ...(sameSession || startingLocal ? {} : { lines: [] }),
        warningTitleKey: null,
        warningBodyKey: null,
        error: null,
        streamError: null,
      });
      if (!startingLocal && activeStream === null) {
        void attachToInstallStream(summary.id);
      }
      return;
    }

    if (summary.phase === "checking") {
      const sameSession = summary.id !== null && summary.id === state.id;
      hydratedTerminalKey = null;
      setState({
        id: summary.id,
        method: summary.method ?? state.method,
        phase: "checking",
        cancelling: false,
        error: null,
        streamError: null,
      });
      if (activeStream === null && (!sameSession || summary.line_count > totalLinesSeen)) {
        void fetchInstallStatus();
      }
      return;
    }

    // Terminal summary from live snapshot: fetch full view when not yet hydrated by live stream.
    const terminalKey = `${summary.id ?? "none"}:${summary.phase}:${summary.line_count}`;
    if (hydratedTerminalKey === terminalKey && state.phase === summary.phase) {
      return;
    }
    if (activeStream !== null && activeStream.id === summary.id) {
      // Live SSE `finished` frame is immediately behind this snapshot notification.
      return;
    }
    if (
      summary.id !== null &&
      summary.id === state.id &&
      summary.phase === "not_found" &&
      totalLinesSeen >= summary.line_count &&
      state.warningTitleKey !== null
    ) {
      hydratedTerminalKey = terminalKey;
      setState({
        phase: "not_found",
        cancelling: false,
        error: null,
        streamError: null,
      });
      return;
    }
    void fetchInstallStatus();
  };

  const syncWithSnapshot = (): void => {
    const storeState = store.getState();
    const { snapshot, connectionStatus } = storeState;

    const reconnected = prevConnectionStatus !== "connected" && connectionStatus === "connected";
    prevConnectionStatus = connectionStatus;

    if (snapshot === null) {
      return;
    }

    if (snapshot.cli_install !== undefined) {
      applySummary(snapshot.cli_install, snapshot.version);
    } else {
      const runningOp = findRunningInstallOp(snapshot);
      if (runningOp !== null && !startingLocal && activeStream === null) {
        void attachToInstallStream(runningOp.id);
      }
    }

    if (
      reconnected &&
      activeStream === null &&
      !startingLocal &&
      (snapshot.cli_install?.phase === "running" || findRunningInstallOp(snapshot) !== null)
    ) {
      const targetId = snapshot.cli_install?.id ?? findRunningInstallOp(snapshot)?.id ?? null;
      void attachToInstallStream(targetId);
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
      reset(false);
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    if (disposed) {
      return;
    }
    syncWithSnapshot();
  });

  const startInstall = async (method: InstallMethod): Promise<void> => {
    if (
      disposed ||
      startingLocal ||
      state.phase === "running" ||
      state.phase === "checking" ||
      store.getState().snapshot?.shutting_down === true
    ) {
      return;
    }

    const generation = client.getSessionGeneration();
    abortStream();
    abortStatusFetch();
    bumpIdleResetWatermark();
    const seq = ++streamSeq;
    const controller = new AbortController();
    activeStream = { seq, id: null, controller };
    startingLocal = true;
    totalLinesSeen = 0;
    hydratedTerminalKey = null;

    setState({
      id: null,
      method,
      preferredMethod: method,
      phase: "running",
      cancelling: false,
      lines: [],
      warningTitleKey: null,
      warningBodyKey: null,
      error: null,
      streamError: null,
    });

    let receivedFinished = false;
    let startedId: number | null = null;

    try {
      await startCliInstallStream(
        method,
        {
          signal: controller.signal,
          onStarted: (id, startedMethod) => {
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            startingLocal = false;
            startedId = id;
            if (activeStream?.seq === seq) {
              activeStream = { seq, id, controller };
            }
            setState({
              id,
              method: startedMethod ?? method,
            });
          },
          onLine: (line) => {
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            appendLine(line);
          },
          onFinished: (event) => {
            receivedFinished = true;
            startingLocal = false;
            if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
              return;
            }
            applyFinishedEvent(event, startedId);
          },
        },
        client,
      );

      startingLocal = false;
      if (activeStream?.seq === seq) {
        activeStream = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      if (!receivedFinished) {
        await reconcileAfterStreamDrop(generation, seq, true);
      }
    } catch (error) {
      startingLocal = false;
      if (activeStream?.seq === seq) {
        activeStream = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== streamSeq) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (error instanceof ApiError && error.status === 409 && error.operationId !== null) {
        void attachToInstallStream(error.operationId);
        return;
      }
      if (!receivedFinished) {
        setState({
          phase: "failed",
          cancelling: false,
          error: null,
          streamError: error,
        });
      }
    }
  };

  const cancelInstall = async (): Promise<void> => {
    const runningOp = findRunningInstallOp(store.getState().snapshot);
    const targetId = state.id ?? runningOp?.id ?? null;
    if (disposed || targetId === null || state.cancelling || state.phase !== "running") {
      return;
    }
    setState({ cancelling: true });
    try {
      await cancelCliInstall(targetId, undefined, client);
    } catch (error) {
      if (disposed) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setState({ cancelling: false });
        void fetchInstallStatus();
        return;
      }
      setState({ cancelling: false });
      throw error;
    }
  };

  return {
    getState(): CliInstallStoreState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setPreferredMethod(method: InstallMethod): void {
      if (!disposed) {
        setState({ preferredMethod: method });
      }
    },

    hydrateFromOverview(view: CliInstallView | null | undefined): void {
      if (disposed || view === null || view === undefined) {
        return;
      }
      // Route-switch remounts pass the same cached `overview.cli_install` object; never re-apply it.
      if (view === lastHydratedOverviewView) {
        return;
      }
      lastHydratedOverviewView = view;
      if (startingLocal) {
        return;
      }
      if (view.phase === "idle" && view.id === null && (activeStream !== null || state.id !== null)) {
        return;
      }
      if (state.id !== null && view.id !== null && view.id < state.id) {
        return;
      }
      if (
        activeStream !== null &&
        (view.phase === "running" || view.phase === "checking") &&
        (activeStream.id === null || activeStream.id === view.id)
      ) {
        if (view.phase === "checking" && state.phase !== "checking") {
          hydratedTerminalKey = null;
          setState({ phase: "checking", cancelling: false });
        } else if (view.cancelling && !state.cancelling) {
          setState({ cancelling: true });
        }
        return;
      }
      applyView(view);
      if (view.phase === "running" && activeStream === null) {
        void attachToInstallStream(view.id);
      }
    },

    syncWithServer(): void {
      if (disposed) {
        return;
      }
      syncWithSnapshot();
    },

    startInstall,
    cancelInstall,

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      unsubscribeStore();
      abortStream();
      abortStatusFetch();
      listeners.clear();
    },
  };
}

/** Shared global CLI install store that persists across Overview route switches. */
export const cliInstallStore: CliInstallStore = createCliInstallStore();

/** React hook subscribing a component to `cliInstallStore`. */
export function useCliInstallStore(store: CliInstallStore = cliInstallStore): CliInstallStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
