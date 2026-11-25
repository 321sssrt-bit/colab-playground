/**
 * Live Web state store with monotonic snapshot convergence, POST SSE streaming,
 * exponential-backoff reconnection, and React `useSyncExternalStore` bindings.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient, type AuthEvent } from "./api.ts";
import type { SseFrame } from "./sse.ts";
import type { Snapshot, TunnelEvent } from "./types.ts";

export type AuthStatus = "signed_out" | "authenticated" | "expired";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface WebStoreState {
  readonly authStatus: AuthStatus;
  readonly connectionStatus: ConnectionStatus;
  readonly snapshot: Snapshot | null;
  readonly lastEventId: string | null;
  readonly reconnectAttempt: number;
  readonly nextRetryDelayMs: number | null;
  readonly lastError: ApiError | null;
  readonly lastForwardEvent: TunnelEvent | null;
}

export interface WebStoreOptions {
  readonly client?: ApiClient;
  readonly initialReconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly stableConnectionMs?: number;
  readonly backoffMultiplier?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface WebStore {
  getState(): WebStoreState;
  subscribe(listener: () => void): () => void;
  subscribeForwards(listener: (event: TunnelEvent) => void): () => void;
  signIn(accessKey: string, signal?: AbortSignal): Promise<void>;
  signOut(): void;
  refreshSnapshot(signal?: AbortSignal): Promise<Snapshot>;
  reconnectNow(): void;
  dispose(): void;
}

const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_STABLE_CONNECTION_MS = 5000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_JITTER_RATIO = 0.2;
const MAX_BACKOFF_EXPONENT = 16;

const INITIAL_STATE: WebStoreState = {
  authStatus: "signed_out",
  connectionStatus: "disconnected",
  snapshot: null,
  lastEventId: null,
  reconnectAttempt: 0,
  nextRetryDelayMs: null,
  lastError: null,
  lastForwardEvent: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshotData(data: string): Snapshot | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      isRecord(parsed) &&
      typeof parsed.version === "number" &&
      Number.isFinite(parsed.version)
    ) {
      return parsed as unknown as Snapshot;
    }
  } catch {
    // Ignore malformed JSON frames and let the next snapshot converge state.
  }
  return null;
}

function parseForwardEventData(data: string): TunnelEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      isRecord(parsed) &&
      typeof parsed.id === "number" &&
      (parsed.event === "state" || parsed.event === "health")
    ) {
      return parsed as unknown as TunnelEvent;
    }
  } catch {
    // Ignore malformed forward frames.
  }
  return null;
}

/**
 * Computes capped exponential backoff delay with bounded positive jitter.
 */
export function computeReconnectDelayMs(
  attempt: number,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {},
): number {
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const multiplier = options.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const clampedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(clampedAttempt - 1, MAX_BACKOFF_EXPONENT);
  const base = Math.min(maxDelayMs, initialDelayMs * multiplier ** exponent);
  if (jitterRatio <= 0) {
    return Math.round(base);
  }
  const factor = 1 + Math.max(0, Math.min(1, random())) * jitterRatio;
  return Math.round(Math.min(maxDelayMs, base * factor));
}

/**
 * Creates a live snapshot store bound to an `ApiClient`.
 */
export function createWebStore(options: WebStoreOptions = {}): WebStore {
  const client = options.client ?? apiClient;
  const initialReconnectDelayMs =
    options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
  const maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const stableConnectionMs = options.stableConnectionMs ?? DEFAULT_STABLE_CONNECTION_MS;
  const backoffMultiplier = options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

  let state: WebStoreState = client.isAuthenticated()
    ? { ...INITIAL_STATE, authStatus: "authenticated" }
    : INITIAL_STATE;

  const listeners = new Set<() => void>();
  const forwardListeners = new Set<(event: TunnelEvent) => void>();

  let disposed = false;
  let activeGeneration = client.getSessionGeneration();
  let runSeq = 0;
  let activeController: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const clearStableTimer = (): void => {
    if (stableTimer !== null) {
      clearTimer(stableTimer);
      stableTimer = null;
    }
  };

  const setState = (patch: Partial<WebStoreState>): void => {
    const next: WebStoreState = { ...state, ...patch };
    if (
      next.authStatus === state.authStatus &&
      next.connectionStatus === state.connectionStatus &&
      next.snapshot === state.snapshot &&
      next.lastEventId === state.lastEventId &&
      next.reconnectAttempt === state.reconnectAttempt &&
      next.nextRetryDelayMs === state.nextRetryDelayMs &&
      next.lastError === state.lastError &&
      next.lastForwardEvent === state.lastForwardEvent
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all React consumers receive updates.
      }
    }
  };

  const stopTransport = (): void => {
    runSeq += 1;
    clearStableTimer();
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    if (activeController !== null) {
      activeController.abort();
      activeController = null;
    }
  };

  const isRunLive = (seq: number, generation: number): boolean => {
    return (
      !disposed &&
      seq === runSeq &&
      generation === activeGeneration &&
      client.isAuthenticated() &&
      client.getSessionGeneration() === generation
    );
  };

  const applySnapshot = (
    generation: number,
    incoming: Snapshot,
    eventId?: string | null,
  ): boolean => {
    if (disposed || generation !== activeGeneration || client.getSessionGeneration() !== generation) {
      return false;
    }
    const current = state.snapshot;
    if (current !== null && incoming.version <= current.version) {
      return false;
    }
    setState({
      snapshot: incoming,
      lastEventId: eventId ?? String(incoming.version),
    });
    return true;
  };

  const scheduleReconnect = (
    seq: number,
    generation: number,
    nextAttempt: number,
    error: ApiError | null,
  ): void => {
    if (!isRunLive(seq, generation)) {
      return;
    }
    const delayMs = computeReconnectDelayMs(nextAttempt, {
      initialDelayMs: initialReconnectDelayMs,
      maxDelayMs: maxReconnectDelayMs,
      multiplier: backoffMultiplier,
      jitterRatio,
      random,
    });
    setState({
      connectionStatus: "reconnecting",
      reconnectAttempt: nextAttempt,
      nextRetryDelayMs: delayMs,
      lastError: error,
    });
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (!isRunLive(seq, generation)) {
        return;
      }
      void connectAttempt(seq, generation, nextAttempt, true);
    }, delayMs);
  };

  const connectAttempt = async (
    seq: number,
    generation: number,
    attempt: number,
    pullSnapshotFirst: boolean,
  ): Promise<void> => {
    if (!isRunLive(seq, generation)) {
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    let armedStableReset = false;
    let streamStable = false;

    setState({
      connectionStatus: "connecting",
      nextRetryDelayMs: null,
    });

    try {
      // Pull a full snapshot when recovering from a disconnect to converge state immediately.
      if (pullSnapshotFirst) {
        const latest = await client.getSnapshot(controller.signal);
        if (!isRunLive(seq, generation)) {
          return;
        }
        applySnapshot(generation, latest);
      }

      await client.openEventStream("/api/events", {
        body: {},
        signal: controller.signal,
        onOpen: () => {
          if (!isRunLive(seq, generation)) {
            return;
          }
          setState({
            connectionStatus: "connected",
            lastError: null,
          });
        },
        onFrame: (frame: SseFrame) => {
          if (!isRunLive(seq, generation)) {
            return;
          }
          // Reset backoff only after the stream remains live past the stability window so
          // proxies that drop right after the immediate first snapshot frame still back off.
          if (!armedStableReset) {
            armedStableReset = true;
            setState({
              connectionStatus: "connected",
              nextRetryDelayMs: null,
              lastError: null,
            });
            if (stableConnectionMs <= 0) {
              streamStable = true;
              setState({ reconnectAttempt: 0 });
            } else {
              stableTimer = setTimer(() => {
                stableTimer = null;
                if (!isRunLive(seq, generation)) {
                  return;
                }
                streamStable = true;
                setState({
                  reconnectAttempt: 0,
                  nextRetryDelayMs: null,
                  lastError: null,
                });
              }, stableConnectionMs);
            }
          }
          if (frame.event === "snapshot") {
            const incoming = parseSnapshotData(frame.data);
            if (incoming) {
              applySnapshot(generation, incoming, frame.id);
            }
          } else if (frame.event === "forward") {
            const forwardEvent = parseForwardEventData(frame.data);
            if (forwardEvent) {
              setState({ lastForwardEvent: forwardEvent });
              for (const listener of forwardListeners) {
                try {
                  listener(forwardEvent);
                } catch {
                  // Isolate subscriber exceptions.
                }
              }
            }
          }
        },
      });

      clearStableTimer();
      if (activeController === controller) {
        activeController = null;
      }

      // Clean EOF while still authenticated (e.g. proxy drop, server shutdown, or session expiry)
      // enters backoff reconnect; an expired session will receive 401 on the next attempt and halt.
      if (isRunLive(seq, generation)) {
        const nextAttempt = streamStable ? 1 : attempt + 1;
        scheduleReconnect(seq, generation, nextAttempt, null);
      }
    } catch (error) {
      clearStableTimer();
      if (activeController === controller) {
        activeController = null;
      }
      if (!isRunLive(seq, generation)) {
        return;
      }
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
              status: 0,
              kind: "connection_lost",
              message: "stream connection failed",
              cause: error,
            });
      if (apiError.isUnauthorized || apiError.isAbort) {
        return;
      }
      const nextAttempt = streamStable ? 1 : attempt + 1;
      scheduleReconnect(seq, generation, nextAttempt, apiError);
    }
  };

  const startStreamForGeneration = (generation: number, pullSnapshotFirst = false): void => {
    stopTransport();
    activeGeneration = generation;
    const seq = runSeq;
    void connectAttempt(seq, generation, 0, pullSnapshotFirst);
  };

  const handleAuthEvent = (event: AuthEvent): void => {
    if (disposed) {
      return;
    }
    if (event.type === "authenticated") {
      setState({
        authStatus: "authenticated",
        connectionStatus: "connecting",
        snapshot: null,
        lastEventId: null,
        reconnectAttempt: 0,
        nextRetryDelayMs: null,
        lastError: null,
        lastForwardEvent: null,
      });
      startStreamForGeneration(event.generation, false);
    } else if (event.type === "logged_out") {
      stopTransport();
      activeGeneration = event.generation;
      setState({ ...INITIAL_STATE, authStatus: "signed_out" });
    } else if (event.type === "unauthorized") {
      stopTransport();
      activeGeneration = event.generation;
      setState({
        ...INITIAL_STATE,
        authStatus: "expired",
      });
    }
  };

  const unsubscribeAuth = client.subscribeAuth(handleAuthEvent);

  if (client.isAuthenticated()) {
    startStreamForGeneration(activeGeneration, false);
  }

  return {
    getState(): WebStoreState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    subscribeForwards(listener: (event: TunnelEvent) => void): () => void {
      forwardListeners.add(listener);
      return () => {
        forwardListeners.delete(listener);
      };
    },

    async signIn(accessKey: string, signal?: AbortSignal): Promise<void> {
      await client.login(accessKey, signal);
    },

    signOut(): void {
      const wasAuthenticated = client.isAuthenticated();
      client.logout();
      if (!wasAuthenticated && !disposed) {
        stopTransport();
        activeGeneration = client.getSessionGeneration();
        setState({ ...INITIAL_STATE, authStatus: "signed_out" });
      }
    },

    async refreshSnapshot(signal?: AbortSignal): Promise<Snapshot> {
      const requestGeneration = client.getSessionGeneration();
      const snapshot = await client.getSnapshot(signal);
      applySnapshot(requestGeneration, snapshot);
      return snapshot;
    },

    reconnectNow(): void {
      if (disposed || !client.isAuthenticated()) {
        return;
      }
      const generation = client.getSessionGeneration();
      // Force full snapshot pull on manual reconnect to converge immediately.
      startStreamForGeneration(generation, true);
    },

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      stopTransport();
      listeners.clear();
      forwardListeners.clear();
    },
  };
}

/** Shared live snapshot store bound to `apiClient`. */
export const webStore: WebStore = createWebStore();

/**
 * React hook subscribing a component to the live `WebStoreState`.
 */
export function useWebStore(store: WebStore = webStore): WebStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
