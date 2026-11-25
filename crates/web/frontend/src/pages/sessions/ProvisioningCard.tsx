/**
 * In-flight session provisioning summary card attached to `POST /api/sessions/{id}/events`.
 */

import { useEffect, useState } from "react";

import { CheckCircleIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Locale, PendingOperation } from "../../lib/types.ts";
import {
  cancelProvision,
  openProvisionEventStream,
  type ProvisionFinishedEvent,
  type ProvisionProgressEvent,
} from "./api.ts";
import {
  formatErrorMessage,
  formatHardware,
  formatShortWait,
  formatVram,
} from "./format.ts";
import { AlertTriangleIcon, CircleXIcon, DotIcon, SmallInfoIcon } from "./Icons.tsx";

const SLOW_ANSWER_MS = 60_000;
const SLOW_ANSWER_POLL_MS = 15_000;
const MS_PER_SECOND = 1000;

interface ProvisionSentence {
  readonly text: string;
  readonly tone: "busy" | "good" | "warn" | "bad" | "neutral";
}

function parseProvisionEvent(raw: string): ProvisionProgressEvent | null {
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

function parseFinishedEvent(raw: string): ProvisionFinishedEvent | null {
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

function formatProvisionSentence(
  ev: ProvisionProgressEvent,
  completed: boolean,
  locale: Locale,
  t: TranslateFn,
): ProvisionSentence {
  const hw = (gpu: string | null, vramMib: number | null) =>
    formatHardware(gpu, vramMib, locale, t) ?? t("app.b2.prov_no_gpu");

  switch (ev.event) {
    case "allocating":
      return {
        text: t(completed ? "app.b3.prov_allocated" : "app.b2.prov_allocating", {
          n: ev.attempt,
          of: ev.of,
        }),
        tone: "busy",
      };
    case "allocation_failed":
      return {
        text: t("app.b2.prov_allocation_failed", {
          why: formatErrorMessage(ev.error, t).message,
        }),
        tone: "bad",
      };
    case "probed":
      return {
        text: t("app.b2.prov_probed", { hardware: hw(ev.gpu, ev.vram_mib) }),
        tone: "neutral",
      };
    case "rejected":
      return {
        text: t("app.b2.prov_rejected", {
          got: ev.got_mib !== null ? formatVram(ev.got_mib, locale, t) : t("app.b2.prov_no_gpu"),
          min: formatVram(ev.min_mib, locale, t),
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
    case "orphan_released":
      return { text: t("app.b2.prov_orphan_released"), tone: "good" };
    case "orphan_left":
      return { text: t("app.b2.prov_orphan_left"), tone: "bad" };
    case "retrying":
      return {
        text: t(completed ? "app.b3.prov_retried" : "app.b2.prov_retrying", {
          time: formatShortWait(ev.wait_secs, t),
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
  }
}

function formatHeadline(events: readonly ProvisionProgressEvent[], t: TranslateFn): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.event === "allocating") {
      return t("app.b2.prov_attempt", { n: ev.attempt, of: ev.of });
    }
    if (ev.event === "reconciling") {
      return t("app.b11.prov_reconciling");
    }
  }
  return t("app.b2.prov_starting");
}

export interface ProvisioningCardProps {
  readonly operation: PendingOperation;
  readonly sessionName: string;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  /** Optional seam for #45 to reopen the full New Session modal. */
  readonly onShowDialog?: () => void;
}

export function ProvisioningCard({
  operation,
  sessionName,
  locale,
  t,
  pushToast,
  onShowDialog,
}: ProvisioningCardProps) {
  const [events, setEvents] = useState<readonly ProvisionProgressEvent[]>([]);
  const [latestAtMs, setLatestAtMs] = useState<number>(() => Date.now());
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [cancelRequested, setCancelRequested] = useState(false);

  useEffect(() => {
    setEvents([]);
    setLatestAtMs(Date.now());
    setCancelRequested(false);

    const controller = new AbortController();
    void openProvisionEventStream(operation.id, {
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.event === "progress") {
          const parsed = parseProvisionEvent(frame.data);
          if (parsed) {
            setEvents((prev) => [...prev, parsed]);
            setLatestAtMs(Date.now());
          }
        } else if (frame.event === "finished") {
          const finished = parseFinishedEvent(frame.data);
          if (finished?.phase === "ready" && finished.outcome) {
            const readyEvent: ProvisionProgressEvent = {
              event: "ready",
              gpu: finished.outcome.hardware?.gpu ?? null,
              vram_mib: finished.outcome.hardware?.vram_mib ?? null,
              below_spec: Boolean(finished.outcome.below_spec),
            };
            setEvents((prev) =>
              prev.some((item) => item.event === "ready") ? prev : [...prev, readyEvent],
            );
          }
        }
      },
    }).catch(() => {
      // Stream disconnects are handled by snapshot operation lifecycle.
    });

    return () => {
      controller.abort();
    };
  }, [operation.id]);

  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const isAllocating = lastEvent?.event === "allocating";

  useEffect(() => {
    if (!isAllocating) {
      return;
    }
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, SLOW_ANSWER_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [isAllocating]);

  const cancelling = operation.cancelling || cancelRequested;
  const waitedMs = isAllocating ? Math.max(0, nowMs - latestAtMs) : 0;

  const handleCancel = async () => {
    if (cancelling) {
      return;
    }
    setCancelRequested(true);
    try {
      await cancelProvision(operation.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
      }
      setCancelRequested(false);
    }
  };

  return (
    <section className="card card-compact" data-sessions-provisioning="true">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.b2.sessions_starting", { name: sessionName })}</h2>
          <p className="card-desc">{formatHeadline(events, t)}</p>
        </div>
      </div>

      {events.length > 0 && (
        <div className="progress-list" data-provision-progress="true">
          {events.map((ev, index) => {
            const isCurrent = index + 1 === events.length;
            const sentence = formatProvisionSentence(ev, !isCurrent, locale, t);
            return (
              <div className="progress-row" key={`${ev.event}-${index}`}>
                <span className="progress-marker">
                  {isCurrent && sentence.tone === "busy" ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : sentence.tone === "good" ? (
                    <CheckCircleIcon />
                  ) : sentence.tone === "warn" ? (
                    <AlertTriangleIcon className="icon-warning" />
                  ) : sentence.tone === "bad" ? (
                    <CircleXIcon className="icon-danger" />
                  ) : isCurrent ? (
                    <DotIcon className="icon-muted" />
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
        <div className="inline-msg inline-msg-info">
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">
            {t("app.b11.prov_no_answer", {
              time: formatDuration(Math.floor(waitedMs / MS_PER_SECOND), t),
            })}
          </span>
        </div>
      )}

      <div className="session-actions">
        {onShowDialog && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-provisioning-show="true"
            onClick={onShowDialog}
          >
            {t("app.b2.action_show")}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          data-provisioning-cancel="true"
          disabled={cancelling}
          onClick={() => {
            void handleCancel();
          }}
        >
          {cancelling && <span className="spinner" aria-hidden="true" />}
          <span>{t(cancelling ? "app.b2.new_cancelling" : "app.action.cancel")}</span>
        </button>
      </div>
    </section>
  );
}
