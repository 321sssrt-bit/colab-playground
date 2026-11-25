/**
 * Native modal `<dialog>` confirming removal of a non-built-in user plugin.
 */

import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { formatPluginApiError, removePlugin } from "./api.ts";

export interface RemovePluginTarget {
  readonly id: string;
  readonly name: string;
}

export interface RemovePluginDialogProps {
  readonly target: RemovePluginTarget | null;
  readonly t: TranslateFn;
  readonly onClose: () => void;
  readonly onRemoved: (target: RemovePluginTarget) => void;
}

export function RemovePluginDialog({
  target,
  t,
  onClose,
  onRemoved,
}: RemovePluginDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  const [removing, setRemoving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (target !== null) {
      setRemoving(false);
      setErrorMessage(null);
      if (!dialog.open) {
        dialog.showModal();
      }
      // Focus the safe Cancel button by default in destructive confirmation dialogs.
      cancelButtonRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [target]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (removing) {
      event.preventDefault();
    }
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setRemoving(false);
    setErrorMessage(null);
    if (targetRef.current !== null) {
      onClose();
    }
  };

  const requestClose = () => {
    if (removing) {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
    } else {
      handleDialogClose();
    }
  };

  const handleConfirm = async () => {
    if (!target || removing) {
      return;
    }
    const currentTarget = target;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRemoving(true);
    setErrorMessage(null);

    try {
      await removePlugin(currentTarget.id, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      setRemoving(false);
      onRemoved(currentTarget);
      const dialog = dialogRef.current;
      if (dialog?.open) {
        dialog.close();
      } else if (targetRef.current !== null) {
        onClose();
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof ApiError && error.isAbort)) {
        return;
      }
      setRemoving(false);
      setErrorMessage(formatPluginApiError(error, t));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <h1 className="dialog-title" id={titleId}>
        {target ? t("app.b2.plugin_remove_title", { name: target.name }) : ""}
      </h1>

      <div className="dialog-body">
        <p className="dialog-paragraph">{t("app.b2.plugin_remove_body")}</p>

        {errorMessage !== null && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-body">{errorMessage}</p>
            </div>
          </div>
        )}
      </div>

      <div className="modal-actions">
        <button
          ref={cancelButtonRef}
          type="button"
          className="btn"
          autoFocus
          disabled={removing}
          onClick={requestClose}
        >
          {t("app.action.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={removing || target === null}
          aria-busy={removing || undefined}
          onClick={() => void handleConfirm()}
        >
          {removing && <span className="spinner" aria-hidden="true" />}
          <span>{t("app.b2.action_remove")}</span>
        </button>
      </div>
    </dialog>
  );
}
