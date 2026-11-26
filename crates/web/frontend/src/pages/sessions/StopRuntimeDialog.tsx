/**
 * Reusable native modal `<dialog>` for stopping a single Managed or Unmanaged
 * runtime on any saved account, stating that everything on the runtime is wiped
 * and billing ends.
 *
 * Mounted globally in `App.tsx` via `stopDialogsStore`. Callers mounted inside
 * a route (such as `PluginsPage`) that still render `<StopRuntimeDialog>` in
 * standalone mode automatically forward their request into `stopDialogsStore`
 * so navigating away mid-stop never unmounts the dialog or loses error/retry UI.
 */

import { useEffect, useId, useMemo, useRef, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import type { TranslateFn } from "../../lib/i18n.ts";
import { stopDialogsStore } from "../../lib/stopDialogs.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Runtime, RuntimeRef } from "../../lib/types.ts";
import { formatEmail, formatErrorMessage, formatRuntimeCardLabel } from "./format.ts";
import { AlertTriangleIcon, SquareIcon } from "./Icons.tsx";

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
  /** Controlled global mode props driven by `stopDialogsStore` in `App.tsx`. */
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
  onClose,
  onStopped,
  submitting: controlledSubmitting,
  submitError: controlledSubmitError,
  onConfirm: controlledOnConfirm,
}: StopRuntimeDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const forwardedIdRef = useRef<number | null>(null);
  const callbacksRef = useRef({ onClose, onStopped });
  callbacksRef.current = { onClose, onStopped };

  const isControlled = controlledOnConfirm !== undefined;
  const submitting = Boolean(controlledSubmitting);
  const submitError = useMemo(
    () =>
      isControlled && controlledSubmitError !== null && controlledSubmitError !== undefined
        ? formatErrorMessage(controlledSubmitError, t)
        : null,
    [isControlled, controlledSubmitError, t],
  );

  // Route-local callers delegate to the global dialog host in `App.tsx` so route switches
  // preserve the modal, error alert, and retry action across page unmounts.
  useEffect(() => {
    if (isControlled) {
      return;
    }
    if (!request) {
      forwardedIdRef.current = null;
      return;
    }
    if (forwardedIdRef.current === request.id) {
      return;
    }
    forwardedIdRef.current = request.id;
    stopDialogsStore.openStopRuntime(
      {
        target: request.target,
        label: request.label,
        email: request.email,
      },
      {
        onStopped: (stoppedTarget) => callbacksRef.current.onStopped?.(stoppedTarget),
        onClose: () => callbacksRef.current.onClose(),
      },
    );
  }, [isControlled, request]);

  useEffect(() => {
    if (!isControlled) {
      return;
    }
    const dialog = dialogRef.current;
    if (!request) {
      if (dialog?.open) {
        dialog.close();
      }
      return;
    }
    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [isControlled, request?.id]);

  if (!isControlled) {
    return null;
  }

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
                controlledOnConfirm();
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
