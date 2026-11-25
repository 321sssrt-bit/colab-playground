/**
 * Sessions route entry module (minimal shell entry isolated for Wave 5).
 */

import { AlertIcon } from "../components/Icons.tsx";
import type { PageProps } from "./types.ts";

export function SessionsPage({ snapshot, t }: PageProps) {
  const runtimesView = snapshot?.runtimes ?? null;
  const runtimesError = snapshot?.runtimes_error ?? null;
  const runtimeCount = runtimesView ? runtimesView.runtimes.length : null;
  const accountErrorCount = runtimesView ? runtimesView.errors.length : 0;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.sessions")}</h1>
        <p className="page-subtitle">{t("app.sessions.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null || (runtimesView === null && runtimesError === null) ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.b2.sessions_loading")}</span>
            </div>
          </section>
        ) : runtimesView === null ? (
          <div className="alert alert-warning" role="alert">
            <span className="alert-icon icon-warning">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-title">{t("app.b2.sessions_failed")}</p>
            </div>
          </div>
        ) : (
          <>
            {accountErrorCount > 0 && (
              <div className="alert alert-warning" role="alert">
                <span className="alert-icon icon-warning">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{t("app.b2.sessions_failed")}</p>
                </div>
              </div>
            )}

            {runtimeCount === 0 ? (
              <section className="card">
                <div className="empty-state">
                  <div className="empty-state-words">
                    <h2 className="empty-state-title">
                      {accountErrorCount > 0
                        ? t("app.b10.sessions_empty_partial_title")
                        : t("app.sessions.empty.title")}
                    </h2>
                    {accountErrorCount === 0 && (
                      <p className="empty-state-body">{t("app.sessions.empty.body")}</p>
                    )}
                  </div>
                </div>
              </section>
            ) : (
              <section className="card placeholder-card">
                <h2 className="card-title">
                  {runtimeCount === 1
                    ? t("app.b2.sessions_count_one")
                    : t("app.b2.sessions_count_many", { count: runtimeCount ?? 0 })}
                </h2>
                <p className="card-desc">{t("app.sessions.subtitle")}</p>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
