/**
 * Reusable provisioning progress renderer, backed by pure formatting and
 * server-clock timing helpers in `provision.ts`.
 */

import { CheckCircleIcon } from "../../components/Icons.tsx";
import { useServerClockSecs } from "../../lib/clock.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale, UnixSecs } from "../../lib/types.ts";
import type { ProvisionProgressEvent } from "./api.ts";
import { AlertTriangleIcon, CircleXIcon, DotIcon, SmallInfoIcon } from "./Icons.tsx";
import {
  computeUnansweredForSecs,
  formatProvisionHeadline,
  formatProvisionSentence,
  hasProvisionLines,
  parseFinishedEvent,
  parseProvisionEvent,
  SLOW_ANSWER_SECS,
  type ProvisionSentence,
} from "./provision.ts";

export {
  computeUnansweredForSecs,
  formatProvisionHeadline,
  formatProvisionSentence,
  hasProvisionLines,
  parseFinishedEvent,
  parseProvisionEvent,
  SLOW_ANSWER_SECS,
  type ProvisionSentence,
};

const SLOW_ANSWER_POLL_MS = 15_000;
const MS_PER_SECOND = 1000;

export interface ProvisionProgressProps {
  readonly events: readonly ProvisionProgressEvent[];
  readonly live: boolean;
  readonly waitingSinceSecs?: UnixSecs | null;
  /** Legacy fallback for callers not yet passing server-anchored seconds. */
  readonly waitingSinceMs?: number | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
}

export function ProvisionProgress({
  events,
  live,
  waitingSinceSecs = null,
  waitingSinceMs = null,
  locale,
  t,
}: ProvisionProgressProps) {
  const nowSecs = useServerClockSecs(SLOW_ANSWER_POLL_MS);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const effectiveSinceSecs =
    waitingSinceSecs !== null
      ? waitingSinceSecs
      : waitingSinceMs !== null && Number.isFinite(waitingSinceMs)
        ? Math.floor(waitingSinceMs / MS_PER_SECOND)
        : null;
  const unansweredSecs = live
    ? computeUnansweredForSecs(events, effectiveSinceSecs, nowSecs)
    : null;

  const visibleEvents = events.filter(
    (ev) => formatProvisionSentence(ev, true, locale, t) !== null,
  );
  // Server emits `allocated` once Colab answers `allocating`, so only a trailing `allocating` is waiting.
  const allocatingAnswered = lastEvent !== null && lastEvent.event === "allocated";

  if (visibleEvents.length === 0 && unansweredSecs === null) {
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

      {unansweredSecs !== null && (
        <div className="inline-msg inline-msg-info" role="status" data-provision-no-answer="true">
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">
            {t("app.b11.prov_no_answer", {
              time: formatDuration(unansweredSecs, t),
            })}
          </span>
        </div>
      )}
    </>
  );
}
