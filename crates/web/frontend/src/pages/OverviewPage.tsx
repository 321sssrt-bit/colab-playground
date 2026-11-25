/**
 * Overview route entry module (minimal live summary until full Overview migration).
 */

import { formatCu, formatCuRate, resolveActiveAccount } from "../lib/format.ts";
import type { PageProps } from "./types.ts";

export function OverviewPage({ snapshot, locale, t }: PageProps) {
  const active = resolveActiveAccount(snapshot, t);
  const usageSnap = active.usageSnapshot;
  const runtimeCount = snapshot?.runtimes?.runtimes.length ?? null;

  const balanceText =
    usageSnap !== null ? formatCu(usageSnap.balance_cu, locale, t) : t("app.summary.unknown");
  const rateText =
    usageSnap === null
      ? t("app.summary.unknown")
      : usageSnap.rate_cu_per_hour > 0
        ? formatCuRate(usageSnap.rate_cu_per_hour, locale, t)
        : t("app.summary.not_burning");
  const runtimesText = runtimeCount !== null ? String(runtimeCount) : t("app.summary.unknown");

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.overview")}</h1>
        <p className="page-subtitle">{t("app.overview.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.overview.loading")}</span>
            </div>
          </section>
        ) : (
          <section className="card">
            <div className="card-header">
              <div className="card-heading">
                <h2 className="card-title">{t("app.summary.title")}</h2>
                <p className="card-desc">
                  {active.signedIn
                    ? t("app.summary.active", { email: active.label })
                    : t("app.shell.account.signed_out")}
                </p>
              </div>
            </div>

            <div className="kpi-grid">
              <div className="kpi-tile">
                <span className="kpi-label">{t("app.summary.balance")}</span>
                <div className="kpi-value-row">
                  <span className="kpi-value">{balanceText}</span>
                  {usageSnap?.stale && (
                    <span className="badge badge-warning">{t("app.usage.outdated")}</span>
                  )}
                </div>
              </div>

              <div className="kpi-tile">
                <span className="kpi-label">{t("app.summary.rate")}</span>
                <div className="kpi-value-row">
                  <span className="kpi-value">{rateText}</span>
                </div>
              </div>

              <div className="kpi-tile">
                <span className="kpi-label">{t("app.summary.runtimes")}</span>
                <div className="kpi-value-row">
                  <span className="kpi-value">{runtimesText}</span>
                </div>
                <span className="kpi-note">{t("app.summary.runtimes_all")}</span>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
