/**
 * Native modal `<dialog>` for starting a new Colab runtime with hardware
 * targeting, cost guards, concurrent session limit checks, account-change
 * guard, live SSE provisioning progress, hiding back to the Sessions card,
 * and cancellation at any point.
 */

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import { serverClock } from "../../lib/clock.ts";
import { CORE_DEFAULTS } from "../../lib/constants.ts";
import { resolveActiveAccount } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { RouteId } from "../../lib/router.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type {
  AccountContext,
  AccountId,
  HardwareRate,
  Locale,
  PendingOperation,
  Snapshot,
} from "../../lib/types.ts";
import {
  cancelProvision,
  fetchSessionTemplate,
  startProvision,
  type ProvisionOutcome,
  type ProvisionSpec,
} from "./api.ts";
import { formatEmail, formatErrorMessage, type FormattedError } from "./format.ts";
import { AlertTriangleIcon, PlayIcon, SmallAlertIcon, SmallInfoIcon } from "./Icons.tsx";
import {
  buildProvisionSpecFromDraft,
  findMeasuredRate,
  MAX_SESSION_NAME_LEN,
  ProvisionFields,
  resolveNextSuggestedName,
  specToProvisionDraft,
  type ProvisionDraft,
  type ProvisionFieldErrorId,
  type ProvisionFieldsChangeMeta,
} from "./ProvisionFields.tsx";
import {
  formatProvisionHeadline,
  hasProvisionLines,
  ProvisionProgress,
} from "./ProvisionProgress.tsx";
import {
  refreshRearmDuration,
  setProvisionDialogOperationId,
  trackProvision,
  type SubmittedProvisionForm,
  type TrackedProvision,
} from "./store.ts";

export type NewSessionDialogRequest =
  | {
      readonly id: number;
      readonly mode: "create";
      readonly accountContext: AccountContext;
    }
  | {
      readonly id: number;
      readonly mode: "running";
      readonly operationId: number;
      readonly sessionName: string;
    };

export interface NewSessionDialogProps {
  readonly request: NewSessionDialogRequest | null;
  readonly snapshot: Snapshot | null;
  readonly maxConcurrentSessions: number;
  readonly activeProvisionOp: { readonly op: PendingOperation; readonly sessionName: string } | null;
  readonly trackedProvision: TrackedProvision | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId) => void;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
  readonly onTrackingOperation: (operationId: number | null) => void;
}

type DialogPhase =
  | { readonly kind: "loading" }
  | { readonly kind: "load_error"; readonly error: FormattedError }
  | {
      readonly kind: "limit";
      readonly limit: number;
      readonly email: string;
      readonly counted: readonly string[];
    }
  | { readonly kind: "form" }
  | { readonly kind: "running"; readonly operationId: number; readonly sessionName: string }
  | { readonly kind: "ready"; readonly outcome: ProvisionOutcome }
  | { readonly kind: "failed"; readonly error: FormattedError }
  | { readonly kind: "cancelled" };

function resolveAccountEmail(
  snapshot: Snapshot | null,
  accountId: AccountId | null,
  t: TranslateFn,
): string {
  if (accountId !== null) {
    const matched = snapshot?.accounts?.accounts.find((item) => item.id === accountId) ?? null;
    if (matched) {
      return formatEmail(matched.email, t);
    }
  }
  return formatEmail(resolveActiveAccount(snapshot, t).email, t);
}

function countNamedRuntimesOnAccount(
  snapshot: Snapshot | null,
  accountId: AccountId | null,
): string[] {
  const runtimes = snapshot?.runtimes?.runtimes ?? [];
  const names: string[] = [];
  for (const rt of runtimes) {
    const onTarget = accountId !== null ? rt.id.account === accountId : rt.on_active_account;
    if (onTarget && rt.id.name) {
      names.push(rt.id.name);
    }
  }
  return names;
}

export function NewSessionDialog({
  request,
  snapshot,
  maxConcurrentSessions,
  activeProvisionOp,
  trackedProvision,
  locale,
  t,
  navigate,
  pushToast,
  onClose,
  onTrackingOperation,
}: NewSessionDialogProps) {
  const titleId = useId();
  const nameInputId = useId();
  const validationErrorId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const activeRequestIdRef = useRef<number>(0);
  const autoNameRef = useRef<string>("");
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const maxConcurrentRef = useRef(maxConcurrentSessions);
  maxConcurrentRef.current = maxConcurrentSessions;
  const tRef = useRef(t);
  tRef.current = t;
  const onTrackingOperationRef = useRef(onTrackingOperation);
  onTrackingOperationRef.current = onTrackingOperation;

  const [phase, setPhase] = useState<DialogPhase>({ kind: "loading" });
  const [nameDraft, setNameDraft] = useState("");
  const [suggestedName, setSuggestedName] = useState("");
  const [baseTemplate, setBaseTemplate] = useState<ProvisionSpec | null>(null);
  const [templateMeasuredRates, setTemplateMeasuredRates] = useState<readonly HardwareRate[]>([]);
  const [provisionDraft, setProvisionDraft] = useState<ProvisionDraft | null>(null);
  const [formAccountContext, setFormAccountContext] = useState<AccountContext | null>(null);
  const [retryDelaySecs, setRetryDelaySecs] = useState<number>(CORE_DEFAULTS.retry_delay);
  const [submitting, setSubmitting] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<ProvisionFieldErrorId>>(
    () => new Set<ProvisionFieldErrorId>(),
  );
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);
  const [attachedOperationId, setAttachedOperationId] = useState<number | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const reloadAsCreateRef = useRef(false);

  const reportTrackingOperation = (operationId: number | null) => {
    setProvisionDialogOperationId(operationId);
    onTrackingOperationRef.current(operationId);
  };

  useEffect(() => {
    return () => {
      setProvisionDialogOperationId(null);
      onTrackingOperationRef.current(null);
    };
  }, []);

  const loadTemplateAndLimit = (
    requestId: number,
    targetAccountContext: AccountContext | null,
    signal: AbortSignal,
  ) => {
    const gen = apiClient.getSessionGeneration();
    const targetAccount = targetAccountContext?.active ?? null;
    setPhase({ kind: "loading" });
    setFormAccountContext(targetAccountContext);
    setSubmitting(false);
    setCancelRequested(false);
    setInvalidFields(new Set<ProvisionFieldErrorId>());
    setSubmitError(null);
    setAttachedOperationId(null);
    reportTrackingOperation(null);

    const templatePromise = fetchSessionTemplate(signal);
    const settingsPromise = refreshRearmDuration(signal)
      .then((res) => res.maxConcurrentSessions)
      .catch(() => maxConcurrentRef.current);

    void Promise.all([templatePromise, settingsPromise]).then(
      ([template, resolvedMaxConcurrent]) => {
        if (typeof template.sampled_at === "number") {
          serverClock.sync(template.sampled_at);
        }
        if (
          signal.aborted ||
          apiClient.getSessionGeneration() !== gen ||
          activeRequestIdRef.current !== requestId
        ) {
          return;
        }
        const counted = countNamedRuntimesOnAccount(snapshotRef.current, targetAccount);
        const cap = Math.max(1, resolvedMaxConcurrent);
        setNameDraft(template.name);
        setSuggestedName(template.name);
        autoNameRef.current = template.name;
        setBaseTemplate(template);
        setTemplateMeasuredRates(template.measured_rates ?? []);
        setProvisionDraft(specToProvisionDraft(template));
        setRetryDelaySecs(template.retry_delay);
        if (counted.length >= cap) {
          setPhase({
            kind: "limit",
            limit: cap,
            email: resolveAccountEmail(snapshotRef.current, targetAccount, tRef.current),
            counted,
          });
        } else {
          setPhase({ kind: "form" });
        }
      },
      (error: unknown) => {
        if (signal.aborted || (error instanceof ApiError && error.isAbort)) {
          return;
        }
        if (error instanceof ApiError && error.isUnauthorized) {
          onClose();
          return;
        }
        if (
          apiClient.getSessionGeneration() !== gen ||
          activeRequestIdRef.current !== requestId
        ) {
          return;
        }
        setPhase({ kind: "load_error", error: formatErrorMessage(error, tRef.current) });
      },
    );
  };

  // Initialize dialog strictly once per open (or explicit retry) so SSE pushes never reset user edits.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!request) {
      activeRequestIdRef.current = 0;
      reloadAsCreateRef.current = false;
      setAttachedOperationId(null);
      reportTrackingOperation(null);
      if (dialog?.open) {
        dialog.close();
      }
      return;
    }

    const isSameRequest = activeRequestIdRef.current === request.id;
    const reloadAsCreate = isSameRequest && reloadAsCreateRef.current;
    reloadAsCreateRef.current = false;
    activeRequestIdRef.current = request.id;
    if (dialog && !dialog.open) {
      dialog.returnValue = "";
      dialog.showModal();
    }

    if (request.mode === "running" && !reloadAsCreate) {
      setSubmitting(false);
      setCancelRequested(false);
      setSubmitError(null);
      setInvalidFields(new Set<ProvisionFieldErrorId>());
      setBaseTemplate(null);
      setTemplateMeasuredRates([]);
      setProvisionDraft(null);
      setFormAccountContext(snapshotRef.current?.account ?? null);
      setAttachedOperationId(request.operationId);
      reportTrackingOperation(request.operationId);
      trackProvision(
        request.operationId,
        request.sessionName,
        snapshotRef.current?.account ?? null,
      );
      setPhase({
        kind: "running",
        operationId: request.operationId,
        sessionName: request.sessionName,
      });
      return;
    }

    const controller = new AbortController();
    const targetAccountContext =
      request.mode === "create"
        ? request.accountContext
        : (snapshotRef.current?.account ?? null);
    loadTemplateAndLimit(request.id, targetAccountContext, controller.signal);
    return () => {
      controller.abort();
    };
  }, [request?.id, reloadSeq]);

  const attachedTracked =
    attachedOperationId !== null && trackedProvision?.operationId === attachedOperationId
      ? trackedProvision
      : null;

  // Converge dialog phase when the store-owned provision stream reaches a terminal state.
  useEffect(() => {
    if (phase.kind !== "running" || !attachedTracked || attachedTracked.phase === "running") {
      return;
    }
    setCancelRequested(false);
    if (attachedTracked.phase === "ready" && attachedTracked.outcome) {
      setPhase({ kind: "ready", outcome: attachedTracked.outcome });
      return;
    }
    if (attachedTracked.phase === "cancelled") {
      setPhase({ kind: "cancelled" });
      return;
    }
    if (attachedTracked.finishedError?.kind === "session_limit_reached") {
      const parsedLimit = Number(attachedTracked.finishedError.args?.limit);
      const cap =
        Number.isFinite(parsedLimit) && parsedLimit >= 1
          ? Math.floor(parsedLimit)
          : Math.max(1, maxConcurrentRef.current);
      const targetAccount =
        request?.mode === "create"
          ? request.accountContext.active
          : (attachedTracked.accountContext?.active ?? null);
      setPhase({
        kind: "limit",
        limit: cap,
        email: resolveAccountEmail(snapshotRef.current, targetAccount, tRef.current),
        counted: countNamedRuntimesOnAccount(snapshotRef.current, targetAccount),
      });
      return;
    }
    setPhase({
      kind: "failed",
      error: formatErrorMessage(attachedTracked.finishedError, tRef.current),
    });
  }, [phase.kind, attachedTracked, request]);

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

  const currentAccountContext = snapshot?.account ?? null;
  const originAccountContext =
    request === null
      ? null
      : formAccountContext !== null
        ? formAccountContext
        : request.mode === "create"
          ? request.accountContext
          : (attachedTracked?.accountContext ?? null);
  const accountChanged =
    originAccountContext !== null &&
    currentAccountContext !== null &&
    (currentAccountContext.revision !== originAccountContext.revision ||
      currentAccountContext.active !== originAccountContext.active);

  const shuttingDown = Boolean(snapshot?.shutting_down);
  const blockedByActiveProvision =
    (activeProvisionOp !== null || trackedProvision?.phase === "running") && phase.kind === "form";

  const combinedMeasuredRates = useMemo(() => {
    const fromSnapshot = snapshot?.measured_rates ?? [];
    if (fromSnapshot.length === 0) {
      return templateMeasuredRates;
    }
    if (templateMeasuredRates.length === 0) {
      return fromSnapshot;
    }
    return [...templateMeasuredRates, ...fromSnapshot];
  }, [snapshot?.measured_rates, templateMeasuredRates]);

  const measuredRate = provisionDraft
    ? findMeasuredRate(
        snapshot?.runtimes?.runtimes,
        provisionDraft.accelerator,
        provisionDraft.high_mem,
        combinedMeasuredRates,
      )
    : null;

  const handleProvisionFieldsChange = (
    nextDraft: ProvisionDraft,
    meta?: ProvisionFieldsChangeMeta,
  ) => {
    setProvisionDraft(nextDraft);
    if (meta?.acceleratorChanged) {
      const resolved = resolveNextSuggestedName(
        nameDraft,
        autoNameRef.current,
        meta.acceleratorChanged.prev,
        meta.acceleratorChanged.next,
      );
      if (resolved.suggestedName !== autoNameRef.current) {
        autoNameRef.current = resolved.suggestedName;
        setSuggestedName(resolved.suggestedName);
      }
      if (resolved.nextDraft !== nameDraft) {
        setNameDraft(resolved.nextDraft);
      }
    }
    if (invalidFields.size > 0) {
      setInvalidFields(new Set<ProvisionFieldErrorId>());
    }
    if (submitError) {
      setSubmitError(null);
    }
  };

  const focusFirstInvalidControl = (fields: ReadonlySet<ProvisionFieldErrorId>) => {
    if (fields.has("name")) {
      nameInputRef.current?.focus();
      return;
    }
    window.requestAnimationFrame(() => {
      const firstInvalid = dialogRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      firstInvalid?.focus();
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitAccountContext =
      formAccountContext ?? (request?.mode === "create" ? request.accountContext : null);
    if (
      !request ||
      phase.kind !== "form" ||
      !provisionDraft ||
      !submitAccountContext ||
      submitting ||
      accountChanged ||
      blockedByActiveProvision ||
      shuttingDown
    ) {
      return;
    }

    const built = buildProvisionSpecFromDraft(
      nameDraft,
      provisionDraft,
      retryDelaySecs,
      baseTemplate,
      autoNameRef.current,
    );
    if (!built.ok) {
      setInvalidFields(built.invalidFields);
      focusFirstInvalidControl(built.invalidFields);
      return;
    }

    if (nameDraft.trim() !== built.spec.name) {
      setNameDraft(built.spec.name);
    }

    const requestId = request.id;
    const sessionGeneration = apiClient.getSessionGeneration();
    const submittedForm: SubmittedProvisionForm = {
      name: built.spec.name,
      suggestedName: autoNameRef.current,
      draft: provisionDraft,
      baseTemplate,
      retryDelaySecs,
      measuredRates: combinedMeasuredRates,
      accountContext: submitAccountContext,
    };
    setSubmitting(true);
    setInvalidFields(new Set<ProvisionFieldErrorId>());
    setSubmitError(null);

    try {
      const accepted = await startProvision(submitAccountContext, built.spec);
      if (
        apiClient.getSessionGeneration() !== sessionGeneration ||
        activeRequestIdRef.current !== requestId
      ) {
        return;
      }
      setSubmitting(false);
      setCancelRequested(false);
      setAttachedOperationId(accepted.id);
      reportTrackingOperation(accepted.id);
      trackProvision(accepted.id, built.spec.name, submitAccountContext, submittedForm);
      setPhase({
        kind: "running",
        operationId: accepted.id,
        sessionName: built.spec.name,
      });
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
      if (error instanceof ApiError && error.kind === "session_limit_reached") {
        const parsedLimit = Number(error.args?.limit);
        const cap =
          Number.isFinite(parsedLimit) && parsedLimit >= 1
            ? Math.floor(parsedLimit)
            : Math.max(1, maxConcurrentRef.current);
        setPhase({
          kind: "limit",
          limit: cap,
          email: resolveAccountEmail(
            snapshotRef.current,
            submitAccountContext.active,
            tRef.current,
          ),
          counted: countNamedRuntimesOnAccount(snapshotRef.current, submitAccountContext.active),
        });
        return;
      }
      setSubmitError(formatErrorMessage(error, t));
    }
  };

  const isOpCancelling =
    phase.kind === "running" &&
    (cancelRequested ||
      (activeProvisionOp?.op.id === phase.operationId && activeProvisionOp.op.cancelling));

  const handleCancelProvision = async () => {
    if (phase.kind !== "running" || isOpCancelling) {
      return;
    }
    const opId = phase.operationId;
    setCancelRequested(true);
    try {
      await cancelProvision(opId);
    } catch (error) {
      if (error instanceof ApiError && error.isUnauthorized) {
        onClose();
        return;
      }
      if (!(error instanceof ApiError && error.kind === "provision_not_found")) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
        setCancelRequested(false);
      }
    }
  };

  const handleEditAgain = () => {
    setSubmitError(null);
    setInvalidFields(new Set<ProvisionFieldErrorId>());
    setAttachedOperationId(null);
    reportTrackingOperation(null);
    if (provisionDraft) {
      setFormAccountContext((prev) => snapshotRef.current?.account ?? prev);
      setPhase({ kind: "form" });
      return;
    }
    const saved = attachedTracked?.submittedForm ?? null;
    if (saved) {
      setNameDraft(saved.name);
      setSuggestedName(saved.suggestedName);
      autoNameRef.current = saved.suggestedName;
      setBaseTemplate(saved.baseTemplate);
      setTemplateMeasuredRates(saved.measuredRates);
      setProvisionDraft(saved.draft);
      setRetryDelaySecs(saved.retryDelaySecs);
      setFormAccountContext(snapshotRef.current?.account ?? saved.accountContext);
      setPhase({ kind: "form" });
      return;
    }
    reloadAsCreateRef.current = true;
    setReloadSeq((seq) => seq + 1);
  };

  const events = attachedTracked?.events ?? [];
  const waitingSinceSecs = attachedTracked?.waitingSinceSecs ?? null;
  const reconnecting = Boolean(attachedTracked?.reconnecting);

  const closedByAttr = {
    closedby: submitting ? "none" : "closerequest",
  } as Record<string, string>;

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      data-dialog-kind={request ? "new_session" : undefined}
      data-dialog-phase={request ? (submitting ? "submitting" : phase.kind) : undefined}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
      {...closedByAttr}
    >
      {request && (
        <>
          <h1 id={titleId} className="dialog-title">
            {t("app.b2.new_title")}
          </h1>

          {phase.kind === "loading" && (
            <>
              <div className="dialog-body">
                <div className="busy-line" role="status" data-new-session-loading="true">
                  <span className="spinner" aria-hidden="true" />
                  <span>{t("web.sessions.template_loading")}</span>
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  {t("app.action.close")}
                </button>
              </div>
            </>
          )}

          {phase.kind === "load_error" && (
            <>
              <div className="dialog-body">
                <div className="alert alert-danger" role="alert">
                  <span className="alert-icon icon-danger">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{phase.error.message}</p>
                    {phase.error.hint && <p className="alert-body">{phase.error.hint}</p>}
                  </div>
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  {t("app.action.close")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setReloadSeq((seq) => seq + 1)}
                >
                  {t("app.action.retry")}
                </button>
              </div>
            </>
          )}

          {phase.kind === "limit" && (
            <>
              <div className="dialog-body" data-new-session-limit="true">
                {accountChanged && (
                  <div
                    className="inline-msg inline-msg-warning"
                    role="alert"
                    data-new-session-account-changed="true"
                  >
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">{t("web.sessions.account_changed")}</span>
                  </div>
                )}
                <div className="inline-msg inline-msg-warning" role="status">
                  <AlertTriangleIcon className="icon-xs icon-warning" />
                  <span className="inline-msg-text">
                    {t("app.b3.new_limit_body", {
                      limit: phase.limit,
                      email: phase.email,
                    })}
                  </span>
                </div>
                {phase.counted.length > 0 && (
                  <p className="dialog-paragraph">
                    {t("app.b3.new_limit_counted", {
                      names: phase.counted.join(t("app.fmt.list_separator")),
                    })}
                  </p>
                )}
                <p className="dialog-caption">{t("app.b3.new_limit_hint")}</p>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  {t("app.action.close")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-new-session-open-settings="true"
                  autoFocus
                  onClick={() => {
                    onClose();
                    navigate("settings");
                  }}
                >
                  {t("app.b3.new_open_settings")}
                </button>
              </div>
            </>
          )}

          {phase.kind === "form" && provisionDraft && (
            <form
              className="dialog-form"
              noValidate
              data-new-session-form="true"
              onSubmit={(event) => void handleSubmit(event)}
            >
              <div className="dialog-body">
                <p className="dialog-paragraph">{t("app.b2.new_intro")}</p>

                {accountChanged && (
                  <div
                    className="inline-msg inline-msg-warning"
                    role="alert"
                    data-new-session-account-changed="true"
                  >
                    <AlertTriangleIcon className="icon-xs icon-warning" />
                    <span className="inline-msg-text">{t("web.sessions.account_changed")}</span>
                  </div>
                )}

                {submitError && (
                  <div
                    className="alert alert-danger"
                    role="alert"
                    data-new-session-submit-error="true"
                  >
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">{submitError.message}</p>
                      {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                    </div>
                  </div>
                )}

                {invalidFields.size > 0 && (
                  <div
                    id={validationErrorId}
                    className="inline-msg inline-msg-danger"
                    role="alert"
                    data-new-session-validation-error="true"
                  >
                    <SmallAlertIcon className="icon-xs icon-danger" />
                    <span className="inline-msg-text">{t("app.err.invalid_input")}</span>
                  </div>
                )}

                <div className="field-group">
                  <label htmlFor={nameInputId} className="field-label">
                    {t("app.b2.new_name")}
                  </label>
                  <input
                    ref={nameInputRef}
                    id={nameInputId}
                    name="session_name"
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    className="input"
                    maxLength={MAX_SESSION_NAME_LEN}
                    placeholder={suggestedName || t("app.b2.new_name_placeholder")}
                    aria-invalid={invalidFields.has("name") ? "true" : undefined}
                    aria-describedby={invalidFields.has("name") ? validationErrorId : undefined}
                    data-new-session-name="true"
                    value={nameDraft}
                    disabled={submitting}
                    autoFocus
                    onChange={(event) => {
                      setNameDraft(event.target.value);
                      if (invalidFields.has("name")) {
                        setInvalidFields((prev) => {
                          const next = new Set(prev);
                          next.delete("name");
                          return next;
                        });
                      }
                      if (submitError) {
                        setSubmitError(null);
                      }
                    }}
                  />
                </div>

                <ProvisionFields
                  draft={provisionDraft}
                  invalidFields={invalidFields}
                  disabled={submitting}
                  measuredRate={measuredRate}
                  errorSummaryId={invalidFields.size > 0 ? validationErrorId : undefined}
                  locale={locale}
                  t={t}
                  onChange={handleProvisionFieldsChange}
                />
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
                  data-new-session-start="true"
                  disabled={submitting || accountChanged || blockedByActiveProvision || shuttingDown}
                >
                  {submitting ? <span className="spinner" aria-hidden="true" /> : <PlayIcon />}
                  <span>{t("app.b2.new_start")}</span>
                </button>
              </div>
            </form>
          )}

          {phase.kind === "running" && (
            <>
              <div className="dialog-body" data-new-session-running="true">
                <p className="field-label" data-new-session-headline="true">
                  {formatProvisionHeadline(events, t)}
                </p>

                <ProvisionProgress
                  events={events}
                  live={true}
                  waitingSinceSecs={waitingSinceSecs}
                  locale={locale}
                  t={t}
                />

                {reconnecting && (
                  <div className="inline-msg inline-msg-info" role="status">
                    <SmallInfoIcon className="icon-xs icon-info" />
                    <span className="inline-msg-text">{t("web.shell.reconnecting")}</span>
                  </div>
                )}

                <div className="inline-msg inline-msg-info">
                  <SmallInfoIcon className="icon-xs icon-info" />
                  <span className="inline-msg-text">{t("app.b2.new_cancel_note")}</span>
                </div>
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-new-session-hide="true"
                  onClick={onClose}
                >
                  {t("app.b2.action_hide")}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  data-new-session-cancel="true"
                  disabled={isOpCancelling}
                  onClick={() => {
                    void handleCancelProvision();
                  }}
                >
                  {isOpCancelling && <span className="spinner" aria-hidden="true" />}
                  <span>{t(isOpCancelling ? "app.b2.new_cancelling" : "app.action.cancel")}</span>
                </button>
              </div>
            </>
          )}

          {phase.kind === "ready" && (
            <>
              <div className="dialog-body" data-new-session-ready="true">
                <ProvisionProgress events={events} live={false} locale={locale} t={t} />
                <div className="inline-msg inline-msg-success" role="status">
                  <CheckCircleIcon />
                  <span className="inline-msg-text">
                    {t("app.b2.new_ready", { name: phase.outcome.name })}
                  </span>
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-primary" autoFocus onClick={onClose}>
                  {t("app.action.close")}
                </button>
              </div>
            </>
          )}

          {(phase.kind === "failed" || phase.kind === "cancelled") && (
            <>
              <div className="dialog-body" data-new-session-terminal={phase.kind}>
                {hasProvisionLines(events, locale, t) && (
                  <ProvisionProgress events={events} live={false} locale={locale} t={t} />
                )}

                {phase.kind === "failed" ? (
                  <div className="alert alert-danger" role="alert">
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">{t("app.b2.new_failed")}</p>
                      <p className="alert-body">
                        {[phase.error.message, phase.error.hint].filter(Boolean).join("\n")}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div
                    className="inline-msg inline-msg-info"
                    role="status"
                    data-provision-cancelled="true"
                  >
                    <SmallInfoIcon className="icon-xs icon-info" />
                    <span className="inline-msg-text">{t("app.b2.new_cancelled")}</span>
                  </div>
                )}
              </div>

              <div className="modal-actions">
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  {t("app.action.close")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  data-new-session-change="true"
                  onClick={handleEditAgain}
                >
                  {t("app.b2.new_change")}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </dialog>
  );
}
