/**
 * Reusable native modal `<dialog>` for inspecting, saving/replacing, and deleting
 * the Hugging Face token stored in the server keyring via `/api/plugins/hf/token`.
 *
 * Security invariant: the plaintext token stays inside an uncontrolled `type="password"`
 * DOM input, is cleared immediately on submit/close/unmount, and is never stored in
 * React state, shared stores, snapshots, or echoed back into the UI.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type SyntheticEvent,
} from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import {
  deleteHfToken,
  formatPluginApiError,
  getHfTokenStatus,
  saveHfToken,
} from "./api.ts";

export interface HfTokenDialogProps {
  readonly open: boolean;
  readonly t: TranslateFn;
  readonly disabled?: boolean;
  readonly onClose: () => void;
  readonly onStatusChange?: (saved: boolean) => void;
}

type TokenLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly saved: boolean }
  | { readonly kind: "error"; readonly message: string };

type TokenMutation = "idle" | "saving" | "deleting";

type TokenFeedback = "none" | "saved" | "deleted";

export function HfTokenDialog({
  open,
  t,
  disabled = false,
  onClose,
  onStatusChange,
}: HfTokenDialogProps) {
  const titleId = useId();
  const tokenInputId = useId();
  const hintId = useId();
  const errorId = useId();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const mutateAbortRef = useRef<AbortController | null>(null);
  const statusSeqRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;
  const mountedRef = useRef(true);
  const tRef = useRef(t);
  tRef.current = t;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const [loadState, setLoadState] = useState<TokenLoadState>({ kind: "loading" });
  const [mutation, setMutation] = useState<TokenMutation>("idle");
  const [feedback, setFeedback] = useState<TokenFeedback>("none");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  const clearTokenInput = useCallback(() => {
    if (tokenInputRef.current) {
      tokenInputRef.current.value = "";
    }
  }, []);

  const fetchTokenStatus = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const seq = ++statusSeqRef.current;

    setLoadState({ kind: "loading" });

    try {
      const result = await getHfTokenStatus(controller.signal);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current
      ) {
        return;
      }
      setLoadState({ kind: "ready", saved: result.saved });
      onStatusChangeRef.current?.(result.saved);
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setLoadState({ kind: "error", message: formatPluginApiError(error, tRef.current) });
    } finally {
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      mutateAbortRef.current?.abort();
      mutateAbortRef.current = null;
      statusSeqRef.current += 1;
      clearTokenInput();
      setMutation("idle");
      setFeedback("none");
      setErrorMessage(null);
      setTokenInvalid(false);
      if (!dialog.open) {
        dialog.showModal();
      }
      tokenInputRef.current?.focus();
      void fetchTokenStatus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, clearTokenInput, fetchTokenStatus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      statusSeqRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      mutateAbortRef.current?.abort();
      mutateAbortRef.current = null;
      clearTokenInput();
    };
  }, [clearTokenInput]);

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (mutation !== "idle") {
      event.preventDefault();
    }
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    statusSeqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    mutateAbortRef.current?.abort();
    mutateAbortRef.current = null;
    clearTokenInput();
    setMutation("idle");
    setFeedback("none");
    setErrorMessage(null);
    setTokenInvalid(false);
    if (openRef.current) {
      onClose();
    }
  };

  const requestClose = () => {
    if (mutation !== "idle") {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
    } else {
      handleDialogClose();
    }
  };

  const handleSaveSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || mutation !== "idle") {
      return;
    }

    const trimmed = (tokenInputRef.current?.value ?? "").trim();
    if (!trimmed) {
      setTokenInvalid(true);
      setFeedback("none");
      setErrorMessage(t("web.plugins.token_required"));
      tokenInputRef.current?.focus();
      return;
    }

    // Clear the masked input before awaiting the request so the plaintext never lingers in DOM.
    clearTokenInput();
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    mutateAbortRef.current?.abort();
    const controller = new AbortController();
    mutateAbortRef.current = controller;
    const seq = ++statusSeqRef.current;

    setTokenInvalid(false);
    setFeedback("none");
    setErrorMessage(null);
    setMutation("saving");

    try {
      const result = await saveHfToken(trimmed, controller.signal);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current
      ) {
        return;
      }
      setLoadState({ kind: "ready", saved: result.saved });
      onStatusChangeRef.current?.(result.saved);
      setFeedback("saved");
      setMutation("idle");
      queueMicrotask(() => {
        closeButtonRef.current?.focus();
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setMutation("idle");
      setErrorMessage(formatPluginApiError(error, tRef.current));
      queueMicrotask(() => {
        tokenInputRef.current?.focus();
      });
    } finally {
      if (mutateAbortRef.current === controller) {
        mutateAbortRef.current = null;
      }
    }
  };

  const handleDelete = async () => {
    if (disabled || mutation !== "idle" || loadState.kind !== "ready" || !loadState.saved) {
      return;
    }

    clearTokenInput();
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    mutateAbortRef.current?.abort();
    const controller = new AbortController();
    mutateAbortRef.current = controller;
    const seq = ++statusSeqRef.current;

    setTokenInvalid(false);
    setFeedback("none");
    setErrorMessage(null);
    setMutation("deleting");

    try {
      const result = await deleteHfToken(controller.signal);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current
      ) {
        return;
      }
      setLoadState({ kind: "ready", saved: result.saved });
      onStatusChangeRef.current?.(result.saved);
      setFeedback("deleted");
      setMutation("idle");
      queueMicrotask(() => {
        closeButtonRef.current?.focus();
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        !openRef.current ||
        seq !== statusSeqRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setMutation("idle");
      setErrorMessage(formatPluginApiError(error, tRef.current));
    } finally {
      if (mutateAbortRef.current === controller) {
        mutateAbortRef.current = null;
      }
    }
  };

  const isSaving = mutation === "saving";
  const isDeleting = mutation === "deleting";
  const isMutating = mutation !== "idle";
  const isSaved = loadState.kind === "ready" && loadState.saved;
  const controlsDisabled = disabled || isMutating;

  const badgeClass =
    loadState.kind === "ready"
      ? loadState.saved
        ? "badge badge-success"
        : "badge"
      : loadState.kind === "error"
        ? "badge badge-warning"
        : "badge";
  const badgeText =
    loadState.kind === "ready"
      ? loadState.saved
        ? t("app.b2.hf_token_stored")
        : t("app.b2.hf_token_none")
      : loadState.kind === "error"
        ? t("app.b2.hf_token_unknown")
        : t("app.summary.unknown");

  const describedBy = tokenInvalid && errorMessage ? `${hintId} ${errorId}` : hintId;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <div className="plugin-card-title-row">
        <h1 className="dialog-title" id={titleId}>
          {t("app.b2.hf_token_title")}
        </h1>
        <span className={badgeClass}>{badgeText}</span>
      </div>

      <form className="dialog-form" method="post" onSubmit={handleSaveSubmit} noValidate>
        <div className="dialog-body">
          <p className="dialog-caption" id={hintId}>
            {t("app.b2.hf_token_hint")}
          </p>

          {loadState.kind === "error" && (
            <div className="alert alert-warning" role="alert">
              <span className="alert-icon icon-warning">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{loadState.message}</p>
                <div className="alert-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={controlsDisabled}
                    onClick={() => void fetchTokenStatus()}
                  >
                    {t("app.action.retry")}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="field-group">
            <label className="field-label" htmlFor={tokenInputId}>
              {t("app.b2.hf_token_field")}
            </label>
            <input
              ref={tokenInputRef}
              id={tokenInputId}
              name="hf_token"
              type="password"
              className="input mono"
              placeholder={t("app.b2.hf_token_placeholder")}
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              required
              disabled={controlsDisabled}
              aria-invalid={tokenInvalid ? "true" : undefined}
              aria-describedby={describedBy}
              onInput={() => {
                if (tokenInvalid) {
                  setTokenInvalid(false);
                }
                if (errorMessage !== null) {
                  setErrorMessage(null);
                }
                if (feedback !== "none") {
                  setFeedback("none");
                }
              }}
            />
          </div>

          {feedback !== "none" && (
            <div className="inline-msg inline-msg-success" role="status" aria-live="polite">
              <CheckCircleIcon />
              <span className="inline-msg-text">
                {feedback === "saved" ? t("app.b2.hf_token_saved") : t("app.b2.hf_token_deleted")}
              </span>
            </div>
          )}

          {errorMessage !== null && (
            <div className="alert alert-danger" role="alert" id={errorId}>
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
          {isSaved && (
            <span className="hf-token-delete-slot">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={controlsDisabled}
                aria-busy={isDeleting || undefined}
                onClick={() => void handleDelete()}
              >
                {isDeleting && <span className="spinner" aria-hidden="true" />}
                <span>{t("app.b2.action_delete")}</span>
              </button>
            </span>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            className="btn"
            disabled={isMutating}
            onClick={requestClose}
          >
            {t("app.action.close")}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={controlsDisabled}
            aria-busy={isSaving || undefined}
          >
            {isSaving && <span className="spinner" aria-hidden="true" />}
            <span>{isSaved ? t("web.plugins.replace_token") : t("app.b2.action_save")}</span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
