/**
 * Sessions route entry module: cross-account Managed and Unmanaged runtime groups,
 * focus-preserving 15-second uptime and auto-stop countdowns, Guard warnings and
 * polling errors, native Auto-stop dialogs, mounted Forwards, in-flight creation
 * summary, and Recently ended history.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AlertIcon, SessionsIcon } from "../components/Icons.tsx";
import { appDataStore, useAppDataStore } from "../lib/appCache.ts";
import { forwardsStore, selectRuntimeForwards, useForwardsStore } from "../lib/forwards.ts";
import { stopDialogsStore } from "../lib/stopDialogs.ts";
import { webStore } from "../lib/store.ts";
import type { GuardDecision, Runtime } from "../lib/types.ts";
import {
  SwitchAccountDialog,
  type SwitchAccountDialogProps,
} from "./accounts/SwitchAccountDialog.tsx";
import {
  AutoStopDialog,
  type AutoStopDialogMode,
  type AutoStopDialogRequest,
} from "./sessions/AutoStopDialog.tsx";
import { EndedCard } from "./sessions/EndedCard.tsx";
import {
  ForwardDialog,
  type ForwardDialogRequest,
} from "./sessions/ForwardDialog.tsx";
import {
  formatEmail,
  formatErrorKind,
  formatErrorMessage,
  groupRuntimesByAccount,
  isSessionsEnvironmentReady,
  runtimeKey,
} from "./sessions/format.ts";
import { AlertTriangleIcon, CircleStopIcon, PlusIcon, RefreshIcon } from "./sessions/Icons.tsx";
import {
  NewSessionDialog,
  type NewSessionDialogRequest,
} from "./sessions/NewSessionDialog.tsx";
import { ProvisioningCard } from "./sessions/ProvisioningCard.tsx";
import { RuntimeCard } from "./sessions/RuntimeCard.tsx";
import { stopTargetFromRuntime } from "./sessions/StopRuntimeDialog.tsx";
import {
  clearEndedRuntimes,
  refreshRearmDuration,
  useSessionsLocalState,
} from "./sessions/store.ts";
import type { PageProps } from "./types.ts";

type SwitchAccountTarget = NonNullable<SwitchAccountDialogProps["target"]>;

export function SessionsPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const localState = useSessionsLocalState();
  const appData = useAppDataStore();
  const forwardsState = useForwardsStore();
  const [autoStopDialog, setAutoStopDialog] = useState<AutoStopDialogRequest | null>(null);
  const [forwardDialog, setForwardDialog] = useState<ForwardDialogRequest | null>(null);
  const [newSessionDialog, setNewSessionDialog] = useState<NewSessionDialogRequest | null>(null);
  const [switchTarget, setSwitchTarget] = useState<SwitchAccountTarget | null>(null);

  const dialogSeqRef = useRef(0);

  const loadSessions = useCallback(async () => {
    try {
      await appDataStore.refreshSessions();
      void forwardsStore.refresh().catch(() => {});
    } catch {
      // Failure state is captured in `appDataStore.sessionsError`.
    }
  }, []);

  const refreshing = appData.sessionsRefreshing;
  const refreshError = useMemo(
    () => (appData.sessionsError !== null ? formatErrorMessage(appData.sessionsError, t) : null),
    [appData.sessionsError, t],
  );
  const accountErrorsOverride = appData.sessionsAccountErrors;

  const accounts = snapshot?.accounts?.accounts ?? null;
  const environmentReady = isSessionsEnvironmentReady(
    snapshot,
    appData.overview !== null ? appData.overview.cli_installed : null,
  );

  useEffect(() => {
    if (snapshot === null || !environmentReady) {
      setSwitchTarget(null);
      setAutoStopDialog(null);
      setForwardDialog(null);
      setNewSessionDialog((prev) => (prev?.mode === "running" ? prev : null));
    }
  }, [snapshot, environmentReady]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshRearmDuration(controller.signal).catch(() => {});
    return () => {
      controller.abort();
    };
  }, []);

  // Only list runtimes on mount when the live snapshot does not already hold them.
  const needsInitialSessions =
    environmentReady &&
    snapshot !== null &&
    snapshot.runtimes === null &&
    snapshot.runtimes_error === null;

  useEffect(() => {
    if (needsInitialSessions) {
      void appDataStore.ensureSessions().catch(() => {});
    }
  }, [needsInitialSessions]);

  const runtimesView = snapshot?.runtimes ?? null;
  const runtimesError = snapshot?.runtimes_error ?? null;
  const operations = snapshot?.operations ?? [];

  const activeProvisionOp = useMemo(() => {
    for (const op of operations) {
      if (op.operation.kind === "provision") {
        return { op, sessionName: op.operation.session };
      }
    }
    return null;
  }, [operations]);

  const guardDecisionMap = useMemo(() => {
    const map = new Map<string, GuardDecision>();
    const decisions = snapshot?.guard?.decisions ?? [];
    for (const decision of decisions) {
      map.set(runtimeKey(decision.session), decision);
    }
    return map;
  }, [snapshot?.guard?.decisions]);

  const stoppingKeys = useMemo(() => {
    const set = new Set<string>();
    for (const entry of operations) {
      if (entry.operation.kind === "domain" && entry.operation.name === "stop_runtime") {
        set.add(entry.operation.key);
      }
    }
    return set;
  }, [operations]);

  const autoStopBusyKeys = useMemo(() => {
    const set = new Set<string>();
    for (const entry of operations) {
      if (entry.operation.kind === "domain" && entry.operation.name === "auto_stop") {
        set.add(entry.operation.key);
      }
    }
    return set;
  }, [operations]);

  const stopAllRunning = useMemo(
    () =>
      operations.some(
        (entry) =>
          entry.operation.kind === "domain" && entry.operation.name === "stop_all_runtimes",
      ),
    [operations],
  );

  const openStopRuntimeModal = useCallback((runtime: Runtime) => {
    stopDialogsStore.openStopRuntime(stopTargetFromRuntime(runtime));
  }, []);

  const openStopAllModal = useCallback(() => {
    stopDialogsStore.openStopAll();
  }, []);

  const trackedProvision = localState.trackedProvision;

  const runningProvisionCardTarget = activeProvisionOp
    ? { op: activeProvisionOp.op, sessionName: activeProvisionOp.sessionName }
    : trackedProvision?.phase === "running"
      ? { op: null, sessionName: trackedProvision.sessionName }
      : null;

  const openNewSessionModal = useCallback(() => {
    dialogSeqRef.current += 1;
    if (activeProvisionOp) {
      setNewSessionDialog({
        id: dialogSeqRef.current,
        mode: "running",
        operationId: activeProvisionOp.op.id,
        sessionName: activeProvisionOp.sessionName,
      });
      return;
    }
    if (
      trackedProvision &&
      !trackedProvision.dismissed &&
      (trackedProvision.phase === "running" ||
        trackedProvision.phase === "failed" ||
        trackedProvision.phase === "cancelled")
    ) {
      setNewSessionDialog({
        id: dialogSeqRef.current,
        mode: "running",
        operationId: trackedProvision.operationId,
        sessionName: trackedProvision.sessionName,
      });
      return;
    }
    if (!snapshot) {
      return;
    }
    const ctx = snapshot.account;
    setNewSessionDialog({
      id: dialogSeqRef.current,
      mode: "create",
      accountContext: { revision: ctx.revision, active: ctx.active },
    });
  }, [activeProvisionOp, trackedProvision, snapshot]);

  const handleDialogTrackingOperation = useCallback(() => {}, []);

  const openAutoStopModal = useCallback(
    (runtime: Runtime, mode: AutoStopDialogMode) => {
      if (!snapshot) {
        return;
      }
      const ctx = snapshot.account;
      dialogSeqRef.current += 1;
      setAutoStopDialog({
        id: dialogSeqRef.current,
        mode,
        runtime,
        accountContext: { revision: ctx.revision, active: ctx.active },
        defaultSeconds: appData.rearmDurationSecs,
      });
    },
    [snapshot, appData.rearmDurationSecs],
  );

  const openForwardModal = useCallback(
    (runtime: Runtime) => {
      if (!snapshot || !runtime.on_active_account || !runtime.id.name) {
        return;
      }
      const ctx = snapshot.account;
      dialogSeqRef.current += 1;
      setForwardDialog({
        id: dialogSeqRef.current,
        runtime,
        accountContext: { revision: ctx.revision, active: ctx.active },
      });
      if (appData.overview === null) {
        void appDataStore.ensureOverview().catch(() => {});
      }
    },
    [snapshot, appData.overview],
  );

  const handleExtendAutoStop = useCallback(
    (runtime: Runtime) => openAutoStopModal(runtime, "extend"),
    [openAutoStopModal],
  );

  const handleSetAutoStop = useCallback(
    (runtime: Runtime) => openAutoStopModal(runtime, "set"),
    [openAutoStopModal],
  );

  const handleCancelAutoStop = useCallback(
    (runtime: Runtime) => openAutoStopModal(runtime, "cancel"),
    [openAutoStopModal],
  );

  const handleSwitchAccount = useCallback(
    (runtime: Runtime) => {
      const matched = accounts?.find((item) => item.id === runtime.id.account) ?? null;
      setSwitchTarget({
        id: runtime.id.account,
        emailLabel: formatEmail(runtime.account_email ?? matched?.email, t),
      });
    },
    [accounts, t],
  );

  const handleCloseSwitchDialog = useCallback(() => {
    setSwitchTarget(null);
  }, []);

  const handleRetryForwardPolicy = useCallback(() => {
    void appDataStore.refreshOverview().catch(() => {});
  }, []);

  const handleForwardChanged = useCallback(() => {
    void forwardsStore.refresh().catch(() => {});
    void webStore.refreshSnapshot().catch(() => {});
  }, []);

  const forwardDialogForwards = useMemo(() => {
    if (!forwardDialog || !snapshot) {
      return [];
    }
    return selectRuntimeForwards(forwardDialog.runtime, forwardsState, snapshot);
  }, [forwardDialog, forwardsState, snapshot]);

  // Single-stop, auto-stop, and stop-all already publish updated runtimes into the
  // backend Snapshot; converge via `/api/snapshot` instead of re-listing `/api/sessions`.
  const handleRuntimeMutationCompleted = useCallback(() => {
    void webStore.refreshSnapshot().catch(() => {});
  }, []);

  const findAccountEmail = (accountId: string): string => {
    const matched = accounts?.find((item) => item.id === accountId) ?? null;
    return formatEmail(matched?.email, t);
  };

  const groups = useMemo(
    () => (runtimesView ? groupRuntimesByAccount(runtimesView.runtimes) : []),
    [runtimesView],
  );

  const displayAccountErrors = useMemo(() => {
    if (accountErrorsOverride && accountErrorsOverride.length > 0) {
      return accountErrorsOverride.map((failure) => ({
        account: failure.account,
        formatted: formatErrorMessage(failure.error, t),
      }));
    }
    return (runtimesView?.errors ?? []).map((failure) => ({
      account: failure.account,
      formatted: formatErrorMessage(failure.error, t),
    }));
  }, [accountErrorsOverride, runtimesView?.errors, t]);

  const listErrorBody = refreshError
    ? [refreshError.message, refreshError.hint].filter(Boolean).join("\n")
    : runtimesError
      ? formatErrorKind(runtimesError, t)
      : null;

  return (
    <>
      <header className="page-header page-header-row">
        <div className="page-header-heading">
          <h1 className="page-title">{t("app.nav.sessions")}</h1>
          <p className="page-subtitle">{t("app.sessions.subtitle")}</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            data-sessions-refresh="true"
            aria-label={t("app.b2.sessions_refresh")}
            title={t("app.b2.sessions_refresh")}
            disabled={!environmentReady || refreshing}
            onClick={() => {
              void loadSessions();
            }}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="btn"
            data-sessions-stop-all="true"
            disabled={!environmentReady || Boolean(snapshot?.shutting_down) || stopAllRunning}
            onClick={openStopAllModal}
          >
            {stopAllRunning ? <span className="spinner" aria-hidden="true" /> : <CircleStopIcon />}
            <span>{t("web.sessions.stop_all")}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-sessions-new="true"
            disabled={!environmentReady || Boolean(snapshot?.shutting_down)}
            onClick={openNewSessionModal}
          >
            <PlusIcon />
            <span>{t("app.b2.new_title")}</span>
          </button>
        </div>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.b2.sessions_loading")}</span>
            </div>
          </section>
        ) : !environmentReady ? (
          <section className="card">
            <div className="empty-state">
              <div className="empty-state-disc">
                <SessionsIcon />
              </div>
              <div className="empty-state-words">
                <h2 className="empty-state-title">{t("app.b2.sessions_setup_title")}</h2>
                <p className="empty-state-body">{t("app.b2.sessions_setup_body")}</p>
              </div>
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn"
                  data-sessions-setup-overview="true"
                  onClick={() => navigate("overview")}
                >
                  {t("app.b2.sessions_setup_action")}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <>
            {runningProvisionCardTarget && !newSessionDialog && (
              <ProvisioningCard
                operation={runningProvisionCardTarget.op}
                trackedProvision={trackedProvision}
                sessionName={runningProvisionCardTarget.sessionName}
                locale={locale}
                t={t}
                pushToast={pushToast}
                onShowDialog={openNewSessionModal}
              />
            )}

            {snapshot.guard_error && (
              <div className="inline-msg inline-msg-warning" role="status" data-guard-error="true">
                <AlertTriangleIcon className="icon-xs icon-warning" />
                <span className="inline-msg-text">
                  {t("app.b2.guard_round_failed", {
                    why: formatErrorKind(snapshot.guard_error, t),
                  })}
                </span>
              </div>
            )}

            {listErrorBody && (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{t("app.b2.sessions_failed")}</p>
                  <p className="alert-body">{listErrorBody}</p>
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={refreshing}
                      onClick={() => {
                        void loadSessions();
                      }}
                    >
                      {t("app.action.retry")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {runtimesView === null ? (
              !listErrorBody && (
                <section className="card">
                  <div className="busy-line">
                    <span className="spinner" aria-hidden="true" />
                    <span>{t("app.b2.sessions_loading")}</span>
                  </div>
                </section>
              )
            ) : (
              <>
                {displayAccountErrors.map((failure) => {
                  const body = [failure.formatted.message, failure.formatted.hint]
                    .filter(Boolean)
                    .join("\n");
                  return (
                    <div
                      className="alert alert-danger"
                      role="alert"
                      key={failure.account}
                      data-account-error={failure.account}
                    >
                      <span className="alert-icon icon-danger">
                        <AlertIcon />
                      </span>
                      <div className="alert-text">
                        <p className="alert-title">
                          {t("app.b2.sessions_account_failed", {
                            email: findAccountEmail(failure.account),
                          })}
                        </p>
                        {body && <p className="alert-body">{body}</p>}
                      </div>
                    </div>
                  );
                })}

                {runtimesView.runtimes.length === 0 ? (
                  <section className="card">
                    <div className="empty-state">
                      <div className="empty-state-disc">
                        <SessionsIcon />
                      </div>
                      <div className="empty-state-words">
                        <h2 className="empty-state-title">
                          {displayAccountErrors.length === 0
                            ? t("app.sessions.empty.title")
                            : t("app.b10.sessions_empty_partial_title")}
                        </h2>
                        <p className="empty-state-body">{t("app.sessions.empty.body")}</p>
                      </div>
                      <div className="empty-state-actions">
                        <button
                          type="button"
                          className="btn btn-primary"
                          data-sessions-empty-new="true"
                          disabled={Boolean(snapshot?.shutting_down)}
                          onClick={openNewSessionModal}
                        >
                          <PlusIcon />
                          <span>{t("app.b2.new_title")}</span>
                        </button>
                      </div>
                    </div>
                  </section>
                ) : (
                  <>
                    <p className="caption">{t("app.b3.sessions_estimate_note")}</p>
                    {groups.map((group) => {
                      const email = formatEmail(group.email, t);
                      const heading = group.active
                        ? t("app.b2.sessions_group_active", { email })
                        : t("app.b2.sessions_group", { email });
                      const countText =
                        group.runtimes.length === 1
                          ? t("app.b2.sessions_count_one")
                          : t("app.b2.sessions_count_many", { count: group.runtimes.length });

                      return (
                        <section
                          className="session-group"
                          key={group.account}
                          data-session-group={group.account}
                        >
                          <div className="session-group-header">
                            <h2 className="session-group-title">{heading}</h2>
                            <span className="caption">{countText}</span>
                          </div>
                          <div className="session-group-list">
                            {group.runtimes.map((runtime) => {
                              const key = runtimeKey(runtime.id);
                              return (
                                <RuntimeCard
                                  key={key}
                                  runtime={runtime}
                                  guardDecision={guardDecisionMap.get(key) ?? null}
                                  forwards={selectRuntimeForwards(
                                    runtime,
                                    forwardsState,
                                    snapshot,
                                  )}
                                  rearmDurationSecs={appData.rearmDurationSecs}
                                  stopping={stoppingKeys.has(key)}
                                  autoStopBusy={autoStopBusyKeys.has(key)}
                                  locale={locale}
                                  t={t}
                                  pushToast={pushToast}
                                  onExtendAutoStop={handleExtendAutoStop}
                                  onSetAutoStop={handleSetAutoStop}
                                  onCancelAutoStop={handleCancelAutoStop}
                                  onSwitchAccount={handleSwitchAccount}
                                  onForwardClosed={handleForwardChanged}
                                  onRequestStop={openStopRuntimeModal}
                                  onRequestForward={openForwardModal}
                                />
                              );
                            })}
                          </div>
                        </section>
                      );
                    })}
                  </>
                )}
              </>
            )}

            <EndedCard
              items={localState.ended}
              locale={locale}
              t={t}
              onClear={clearEndedRuntimes}
            />
          </>
        )}
      </div>

      <AutoStopDialog
        request={autoStopDialog}
        currentAccountContext={snapshot?.account ?? null}
        t={t}
        pushToast={pushToast}
        onClose={() => setAutoStopDialog(null)}
        onCompleted={handleRuntimeMutationCompleted}
      />

      <ForwardDialog
        request={forwardDialog}
        currentAccountContext={snapshot?.account ?? null}
        forwardPolicy={appData.overview?.forward_policy ?? null}
        forwardPolicyLoading={appData.overviewLoading}
        forwardPolicyError={appData.overviewError}
        existingForwards={forwardDialogForwards}
        t={t}
        pushToast={pushToast}
        onClose={() => setForwardDialog(null)}
        onForwardChanged={handleForwardChanged}
        onRetryForwardPolicy={handleRetryForwardPolicy}
      />

      <NewSessionDialog
        request={newSessionDialog}
        snapshot={snapshot}
        maxConcurrentSessions={appData.maxConcurrentSessions}
        activeProvisionOp={activeProvisionOp}
        trackedProvision={trackedProvision}
        locale={locale}
        t={t}
        navigate={navigate}
        pushToast={pushToast}
        onClose={() => setNewSessionDialog(null)}
        onTrackingOperation={handleDialogTrackingOperation}
      />

      {snapshot && (
        <SwitchAccountDialog
          target={switchTarget}
          snapshot={snapshot}
          t={t}
          pushToast={pushToast}
          onClose={handleCloseSwitchDialog}
        />
      )}
    </>
  );
}
