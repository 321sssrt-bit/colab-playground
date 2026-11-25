/**
 * Plugins route entry module (minimal shell entry isolated for Wave 5).
 */

import type { PageProps } from "./types.ts";

export function PluginsPage({ snapshot, t }: PageProps) {
  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.plugins")}</h1>
        <p className="page-subtitle">{t("app.plugins.subtitle")}</p>
      </header>

      <div className="page-sections">
        {snapshot === null ? (
          <section className="card">
            <div className="busy-line">
              <span className="spinner" aria-hidden="true" />
              <span>{t("app.b2.plugins_loading")}</span>
            </div>
          </section>
        ) : (
          <section className="card placeholder-card">
            <h2 className="card-title">{t("app.nav.plugins")}</h2>
            <p className="card-desc">{t("app.plugins.subtitle")}</p>
          </section>
        )}
      </div>
    </>
  );
}
