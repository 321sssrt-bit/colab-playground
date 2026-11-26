/**
 * Accounts page: environment/keyring readiness diagnostics, multi-account usage
 * totals with manual refresh, unmanaged runtime warnings, per-account cards,
 * pending-account adoption, OAuth sign-in dialog, and remove-account protection.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { AccountsIcon, AlertIcon, CloseIcon, InfoIcon } from "../components/Icons.tsx";
import { appDataStore, isAccountChangeBlocked, useAppDataStore } from "../lib/appCache.ts";
import {
  formatCu,
  formatCuRate,
  formatRelativeAge,
  useUsageClockSecs,
} from "../lib/format.ts";
import { webStore } from "../lib/store.ts";
import { RefreshIcon, TerminalIcon, TrashIcon, UserPlusIcon } from "./accounts/Icons.tsx";
import {
  buildAccountRows,
  buildUnmanagedWarning,
  computeAccountsTotals,
  formatAccountTimeLeft,
  formatApiError,
  formatCoreError,
  formatErrorKind,
  resolveAccountsGate,
  type SwitchTarget,
} from "./accounts/model.ts";
import { RemoveAccountDialog, type RemoveTarget } from "./accounts/RemoveAccountDialog.tsx";
import type { PageProps } from "./types.ts";

export interface AccountsPageProps extends PageProps {
  readonly onRequestSwitchAccount: (target: SwitchTarget) => void;
  readonly onRequestAddAccount: () => void;
  readonly addAccountDialogOpen: boolean;
}

export function AccountsPage({
  snapshot,
  locale,
  t,
  navigate,
  pushToast,
  onRequestSwitchAccount,
  onRequestAddAccount,
  addAccountDialogOpen,
}: AccountsPageProps) {
  const idPrefix = useId();
  const nowSecs = useUsageClockSecs();
  const appData = useAppDataStore();

  const [recoveredVisible, setRecoveredVisible] = useState(false);
  const [recoveredDismissed, setRecoveredDismissed] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [removingAccount, setRemovingAccount] = useState(false);

  const needsOverviewDiagnostics =
    snapshot !== null &&
    ((snapshot.accounts === null && snapshot.accounts_error === null) ||
      snapshot.accounts_error === "keyring_unavailable");

  useEffect(() => {
    if (needsOverviewDiagnostics) {
      void appDataStore.ensureOverview().catch(() => {});
    }
  }, [needsOverviewDiagnostics]);

  const handleCheckEnvironmentAgain = useCallback(async () => {
    try {
      await appDataStore.refreshOverview();
    } catch {
      // Failure state is captured in `appDataStore`.
    }
    try {
      await webStore.refreshSnapshot();
    } catch {
      // SSE reconnect banner surfaces transport failures.
    }
  }, []);

  const handleRefreshUsage = useCallback(async () => {
    try {
      await appDataStore.refreshUsage();
    } catch {
      // Failure state is captured in `appDataStore.usageRefreshError`.
    }
  }, []);

  const handleAdoptAccount = useCallback(async () => {
    try {
      await appDataStore.adoptAccount();
    } catch {
      // Failure state is captured in `appDataStore.adoptError`.
    }
  }, []);

  const diagnostics = appData.overview;
  const diagnosticsLoading = appData.overviewLoading;
  const refreshingUsage = appData.refreshingUsage;
  const adopting = appData.adopting;
  const usageRefreshError = useMemo(
    () =>
      appData.usageRefreshError !== null ? formatApiError(appData.usageRefreshError, t) : null,
    [appData.usageRefreshError, t],
  );
  const adoptError = useMemo(
    () => (appData.adoptError !== null ? formatApiError(appData.adoptError, t) : null),
    [appData.adoptError, t],
  );

  const gate = useMemo(
    () => resolveAccountsGate(snapshot, diagnostics),
    [diagnostics, snapshot],
  );

  const accountChangeBlocked = isAccountChangeBlocked(snapshot, appData);
  const shuttingDown = snapshot?.shutting_down === true;
  const canAdd = gate.kind === "ready" && !accountChangeBlocked && !shuttingDown;
  const addDisabledTitle =
    gate.kind === "ready" && accountChangeBlocked
      ? t("app.b2.account_change_blocked")
      : undefined;

  const rows = useMemo(() => {
    if (gate.kind !== "ready" || snapshot === null) {
      return [];
    }
    return buildAccountRows(gate.accounts, snapshot, nowSecs, t);
  }, [gate, nowSecs, snapshot, t]);

  const totals = useMemo(() => computeAccountsTotals(rows), [rows]);
  const unmanagedWarning = useMemo(() => buildUnmanagedWarning(rows, t), [rows, t]);

  // Latch the one-shot server recovery flag so a subsequent background poll does not hide it.
  useEffect(() => {
    if (gate.kind === "ready" && gate.accounts.recovered_pending_add && !recoveredDismissed) {
      setRecoveredVisible(true);
    }
  }, [gate, recoveredDismissed]);

  // Clear remove target if the account disappears while idle (not mid-confirm, so the
  // in-flight remove handler can still finish its success toast cleanly).
  useEffect(() => {
    if (removeTarget === null || removingAccount || gate.kind !== "ready") {
      return;
    }
    const stillExists = gate.accounts.accounts.some((account) => account.id === removeTarget.id);
    if (!stillExists) {
      setRemoveTarget(null);
    }
  }, [gate, removeTarget, removingAccount]);

  const totalsKnown = totals.known > 0;
  const totalBalanceText = totalsKnown
    ? formatCu(totals.balanceCu, locale, t)
    : t("app.summary.unknown");
  const totalRateText = totalsKnown
    ? formatCuRate(totals.rateCuPerHour, locale, t)
    : t("app.summary.unknown");
  const totalRuntimesText = totalsKnown ? String(totals.runtimes) : t("app.summary.unknown");
  const totalMissingText =
    totals.unknown === 1
      ? t("app.accounts.total.missing_one")
      : totals.unknown > 1
        ? t("app.accounts.total.missing_many", { count: totals.unknown })
        : null;

  const hasActiveLoginBanner =
    gate.kind === "ready" &&
    snapshot !== null &&
    snapshot.login_id !== null &&
    !addAccountDialogOpen;

  return (
    <>
      <header className="page-header page-header-row">
        <div className="page-header-heading">
          <h1 className="page-title">{t("app.nav.accounts")}</h1>
          <p className="page-subtitle">{t("app.accounts.subtitle")}</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canAdd}
            title={addDisabledTitle}
            onClick={onRequestAddAccount}
          >
            <UserPlusIcon />
            <span>{t("app.action.add_account")}</span>
          </button>
        </div>
      </header>

      <div className="page-sections">
        {gate.kind === "loading" && (
          <section className="card">
            <div className="busy-line" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.accounts.loading")}</span>
            </div>
          </section>
        )}

        {gate.kind === "needs_cli" && (
          <section className="card">
            <div className="empty-state">
              <div className="empty-state-disc" aria-hidden="true">
                <TerminalIcon />
              </div>
              <div className="empty-state-words">
                <h2 className="empty-state-title">{t("app.err.not_installed")}</h2>
                <p className="empty-state-body">{t("app.accounts.needs_cli")}</p>
              </div>
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigate("overview")}
                >
                  {t("app.action.install_cli")}
                </button>
              </div>
            </div>
          </section>
        )}

        {gate.kind === "needs_wsl" && (
          <section className="card">
            <div className="empty-state">
              <div className="empty-state-disc" aria-hidden="true">
                <TerminalIcon />
              </div>
              <div className="empty-state-words">
                <h2 className="empty-state-title">{t("app.err.wsl_unavailable")}</h2>
                <p className="empty-state-body">{t("app.step.wsl.todo")}</p>
              </div>
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigate("overview")}
                >
                  {t("app.b2.sessions_setup_action")}
                </button>
              </div>
            </div>
          </section>
        )}

        {gate.kind === "needs_shell" && (
          <section className="card">
            <div className="empty-state">
              <div className="empty-state-disc" aria-hidden="true">
                <TerminalIcon />
              </div>
              <div className="empty-state-words">
                <h2 className="empty-state-title">{t("app.step.shell.title")}</h2>
                <p className="empty-state-body">{t("app.step.shell.todo")}</p>
              </div>
              <div className="empty-state-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => navigate("overview")}
                >
                  {t("app.b2.sessions_setup_action")}
                </button>
              </div>
            </div>
          </section>
        )}

        {gate.kind === "keyring_unavailable" && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{t("app.accounts.keyring.title")}</p>
              <p className="alert-body">
                {(gate.hint_key ? t(gate.hint_key) : "") || t("app.accounts.keyring.body")}
              </p>
              <div className="alert-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={diagnosticsLoading}
                  onClick={() => {
                    void handleCheckEnvironmentAgain();
                  }}
                >
                  {diagnosticsLoading && <span className="spinner" aria-hidden="true" />}
                  <span>{t("app.action.check_again")}</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {gate.kind === "error" && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{formatErrorKind(gate.errorKind, t)}</p>
              <div className="alert-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={diagnosticsLoading}
                  onClick={() => {
                    void handleCheckEnvironmentAgain();
                  }}
                >
                  {t("app.action.retry")}
                </button>
              </div>
            </div>
          </div>
        )}

        {gate.kind === "ready" && (
          <>
            {(recoveredVisible || gate.accounts.recovered_pending_add) && !recoveredDismissed && (
              <div className="alert alert-info" role="status">
                <span className="alert-icon icon-info">
                  <InfoIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{t("app.accounts.recovered.title")}</p>
                  <p className="alert-body">{t("app.accounts.recovered.body")}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon alert-dismiss"
                  aria-label={t("app.action.dismiss")}
                  onClick={() => {
                    setRecoveredVisible(false);
                    setRecoveredDismissed(true);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            )}

            {hasActiveLoginBanner && (
              <div className="alert alert-warning" role="status">
                <span className="alert-icon icon-warning">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-body">{t("web.add.in_progress_other")}</p>
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={shuttingDown}
                      onClick={onRequestAddAccount}
                    >
                      {t("web.add.cancel_existing")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {gate.accounts.unadopted && (
              <div className="alert alert-info" role="status">
                <span className="alert-icon icon-info">
                  <InfoIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">
                    {gate.accounts.active_email
                      ? t("app.accounts.unadopted.title", { email: gate.accounts.active_email })
                      : t("app.accounts.unadopted.title_no_email")}
                  </p>
                  <p className="alert-body">{t("app.accounts.unadopted.body")}</p>
                  {adoptError !== null && (
                    <div className="inline-msg inline-msg-danger" role="alert">
                      <AlertIcon />
                      <span className="inline-msg-text">{adoptError.message}</span>
                    </div>
                  )}
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={adopting || accountChangeBlocked || shuttingDown}
                      title={
                        accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined
                      }
                      onClick={() => {
                        void handleAdoptAccount();
                      }}
                    >
                      {adopting && <span className="spinner" aria-hidden="true" />}
                      <span>{t("app.accounts.adopt")}</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {rows.length === 0 ? (
              <section className="card">
                <div className="empty-state">
                  <div className="empty-state-disc" aria-hidden="true">
                    <AccountsIcon />
                  </div>
                  <div className="empty-state-words">
                    <h2 className="empty-state-title">{t("app.accounts.empty.title")}</h2>
                    <p className="empty-state-body">{t("app.accounts.empty.body")}</p>
                  </div>
                  <div className="empty-state-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={!canAdd}
                      title={addDisabledTitle}
                      onClick={onRequestAddAccount}
                    >
                      <UserPlusIcon />
                      <span>{t("app.action.add_account")}</span>
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <>
                <section className="card">
                  <div className="card-header">
                    <div className="card-heading">
                      <h2 className="card-title">{t("app.accounts.total.title")}</h2>
                    </div>
                    <div className="card-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        aria-label={t("app.usage.refresh")}
                        title={t("app.usage.refresh")}
                        disabled={refreshingUsage || shuttingDown}
                        onClick={() => {
                          void handleRefreshUsage();
                        }}
                      >
                        {refreshingUsage ? (
                          <span className="spinner" aria-hidden="true" />
                        ) : (
                          <RefreshIcon />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="kpi-grid">
                    <div className="kpi-tile">
                      <span className="kpi-label">{t("app.accounts.balance")}</span>
                      <span className="totals-value">{totalBalanceText}</span>
                    </div>
                    <div className="kpi-tile">
                      <span className="kpi-label">{t("app.accounts.rate")}</span>
                      <span className="totals-value">{totalRateText}</span>
                    </div>
                    <div className="kpi-tile">
                      <span className="kpi-label">{t("app.summary.runtimes")}</span>
                      <span className="totals-value">{totalRuntimesText}</span>
                    </div>
                  </div>

                  {totalMissingText !== null && <p className="caption">{totalMissingText}</p>}

                  {usageRefreshError !== null && (
                    <div className="inline-msg inline-msg-warning" role="status">
                      <AlertIcon />
                      <span className="inline-msg-text">{usageRefreshError.message}</span>
                    </div>
                  )}
                </section>

                {unmanagedWarning !== null && (
                  <div className="alert alert-warning" role="alert">
                    <span className="alert-icon icon-warning">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-title">{unmanagedWarning.title}</p>
                      <p className="alert-body">{unmanagedWarning.body}</p>
                      <div className="alert-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => navigate("sessions")}
                        >
                          {t("app.action.view_sessions")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {rows.map((row) => {
                  const blockReason =
                    row.removeBlock === "active"
                      ? t("app.accounts.remove_active")
                      : row.removeBlock === "running"
                        ? t("app.accounts.remove_running")
                        : null;
                  const blockNoteId =
                    blockReason !== null ? `${idPrefix}-block-${row.account.id}` : undefined;
                  const removeDisabled =
                    blockReason !== null || accountChangeBlocked || shuttingDown;
                  const removeTitle =
                    blockReason ??
                    (accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined);

                  const balanceText =
                    row.usageSnapshot !== null
                      ? formatCu(row.usageSnapshot.balance_cu, locale, t)
                      : t("app.summary.unknown");
                  const rateText =
                    row.usageSnapshot !== null
                      ? formatCuRate(row.usageSnapshot.rate_cu_per_hour, locale, t)
                      : t("app.summary.unknown");
                  const timeLeftText = formatAccountTimeLeft(row.usage, row.usageSnapshot, t);
                  const updatedText =
                    row.ageSecs !== null
                      ? formatRelativeAge(row.ageSecs, t)
                      : t("app.summary.unknown");

                  const usageFailure =
                    row.usage?.last_error !== null &&
                    row.usage?.last_error !== undefined &&
                    (row.usageSnapshot === null || row.isFailed)
                      ? row.usage.last_error
                      : null;

                  const switchDisabled = accountChangeBlocked || shuttingDown || removingAccount;
                  const switchTitle = accountChangeBlocked
                    ? t("app.b2.account_change_blocked")
                    : undefined;

                  return (
                    <section key={row.account.id} className="card card-compact">
                      <div className="account-card-header">
                        <div className="account-identity">
                          <span className="account-email">{row.emailLabel}</span>
                          {row.active && (
                            <span className="badge badge-success">
                              {t("app.accounts.active")}
                            </span>
                          )}
                        </div>

                        <div className="account-actions">
                          {!row.active && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={switchDisabled}
                              title={switchTitle}
                              onClick={() =>
                                onRequestSwitchAccount({
                                  id: row.account.id,
                                  emailLabel: row.emailLabel,
                                })
                              }
                            >
                              {t("app.accounts.switch")}
                            </button>
                          )}
                          <span title={removeTitle}>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled={removeDisabled}
                              title={removeTitle}
                              aria-describedby={blockNoteId}
                              onClick={() =>
                                setRemoveTarget({
                                  id: row.account.id,
                                  emailLabel: row.emailLabel,
                                })
                              }
                            >
                              <TrashIcon />
                              <span>{t("app.accounts.remove")}</span>
                            </button>
                          </span>
                        </div>
                      </div>

                      <div className="account-stats-grid">
                        <div className="account-stat">
                          <span className="account-stat-label">{t("app.accounts.balance")}</span>
                          <span className="account-stat-value">{balanceText}</span>
                        </div>
                        <div className="account-stat">
                          <span className="account-stat-label">{t("app.accounts.rate")}</span>
                          <span className="account-stat-value">{rateText}</span>
                        </div>
                        <div className="account-stat">
                          <span className="account-stat-label">{t("app.accounts.time_left")}</span>
                          <span className="account-stat-value">{timeLeftText}</span>
                        </div>
                        <div className="account-stat">
                          <span className="account-stat-label">{t("app.accounts.updated")}</span>
                          <span className="account-stat-value">{updatedText}</span>
                        </div>
                        {row.isStale && (
                          <span className="badge badge-warning">{t("app.usage.outdated")}</span>
                        )}
                      </div>

                      {usageFailure !== null && (
                        <div className="inline-msg inline-msg-warning" role="status">
                          <AlertIcon />
                          <span className="inline-msg-text">
                            {`${t("app.accounts.usage_failed")} ${formatCoreError(usageFailure, t)}`}
                          </span>
                        </div>
                      )}

                      {blockReason !== null && (
                        <p id={blockNoteId} className="account-block-note">
                          {blockReason}
                        </p>
                      )}
                    </section>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {snapshot !== null && (
        <RemoveAccountDialog
          target={removeTarget}
          snapshot={snapshot}
          t={t}
          pushToast={pushToast}
          onRemovingChange={setRemovingAccount}
          onClose={() => setRemoveTarget(null)}
        />
      )}
    </>
  );
}
