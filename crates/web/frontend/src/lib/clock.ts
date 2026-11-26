/**
 * Backend-anchored server clock baseline shared across usage freshness,
 * auto-stop countdowns, switch-impact previews, and measured-rate ages.
 *
 * Measures elapsed time monotonically from the latest server timestamp
 * (`Snapshot.server_now` or HTTP `sampled_at`) so browser wall-clock skew
 * never distorts ages or countdowns.
 */

import { useSyncExternalStore } from "react";

import type { UnixSecs } from "./types.ts";

const MS_PER_SECOND = 1000;
export const DEFAULT_CLOCK_INTERVAL_MS = 30_000;

interface ClockAnchor {
  readonly serverSecs: number;
  readonly monotonicMs: number;
}

interface IntervalBucket {
  currentSecs: number;
  readonly listeners: Set<() => void>;
  timerId: ReturnType<typeof setInterval> | null;
}

export interface ServerClockSyncOptions {
  /**
   * True when the timestamp comes from an authoritative monotonic source such as
   * a newer `Snapshot.server_now`, allowing the anchor to adjust even if the clock stepped.
   */
  readonly authoritative?: boolean;
}

export interface ServerClockOptions {
  readonly wallNow?: () => number;
  readonly monotonicNow?: () => number;
  readonly setIntervalFn?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}

export interface ServerClock {
  /** Returns the current Unix timestamp in seconds in the backend's clock domain. */
  getNowSecs(): UnixSecs;
  /** Returns true once at least one valid backend timestamp has anchored this clock. */
  isAnchored(): boolean;
  /** Anchors the clock to a backend Unix timestamp in seconds. */
  sync(serverSecs: UnixSecs | null | undefined, options?: ServerClockSyncOptions): boolean;
  /** Clears the server anchor (called on sign-out or session expiry). */
  reset(): void;
  /** Subscribes a listener ticking on `intervalMs` (and immediately on anchor shifts). */
  subscribe(intervalMs: number, listener: () => void): () => void;
  /** Returns the cached snapshot value for `useSyncExternalStore` at `intervalMs`. */
  getSnapshot(intervalMs: number): UnixSecs;
  /** Stops all timers and clears subscribers. */
  dispose(): void;
}

function defaultMonotonicNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizeIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return DEFAULT_CLOCK_INTERVAL_MS;
  }
  return Math.max(MS_PER_SECOND, Math.round(intervalMs));
}

/**
 * Creates an isolated backend-anchored clock with per-interval subscriber buckets.
 */
export function createServerClock(options: ServerClockOptions = {}): ServerClock {
  const wallNow = options.wallNow ?? Date.now;
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const setIntervalFn =
    options.setIntervalFn ??
    (typeof globalThis.setInterval === "function"
      ? globalThis.setInterval.bind(globalThis)
      : null);
  const clearIntervalFn =
    options.clearIntervalFn ??
    (typeof globalThis.clearInterval === "function"
      ? globalThis.clearInterval.bind(globalThis)
      : null);

  let anchor: ClockAnchor | null = null;
  let disposed = false;
  const buckets = new Map<number, IntervalBucket>();

  const computeNowSecs = (): UnixSecs => {
    if (anchor !== null) {
      const elapsedSecs = Math.max(0, Math.floor((monotonicNow() - anchor.monotonicMs) / MS_PER_SECOND));
      return anchor.serverSecs + elapsedSecs;
    }
    return Math.floor(wallNow() / MS_PER_SECOND);
  };

  const notifyBucket = (bucket: IntervalBucket, force = false): void => {
    const next = computeNowSecs();
    if (!force && next === bucket.currentSecs) {
      return;
    }
    bucket.currentSecs = next;
    for (const listener of bucket.listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so remaining clock leaves continue ticking.
      }
    }
  };

  const notifyAllBuckets = (force = false): void => {
    for (const bucket of buckets.values()) {
      notifyBucket(bucket, force);
    }
  };

  return {
    getNowSecs(): UnixSecs {
      return computeNowSecs();
    },

    isAnchored(): boolean {
      return anchor !== null;
    },

    sync(serverSecs: UnixSecs | null | undefined, syncOptions?: ServerClockSyncOptions): boolean {
      if (disposed || typeof serverSecs !== "number" || !Number.isFinite(serverSecs) || serverSecs <= 0) {
        return false;
      }
      const normalized = Math.floor(serverSecs);
      const prevSecs = computeNowSecs();
      if (!syncOptions?.authoritative && anchor !== null && normalized <= prevSecs) {
        return false;
      }
      const wasAnchored = anchor !== null;
      anchor = {
        serverSecs: normalized,
        monotonicMs: monotonicNow(),
      };
      const nextSecs = computeNowSecs();
      if (!wasAnchored || nextSecs !== prevSecs) {
        notifyAllBuckets(!wasAnchored);
      }
      return true;
    },

    reset(): void {
      if (anchor === null) {
        return;
      }
      anchor = null;
      notifyAllBuckets(true);
    },

    subscribe(intervalMs: number, listener: () => void): () => void {
      if (disposed) {
        return () => {};
      }
      const key = normalizeIntervalMs(intervalMs);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          currentSecs: computeNowSecs(),
          listeners: new Set(),
          timerId: null,
        };
        buckets.set(key, bucket);
      }
      bucket.listeners.add(listener);
      if (bucket.timerId === null && setIntervalFn !== null) {
        bucket.currentSecs = computeNowSecs();
        const activeBucket = bucket;
        bucket.timerId = setIntervalFn(() => {
          notifyBucket(activeBucket);
        }, key);
      }
      return () => {
        const current = buckets.get(key);
        if (!current) {
          return;
        }
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
          if (current.timerId !== null && clearIntervalFn !== null) {
            clearIntervalFn(current.timerId);
          }
          buckets.delete(key);
        }
      };
    },

    getSnapshot(intervalMs: number): UnixSecs {
      const key = normalizeIntervalMs(intervalMs);
      const bucket = buckets.get(key);
      return bucket ? bucket.currentSecs : computeNowSecs();
    },

    dispose(): void {
      disposed = true;
      for (const bucket of buckets.values()) {
        if (bucket.timerId !== null && clearIntervalFn !== null) {
          clearIntervalFn(bucket.timerId);
        }
        bucket.listeners.clear();
      }
      buckets.clear();
    },
  };
}

/** Shared backend-anchored server clock for the Browser Client. */
export const serverClock: ServerClock = createServerClock();

/**
 * React hook returning the current Unix timestamp in seconds anchored to the
 * backend's clock, updating on `intervalMs` (and immediately when re-anchored).
 */
export function useServerClockSecs(
  intervalMs: number = DEFAULT_CLOCK_INTERVAL_MS,
  clock: ServerClock = serverClock,
): UnixSecs {
  return useSyncExternalStore(
    (listener) => clock.subscribe(intervalMs, listener),
    () => clock.getSnapshot(intervalMs),
    () => clock.getSnapshot(intervalMs),
  );
}
