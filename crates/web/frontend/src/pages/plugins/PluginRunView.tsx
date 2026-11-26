/**
 * Live Plugin run detail view: provisioning progress, manifest stages with native
 * `<progress>`, cancel with new/existing session consequence notice, post-failure/cancel
 * billing verification with direct `StopRuntimeDialog` stop action, ready Endpoint cards,
 * structured outputs, and redacted streaming logs with truncation/skipped-path notices.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon, CheckCircleIcon, InfoIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import { appDataStore } from "../../lib/appCache.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { RouteId } from "../../lib/router.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Locale, Runtime, Snapshot } from "../../lib/types.ts";
import type {
  ForwardAddresses,
  ForwardPolicyView,
  ProvisionProgressEvent,
} from "../sessions/api.ts";
import {
  formatErrorMessage,
  formatHardware,
  formatShortWait,
  formatVram,
} from "../sessions/format.ts";
import {
  AlertTriangleIcon,
  CircleXIcon,
  DotIcon,
  SmallInfoIcon,
  SquareIcon,
} from "../sessions/Icons.tsx";
import { resolveLocalizedText } from "./api.ts";
import { selectEndpointTunnelById, type ForwardLiveOverlay } from "./endpoint.ts";
import { EndpointCard } from "./EndpointCard.tsx";
import { requestCancelPluginRun } from "./runStore.ts";
import type { PluginInfo, PluginRunDetail } from "./types.ts";

const SLOW_ANSWER_MS = 60_000;
const SLOW_ANSWER_POLL_MS = 15_000;
const MS_PER_SECOND = 1000;
const AUTO_SCROLL_TOLERANCE_PX = 24;

interface ProvisionSentence {
  readonly text: string;
  readonly tone: "busy" | "good" | "warn" | "bad" | "neutral";
}

interface BillingCheckResult {
  readonly runId: number;
  readonly status: "checking" | "verified" | "error";
  readonly runtime: Runtime | null;
  readonly accountErrored: boolean;
  readonly snapshotVersion: number;
}

function ArrowLeftIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function formatProvisionSentence(
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
          got: ev.vram_mib !== null ? formatVram(ev.vram_mib, locale, t) : t("app.b2.prov_no_gpu"),
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
        ? { text: t("app.b2.prov_orphan_released"), tone: "good" }
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

function formatProvisionHeadline(
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

function formatOutputValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface PluginRunViewProps {
  readonly run: PluginRunDetail;
  readonly plugin: PluginInfo | null;
  readonly snapshot: Snapshot | null;
  readonly endpointForwardIdsByKey: Readonly<Record<string, number | null>>;
  readonly forwardAddressesById: Readonly<Record<number, ForwardAddresses>>;
  readonly forwardOverlaysById: Readonly<Record<number, ForwardLiveOverlay>>;
  readonly forwardPolicy: ForwardPolicyView | null;
  readonly forwardPolicyLoading: boolean;
  readonly forwardPolicyError: unknown | null;
  readonly onRetryForwardPolicy: () => void;
  readonly billingRecheckSeq: number;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId) => void;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onBack: () => void;
  readonly onRequestStopRuntime: (runtime: Runtime) => void;
  /** Optional seam for #50 to reopen the dynamic plugin deploy form. */
  readonly onRunAgain?: (pluginId: string) => void;
}

export function PluginRunView({
  run,
  plugin,
  snapshot,
  endpointForwardIdsByKey,
  forwardAddressesById,
  forwardOverlaysById,
  forwardPolicy,
  forwardPolicyLoading,
  forwardPolicyError,
  onRetryForwardPolicy,
  billingRecheckSeq,
  locale,
  t,
  navigate,
  pushToast,
  onBack,
  onRequestStopRuntime,
  onRunAgain,
}: PluginRunViewProps) {
  const stageIdPrefix = useId();
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const billingSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [billingCheck, setBillingCheck] = useState<BillingCheckResult>({
    runId: run.id,
    status: "checking",
    runtime: null,
    accountErrored: false,
    snapshotVersion: 0,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isRunning = run.phase === "running";
  const isEndedErrorOrCancel = run.phase === "failed" || run.phase === "cancelled";
  const provisioning = isRunning && run.provisions && !run.launched;
  const lastProvisionEvent =
    run.provisionEvents.length > 0 ? run.provisionEvents[run.provisionEvents.length - 1] : null;
  const isAllocating = provisioning && lastProvisionEvent?.event === "allocating";

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
  }, [isAllocating]);

  const verifyBilling = useCallback(async () => {
    const seq = ++billingSeqRef.current;
    const gen = apiClient.getSessionGeneration();
    const targetRunId = run.id;
    const targetAccount = run.account;
    const targetSession = run.session;

    setBillingCheck({
      runId: targetRunId,
      status: "checking",
      runtime: null,
      accountErrored: false,
      snapshotVersion: webStore.getState().snapshot?.version ?? 0,
    });

    try {
      const sessions = await appDataStore.refreshSessions();
      if (
        !mountedRef.current ||
        seq !== billingSeqRef.current ||
        apiClient.getSessionGeneration() !== gen
      ) {
        return;
      }
      const matched =
        sessions.runtimes.find(
          (rt) => rt.id.account === targetAccount && rt.id.name === targetSession,
        ) ?? null;
      const accountErrored = sessions.errors.some((err) => err.account === targetAccount);
      setBillingCheck({
        runId: targetRunId,
        status: "verified",
        runtime: matched,
        accountErrored,
        snapshotVersion: webStore.getState().snapshot?.version ?? 0,
      });
    } catch (error) {
      if (
        !mountedRef.current ||
        seq !== billingSeqRef.current ||
        apiClient.getSessionGeneration() !== gen ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setBillingCheck({
        runId: targetRunId,
        status: "error",
        runtime: null,
        accountErrored: true,
        snapshotVersion: webStore.getState().snapshot?.version ?? 0,
      });
    }
  }, [run.id, run.account, run.session]);

  useEffect(() => {
    if (!isEndedErrorOrCancel) {
      return;
    }
    void verifyBilling();
  }, [isEndedErrorOrCancel, verifyBilling, billingRecheckSeq]);

  // Keep the log viewport pinned to the latest line unless the user scrolled up to read history.
  useEffect(() => {
    const box = logBoxRef.current;
    if (box && stickToBottomRef.current) {
      box.scrollTop = box.scrollHeight;
    }
  }, [run.logEntries.length]);

  useEffect(() => {
    stickToBottomRef.current = true;
  }, [run.id]);

  const handleLogScroll = () => {
    const box = logBoxRef.current;
    if (!box) {
      return;
    }
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= AUTO_SCROLL_TOLERANCE_PX;
  };

  const shuttingDown = snapshot?.shutting_down === true;
  const cancellingOp =
    snapshot?.operations.some((op) => op.id === run.id && op.cancelling) ?? false;
  const cancelling = run.cancelRequested || cancellingOp;

  const handleCancel = async () => {
    if (cancelling || shuttingDown) {
      return;
    }
    try {
      await requestCancelPluginRun(run.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
      }
    }
  };

  const pluginName = plugin
    ? resolveLocalizedText(plugin.manifest.name, locale, plugin.manifest.id)
    : run.plugin;
  const showSessionSubtitle = run.launched || !run.provisions || run.outcome !== null;
  const subtitle = showSessionSubtitle
    ? t("app.b2.run_on_session", { name: run.session })
    : t("app.b2.run_subtitle");

  const visibleProvisionEvents = run.provisionEvents.filter(
    (ev) => formatProvisionSentence(ev, true, locale, t) !== null,
  );
  const allocatingAnswered = lastProvisionEvent !== null && lastProvisionEvent.event === "allocated";
  const waitedMs = isAllocating ? Math.max(0, nowMs - run.latestProvisionAtMs) : 0;

  const manifestStages = plugin?.manifest.stages ?? [];
  const currentStageId = run.status?.stage ?? null;
  const currentStageIndex =
    currentStageId !== null
      ? manifestStages.findIndex((stage) => stage.id === currentStageId)
      : -1;
  const runFailedOrCancelled =
    run.phase === "failed" || run.phase === "cancelled" || run.status?.state === "failed";

  // Match the run's runtime against the freshly verified `/api/sessions` response, preferring
  // any newer clean SSE snapshot so stops performed in another tab or by the guard clear immediately.
  const snapshotRuntime =
    snapshot?.runtimes?.runtimes.find(
      (rt) => rt.id.account === run.account && rt.id.name === run.session,
    ) ?? null;
  const snapshotErroredForAccount =
    snapshot?.runtimes_error !== null ||
    Boolean(snapshot?.runtimes?.errors.some((err) => err.account === run.account));
  const billingCheckMatchesRun = billingCheck.runId === run.id;
  const snapshotNewerThanVerify =
    billingCheckMatchesRun &&
    snapshot !== null &&
    snapshot.version > billingCheck.snapshotVersion &&
    snapshot.runtimes !== null &&
    !snapshotErroredForAccount;
  const verifiedRuntime =
    billingCheckMatchesRun && billingCheck.status === "verified"
      ? snapshotNewerThanVerify
        ? snapshotRuntime
        : billingCheck.runtime
      : snapshotRuntime;
  const billingChecking =
    !billingCheckMatchesRun || billingCheck.status === "checking";
  const billingCheckFailed =
    billingCheckMatchesRun &&
    (billingCheck.status === "error" ||
      (billingCheck.status === "verified" &&
        billingCheck.accountErrored &&
        !snapshotNewerThanVerify));

  const outputEntries = run.status?.outputs ? Object.entries(run.status.outputs) : [];
  const hasSecretInput =
    plugin?.manifest.inputs.some((input) => input.type === "secret") ?? false;
  const formattedRunError = run.error ? formatErrorMessage(run.error, t) : null;
  const formattedStreamError = run.streamError ? formatErrorMessage(run.streamError, t) : null;

  return (
    <>
      <header className="page-header page-header-row">
        <div className="page-header-heading">
          <h1 className="page-title">{pluginName}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-plugin-run-back="true"
            onClick={onBack}
          >
            <ArrowLeftIcon />
            <span>{t("app.b2.action_back")}</span>
          </button>
        </div>
      </header>

      <div className="page-sections" data-plugin-run-view={String(run.id)} data-plugin-run-phase={run.phase}>
        {formattedStreamError && (
          <div className="alert alert-warning" role="alert">
            <span className="alert-icon icon-warning">
              <AlertTriangleIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{formattedStreamError.message}</p>
              {formattedStreamError.hint && (
                <p className="alert-body">{formattedStreamError.hint}</p>
              )}
            </div>
          </div>
        )}

        {run.provisions && visibleProvisionEvents.length > 0 && (
          <section className="card card-compact" data-plugin-run-provision="true">
            <div className="card-header">
              <div className="card-heading">
                <h2 className="card-title">{t("app.b2.run_provisioning")}</h2>
                <p className="card-desc">{formatProvisionHeadline(run.provisionEvents, t)}</p>
              </div>
            </div>

            <div className="progress-list">
              {visibleProvisionEvents.map((ev, index) => {
                const isCurrent =
                  provisioning &&
                  index + 1 === visibleProvisionEvents.length &&
                  !(ev.event === "allocating" && allocatingAnswered);
                const sentence = formatProvisionSentence(ev, !isCurrent, locale, t);
                if (!sentence) {
                  return null;
                }
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
          </section>
        )}

        {manifestStages.length > 0 && (
          <section className="card card-compact" data-plugin-run-stages="true">
            <div className="card-header">
              <div className="card-heading">
                <h2 className="card-title">{t("app.b2.run_stages")}</h2>
              </div>
            </div>

            <div className="stage-list">
              {manifestStages.map((stage, index) => {
                const label = resolveLocalizedText(stage.label, locale, stage.id);
                const labelId = `${stageIdPrefix}-stage-${stage.id}`;
                const isCurrent = index === currentStageIndex;
                const done =
                  run.phase === "ready" || (currentStageIndex !== -1 && index < currentStageIndex);

                return (
                  <div
                    className="stage-row"
                    key={stage.id}
                    data-stage-id={stage.id}
                    data-stage-state={
                      done
                        ? "done"
                        : isCurrent && runFailedOrCancelled
                          ? "failed"
                          : isCurrent
                            ? "active"
                            : "pending"
                    }
                  >
                    <div className="stage-row-main">
                      {done ? (
                        <span className="icon-success">
                          <CheckCircleIcon />
                        </span>
                      ) : isCurrent && runFailedOrCancelled ? (
                        <CircleXIcon className="icon-danger" />
                      ) : isCurrent ? (
                        <span className="spinner" aria-hidden="true" />
                      ) : (
                        <DotIcon className="icon-subtle" />
                      )}
                      <span
                        id={labelId}
                        className={isCurrent ? "stage-row-label-active" : undefined}
                      >
                        {label}
                      </span>
                    </div>

                    {isCurrent && !done && (
                      <div className="stage-row-detail">
                        {run.status?.progress !== null && run.status?.progress !== undefined && (
                          <progress
                            className="stage-progress"
                            value={Math.min(1, Math.max(0, run.status.progress))}
                            max={1}
                            aria-labelledby={labelId}
                          />
                        )}
                        {run.status?.message && (
                          <span className="caption">{run.status.message}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="run-outcome-section" data-plugin-run-outcome={run.phase}>
          {run.phase === "running" && (
            <div className="plugin-submit-row">
              <button
                type="button"
                className="btn btn-danger"
                data-plugin-run-cancel="true"
                disabled={cancelling || shuttingDown}
                onClick={() => {
                  void handleCancel();
                }}
              >
                {cancelling && <span className="spinner" aria-hidden="true" />}
                <span>{t(cancelling ? "app.b2.new_cancelling" : "app.action.cancel")}</span>
              </button>
              <span className="caption" data-plugin-run-cancel-note={run.provisions ? "new" : "existing"}>
                {t(run.provisions ? "app.b2.run_cancel_note_new" : "app.b2.run_cancel_note_existing")}
              </span>
            </div>
          )}

          {run.phase === "ready" && (
            <div className="inline-msg inline-msg-success" role="status" aria-live="polite">
              <CheckCircleIcon />
              <span className="inline-msg-text">{t("app.b2.run_ready")}</span>
            </div>
          )}

          {run.phase === "failed" && (
            <div className="alert alert-danger" role="alert">
              <span className="alert-icon icon-danger">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-title">{t("app.b2.run_failed")}</p>
                {formattedRunError && <p className="alert-body">{formattedRunError.message}</p>}
                {formattedRunError?.hint && <p className="alert-body">{formattedRunError.hint}</p>}
              </div>
            </div>
          )}

          {run.phase === "cancelled" && (
            <div className="inline-msg inline-msg-info" role="status" aria-live="polite">
              <InfoIcon />
              <span className="inline-msg-text">{t("app.b2.run_cancelled")}</span>
            </div>
          )}

          {isEndedErrorOrCancel && (
            <div className="run-outcome-section" data-plugin-run-billing="true">
              {verifiedRuntime ? (
                <div className="alert alert-warning" role="alert" data-run-session-billing="true">
                  <span className="alert-icon icon-warning">
                    <AlertTriangleIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{t("app.b2.run_session_billing")}</p>
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        data-plugin-run-stop="true"
                        disabled={shuttingDown}
                        onClick={() => onRequestStopRuntime(verifiedRuntime)}
                      >
                        <SquareIcon />
                        <span>{t("app.b2.stop_action")}</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : billingChecking ? (
                <div className="busy-line" role="status" aria-live="polite" data-run-checking="true">
                  <span className="spinner" aria-hidden="true" />
                  <span>{t("app.b2.run_checking")}</span>
                </div>
              ) : billingCheckFailed ? (
                <div className="alert alert-warning" role="alert" data-run-session-unknown="true">
                  <span className="alert-icon icon-warning">
                    <AlertTriangleIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-body">{t("app.b2.run_session_unknown")}</p>
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          void verifyBilling();
                        }}
                      >
                        {t("app.action.retry")}
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => navigate("sessions")}
                      >
                        {t("app.action.view_sessions")}
                      </button>
                    </div>
                  </div>
                </div>
              ) : run.provisions && !run.launched && !run.provisionAllocated ? (
                <p className="caption" data-run-no-session="true">
                  {t("app.b2.run_no_session")}
                </p>
              ) : (
                <div
                  className="inline-msg inline-msg-info"
                  role="status"
                  aria-live="polite"
                  data-run-session-stopped="true"
                >
                  <InfoIcon />
                  <span className="inline-msg-text">{t("app.b2.run_session_stopped")}</span>
                </div>
              )}
            </div>
          )}

          {!isRunning && onRunAgain && (
            <div className="plugin-submit-row">
              <button
                type="button"
                className="btn"
                data-plugin-run-again="true"
                disabled={shuttingDown}
                onClick={() => onRunAgain(run.plugin)}
              >
                {t("app.b2.run_again")}
              </button>
            </div>
          )}
        </div>

        {run.phase === "ready" &&
          run.outcome !== null &&
          run.endpoints.map((item) => {
            const forwardKey = `${run.id}:${item.endpoint.id}`;
            const trackedForwardId = Object.hasOwn(endpointForwardIdsByKey, forwardKey)
              ? endpointForwardIdsByKey[forwardKey]
              : (item.forward?.id ?? null);
            const activeTunnel = selectEndpointTunnelById(
              snapshot?.tunnels ?? [],
              trackedForwardId,
              forwardOverlaysById,
              snapshot?.version ?? 0,
            );
            const serverAddresses = activeTunnel
              ? (forwardAddressesById[activeTunnel.id] ??
                (item.forward?.id === activeTunnel.id ? (item.forward.addresses ?? null) : null))
              : null;

            return (
              <EndpointCard
                key={item.endpoint.id}
                runId={run.id}
                endpoint={item.endpoint}
                outcome={run.outcome!}
                initialError={item.error}
                activeTunnel={activeTunnel}
                serverAddresses={serverAddresses}
                forwardPolicy={forwardPolicy}
                forwardPolicyLoading={forwardPolicyLoading}
                forwardPolicyError={forwardPolicyError}
                onRetryForwardPolicy={onRetryForwardPolicy}
                currentAccountContext={snapshot?.account ?? null}
                hasSecretInput={hasSecretInput}
                shuttingDown={shuttingDown}
                locale={locale}
                t={t}
                pushToast={pushToast}
              />
            );
          })}

        {outputEntries.length > 0 && (
          <section className="card card-compact" data-plugin-run-outputs="true">
            <div className="card-header">
              <div className="card-heading">
                <h2 className="card-title">{t("app.b2.run_outputs")}</h2>
              </div>
            </div>
            <div className="run-outputs-list">
              {outputEntries.map(([key, value]) => (
                <div className="run-output-row" key={key}>
                  <span className="run-output-key">{key}</span>
                  <span className="run-output-val mono">{formatOutputValue(value)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {run.logEntries.length > 0 && (
          <section className="card card-compact" data-plugin-run-log="true">
            <div className="card-header">
              <div className="card-heading">
                <h2 className="card-title">{t("app.b2.run_log")}</h2>
              </div>
            </div>
            <div
              ref={logBoxRef}
              className="run-log-box"
              role="log"
              aria-live="off"
              onScroll={handleLogScroll}
            >
              {run.logEntries.map((entry, index) => {
                if (entry.kind === "history_skipped") {
                  return (
                    <div
                      className="run-log-line-notice"
                      data-log-notice="history_skipped"
                      key={`history-${index}`}
                    >
                      {t("web.plugins.history_skipped")}
                    </div>
                  );
                }
                if (entry.kind === "log_skipped") {
                  return (
                    <div
                      className="run-log-line-notice"
                      data-log-notice="log_skipped"
                      key={`skipped-${index}`}
                    >
                      {t(entry.message_key, { path: entry.path })}
                    </div>
                  );
                }
                return (
                  <div className="run-log-line" key={`line-${index}`}>
                    {entry.text}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
