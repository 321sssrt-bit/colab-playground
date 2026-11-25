/**
 * Reusable live provisioning progress stream hook and step list renderer,
 * shared by `NewSessionDialog`, `ProvisioningCard`, and future plugin new-session runs.
 */

import { useEffect, useRef, useState } from "react";

import { CheckCircleIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import {
  openProvisionEventStream,
  type ProvisionFinishedEvent,
  type ProvisionProgressEvent,
} from "./api.ts";
import { formatErrorMessage, formatHardware, formatShortWait, formatVram } from "./format.ts";
import { AlertTriangleIcon, CircleXIcon, DotIcon, SmallInfoIcon } from "./Icons.tsx";

const SLOW_ANSWER_MS = 60_000;
const SLOW_ANSWER_POLL_MS = 15_000;
const MS_PER_SECOND = 1000;

export interface ProvisionSentence {
  readonly text: string;
  readonly tone: "busy" | "good" | "warn" | "bad" | "neutral";
}

export function parseProvisionEvent(raw: string): ProvisionProgressEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "event" in parsed) {
      return parsed as ProvisionProgressEvent;
    }
  } catch {
    // Ignore malformed SSE event frames.
  }
  return null;
}

export function parseFinishedEvent(raw: string): ProvisionFinishedEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "phase" in parsed) {
      return parsed as ProvisionFinishedEvent;
    }
  } catch {
    // Ignore malformed SSE finished frames.
  }
  return null;
}

export function formatProvisionSentence(
  ev: ProvisionProgressEvent,
  completed: boolean,
  locale: Locale,
  t: TranslateFn,
): ProvisionSentence | null {
  const hw = (gpu: string | null, vramMib: number | null) =>
    formatHardware(gpu, vramMib, locale, t) ?? t("app.b2.prov_no_gpu");

  switch (ev.event) {
    case "allocating":
      return {
        text: t(completed ? "app.b3.prov_allocated" : "app.b2.prov_allocating", {
          n: ev.attempt,
          of: ev.max_attempts,
        }),
        tone: "busy",
      };
    case "allocated":
    case "failed":
      return null;
    case "allocation_failed":
      return {
        text: t("app.b2.prov_allocation_failed", {
          why: formatErrorMessage(ev.error, t).message,
        }),
        tone: "warn",
      };
    case "probed":
      return {
        text: t("app.b2.prov_probed", { hardware: hw(ev.gpu, ev.vram_mib) }),
        tone: "neutral",
      };
    case "rejected":
      return {
        text: t("app.b2.prov_rejected", {
          got: ev.vram_mib !== null ? formatVram(ev.vram_mib, locale, t) : t("app.summary.unknown"),
          min: formatVram(ev.min_vram_mib, locale, t),
        }),
        tone: "warn",
      };
    case "releasing":
      return {
        text: t(completed ? "app.b3.prov_released" : "app.b2.prov_releasing"),
        tone: "busy",
      };
    case "reconciling":
      return {
        text: t(completed ? "app.b11.prov_reconciled" : "app.b11.prov_reconciling"),
        tone: "busy",
      };
    case "orphan_detected":
      return ev.released
        ? { text: t("app.b2.prov_orphan_released"), tone: "neutral" }
        : { text: t("app.b2.prov_orphan_left"), tone: "bad" };
    case "retrying":
      return {
        text: t(completed ? "app.b3.prov_retried" : "app.b2.prov_retrying", {
          time: formatShortWait(ev.delay_secs, t),
        }),
        tone: "busy",
      };
    case "watchdog_started":
      return {
        text: t(ev.deadline !== null ? "app.b2.prov_watchdog" : "app.b2.prov_watchdog_no_deadline"),
        tone: "good",
      };
    case "watchdog_failed":
      return { text: t("app.b2.prov_watchdog_failed"), tone: "bad" };
    case "ready":
      return {
        text: t(ev.below_spec ? "app.b2.prov_ready_below" : "app.b2.prov_ready", {
          hardware: hw(ev.gpu, ev.vram_mib),
        }),
        tone: ev.below_spec ? "warn" : "good",
      };
    default:
      return null;
  }
}

export function formatProvisionHeadline(
  events: readonly ProvisionProgressEvent[],
  t: TranslateFn,
): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.event === "allocating") {
      return t("app.b2.prov_attempt", { n: ev.attempt, of: ev.max_attempts });
    }
    if (ev.event === "reconciling") {
      return t("app.b11.prov_reconciling");
    }
  }
  return t("app.b2.prov_starting");
}

export function hasProvisionLines(
  events: readonly ProvisionProgressEvent[],
  locale: Locale,
  t: TranslateFn,
): boolean {
  return events.some((ev) => formatProvisionSentence(ev, true, locale, t) !== null);
}

export interface UseProvisionStreamOptions {
  readonly operationId: number | null;
  readonly onFinished?: (event: ProvisionFinishedEvent) => void;
  readonly onStreamError?: (error: unknown) => void;
}

export interface ProvisionStreamState {
  readonly events: readonly ProvisionProgressEvent[];
  readonly waitingSinceMs: number | null;
}

/**
 * Subscribes to `POST /api/sessions/{id}/events` for `operationId`, accumulating
 * replayed and live progress frames and tracking when an unanswered `allocating`
 * step began so slow-answer notices can be displayed.
 */
export function useProvisionStream({
  operationId,
  onFinished,
  onStreamError,
}: UseProvisionStreamOptions): ProvisionStreamState {
  const [events, setEvents] = useState<readonly ProvisionProgressEvent[]>([]);
  const [waitingSinceMs, setWaitingSinceMs] = useState<number | null>(null);

  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onStreamErrorRef = useRef(onStreamError);
  onStreamErrorRef.current = onStreamError;

  useEffect(() => {
    if (operationId === null) {
      setEvents([]);
      setWaitingSinceMs(null);
      return;
    }

    setEvents([]);
    setWaitingSinceMs(null);

    const controller = new AbortController();
    let sawFinished = false;

    void openProvisionEventStream(operationId, {
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.event === "progress") {
          const parsed = parseProvisionEvent(frame.data);
          if (parsed) {
            setEvents((prev) => [...prev, parsed]);
            setWaitingSinceMs(parsed.event === "allocating" ? Date.now() : null);
          }
        } else if (frame.event === "finished") {
          const finished = parseFinishedEvent(frame.data);
          if (finished) {
            sawFinished = true;
            setWaitingSinceMs(null);
            if (finished.phase === "ready" && finished.outcome) {
              const readyEvent: ProvisionProgressEvent = {
                event: "ready",
                name: finished.outcome.name,
                gpu: finished.outcome.hardware?.gpu ?? null,
                vram_mib: finished.outcome.hardware?.vram_mib ?? null,
                below_spec: Boolean(finished.outcome.below_spec),
              };
              setEvents((prev) =>
                prev.some((item) => item.event === "ready") ? prev : [...prev, readyEvent],
              );
            }
            onFinishedRef.current?.(finished);
          }
        }
      },
    })
      .then(() => {
        if (controller.signal.aborted || sawFinished) {
          return;
        }
        onStreamErrorRef.current?.(
          new ApiError({
            status: 0,
            kind: "connection_lost",
            message: "provision stream ended before completion",
          }),
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sawFinished) {
          return;
        }
        if (error instanceof ApiError && error.isAbort) {
          return;
        }
        onStreamErrorRef.current?.(error);
      });

    return () => {
      controller.abort();
    };
  }, [operationId]);

  return { events, waitingSinceMs };
}

export interface ProvisionProgressProps {
  readonly events: readonly ProvisionProgressEvent[];
  readonly live: boolean;
  readonly waitingSinceMs?: number | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
}

export function ProvisionProgress({
  events,
  live,
  waitingSinceMs = null,
  locale,
  t,
}: ProvisionProgressProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const isAllocating = live && lastEvent?.event === "allocating" && waitingSinceMs !== null;

  useEffect(() => {
    if (!isAllocating) {
      return;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, SLOW_ANSWER_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAllocating, waitingSinceMs]);

  const visibleEvents = events.filter(
    (ev) => formatProvisionSentence(ev, true, locale, t) !== null,
  );
  // Server emits `allocated` once Colab answers `allocating`, so only a trailing `allocating` is waiting.
  const allocatingAnswered = lastEvent !== null && lastEvent.event === "allocated";
  const waitedMs = isAllocating && waitingSinceMs !== null ? Math.max(0, nowMs - waitingSinceMs) : 0;

  if (visibleEvents.length === 0 && !(isAllocating && waitedMs >= SLOW_ANSWER_MS)) {
    return null;
  }

  return (
    <>
      {visibleEvents.length > 0 && (
        <div
          className="progress-list"
          role="log"
          aria-live="polite"
          data-provision-progress="true"
        >
          {visibleEvents.map((ev, index) => {
            const isCurrent =
              live &&
              index + 1 === visibleEvents.length &&
              !(ev.event === "allocating" && allocatingAnswered);
            const sentence = formatProvisionSentence(ev, !isCurrent, locale, t);
            if (!sentence) {
              return null;
            }
            const markerToneClass =
              sentence.tone === "good"
                ? "progress-marker icon-success"
                : sentence.tone === "warn"
                  ? "progress-marker icon-warning"
                  : sentence.tone === "bad"
                    ? "progress-marker icon-danger"
                    : "progress-marker icon-muted";
            return (
              <div className="progress-row" key={`${ev.event}-${index}`}>
                <span className={markerToneClass}>
                  {isCurrent && sentence.tone === "busy" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : sentence.tone === "good" ? (
                    <CheckCircleIcon />
                  ) : sentence.tone === "warn" ? (
                    <AlertTriangleIcon />
                  ) : sentence.tone === "bad" ? (
                    <CircleXIcon />
                  ) : isCurrent ? (
                    <DotIcon />
                  ) : (
                    <CheckCircleIcon />
                  )}
                </span>
                <span className="progress-text">{sentence.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {isAllocating && waitedMs >= SLOW_ANSWER_MS && (
        <div className="inline-msg inline-msg-info" role="status" data-provision-no-answer="true">
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">
            {t("app.b11.prov_no_answer", {
              time: formatDuration(Math.floor(waitedMs / MS_PER_SECOND), t),
            })}
          </span>
        </div>
      )}
    </>
  );
}
