/**
 * Native modal `<dialog>` for "Stop all and verify": confirms stopping every
 * running Colab runtime across all accounts and cancelling in-flight creations
 * while keeping the Web Server running, then reports either verified cleanup or
 * remaining runtimes and per-account lookup errors.
 */

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Account, Runtime, RuntimeRef, Snapshot } from "../../lib/types.ts";
import { fetchSessions, stopAllRuntimes, type StopAllResponse } from "./api.ts";
import {
  formatEmail,
  formatErrorMessage,
  formatRuntimeCardLabel,
  runtimeKey,
  type FormattedError,
} from "./format.ts";
import { AlertTriangleIcon, CheckIcon, SquareIcon } from "./Icons.tsx";
import { beginStopAll, recordEndedRuntime } from "./store.ts";

type StopAllPhase = "confirm" | "submitting" | "result";

export interface StopAllDialogProps {
  readonly openId: number | null;
  readonly snapshot: Snapshot | null;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
  readonly onCompleted: () => void;
}

export function StopAllDialog({
  openId,
  snapshot,
  t,
  pushToast,
  onClose,
  onCompleted,
}: StopAllDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeOpenIdRef = useRef<number>(0);

  const [phase, setPhase] = useState<StopAllPhase>("confirm");
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);
  const [result, setResult] = useState<StopAllResponse | null>(null);
  const [capturedRuntimes, setCapturedRuntimes] = useState<readonly Runtime[]>([]);
  const [capturedAccounts, setCapturedAccounts] = useState<readonly Account[]>([]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (openId === null) {
      activeOpenIdRef.current = 0;
      if (dialog?.open) {
        dialog.close();
      }
      return;
    }

    activeOpenIdRef.current = openId;
    setPhase("confirm");
    setSubmitError(null);
    setResult(null);
    setCapturedRuntimes([]);
    setCapturedAccounts([]);

    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [openId]);

  // Keep focus inside the open modal when actions swap between confirm and result phases.
  useEffect(() => {
    if (openId === null) {
      return;
    }
    if (phase === "result") {
      closeButtonRef.current?.focus();
    } else if (phase === "confirm") {
      cancelButtonRef.current?.focus();
    }
  }, [openId, phase]);

  const submitting = phase === "submitting";

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    if (!submitting) {
      onClose();
    }
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    if (openId !== null && !submitting) {
      onClose();
    }
  };

  const liveRuntimes = snapshot?.runtimes?.runtimes ?? [];
  const liveAccounts = snapshot?.accounts?.accounts ?? [];
  const operations = snapshot?.operations ?? [];
  const hasProvisioning = operations.some((entry) => entry.operation.kind === "provision");
  const hasPluginRun = operations.some((entry) => entry.operation.kind === "plugin_run");
  const hasUnknownAccounts =
    snapshot?.runtimes_error !== null || (snapshot?.runtimes?.errors.length ?? 0) > 0;

  const findAccountEmail = (accountId: string): string => {
    const matched =
      liveAccounts.find((item) => item.id === accountId) ??
      capturedAccounts.find((item) => item.id === accountId) ??
      null;
    return formatEmail(matched?.email, t);
  };

  const resolveRuntimeInfo = (
    target: RuntimeRef,
  ): { readonly label: string; readonly email: string; readonly unmanaged: boolean } => {
    const key = runtimeKey(target);
    const matched =
      liveRuntimes.find((rt) => runtimeKey(rt.id) === key) ??
      capturedRuntimes.find((rt) => runtimeKey(rt.id) === key) ??
      null;
    return {
      label: matched ? formatRuntimeCardLabel(matched) : (target.name ?? target.endpoint),
      email: matched?.account_email
        ? formatEmail(matched.account_email, t)
        : findAccountEmail(target.account),
      unmanaged: matched !== null && !matched.managed,
    };
  };

  const handleConfirm = async () => {
    if (openId === null || submitting) {
      return;
    }

    const requestOpenId = openId;
    const sessionGeneration = apiClient.getSessionGeneration();
    const preStopRuntimes = liveRuntimes;
    const preStopAccounts = liveAccounts;
    setCapturedRuntimes(preStopRuntimes);
    setCapturedAccounts(preStopAccounts);
    setPhase("submitting");
    setSubmitError(null);
    setResult(null);

    const releasePending = beginStopAll();
    try {
      const report = await stopAllRuntimes();
      if (apiClient.getSessionGeneration() !== sessionGeneration) {
        return;
      }
      const remainingKeys = new Set(report.remaining.map((item) => runtimeKey(item.target)));
      const erroredAccounts = new Set(report.account_errors.map((item) => item.account));
      for (const rt of preStopRuntimes) {
        const key = runtimeKey(rt.id);
        if (!remainingKeys.has(key) && !erroredAccounts.has(rt.id.account)) {
          recordEndedRuntime({
            runtime: rt.id,
            label: formatRuntimeCardLabel(rt),
            email: rt.account_email,
            reason: { kind: "user" },
          });
        }
      }
      if (activeOpenIdRef.current !== requestOpenId) {
        return;
      }
      setResult(report);
      setPhase("result");
      if (report.verified) {
        pushToast({
          tone: "success",
          body: t("web.sessions.stop_all_verified"),
        });
      }
      onCompleted();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        setPhase("confirm");
        onClose();
        return;
      }
      if (apiClient.getSessionGeneration() !== sessionGeneration) {
        return;
      }
      // Refresh runtimes in the background so any runtimes stopped before a verification-listing
      // failure still reconcile into the live list and Recently ended once listing succeeds.
      void fetchSessions()
        .then(() => webStore.refreshSnapshot())
        .catch(() => {});
      if (activeOpenIdRef.current !== requestOpenId) {
        return;
      }
      setPhase("confirm");
      setSubmitError(formatErrorMessage(error, t));
    } finally {
      releasePending();
    }
  };

  const closedByAttr = {
    closedby: submitting ? "none" : "closerequest",
  } as Record<string, string>;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      data-dialog-kind={openId !== null ? "stop_all" : undefined}
      data-dialog-phase={openId !== null ? phase : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      {openId !== null && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("web.sessions.stop_all_title")}
          </h1>

          <div className="dialog-body">
            {phase !== "result" ? (
              <>
                <p className="dialog-paragraph">{t("web.sessions.stop_all_web_note")}</p>

                {hasProvisioning && (
                  <div className="inline-msg inline-msg-warning">
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">{t("app.b2.quit_provisioning")}</span>
                  </div>
                )}

                {hasPluginRun && (
                  <div className="inline-msg inline-msg-warning">
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">{t("app.b2.quit_running_plugin")}</span>
                  </div>
                )}

                {hasUnknownAccounts && (
                  <div className="inline-msg inline-msg-warning">
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">{t("app.b2.quit_unknown")}</span>
                  </div>
                )}

                {liveRuntimes.length > 0 && (
                  <ul className="stop-all-list" data-stop-all-list="true">
                    {liveRuntimes.map((runtime) => {
                      const label = formatRuntimeCardLabel(runtime);
                      const email = formatEmail(runtime.account_email, t);
                      return (
                        <li className="stop-all-item" key={runtimeKey(runtime.id)}>
                          <span>{t("app.b2.ended_line", { name: label, email })}</span>
                          {!runtime.managed && (
                            <span className="badge badge-warning">
                              {t("app.b2.runtime_unmanaged")}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="inline-msg inline-msg-warning">
                  <AlertTriangleIcon className="icon-xs icon-warning" />
                  <span className="inline-msg-text">{t("app.b3.quit_stop_wiped")}</span>
                </div>

                {submitting && (
                  <div className="busy-line" role="status" aria-live="polite">
                    <span className="spinner" aria-hidden="true" />
                    <span>{t("app.b2.quit_stopping")}</span>
                  </div>
                )}

                {submitError && (
                  <div className="alert alert-danger" role="alert">
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">
                        {t("app.b9.quit_stop_all_failed", { why: submitError.message })}
                      </p>
                      {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                    </div>
                  </div>
                )}
              </>
            ) : result?.verified ? (
              <div className="alert alert-success" role="status" data-stop-all-verified="true">
                <span className="alert-icon icon-success">
                  <CheckIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{t("web.sessions.stop_all_verified")}</p>
                </div>
              </div>
            ) : (
              <>
                {result && result.remaining.length > 0 && (
                  <>
                    <div
                      className="inline-msg inline-msg-danger"
                      role="alert"
                      data-stop-all-remaining="true"
                    >
                      <AlertTriangleIcon className="icon-xs icon-danger" />
                      <span className="inline-msg-text">
                        {t("web.sessions.stop_all_remaining")}
                      </span>
                    </div>
                    <ul className="stop-all-list">
                      {result.remaining.map((item) => {
                        const info = resolveRuntimeInfo(item.target);
                        const displayName = t("app.b2.ended_line", {
                          name: info.label,
                          email: info.email,
                        });
                        const err = item.error ? formatErrorMessage(item.error, t) : null;
                        return (
                          <li className="stop-all-item" key={runtimeKey(item.target)}>
                            <span>
                              {err
                                ? t("app.b2.quit_stop_failed", {
                                    name: displayName,
                                    why: err.message,
                                  })
                                : displayName}
                            </span>
                            {info.unmanaged && (
                              <span className="badge badge-warning">
                                {t("app.b2.runtime_unmanaged")}
                              </span>
                            )}
                            {err?.hint && <p className="dialog-caption">{err.hint}</p>}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}

                {result &&
                  result.account_errors.map((failure) => {
                    const formatted = formatErrorMessage(failure.error, t);
                    const body = [formatted.message, formatted.hint].filter(Boolean).join("\n");
                    return (
                      <div
                        className="alert alert-danger"
                        role="alert"
                        key={failure.account}
                        data-stop-all-account-error={failure.account}
                      >
                        <span className="alert-icon icon-danger">
                          <AlertIcon />
                        </span>
                        <div className="alert-text">
                          <p className="alert-title">
                            {t("app.b2.sessions_account_failed", {
                              email: findAccountEmail(failure.account),
                            })}
                          </p>
                          {body && <p className="alert-body">{body}</p>}
                        </div>
                      </div>
                    );
                  })}
              </>
            )}
          </div>

          <div className="modal-actions">
            {phase === "result" ? (
              <>
                <button
                  ref={closeButtonRef}
                  type="button"
                  className={result?.verified ? "btn btn-primary" : "btn btn-ghost"}
                  data-stop-all-close="true"
                  onClick={onClose}
                >
                  {t("app.action.close")}
                </button>
                {!result?.verified && (
                  <button
                    type="button"
                    className="btn"
                    data-stop-all-retry="true"
                    onClick={() => {
                      setResult(null);
                      setSubmitError(null);
                      setPhase("confirm");
                    }}
                  >
                    {t("app.action.retry")}
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  ref={cancelButtonRef}
                  type="button"
                  className="btn btn-ghost"
                  disabled={submitting}
                  autoFocus
                  onClick={onClose}
                >
                  {t("app.action.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  data-stop-all-confirm="true"
                  disabled={submitting}
                  onClick={() => {
                    void handleConfirm();
                  }}
                >
                  {submitting ? <span className="spinner" aria-hidden="true" /> : <SquareIcon />}
                  <span>{t("web.sessions.stop_all_action")}</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
