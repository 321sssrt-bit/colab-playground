/**
 * Native modal `<dialog>` for installing a plugin from a server folder path or Git URL:
 * step 1 inspects the source, step 2 previews the manifest, script size, replacement notice,
 * and paid-runtime warning, discarding the staged preview whenever cancelled or returning to edit.
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

import { AlertIcon, InfoIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import {
  discardPluginPreview,
  formatPluginApiError,
  formatScriptBytes,
  installPluginPreview,
  parsePluginOrigin,
  previewPlugin,
  resolveLocalizedText,
} from "./api.ts";
import type { PluginInfo, PluginPreviewResponse } from "./types.ts";

export interface InstallPluginDialogProps {
  readonly open: boolean;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onClose: () => void;
  readonly onInstalled: (plugin: PluginInfo) => void;
}

type DialogPhase = "source" | "checking" | "preview" | "installing";

export function InstallPluginDialog({
  open,
  locale,
  t,
  onClose,
  onInstalled,
}: InstallPluginDialogProps) {
  const titleId = useId();
  const sourceInputId = useId();
  const sourceHintId = useId();
  const sourceErrorId = useId();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const previewNameRef = useRef<HTMLParagraphElement | null>(null);
  const checkSeqRef = useRef(0);
  const installAbortRef = useRef<AbortController | null>(null);
  const activePreviewIdRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const mountedRef = useRef(true);

  const [sourceText, setSourceText] = useState("");
  const [checkedSource, setCheckedSource] = useState("");
  const [phase, setPhase] = useState<DialogPhase>("source");
  const [preview, setPreview] = useState<PluginPreviewResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceInvalid, setSourceInvalid] = useState(false);

  const discardStagedPreview = useCallback((previewId: string | null) => {
    if (!previewId) {
      return;
    }
    if (activePreviewIdRef.current === previewId) {
      activePreviewIdRef.current = null;
    }
    // Best-effort cleanup so a staged preview is never stranded on the server.
    void discardPluginPreview(previewId).catch(() => {});
  }, []);

  const resetForOpen = useCallback(() => {
    checkSeqRef.current += 1;
    installAbortRef.current?.abort();
    installAbortRef.current = null;
    discardStagedPreview(activePreviewIdRef.current);
    setSourceText("");
    setCheckedSource("");
    setPhase("source");
    setPreview(null);
    setErrorMessage(null);
    setSourceInvalid(false);
  }, [discardStagedPreview]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open) {
      resetForOpen();
      if (!dialog.open) {
        dialog.showModal();
      }
      sourceInputRef.current?.focus();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [open, resetForOpen]);

  useEffect(() => {
    if (open && phase === "preview") {
      previewNameRef.current?.focus();
    }
  }, [open, phase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkSeqRef.current += 1;
      installAbortRef.current?.abort();
      installAbortRef.current = null;
      discardStagedPreview(activePreviewIdRef.current);
    };
  }, [discardStagedPreview]);

  const handleDialogCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    if (phase === "installing") {
      event.preventDefault();
    }
  };

  const handleDialogClose = () => {
    const dialog = dialogRef.current;
    if (dialog) {
      dialog.returnValue = "";
    }
    // Invalidate any in-flight check without aborting its HTTP response so late previews get discarded.
    checkSeqRef.current += 1;
    installAbortRef.current?.abort();
    installAbortRef.current = null;
    discardStagedPreview(activePreviewIdRef.current);
    setPreview(null);
    setPhase("source");
    setErrorMessage(null);
    setSourceInvalid(false);
    if (openRef.current) {
      onClose();
    }
  };

  const requestClose = () => {
    if (phase === "installing") {
      return;
    }
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
    } else {
      handleDialogClose();
    }
  };

  const handleCheckSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (phase === "checking" || phase === "installing") {
      return;
    }
    const trimmed = sourceText.trim();
    if (!trimmed) {
      setSourceInvalid(true);
      setErrorMessage(t("web.plugins.source_required"));
      sourceInputRef.current?.focus();
      return;
    }

    const seq = ++checkSeqRef.current;

    setSourceInvalid(false);
    setErrorMessage(null);
    setPhase("checking");
    setCheckedSource(trimmed);

    try {
      // Do not abort the preview request on cancel: the backend still finishes staging it, so
      // receiving the late response lets us immediately DELETE its preview_id.
      const result = await previewPlugin(parsePluginOrigin(trimmed));
      if (!mountedRef.current || !openRef.current || seq !== checkSeqRef.current) {
        discardStagedPreview(result.preview_id);
        return;
      }
      activePreviewIdRef.current = result.preview_id;
      setPreview(result);
      setPhase("preview");
    } catch (error) {
      if (
        !mountedRef.current ||
        !openRef.current ||
        seq !== checkSeqRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setPhase("source");
      setErrorMessage(formatPluginApiError(error, t));
      sourceInputRef.current?.focus();
    }
  };

  const handleBackToSource = () => {
    if (phase !== "preview") {
      return;
    }
    discardStagedPreview(preview?.preview_id ?? activePreviewIdRef.current);
    setPreview(null);
    setErrorMessage(null);
    setSourceInvalid(false);
    setPhase("source");
    queueMicrotask(() => {
      sourceInputRef.current?.focus();
    });
  };

  const handleConfirmInstall = async () => {
    if (!preview || phase !== "preview") {
      return;
    }
    const previewId = preview.preview_id;
    installAbortRef.current?.abort();
    const controller = new AbortController();
    installAbortRef.current = controller;

    setErrorMessage(null);
    setPhase("installing");

    try {
      const installed = await installPluginPreview(previewId, controller.signal);
      // The backend consumes the staged preview once installation starts.
      if (activePreviewIdRef.current === previewId) {
        activePreviewIdRef.current = null;
      }
      if (controller.signal.aborted || !mountedRef.current) {
        return;
      }
      setPreview(null);
      setPhase("source");
      onInstalled(installed);
      const dialog = dialogRef.current;
      if (dialog?.open) {
        dialog.close();
      } else if (openRef.current) {
        onClose();
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      // Backend removes the staged preview as soon as installation enters commit, and another tab
      // may also invalidate it; discard best-effort and return to source so the user re-checks.
      discardStagedPreview(previewId);
      setPreview(null);
      setPhase("source");
      setErrorMessage(formatPluginApiError(error, t));
      queueMicrotask(() => {
        sourceInputRef.current?.focus();
      });
    } finally {
      if (installAbortRef.current === controller) {
        installAbortRef.current = null;
      }
    }
  };

  const isSourceStep = phase === "source" || phase === "checking";
  const isChecking = phase === "checking";
  const isInstalling = phase === "installing";

  const previewManifest = preview?.manifest ?? null;
  const previewName = previewManifest
    ? resolveLocalizedText(previewManifest.name, locale, previewManifest.id)
    : "";
  const previewDescription = previewManifest
    ? resolveLocalizedText(previewManifest.description, locale, "")
    : "";
  const separator = t("app.fmt.list_separator");
  const asksText = previewManifest
    ? previewManifest.inputs
        .map((input) => {
          const label = resolveLocalizedText(input.label, locale, input.id);
          return input.type === "secret"
            ? t("app.b2.plugin_input_secret", { name: label })
            : label;
        })
        .join(separator)
    : "";
  const receivesText = previewManifest
    ? previewManifest.needs.length === 0
      ? t("app.b2.plugin_receives_nothing")
      : previewManifest.needs.map(() => t("app.b2.plugin_needs_hf_token")).join(separator)
    : "";
  const offersText = previewManifest
    ? previewManifest.endpoints
        .map((endpoint) => resolveLocalizedText(endpoint.label, locale, endpoint.id))
        .join(separator)
    : "";
  const warningText = preview
    ? t(preview.warning_key) || t("app.b2.plugin_runs_on_runtime")
    : t("app.b2.plugin_runs_on_runtime");

  const describedBy =
    sourceInvalid && errorMessage ? `${sourceHintId} ${sourceErrorId}` : sourceHintId;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <h1 className="dialog-title" id={titleId}>
        {t("app.b2.plugin_install_title")}
      </h1>

      {isSourceStep ? (
        <form className="dialog-form" method="post" onSubmit={handleCheckSubmit} noValidate>
          <div className="dialog-body">
            <p className="dialog-caption" id={sourceHintId}>
              {t("web.plugins.source_required")}
            </p>

            <div className="field-group">
              <label className="field-label" htmlFor={sourceInputId}>
                {t("app.b2.plugin_source")}
              </label>
              <input
                ref={sourceInputRef}
                id={sourceInputId}
                name="plugin_source"
                type="text"
                className="input mono"
                value={sourceText}
                onChange={(event) => {
                  setSourceText(event.target.value);
                  if (sourceInvalid) {
                    setSourceInvalid(false);
                  }
                  if (errorMessage !== null) {
                    setErrorMessage(null);
                  }
                }}
                placeholder={t("app.b2.plugin_source_placeholder")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="next"
                required
                disabled={isChecking}
                aria-invalid={sourceInvalid ? "true" : undefined}
                aria-describedby={describedBy}
              />
            </div>

            {isChecking && (
              <div className="busy-line" role="status" aria-live="polite">
                <span className="spinner" aria-hidden="true" />
                <span>{t("app.b2.plugin_checking")}</span>
              </div>
            )}

            {errorMessage !== null && (
              <div className="alert alert-danger" role="alert" id={sourceErrorId}>
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
            <button type="button" className="btn" onClick={requestClose}>
              {t("app.action.cancel")}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={isChecking}
              aria-busy={isChecking || undefined}
            >
              {isChecking && <span className="spinner" aria-hidden="true" />}
              <span>{t("app.b2.plugin_check")}</span>
            </button>
          </div>
        </form>
      ) : (
        preview !== null &&
        previewManifest !== null && (
          <>
            <div className="dialog-body">
              <div className="plugin-facts">
                <p className="plugin-card-name" ref={previewNameRef} tabIndex={-1}>
                  {previewName}
                </p>
                {previewDescription && <p className="caption">{previewDescription}</p>}

                <div className="plugin-fact-row">
                  <span className="plugin-fact-key">{t("app.b2.plugin_version")}</span>
                  <span className="plugin-fact-val">{previewManifest.version}</span>
                </div>

                <div className="plugin-fact-row">
                  <span className="plugin-fact-key">{t("app.b2.plugin_from")}</span>
                  <span className="plugin-fact-val mono">{checkedSource}</span>
                </div>

                <div className="plugin-fact-row">
                  <span className="plugin-fact-key">{t("app.b2.plugin_script")}</span>
                  <span className="plugin-fact-val">
                    {t("app.b2.plugin_script_value", {
                      file: previewManifest.run.script,
                      size: formatScriptBytes(preview.script_bytes, locale, t),
                    })}
                  </span>
                </div>

                {asksText && (
                  <div className="plugin-fact-row">
                    <span className="plugin-fact-key">{t("app.b2.plugin_asks")}</span>
                    <span className="plugin-fact-val">{asksText}</span>
                  </div>
                )}

                <div className="plugin-fact-row">
                  <span className="plugin-fact-key">{t("app.b2.plugin_receives")}</span>
                  <span className="plugin-fact-val">{receivesText}</span>
                </div>

                {offersText && (
                  <div className="plugin-fact-row">
                    <span className="plugin-fact-key">{t("app.b2.plugin_offers")}</span>
                    <span className="plugin-fact-val">{offersText}</span>
                  </div>
                )}
              </div>

              {preview.replaces_version !== null && (
                <div className="inline-msg inline-msg-info" role="status">
                  <InfoIcon />
                  <span className="inline-msg-text">
                    {t("app.b2.plugin_replaces", { version: preview.replaces_version })}
                  </span>
                </div>
              )}

              <div className="alert alert-warning" role="note">
                <span className="alert-icon icon-warning">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-body">{warningText}</p>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={isInstalling}
                onClick={handleBackToSource}
              >
                {t("web.plugins.back_to_source")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={isInstalling}
                onClick={requestClose}
              >
                {t("app.action.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={isInstalling}
                aria-busy={isInstalling || undefined}
                onClick={() => void handleConfirmInstall()}
              >
                {isInstalling && <span className="spinner" aria-hidden="true" />}
                <span>{t("app.b2.plugin_install_action")}</span>
              </button>
            </div>
          </>
        )
      )}
    </dialog>
  );
}
