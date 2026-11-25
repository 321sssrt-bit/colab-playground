/**
 * Sessions route entry module: cross-account Managed and Unmanaged runtime groups,
 * focus-preserving 15-second uptime and auto-stop countdowns, Guard warnings and
 * polling errors, native Auto-stop dialogs, mounted Forwards, in-flight creation
 * summary, and Recently ended history.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AlertIcon, SessionsIcon } from "../components/Icons.tsx";
import { ApiError } from "../lib/api.ts";
import { webStore } from "../lib/store.ts";
import type { GuardDecision, Runtime, Snapshot } from "../lib/types.ts";
import { fetchSessions, type AccountFailureResponse } from "./sessions/api.ts";
import {
  AutoStopDialog,
  type AutoStopDialogMode,
  type AutoStopDialogRequest,
} from "./sessions/AutoStopDialog.tsx";
import { syncServerClock } from "./sessions/clock.tsx";
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
  runtimeKey,
  type FormattedError,
} from "./sessions/format.ts";
import { AlertTriangleIcon, CircleStopIcon, RefreshIcon } from "./sessions/Icons.tsx";
import { ProvisioningCard } from "./sessions/ProvisioningCard.tsx";
import { RuntimeCard } from "./sessions/RuntimeCard.tsx";
import { StopAllDialog } from "./sessions/StopAllDialog.tsx";
import {
  StopRuntimeDialog,
  stopTargetFromRuntime,
  type StopRuntimeDialogRequest,
} from "./sessions/StopRuntimeDialog.tsx";
import {
  applyForwardEvent,
  clearEndedRuntimes,
  observeSnapshotTransitions,
  refreshForwards,
  refreshOverviewHints,
  refreshRearmDuration,
  selectForwardsForRuntime,
  useSessionsLocalState,
} from "./sessions/store.ts";
import type { PageProps } from "./types.ts";

export function SessionsPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const localState = useSessionsLocalState();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<FormattedError | null>(null);
  const [accountErrorsOverride, setAccountErrorsOverride] = useState<
    readonly AccountFailureResponse[] | null
  >(null);
  const [autoStopDialog, setAutoStopDialog] = useState<AutoStopDialogRequest | null>(null);
  const [forwardDialog, setForwardDialog] = useState<ForwardDialogRequest | null>(null);
  const [stopRuntimeDialog, setStopRuntimeDialog] = useState<StopRuntimeDialogRequest | null>(null);
  const [stopAllDialogId, setStopAllDialogId] = useState<number | null>(null);

  const prevSnapshotRef = useRef<Snapshot | null>(null);
  const dialogSeqRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  const loadSessions = useCallback(async () => {
    if (refreshInFlightRef.current) {
      return;
    }
    refreshInFlightRef.current = true;
    setRefreshing(true);
    try {
      const response = await fetchSessions();
      syncServerClock(response.sampled_at);
      setRefreshError(null);
      setAccountErrorsOverride(response.errors);
      void webStore.refreshSnapshot().catch(() => {});
      void refreshForwards().catch(() => {});
    } catch (error) {
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        setRefreshError(formatErrorMessage(error, tRef.current));
      }
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSessions();
    void refreshForwards(controller.signal).catch(() => {});
    void refreshRearmDuration(controller.signal).catch(() => {});
    void refreshOverviewHints(controller.signal).catch(() => {});
    return () => {
      controller.abort();
    };
  }, [loadSessions]);

  useEffect(() => {
    return webStore.subscribeForwards((event) => {
      applyForwardEvent(event);
    });
  }, []);

  const tunnelAddressSignature = useMemo(() => {
    const tunnels = snapshot?.tunnels ?? [];
    return tunnels
      .map((item) => `${item.id}:${item.spec.bind}:${item.spec.local_port}:${item.spec.remote_port}`)
      .join(",");
  }, [snapshot?.tunnels]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    void refreshForwards().catch(() => {});
  }, [tunnelAddressSignature, Boolean(snapshot)]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (snapshot.runtimes && snapshot.runtimes.errors.length === 0) {
      setAccountErrorsOverride(null);
    }
    observeSnapshotTransitions(prevSnapshotRef.current, snapshot, locale, t, pushToast);
    prevSnapshotRef.current = snapshot;
  }, [snapshot, localState.reconcileSeq, locale, t, pushToast]);

  const accounts = snapshot?.accounts?.accounts ?? null;
  const cliReady =
    localState.cliInstalled !== null
      ? localState.cliInstalled
      : snapshot?.accounts_error !== "not_installed";
  const hasSavedAccounts = accounts === null ? true : accounts.length > 0;
  const environmentReady = snapshot !== null && cliReady && hasSavedAccounts;

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
    dialogSeqRef.current += 1;
    setStopRuntimeDialog({
      id: dialogSeqRef.current,
      ...stopTargetFromRuntime(runtime),
    });
  }, []);

  const openStopAllModal = useCallback(() => {
    dialogSeqRef.current += 1;
    setStopAllDialogId(dialogSeqRef.current);
  }, []);

  const openAutoStopModal = useCallback(
    (runtime: Runtime, mode: AutoStopDialogMode) => {
      const ctx = snapshot?.account ?? { revision: 0, active: null };
      dialogSeqRef.current += 1;
      setAutoStopDialog({
        id: dialogSeqRef.current,
        mode,
        runtime,
        accountContext: { revision: ctx.revision, active: ctx.active },
        defaultSeconds: localState.rearmDurationSecs,
      });
    },
    [snapshot?.account, localState.rearmDurationSecs],
  );

  const openForwardModal = useCallback(
    (runtime: Runtime) => {
      if (!runtime.on_active_account || !runtime.id.name) {
        return;
      }
      const ctx = snapshot?.account ?? { revision: 0, active: null };
      dialogSeqRef.current += 1;
      setForwardDialog({
        id: dialogSeqRef.current,
        runtime,
        accountContext: { revision: ctx.revision, active: ctx.active },
      });
      if (localState.forwardPolicy === null) {
        void refreshOverviewHints().catch(() => {});
      }
    },
    [snapshot?.account, localState.forwardPolicy],
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

  const handleSwitchAccount = useCallback(() => {
    navigate("accounts");
  }, [navigate]);

  const handleForwardChanged = useCallback(() => {
    void refreshForwards().catch(() => {});
    void webStore.refreshSnapshot().catch(() => {});
  }, []);

  const forwardDialogForwards = useMemo(() => {
    if (!forwardDialog || !snapshot) {
      return [];
    }
    return selectForwardsForRuntime(forwardDialog.runtime, localState, snapshot);
  }, [forwardDialog, localState, snapshot]);

  const handleAutoStopCompleted = useCallback(() => {
    void loadSessions();
  }, [loadSessions]);

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
            {activeProvisionOp && (
              <ProvisioningCard
                operation={activeProvisionOp.op}
                sessionName={activeProvisionOp.sessionName}
                locale={locale}
                t={t}
                pushToast={pushToast}
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
                                  forwards={selectForwardsForRuntime(
                                    runtime,
                                    localState,
                                    snapshot,
                                  )}
                                  rearmDurationSecs={localState.rearmDurationSecs}
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
        onCompleted={handleAutoStopCompleted}
      />

      <ForwardDialog
        request={forwardDialog}
        currentAccountContext={snapshot?.account ?? null}
        forwardPolicy={localState.forwardPolicy}
        existingForwards={forwardDialogForwards}
        t={t}
        pushToast={pushToast}
        onClose={() => setForwardDialog(null)}
        onForwardChanged={handleForwardChanged}
      />

      <StopRuntimeDialog
        request={stopRuntimeDialog}
        t={t}
        pushToast={pushToast}
        onClose={() => setStopRuntimeDialog(null)}
        onStopped={handleAutoStopCompleted}
      />

      <StopAllDialog
        openId={stopAllDialogId}
        snapshot={snapshot}
        t={t}
        pushToast={pushToast}
        onClose={() => setStopAllDialogId(null)}
        onCompleted={handleAutoStopCompleted}
      />
    </>
  );
}
