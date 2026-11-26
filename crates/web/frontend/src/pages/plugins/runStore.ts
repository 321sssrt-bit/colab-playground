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
import { forwardsStore } from "../../lib/forwards.ts";
import { routerStore } from "../../lib/router.ts";
import type { SseFrame } from "../../lib/sse.ts";
import { webStore } from "../../lib/store.ts";
import type { ApiErrorPayload, ForwardView } from "../../lib/types.ts";
import type { ProvisionProgressEvent } from "../sessions/api.ts";
import { cancelPluginRun, listPluginRuns, openPluginRunEventStream } from "./api.ts";
import { stripAnsi } from "./endpoint.ts";
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
  readonly selectedRunId: number | null;
  readonly selectedFormPluginId: string | null;
  readonly formOpenSeq: number;
  readonly activeRun: PluginRunDetail | null;
  readonly knownPhasesById: Readonly<Record<number, PluginRunPhase>>;
  readonly endpointForwardIdsByKey: Readonly<Record<string, number | null>>;
}

const INITIAL_STATE: PluginRunsStoreState = {
  runs: [],
  selectedRunId: null,
  selectedFormPluginId: null,
  formOpenSeq: 0,
  activeRun: null,
  knownPhasesById: {},
  endpointForwardIdsByKey: {},
};

let state: PluginRunsStoreState = INITIAL_STATE;
let dismissedAutoRunId = 0;
let highestSeenRunId = 0;
let pendingAutoAttach = false;
let runsListInFlight: Promise<PluginRunSummary[]> | null = null;
let runsListSeq = 0;
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
  highestSeenRunId = 0;
  pendingAutoAttach = false;
  runsListInFlight = null;
  runsListSeq += 1;
  state = INITIAL_STATE;
  emit();
}

apiClient.subscribeAuth((event) => {
  if (event.type === "logged_out" || event.type === "unauthorized") {
    resetStore();
  }
});

// Clear an open deploy form when leaving `#/plugins` so returning via the sidebar
// lands on the plugin list instead of reopening a discarded form.
routerStore.subscribe(() => {
  if (routerStore.getRoute() !== "plugins" && state.selectedFormPluginId !== null) {
    closePluginDeployForm();
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
  const dropCount = combined.length - (MAX_LOG_ENTRIES - 1);
  let droppedLogSkipped: Extract<PluginRunLogEntry, { readonly kind: "log_skipped" }> | null = null;
  for (let i = 0; i < dropCount; i += 1) {
    const entry = combined[i];
    if (entry?.kind === "log_skipped") {
      droppedLogSkipped = entry;
    }
  }
  const tail = combined.slice(dropCount);
  const tailHasLogSkipped = tail.some((entry) => entry.kind === "log_skipped");
  const pinned: PluginRunLogEntry[] = [];
  if (tail[0]?.kind !== "history_skipped") {
    pinned.push({ kind: "history_skipped" });
  }
  if (droppedLogSkipped && !tailHasLogSkipped) {
    pinned.push(droppedLogSkipped);
  }
  const maxTailLen = Math.max(0, MAX_LOG_ENTRIES - pinned.length);
  const trimmedTail = tail.length > maxTailLen ? tail.slice(tail.length - maxTailLen) : tail;
  return [...pinned, ...trimmedTail];
}

function endpointForwardKey(runId: number, endpointId: string): string {
  return `${runId}:${endpointId}`;
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
    phase: "running",
    provisionEvents: [],
    latestProvisionAtMs: Date.now(),
    status: null,
    logEntries: [],
    logSkipped: null,
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

function mergeEndpointResults(runId: number, endpoints: readonly PluginRunEndpointResult[]): void {
  let idChanged = false;
  const nextIds = { ...state.endpointForwardIdsByKey };
  for (const item of endpoints) {
    const key = endpointForwardKey(runId, item.endpoint.id);
    const serverForwardId = item.forward?.id ?? null;
    if (!Object.hasOwn(nextIds, key)) {
      nextIds[key] = serverForwardId;
      idChanged = true;
    }
    if (item.forward?.addresses) {
      forwardsStore.recordForward(item.forward);
    }
  }
  if (idChanged) {
    setState({ endpointForwardIdsByKey: nextIds });
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
    updateActiveRun(runId, (prev) => ({
      ...prev,
      launched: true,
      session: session ?? prev.session,
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
    const path = parsed.path as string;
    updateActiveRun(runId, (prev) => {
      const alreadyPresent = prev.logEntries.some(
        (entry) =>
          entry.kind === "log_skipped" &&
          entry.path === path &&
          entry.message_key === message_key,
      );
      return {
        ...prev,
        logSkipped: { path, message_key },
        logEntries: alreadyPresent
          ? prev.logEntries
          : appendLogEntries(prev.logEntries, [{ kind: "log_skipped", path, message_key }]),
        streamError: null,
      };
    });
    return false;
  }

  if (frame.event === "finished") {
    const finished = parseFinishedEvent(parsed);
    if (!finished) {
      return false;
    }
    mergeEndpointResults(runId, finished.endpoints);
    updateActiveRun(runId, (prev) => ({
      ...prev,
      plugin: finished.run.plugin,
      account: finished.run.account,
      session: finished.run.session,
      provisions: finished.run.provisions,
      launched: prev.launched || finished.outcome !== null || !finished.run.provisions,
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

  let resetPendingForReconnect = isReconnect;

  void openPluginRunEventStream(runId, {
    signal: controller.signal,
    onOpen: () => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      updateActiveRun(runId, (prev) => ({
        ...prev,
        streamError: null,
      }));
    },
    onFrame: (frame) => {
      if (seq !== streamSeq || apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (resetPendingForReconnect) {
        resetPendingForReconnect = false;
        // Wait until the first replayed frame arrives before replacing buffered logs so a
        // transient drop never leaves the log pane empty; preserve completed provisioning
        // history and any previously seen `log_skipped` path notice across journal rollovers.
        updateActiveRun(runId, (prev) => ({
          ...prev,
          provisionEvents: prev.launched ? prev.provisionEvents : [],
          logEntries:
            frame.event === "history_skipped"
              ? prev.logEntries
              : prev.logSkipped
                ? [{ kind: "log_skipped", ...prev.logSkipped }]
                : [],
        }));
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
  // Invalidate any pre-submit `/api/plugins/runs` fetch so a delayed stale list cannot drop this run.
  runsListSeq += 1;
  runsListInFlight = null;
  highestSeenRunId = Math.max(highestSeenRunId, summary.id);
  const runs = state.runs.some((item) => item.id === summary.id)
    ? state.runs
    : [summary, ...state.runs];
  if (
    state.selectedRunId === summary.id &&
    state.activeRun?.id === summary.id &&
    (activeStreamRunId === summary.id || state.activeRun.phase !== "running")
  ) {
    if (state.selectedFormPluginId !== null || runs !== state.runs) {
      setState({ selectedFormPluginId: null, runs });
    }
    return;
  }
  stopStream();
  activeStreamRunId = summary.id;
  const detail = createInitialDetail(summary);
  setState({
    runs,
    selectedRunId: summary.id,
    selectedFormPluginId: null,
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
  const autoAttach = (options?.autoAttach ?? true) && state.selectedFormPluginId === null;
  pendingAutoAttach = pendingAutoAttach || autoAttach;
  if (runsListInFlight) {
    return runsListInFlight;
  }
  const gen = apiClient.getSessionGeneration();
  const seq = ++runsListSeq;

  const promise = listPluginRuns()
    .then((runs) => {
      if (apiClient.getSessionGeneration() !== gen || seq !== runsListSeq) {
        return state.runs as PluginRunSummary[];
      }
      const shouldConsiderAutoAttach = pendingAutoAttach;
      pendingAutoAttach = false;
      setState({ runs });

      const newest = runs[0] ?? null;
      if (shouldConsiderAutoAttach && newest) {
        const isBrandNewRun = newest.id > highestSeenRunId;
        const shouldAutoAttach =
          newest.id > dismissedAutoRunId &&
          state.selectedFormPluginId === null &&
          (state.selectedRunId === null ||
            (isBrandNewRun &&
              newest.id > state.selectedRunId &&
              (!newest.finished || state.activeRun?.phase !== "running")));
        highestSeenRunId = Math.max(highestSeenRunId, newest.id);
        if (shouldAutoAttach) {
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
      } else if (newest) {
        highestSeenRunId = Math.max(highestSeenRunId, newest.id);
      }
      return runs;
    })
    .catch(() => {
      if (seq === runsListSeq) {
        pendingAutoAttach = false;
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
 * Opens the dynamic deploy form for `pluginId` (used by Plugins cards, Run Again,
 * and Overview quick-deploy entry points). Suppresses auto-reopen of older runs so
 * navigating to `#/plugins` lands directly on the form.
 */
export function openPluginDeployForm(pluginId: string): void {
  const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
  dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
  pendingAutoAttach = false;
  stopStream();
  setState({
    selectedRunId: null,
    selectedFormPluginId: pluginId,
    formOpenSeq: state.formOpenSeq + 1,
  });
}

/**
 * Closes the dynamic deploy form and returns to the Plugins list view.
 */
export function closePluginDeployForm(): void {
  if (state.selectedFormPluginId === null) {
    return;
  }
  const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
  dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
  pendingAutoAttach = false;
  setState({ selectedFormPluginId: null });
}

/**
 * Returns to the Plugins list view and suppresses immediate auto-reopen for the latest run
 * until a newer run ID appears or the user clicks "Show".
 */
export function showPluginList(): void {
  const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
  dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
  stopStream();
  setState({ selectedRunId: null, selectedFormPluginId: null });
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
 * Records the exact tunnel ID currently bound to one endpoint card (`null` when closed).
 */
export function setEndpointForwardId(
  runId: number,
  endpointId: string,
  forwardId: number | null,
): void {
  const key = endpointForwardKey(runId, endpointId);
  if (state.endpointForwardIdsByKey[key] === forwardId) {
    return;
  }
  setState({
    endpointForwardIdsByKey: {
      ...state.endpointForwardIdsByKey,
      [key]: forwardId,
    },
  });
}

/**
 * Caches server-validated forward addresses returned by `POST /api/forwards`
 * in the global `forwardsStore`.
 */
export function cachePluginForwardAddresses(view: ForwardView): void {
  forwardsStore.recordForward(view);
}

/**
 * Pulls `/api/forwards` via the global `forwardsStore` to hydrate server-validated addresses.
 */
export function refreshPluginForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  return forwardsStore.refresh(signal);
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
