/**
 * Native modal `<dialog>` for opening and managing port forwards on a named
 * runtime on the active account. Defaults to `Loopback (127.0.0.1)`, honors
 * the server's `forward_policy`, warns on `AllInterfaces` downstream auth,
 * validates ports (1..65535, blocking reserved VM port 8080) and health paths
 * before submit, and shows live active forwards for the session.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type SyntheticEvent } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { AccountContext, ForwardBind, Runtime } from "../../lib/types.ts";
import { openForward, type ForwardPolicyView, type ForwardView } from "./api.ts";
import {
  FORWARD_DEFAULT_PORT,
  formatErrorMessage,
  parseForwardPort,
  RESERVED_VM_PORT,
  validateHealthPath,
  type FormattedError,
} from "./format.ts";
import { ForwardRow, type ForwardClosedNotice } from "./ForwardRow.tsx";
import { AlertTriangleIcon, LinkIcon, SmallAlertIcon, SmallInfoIcon } from "./Icons.tsx";
import { recordForwardAddresses } from "./store.ts";

export interface ForwardDialogRequest {
  readonly id: number;
  readonly runtime: Runtime;
  readonly accountContext: AccountContext;
}

export interface ForwardDialogProps {
  readonly request: ForwardDialogRequest | null;
  readonly currentAccountContext: AccountContext | null;
  readonly forwardPolicy: ForwardPolicyView | null;
  readonly forwardPolicyLoading: boolean;
  readonly forwardPolicyError: unknown | null;
  readonly existingForwards: readonly ForwardView[];
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
  readonly onForwardChanged: () => void;
  readonly onRetryForwardPolicy: () => void;
}

type InvalidField = "remote" | "local" | "health";

interface ValidationIssue {
  readonly field: InvalidField;
  readonly message: string;
}

function validateRemotePort(raw: string, t: TranslateFn): ValidationIssue | null {
  const port = parseForwardPort(raw);
  if (port === null) {
    return { field: "remote", message: t("web.forward.ports_invalid") };
  }
  if (port === RESERVED_VM_PORT) {
    return {
      field: "remote",
      message: t("app.err.port_reserved", { port: RESERVED_VM_PORT }),
    };
  }
  return null;
}

function validateLocalPort(raw: string, t: TranslateFn): ValidationIssue | null {
  if (parseForwardPort(raw) === null) {
    return { field: "local", message: t("web.forward.ports_invalid") };
  }
  return null;
}

export function ForwardDialog({
  request,
  currentAccountContext,
  forwardPolicy,
  forwardPolicyLoading,
  forwardPolicyError,
  existingForwards,
  t,
  pushToast,
  onClose,
  onForwardChanged,
  onRetryForwardPolicy,
}: ForwardDialogProps) {
  const titleId = useId();
  const remotePortId = useId();
  const localPortId = useId();
  const healthPathId = useId();
  const healthHintId = useId();
  const validationErrorId = useId();
  const bindGroupName = useId();
  const bindLoopbackId = useId();
  const bindAllId = useId();
  const bindNoticeId = useId();

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const remotePortRef = useRef<HTMLInputElement | null>(null);
  const localPortRef = useRef<HTMLInputElement | null>(null);
  const healthPathRef = useRef<HTMLInputElement | null>(null);
  const closedNoticeRef = useRef<HTMLDivElement | null>(null);
  const activeRequestIdRef = useRef<number>(0);

  const [remotePortDraft, setRemotePortDraft] = useState(String(FORWARD_DEFAULT_PORT));
  const [localPortDraft, setLocalPortDraft] = useState(String(FORWARD_DEFAULT_PORT));
  const [healthPathDraft, setHealthPathDraft] = useState("");
  const [bindDraft, setBindDraft] = useState<ForwardBind>("loopback");
  const [submitting, setSubmitting] = useState(false);
  const [validationIssue, setValidationIssue] = useState<ValidationIssue | null>(null);
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);
  const [closedNotice, setClosedNotice] = useState<ForwardClosedNotice | null>(null);

  // Initialize drafts strictly once per dialog open so live SSE snapshots never overwrite edits.
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
    setRemotePortDraft(String(FORWARD_DEFAULT_PORT));
    setLocalPortDraft(String(FORWARD_DEFAULT_PORT));
    setHealthPathDraft("");
    setBindDraft("loopback");
    setSubmitting(false);
    setValidationIssue(null);
    setSubmitError(null);
    setClosedNotice(null);

    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }
  }, [request?.id]);

  useEffect(() => {
    if (closedNotice) {
      closedNoticeRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [closedNotice]);

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

  const accountChanged =
    request !== null &&
    currentAccountContext !== null &&
    (currentAccountContext.revision !== request.accountContext.revision ||
      currentAccountContext.active !== request.accountContext.active);

  const allInterfacesAllowed = Boolean(forwardPolicy?.all_interfaces_allowed);
  const effectiveBind: ForwardBind = allInterfacesAllowed ? bindDraft : "loopback";
  const showRestrictionNotice = forwardPolicy !== null && !forwardPolicy.all_interfaces_allowed;
  const restrictionMessage = showRestrictionNotice
    ? forwardPolicy.restriction === "windows_or_wsl"
      ? t("web.forward.bind_windows_or_wsl")
      : t("web.forward.bind_loopback_listener")
    : null;
  const showDownstreamWarning = allInterfacesAllowed && effectiveBind === "all_interfaces";
  const showPolicyLoading = forwardPolicy === null && forwardPolicyLoading;
  const formattedPolicyError =
    forwardPolicy === null && !forwardPolicyLoading && forwardPolicyError
      ? formatErrorMessage(forwardPolicyError, t)
      : null;
  const hasBindNotices = Boolean(
    restrictionMessage || showDownstreamWarning || showPolicyLoading || formattedPolicyError,
  );

  const sessionName = request?.runtime.id.name ?? "";
  const invalidField = validationIssue?.field ?? null;

  const focusField = (field: InvalidField) => {
    if (field === "remote") {
      remotePortRef.current?.focus();
    } else if (field === "local") {
      localPortRef.current?.focus();
    } else {
      healthPathRef.current?.focus();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!request || submitting || accountChanged || !request.runtime.id.name) {
      return;
    }

    const remoteIssue = validateRemotePort(remotePortDraft, t);
    if (remoteIssue) {
      setValidationIssue(remoteIssue);
      focusField(remoteIssue.field);
      return;
    }
    const localIssue = validateLocalPort(localPortDraft, t);
    if (localIssue) {
      setValidationIssue(localIssue);
      focusField(localIssue.field);
      return;
    }
    const healthResult = validateHealthPath(healthPathDraft);
    if (!healthResult.ok) {
      setValidationIssue({ field: "health", message: t("web.forward.health_invalid") });
      focusField("health");
      return;
    }

    const remotePort = parseForwardPort(remotePortDraft);
    const localPort = parseForwardPort(localPortDraft);
    if (remotePort === null || localPort === null) {
      return;
    }

    const requestId = request.id;
    const sessionGeneration = apiClient.getSessionGeneration();
    setSubmitting(true);
    setValidationIssue(null);
    setSubmitError(null);
    setClosedNotice(null);

    try {
      const created = await openForward({
        account_context: request.accountContext,
        account: request.runtime.id.account,
        session: request.runtime.id.name,
        bind: effectiveBind,
        local_port: localPort,
        remote_port: remotePort,
        health_path: healthResult.value,
      });
      if (apiClient.getSessionGeneration() !== sessionGeneration) {
        return;
      }
      recordForwardAddresses(created);
      onForwardChanged();
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      setSubmitting(false);
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        setSubmitting(false);
        onClose();
        return;
      }
      if (
        apiClient.getSessionGeneration() !== sessionGeneration ||
        activeRequestIdRef.current !== requestId
      ) {
        return;
      }
      setSubmitting(false);
      setSubmitError(formatErrorMessage(error, t));
    }
  };

  const closedByAttr = {
    closedby: submitting ? "none" : "closerequest",
  } as Record<string, string>;
  const activeRequestId = request?.id ?? 0;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      data-dialog-kind={request ? "forward" : undefined}
      data-dialog-phase={request ? (submitting ? "submitting" : "form") : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {closedNotice && (
          <>
            <span>{closedNotice.title}</span>
            <span>{" "}</span>
            <span>{closedNotice.body}</span>
          </>
        )}
      </div>

      {request && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("app.b2.forward_title")}
          </h1>

          <form
            className="dialog-form"
            noValidate
            onSubmit={(event) => void handleSubmit(event)}
          >
            <div className="dialog-body">
              <p className="dialog-paragraph">
                {t("app.b2.forward_intro", { name: sessionName })}
              </p>

              <div className="inline-msg inline-msg-info" data-forward-billing-note="true">
                <SmallInfoIcon className="icon-xs icon-info" />
                <span className="inline-msg-text">{t("app.b2.forward_billing_note")}</span>
              </div>

              {accountChanged && (
                <div className="inline-msg inline-msg-warning">
                  <AlertTriangleIcon className="icon-xs icon-warning" />
                  <span className="inline-msg-text">{t("web.sessions.account_changed")}</span>
                </div>
              )}

              {closedNotice && (
                <div
                  ref={closedNoticeRef}
                  className="alert alert-info"
                  data-forward-closed-notice="true"
                >
                  <span className="alert-icon icon-info">
                    <SmallInfoIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{closedNotice.title}</p>
                    <p className="alert-body">{closedNotice.body}</p>
                  </div>
                </div>
              )}

              {submitError && (
                <div className="alert alert-danger" role="alert" data-forward-submit-error="true">
                  <span className="alert-icon icon-danger">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{submitError.message}</p>
                    {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                  </div>
                </div>
              )}

              {validationIssue && (
                <div
                  id={validationErrorId}
                  className="inline-msg inline-msg-danger"
                  role="alert"
                  data-forward-validation-error={validationIssue.field}
                >
                  <SmallAlertIcon className="icon-xs icon-danger" />
                  <span className="inline-msg-text">{validationIssue.message}</span>
                </div>
              )}

              <div className="forward-ports-row">
                <div className="field-group forward-port-field">
                  <label htmlFor={remotePortId} className="field-label">
                    {t("app.b2.forward_remote")}
                  </label>
                  <input
                    ref={remotePortRef}
                    id={remotePortId}
                    name="remote_port"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                    className="input"
                    required
                    aria-invalid={invalidField === "remote" ? "true" : undefined}
                    aria-describedby={invalidField === "remote" ? validationErrorId : undefined}
                    data-forward-remote-port="true"
                    value={remotePortDraft}
                    disabled={submitting}
                    autoFocus
                    onChange={(event) => {
                      setRemotePortDraft(event.target.value);
                      if (invalidField === "remote") {
                        setValidationIssue(null);
                      }
                      if (submitError) {
                        setSubmitError(null);
                      }
                    }}
                  />
                </div>

                <div className="field-group forward-port-field">
                  <label htmlFor={localPortId} className="field-label">
                    {t("app.b2.forward_local")}
                  </label>
                  <input
                    ref={localPortRef}
                    id={localPortId}
                    name="local_port"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                    className="input"
                    required
                    aria-invalid={invalidField === "local" ? "true" : undefined}
                    aria-describedby={invalidField === "local" ? validationErrorId : undefined}
                    data-forward-local-port="true"
                    value={localPortDraft}
                    disabled={submitting}
                    onChange={(event) => {
                      setLocalPortDraft(event.target.value);
                      if (invalidField === "local") {
                        setValidationIssue(null);
                      }
                      if (submitError) {
                        setSubmitError(null);
                      }
                    }}
                  />
                </div>
              </div>

              <div className="field-group">
                <label htmlFor={healthPathId} className="field-label">
                  {t("app.b2.forward_health")}
                </label>
                <input
                  ref={healthPathRef}
                  id={healthPathId}
                  name="health_path"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  className="input"
                  placeholder={t("app.b2.forward_health_placeholder")}
                  aria-invalid={invalidField === "health" ? "true" : undefined}
                  aria-describedby={
                    invalidField === "health"
                      ? `${healthHintId} ${validationErrorId}`
                      : healthHintId
                  }
                  data-forward-health-path="true"
                  value={healthPathDraft}
                  disabled={submitting}
                  onChange={(event) => {
                    setHealthPathDraft(event.target.value);
                    if (invalidField === "health") {
                      setValidationIssue(null);
                    }
                    if (submitError) {
                      setSubmitError(null);
                    }
                  }}
                />
                <span id={healthHintId} className="field-hint">
                  {t("app.b2.forward_health_hint")}
                </span>
              </div>

              <fieldset className="forward-bind-fieldset" data-forward-bind-fieldset="true">
                <legend className="field-label">{t("web.forward.bind_label")}</legend>
                <div className="forward-bind-options">
                  <label className="forward-bind-option" htmlFor={bindLoopbackId}>
                    <input
                      id={bindLoopbackId}
                      type="radio"
                      name={bindGroupName}
                      value="loopback"
                      data-forward-bind="loopback"
                      checked={effectiveBind === "loopback"}
                      disabled={submitting}
                      onChange={() => {
                        setBindDraft("loopback");
                        if (submitError) {
                          setSubmitError(null);
                        }
                      }}
                    />
                    <span>{t("web.forward.bind_loopback")}</span>
                  </label>
                  <label
                    className={
                      allInterfacesAllowed
                        ? "forward-bind-option"
                        : "forward-bind-option forward-bind-option-disabled"
                    }
                    htmlFor={bindAllId}
                  >
                    <input
                      id={bindAllId}
                      type="radio"
                      name={bindGroupName}
                      value="all_interfaces"
                      data-forward-bind="all_interfaces"
                      checked={effectiveBind === "all_interfaces"}
                      disabled={submitting || !allInterfacesAllowed}
                      aria-describedby={hasBindNotices ? bindNoticeId : undefined}
                      onChange={() => {
                        if (allInterfacesAllowed) {
                          setBindDraft("all_interfaces");
                          if (submitError) {
                            setSubmitError(null);
                          }
                        }
                      }}
                    />
                    <span>{t("web.forward.bind_all")}</span>
                  </label>
                </div>

                {hasBindNotices && (
                  <div id={bindNoticeId} className="forward-bind-notices">
                    {showPolicyLoading && (
                      <div className="busy-line" role="status" data-forward-policy-loading="true">
                        <span className="spinner" aria-hidden="true" />
                        <span>{t("web.settings.loading")}</span>
                      </div>
                    )}
                    {formattedPolicyError && (
                      <div
                        className="alert alert-warning"
                        role="alert"
                        data-forward-policy-error="true"
                      >
                        <span className="alert-icon icon-warning">
                          <AlertTriangleIcon />
                        </span>
                        <div className="alert-text">
                          <p className="alert-title">{formattedPolicyError.message}</p>
                          {formattedPolicyError.hint && (
                            <p className="alert-body">{formattedPolicyError.hint}</p>
                          )}
                          <div className="alert-actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              data-forward-policy-retry="true"
                              disabled={submitting}
                              onClick={onRetryForwardPolicy}
                            >
                              {t("app.action.retry")}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {restrictionMessage && (
                      <div
                        className="inline-msg inline-msg-info"
                        data-forward-bind-restriction={forwardPolicy?.restriction ?? "loopback"}
                      >
                        <SmallInfoIcon className="icon-xs icon-info" />
                        <span className="inline-msg-text">{restrictionMessage}</span>
                      </div>
                    )}
                    {showDownstreamWarning && (
                      <div
                        className="inline-msg inline-msg-warning"
                        role="note"
                        data-forward-downstream-warning="true"
                      >
                        <AlertTriangleIcon className="icon-xs icon-warning" />
                        <span className="inline-msg-text">{t("web.forward.downstream_auth")}</span>
                      </div>
                    )}
                  </div>
                )}
              </fieldset>

              {existingForwards.length > 0 && (
                <div className="forward-existing-host" data-forward-existing="true">
                  <span className="field-label">
                    {t("web.forward.existing_title", { name: sessionName })}
                  </span>
                  <div className="forward-list">
                    {existingForwards.map((fw) => (
                      <ForwardRow
                        key={fw.id}
                        forward={fw}
                        t={t}
                        pushToast={pushToast}
                        onAfterClose={(notice) => {
                          if (notice && activeRequestIdRef.current === activeRequestId) {
                            setClosedNotice(notice);
                          }
                          onForwardChanged();
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={submitting}
                onClick={onClose}
              >
                {t("app.action.cancel")}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                data-forward-submit="true"
                disabled={submitting || accountChanged}
              >
                {submitting ? <span className="spinner" aria-hidden="true" /> : <LinkIcon />}
                <span>{t("app.b2.forward_action")}</span>
              </button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}
