/**
 * Isolated 15-second backend-anchored clock store and leaf countdown components.
 *
 * Only the leaf text nodes subscribe to the 15-second tick so uptime and auto-stop
 * countdown updates never re-render parent cards, controls, or open modal dialogs,
 * keeping active focus and form drafts intact.
 */

import { useSyncExternalStore } from "react";

import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { UnixSecs } from "../../lib/types.ts";

const SESSION_TICK_INTERVAL_MS = 15_000;
const MS_PER_SECOND = 1000;

interface ClockAnchor {
  readonly serverSecs: number;
  readonly localMs: number;
}

let anchor: ClockAnchor | null = null;
let currentNowSecs = computeNowSecs();
let timerId: number | null = null;
const listeners = new Set<() => void>();

function computeNowSecs(): number {
  if (anchor !== null) {
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - anchor.localMs) / MS_PER_SECOND));
    return anchor.serverSecs + elapsedSecs;
  }
  return Math.floor(Date.now() / MS_PER_SECOND);
}

function emit(): void {
  const next = computeNowSecs();
  if (next === currentNowSecs) {
    return;
  }
  currentNowSecs = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Isolate subscriber errors so remaining countdown leaves still update.
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timerId === null && typeof window !== "undefined") {
    currentNowSecs = computeNowSecs();
    timerId = window.setInterval(emit, SESSION_TICK_INTERVAL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timerId !== null && typeof window !== "undefined") {
      window.clearInterval(timerId);
      timerId = null;
    }
  };
}

function getSnapshot(): number {
  return currentNowSecs;
}

export function getServerNowSecs(): number {
  return computeNowSecs();
}

/**
 * Anchors the local 15-second ticker to the backend timestamp from `GET /api/sessions`.
 */
export function syncServerClock(sampledAtSecs: UnixSecs): void {
  if (!Number.isFinite(sampledAtSecs) || sampledAtSecs <= 0) {
    return;
  }
  anchor = {
    serverSecs: Math.floor(sampledAtSecs),
    localMs: Date.now(),
  };
  emit();
}

function useSessionClockSecs(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface LiveRuntimeUptimeProps {
  readonly startedAt: UnixSecs;
  readonly t: TranslateFn;
}

export function LiveRuntimeUptime({ startedAt, t }: LiveRuntimeUptimeProps) {
  const nowSecs = useSessionClockSecs();
  const elapsed = Math.max(0, nowSecs - startedAt);
  return (
    <span className="session-stat-value" data-runtime-uptime-since={String(startedAt)}>
      {formatDuration(elapsed, t)}
    </span>
  );
}

export interface LiveAutoStopCountdownProps {
  readonly autoStopAt: UnixSecs;
  readonly t: TranslateFn;
}

export function LiveAutoStopCountdown({ autoStopAt, t }: LiveAutoStopCountdownProps) {
  const nowSecs = useSessionClockSecs();
  const remaining = Math.max(0, autoStopAt - nowSecs);
  return (
    <span className="session-stat-value" data-runtime-auto-stop-at={String(autoStopAt)}>
      {t("app.b2.runtime_auto_stop_in", { time: formatDuration(remaining, t) })}
    </span>
  );
}
