/**
 * Reusable native modal `<dialog>` for stopping a single Managed or Unmanaged
 * runtime on any saved account, stating that everything on the runtime is wiped
 * and billing ends. Shared by Sessions and plugin failure cleanup views.
 */

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
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
}: StopRuntimeDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);

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
    setSubmitting(false);
    setSubmitError(null);

    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [request?.id]);

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

    const requestId = request.id;
    const stopTarget: StopRuntimeTarget = {
      target: request.target,
      label: request.label,
      email: request.email,
    };
    const releasePending = beginUserStop(stopTarget.target);
    setSubmitting(true);
    setSubmitError(null);

    try {
      await stopRuntime(stopTarget.target);
      recordEndedRuntime({
        runtime: stopTarget.target,
        label: stopTarget.label,
        email: stopTarget.email,
        reason: { kind: "user" },
      });
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      pushToast({
        tone: "success",
        body: t("app.b2.stop_done", { name: stopTarget.label }),
      });
      setSubmitting(false);
      void webStore.refreshSnapshot().catch(() => {});
      onStopped?.(stopTarget);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        setSubmitting(false);
        onClose();
        return;
      }
      if (error instanceof ApiError && error.kind === "session_gone") {
        void webStore.refreshSnapshot().catch(() => {});
      }
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      setSubmitting(false);
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
