import { useEffect, useState } from "react";
import {
  detectBrowserLocale,
  loadDictionary,
  type Dictionary,
} from "./lib/i18n";

export function App() {
  const [locale] = useState(detectBrowserLocale);
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    document.documentElement.lang = locale;
    loadDictionary(locale, controller.signal)
      .then((loaded) => {
        setDict(loaded);
        setFailed(false);
        const appName = loaded["app.name"];
        if (appName) {
          document.title = appName;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [locale]);

  const t = (key: string): string => dict?.[key] ?? "";

  return (
    <main className="login-page">
      <div className="login-shell">
        <section className="card login-card">
          <header className="login-header">
            <h1 className="login-title">{t("app.name")}</h1>
            <p className="caption">
              {failed
                ? t("web.login.network_error")
                : dict
                  ? t("web.login.title")
                  : t("web.overview.loading")}
            </p>
          </header>
        </section>
      </div>
    </main>
  );
}
