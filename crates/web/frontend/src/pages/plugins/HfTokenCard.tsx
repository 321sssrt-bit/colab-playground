/**
 * Inline Hugging Face token status and management card rendered on the Plugins list page,
 * mirroring upstream `crates/app/src/ui/pages/plugins/mod.rs::token_card`.
 *
 * Security invariant: the plaintext token lives only inside an uncontrolled `type="password"`
 * DOM input, is cleared immediately before submitting and on unmount, and never enters React
 * state, shared stores, or logs.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import { formatPluginApiError, getHfTokenBadgeMeta } from "./api.ts";
import { pluginCacheStore } from "./pluginCache.ts";
import type { HfTokenState } from "./types.ts";

export interface HfTokenCardProps {
  readonly hfToken: HfTokenState;
  readonly disabled: boolean;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
}

type CardMutation = "idle" | "saving" | "deleting";

export function HfTokenCard({ hfToken, disabled, t, pushToast }: HfTokenCardProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const mutateAbortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const tRef = useRef(t);
  tRef.current = t;
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  const [mutation, setMutation] = useState<CardMutation>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);

  const clearTokenInput = useCallback(() => {
    if (tokenInputRef.current) {
      tokenInputRef.current.value = "";
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      mutateAbortRef.current?.abort();
      mutateAbortRef.current = null;
      clearTokenInput();
    };
  }, [clearTokenInput]);

  const handleSaveSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || mutation !== "idle") {
      return;
    }

    const trimmed = (tokenInputRef.current?.value ?? "").trim();
    if (!trimmed) {
      setTokenInvalid(true);
      setErrorMessage(t("web.plugins.token_required"));
      tokenInputRef.current?.focus();
      return;
    }

    // Clear the masked field before awaiting network I/O so plaintext never lingers in DOM.
    clearTokenInput();
    mutateAbortRef.current?.abort();
    const controller = new AbortController();
    mutateAbortRef.current = controller;
    const seq = ++seqRef.current;

    setTokenInvalid(false);
    setErrorMessage(null);
    setMutation("saving");

    try {
      await pluginCacheStore.saveHfToken(trimmed, controller.signal);
      if (controller.signal.aborted || !mountedRef.current || seq !== seqRef.current) {
        return;
      }
      setMutation("idle");
      pushToastRef.current({
        tone: "success",
        body: tRef.current("app.b2.hf_token_saved"),
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        seq !== seqRef.current ||
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
    if (disabled || mutation !== "idle" || hfToken.kind !== "ready" || !hfToken.saved) {
      return;
    }

    clearTokenInput();
    mutateAbortRef.current?.abort();
    const controller = new AbortController();
    mutateAbortRef.current = controller;
    const seq = ++seqRef.current;

    setTokenInvalid(false);
    setErrorMessage(null);
    setMutation("deleting");

    try {
      await pluginCacheStore.deleteHfToken(controller.signal);
      if (controller.signal.aborted || !mountedRef.current || seq !== seqRef.current) {
        return;
      }
      setMutation("idle");
      pushToastRef.current({
        tone: "success",
        body: tRef.current("app.b2.hf_token_deleted"),
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        seq !== seqRef.current ||
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

  const badge = getHfTokenBadgeMeta(hfToken, t);
  const isSaving = mutation === "saving";
  const isDeleting = mutation === "deleting";
  const isMutating = mutation !== "idle";
  const isSaved = hfToken.kind === "ready" && hfToken.saved;
  const controlsDisabled = disabled || isMutating;
  const loadErrorMessage =
    hfToken.kind === "error" ? formatPluginApiError(hfToken.error, t) : null;
  const describedBy = tokenInvalid && errorMessage ? `${hintId} ${errorId}` : hintId;

  return (
    <section
      className="card hf-token-card"
      data-hf-token-card="true"
      data-hf-token-status={badge.status}
    >
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.b2.hf_token_title")}</h2>
          <p className="card-desc" id={hintId}>
            {t("app.b2.hf_token_hint")}
          </p>
        </div>
        <div className="card-actions">
          <span className={badge.className} data-hf-token-badge="true">
            {badge.text}
          </span>
        </div>
      </div>

      {loadErrorMessage !== null && (
        <div className="alert alert-warning" role="alert" data-hf-token-error="true">
          <span className="alert-icon icon-warning">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-body">{loadErrorMessage}</p>
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                data-hf-token-retry="true"
                disabled={controlsDisabled}
                onClick={() => {
                  void pluginCacheStore.refreshHfTokenStatus().catch(() => {});
                }}
              >
                {t("app.action.retry")}
              </button>
            </div>
          </div>
        </div>
      )}

      <form
        className="hf-token-inline-form"
        method="post"
        noValidate
        onSubmit={(event) => void handleSaveSubmit(event)}
      >
        <div className="hf-token-inline-row">
          <label className="visually-hidden" htmlFor={inputId}>
            {t("app.b2.hf_token_field")}
          </label>
          <input
            ref={tokenInputRef}
            id={inputId}
            name="hf_token_card"
            type="password"
            className="input mono"
            placeholder={t("app.b2.hf_token_placeholder")}
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
            disabled={controlsDisabled}
            aria-invalid={tokenInvalid ? "true" : undefined}
            aria-describedby={describedBy}
            data-hf-token-input="true"
            onInput={() => {
              if (tokenInvalid) {
                setTokenInvalid(false);
              }
              if (errorMessage !== null) {
                setErrorMessage(null);
              }
            }}
          />
          <div className="hf-token-card-actions">
            <button
              type="submit"
              className="btn btn-primary"
              data-hf-token-save="true"
              disabled={controlsDisabled}
              aria-busy={isSaving || undefined}
            >
              {isSaving && <span className="spinner" aria-hidden="true" />}
              <span>{isSaved ? t("web.plugins.replace_token") : t("app.b2.action_save")}</span>
            </button>
            {isSaved && (
              <button
                type="button"
                className="btn btn-ghost"
                data-hf-token-delete="true"
                disabled={controlsDisabled}
                aria-busy={isDeleting || undefined}
                onClick={() => void handleDelete()}
              >
                {isDeleting && <span className="spinner" aria-hidden="true" />}
                <span>{t("app.b2.action_delete")}</span>
              </button>
            )}
          </div>
        </div>

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
      </form>
    </section>
  );
}
