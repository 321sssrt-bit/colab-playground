/**
 * Bearer access-key login gate with pre-login 5-locale and appearance controls.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon, BrandIcon, EyeIcon, EyeOffIcon } from "../components/Icons.tsx";
import { PreferenceBar } from "../components/PreferenceBar.tsx";
import { ApiError } from "../lib/api.ts";
import type { TranslateFn } from "../lib/i18n.ts";
import type { AppearancePref, LanguagePref, Locale } from "../lib/types.ts";

type LoginErrorKind = "invalid_key" | "unavailable" | "network_error";

const LOGIN_ERROR_KEYS = {
  invalid_key: "web.login.invalid_key",
  unavailable: "web.login.unavailable",
  network_error: "web.login.network_error",
} as const;

function classifyLoginError(error: unknown): LoginErrorKind | null {
  if (error instanceof ApiError) {
    if (error.isAbort) {
      return null;
    }
    if (error.isUnauthorized) {
      return "invalid_key";
    }
    if (error.status === 0) {
      return "network_error";
    }
    return "unavailable";
  }
  return "network_error";
}

export interface LoginPageProps {
  readonly language: LanguagePref;
  readonly browserLocale: Locale;
  readonly appearance: AppearancePref;
  readonly sessionExpired: boolean;
  readonly dictionaryLoadFailed: boolean;
  readonly t: TranslateFn;
  readonly onLanguageChange: (pref: LanguagePref) => void;
  readonly onAppearanceChange: (pref: AppearancePref) => void;
  readonly onSignIn: (accessKey: string, signal: AbortSignal) => Promise<void>;
}

export function LoginPage({
  language,
  browserLocale,
  appearance,
  sessionExpired,
  dictionaryLoadFailed,
  t,
  onLanguageChange,
  onAppearanceChange,
  onSignIn,
}: LoginPageProps) {
  const keyInputId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);

  const [accessKey, setAccessKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorKind, setErrorKind] = useState<LoginErrorKind | null>(null);

  useEffect(() => {
    return () => {
      submitAbortRef.current?.abort();
      submitAbortRef.current = null;
    };
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const trimmed = accessKey.trim();
    if (!trimmed) {
      setErrorKind("invalid_key");
      inputRef.current?.focus();
      return;
    }

    const controller = new AbortController();
    submitAbortRef.current = controller;

    setSubmitting(true);
    setErrorKind(null);

    try {
      await onSignIn(trimmed, controller.signal);
      if (!controller.signal.aborted) {
        setAccessKey("");
        setRevealed(false);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const kind = classifyLoginError(error);
      if (kind !== null) {
        setErrorKind(kind);
        inputRef.current?.focus();
      }
    } finally {
      if (submitAbortRef.current === controller) {
        submitAbortRef.current = null;
      }
      if (!controller.signal.aborted) {
        setSubmitting(false);
      }
    }
  };

  const effectiveError: LoginErrorKind | null =
    errorKind ?? (dictionaryLoadFailed ? "network_error" : null);

  const isKeyInvalid = errorKind === "invalid_key";
  const describedBy = isKeyInvalid ? `${keyHintId} ${keyErrorId}` : keyHintId;

  return (
    <main className="login-page">
      <div className="login-shell">
        <div className="login-topbar">
          <PreferenceBar
            language={language}
            browserLocale={browserLocale}
            appearance={appearance}
            t={t}
            onLanguageChange={onLanguageChange}
            onAppearanceChange={onAppearanceChange}
          />
        </div>

        <section className="card login-card">
          <header className="login-header">
            <div className="brand-mark login-brand">
              <BrandIcon />
              <span className="brand-name">{t("app.name")}</span>
            </div>
            <h1 className="login-title">{t("web.login.title")}</h1>
            <p className="caption">{t("web.login.subtitle")}</p>
          </header>

          {sessionExpired && effectiveError === null && (
            <div className="alert alert-warning" role="alert">
              <span className="alert-icon icon-warning">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{t("web.login.session_expired")}</p>
              </div>
            </div>
          )}

          {effectiveError !== null && (
            <div className="alert alert-danger" role="alert" id={keyErrorId}>
              <span className="alert-icon icon-danger">
                <AlertIcon />
              </span>
              <div className="alert-text">
                <p className="alert-body">{t(LOGIN_ERROR_KEYS[effectiveError])}</p>
              </div>
            </div>
          )}

          <form className="login-form" method="post" onSubmit={handleSubmit} noValidate>
            <div className="field-group">
              <label className="field-label" htmlFor={keyInputId}>
                {t("web.login.key_label")}
              </label>
              <div className="password-row">
                <input
                  ref={inputRef}
                  id={keyInputId}
                  name="access_key"
                  type={revealed ? "text" : "password"}
                  className="input input-lg mono"
                  value={accessKey}
                  onChange={(event) => {
                    setAccessKey(event.target.value);
                    if (errorKind !== null) {
                      setErrorKind(null);
                    }
                  }}
                  placeholder={t("web.login.key_placeholder")}
                  autoComplete="current-password"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="done"
                  required
                  disabled={submitting}
                  aria-invalid={isKeyInvalid ? "true" : undefined}
                  aria-describedby={describedBy}
                />
                <button
                  type="button"
                  className="btn btn-lg btn-icon"
                  aria-pressed={revealed}
                  aria-label={revealed ? t("input.hide_password") : t("input.show_password")}
                  disabled={submitting}
                  onClick={() => setRevealed((prev) => !prev)}
                >
                  {revealed ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              <p className="field-hint" id={keyHintId}>
                {t("web.login.key_hint")}
              </p>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-lg login-submit"
              disabled={submitting}
              aria-busy={submitting || undefined}
            >
              {submitting && <span className="spinner" aria-hidden="true" />}
              <span>{submitting ? t("web.login.submitting") : t("web.login.submit")}</span>
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}
