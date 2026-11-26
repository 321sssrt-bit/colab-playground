/**
 * Global native `<dialog>` confirmation modal for removing a saved Google account.
 *
 * State and request execution live in `lib/accountDialogs.ts` so navigating away
 * mid-removal never drops the result or completion toast.
 */

import { useCallback, useEffect, useId, useRef } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import type { RemoveAccountDialogState } from "../../lib/accountDialogs.ts";
import { isAccountChangeBlocked, useAppDataStore } from "../../lib/appCache.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Snapshot } from "../../lib/types.ts";
import { getAccountRemoveBlock, type RemoveTarget } from "./model.ts";

export type { RemoveTarget };

export interface RemoveAccountDialogProps {
  readonly state: RemoveAccountDialogState;
  readonly snapshot: Snapshot | null;
  readonly t: TranslateFn;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function RemoveAccountDialog({
  state,
  snapshot,
  t,
  onClose,
  onConfirm,
}: RemoveAccountDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const appData = useAppDataStore();

  const { target, openSeq, removing, error } = state;
  const targetRef = useRef(target);
  targetRef.current = target;
  const removingRef = useRef(removing);
  removingRef.current = removing;

  const removeBlock =
    target !== null && snapshot !== null ? getAccountRemoveBlock(target.id, snapshot) : null;
  const accountChangeBlocked = isAccountChangeBlocked(snapshot, appData);
  const removeBlockReason =
    removeBlock === "active"
      ? t("app.accounts.remove_active")
      : removeBlock === "running"
        ? t("app.accounts.remove_running")
        : accountChangeBlocked
          ? t("app.b2.account_change_blocked")
          : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (target !== null) {
      if (!dialog.open) {
        dialog.showModal();
      }
      cancelButtonRef.current?.focus();
    } else if (dialog.open) {
      dialog.returnValue = "";
      dialog.close();
    }
  }, [target, openSeq]);

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
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    if (targetRef.current === null) {
      return;
    }
    if (removingRef.current) {
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
      return;
    }
    onClose();
  }, [onClose]);

  const email = target?.emailLabel ?? "";
  const shuttingDown = snapshot?.shutting_down === true;

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

        {!removing && removeBlockReason !== null && (
          <div className="alert alert-warning" role="alert">
            <span className="alert-icon icon-warning">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-body">{removeBlockReason}</p>
            </div>
          </div>
        )}

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
          disabled={
            removing || snapshot === null || removeBlockReason !== null || shuttingDown
          }
          title={removeBlockReason ?? undefined}
          onClick={onConfirm}
        >
          {removing && <span className="spinner" aria-hidden="true" />}
          <span>{t("app.remove.confirm")}</span>
        </button>
      </div>
    </dialog>
  );
}
