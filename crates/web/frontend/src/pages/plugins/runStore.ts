/**
 * Session-scoped store for Plugin runs: lists server runs via `GET /api/plugins/runs`,
 * attaches to `POST /api/plugins/runs/{id}/events` with bounded reconnect on transient
 * stream loss, caches server-validated Endpoint forward addresses, and exposes clean
 * navigation seams (`openPluginRun`, `showPluginList`) for both #49 and #50.
 *
 * Resets automatically when the Bearer auth session ends or rotates.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError } from "../../lib/api.ts";
import type { SseFrame } from "../../lib/sse.ts";
import { webStore } from "../../lib/store.ts";
import type { ApiErrorPayload, TunnelEvent } from "../../lib/types.ts";
import {
  fetchForwards,
  type ForwardAddresses,
  type ForwardView,
  type ProvisionProgressEvent,
} from "../sessions/api.ts";
import { recordForwardAddresses } from "../sessions/store.ts";
import { cancelPluginRun, listPluginRuns, openPluginRunEventStream } from "./api.ts";
import { stripAnsi, type ForwardLiveOverlay } from "./endpoint.ts";
import type {
  PluginRunDetail,
  PluginRunEndpointResult,
  PluginRunFinishedEvent,
  PluginRunLogEntry,
  PluginRunOutcome,
  PluginRunPhase,
  PluginRunState,
  PluginRunStatus,
  PluginRunSummary,
} from "./types.ts";

const MAX_LOG_ENTRIES = 2000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_EXPONENT = 8;

export interface PluginRunsStoreState {
  readonly runs: readonly PluginRunSummary[];
  readonly runsLoading: boolean;
  readonly runsError: unknown | null;
  readonly selectedRunId: number | null;
  readonly activeRun: PluginRunDetail | null;
  readonly knownPhasesById: Readonly<Record<number, PluginRunPhase>>;
  readonly forwardAddressesById: Readonly<Record<number, ForwardAddresses>>;
  readonly forwardOverlaysById: Readonly<Record<number, ForwardLiveOverlay>>;
  readonly latestSnapshotVersion: number;
}

const INITIAL_STATE: PluginRunsStoreState = {
  runs: [],
  runsLoading: false,
  runsError: null,
  selectedRunId: null,
  activeRun: null,
  knownPhasesById: {},
  forwardAddressesById: {},
  forwardOverlaysById: {},
  latestSnapshotVersion: 0,
};

let state: PluginRunsStoreState = INITIAL_STATE;
let dismissedAutoRunId = 0;
let runsListInFlight: Promise<PluginRunSummary[]> | null = null;
let forwardsInFlight: Promise<ForwardView[]> | null = null;
let forwardsSeq = 0;
let streamSeq = 0;
let streamAbort: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let activeStreamRunId: number | null = null;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Isolate subscriber errors so every Plugins consumer receives updates.
    }
  }
}

function setState(patch: Partial<PluginRunsStoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function stopStream(): void {
  streamSeq += 1;
  activeStreamRunId = null;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (streamAbort !== null) {
    streamAbort.abort();
    streamAbort = null;
  }
}

function resetStore(): void {
  stopStream();
  dismissedAutoRunId = 0;
  runsListInFlight = null;
  forwardsInFlight = null;
  forwardsSeq += 1;
  state = INITIAL_STATE;
  emit();
}

apiClient.subscribeAuth((event) => {
  if (event.type === "logged_out" || event.type === "unauthorized") {
    resetStore();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRunState(value: unknown): value is PluginRunState {
  return value === "starting" || value === "running" || value === "ready" || value === "failed";
}

function parseRunStatus(raw: unknown): PluginRunStatus | null {
  if (!isRecord(raw) || !isRunState(raw.state)) {
    return null;
  }
  const outputs: Record<string, unknown> = isRecord(raw.outputs) ? { ...raw.outputs } : {};
  return {
    state: raw.state,
    stage: typeof raw.stage === "string" ? raw.stage : null,
    progress:
      typeof raw.progress === "number" && Number.isFinite(raw.progress) ? raw.progress : null,
    message: typeof raw.message === "string" ? raw.message : null,
    outputs,
  };
}

function parseProvisionEvent(raw: unknown): ProvisionProgressEvent | null {
  if (!isRecord(raw) || typeof raw.event !== "string") {
    return null;
  }
  return raw as unknown as ProvisionProgressEvent;
}

function parseFinishedEvent(raw: unknown): PluginRunFinishedEvent | null {
  if (
    !isRecord(raw) ||
    (raw.phase !== "ready" && raw.phase !== "cancelled" && raw.phase !== "failed") ||
    !isRecord(raw.run) ||
    typeof raw.run.plugin !== "string" ||
    typeof raw.run.account !== "string" ||
    typeof raw.run.session !== "string"
  ) {
    return null;
  }
  const endpoints = Array.isArray(raw.endpoints)
    ? (raw.endpoints as PluginRunEndpointResult[])
    : [];
  const outcome = isRecord(raw.outcome) ? (raw.outcome as unknown as PluginRunOutcome) : null;
  const error = isRecord(raw.error) ? (raw.error as unknown as ApiErrorPayload) : null;
  return {
    phase: raw.phase,
    run: {
      plugin: raw.run.plugin,
      account: raw.run.account,
      session: raw.run.session,
      provisions: Boolean(raw.run.provisions),
    },
    outcome,
    endpoints,
    error,
  };
}

function appendLogEntries(
  existing: readonly PluginRunLogEntry[],
  incoming: readonly PluginRunLogEntry[],
): readonly PluginRunLogEntry[] {
  if (incoming.length === 0) {
    return existing;
  }
  const combined = [...existing, ...incoming];
  if (combined.length <= MAX_LOG_ENTRIES) {
    return combined;
  }
  const tail = combined.slice(combined.length - (MAX_LOG_ENTRIES - 1));
  if (tail[0]?.kind === "history_skipped") {
    return tail;
  }
  return [{ kind: "history_skipped" }, ...tail];
}

function createInitialDetail(summary: PluginRunSummary): PluginRunDetail {
  return {
    id: summary.id,
    plugin: summary.plugin,
    account: summary.account,
    session: summary.session,
    provisions: summary.provisions,
    launched: !summary.provisions,
    provisionAllocated: false,
    runId: null,
    phase: "running",
    provisionEvents: [],
    latestProvisionAtMs: Date.now(),
    status: null,
    logEntries: [],
    outcome: null,
    endpoints: [],
    error: null,
    streamError: null,
    cancelRequested: false,
    finishedLive: false,
  };
}

function updateActiveRun(id: number, updater: (prev: PluginRunDetail) => PluginRunDetail): void {
  const current = state.activeRun;
  if (!current || current.id !== id) {
    return;
  }
  const next = updater(current);
  if (next === current) {
    return;
  }
  setState({
    activeRun: next,
    knownPhasesById:
      state.knownPhasesById[id] === next.phase
        ? state.knownPhasesById
        : { ...state.knownPhasesById, [id]: next.phase },
  });
}

function mergeEndpointForwardAddresses(endpoints: readonly PluginRunEndpointResult[]): void {
  let changed = false;
  const next = { ...state.forwardAddressesById };
  for (const item of endpoints) {
    if (item.forward?.addresses) {
      next[item.forward.id] = item.forward.addresses;
      recordForwardAddresses(item.forward);
      changed = true;
    }
  }
  if (changed) {
    setState({ forwardAddressesById: next });
  }
}

function applyRunFrame(runId: number, frame: SseFrame, wasAlreadyFinished: boolean): boolean {
  const parsed = parseJson(frame.data);

  if (frame.event === "provision") {
    const prov = parseProvisionEvent(parsed);
    if (!prov) {
      return false;
    }
    updateActiveRun(runId, (prev) => ({
      ...prev,
      provisionEvents: [...prev.provisionEvents, prov],
      provisionAllocated:
        prev.provisionAllocated ||
        prov.event === "allocated" ||
        prov.event === "probed" ||
        prov.event === "ready",
      latestProvisionAtMs: Date.now(),
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "launched") {
    if (!isRecord(parsed)) {
      return false;
    }
    const session = typeof parsed.session === "string" ? parsed.session : null;
    const vmRunId = typeof parsed.run_id === "string" ? parsed.run_id : null;
    updateActiveRun(runId, (prev) => ({
      ...prev,
      launched: true,
      session: session ?? prev.session,
      runId: vmRunId ?? prev.runId,
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "status") {
    const status = parseRunStatus(parsed);
    if (!status) {
      return false;
    }
    updateActiveRun(runId, (prev) => ({
      ...prev,
      status,
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "log") {
    if (!isRecord(parsed) || !Array.isArray(parsed.lines)) {
      return false;
    }
    const lines: PluginRunLogEntry[] = [];
    for (const rawLine of parsed.lines) {
      if (typeof rawLine === "string") {
        lines.push({ kind: "line", text: stripAnsi(rawLine) });
      }
    }
    updateActiveRun(runId, (prev) => ({
      ...prev,
      logEntries: appendLogEntries(prev.logEntries, lines),
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "history_skipped") {
    updateActiveRun(runId, (prev) => ({
      ...prev,
      logEntries: appendLogEntries(prev.logEntries, [{ kind: "history_skipped" }]),
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "log_skipped") {
    if (!isRecord(parsed) || typeof parsed.path !== "string") {
      return false;
    }
    const message_key =
      typeof parsed.message_key === "string" && parsed.message_key.length > 0
        ? parsed.message_key
        : "app.b2.run_log_skipped";
    updateActiveRun(runId, (prev) => ({
      ...prev,
      logEntries: appendLogEntries(prev.logEntries, [
        { kind: "log_skipped", path: parsed.path as string, message_key },
      ]),
      streamError: null,
    }));
    return false;
  }

  if (frame.event === "finished") {
    const finished = parseFinishedEvent(parsed);
    if (!finished) {
      return false;
    }
    mergeEndpointForwardAddresses(finished.endpoints);
    updateActiveRun(runId, (prev) => ({
      ...prev,
      plugin: finished.run.plugin,
      account: finished.run.account,
      session: finished.run.session,
      provisions: finished.run.provisions,
      launched: prev.launched || finished.outcome !== null || !finished.run.provisions,
      runId: finished.outcome?.run_id ?? prev.runId,
      phase: finished.phase,
      status: finished.outcome?.status ?? prev.status,
      outcome: finished.outcome,
      endpoints: finished.endpoints,
      error: finished.error,
      streamError: null,
      finishedLive: !wasAlreadyFinished,
    }));
    setState({
      runs: state.runs.map((item) =>
        item.id === runId ? { ...item, finished: true } : item,
      ),
    });
    void webStore.refreshSnapshot().catch(() => {});
    return true;
  }

  return false;
}

function computeReconnectDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(0, attempt - 1), MAX_BACKOFF_EXPONENT);
  return Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * BACKOFF_MULTIPLIER ** exponent);
}

function connectRunStream(
  runId: number,
  wasAlreadyFinished: boolean,
  attempt: number,
  isReconnect: boolean,
): void {
  const seq = streamSeq;
  const gen = apiClient.getSessionGeneration();
  const controller = new AbortController();
  streamAbort = controller;
  let receivedFinished = false;

  void openPluginRunEventStream(runId, {
    signal: controller.signal,
    onOpen: () => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (isReconnect) {
        // The server journal replays from offset 0 on each subscription, so reset buffered replay
        // state on reconnect to prevent duplicate progress rows or log lines.
        updateActiveRun(runId, (prev) => ({
          ...prev,
          provisionEvents: [],
          logEntries: [],
          streamError: null,
        }));
      } else {
        updateActiveRun(runId, (prev) => ({
          ...prev,
          streamError: null,
        }));
      }
    },
    onFrame: (frame) => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (applyRunFrame(runId, frame, wasAlreadyFinished)) {
        receivedFinished = true;
      }
    },
  })
    .then(() => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (streamAbort === controller) {
        streamAbort = null;
      }
      if (receivedFinished || state.activeRun?.phase !== "running") {
        activeStreamRunId = null;
        return;
      }
      const nextAttempt = attempt + 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
          return;
        }
        connectRunStream(runId, false, nextAttempt, true);
      }, computeReconnectDelayMs(nextAttempt));
    })
    .catch((error: unknown) => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (streamAbort === controller) {
        streamAbort = null;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        activeStreamRunId = null;
        updateActiveRun(runId, (prev) => ({
          ...prev,
          streamError: error,
        }));
        return;
      }
      if (receivedFinished || state.activeRun?.phase !== "running") {
        activeStreamRunId = null;
        return;
      }
      updateActiveRun(runId, (prev) => ({
        ...prev,
        streamError: error,
      }));
      const nextAttempt = attempt + 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
          return;
        }
        connectRunStream(runId, false, nextAttempt, true);
      }, computeReconnectDelayMs(nextAttempt));
    });
}

function attachRun(summary: PluginRunSummary): void {
  if (
    state.selectedRunId === summary.id &&
    state.activeRun?.id === summary.id &&
    (activeStreamRunId === summary.id || state.activeRun.phase !== "running")
  ) {
    return;
  }
  stopStream();
  activeStreamRunId = summary.id;
  const detail = createInitialDetail(summary);
  setState({
    selectedRunId: summary.id,
    activeRun: detail,
    knownPhasesById:
      summary.finished && state.knownPhasesById[summary.id]
        ? state.knownPhasesById
        : { ...state.knownPhasesById, [summary.id]: "running" },
  });
  connectRunStream(summary.id, summary.finished, 0, false);
}

/**
 * Fetches `/api/plugins/runs` and auto-attaches to the newest run when none is open
 * and the user has not explicitly backed out of that run ID.
 */
export function refreshPluginRuns(options?: {
  readonly autoAttach?: boolean;
}): Promise<PluginRunSummary[]> {
  if (runsListInFlight) {
    return runsListInFlight;
  }
  const autoAttach = options?.autoAttach ?? true;
  const gen = apiClient.getSessionGeneration();
  setState({ runsLoading: true, runsError: null });

  const promise = listPluginRuns()
    .then((runs) => {
      if (apiClient.getSessionGeneration() !== gen) {
        return runs;
      }
      setState({
        runs,
        runsLoading: false,
        runsError: null,
      });

      const newest = runs[0] ?? null;
      if (autoAttach && newest) {
        if (state.selectedRunId === null && newest.id > dismissedAutoRunId) {
          attachRun(newest);
        } else if (
          state.selectedRunId !== null &&
          !runs.some((item) => item.id === state.selectedRunId)
        ) {
          // Selected run expired from server history while away; fall back cleanly.
          if (state.activeRun?.phase === "running") {
            stopStream();
            setState({ selectedRunId: null, activeRun: null });
          }
        }
      }
      return runs;
    })
    .catch((error: unknown) => {
      if (apiClient.getSessionGeneration() === gen && !(error instanceof ApiError && error.isAbort)) {
        setState({ runsLoading: false, runsError: error });
      }
      return state.runs as PluginRunSummary[];
    })
    .finally(() => {
      if (runsListInFlight === promise) {
        runsListInFlight = null;
      }
    });

  runsListInFlight = promise;
  return promise;
}

/**
 * Opens a specific run detail view by ID. Also serves as the direct entry seam for #50
 * after `POST /api/plugins/runs` returns an accepted run ID.
 */
export function openPluginRun(id: number, fallbackSummary?: PluginRunSummary): void {
  const existing = state.runs.find((item) => item.id === id) ?? fallbackSummary ?? null;
  if (existing) {
    attachRun(existing);
    return;
  }
  void refreshPluginRuns({ autoAttach: false }).then((runs) => {
    const matched = runs.find((item) => item.id === id);
    if (matched) {
      attachRun(matched);
    }
  });
}

/**
 * Returns to the Plugins list view and suppresses immediate auto-reopen for the latest run
 * until a newer run ID appears or the user clicks "Show".
 */
export function showPluginList(): void {
  const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
  dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
  stopStream();
  setState({ selectedRunId: null });
}

/**
 * Requests cancellation of the currently viewed running plugin job.
 */
export async function requestCancelPluginRun(id: number): Promise<void> {
  const gen = apiClient.getSessionGeneration();
  updateActiveRun(id, (prev) => ({
    ...prev,
    cancelRequested: true,
  }));
  try {
    await cancelPluginRun(id);
  } catch (error) {
    if (apiClient.getSessionGeneration() === gen) {
      updateActiveRun(id, (prev) => ({
        ...prev,
        cancelRequested: false,
      }));
    }
    throw error;
  }
}

/**
 * Caches server-validated forward addresses returned by `POST /api/forwards` for instant
 * endpoint link updates, mirroring them into the shared Sessions store as well.
 */
export function cachePluginForwardAddresses(view: ForwardView): void {
  if (!view.addresses) {
    return;
  }
  forwardsSeq += 1;
  forwardsInFlight = null;
  recordForwardAddresses(view);
  setState({
    forwardAddressesById: {
      ...state.forwardAddressesById,
      [view.id]: view.addresses,
    },
  });
}

/**
 * Pulls `/api/forwards` to hydrate server-validated addresses for any live tunnel
 * whose addresses are not yet cached locally.
 */
export function refreshPluginForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  if (forwardsInFlight) {
    return forwardsInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const seq = ++forwardsSeq;
  const promise = fetchForwards(signal)
    .then((list) => {
      if (apiClient.getSessionGeneration() === gen && seq === forwardsSeq) {
        const next: Record<number, ForwardAddresses> = { ...state.forwardAddressesById };
        for (const fw of list) {
          if (fw.addresses) {
            next[fw.id] = fw.addresses;
            recordForwardAddresses(fw);
          }
        }
        setState({ forwardAddressesById: next });
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

/**
 * Advances the local snapshot version cursor so live SSE `forward` overlays stay aligned
 * with the current `snapshot.version` even when `SessionsPage` is not mounted.
 */
export function syncPluginSnapshotVersion(version: number): void {
  if (version <= state.latestSnapshotVersion) {
    return;
  }
  setState({
    latestSnapshotVersion: version,
    forwardOverlaysById:
      Object.keys(state.forwardOverlaysById).length > 0 ? {} : state.forwardOverlaysById,
  });
}

/**
 * Applies a live `forward` SSE transition over the current snapshot version.
 */
export function applyPluginForwardEvent(event: TunnelEvent): void {
  const prev = state.forwardOverlaysById[event.id];
  const base: ForwardLiveOverlay =
    prev && prev.snapshotVersion === state.latestSnapshotVersion
      ? prev
      : { snapshotVersion: state.latestSnapshotVersion };
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PluginRunsStoreState {
  return state;
}

export function usePluginRunsStore(): PluginRunsStoreState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
