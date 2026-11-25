/**
 * Accounts route entry module (minimal shell entry isolated for Wave 5).
 */

import { resolveActiveAccount } from "../lib/format.ts";
import type { PageProps } from "./types.ts";

export function AccountsPage({ snapshot, t }: PageProps) {
  const active = resolveActiveAccount(snapshot, t);

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.accounts")}</h1>
        <p className="page-subtitle">{t("app.accounts.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.accounts.loading")}</span>
            </div>
          </section>
        ) : (
          <section className="card placeholder-card">
            <h2 className="card-title">
              {active.signedIn
                ? t("app.summary.active", { email: active.label })
                : t("app.accounts.empty.title")}
            </h2>
            <p className="card-desc">
              {active.signedIn ? t("app.accounts.subtitle") : t("app.accounts.empty.body")}
            </p>
          </section>
        )}
      </div>
    </>
  );
}
