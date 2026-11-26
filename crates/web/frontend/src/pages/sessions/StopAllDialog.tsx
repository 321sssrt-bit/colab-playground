/**
 * Global native modal `<dialog>` for "Stop all and verify": confirms stopping
 * every running Colab runtime across all accounts and cancelling in-flight
 * creations while keeping the Web Server running, then reports either verified
 * cleanup or remaining runtimes and per-account lookup errors.
 *
 * Mounted in `App.tsx` and driven by `stopDialogsStore` so route switches never
 * unmount an active stop-all or drop a `verified: false` verification report.
 */

import { useEffect, useId, useMemo, useRef, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import type { TranslateFn } from "../../lib/i18n.ts";
import {
  countStopAllProtection,
  isStopAllRuntimesLoading,
  type StopAllDialogState,
} from "../../lib/stopDialogs.ts";
import type { RuntimeRef, Snapshot } from "../../lib/types.ts";
import {
  formatEmail,
  formatErrorMessage,
  formatRuntimeCardLabel,
  runtimeKey,
} from "./format.ts";
import { AlertTriangleIcon, CheckIcon, SquareIcon } from "./Icons.tsx";

export interface StopAllDialogProps {
  readonly state: StopAllDialogState;
  readonly snapshot: Snapshot | null;
  readonly sessionsRefreshing: boolean;
  readonly t: TranslateFn;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function StopAllDialog({
  state,
  snapshot,
  sessionsRefreshing,
  t,
  onClose,
  onConfirm,
}: StopAllDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const { open, phase, result, submitError, capturedRuntimes, capturedAccounts } = state;
  const submitting = phase === "submitting";
  const showingReport = result !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open) {
      if (dialog?.open) {
        dialog.close();
      }
      return;
    }
    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [open, state.openId]);

  // Keep focus inside the open modal when actions swap between confirm and result views.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (showingReport) {
      closeButtonRef.current?.focus();
    } else {
      cancelButtonRef.current?.focus();
    }
  }, [open, showingReport]);

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
    if (open && !submitting) {
      onClose();
    }
  };

  const runtimesLoading = isStopAllRuntimesLoading(snapshot, sessionsRefreshing);
  const liveRuntimes = snapshot?.runtimes?.runtimes ?? [];
  const displayRuntimes = liveRuntimes.length > 0 ? liveRuntimes : capturedRuntimes;
  const liveAccounts = snapshot?.accounts?.accounts ?? [];
  const operations = snapshot?.operations ?? [];
  const hasProvisioning = operations.some((entry) => entry.operation.kind === "provision");
  const hasPluginRun = operations.some((entry) => entry.operation.kind === "plugin_run");
  const hasUnknownAccounts =
    !runtimesLoading &&
    ((snapshot?.runtimes_error ?? null) !== null || (snapshot?.runtimes?.errors.length ?? 0) > 0);

  const protectionCounts = useMemo(
    () => countStopAllProtection(displayRuntimes),
    [displayRuntimes],
  );

  const formattedSubmitError = useMemo(
    () => (submitError !== null ? formatErrorMessage(submitError, t) : null),
    [submitError, t],
  );

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

  const closedByAttr = {
    closedby: submitting ? "none" : "closerequest",
  } as Record<string, string>;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      data-dialog-kind={open ? "stop_all" : undefined}
      data-dialog-phase={open ? phase : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      {open && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("web.sessions.stop_all_title")}
          </h1>

          <div className="dialog-body">
            {!showingReport ? (
              <>
                <p className="dialog-paragraph">{t("web.sessions.stop_all_web_note")}</p>

                {runtimesLoading && (
                  <div
                    className="busy-line"
                    role="status"
                    aria-live="polite"
                    data-stop-all-loading="true"
                  >
                    <span className="spinner" aria-hidden="true" />
                    <span>{t("app.b9.quit_title_checking")}</span>
                  </div>
                )}

                {!runtimesLoading && protectionCounts.watched > 0 && (
                  <p className="dialog-paragraph" data-stop-all-watched="true">
                    {protectionCounts.watched === 1
                      ? t("app.b2.quit_watched_one")
                      : t("app.b2.quit_watched_many", { count: protectionCounts.watched })}
                  </p>
                )}

                {!runtimesLoading && protectionCounts.unwatched > 0 && (
                  <div className="inline-msg inline-msg-warning" data-stop-all-unwatched="true">
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">
                      {protectionCounts.unwatched === 1
                        ? t("app.b2.quit_unwatched_one")
                        : t("app.b2.quit_unwatched_many", {
                            count: protectionCounts.unwatched,
                          })}
                    </span>
                  </div>
                )}

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

                {displayRuntimes.length > 0 && (
                  <ul className="stop-all-list" data-stop-all-list="true">
                    {displayRuntimes.map((runtime) => {
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

                {formattedSubmitError && (
                  <div className="alert alert-danger" role="alert">
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">
                        {t("app.b9.quit_stop_all_failed", { why: formattedSubmitError.message })}
                      </p>
                      {formattedSubmitError.hint && (
                        <p className="alert-body">{formattedSubmitError.hint}</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : result.verified ? (
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
                {result.remaining.length > 0 && (
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
                    <ul className="stop-all-list" data-stop-all-remaining-list="true">
                      {result.remaining.map((item) => {
                        const info = resolveRuntimeInfo(item.target);
                        const displayName = t("app.b2.ended_line", {
                          name: info.label,
                          email: info.email,
                        });
                        const err = item.error ? formatErrorMessage(item.error, t) : null;
                        // When stop succeeded yet the runtime remained listed, explain it is still billing.
                        const why = err ? err.message : t("app.b2.run_session_billing");
                        return (
                          <li className="stop-all-item" key={runtimeKey(item.target)}>
                            <span>
                              {t("app.b2.quit_stop_failed", {
                                name: displayName,
                                why,
                              })}
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

                {result.account_errors.map((failure) => {
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

                {submitting && (
                  <div className="busy-line" role="status" aria-live="polite">
                    <span className="spinner" aria-hidden="true" />
                    <span>{t("app.b2.quit_stopping")}</span>
                  </div>
                )}

                {!submitting && runtimesLoading && (
                  <div
                    className="busy-line"
                    role="status"
                    aria-live="polite"
                    data-stop-all-loading="true"
                  >
                    <span className="spinner" aria-hidden="true" />
                    <span>{t("app.b9.quit_title_checking")}</span>
                  </div>
                )}

                {formattedSubmitError && (
                  <div className="alert alert-danger" role="alert">
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">
                        {t("app.b9.quit_stop_all_failed", { why: formattedSubmitError.message })}
                      </p>
                      {formattedSubmitError.hint && (
                        <p className="alert-body">{formattedSubmitError.hint}</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="modal-actions">
            {showingReport ? (
              <>
                <button
                  ref={closeButtonRef}
                  type="button"
                  className={result.verified ? "btn btn-primary" : "btn btn-ghost"}
                  data-stop-all-close="true"
                  disabled={submitting}
                  onClick={onClose}
                >
                  {t("app.action.close")}
                </button>
                {!result.verified && (
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-stop-all-retry="true"
                    disabled={submitting || runtimesLoading}
                    onClick={onConfirm}
                  >
                    {submitting ? <span className="spinner" aria-hidden="true" /> : <SquareIcon />}
                    <span>{t("app.action.retry")}</span>
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
                  disabled={submitting || runtimesLoading}
                  onClick={onConfirm}
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
