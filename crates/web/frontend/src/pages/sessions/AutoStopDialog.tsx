/**
 * Native modal `<dialog>` for extending, setting, and cancelling auto-stop on a
 * named managed runtime. Preserves user draft inputs across live SSE snapshots
 * and 15-second countdown ticks.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { AccountContext, Runtime } from "../../lib/types.ts";
import { changeAutoStop } from "./api.ts";
import {
  composeDurationSeconds,
  formatErrorMessage,
  formatRuntimeCardLabel,
  MAX_HOURS_INPUT,
  MAX_MINUTES_INPUT,
  splitDurationHoursMinutes,
  type FormattedError,
} from "./format.ts";
import { AlertTriangleIcon, SmallAlertIcon } from "./Icons.tsx";

export type AutoStopDialogMode = "extend" | "set" | "cancel";

export interface AutoStopDialogRequest {
  readonly id: number;
  readonly mode: AutoStopDialogMode;
  readonly runtime: Runtime;
  readonly accountContext: AccountContext;
  readonly defaultSeconds: number;
}

export interface AutoStopDialogProps {
  readonly request: AutoStopDialogRequest | null;
  readonly currentAccountContext: AccountContext | null;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
  readonly onCompleted: () => void;
}

export function AutoStopDialog({
  request,
  currentAccountContext,
  t,
  pushToast,
  onClose,
  onCompleted,
}: AutoStopDialogProps) {
  const titleId = useId();
  const hoursInputId = useId();
  const minutesInputId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const [hoursDraft, setHoursDraft] = useState("");
  const [minutesDraft, setMinutesDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  // Initialize draft fields strictly once per dialog open so SSE snapshots never overwrite edits.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!request) {
      activeRequestIdRef.current = 0;
      if (dialog?.open) {
        dialog.close();
      }
      return;
    }

    activeRequestIdRef.current = request.id;
    const parts = splitDurationHoursMinutes(request.defaultSeconds);
    setHoursDraft(String(parts.hours));
    setMinutesDraft(String(parts.minutes));
    setSubmitting(false);
    setValidationError(null);
    setSubmitError(null);

    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [request?.id]);

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (submitting) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    onClose();
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    if (request && !submitting) {
      onClose();
    }
  };

  const accountChanged =
    request !== null &&
    currentAccountContext !== null &&
    (currentAccountContext.revision !== request.accountContext.revision ||
      currentAccountContext.active !== request.accountContext.active);

  const label = request ? formatRuntimeCardLabel(request.runtime) : "";
  const isCancel = request?.mode === "cancel";
  const isExtend = request?.mode === "extend";

  const handleDurationSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!request || submitting || request.mode === "cancel") {
      return;
    }
    const seconds = composeDurationSeconds(hoursDraft, minutesDraft);
    if (seconds === null) {
      setValidationError(t("web.sessions.auto_stop_duration_required"));
      return;
    }

    const requestId = request.id;
    setSubmitting(true);
    setValidationError(null);
    setSubmitError(null);
    try {
      const result = await changeAutoStop(request.accountContext, request.runtime.id, {
        kind: request.mode,
        seconds,
      });
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      const durationText = formatDuration(result.app_limit_seconds ?? seconds, t);
      const toastTitle = t(isExtend ? "app.b2.extend_done" : "app.b3.auto_stop_set", {
        time: durationText,
      });
      const armed = Boolean(result.watchdog_armed);
      const warningBody = result.warning_key
        ? t(result.warning_key)
        : t("app.b2.prov_watchdog_failed");
      pushToast({
        tone: armed ? "success" : "warning",
        title: toastTitle,
        body: armed ? t("app.b2.prov_watchdog") : warningBody,
      });
      setSubmitting(false);
      onCompleted();
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        setSubmitting(false);
        onClose();
        return;
      }
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      setSubmitting(false);
      setSubmitError(formatErrorMessage(error, t));
    }
  };

  const handleCancelConfirm = async () => {
    if (!request || submitting || request.mode !== "cancel") {
      return;
    }
    const requestId = request.id;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await changeAutoStop(request.accountContext, request.runtime.id, { kind: "cancel" });
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      pushToast({
        tone: "warning",
        body: t("app.b2.auto_stop_cancelled"),
      });
      setSubmitting(false);
      onCompleted();
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        setSubmitting(false);
        onClose();
        return;
      }
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      setSubmitting(false);
      setSubmitError(formatErrorMessage(error, t));
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
      data-dialog-kind={request ? (isCancel ? "cancel_auto_stop" : "auto_stop") : undefined}
      data-dialog-phase={request ? (submitting ? "submitting" : request.mode) : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      {request && isCancel && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("app.b3.cancel_auto_stop_title")}
          </h1>

          <div className="dialog-body">
            <div className="inline-msg inline-msg-warning">
              <AlertTriangleIcon className="icon-xs icon-warning" />
              <span className="inline-msg-text">
                {t("app.b3.cancel_auto_stop_body", { name: label })}
              </span>
            </div>

            <p className="dialog-paragraph">{t("app.b3.cancel_auto_stop_rearm")}</p>

            {accountChanged && (
              <div className="inline-msg inline-msg-warning">
                <AlertTriangleIcon className="icon-xs icon-warning" />
                <span className="inline-msg-text">{t("web.sessions.account_changed")}</span>
              </div>
            )}

            {submitError && (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{submitError.message}</p>
                  {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                </div>
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={submitting}
              autoFocus
              onClick={onClose}
            >
              {t("app.b3.cancel_auto_stop_keep")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-cancel-auto-stop-confirm="true"
              disabled={submitting || accountChanged}
              onClick={() => {
                void handleCancelConfirm();
              }}
            >
              {submitting && <span className="spinner" aria-hidden="true" />}
              <span>{t("app.b2.runtime_cancel_auto_stop")}</span>
            </button>
          </div>
        </>
      )}

      {request && !isCancel && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t(
              isExtend
                ? "web.sessions.auto_stop_extend_title"
                : "web.sessions.auto_stop_set_title",
            )}
          </h1>

          <form
            className="dialog-form"
            noValidate
            onSubmit={(event) => void handleDurationSubmit(event)}
          >
            <div className="dialog-body">
              <p className="dialog-paragraph">
                {t(
                  isExtend
                    ? "web.sessions.auto_stop_extend_desc"
                    : "web.sessions.auto_stop_set_desc",
                  { name: label },
                )}
              </p>
              <p className="dialog-caption">{t("app.def.max_runtime_hint")}</p>

              {accountChanged && (
                <div className="inline-msg inline-msg-warning">
                  <AlertTriangleIcon className="icon-xs icon-warning" />
                  <span className="inline-msg-text">{t("web.sessions.account_changed")}</span>
                </div>
              )}

              {submitError && (
                <div className="alert alert-danger" role="alert">
                  <span className="alert-icon icon-danger">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{submitError.message}</p>
                    {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                  </div>
                </div>
              )}

              {validationError && (
                <div className="inline-msg inline-msg-danger" role="alert">
                  <SmallAlertIcon className="icon-xs icon-danger" />
                  <span className="inline-msg-text">{validationError}</span>
                </div>
              )}

              <div className="field-group">
                <span className="field-label">
                  {t(
                    isExtend
                      ? "web.sessions.auto_stop_extend_by"
                      : "web.sessions.auto_stop_after",
                  )}
                </span>
                <div className="duration-group">
                  <span className="unit-field">
                    <input
                      id={hoursInputId}
                      type="number"
                      min={0}
                      max={MAX_HOURS_INPUT}
                      step={1}
                      className="input input-sm input-num"
                      aria-label={t("app.b3.unit_hours")}
                      aria-invalid={validationError ? "true" : undefined}
                      data-auto-stop-hours="true"
                      value={hoursDraft}
                      disabled={submitting}
                      autoFocus
                      onChange={(event) => {
                        setHoursDraft(event.target.value);
                        if (validationError) {
                          setValidationError(null);
                        }
                      }}
                    />
                    <label htmlFor={hoursInputId} className="unit-suffix">
                      {t("app.b3.unit_hours")}
                    </label>
                  </span>
                  <span className="unit-field">
                    <input
                      id={minutesInputId}
                      type="number"
                      min={0}
                      max={MAX_MINUTES_INPUT}
                      step={1}
                      className="input input-sm input-num"
                      aria-label={t("app.b3.unit_minutes")}
                      aria-invalid={validationError ? "true" : undefined}
                      data-auto-stop-minutes="true"
                      value={minutesDraft}
                      disabled={submitting}
                      onChange={(event) => {
                        setMinutesDraft(event.target.value);
                        if (validationError) {
                          setValidationError(null);
                        }
                      }}
                    />
                    <label htmlFor={minutesInputId} className="unit-suffix">
                      {t("app.b3.unit_minutes")}
                    </label>
                  </span>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={submitting}
                onClick={onClose}
              >
                {t("app.action.cancel")}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                data-auto-stop-submit="true"
                disabled={submitting || accountChanged}
              >
                {submitting && <span className="spinner" aria-hidden="true" />}
                <span>{t("web.sessions.auto_stop_apply")}</span>
              </button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}
