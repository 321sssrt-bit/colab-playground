/**
 * Reusable native modal `<dialog>` for stopping a single Managed or Unmanaged
 * runtime on any saved account, stating that everything on the runtime is wiped
 * and billing ends. Supports both global controlled mode (mounted in `App.tsx`
 * via `stopDialogsStore`) and standalone mode (used by plugin failure views),
 * with failure-toast fallback if closed or unmounted mid-request.
 */

import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import { appDataStore } from "../../lib/appCache.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Runtime, RuntimeRef } from "../../lib/types.ts";
import { stopRuntime } from "./api.ts";
import {
  formatEmail,
  formatErrorMessage,
  formatRuntimeCardLabel,
  type FormattedError,
} from "./format.ts";
import { AlertTriangleIcon, SquareIcon } from "./Icons.tsx";
import { beginUserStop, recordEndedRuntime } from "./store.ts";

export interface StopRuntimeTarget {
  readonly target: RuntimeRef;
  readonly label: string;
  readonly email: string | null;
}

export interface StopRuntimeDialogRequest extends StopRuntimeTarget {
  readonly id: number;
}

export interface StopRuntimeDialogProps {
  readonly request: StopRuntimeDialogRequest | null;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
  readonly onStopped?: (target: StopRuntimeTarget) => void;
  /** Controlled global mode props driven by `stopDialogsStore`. */
  readonly submitting?: boolean;
  readonly submitError?: unknown | null;
  readonly onConfirm?: () => void;
}

export function stopTargetFromRuntime(runtime: Runtime): StopRuntimeTarget {
  return {
    target: runtime.id,
    label: formatRuntimeCardLabel(runtime),
    email: runtime.account_email,
  };
}

export function StopRuntimeDialog({
  request,
  t,
  pushToast,
  onClose,
  onStopped,
  submitting: controlledSubmitting,
  submitError: controlledSubmitError,
  onConfirm: controlledOnConfirm,
}: StopRuntimeDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localSubmitError, setLocalSubmitError] = useState<FormattedError | null>(null);

  const isControlled = controlledOnConfirm !== undefined;
  const submitting = isControlled ? Boolean(controlledSubmitting) : localSubmitting;
  const submitError = useMemo(
    () =>
      isControlled
        ? controlledSubmitError !== null && controlledSubmitError !== undefined
          ? formatErrorMessage(controlledSubmitError, t)
          : null
        : localSubmitError,
    [isControlled, controlledSubmitError, localSubmitError, t],
  );

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
    if (!isControlled) {
      setLocalSubmitting(false);
      setLocalSubmitError(null);
    }

    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [request?.id, isControlled]);

  useEffect(() => {
    return () => {
      activeRequestIdRef.current = 0;
    };
  }, []);

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
    if (request && !submitting) {
      onClose();
    }
  };

  const handleConfirm = async () => {
    if (!request || submitting) {
      return;
    }
    if (controlledOnConfirm) {
      controlledOnConfirm();
      return;
    }

    const requestId = request.id;
    const sessionGeneration = apiClient.getSessionGeneration();
    const stopTarget: StopRuntimeTarget = {
      target: request.target,
      label: request.label,
      email: request.email,
    };
    const releasePending = beginUserStop(stopTarget.target);
    setLocalSubmitting(true);
    setLocalSubmitError(null);

    try {
      await stopRuntime(stopTarget.target);
      if (apiClient.getSessionGeneration() !== sessionGeneration) {
        return;
      }
      recordEndedRuntime({
        runtime: stopTarget.target,
        label: stopTarget.label,
        email: stopTarget.email,
        reason: { kind: "user" },
      });
      pushToast({
        tone: "success",
        body: t("app.b2.stop_done", { name: stopTarget.label }),
      });
      void webStore.refreshSnapshot().catch(() => {});
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      setLocalSubmitting(false);
      onStopped?.(stopTarget);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        if (activeRequestIdRef.current === requestId) {
          setLocalSubmitting(false);
          onClose();
        }
        return;
      }
      if (apiClient.getSessionGeneration() !== sessionGeneration) {
        return;
      }
      if (error instanceof ApiError && error.kind === "session_gone") {
        // `stop_runtime` returns `session_gone` before updating the backend snapshot, so re-list
        // runtimes to clear the stale card and let snapshot transitions record it honestly.
        void appDataStore.refreshSessions().catch(() => {});
      }
      const formatted = formatErrorMessage(error, t);
      if (activeRequestIdRef.current !== requestId) {
        // Dialog unmounted or closed mid-request: fall back to a global danger toast.
        pushToast({
          tone: "danger",
          title: formatted.hint ? formatted.message : undefined,
          body: formatted.hint ?? formatted.message,
        });
        return;
      }
      setLocalSubmitting(false);
      setLocalSubmitError(formatted);
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
      data-dialog-kind={request ? "stop_runtime" : undefined}
      data-dialog-phase={request ? (submitting ? "submitting" : "confirm") : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      {request && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("app.b2.stop_title")}
          </h1>

          <div className="dialog-body">
            <p className="dialog-paragraph">
              {t("app.b2.stop_body", {
                name: request.label,
                email: formatEmail(request.email, t),
              })}
            </p>

            <div className="inline-msg inline-msg-warning">
              <AlertTriangleIcon className="icon-xs icon-warning" />
              <span className="inline-msg-text">{t("app.b2.stop_wiped")}</span>
            </div>

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
              {t("app.action.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              data-stop-runtime-confirm="true"
              disabled={submitting}
              onClick={() => {
                void handleConfirm();
              }}
            >
              {submitting ? <span className="spinner" aria-hidden="true" /> : <SquareIcon />}
              <span>{t("app.b2.stop_action")}</span>
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
