/**
 * Native `<dialog>` modal for adding a Google account via OAuth2.
 *
 * Renders an explicit `<a target="_blank" rel="noopener noreferrer">` sign-in link
 * (never calling `window.open`), supports authorization code submission, explicit
 * cancellation, concurrent-login cancellation, and live SSE timeout/cancel sync.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon, InfoIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Snapshot } from "../../lib/types.ts";
import { CopyIcon, ExternalLinkIcon } from "./Icons.tsx";
import {
  beginAccountLogin,
  cancelAccountLogin,
  copyTextToClipboard,
  formatApiError,
  isValidExternalHttpUrl,
  submitAccountLoginCode,
  type FormattedApiError,
} from "./model.ts";

type AddPhase =
  | { readonly kind: "intro" }
  | { readonly kind: "other_active"; readonly loginId: number }
  | { readonly kind: "starting" }
  | { readonly kind: "code"; readonly loginId: number; readonly authUrl: string }
  | { readonly kind: "submitting"; readonly loginId: number; readonly authUrl: string }
  | { readonly kind: "cancelling"; readonly reopenIntroAfter: boolean }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly error: FormattedApiError; readonly rolledBack: boolean };

export interface AddAccountDialogProps {
  readonly open: boolean;
  readonly snapshot: Snapshot;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
}

export function AddAccountDialog({
  open,
  snapshot,
  t,
  pushToast,
  onClose,
}: AddAccountDialogProps) {
  const titleId = useId();
  const codeInputId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  const [phase, setPhase] = useState<AddPhase>({ kind: "intro" });
  const [code, setCode] = useState("");
  const [postBeginVersion, setPostBeginVersion] = useState<number | null>(null);

  const phaseRef = useRef<AddPhase>(phase);
  phaseRef.current = phase;
  const openRef = useRef(open);
  openRef.current = open;
  const serverLoginIdRef = useRef<number | null>(snapshot.login_id);
  serverLoginIdRef.current = snapshot.login_id;
  const postBeginVersionRef = useRef<number | null>(postBeginVersion);
  postBeginVersionRef.current = postBeginVersion;
  const cancelStartRequestedRef = useRef(false);
  const requestControllerRef = useRef<AbortController | null>(null);
  const syncControllerRef = useRef<AbortController | null>(null);
  const loginSessionSeqRef = useRef(0);

  const abortActiveRequest = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    syncControllerRef.current?.abort();
    syncControllerRef.current = null;
  }, []);

  // Pull a post-begin snapshot directly so missed SSE frames during disconnects still detect timeout.
  const syncPromptSnapshot = useCallback(async (loginId: number, seq: number) => {
    syncControllerRef.current?.abort();
    const controller = new AbortController();
    syncControllerRef.current = controller;
    try {
      const latest = await webStore.refreshSnapshot(controller.signal);
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = null;
      }
      if (seq !== loginSessionSeqRef.current || !openRef.current) {
        return;
      }
      const current = phaseRef.current;
      if (current.kind !== "code" || current.loginId !== loginId) {
        return;
      }
      setPostBeginVersion(latest.version);
      const loginOpRunning = latest.operations.some(
        (pending) =>
          pending.operation.kind === "login" &&
          (pending.operation.login_id === undefined || pending.operation.login_id === loginId),
      );
      if (latest.login_id !== loginId && !loginOpRunning) {
        setCode("");
        setPhase({ kind: "expired" });
      }
    } catch {
      if (syncControllerRef.current === controller) {
        syncControllerRef.current = null;
      }
    }
  }, []);

  // Synchronize native top-layer modal visibility with `open` prop.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      loginSessionSeqRef.current += 1;
      cancelStartRequestedRef.current = false;
      setCode("");
      setPostBeginVersion(null);
      const activeServerLoginId = serverLoginIdRef.current;
      if (activeServerLoginId !== null) {
        setPhase({ kind: "other_active", loginId: activeServerLoginId });
      } else {
        setPhase({ kind: "intro" });
      }
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      abortActiveRequest();
      if (dialog.open) {
        dialog.returnValue = "";
        dialog.close();
      }
    }
  }, [abortActiveRequest, open]);

  useEffect(() => {
    return () => {
      abortActiveRequest();
    };
  }, [abortActiveRequest]);

  // Retry post-begin snapshot sync once SSE reconnects if the initial pull failed while offline.
  useEffect(() => {
    if (!open || phase.kind !== "code" || postBeginVersion !== null) {
      return;
    }
    const { loginId } = phase;
    const seq = loginSessionSeqRef.current;
    let prevStatus = webStore.getState().connectionStatus;
    return webStore.subscribe(() => {
      const nextStatus = webStore.getState().connectionStatus;
      if (
        prevStatus !== "connected" &&
        nextStatus === "connected" &&
        postBeginVersionRef.current === null
      ) {
        void syncPromptSnapshot(loginId, seq);
      }
      prevStatus = nextStatus;
    });
  }, [open, phase, postBeginVersion, syncPromptSnapshot]);

  // Keep modal state synchronized with server-side login timeout or external cancellation via SSE.
  useEffect(() => {
    if (!open) {
      return;
    }

    if (phase.kind === "other_active") {
      if (snapshot.login_id === null) {
        setPhase({ kind: "intro" });
      } else if (snapshot.login_id !== phase.loginId) {
        setPhase({ kind: "other_active", loginId: snapshot.login_id });
      }
      return;
    }

    if (phase.kind === "code") {
      const serverLoginId = snapshot.login_id;
      if (serverLoginId === phase.loginId) {
        if (postBeginVersion === null) {
          setPostBeginVersion(snapshot.version);
        }
        return;
      }
      const loginOpRunning = snapshot.operations.some(
        (pending) =>
          pending.operation.kind === "login" &&
          (pending.operation.login_id === undefined || pending.operation.login_id === phase.loginId),
      );
      if (
        (serverLoginId !== null && serverLoginId !== phase.loginId) ||
        (postBeginVersion !== null &&
          snapshot.version >= postBeginVersion &&
          serverLoginId === null &&
          !loginOpRunning)
      ) {
        setCode("");
        setPhase({ kind: "expired" });
      }
    }
  }, [open, phase, postBeginVersion, snapshot.login_id, snapshot.operations, snapshot.version]);

  const performCancelLogin = useCallback(
    async (loginId: number, reopenIntroAfter: boolean) => {
      const seq = loginSessionSeqRef.current;
      setPhase({ kind: "cancelling", reopenIntroAfter });
      try {
        await cancelAccountLogin(loginId);
      } catch (error) {
        if (seq !== loginSessionSeqRef.current || !openRef.current) {
          return;
        }
        // Treat an already-expired or already-cancelled login as cleanly rolled back.
        if (!(error instanceof ApiError && error.kind === "login_cancelled")) {
          setPhase({
            kind: "failed",
            error: formatApiError(error, t),
            rolledBack: false,
          });
          return;
        }
      }

      if (seq !== loginSessionSeqRef.current || !openRef.current) {
        return;
      }

      void webStore.refreshSnapshot().catch(() => {});
      pushToast({ tone: "info", body: t("web.add.cancelled_notice") });
      if (reopenIntroAfter) {
        setCode("");
        setPostBeginVersion(null);
        setPhase({ kind: "intro" });
      } else {
        onClose();
      }
    },
    [onClose, pushToast, t],
  );

  const handleStartLogin = useCallback(async () => {
    const seq = ++loginSessionSeqRef.current;
    cancelStartRequestedRef.current = false;
    setCode("");
    setPostBeginVersion(null);
    setPhase({ kind: "starting" });

    const controller = new AbortController();
    requestControllerRef.current = controller;

    try {
      const prompt = await beginAccountLogin(snapshot.account, controller.signal);
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }

      // If the user cancelled while begin_login was in flight, roll back the newly created prompt.
      if (cancelStartRequestedRef.current || !openRef.current || seq !== loginSessionSeqRef.current) {
        await performCancelLogin(prompt.id, false);
        return;
      }

      setPhase({ kind: "code", loginId: prompt.id, authUrl: prompt.auth_url });
      void syncPromptSnapshot(prompt.id, seq);
      window.requestAnimationFrame(() => {
        codeInputRef.current?.focus();
      });
    } catch (error) {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      if (seq !== loginSessionSeqRef.current || !openRef.current) {
        return;
      }
      if (cancelStartRequestedRef.current) {
        void webStore.refreshSnapshot().catch(() => {});
        onClose();
        return;
      }
      if (error instanceof ApiError && error.isAbort) {
        return;
      }
      const activeServerLoginId = serverLoginIdRef.current;
      if (
        error instanceof ApiError &&
        (error.kind === "add_in_progress" || error.kind === "busy") &&
        activeServerLoginId !== null
      ) {
        setPhase({ kind: "other_active", loginId: activeServerLoginId });
        return;
      }
      setPhase({
        kind: "failed",
        error: formatApiError(error, t),
        rolledBack: true,
      });
    }
  }, [onClose, performCancelLogin, snapshot.account, syncPromptSnapshot, t]);

  const handleCancelOrClose = useCallback(() => {
    const current = phaseRef.current;
    if (current.kind === "cancelling") {
      return;
    }
    if (current.kind === "starting") {
      cancelStartRequestedRef.current = true;
      setPhase({ kind: "cancelling", reopenIntroAfter: false });
      return;
    }
    if (current.kind === "code" || current.kind === "submitting") {
      void performCancelLogin(current.loginId, false);
      return;
    }
    onClose();
  }, [onClose, performCancelLogin]);

  const handleSubmitCode = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const current = phaseRef.current;
      if (current.kind !== "code") {
        return;
      }
      const trimmed = code.trim();
      if (trimmed.length === 0) {
        codeInputRef.current?.focus();
        return;
      }

      const seq = loginSessionSeqRef.current;
      const { loginId, authUrl } = current;
      setCode("");
      setPhase({ kind: "submitting", loginId, authUrl });

      try {
        const account = await submitAccountLoginCode(loginId, trimmed);
        if (seq !== loginSessionSeqRef.current || !openRef.current) {
          return;
        }
        // Invalidate any racing cancel call because the backend already committed this sign-in.
        loginSessionSeqRef.current += 1;
        const emailLabel = account.email ?? t("app.accounts.no_email");
        pushToast({ tone: "success", body: t("app.add.done", { email: emailLabel }) });
        void webStore.refreshSnapshot().catch(() => {});
        onClose();
      } catch (error) {
        if (seq !== loginSessionSeqRef.current || !openRef.current) {
          return;
        }
        if (phaseRef.current.kind === "cancelling") {
          return;
        }
        void webStore.refreshSnapshot().catch(() => {});
        if (error instanceof ApiError && error.kind === "login_cancelled") {
          setPhase({ kind: "expired" });
          return;
        }
        setPhase({
          kind: "failed",
          error: formatApiError(error, t),
          rolledBack: true,
        });
      }
    },
    [code, onClose, pushToast, t],
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
      // Always route Esc / back-gesture dismissal through the state machine so pending
      // server-side OAuth flows are explicitly cancelled instead of orphaned.
      event.preventDefault();
      handleCancelOrClose();
    },
    [handleCancelOrClose],
  );

  const handleDialogClose = useCallback(() => {
    if (dialogRef.current) {
      dialogRef.current.returnValue = "";
    }
    if (openRef.current) {
      onClose();
    }
  }, [onClose]);

  const submitting = phase.kind === "submitting";
  const hasCodePrompt = phase.kind === "code" || phase.kind === "submitting";
  const safeAuthUrl =
    hasCodePrompt && isValidExternalHttpUrl(phase.authUrl) ? phase.authUrl : null;

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

            <form
              id={`${codeInputId}-form`}
              className="oauth-code-form"
              onSubmit={(event) => {
                void handleSubmitCode(event);
              }}
            >
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
                  <span>{t("app.add.submitting")}</span>
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
            <button type="button" className="btn" onClick={handleCancelOrClose}>
              {t("app.action.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              disabled={snapshot.shutting_down}
              onClick={() => {
                void handleStartLogin();
              }}
            >
              <ExternalLinkIcon />
              <span>{t("app.add.continue")}</span>
            </button>
          </>
        )}

        {phase.kind === "other_active" && (
          <>
            <button type="button" className="btn" autoFocus onClick={handleCancelOrClose}>
              {t("app.action.close")}
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={snapshot.shutting_down}
              onClick={() => {
                void performCancelLogin(phase.loginId, true);
              }}
            >
              {t("web.add.cancel_existing")}
            </button>
          </>
        )}

        {phase.kind === "starting" && (
          <button type="button" className="btn" onClick={handleCancelOrClose}>
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
            <button type="button" className="btn" onClick={handleCancelOrClose}>
              {t("app.action.cancel")}
            </button>
            <button
              type="submit"
              form={`${codeInputId}-form`}
              className="btn btn-primary"
              disabled={submitting || code.trim().length === 0 || snapshot.shutting_down}
            >
              {submitting && <span className="spinner" aria-hidden="true" />}
              <span>{t("app.add.submit")}</span>
            </button>
          </>
        )}

        {(phase.kind === "expired" || phase.kind === "failed") && (
          <>
            <button type="button" className="btn" onClick={handleCancelOrClose}>
              {t("app.action.close")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              autoFocus
              disabled={snapshot.shutting_down}
              onClick={() => {
                void handleStartLogin();
              }}
            >
              {t("app.add.start_again")}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
