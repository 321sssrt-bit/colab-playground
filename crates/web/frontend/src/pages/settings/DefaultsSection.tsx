/**
 * Isolated Defaults form card.
 *
 * Intentionally receives no SSE `snapshot` prop and is memoized so live
 * background snapshot pushes never re-render inputs, reset draft text, or
 * disturb active focus.
 */

import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import {
  ACCELERATOR_OPTIONS,
  CORE_DEFAULTS,
  CU_INPUT_STEP,
  MAX_ATTEMPTS_CAP,
  MAX_CONCURRENT_SESSIONS,
  MAX_CU_FIELD,
  MAX_DURATION_HOURS,
  MAX_DURATION_MINUTES,
  MAX_DURATION_SECONDS,
  MAX_VRAM_GIB,
  MIN_ATTEMPTS,
  MIN_CONCURRENT_SESSIONS,
  MIN_CU_FIELD,
  MIN_VRAM_GIB,
  ON_EXHAUSTED_OPTIONS,
  type OnExhausted,
  type RuntimeDefaults,
} from "../../lib/constants.ts";
import type { Dictionary, TranslateFn } from "../../lib/i18n.ts";
import type { Accelerator } from "../../lib/types.ts";
import {
  defaultsToDraft,
  isDraftAtCoreDefaults,
  isDraftDirty,
  parseDefaultsDraft,
  toggleOptionalField,
  type DefaultsDraft,
  type DefaultsFieldId,
  type DurationDraft,
} from "./draft.ts";

const ACCELERATOR_LABEL_KEYS = {
  NONE: "app.acc.none",
  T4: "app.acc.t4",
  L4: "app.acc.l4",
  G4: "app.acc.g4",
  A100: "app.acc.a100",
  H100: "app.acc.h100",
  V5E1: "app.acc.v5e1",
  V6E1: "app.acc.v6e1",
} as const;

const ON_EXHAUSTED_LABEL_KEYS = {
  stop_and_fail: "app.def.exhausted_stop",
  keep_last: "app.def.exhausted_keep",
} as const;

interface DurationInputsProps {
  readonly idPrefix: string;
  readonly legend: string;
  readonly value: DurationDraft;
  readonly withSeconds: boolean;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly t: TranslateFn;
  readonly onChange: (next: DurationDraft) => void;
}

function DurationInputs({
  idPrefix,
  legend,
  value,
  withSeconds,
  invalid,
  disabled,
  t,
  onChange,
}: DurationInputsProps) {
  return (
    <fieldset className="settings-fieldset">
      <legend className="visually-hidden">{legend}</legend>
      <div className="duration-group">
        <label className="unit-field" htmlFor={`${idPrefix}-hours`}>
          <input
            id={`${idPrefix}-hours`}
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            min={0}
            max={MAX_DURATION_HOURS}
            step={1}
            value={value.hours}
            disabled={disabled}
            aria-invalid={invalid ? "true" : undefined}
            onChange={(event) => onChange({ ...value, hours: event.target.value })}
          />
          <span className="unit-suffix">{t("app.b3.unit_hours")}</span>
        </label>

        <label className="unit-field" htmlFor={`${idPrefix}-minutes`}>
          <input
            id={`${idPrefix}-minutes`}
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            min={0}
            max={MAX_DURATION_MINUTES}
            step={1}
            value={value.minutes}
            disabled={disabled}
            aria-invalid={invalid ? "true" : undefined}
            onChange={(event) => onChange({ ...value, minutes: event.target.value })}
          />
          <span className="unit-suffix">{t("app.b3.unit_minutes")}</span>
        </label>

        {withSeconds && (
          <label className="unit-field" htmlFor={`${idPrefix}-seconds`}>
            <input
              id={`${idPrefix}-seconds`}
              type="number"
              inputMode="numeric"
              className="input input-sm input-num"
              min={0}
              max={MAX_DURATION_SECONDS}
              step={1}
              value={value.seconds}
              disabled={disabled}
              aria-invalid={invalid ? "true" : undefined}
              onChange={(event) => onChange({ ...value, seconds: event.target.value })}
            />
            <span className="unit-suffix">{t("app.b3.unit_seconds")}</span>
          </label>
        )}
      </div>
    </fieldset>
  );
}

export interface DefaultsSectionProps {
  readonly serverDefaults: RuntimeDefaults;
  readonly dict: Dictionary | null;
  readonly t: TranslateFn;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly savedNotice: boolean;
  readonly onSave: (next: RuntimeDefaults) => Promise<boolean>;
  readonly onClearFeedback: () => void;
}

export const DefaultsSection = memo(function DefaultsSection({
  serverDefaults,
  t,
  saving,
  saveError,
  savedNotice,
  onSave,
  onClearFeedback,
}: DefaultsSectionProps) {
  const idBase = useId();
  const [draft, setDraft] = useState<DefaultsDraft>(() => defaultsToDraft(serverDefaults));
  const [invalidFields, setInvalidFields] = useState<ReadonlySet<DefaultsFieldId>>(
    () => new Set<DefaultsFieldId>(),
  );
  const lastServerRef = useRef<RuntimeDefaults>(serverDefaults);

  useEffect(() => {
    if (lastServerRef.current !== serverDefaults) {
      lastServerRef.current = serverDefaults;
      setDraft(defaultsToDraft(serverDefaults));
      setInvalidFields(new Set<DefaultsFieldId>());
    }
  }, [serverDefaults]);

  const dirty = isDraftDirty(draft, serverDefaults);
  const atCoreDefaults = isDraftAtCoreDefaults(draft);

  const updateDraft = (updater: (prev: DefaultsDraft) => DefaultsDraft): void => {
    setDraft(updater);
    if (invalidFields.size > 0) {
      setInvalidFields(new Set<DefaultsFieldId>());
    }
    if (savedNotice || saveError !== null) {
      onClearFeedback();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving || !dirty) {
      return;
    }
    const parsed = parseDefaultsDraft(draft);
    if (!parsed.ok) {
      setInvalidFields(parsed.invalidFields);
      return;
    }
    setInvalidFields(new Set<DefaultsFieldId>());
    await onSave(parsed.value);
  };

  const handleDiscard = (): void => {
    setDraft(defaultsToDraft(serverDefaults));
    setInvalidFields(new Set<DefaultsFieldId>());
    onClearFeedback();
  };

  const handleResetToDefaults = (): void => {
    setDraft(defaultsToDraft(CORE_DEFAULTS));
    setInvalidFields(new Set<DefaultsFieldId>());
    onClearFeedback();
  };

  const maxConcurrentId = `${idBase}-concurrent`;
  const maxAttemptsId = `${idBase}-attempts`;
  const onExhaustedId = `${idBase}-exhausted`;
  const acceleratorId = `${idBase}-accelerator`;
  const highMemId = `${idBase}-high-mem`;
  const maxSpendId = `${idBase}-max-spend`;
  const minBalanceId = `${idBase}-min-balance`;
  const minVramId = `${idBase}-min-vram`;

  return (
    <section className="card settings-section">
      <div className="card-heading">
        <h2 className="card-title">{t("app.defaults.title")}</h2>
        <p className="card-desc">{t("app.defaults.description")}</p>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.max_runtime")}</span>
              <p className="settings-row-desc">{t("app.def.max_runtime_hint")}</p>
            </div>
            <div className="settings-row-control">
              <div className="optional-control">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  checked={draft.max_runtime_enabled}
                  disabled={saving}
                  aria-label={`${t("app.def.max_runtime")} — ${t("app.def.limit")}`}
                  onChange={(event) =>
                    updateDraft((prev) =>
                      toggleOptionalField(prev, "max_runtime", event.target.checked),
                    )
                  }
                />
                {draft.max_runtime_enabled ? (
                  <DurationInputs
                    idPrefix={`${idBase}-max-runtime`}
                    legend={t("app.def.max_runtime")}
                    value={draft.max_runtime}
                    withSeconds={false}
                    invalid={invalidFields.has("max_runtime")}
                    disabled={saving}
                    t={t}
                    onChange={(next) => updateDraft((prev) => ({ ...prev, max_runtime: next }))}
                  />
                ) : (
                  <span className="caption">{t("app.def.no_limit")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={maxSpendId}>
                {t("app.def.max_spend")}
              </label>
              <p className="settings-row-desc">{t("app.def.max_spend_hint")}</p>
            </div>
            <div className="settings-row-control">
              <div className="optional-control">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  checked={draft.max_spend_enabled}
                  disabled={saving}
                  aria-label={`${t("app.def.max_spend")} — ${t("app.def.limit")}`}
                  onChange={(event) =>
                    updateDraft((prev) =>
                      toggleOptionalField(prev, "max_spend_cu", event.target.checked),
                    )
                  }
                />
                {draft.max_spend_enabled ? (
                  <div className="unit-field">
                    <input
                      id={maxSpendId}
                      type="number"
                      inputMode="decimal"
                      className="input input-sm input-num"
                      min={MIN_CU_FIELD}
                      max={MAX_CU_FIELD}
                      step={CU_INPUT_STEP}
                      value={draft.max_spend_cu}
                      disabled={saving}
                      aria-invalid={invalidFields.has("max_spend_cu") ? "true" : undefined}
                      onChange={(event) =>
                        updateDraft((prev) => ({ ...prev, max_spend_cu: event.target.value }))
                      }
                    />
                    <span className="unit-suffix">{t("app.unit.cu")}</span>
                  </div>
                ) : (
                  <span className="caption">{t("app.def.no_limit")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={minBalanceId}>
                {t("app.def.min_balance")}
              </label>
              <p className="settings-row-desc">{t("app.def.min_balance_hint")}</p>
            </div>
            <div className="settings-row-control">
              <div className="optional-control">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  checked={draft.min_balance_enabled}
                  disabled={saving}
                  aria-label={`${t("app.def.min_balance")} — ${t("app.def.limit")}`}
                  onChange={(event) =>
                    updateDraft((prev) =>
                      toggleOptionalField(prev, "min_balance_cu", event.target.checked),
                    )
                  }
                />
                {draft.min_balance_enabled ? (
                  <div className="unit-field">
                    <input
                      id={minBalanceId}
                      type="number"
                      inputMode="decimal"
                      className="input input-sm input-num"
                      min={MIN_CU_FIELD}
                      max={MAX_CU_FIELD}
                      step={CU_INPUT_STEP}
                      value={draft.min_balance_cu}
                      disabled={saving}
                      aria-invalid={invalidFields.has("min_balance_cu") ? "true" : undefined}
                      onChange={(event) =>
                        updateDraft((prev) => ({ ...prev, min_balance_cu: event.target.value }))
                      }
                    />
                    <span className="unit-suffix">{t("app.unit.cu")}</span>
                  </div>
                ) : (
                  <span className="caption">{t("app.def.no_limit")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.idle")}</span>
              <p className="settings-row-desc">{t("app.def.idle_hint")}</p>
            </div>
            <div className="settings-row-control">
              <div className="optional-control">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  checked={draft.idle_timeout_enabled}
                  disabled={saving}
                  aria-label={`${t("app.def.idle")} — ${t("app.def.limit")}`}
                  onChange={(event) =>
                    updateDraft((prev) =>
                      toggleOptionalField(prev, "idle_timeout", event.target.checked),
                    )
                  }
                />
                {draft.idle_timeout_enabled ? (
                  <DurationInputs
                    idPrefix={`${idBase}-idle`}
                    legend={t("app.def.idle")}
                    value={draft.idle_timeout}
                    withSeconds={false}
                    invalid={invalidFields.has("idle_timeout")}
                    disabled={saving}
                    t={t}
                    onChange={(next) => updateDraft((prev) => ({ ...prev, idle_timeout: next }))}
                  />
                ) : (
                  <span className="caption">{t("app.def.no_limit")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={maxConcurrentId}>
                {t("app.def.concurrent")}
              </label>
              <p className="settings-row-desc">{t("app.def.concurrent_hint")}</p>
            </div>
            <div className="settings-row-control">
              <input
                id={maxConcurrentId}
                name="max_concurrent_sessions"
                type="number"
                inputMode="numeric"
                className="input input-sm input-num"
                min={MIN_CONCURRENT_SESSIONS}
                max={MAX_CONCURRENT_SESSIONS}
                step={1}
                value={draft.max_concurrent_sessions}
                disabled={saving}
                aria-invalid={invalidFields.has("max_concurrent_sessions") ? "true" : undefined}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    max_concurrent_sessions: event.target.value,
                  }))
                }
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={maxAttemptsId}>
                {t("app.def.attempts")}
              </label>
              <p className="settings-row-desc">
                {t("app.def.attempts_hint", { cap: MAX_ATTEMPTS_CAP })}
              </p>
            </div>
            <div className="settings-row-control">
              <input
                id={maxAttemptsId}
                name="max_attempts"
                type="number"
                inputMode="numeric"
                className="input input-sm input-num"
                min={MIN_ATTEMPTS}
                max={MAX_ATTEMPTS_CAP}
                step={1}
                value={draft.max_attempts}
                disabled={saving}
                aria-invalid={invalidFields.has("max_attempts") ? "true" : undefined}
                onChange={(event) =>
                  updateDraft((prev) => ({ ...prev, max_attempts: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.retry_delay")}</span>
            </div>
            <div className="settings-row-control">
              <DurationInputs
                idPrefix={`${idBase}-retry-delay`}
                legend={t("app.def.retry_delay")}
                value={draft.retry_delay}
                withSeconds={true}
                invalid={invalidFields.has("retry_delay")}
                disabled={saving}
                t={t}
                onChange={(next) => updateDraft((prev) => ({ ...prev, retry_delay: next }))}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={onExhaustedId}>
                {t("app.def.on_exhausted")}
              </label>
            </div>
            <div className="settings-row-control">
              <select
                id={onExhaustedId}
                name="on_exhausted"
                className="select select-sm select-inline"
                value={draft.on_exhausted}
                disabled={saving}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    on_exhausted: event.target.value as OnExhausted,
                  }))
                }
              >
                {ON_EXHAUSTED_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {t(ON_EXHAUSTED_LABEL_KEYS[option])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={acceleratorId}>
                {t("app.def.accelerator")}
              </label>
            </div>
            <div className="settings-row-control">
              <select
                id={acceleratorId}
                name="accelerator"
                className="select select-sm select-inline"
                value={draft.accelerator}
                disabled={saving}
                onChange={(event) =>
                  updateDraft((prev) => ({
                    ...prev,
                    accelerator: event.target.value as Accelerator,
                  }))
                }
              >
                {ACCELERATOR_OPTIONS.map((acc) => (
                  <option key={acc} value={acc}>
                    {t(ACCELERATOR_LABEL_KEYS[acc])}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={highMemId}>
                {t("app.def.high_mem")}
              </label>
            </div>
            <div className="settings-row-control">
              <input
                id={highMemId}
                name="high_mem"
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={draft.high_mem}
                disabled={saving}
                onChange={(event) =>
                  updateDraft((prev) => ({ ...prev, high_mem: event.target.checked }))
                }
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <label className="settings-row-title" htmlFor={minVramId}>
                {t("app.def.min_vram")}
              </label>
              <p className="settings-row-desc">{t("app.def.min_vram_hint")}</p>
            </div>
            <div className="settings-row-control">
              <div className="optional-control">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch-input"
                  checked={draft.min_vram_enabled}
                  disabled={saving}
                  aria-label={`${t("app.def.min_vram")} — ${t("app.def.limit")}`}
                  onChange={(event) =>
                    updateDraft((prev) =>
                      toggleOptionalField(prev, "min_vram_mib", event.target.checked),
                    )
                  }
                />
                {draft.min_vram_enabled ? (
                  <div className="unit-field">
                    <input
                      id={minVramId}
                      type="number"
                      inputMode="numeric"
                      className="input input-sm input-num"
                      min={MIN_VRAM_GIB}
                      max={MAX_VRAM_GIB}
                      step={1}
                      value={draft.min_vram_gib}
                      disabled={saving}
                      aria-invalid={invalidFields.has("min_vram_mib") ? "true" : undefined}
                      onChange={(event) =>
                        updateDraft((prev) => ({ ...prev, min_vram_gib: event.target.value }))
                      }
                    />
                    <span className="unit-suffix">{t("app.unit.gb")}</span>
                  </div>
                ) : (
                  <span className="caption">{t("app.def.no_limit")}</span>
                )}
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.winddown")}</span>
              <p className="settings-row-desc">{t("app.def.winddown_hint")}</p>
            </div>
            <div className="settings-row-control">
              <DurationInputs
                idPrefix={`${idBase}-winddown`}
                legend={t("app.def.winddown")}
                value={draft.winddown_grace}
                withSeconds={true}
                invalid={invalidFields.has("winddown_grace")}
                disabled={saving}
                t={t}
                onChange={(next) => updateDraft((prev) => ({ ...prev, winddown_grace: next }))}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.poll_active")}</span>
              <p className="settings-row-desc">{t("app.def.poll_hint")}</p>
            </div>
            <div className="settings-row-control">
              <DurationInputs
                idPrefix={`${idBase}-poll-active`}
                legend={t("app.def.poll_active")}
                value={draft.usage_poll_active}
                withSeconds={true}
                invalid={invalidFields.has("usage_poll_active")}
                disabled={saving}
                t={t}
                onChange={(next) => updateDraft((prev) => ({ ...prev, usage_poll_active: next }))}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">{t("app.def.poll_idle")}</span>
            </div>
            <div className="settings-row-control">
              <DurationInputs
                idPrefix={`${idBase}-poll-idle`}
                legend={t("app.def.poll_idle")}
                value={draft.usage_poll_idle}
                withSeconds={true}
                invalid={invalidFields.has("usage_poll_idle")}
                disabled={saving}
                t={t}
                onChange={(next) => updateDraft((prev) => ({ ...prev, usage_poll_idle: next }))}
              />
            </div>
          </div>
        </div>

        <div className="form-footer">
          <div>
            {invalidFields.size > 0 ? (
              <span className="inline-msg inline-msg-danger" role="alert">
                <AlertIcon />
                <span className="inline-msg-text">{t("app.err.invalid_input")}</span>
              </span>
            ) : saveError !== null ? (
              <span className="inline-msg inline-msg-danger" role="alert">
                <AlertIcon />
                <span className="inline-msg-text">{saveError}</span>
              </span>
            ) : dirty ? (
              <span className="inline-msg inline-msg-warning" role="status">
                <AlertIcon />
                <span className="inline-msg-text">{t("web.settings.unsaved")}</span>
              </span>
            ) : savedNotice ? (
              <span className="inline-msg inline-msg-success" role="status">
                <CheckCircleIcon />
                <span className="inline-msg-text">{t("web.settings.saved")}</span>
              </span>
            ) : null}
          </div>

          <div className="form-footer-actions">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={saving || atCoreDefaults}
              onClick={handleResetToDefaults}
            >
              {t("app.def.reset")}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving || !dirty}
              onClick={handleDiscard}
            >
              {t("web.settings.discard")}
            </button>
            <button
              type="submit"
              className="btn btn-sm btn-primary"
              disabled={saving || !dirty}
              aria-busy={saving || undefined}
            >
              {saving && <span className="spinner" aria-hidden="true" />}
              <span>{t("app.b2.action_save")}</span>
            </button>
          </div>
        </div>
      </form>
    </section>
  );
});
