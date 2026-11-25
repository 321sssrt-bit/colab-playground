/**
 * Native `<dialog>` confirmation modal for removing a saved Google account.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { AccountId, Snapshot } from "../../lib/types.ts";
import { formatApiError, removeSavedAccount, type FormattedApiError } from "./model.ts";

export interface RemoveTarget {
  readonly id: AccountId;
  readonly emailLabel: string;
}

export interface RemoveAccountDialogProps {
  readonly target: RemoveTarget | null;
  readonly snapshot: Snapshot;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onRemovingChange?: (removing: boolean) => void;
  readonly onClose: () => void;
}

export function RemoveAccountDialog({
  target,
  snapshot,
  t,
  pushToast,
  onRemovingChange,
  onClose,
}: RemoveAccountDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<FormattedApiError | null>(null);

  const targetRef = useRef(target);
  targetRef.current = target;
  const removingRef = useRef(removing);
  removingRef.current = removing;
  const requestSeqRef = useRef(0);

  useEffect(() => {
    onRemovingChange?.(removing);
    return () => {
      onRemovingChange?.(false);
    };
  }, [onRemovingChange, removing]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (target !== null) {
      requestSeqRef.current += 1;
      setRemoving(false);
      setError(null);
      if (!dialog.open) {
        dialog.showModal();
      }
      cancelButtonRef.current?.focus();
    } else if (dialog.open) {
      dialog.returnValue = "";
      dialog.close();
    }
  }, [target]);

  const handleConfirm = useCallback(async () => {
    const current = targetRef.current;
    if (current === null || removingRef.current) {
      return;
    }
    const seq = requestSeqRef.current;
    setRemoving(true);
    setError(null);

    try {
      await removeSavedAccount(current.id, snapshot.account);
      if (seq !== requestSeqRef.current || targetRef.current === null) {
        return;
      }
      pushToast({ tone: "success", body: t("app.remove.done", { email: current.emailLabel }) });
      void webStore.refreshSnapshot().catch(() => {});
      onClose();
    } catch (err) {
      if (seq !== requestSeqRef.current || targetRef.current === null) {
        return;
      }
      setRemoving(false);
      setError(formatApiError(err, t));
    }
  }, [onClose, pushToast, snapshot.account, t]);

  const handleDialogCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      if (!removingRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const handleDialogClose = useCallback(() => {
    if (dialogRef.current) {
      dialogRef.current.returnValue = "";
    }
    if (targetRef.current !== null && !removingRef.current) {
      onClose();
    }
  }, [onClose]);

  const email = target?.emailLabel ?? "";

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <h1 id={titleId} className="dialog-title">
        {t("app.remove.title", { email })}
      </h1>

      <div className="dialog-body">
        <p className="dialog-paragraph">{t("app.remove.body")}</p>

        {error !== null && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{error.message}</p>
              {error.hint && <p className="alert-body">{error.hint}</p>}
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
          onClick={onClose}
        >
          {t("app.action.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={removing || snapshot.shutting_down}
          onClick={() => {
            void handleConfirm();
          }}
        >
          {removing && <span className="spinner" aria-hidden="true" />}
          <span>{t("app.remove.confirm")}</span>
        </button>
      </div>
    </dialog>
  );
}
