/**
 * Isolated 15-second backend-anchored clock leaf countdown components.
 *
 * Delegates timekeeping to the shared `serverClock` baseline so uptime and
 * auto-stop countdowns stay accurate under browser wall-clock skew while only
 * leaf text nodes subscribe to the 15-second tick (keeping parent cards,
 * active focus, and form drafts undisturbed).
 */

import { serverClock, useServerClockSecs } from "../../lib/clock.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { UnixSecs } from "../../lib/types.ts";

const SESSION_TICK_INTERVAL_MS = 15_000;

export function getServerNowSecs(): number {
  return serverClock.getNowSecs();
}

function useSessionClockSecs(): number {
  return useServerClockSecs(SESSION_TICK_INTERVAL_MS);
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
