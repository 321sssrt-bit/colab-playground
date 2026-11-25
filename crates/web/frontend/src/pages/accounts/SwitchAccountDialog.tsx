/**
 * Cross-page native `<dialog>` confirmation modal for switching the active
 * Google account. Runs preflight impact inspection (`GET /api/accounts/{id}/switch`),
 * lists closing forwards, managed runtimes continuing under their watchdog,
 * unmanaged runtimes without a watchdog (or unknown-listing warning), and
 * offers re-inspection when the backend reports a 409 impact-changed conflict.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import { formatDuration, useUsageClockSecs } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { AccountId, Snapshot, TrackedSession } from "../../lib/types.ts";
import {
  confirmAccountSwitch,
  formatAcceleratorLabel,
  formatApiError,
  isAccountChangeBlocked,
  isSwitchConflictError,
  isSwitchImpactEmpty,
  previewAccountSwitch,
  resolveAccountEmailLabel,
  resolveUnmanagedRuntimeLabel,
  type AccountSwitchPreview,
  type FormattedApiError,
  type SwitchTarget,
} from "./model.ts";

const MS_PER_SECOND = 1000;

type SwitchPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "preview_failed"; readonly error: FormattedApiError }
  | {
      readonly kind: "ready";
      readonly preview: AccountSwitchPreview;
      readonly previewedAtSecs: number;
      readonly confirming: boolean;
      readonly confirmError: FormattedApiError | null;
      readonly impactChanged: boolean;
    };

export interface SwitchAccountDialogProps {
  readonly target: SwitchTarget | null;
  readonly snapshot: Snapshot;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onClose: () => void;
}

function overlayLiveWatchdog(session: TrackedSession, snapshot: Snapshot): TrackedSession {
  const live = snapshot.runtimes?.runtimes.find(
    (runtime) =>
      runtime.id.account === session.account &&
      (runtime.id.name === session.name ||
        (session.endpoint !== null && runtime.id.endpoint === session.endpoint)),
  );
  if (!live?.tracked) {
    return session;
  }
  return {
    ...session,
    policy: live.tracked.policy,
    watchdog: live.tracked.watchdog,
  };
}

function hasEnforcedWatchdog(session: TrackedSession): boolean {
  const watchdog = session.watchdog;
  return (
    watchdog !== null &&
    watchdog.armed &&
    !watchdog.cancelled &&
    (watchdog.deadline !== null || watchdog.idle_timeout !== null)
  );
}

function formatWatchedSessionLine(
  session: TrackedSession,
  nowSecs: number,
  t: TranslateFn,
): string {
  const hardware = formatAcceleratorLabel(session.accelerator, t);
  const watchdog = session.watchdog;
  if (watchdog !== null && watchdog.armed && !watchdog.cancelled && watchdog.deadline !== null) {
    const remainingSecs = watchdog.deadline - nowSecs;
    if (remainingSecs >= 0) {
      return t("app.switch.session_deadline", {
        name: session.name,
        hardware,
        time: formatDuration(remainingSecs, t),
      });
    }
  }
  return t("app.switch.session", {
    name: session.name,
    hardware,
  });
}

function formatUnwatchedSessionLine(session: TrackedSession, t: TranslateFn): string {
  const hardware = formatAcceleratorLabel(session.accelerator, t);
  const base = t("app.switch.session", {
    name: session.name,
    hardware,
  });
  const watchdog = session.watchdog;
  if (watchdog?.cancelled) {
    return `${base} — ${t("app.b2.auto_stop_cancelled")}`;
  }
  const hasConfiguredAutoStop =
    session.policy.max_runtime !== null ||
    session.policy.idle_timeout !== null ||
    watchdog?.deadline !== null ||
    watchdog?.idle_timeout !== null;
  if (watchdog !== null && !watchdog.armed && hasConfiguredAutoStop) {
    return `${base} — ${t("app.b5.runtime_auto_stop_app_only")}`;
  }
  return base;
}

export function SwitchAccountDialog({
  target,
  snapshot,
  t,
  pushToast,
  onClose,
}: SwitchAccountDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  const [phase, setPhase] = useState<SwitchPhase>({ kind: "idle" });
  const nowSecs = useUsageClockSecs();

  const targetRef = useRef(target);
  targetRef.current = target;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const tRef = useRef(t);
  tRef.current = t;
  const requestSeqRef = useRef(0);
  const previewControllerRef = useRef<AbortController | null>(null);

  const abortPreview = useCallback(() => {
    previewControllerRef.current?.abort();
    previewControllerRef.current = null;
  }, []);

  const loadPreview = useCallback(
    async (accountId: AccountId) => {
      abortPreview();
      const seq = ++requestSeqRef.current;
      const controller = new AbortController();
      previewControllerRef.current = controller;
      setPhase({ kind: "loading" });

      try {
        const preview = await previewAccountSwitch(accountId, controller.signal);
        if (previewControllerRef.current === controller) {
          previewControllerRef.current = null;
        }
        if (seq !== requestSeqRef.current || targetRef.current?.id !== accountId) {
          return;
        }
        setPhase({
          kind: "ready",
          preview,
          previewedAtSecs: Math.floor(Date.now() / MS_PER_SECOND),
          confirming: false,
          confirmError: null,
          impactChanged: false,
        });
      } catch (error) {
        if (previewControllerRef.current === controller) {
          previewControllerRef.current = null;
        }
        if (seq !== requestSeqRef.current || targetRef.current?.id !== accountId) {
          return;
        }
        if (error instanceof ApiError && error.isAbort) {
          return;
        }
        setPhase({
          kind: "preview_failed",
          error: formatApiError(error, tRef.current),
        });
      }
    },
    [abortPreview],
  );

  // Sync top-layer modal visibility and kick off preflight impact inspection whenever target changes.
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
      void loadPreview(target.id);
    } else {
      requestSeqRef.current += 1;
      abortPreview();
      setPhase({ kind: "idle" });
      if (dialog.open) {
        dialog.returnValue = "";
        dialog.close();
      }
    }
  }, [abortPreview, loadPreview, target?.id]);

  useEffect(() => {
    return () => {
      requestSeqRef.current += 1;
      abortPreview();
    };
  }, [abortPreview]);

  // Dismiss cleanly if the target account becomes active or disappears externally while idle.
  useEffect(() => {
    if (target === null || snapshot.accounts === null) {
      return;
    }
    if (phaseRef.current.kind === "ready" && phaseRef.current.confirming) {
      return;
    }
    const alreadyActive = snapshot.accounts.active === target.id;
    const stillSaved = snapshot.accounts.accounts.some((account) => account.id === target.id);
    if (alreadyActive || !stillSaved) {
      onClose();
    }
  }, [onClose, snapshot.accounts, target]);

  const handleRefreshImpact = useCallback(() => {
    const current = targetRef.current;
    if (current === null) {
      return;
    }
    if (phaseRef.current.kind === "ready" && phaseRef.current.confirming) {
      return;
    }
    void loadPreview(current.id);
  }, [loadPreview]);

  const handleConfirm = useCallback(async () => {
    const currentTarget = targetRef.current;
    const currentPhase = phaseRef.current;
    const liveSnapshot = snapshotRef.current;
    if (
      currentTarget === null ||
      currentPhase.kind !== "ready" ||
      currentPhase.confirming ||
      currentPhase.impactChanged
    ) {
      return;
    }
    if (isAccountChangeBlocked(liveSnapshot) || liveSnapshot.shutting_down) {
      return;
    }

    const seq = requestSeqRef.current;
    const { preview, previewedAtSecs } = currentPhase;
    setPhase({
      kind: "ready",
      preview,
      previewedAtSecs,
      confirming: true,
      confirmError: null,
      impactChanged: false,
    });

    try {
      await confirmAccountSwitch(currentTarget.id, {
        account_context: preview.account_context,
        confirmation: preview.confirmation,
      });
      if (seq !== requestSeqRef.current || targetRef.current?.id !== currentTarget.id) {
        return;
      }
      const email = resolveAccountEmailLabel(
        currentTarget.id,
        snapshotRef.current,
        tRef.current,
        currentTarget.emailLabel,
      );
      pushToast({ tone: "success", body: tRef.current("app.switch.done", { email }) });
      void webStore.refreshSnapshot().catch(() => {});
      onClose();
    } catch (error) {
      if (seq !== requestSeqRef.current || targetRef.current?.id !== currentTarget.id) {
        return;
      }
      const conflict = isSwitchConflictError(error);
      setPhase({
        kind: "ready",
        preview,
        previewedAtSecs,
        confirming: false,
        confirmError: formatApiError(error, tRef.current),
        impactChanged: conflict,
      });
    }
  }, [onClose, pushToast]);

  const handleDialogCancel = useCallback(
    (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      const current = phaseRef.current;
      if (current.kind === "ready" && current.confirming) {
        return;
      }
      onClose();
    },
    [onClose],
  );

  const handleDialogClose = useCallback(() => {
    if (dialogRef.current) {
      dialogRef.current.returnValue = "";
    }
    const current = phaseRef.current;
    if (targetRef.current !== null && !(current.kind === "ready" && current.confirming)) {
      onClose();
    }
  }, [onClose]);

  const targetEmail =
    target !== null
      ? resolveAccountEmailLabel(target.id, snapshot, t, target.emailLabel)
      : "";
  const accountChangeBlocked = isAccountChangeBlocked(snapshot);
  const shuttingDown = snapshot.shutting_down;
  const confirming = phase.kind === "ready" && phase.confirming;
  const confirmDisabled =
    phase.kind !== "ready" ||
    confirming ||
    phase.impactChanged ||
    accountChangeBlocked ||
    shuttingDown;
  const confirmTitle = accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined;

  const effectiveNowSecs =
    phase.kind === "ready" ? Math.max(phase.previewedAtSecs, nowSecs) : nowSecs;
  const managedSessions =
    phase.kind === "ready"
      ? phase.preview.impact.sessions_left_running.map((session) =>
          overlayLiveWatchdog(session, snapshot),
        )
      : [];
  const watchedSessions = managedSessions.filter(hasEnforcedWatchdog);
  const unwatchedSessions = managedSessions.filter((session) => !hasEnforcedWatchdog(session));

  return (
    <dialog
      ref={dialogRef}
      className="modal-dialog"
      aria-labelledby={titleId}
      onCancel={handleDialogCancel}
      onClose={handleDialogClose}
    >
      <h1 id={titleId} className="dialog-title">
        {t("app.switch.title", { email: targetEmail })}
      </h1>

      <div className="dialog-body">
        {phase.kind === "loading" && (
          <div className="busy-line" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{t("app.switch.loading")}</span>
          </div>
        )}

        {phase.kind === "preview_failed" && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{phase.error.message}</p>
              {phase.error.hint && <p className="alert-body">{phase.error.hint}</p>}
            </div>
          </div>
        )}

        {phase.kind === "ready" && (
          <>
            {isSwitchImpactEmpty(phase.preview.impact) ? (
              <p className="dialog-paragraph">{t("app.switch.nothing")}</p>
            ) : (
              <div className="impact-list">
                {phase.preview.impact.tunnels_closing.length > 0 && (
                  <div className="impact-group">
                    <p className="dialog-paragraph">{t("app.switch.tunnels")}</p>
                    <ul className="impact-items">
                      {phase.preview.impact.tunnels_closing.map((tunnel) => (
                        <li key={tunnel.id}>
                          {t("app.switch.tunnel", {
                            local: tunnel.spec.local_port,
                            session: tunnel.spec.session,
                            remote: tunnel.spec.remote_port,
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {watchedSessions.length > 0 && (
                  <div className="impact-group">
                    <p className="dialog-paragraph">{t("app.switch.sessions")}</p>
                    <ul className="impact-items">
                      {watchedSessions.map((session) => (
                        <li key={`${session.account}:${session.name}`}>
                          {formatWatchedSessionLine(session, effectiveNowSecs, t)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {unwatchedSessions.length > 0 && (
                  <div className="impact-group">
                    <p className="dialog-paragraph">
                      {unwatchedSessions.length === 1
                        ? t("app.b2.quit_unwatched_one")
                        : t("app.b2.quit_unwatched_many", { count: unwatchedSessions.length })}
                    </p>
                    <ul className="impact-items">
                      {unwatchedSessions.map((session) => (
                        <li key={`${session.account}:${session.name}`}>
                          {formatUnwatchedSessionLine(session, t)}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {phase.preview.impact.unmanaged_left_running === null ? (
                  <div className="inline-msg inline-msg-warning" role="status">
                    <AlertIcon />
                    <span className="inline-msg-text">
                      {t("app.b10.switch_unmanaged_unknown")}
                    </span>
                  </div>
                ) : (
                  phase.preview.impact.unmanaged_left_running.length > 0 && (
                    <div className="impact-group">
                      <p className="dialog-paragraph">{t("app.b3.switch_unmanaged")}</p>
                      <ul className="impact-items">
                        {phase.preview.impact.unmanaged_left_running.map((runtimeRef) => (
                          <li key={`${runtimeRef.account}:${runtimeRef.endpoint}`}>
                            {t("app.b3.switch_unmanaged_item", {
                              name: resolveUnmanagedRuntimeLabel(runtimeRef, snapshot),
                            })}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                )}
              </div>
            )}

            {!confirming && accountChangeBlocked && (
              <div className="alert alert-warning" role="alert">
                <span className="alert-icon icon-warning">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-body">{t("app.b2.account_change_blocked")}</p>
                </div>
              </div>
            )}

            {phase.confirmError !== null && (
              <div
                className={phase.impactChanged ? "alert alert-warning" : "alert alert-danger"}
                role="alert"
              >
                <span
                  className={
                    phase.impactChanged ? "alert-icon icon-warning" : "alert-icon icon-danger"
                  }
                >
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{phase.confirmError.message}</p>
                  {phase.confirmError.hint && (
                    <p className="alert-body">{phase.confirmError.hint}</p>
                  )}
                  {phase.impactChanged && (
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={shuttingDown}
                        onClick={handleRefreshImpact}
                      >
                        {t("web.switch.review_again")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="modal-actions">
        <button
          ref={cancelButtonRef}
          type="button"
          className="btn"
          autoFocus
          disabled={confirming}
          onClick={onClose}
        >
          {t("app.action.cancel")}
        </button>

        {phase.kind === "preview_failed" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={shuttingDown}
            onClick={handleRefreshImpact}
          >
            {t("web.switch.review_again")}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirmDisabled}
            title={confirmTitle}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {confirming && <span className="spinner" aria-hidden="true" />}
            <span>{t("app.switch.confirm")}</span>
          </button>
        )}
      </div>
    </dialog>
  );
}
