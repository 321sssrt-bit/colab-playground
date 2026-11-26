/**
 * Global native `<dialog>` modal for adding a Google account via OAuth2.
 *
 * State transitions, cancellation/rollback settlement, and multi-tab conflict
 * monitoring live in `lib/accountDialogs.ts` so navigating between routes never
 * drops an in-flight OAuth flow or completion notice.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon, InfoIcon } from "../../components/Icons.tsx";
import type { AddAccountDialogState } from "../../lib/accountDialogs.ts";
import { isAccountChangeBlocked, useAppDataStore } from "../../lib/appCache.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Snapshot } from "../../lib/types.ts";
import { CopyIcon, ExternalLinkIcon } from "./Icons.tsx";
import {
  copyTextToClipboard,
  isServerLoginCancelling,
  isValidExternalHttpUrl,
} from "./model.ts";

export interface AddAccountDialogProps {
  readonly state: AddAccountDialogState;
  readonly snapshot: Snapshot | null;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onStartLogin: () => void;
  readonly onSubmitCode: (code: string) => void;
  readonly onCancelExisting: () => void;
  readonly onCancelOrClose: () => void;
}

export function AddAccountDialog({
  state,
  snapshot,
  t,
  pushToast,
  onStartLogin,
  onSubmitCode,
  onCancelExisting,
  onCancelOrClose,
}: AddAccountDialogProps) {
  const titleId = useId();
  const codeInputId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  const [code, setCode] = useState("");
  const appData = useAppDataStore();

  const { open, openSeq, phase } = state;
  const openRef = useRef(open);
  openRef.current = open;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const isLocked = phase.kind === "submitting" || phase.kind === "cancelling";
  const isLockedRef = useRef(isLocked);
  isLockedRef.current = isLocked;

  // Synchronize native top-layer modal visibility with global dialog state.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      setCode("");
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.returnValue = "";
      dialog.close();
    }
  }, [open, openSeq]);

  // Clear code input whenever leaving code entry and focus it upon entering code entry.
  useEffect(() => {
    if (!open) {
      return;
    }
    if (phase.kind === "code") {
      window.requestAnimationFrame(() => {
        codeInputRef.current?.focus();
      });
    } else {
      setCode("");
    }
  }, [open, phase.kind]);

  const handleSubmitCode = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (phaseRef.current.kind !== "code") {
        return;
      }
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        codeInputRef.current?.focus();
        return;
      }
      setCode("");
      onSubmitCode(trimmed);
    },
    [code, onSubmitCode],
  );

  const handleCopyAuthUrl = useCallback(
    async (url: string) => {
      const copied = await copyTextToClipboard(url);
      pushToast(
        copied
          ? { tone: "success", body: t("web.shell.copied") }
          : { tone: "warning", body: t("web.shell.copy_link_failed") },
      );
    },
    [pushToast, t],
  );

  const handleDialogCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      // Route Esc / back-gesture dismissal through the global state machine so submitting
      // and cancelling phases stay locked and pending OAuth flows are explicitly cancelled.
      event.preventDefault();
      if (isLockedRef.current) {
        return;
      }
      onCancelOrClose();
    },
    [onCancelOrClose],
  );

  const handleDialogClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    if (!openRef.current) {
      return;
    }
    if (isLockedRef.current) {
      if (dialog && !dialog.open) {
        dialog.showModal();
      }
      return;
    }
    onCancelOrClose();
  }, [onCancelOrClose]);

  const shuttingDown = snapshot?.shutting_down === true;
  const accountChangeBlocked = isAccountChangeBlocked(snapshot, appData);
  const submitting = phase.kind === "submitting";
  const hasCodePrompt = phase.kind === "code" || phase.kind === "submitting";
  const safeAuthUrl =
    hasCodePrompt && isValidExternalHttpUrl(phase.authUrl) ? phase.authUrl : null;
  const submittingCancelling =
    phase.kind === "submitting" && isServerLoginCancelling(snapshot, phase.loginId);

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <h1 id={titleId} className="dialog-title">
        {t("app.add.title")}
      </h1>

      <div className="dialog-body">
        {phase.kind === "intro" && (
          <>
            <p className="dialog-paragraph">{t("app.add.intro")}</p>
            <div className="inline-msg inline-msg-info">
              <InfoIcon />
              <span className="inline-msg-text">{t("app.add.impact")}</span>
            </div>
          </>
        )}

        {phase.kind === "other_active" && (
          <div className="alert alert-warning" role="alert">
            <span className="alert-icon icon-warning">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-body">{t("web.add.in_progress_other")}</p>
            </div>
          </div>
        )}

        {phase.kind === "starting" && (
          <div className="busy-line" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{t("app.add.starting")}</span>
          </div>
        )}

        {phase.kind === "cancelling" && (
          <div className="busy-line" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{t("web.add.cancelling")}</span>
          </div>
        )}

        {hasCodePrompt && (
          <>
            <p className="dialog-paragraph">{t("web.add.open_hint")}</p>

            <div className="oauth-link-box">
              <div className="oauth-open-row">
                {safeAuthUrl !== null && (
                  <a
                    className="btn btn-primary"
                    href={safeAuthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLinkIcon />
                    <span>{t("web.add.open_link")}</span>
                  </a>
                )}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void handleCopyAuthUrl(phase.authUrl);
                  }}
                >
                  <CopyIcon />
                  <span>{t("copy.button")}</span>
                </button>
              </div>
              <div className="oauth-url-row">
                <span className="oauth-url mono" title={phase.authUrl}>
                  {phase.authUrl}
                </span>
              </div>
            </div>

            <form id={`${codeInputId}-form`} className="oauth-code-form" onSubmit={handleSubmitCode}>
              <div className="field-group">
                <label className="field-label" htmlFor={codeInputId}>
                  {t("app.add.code_label")}
                </label>
                <input
                  ref={codeInputRef}
                  id={codeInputId}
                  type="text"
                  className="input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("app.add.code_placeholder")}
                  value={code}
                  disabled={submitting}
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>

              {submitting && (
                <div className="busy-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    {submittingCancelling ? t("web.add.cancelling") : t("app.add.submitting")}
                  </span>
                </div>
              )}
            </form>
          </>
        )}

        {phase.kind === "expired" && (
          <>
            <div className="alert alert-warning" role="alert">
              <span className="alert-icon icon-warning">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{t("web.add.expired_or_cancelled")}</p>
              </div>
            </div>
            <p className="dialog-caption">{t("app.add.rolled_back")}</p>
          </>
        )}

        {phase.kind === "failed" && (
          <>
            <div className="alert alert-danger" role="alert">
              <span className="alert-icon icon-danger">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-title">{phase.error.message}</p>
                {phase.error.hint && <p className="alert-body">{phase.error.hint}</p>}
              </div>
            </div>
            {phase.rolledBack && <p className="dialog-caption">{t("app.add.rolled_back")}</p>}
          </>
        )}
      </div>

      <div className="modal-actions">
        {phase.kind === "intro" && (
          <>
            <button type="button" className="btn" onClick={onCancelOrClose}>
              {t("app.action.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              disabled={snapshot === null || shuttingDown || accountChangeBlocked}
              title={accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined}
              onClick={onStartLogin}
            >
              <ExternalLinkIcon />
              <span>{t("app.add.continue")}</span>
            </button>
          </>
        )}

        {phase.kind === "other_active" && (
          <>
            <button type="button" className="btn" autoFocus onClick={onCancelOrClose}>
              {t("app.action.close")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={shuttingDown}
              onClick={onCancelExisting}
            >
              {t("web.add.cancel_existing")}
            </button>
          </>
        )}

        {phase.kind === "starting" && (
          <button type="button" className="btn" onClick={onCancelOrClose}>
            {t("app.action.cancel")}
          </button>
        )}

        {phase.kind === "cancelling" && (
          <button type="button" className="btn" disabled>
            {t("app.action.cancel")}
          </button>
        )}

        {hasCodePrompt && (
          <>
            <button
              type="button"
              className="btn"
              disabled={submitting}
              onClick={onCancelOrClose}
            >
              {t("app.action.cancel")}
            </button>
            <button
              type="submit"
              form={`${codeInputId}-form`}
              className="btn btn-primary"
              disabled={submitting || code.trim().length === 0 || shuttingDown}
            >
              {submitting && <span className="spinner" aria-hidden="true" />}
              <span>{t("app.add.submit")}</span>
            </button>
          </>
        )}

        {(phase.kind === "expired" || phase.kind === "failed") && (
          <>
            <button type="button" className="btn" onClick={onCancelOrClose}>
              {t("app.action.close")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              disabled={snapshot === null || shuttingDown || accountChangeBlocked}
              title={accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined}
              onClick={onStartLogin}
            >
              {t("app.add.start_again")}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
