/**
 * Session-scoped store for Plugin runs, post-failure billing verification cache,
 * persistent deploy form drafts, and non-disconnecting SSE run streams.
 *
 * Key guarantees aligned with upstream `crates/app/src/state/runs.rs`:
 * - Leaving the run detail view or opening a deploy form never disconnects an active
 *   plugin run SSE stream; background streams keep updating `phase`, `logs`, and emit
 *   the global `ready` toast exactly once per run regardless of active route.
 * - Post-failure/cancel billing verification isolates `checking` (never falling back
 *   to a stale pre-failure snapshot) and caches results across route switches.
 * - Deploy form drafts (non-secret values, provision options, HF lookup, and the
 *   initial `originAccountContext` lock) survive route switches and clear only on
 *   explicit Back, successful submit, or auth session reset.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient } from "../../lib/api.ts";
import { appDataStore, type AppDataStore } from "../../lib/appCache.ts";
import { forwardsStore, type ForwardsStore } from "../../lib/forwards.ts";
import { i18nStore, type TranslateFn } from "../../lib/i18n.ts";
import type { SseFrame } from "../../lib/sse.ts";
import { webStore, type WebStore } from "../../lib/store.ts";
import { toastStore, type ToastStore } from "../../lib/toast.ts";
import type {
  AccountContext,
  ApiErrorPayload,
  ForwardView,
  Locale,
  RuntimeRef,
  SessionsListResponse,
  Snapshot,
} from "../../lib/types.ts";
import type { ProvisionProgressEvent } from "../sessions/api.ts";
import {
  cancelPluginRun as apiCancelPluginRun,
  fetchPluginRunTemplate as apiFetchPluginRunTemplate,
  listPluginRuns as apiListPluginRuns,
  openPluginRunEventStream as apiOpenPluginRunEventStream,
  startPluginRun as apiStartPluginRun,
} from "./api.ts";
import { stripAnsi } from "./endpoint.ts";
import { pluginCacheStore, type PluginCacheStore } from "./pluginCache.ts";
import type {
  PluginDeployFormDraft,
  PluginInfo,
  PluginRunBillingCheck,
  PluginRunBillingState,
  PluginRunDetail,
  PluginRunEndpointResult,
  PluginRunFinishedEvent,
  PluginRunLogEntry,
  PluginRunOutcome,
  PluginRunPhase,
  PluginRunState,
  PluginRunStatus,
  PluginRunSummary,
  PluginRunTemplateSpec,
  StartPluginRunRequest,
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
  readonly detailsById: Readonly<Record<number, PluginRunDetail>>;
  readonly knownPhasesById: Readonly<Record<number, PluginRunPhase>>;
  readonly billingChecksByRunId: Readonly<Record<number, PluginRunBillingCheck>>;
  readonly endpointForwardIdsByKey: Readonly<Record<string, number | null>>;
  readonly deployDraft: PluginDeployFormDraft | null;
}

export interface PluginRunsStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly appData?: AppDataStore;
  readonly forwards?: ForwardsStore;
  readonly pluginCache?: PluginCacheStore;
  readonly toast?: ToastStore;
  readonly t?: TranslateFn;
  readonly getLocale?: () => Locale;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export type DeployTemplateMapper = (
  template: PluginRunTemplateSpec,
) => Pick<
  PluginDeployFormDraft,
  | "textValues"
  | "boolValues"
  | "baseProvisionSpec"
  | "provisionDraft"
  | "sessionName"
  | "retryDelaySecs"
  | "stopOnFailure"
>;

export interface PluginRunsStore {
  getState(): PluginRunsStoreState;
  subscribe(listener: () => void): () => void;
  setLocale(locale: Locale): void;
  refreshPluginRuns(options?: { readonly autoAttach?: boolean }): Promise<PluginRunSummary[]>;
  openPluginRun(id: number, fallbackSummary?: PluginRunSummary): void;
  openPluginDeployForm(pluginId: string): void;
  closePluginDeployForm(): void;
  showPluginList(): void;
  requestCancelPluginRun(id: number): Promise<void>;
  verifyRunBilling(
    runId: number,
    options?: { readonly force?: boolean },
  ): Promise<PluginRunBillingCheck | null>;
  loadDeployFormTemplate(
    pluginId: string,
    openSeq: number,
    mapTemplate: DeployTemplateMapper,
    options?: { readonly force?: boolean },
  ): Promise<void>;
  updateDeployDraft(
    updater: (prev: PluginDeployFormDraft) => PluginDeployFormDraft,
  ): void;
  latchDeployOriginAccountContext(snapshotAccount: AccountContext | null): void;
  reconcileDeployTarget(snapshot: Snapshot | null): void;
  stashDeploySecrets(
    pluginId: string,
    openSeq: number,
    entries: readonly (readonly [string, string])[],
  ): void;
  takeStashedDeploySecrets(
    pluginId: string,
    openSeq: number,
  ): ReadonlyMap<string, string> | null;
  clearStashedDeploySecrets(): void;
  setEndpointForwardId(runId: number, endpointId: string, forwardId: number | null): void;
  cachePluginForwardAddresses(view: ForwardView): void;
  refreshPluginForwards(signal?: AbortSignal): Promise<ForwardView[]>;
  isStreamActive(runId: number): boolean;
  hasToastedReadyRun(runId: number): boolean;
  dispose(): void;
}

const INITIAL_STATE: PluginRunsStoreState = {
  runs: [],
  selectedRunId: null,
  selectedFormPluginId: null,
  formOpenSeq: 0,
  activeRun: null,
  detailsById: {},
  knownPhasesById: {},
  billingChecksByRunId: {},
  endpointForwardIdsByKey: {},
  deployDraft: null,
};

interface StreamHandle {
  seq: number;
  abort: AbortController | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

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

function isRunPhase(value: unknown): value is PluginRunPhase {
  return value === "running" || value === "ready" || value === "cancelled" || value === "failed";
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

function computeReconnectDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(0, attempt - 1), MAX_BACKOFF_EXPONENT);
  return Math.min(MAX_RECONNECT_DELAY_MS, INITIAL_RECONNECT_DELAY_MS * BACKOFF_MULTIPLIER ** exponent);
}

function extractPluginRunOpIds(snapshot: Snapshot | null): string {
  if (!snapshot) {
    return "";
  }
  return snapshot.operations
    .filter(({ operation }) => operation.kind === "plugin_run")
    .map((op) => op.id)
    .join(",");
}

/**
 * Latches the initial non-null active `AccountContext` for a deploy form draft so
 * subsequent account switches never silently re-target billing to a new account.
 */
export function resolveDeployOriginAccountContext(
  currentOrigin: AccountContext | null,
  snapshotAccount: AccountContext | null,
): AccountContext | null {
  if (currentOrigin !== null && currentOrigin.active !== null) {
    return currentOrigin;
  }
  if (snapshotAccount !== null && snapshotAccount.active !== null) {
    return snapshotAccount;
  }
  return currentOrigin;
}

/**
 * Returns true only when the plugin is present, enabled, and the server is not shutting down.
 * Prevents "Run again" from opening a dead form for a disabled or removed plugin.
 */
export function canRunPluginAgain(
  plugin: PluginInfo | null | undefined,
  shuttingDown: boolean,
): boolean {
  return !shuttingDown && plugin !== null && plugin !== undefined && plugin.enabled;
}

export interface SubmitPluginDeployRunParams {
  readonly originAccountContext: AccountContext;
  readonly spec: PluginRunTemplateSpec;
  readonly existing: RuntimeRef | null;
  readonly resolvedSessionName: string;
  readonly clearSecrets: () => void;
  readonly signal?: AbortSignal;
  readonly client?: ApiClient;
}

/**
 * Submits a plugin deploy request strictly locked to `originAccountContext` and clears
 * secret inputs only after the server accepts the run (keeping entered secrets on failure).
 */
export async function submitPluginDeployRun(
  params: SubmitPluginDeployRunParams,
): Promise<{ readonly id: number; readonly summary: PluginRunSummary }> {
  const requestPayload: StartPluginRunRequest = {
    account_context: params.originAccountContext,
    spec: params.spec,
    existing: params.existing,
  };
  const accepted = await apiStartPluginRun(
    requestPayload,
    params.signal,
    params.client ?? apiClient,
  );
  params.clearSecrets();
  return {
    id: accepted.id,
    summary: {
      id: accepted.id,
      plugin: params.spec.plugin,
      account: params.originAccountContext.active ?? "",
      session: params.resolvedSessionName,
      provisions: params.existing === null,
      finished: false,
      phase: "running",
    },
  };
}

/**
 * Pure billing-verification state resolver for failed or cancelled plugin runs.
 *
 * Strictly isolates `checking` (never falling back to a stale pre-failure snapshot) and
 * overlays a newer clean SSE `Snapshot` (`snapshot.version > billingCheck.snapshotVersion`)
 * so stops performed from Sessions or by the Cost Guard clear immediately without re-querying.
 */
export function resolvePluginRunBillingState(
  run: Pick<
    PluginRunDetail,
    "id" | "account" | "session" | "provisions" | "launched" | "provisionAllocated"
  >,
  billingCheck: PluginRunBillingCheck | undefined,
  snapshot: Snapshot | null,
): PluginRunBillingState {
  if (!billingCheck || billingCheck.runId !== run.id || billingCheck.status === "checking") {
    return { phase: "checking", runtime: null };
  }

  const snapshotRuntime =
    snapshot?.runtimes?.runtimes.find(
      (rt) => rt.id.account === run.account && rt.id.name === run.session,
    ) ?? null;
  const snapshotErroredForAccount =
    snapshot?.runtimes_error !== null ||
    Boolean(snapshot?.runtimes?.errors.some((err) => err.account === run.account));
  const snapshotNewerThanVerify =
    snapshot !== null &&
    snapshot.version > billingCheck.snapshotVersion &&
    snapshot.runtimes !== null &&
    !snapshotErroredForAccount;

  if (billingCheck.status === "error") {
    if (!snapshotNewerThanVerify) {
      return { phase: "unknown", runtime: null };
    }
    if (snapshotRuntime) {
      return { phase: "billing", runtime: snapshotRuntime };
    }
    return {
      phase: run.provisions && !run.launched && !run.provisionAllocated ? "no_session" : "stopped",
      runtime: null,
    };
  }

  const verifiedRuntime = snapshotNewerThanVerify ? snapshotRuntime : billingCheck.runtime;
  if (verifiedRuntime) {
    return { phase: "billing", runtime: verifiedRuntime };
  }
  if (billingCheck.accountErrored && !snapshotNewerThanVerify) {
    return { phase: "unknown", runtime: null };
  }
  if (run.provisions && !run.launched && !run.provisionAllocated) {
    return { phase: "no_session", runtime: null };
  }
  return { phase: "stopped", runtime: null };
}

function createEmptyDeployDraft(
  pluginId: string,
  openSeq: number,
  originAccountContext: AccountContext | null,
): PluginDeployFormDraft {
  return {
    pluginId,
    openSeq,
    loadPhase: "loading",
    loadError: null,
    textValues: {},
    boolValues: {},
    baseProvisionSpec: null,
    provisionDraft: null,
    sessionName: "",
    retryDelaySecs: 0,
    stopOnFailure: true,
    selectedExisting: null,
    targetLost: null,
    originAccountContext,
    hfByInputId: {},
  };
}

/**
 * Creates an isolated plugin runs, billing verification, and deploy draft store.
 */
export function createPluginRunsStore(options: PluginRunsStoreOptions = {}): PluginRunsStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const appData = options.appData ?? appDataStore;
  const forwards = options.forwards ?? forwardsStore;
  const pluginCache = options.pluginCache ?? pluginCacheStore;
  const toast = options.toast ?? toastStore;
  const t = options.t ?? i18nStore.t;
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

  let currentLocale: Locale = options.getLocale ? options.getLocale() : "en-US";
  const resolveLocale = (): Locale => (options.getLocale ? options.getLocale() : currentLocale);

  let state: PluginRunsStoreState = INITIAL_STATE;
  let disposed = false;
  let dismissedAutoRunId = 0;
  let highestSeenRunId = 0;
  let pendingAutoAttach = false;
  let runsListInFlight: Promise<PluginRunSummary[]> | null = null;
  let runsListSeq = 0;
  let globalStreamSeq = 0;
  let prevPluginRunOpIds = extractPluginRunOpIds(store.getState().snapshot);

  const streamsByRunId = new Map<number, StreamHandle>();
  const toastedReadyRunIds = new Set<number>();
  const submittedLiveRunIds = new Set<number>();
  const billingInFlightByRunId = new Map<number, Promise<PluginRunBillingCheck | null>>();
  const billingSeqByRunId = new Map<number, number>();
  // Volatile, non-serialized in-memory handoff for masked secret inputs across route switches
  // while the same deploy draft stays open (never enters React state or `deployDraft`).
  let stashedDeploySecrets: {
    readonly pluginId: string;
    readonly openSeq: number;
    readonly values: Map<string, string>;
  } | null = null;
  let templateInFlight: {
    readonly key: string;
    readonly generation: number;
    readonly controller: AbortController;
    readonly promise: Promise<void>;
  } | null = null;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so every Plugins consumer receives updates.
      }
    }
  };

  const setState = (patch: Partial<PluginRunsStoreState>): void => {
    const nextBase: PluginRunsStoreState = { ...state, ...patch };
    const nextActiveRun =
      nextBase.selectedRunId !== null ? (nextBase.detailsById[nextBase.selectedRunId] ?? null) : null;
    state =
      nextBase.activeRun === nextActiveRun
        ? nextBase
        : { ...nextBase, activeRun: nextActiveRun };
    emit();
  };

  const stopStreamForRun = (runId: number): void => {
    const handle = streamsByRunId.get(runId);
    if (!handle) {
      return;
    }
    handle.seq += 1;
    if (handle.reconnectTimer !== null) {
      clearTimer(handle.reconnectTimer);
      handle.reconnectTimer = null;
    }
    if (handle.abort !== null) {
      handle.abort.abort();
      handle.abort = null;
    }
    streamsByRunId.delete(runId);
  };

  const stopAllStreams = (): void => {
    globalStreamSeq += 1;
    for (const handle of streamsByRunId.values()) {
      handle.seq += 1;
      if (handle.reconnectTimer !== null) {
        clearTimer(handle.reconnectTimer);
        handle.reconnectTimer = null;
      }
      if (handle.abort !== null) {
        handle.abort.abort();
        handle.abort = null;
      }
    }
    streamsByRunId.clear();
  };

  const abortTemplateInFlight = (): void => {
    templateInFlight?.controller.abort();
    templateInFlight = null;
  };

  const resetStore = (): void => {
    stopAllStreams();
    abortTemplateInFlight();
    dismissedAutoRunId = 0;
    highestSeenRunId = 0;
    pendingAutoAttach = false;
    runsListInFlight = null;
    runsListSeq += 1;
    prevPluginRunOpIds = "";
    toastedReadyRunIds.clear();
    submittedLiveRunIds.clear();
    billingInFlightByRunId.clear();
    billingSeqByRunId.clear();
    stashedDeploySecrets = null;
    state = INITIAL_STATE;
    emit();
  };

  const updateRunDetail = (
    id: number,
    updater: (prev: PluginRunDetail) => PluginRunDetail,
  ): void => {
    const current = state.detailsById[id];
    if (!current) {
      return;
    }
    const next = updater(current);
    if (next === current) {
      return;
    }
    setState({
      detailsById: {
        ...state.detailsById,
        [id]: next,
      },
      knownPhasesById:
        state.knownPhasesById[id] === next.phase
          ? state.knownPhasesById
          : { ...state.knownPhasesById, [id]: next.phase },
    });
  };

  const mergeEndpointResults = (
    runId: number,
    endpoints: readonly PluginRunEndpointResult[],
  ): void => {
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
        forwards.recordForward(item.forward);
      }
    }
    if (idChanged) {
      setState({ endpointForwardIdsByKey: nextIds });
    }
  };

  const verifyRunBilling = (
    runId: number,
    opts?: { readonly force?: boolean },
  ): Promise<PluginRunBillingCheck | null> => {
    const force = opts?.force === true;
    const detail = state.detailsById[runId] ?? null;
    const summary = state.runs.find((item) => item.id === runId) ?? null;
    const targetAccount = detail?.account ?? summary?.account ?? null;
    const targetSession = detail?.session ?? summary?.session ?? null;

    if (targetAccount === null || targetSession === null) {
      return Promise.resolve(null);
    }

    if (!force) {
      const inflight = billingInFlightByRunId.get(runId);
      if (inflight) {
        return inflight;
      }
      if (Object.hasOwn(state.billingChecksByRunId, runId)) {
        return Promise.resolve(state.billingChecksByRunId[runId]);
      }
    }

    const seq = (billingSeqByRunId.get(runId) ?? 0) + 1;
    billingSeqByRunId.set(runId, seq);
    const gen = client.getSessionGeneration();

    const checkingEntry: PluginRunBillingCheck = {
      runId,
      status: "checking",
      runtime: null,
      accountErrored: false,
      snapshotVersion: store.getState().snapshot?.version ?? 0,
    };
    setState({
      billingChecksByRunId: {
        ...state.billingChecksByRunId,
        [runId]: checkingEntry,
      },
    });

    const fetchPostFinishSessions = async (): Promise<SessionsListResponse> => {
      // If a `/api/sessions` listing was already in flight before the run finished, wait for it
      // to settle and then start a fresh post-finish request so a pre-failure empty list cannot
      // hide a still-billing VM.
      if (appData.getState?.().sessionsRefreshing === true) {
        await appData.refreshSessions().catch(() => {});
        if (
          disposed ||
          client.getSessionGeneration() !== gen ||
          billingSeqByRunId.get(runId) !== seq
        ) {
          throw new ApiError({
            status: 0,
            kind: "cancelled",
            message: "billing verification superseded",
            isAbort: true,
          });
        }
      }
      return appData.refreshSessions();
    };

    const promise = fetchPostFinishSessions()
      .then((sessions): PluginRunBillingCheck | null => {
        if (
          disposed ||
          client.getSessionGeneration() !== gen ||
          billingSeqByRunId.get(runId) !== seq
        ) {
          return null;
        }
        const matched =
          sessions.runtimes.find(
            (rt) => rt.id.account === targetAccount && rt.id.name === targetSession,
          ) ?? null;
        const accountErrored = sessions.errors.some((err) => err.account === targetAccount);
        const verifiedEntry: PluginRunBillingCheck = {
          runId,
          status: "verified",
          runtime: matched,
          accountErrored,
          snapshotVersion: store.getState().snapshot?.version ?? 0,
        };
        setState({
          billingChecksByRunId: {
            ...state.billingChecksByRunId,
            [runId]: verifiedEntry,
          },
        });
        return verifiedEntry;
      })
      .catch((error: unknown): PluginRunBillingCheck | null => {
        if (
          disposed ||
          client.getSessionGeneration() !== gen ||
          billingSeqByRunId.get(runId) !== seq ||
          (error instanceof ApiError && (error.isAbort || error.isUnauthorized))
        ) {
          return null;
        }
        const errorEntry: PluginRunBillingCheck = {
          runId,
          status: "error",
          runtime: null,
          accountErrored: true,
          snapshotVersion: store.getState().snapshot?.version ?? 0,
        };
        setState({
          billingChecksByRunId: {
            ...state.billingChecksByRunId,
            [runId]: errorEntry,
          },
        });
        return errorEntry;
      })
      .finally(() => {
        if (billingInFlightByRunId.get(runId) === promise) {
          billingInFlightByRunId.delete(runId);
        }
      });

    billingInFlightByRunId.set(runId, promise);
    return promise;
  };

  const announceReadyOnce = (runId: number, pluginId: string): void => {
    if (toastedReadyRunIds.has(runId)) {
      return;
    }
    toastedReadyRunIds.add(runId);
    const name = pluginCache.resolvePluginName(pluginId, resolveLocale());
    toast.push({
      tone: "success",
      body: t("app.b2.run_ready_toast", { name }),
    });
  };

  const applyRunFrame = (
    runId: number,
    frame: SseFrame,
    wasAlreadyFinished: boolean,
  ): boolean => {
    const parsed = parseJson(frame.data);

    if (frame.event === "provision") {
      const prov = parseProvisionEvent(parsed);
      if (!prov) {
        return false;
      }
      updateRunDetail(runId, (prev) => ({
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
      updateRunDetail(runId, (prev) => ({
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
      updateRunDetail(runId, (prev) => ({
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
      updateRunDetail(runId, (prev) => ({
        ...prev,
        logEntries: appendLogEntries(prev.logEntries, lines),
        streamError: null,
      }));
      return false;
    }

    if (frame.event === "history_skipped") {
      updateRunDetail(runId, (prev) => ({
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
      const path = parsed.path;
      updateRunDetail(runId, (prev) => {
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
      const isLiveCompletion = !wasAlreadyFinished || submittedLiveRunIds.has(runId);
      mergeEndpointResults(runId, finished.endpoints);
      updateRunDetail(runId, (prev) => ({
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
        finishedLive: isLiveCompletion,
      }));
      setState({
        runs: state.runs.map((item) =>
          item.id === runId
            ? {
                ...item,
                session: finished.run.session,
                account: finished.run.account,
                finished: true,
                phase: finished.phase,
              }
            : item,
        ),
        knownPhasesById: {
          ...state.knownPhasesById,
          [runId]: finished.phase,
        },
      });
      if (finished.phase === "ready" && isLiveCompletion) {
        announceReadyOnce(runId, finished.run.plugin);
      } else if (
        (finished.phase === "failed" || finished.phase === "cancelled") &&
        isLiveCompletion
      ) {
        void verifyRunBilling(runId).catch(() => {});
      }
      void store.refreshSnapshot().catch(() => {});
      return true;
    }

    return false;
  };

  const connectRunStream = (
    runId: number,
    handle: StreamHandle,
    seq: number,
    globalSeq: number,
    wasAlreadyFinished: boolean,
    attempt: number,
    isReconnect: boolean,
  ): void => {
    const gen = client.getSessionGeneration();
    const controller = new AbortController();
    handle.abort = controller;
    let receivedFinished = false;
    let resetPendingForReconnect = isReconnect;

    const isLive = (): boolean =>
      !disposed &&
      globalSeq === globalStreamSeq &&
      streamsByRunId.get(runId) === handle &&
      handle.seq === seq &&
      client.getSessionGeneration() === gen;

    void apiOpenPluginRunEventStream(
      runId,
      {
        signal: controller.signal,
        onOpen: () => {
          if (!isLive()) {
            return;
          }
          updateRunDetail(runId, (prev) => ({
            ...prev,
            streamError: null,
          }));
        },
        onFrame: (frame) => {
          if (!isLive()) {
            return;
          }
          if (resetPendingForReconnect) {
            resetPendingForReconnect = false;
            // Wait until the first replayed frame arrives before replacing buffered logs so a
            // transient drop never blanks the log pane; preserve completed provisioning
            // history and any previously seen `log_skipped` path notice across journal rollovers.
            updateRunDetail(runId, (prev) => ({
              ...prev,
              provisionEvents: prev.launched ? prev.provisionEvents : [],
              logEntries: prev.logSkipped
                ? [{ kind: "log_skipped", ...prev.logSkipped }]
                : [],
            }));
          }
          if (applyRunFrame(runId, frame, wasAlreadyFinished)) {
            receivedFinished = true;
          }
        },
      },
      client,
    )
      .then(() => {
        if (!isLive()) {
          return;
        }
        if (handle.abort === controller) {
          handle.abort = null;
        }
        const detail = state.detailsById[runId];
        if (receivedFinished || detail?.phase !== "running") {
          streamsByRunId.delete(runId);
          return;
        }
        const nextAttempt = attempt + 1;
        handle.reconnectTimer = setTimer(() => {
          handle.reconnectTimer = null;
          if (!isLive()) {
            return;
          }
          connectRunStream(runId, handle, seq, globalSeq, wasAlreadyFinished, nextAttempt, true);
        }, computeReconnectDelayMs(nextAttempt));
      })
      .catch((error: unknown) => {
        if (!isLive()) {
          return;
        }
        if (handle.abort === controller) {
          handle.abort = null;
        }
        if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          streamsByRunId.delete(runId);
          updateRunDetail(runId, (prev) => ({
            ...prev,
            streamError: error,
          }));
          return;
        }
        const detail = state.detailsById[runId];
        if (receivedFinished || detail?.phase !== "running") {
          streamsByRunId.delete(runId);
          return;
        }
        updateRunDetail(runId, (prev) => ({
          ...prev,
          streamError: error,
        }));
        const nextAttempt = attempt + 1;
        handle.reconnectTimer = setTimer(() => {
          handle.reconnectTimer = null;
          if (!isLive()) {
            return;
          }
          connectRunStream(runId, handle, seq, globalSeq, wasAlreadyFinished, nextAttempt, true);
        }, computeReconnectDelayMs(nextAttempt));
      });
  };

  const ensureRunStream = (summary: PluginRunSummary, selectView: boolean): void => {
    const existingDetail = state.detailsById[summary.id] ?? null;
    const summaryPhase: PluginRunPhase = isRunPhase(summary.phase)
      ? summary.phase
      : summary.finished
        ? (state.knownPhasesById[summary.id] ?? "failed")
        : "running";

    const runs = state.runs.some((item) => item.id === summary.id)
      ? state.runs
      : [{ ...summary, phase: summaryPhase }, ...state.runs];

    const alreadyStreaming = streamsByRunId.has(summary.id);
    const alreadyHasCompleteDetail = existingDetail !== null && existingDetail.phase !== "running";

    if (alreadyStreaming || alreadyHasCompleteDetail) {
      if (selectView) {
        abortTemplateInFlight();
        stashedDeploySecrets = null;
        setState({
          runs,
          selectedRunId: summary.id,
          selectedFormPluginId: null,
          deployDraft: null,
        });
      } else if (runs !== state.runs) {
        setState({ runs });
      }
      return;
    }

    const detail = existingDetail ?? createInitialDetail(summary);
    const nextKnownPhase =
      summary.finished && summaryPhase !== "running"
        ? summaryPhase
        : (state.knownPhasesById[summary.id] ?? "running");

    if (selectView) {
      abortTemplateInFlight();
      stashedDeploySecrets = null;
    }

    setState({
      runs,
      ...(selectView
        ? {
            selectedRunId: summary.id,
            selectedFormPluginId: null,
            deployDraft: null,
          }
        : {}),
      detailsById: {
        ...state.detailsById,
        [summary.id]: detail,
      },
      knownPhasesById:
        state.knownPhasesById[summary.id] === nextKnownPhase
          ? state.knownPhasesById
          : { ...state.knownPhasesById, [summary.id]: nextKnownPhase },
    });

    const handle: StreamHandle = {
      seq: 1,
      abort: null,
      reconnectTimer: null,
    };
    streamsByRunId.set(summary.id, handle);
    const wasAlreadyFinished = summary.finished && !submittedLiveRunIds.has(summary.id);
    connectRunStream(
      summary.id,
      handle,
      handle.seq,
      globalStreamSeq,
      wasAlreadyFinished,
      0,
      false,
    );
  };

  const attachRun = (summary: PluginRunSummary): void => {
    // Invalidate any pre-submit `/api/plugins/runs` fetch so a delayed stale list cannot drop this run.
    runsListSeq += 1;
    runsListInFlight = null;
    highestSeenRunId = Math.max(highestSeenRunId, summary.id);
    ensureRunStream(summary, true);
  };

  const refreshPluginRuns = (opts?: {
    readonly autoAttach?: boolean;
  }): Promise<PluginRunSummary[]> => {
    const autoAttach = (opts?.autoAttach ?? true) && state.selectedFormPluginId === null;
    pendingAutoAttach = pendingAutoAttach || autoAttach;
    if (runsListInFlight) {
      return runsListInFlight;
    }
    const gen = client.getSessionGeneration();
    const seq = ++runsListSeq;

    const promise = apiListPluginRuns(undefined, client)
      .then((rawRuns) => {
        if (disposed || client.getSessionGeneration() !== gen || seq !== runsListSeq) {
          return state.runs as PluginRunSummary[];
        }
        const nextKnownPhases: Record<number, PluginRunPhase> = { ...state.knownPhasesById };
        const runs: PluginRunSummary[] = rawRuns.map((item) => {
          const detail = state.detailsById[item.id];
          const serverPhase: PluginRunPhase = isRunPhase(item.phase)
            ? item.phase
            : item.finished
              ? (nextKnownPhases[item.id] ?? "failed")
              : "running";
          const effectivePhase =
            detail && detail.phase !== "running" ? detail.phase : serverPhase;
          nextKnownPhases[item.id] = effectivePhase;
          return {
            ...item,
            finished: item.finished || effectivePhase !== "running",
            phase: effectivePhase,
          };
        });

        const shouldConsiderAutoAttach = pendingAutoAttach;
        pendingAutoAttach = false;
        setState({ runs, knownPhasesById: nextKnownPhases });

        // Keep live SSE streams attached for every running plugin run even while browsing
        // the list, deploy form, or another route so completion updates and Ready toasts
        // never drop.
        for (const item of runs) {
          if (!item.finished && item.phase === "running" && !streamsByRunId.has(item.id)) {
            ensureRunStream(item, false);
          }
        }

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
              stopStreamForRun(state.selectedRunId);
              setState({ selectedRunId: null });
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
      resetStore();
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    if (disposed || !client.isAuthenticated()) {
      return;
    }
    const snapshot = store.getState().snapshot;
    const nextOpIds = extractPluginRunOpIds(snapshot);
    const prevOpIds = prevPluginRunOpIds;
    prevPluginRunOpIds = nextOpIds;
    if (nextOpIds) {
      const ids = nextOpIds.split(",").map(Number);
      const hasUnknownOrUnstreamedRun = ids.some(
        (id) => !state.runs.some((run) => run.id === id) || !streamsByRunId.has(id),
      );
      if (hasUnknownOrUnstreamedRun) {
        void refreshPluginRuns({ autoAttach: false });
      }
    } else if (prevOpIds) {
      void refreshPluginRuns({ autoAttach: false });
    }
  });

  const openPluginRun = (id: number, fallbackSummary?: PluginRunSummary): void => {
    const isFreshSubmit = fallbackSummary !== undefined && !fallbackSummary.finished;
    if (isFreshSubmit) {
      submittedLiveRunIds.add(id);
    }
    const existing = state.runs.find((item) => item.id === id) ?? fallbackSummary ?? null;
    if (existing) {
      attachRun(existing);
      if (isFreshSubmit) {
        const detail = state.detailsById[id];
        if (detail?.phase === "ready") {
          announceReadyOnce(id, detail.plugin);
        } else if (detail?.phase === "failed" || detail?.phase === "cancelled") {
          void verifyRunBilling(id).catch(() => {});
        }
      }
      return;
    }
    void refreshPluginRuns({ autoAttach: false }).then((runs) => {
      const matched = runs.find((item) => item.id === id);
      if (matched) {
        attachRun(matched);
      }
    });
  };

  const openPluginDeployForm = (pluginId: string): void => {
    const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
    dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
    pendingAutoAttach = false;
    abortTemplateInFlight();
    stashedDeploySecrets = null;
    // Do NOT stop active SSE streams here: background plugin runs stay connected.
    const nextOpenSeq = state.formOpenSeq + 1;
    const originAccountContext = resolveDeployOriginAccountContext(
      null,
      store.getState().snapshot?.account ?? null,
    );
    setState({
      selectedRunId: null,
      selectedFormPluginId: pluginId,
      formOpenSeq: nextOpenSeq,
      deployDraft: createEmptyDeployDraft(pluginId, nextOpenSeq, originAccountContext),
    });
  };

  const closePluginDeployForm = (): void => {
    if (state.selectedFormPluginId === null && state.deployDraft === null) {
      stashedDeploySecrets = null;
      return;
    }
    const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
    dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
    pendingAutoAttach = false;
    abortTemplateInFlight();
    stashedDeploySecrets = null;
    setState({ selectedFormPluginId: null, deployDraft: null });
  };

  const showPluginList = (): void => {
    const latestId = state.runs[0]?.id ?? state.selectedRunId ?? 0;
    dismissedAutoRunId = Math.max(dismissedAutoRunId, latestId);
    abortTemplateInFlight();
    stashedDeploySecrets = null;
    // Do NOT stop active SSE streams here: leaving run detail keeps streaming live in background.
    setState({ selectedRunId: null, selectedFormPluginId: null, deployDraft: null });
  };

  const loadDeployFormTemplate = (
    pluginId: string,
    openSeq: number,
    mapTemplate: DeployTemplateMapper,
    opts?: { readonly force?: boolean },
  ): Promise<void> => {
    const currentDraft = state.deployDraft;
    if (
      !currentDraft ||
      currentDraft.pluginId !== pluginId ||
      currentDraft.openSeq !== openSeq
    ) {
      return Promise.resolve();
    }
    if (!opts?.force && currentDraft.loadPhase === "ready") {
      return Promise.resolve();
    }
    const key = `${pluginId}:${openSeq}`;
    const generation = client.getSessionGeneration();
    if (
      !opts?.force &&
      templateInFlight !== null &&
      templateInFlight.key === key &&
      templateInFlight.generation === generation
    ) {
      return templateInFlight.promise;
    }

    abortTemplateInFlight();
    const controller = new AbortController();
    setState({
      deployDraft: {
        ...currentDraft,
        loadPhase: "loading",
        loadError: null,
      },
    });

    const promise = apiFetchPluginRunTemplate(pluginId, controller.signal, client)
      .then((template) => {
        if (disposed || controller.signal.aborted || client.getSessionGeneration() !== generation) {
          return;
        }
        const latestDraft = state.deployDraft;
        if (!latestDraft || latestDraft.pluginId !== pluginId || latestDraft.openSeq !== openSeq) {
          return;
        }
        const mapped = mapTemplate(template);
        setState({
          deployDraft: {
            ...latestDraft,
            ...mapped,
            loadPhase: "ready",
            loadError: null,
            selectedExisting: null,
            targetLost: null,
            hfByInputId: {},
          },
        });
      })
      .catch((error: unknown) => {
        if (
          disposed ||
          controller.signal.aborted ||
          client.getSessionGeneration() !== generation ||
          (error instanceof ApiError && error.isAbort)
        ) {
          return;
        }
        const latestDraft = state.deployDraft;
        if (!latestDraft || latestDraft.pluginId !== pluginId || latestDraft.openSeq !== openSeq) {
          return;
        }
        setState({
          deployDraft: {
            ...latestDraft,
            loadPhase: "error",
            loadError: error,
          },
        });
      })
      .finally(() => {
        if (templateInFlight?.promise === promise) {
          templateInFlight = null;
        }
      });

    templateInFlight = { key, generation, controller, promise };
    return promise;
  };

  const updateDeployDraft = (
    updater: (prev: PluginDeployFormDraft) => PluginDeployFormDraft,
  ): void => {
    const current = state.deployDraft;
    if (!current) {
      return;
    }
    const next = updater(current);
    if (next === current) {
      return;
    }
    setState({ deployDraft: next });
  };

  const latchDeployOriginAccountContext = (snapshotAccount: AccountContext | null): void => {
    const current = state.deployDraft;
    if (!current) {
      return;
    }
    const nextOrigin = resolveDeployOriginAccountContext(
      current.originAccountContext,
      snapshotAccount,
    );
    if (nextOrigin === current.originAccountContext) {
      return;
    }
    setState({
      deployDraft: {
        ...current,
        originAccountContext: nextOrigin,
      },
    });
  };

  const reconcileDeployTarget = (snapshot: Snapshot | null): void => {
    const current = state.deployDraft;
    const selectedExisting = current?.selectedExisting ?? null;
    if (!current || !selectedExisting || !snapshot) {
      return;
    }
    const activeAccount = snapshot.accounts?.active ?? snapshot.account.active ?? null;
    if (!activeAccount || selectedExisting.account !== activeAccount) {
      setState({
        deployDraft: {
          ...current,
          selectedExisting: null,
          targetLost: { kind: "other_account", name: selectedExisting.name },
        },
      });
      return;
    }
    if (
      !snapshot.runtimes ||
      snapshot.runtimes_error !== null ||
      snapshot.runtimes.errors.some((err) => err.account === activeAccount)
    ) {
      return;
    }
    const matched = snapshot.runtimes.runtimes.find(
      (rt) =>
        rt.on_active_account &&
        rt.managed &&
        rt.id.account === selectedExisting.account &&
        rt.id.endpoint === selectedExisting.runtime.endpoint &&
        rt.id.name === selectedExisting.name,
    );
    if (!matched) {
      setState({
        deployDraft: {
          ...current,
          selectedExisting: null,
          targetLost: { kind: "ended", name: selectedExisting.name },
        },
      });
    }
  };

  return {
    getState(): PluginRunsStoreState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setLocale(locale: Locale): void {
      currentLocale = locale;
    },

    refreshPluginRuns,
    openPluginRun,
    openPluginDeployForm,
    closePluginDeployForm,
    showPluginList,

    async requestCancelPluginRun(id: number): Promise<void> {
      const gen = client.getSessionGeneration();
      updateRunDetail(id, (prev) => ({
        ...prev,
        cancelRequested: true,
      }));
      try {
        await apiCancelPluginRun(id, undefined, client);
      } catch (error) {
        if (!disposed && client.getSessionGeneration() === gen) {
          updateRunDetail(id, (prev) => ({
            ...prev,
            cancelRequested: false,
          }));
        }
        throw error;
      }
    },

    verifyRunBilling,
    loadDeployFormTemplate,
    updateDeployDraft,
    latchDeployOriginAccountContext,
    reconcileDeployTarget,

    stashDeploySecrets(
      pluginId: string,
      openSeq: number,
      entries: readonly (readonly [string, string])[],
    ): void {
      const current = state.deployDraft;
      if (!current || current.pluginId !== pluginId || current.openSeq !== openSeq) {
        stashedDeploySecrets = null;
        return;
      }
      const values = new Map<string, string>();
      for (const [id, raw] of entries) {
        if (raw.length > 0) {
          values.set(id, raw);
        }
      }
      stashedDeploySecrets = values.size > 0 ? { pluginId, openSeq, values } : null;
    },

    takeStashedDeploySecrets(
      pluginId: string,
      openSeq: number,
    ): ReadonlyMap<string, string> | null {
      const current = stashedDeploySecrets;
      if (!current || current.pluginId !== pluginId || current.openSeq !== openSeq) {
        return null;
      }
      stashedDeploySecrets = null;
      return current.values;
    },

    clearStashedDeploySecrets(): void {
      stashedDeploySecrets = null;
    },

    setEndpointForwardId(runId: number, endpointId: string, forwardId: number | null): void {
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
    },

    cachePluginForwardAddresses(view: ForwardView): void {
      forwards.recordForward(view);
    },

    refreshPluginForwards(signal?: AbortSignal): Promise<ForwardView[]> {
      return forwards.refresh(signal);
    },

    isStreamActive(runId: number): boolean {
      return streamsByRunId.has(runId);
    },

    hasToastedReadyRun(runId: number): boolean {
      return toastedReadyRunIds.has(runId);
    },

    dispose(): void {
      disposed = true;
      stashedDeploySecrets = null;
      unsubscribeAuth();
      unsubscribeStore();
      stopAllStreams();
      abortTemplateInFlight();
      listeners.clear();
    },
  };
}

/** Shared global store for plugin runs, billing verification cache, and deploy form drafts. */
export const pluginRunsStore: PluginRunsStore = createPluginRunsStore();

export function setPluginRunsLocale(locale: Locale): void {
  pluginRunsStore.setLocale(locale);
}

/**
 * Fetches `/api/plugins/runs` and auto-attaches to the newest run when none is open
 * and the user has not explicitly backed out of that run ID.
 */
export function refreshPluginRuns(options?: {
  readonly autoAttach?: boolean;
}): Promise<PluginRunSummary[]> {
  return pluginRunsStore.refreshPluginRuns(options);
}

/**
 * Opens a specific run detail view by ID.
 */
export function openPluginRun(id: number, fallbackSummary?: PluginRunSummary): void {
  pluginRunsStore.openPluginRun(id, fallbackSummary);
}

/**
 * Opens the dynamic deploy form for `pluginId` without interrupting active background run streams.
 */
export function openPluginDeployForm(pluginId: string): void {
  pluginRunsStore.openPluginDeployForm(pluginId);
}

/**
 * Closes the dynamic deploy form, discards its draft, and returns to the Plugins list view.
 */
export function closePluginDeployForm(): void {
  pluginRunsStore.closePluginDeployForm();
}

/**
 * Returns to the Plugins list view without stopping active background plugin run streams.
 */
export function showPluginList(): void {
  pluginRunsStore.showPluginList();
}

/**
 * Requests cancellation of a running plugin job.
 */
export function requestCancelPluginRun(id: number): Promise<void> {
  return pluginRunsStore.requestCancelPluginRun(id);
}

/**
 * Verifies post-failure/cancel billing status for `runId` and caches the result across routes.
 */
export function verifyPluginRunBilling(
  runId: number,
  options?: { readonly force?: boolean },
): Promise<PluginRunBillingCheck | null> {
  return pluginRunsStore.verifyRunBilling(runId, options);
}

/**
 * Loads the deploy form template into the persistent draft store if not already ready.
 */
export function loadPluginDeployFormTemplate(
  pluginId: string,
  openSeq: number,
  mapTemplate: DeployTemplateMapper,
  options?: { readonly force?: boolean },
): Promise<void> {
  return pluginRunsStore.loadDeployFormTemplate(pluginId, openSeq, mapTemplate, options);
}

/**
 * Mutates the currently open persistent deploy form draft.
 */
export function updatePluginDeployDraft(
  updater: (prev: PluginDeployFormDraft) => PluginDeployFormDraft,
): void {
  pluginRunsStore.updateDeployDraft(updater);
}

/**
 * Latches the initial active `AccountContext` onto the active deploy draft once available.
 */
export function latchPluginDeployOriginAccountContext(
  snapshotAccount: AccountContext | null,
): void {
  pluginRunsStore.latchDeployOriginAccountContext(snapshotAccount);
}

/**
 * Drops an existing-session target from the deploy draft when it ended or switched accounts.
 */
export function reconcilePluginDeployTarget(snapshot: Snapshot | null): void {
  pluginRunsStore.reconcileDeployTarget(snapshot);
}

/**
 * Temporarily stashes non-empty masked secret inputs in volatile memory across a route unmount
 * while the same deploy draft stays open (never enters React state or `deployDraft`).
 */
export function stashPluginDeploySecrets(
  pluginId: string,
  openSeq: number,
  entries: readonly (readonly [string, string])[],
): void {
  pluginRunsStore.stashDeploySecrets(pluginId, openSeq, entries);
}

/**
 * Restores and clears volatile stashed secret inputs for the active deploy draft upon remount.
 */
export function takeStashedPluginDeploySecrets(
  pluginId: string,
  openSeq: number,
): ReadonlyMap<string, string> | null {
  return pluginRunsStore.takeStashedDeploySecrets(pluginId, openSeq);
}

/**
 * Immediately wipes any volatile stashed deploy secrets.
 */
export function clearStashedPluginDeploySecrets(): void {
  pluginRunsStore.clearStashedDeploySecrets();
}

/**
 * Records a preferred tunnel ID for an endpoint card (`null` when closed).
 */
export function setEndpointForwardId(
  runId: number,
  endpointId: string,
  forwardId: number | null,
): void {
  pluginRunsStore.setEndpointForwardId(runId, endpointId, forwardId);
}

/**
 * Caches server-validated forward addresses returned by `POST /api/forwards`
 * in the global `forwardsStore`.
 */
export function cachePluginForwardAddresses(view: ForwardView): void {
  pluginRunsStore.cachePluginForwardAddresses(view);
}

/**
 * Pulls `/api/forwards` via the global `forwardsStore` to hydrate server-validated addresses.
 */
export function refreshPluginForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  return pluginRunsStore.refreshPluginForwards(signal);
}

export function usePluginRunsStore(
  store: PluginRunsStore = pluginRunsStore,
): PluginRunsStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
