/**
 * Ready-state Overview compute-unit summary card.
 */

import { AlertIcon } from "../../components/Icons.tsx";
import {
  evaluateUsageFreshness,
  formatCu,
  formatCuRate,
  resolveActiveAccount,
} from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale, Snapshot } from "../../lib/types.ts";
import {
  formatAccountTimeLeft,
  formatCoreError,
  type FormattedApiError,
} from "../accounts/model.ts";
import { summarizeCrossAccountRuntimes, type OverviewResponse } from "./api.ts";
import { RefreshIcon } from "./Icons.tsx";

export interface SummaryCardProps {
  readonly overview: OverviewResponse;
  readonly snapshot: Snapshot | null;
  readonly nowSecs: number;
  readonly locale: Locale;
  readonly refreshingUsage: boolean;
  readonly usageRefreshError: FormattedApiError | null;
  readonly shuttingDown: boolean;
  readonly t: TranslateFn;
  readonly onRefreshUsage: () => Promise<void>;
}

export function SummaryCard({
  overview,
  snapshot,
  nowSecs,
  locale,
  refreshingUsage,
  usageRefreshError,
  shuttingDown,
  t,
  onRefreshUsage,
}: SummaryCardProps) {
  const effectiveSnapshot: Snapshot | null =
    snapshot !== null
      ? snapshot
      : overview.accounts !== null
        ? {
            version: 0,
            server_now: overview.sampled_at,
            backend: "mock",
            account: { revision: 0, active: overview.accounts.active },
            accounts: overview.accounts,
            accounts_error: overview.accounts_error,
            runtimes: null,
            runtimes_error: null,
            tunnels: [],
            usage: [...overview.usage],
            measured_rates: overview.measured_rates ? [...overview.measured_rates] : [],
            guard: null,
            guard_events: [],
            guard_error: null,
            ended: [],
            operations: [],
            login_id: null,
            shutting_down: false,
          }
        : null;

  const active = resolveActiveAccount(effectiveSnapshot, t);
  const usageSnap = active.usageSnapshot;
  const freshness = evaluateUsageFreshness(active, nowSecs);

  const balanceText =
    usageSnap !== null ? formatCu(usageSnap.balance_cu, locale, t) : t("app.summary.unknown");
  const rateText =
    usageSnap !== null
      ? formatCuRate(usageSnap.rate_cu_per_hour, locale, t)
      : t("app.summary.unknown");
  const timeLeftText = formatAccountTimeLeft(active.usage, usageSnap, t);

  const effectiveAccounts = effectiveSnapshot?.accounts ?? overview.accounts;
  const effectiveUsage = effectiveSnapshot !== null ? effectiveSnapshot.usage : overview.usage;
  const runtimesSummary = summarizeCrossAccountRuntimes(effectiveAccounts, effectiveUsage, t);
  const runtimesText =
    runtimesSummary.known > 0 ? String(runtimesSummary.totalRuntimes) : t("app.summary.unknown");

  const staleNote =
    freshness !== null && freshness.outdated
      ? t(freshness.isStale ? "app.usage.tip.stale" : "app.usage.tip.old")
      : null;

  const activeUsageError =
    usageRefreshError === null &&
    active.usage?.last_error !== null &&
    active.usage?.last_error !== undefined
      ? active.usage.last_error
      : null;

  return (
    <section className="card" data-overview-summary="true">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.summary.title")}</h2>
          <p className="card-desc">{t("app.summary.active", { email: active.label })}</p>
        </div>
        <div className="card-actions">
          {freshness?.outdated && (
            <span className="badge badge-warning">{t("app.usage.outdated")}</span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            data-overview-refresh-usage="true"
            aria-label={t("app.usage.refresh")}
            title={t("app.usage.refresh")}
            disabled={refreshingUsage || shuttingDown}
            onClick={() => {
              void onRefreshUsage();
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
          <span className="kpi-label">{t("app.summary.balance")}</span>
          <div className="kpi-value-row">
            <span className="kpi-value">{balanceText}</span>
          </div>
        </div>

        <div className="kpi-tile">
          <span className="kpi-label">{t("app.summary.rate")}</span>
          <div className="kpi-value-row">
            <span className="kpi-value">{rateText}</span>
          </div>
        </div>

        <div className="kpi-tile">
          <span className="kpi-label">{t("app.summary.time_left")}</span>
          <div className="kpi-value-row">
            <span className="kpi-value">{timeLeftText}</span>
          </div>
        </div>

        <div className="kpi-tile">
          <span className="kpi-label">{t("app.summary.runtimes")}</span>
          <div className="kpi-value-row">
            <span className="kpi-value">{runtimesText}</span>
            {runtimesSummary.incomplete && (
              <span className="badge badge-warning">{t("app.b10.summary_incomplete")}</span>
            )}
          </div>
          <span className="kpi-note">
            {runtimesSummary.incomplete && runtimesSummary.uncountedNote !== null
              ? runtimesSummary.uncountedNote
              : t("app.summary.runtimes_all")}
          </span>
        </div>
      </div>

      {staleNote !== null && (
        <div className="inline-msg inline-msg-warning" role="status">
          <AlertIcon />
          <span className="inline-msg-text">{staleNote}</span>
        </div>
      )}

      {usageRefreshError !== null && (
        <div className="inline-msg inline-msg-warning" role="status">
          <AlertIcon />
          <span className="inline-msg-text">{usageRefreshError.message}</span>
        </div>
      )}

      {activeUsageError !== null && (
        <div className="inline-msg inline-msg-warning" role="status">
          <AlertIcon />
          <span className="inline-msg-text">
            {`${t("app.accounts.usage_failed")} ${formatCoreError(activeUsageError, t)}`}
          </span>
        </div>
      )}
    </section>
  );
}
