/**
 * Sessions route entry module (minimal shell entry isolated for Wave 5).
 */

import type { PageProps } from "./types.ts";

export function SessionsPage({ snapshot, t }: PageProps) {
  const runtimeCount = snapshot?.runtimes?.runtimes.length ?? null;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.sessions")}</h1>
        <p className="page-subtitle">{t("app.sessions.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.b2.sessions_loading")}</span>
            </div>
          </section>
        ) : runtimeCount === 0 ? (
          <section className="card">
            <div className="empty-state">
              <div className="empty-state-words">
                <h2 className="empty-state-title">{t("app.sessions.empty.title")}</h2>
                <p className="empty-state-body">{t("app.sessions.empty.body")}</p>
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
      </div>
    </>
  );
}
