/**
 * Pinned concurrent-session limit card shown at the top of Settings when
 * New Session or Plugin Deploy links here via `SettingsFocus: "limit"`.
 */

import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import {
  MAX_CONCURRENT_SESSIONS,
  MIN_CONCURRENT_SESSIONS,
  type RuntimeDefaults,
} from "../../lib/constants.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { scrollSettingsToTop } from "./focus.ts";

const INTEGER_RE = /^\d+$/;

function parseConcurrentLimit(raw: string): number | null {
  const trimmed = raw.trim();
  if (!INTEGER_RE.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_CONCURRENT_SESSIONS ||
    parsed > MAX_CONCURRENT_SESSIONS
  ) {
    return null;
  }
  return parsed;
}

export interface LimitFocusCardProps {
  readonly serverDefaults: RuntimeDefaults;
  readonly draftValue: string;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly savedNotice: boolean;
  readonly t: TranslateFn;
  readonly onChange: (value: string) => void;
  readonly onSave: (limit: number) => Promise<boolean>;
  readonly onClearFeedback: () => void;
}

export const LimitFocusCard = memo(function LimitFocusCard({
  serverDefaults,
  draftValue,
  saving,
  saveError,
  savedNotice,
  t,
  onChange,
  onSave,
  onClearFeedback,
}: LimitFocusCardProps) {
  const headingId = useId();
  const inputId = useId();
  const descId = useId();
  const errorId = useId();
  const sectionRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    scrollSettingsToTop(sectionRef.current);
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const parsed = parseConcurrentLimit(draftValue);
  const dirty = parsed === null || parsed !== serverDefaults.max_concurrent_sessions;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || !dirty) {
      return;
    }
    const next = parseConcurrentLimit(draftValue);
    if (next === null) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    setInvalid(false);
    await onSave(next);
  };

  const describedBy = invalid || saveError !== null ? `${descId} ${errorId}` : descId;

  return (
    <section
      ref={sectionRef}
      className="card settings-section settings-focus-card"
      data-settings-limit-focus="true"
    >
      <div className="card-heading">
        <h2
          ref={headingRef}
          id={headingId}
          tabIndex={-1}
          className="card-title settings-focus-heading"
        >
          {t("app.def.concurrent")}
        </h2>
        <p id={descId} className="card-desc">
          {t("app.b3.limit_focus_hint")}
        </p>
      </div>

      <form
        className="settings-limit-form"
        aria-labelledby={headingId}
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
      >
        <div className="settings-limit-controls">
          <label className="visually-hidden" htmlFor={inputId}>
            {t("app.def.concurrent")}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            name="max_concurrent_sessions_focus"
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            min={MIN_CONCURRENT_SESSIONS}
            max={MAX_CONCURRENT_SESSIONS}
            step={1}
            value={draftValue}
            disabled={saving}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={describedBy}
            data-settings-limit-input="true"
            onChange={(event) => {
              onChange(event.target.value);
              if (invalid) {
                setInvalid(false);
              }
              if (savedNotice || saveError !== null) {
                onClearFeedback();
              }
            }}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={saving || !dirty}
            aria-busy={saving || undefined}
            data-settings-limit-save="true"
          >
            {saving && <span className="spinner" aria-hidden="true" />}
            <span>{t("app.b2.action_save")}</span>
          </button>
        </div>

        {invalid ? (
          <span id={errorId} className="inline-msg inline-msg-danger" role="alert">
            <AlertIcon />
            <span className="inline-msg-text">{t("app.err.invalid_input")}</span>
          </span>
        ) : saveError !== null ? (
          <span id={errorId} className="inline-msg inline-msg-danger" role="alert">
            <AlertIcon />
            <span className="inline-msg-text">{saveError}</span>
          </span>
        ) : savedNotice ? (
          <span className="inline-msg inline-msg-success" role="status">
            <CheckCircleIcon />
            <span className="inline-msg-text">{t("web.settings.saved")}</span>
          </span>
        ) : null}
      </form>
    </section>
  );
});
