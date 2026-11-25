/**
 * Reusable Provision hardware, retry, and cost-guard form rows shared by
 * `NewSessionDialog` and future plugin deploy forms (`#50`).
 *
 * Imports every numeric bound, conversion factor, and initial toggle value from
 * `lib/constants.ts` so no UI constant is duplicated across forms.
 */

import { useId } from "react";

import {
  ACCELERATOR_OPTIONS,
  CU_INPUT_STEP,
  MAX_ATTEMPTS_CAP,
  MAX_CU_FIELD,
  MAX_DURATION_HOURS,
  MAX_DURATION_MINUTES,
  MAX_VRAM_GIB,
  MIB_PER_GIB,
  MIN_ATTEMPTS,
  MIN_CU_FIELD,
  MIN_DURATION_SECS,
  MIN_VRAM_GIB,
  MINUTES_PER_HOUR,
  ON_EXHAUSTED_OPTIONS,
  SECS_PER_HOUR,
  SECS_PER_MINUTE,
  START_IDLE_TIMEOUT_SECS,
  START_MAX_RUNTIME_SECS,
  START_MAX_SPEND_CU,
  START_MIN_BALANCE_CU,
  START_MIN_VRAM_GIB,
  type OnExhausted,
} from "../../lib/constants.ts";
import { formatCuRate, formatRelativeAge } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Accelerator, Locale, RateReading, Runtime } from "../../lib/types.ts";
import type { ProvisionSpec } from "./api.ts";
import { getServerNowSecs } from "./clock.tsx";
import { formatApprox } from "./format.ts";

export const MAX_SESSION_NAME_LEN = 63;
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGER_RE = /^\d+$/;

const ACCELERATOR_LABEL_KEYS: Readonly<Record<Accelerator, string>> = {
  NONE: "app.acc.none",
  T4: "app.acc.t4",
  L4: "app.acc.l4",
  G4: "app.acc.g4",
  A100: "app.acc.a100",
  H100: "app.acc.h100",
  V5E1: "app.acc.v5e1",
  V6E1: "app.acc.v6e1",
};

const ON_EXHAUSTED_LABEL_KEYS: Readonly<Record<OnExhausted, string>> = {
  stop_and_fail: "app.def.exhausted_stop",
  keep_last: "app.def.exhausted_keep",
};

const GPU_ACCELERATORS: ReadonlySet<Accelerator> = new Set<Accelerator>([
  "T4",
  "L4",
  "G4",
  "A100",
  "H100",
]);

const SINGLE_SHAPE_ACCELERATORS: ReadonlySet<Accelerator> = new Set<Accelerator>([
  "L4",
  "V5E1",
  "V6E1",
]);

/** Published burn rates (CU/h) mirroring `crates/core/src/usage.rs::published_rate`. */
const PUBLISHED_RATES_STANDARD: Readonly<Record<Accelerator, number>> = {
  NONE: 0.08,
  T4: 1.07,
  L4: 1.54,
  G4: 8.9,
  A100: 5.3,
  H100: 18.05,
  V5E1: 2.92,
  V6E1: 4.08,
};

const PUBLISHED_RATES_HIGH_MEM: Readonly<Record<Accelerator, number>> = {
  NONE: 0.26,
  T4: 1.41,
  L4: 1.54,
  G4: 8.9,
  A100: 6.77,
  H100: 18.05,
  V5E1: 2.92,
  V6E1: 4.08,
};

export interface ProvisionDurationDraft {
  readonly hours: string;
  readonly minutes: string;
}

export interface ProvisionDraft {
  readonly accelerator: Accelerator;
  readonly high_mem: boolean;
  readonly min_vram_enabled: boolean;
  readonly min_vram_gib: string;
  readonly max_attempts: string;
  readonly on_exhausted: OnExhausted;
  readonly max_runtime_enabled: boolean;
  readonly max_runtime: ProvisionDurationDraft;
  readonly max_spend_enabled: boolean;
  readonly max_spend_cu: string;
  readonly min_balance_enabled: boolean;
  readonly min_balance_cu: string;
  readonly idle_timeout_enabled: boolean;
  readonly idle_timeout: ProvisionDurationDraft;
}

export type ProvisionFieldErrorId =
  | "name"
  | "min_vram_mib"
  | "max_attempts"
  | "max_runtime"
  | "max_spend_cu"
  | "min_balance_cu"
  | "idle_timeout";

export function acceleratorIsGpu(accelerator: Accelerator): boolean {
  return GPU_ACCELERATORS.has(accelerator);
}

export function acceleratorSupportsHighMem(accelerator: Accelerator): boolean {
  return !SINGLE_SHAPE_ACCELERATORS.has(accelerator);
}

/** Mirrors `crates/core/src/backend.rs::accelerator_prefix`. */
export function acceleratorPrefix(accelerator: Accelerator): string {
  return accelerator === "NONE" ? "cpu" : accelerator.toLowerCase();
}

export function publishedRate(accelerator: Accelerator, highMem: boolean): number {
  const effectiveHighMem = highMem && acceleratorSupportsHighMem(accelerator);
  return effectiveHighMem
    ? PUBLISHED_RATES_HIGH_MEM[accelerator]
    : PUBLISHED_RATES_STANDARD[accelerator];
}

/** Mirrors `crates/core/src/sessions.rs::validate_session_name`. */
export function validateSessionName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SESSION_NAME_LEN && SESSION_NAME_RE.test(name);
}

/**
 * Finds the latest measured burn rate across known runtimes matching the selected
 * `(accelerator, effectiveHighMem)` machine shape.
 */
export function findMeasuredRate(
  runtimes: readonly Runtime[] | null | undefined,
  accelerator: Accelerator,
  highMem: boolean,
): RateReading | null {
  if (!runtimes || runtimes.length === 0) {
    return null;
  }
  const effectiveHighMem = highMem && acceleratorSupportsHighMem(accelerator);
  let latest: RateReading | null = null;
  for (const rt of runtimes) {
    const tracked = rt.tracked;
    if (!tracked?.measured_rate) {
      continue;
    }
    const rtHighMem = tracked.high_mem && acceleratorSupportsHighMem(tracked.accelerator);
    if (tracked.accelerator !== accelerator || rtHighMem !== effectiveHighMem) {
      continue;
    }
    if (!latest || tracked.measured_rate.at > latest.at) {
      latest = tracked.measured_rate;
    }
  }
  return latest;
}

function secsToDurationDraft(totalSecs: number): ProvisionDurationDraft {
  const safe = Math.max(0, Math.round(totalSecs));
  if (safe > 0 && safe < SECS_PER_MINUTE) {
    return { hours: "0", minutes: "1" };
  }
  const hours = Math.min(MAX_DURATION_HOURS, Math.floor(safe / SECS_PER_HOUR));
  const minutes = Math.floor((safe % SECS_PER_HOUR) / SECS_PER_MINUTE) % MINUTES_PER_HOUR;
  return { hours: String(hours), minutes: String(minutes) };
}

function parseIntInRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!INTEGER_RE.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseFloatInRange(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

function parseDurationSecs(draft: ProvisionDurationDraft): number | null {
  const hours = parseIntInRange(draft.hours, 0, MAX_DURATION_HOURS);
  const minutes = parseIntInRange(draft.minutes, 0, MAX_DURATION_MINUTES);
  if (hours === null || minutes === null) {
    return null;
  }
  const total = hours * SECS_PER_HOUR + minutes * SECS_PER_MINUTE;
  if (total < MIN_DURATION_SECS) {
    return null;
  }
  return total;
}

export function specToProvisionDraft(spec: ProvisionSpec): ProvisionDraft {
  const supportsHighMem = acceleratorSupportsHighMem(spec.accelerator);
  const isGpu = acceleratorIsGpu(spec.accelerator);
  const minVramMib = isGpu && spec.min_vram_mib !== null && spec.min_vram_mib > 0
    ? spec.min_vram_mib
    : null;
  const clampedAttempts = Math.min(
    MAX_ATTEMPTS_CAP,
    Math.max(MIN_ATTEMPTS, Math.round(spec.max_attempts)),
  );
  return {
    accelerator: spec.accelerator,
    high_mem: supportsHighMem && spec.high_mem,
    min_vram_enabled: minVramMib !== null,
    min_vram_gib: String(
      minVramMib !== null
        ? Math.max(MIN_VRAM_GIB, Math.round(minVramMib / MIB_PER_GIB))
        : START_MIN_VRAM_GIB,
    ),
    max_attempts: String(clampedAttempts),
    on_exhausted: spec.on_exhausted,
    max_runtime_enabled: spec.guard.max_runtime !== null,
    max_runtime: secsToDurationDraft(spec.guard.max_runtime ?? START_MAX_RUNTIME_SECS),
    max_spend_enabled: spec.guard.max_spend_cu !== null,
    max_spend_cu: String(spec.guard.max_spend_cu ?? START_MAX_SPEND_CU),
    min_balance_enabled: spec.guard.min_balance_cu !== null,
    min_balance_cu: String(spec.guard.min_balance_cu ?? START_MIN_BALANCE_CU),
    idle_timeout_enabled: spec.guard.idle_timeout !== null,
    idle_timeout: secsToDurationDraft(spec.guard.idle_timeout ?? START_IDLE_TIMEOUT_SECS),
  };
}

function durationDraftEqual(a: ProvisionDurationDraft, b: ProvisionDurationDraft): boolean {
  return a.hours.trim() === b.hours.trim() && a.minutes.trim() === b.minutes.trim();
}

export type BuildProvisionSpecResult =
  | { readonly ok: true; readonly spec: ProvisionSpec }
  | { readonly ok: false; readonly invalidFields: ReadonlySet<ProvisionFieldErrorId> };

/**
 * Validates `draft` and builds a `ProvisionSpec`. When `baseSpec` is supplied,
 * untouched fields preserve exact backend values (such as sub-minute durations
 * or non-GiB-aligned `min_vram_mib`) instead of rounding them through UI inputs.
 */
export function buildProvisionSpecFromDraft(
  name: string,
  draft: ProvisionDraft,
  retryDelaySecs: number,
  baseSpec?: ProvisionSpec | null,
): BuildProvisionSpecResult {
  const initialDraft = baseSpec ? specToProvisionDraft(baseSpec) : null;
  const invalidFields = new Set<ProvisionFieldErrorId>();
  const trimmedName = name.trim();
  if (!validateSessionName(trimmedName)) {
    invalidFields.add("name");
  }

  const isGpu = acceleratorIsGpu(draft.accelerator);
  let minVramMib: number | null = null;
  if (isGpu && draft.min_vram_enabled) {
    if (
      baseSpec &&
      initialDraft &&
      initialDraft.min_vram_enabled &&
      baseSpec.min_vram_mib !== null &&
      baseSpec.min_vram_mib > 0 &&
      draft.min_vram_gib.trim() === initialDraft.min_vram_gib.trim()
    ) {
      minVramMib = baseSpec.min_vram_mib;
    } else {
      const parsedGib = parseIntInRange(draft.min_vram_gib, MIN_VRAM_GIB, MAX_VRAM_GIB);
      if (parsedGib === null) {
        invalidFields.add("min_vram_mib");
      } else {
        minVramMib = parsedGib * MIB_PER_GIB;
      }
    }
  }

  let maxAttempts: number | null;
  if (
    baseSpec &&
    initialDraft &&
    draft.max_attempts.trim() === initialDraft.max_attempts.trim()
  ) {
    maxAttempts = Math.min(
      MAX_ATTEMPTS_CAP,
      Math.max(MIN_ATTEMPTS, Math.round(baseSpec.max_attempts)),
    );
  } else {
    maxAttempts = parseIntInRange(draft.max_attempts, MIN_ATTEMPTS, MAX_ATTEMPTS_CAP);
    if (maxAttempts === null) {
      invalidFields.add("max_attempts");
    }
  }

  let maxRuntime: number | null = null;
  if (draft.max_runtime_enabled) {
    if (
      baseSpec &&
      initialDraft &&
      initialDraft.max_runtime_enabled &&
      baseSpec.guard.max_runtime !== null &&
      durationDraftEqual(draft.max_runtime, initialDraft.max_runtime)
    ) {
      maxRuntime = baseSpec.guard.max_runtime;
    } else {
      maxRuntime = parseDurationSecs(draft.max_runtime);
      if (maxRuntime === null) {
        invalidFields.add("max_runtime");
      }
    }
  }

  let maxSpendCu: number | null = null;
  if (draft.max_spend_enabled) {
    if (
      baseSpec &&
      initialDraft &&
      initialDraft.max_spend_enabled &&
      baseSpec.guard.max_spend_cu !== null &&
      draft.max_spend_cu.trim() === initialDraft.max_spend_cu.trim()
    ) {
      maxSpendCu = baseSpec.guard.max_spend_cu;
    } else {
      maxSpendCu = parseFloatInRange(draft.max_spend_cu, MIN_CU_FIELD, MAX_CU_FIELD);
      if (maxSpendCu === null) {
        invalidFields.add("max_spend_cu");
      }
    }
  }

  let minBalanceCu: number | null = null;
  if (draft.min_balance_enabled) {
    if (
      baseSpec &&
      initialDraft &&
      initialDraft.min_balance_enabled &&
      baseSpec.guard.min_balance_cu !== null &&
      draft.min_balance_cu.trim() === initialDraft.min_balance_cu.trim()
    ) {
      minBalanceCu = baseSpec.guard.min_balance_cu;
    } else {
      minBalanceCu = parseFloatInRange(draft.min_balance_cu, MIN_CU_FIELD, MAX_CU_FIELD);
      if (minBalanceCu === null) {
        invalidFields.add("min_balance_cu");
      }
    }
  }

  let idleTimeout: number | null = null;
  if (draft.idle_timeout_enabled) {
    if (
      baseSpec &&
      initialDraft &&
      initialDraft.idle_timeout_enabled &&
      baseSpec.guard.idle_timeout !== null &&
      durationDraftEqual(draft.idle_timeout, initialDraft.idle_timeout)
    ) {
      idleTimeout = baseSpec.guard.idle_timeout;
    } else {
      idleTimeout = parseDurationSecs(draft.idle_timeout);
      if (idleTimeout === null) {
        invalidFields.add("idle_timeout");
      }
    }
  }

  if (invalidFields.size > 0 || maxAttempts === null) {
    return { ok: false, invalidFields };
  }

  return {
    ok: true,
    spec: {
      name: trimmedName,
      accelerator: draft.accelerator,
      high_mem: acceleratorSupportsHighMem(draft.accelerator) && draft.high_mem,
      min_vram_mib: minVramMib,
      max_attempts: maxAttempts,
      retry_delay: Math.max(0, Math.floor(retryDelaySecs)),
      on_exhausted: draft.on_exhausted,
      guard: {
        max_runtime: maxRuntime,
        max_spend_cu: maxSpendCu,
        min_balance_cu: minBalanceCu,
        idle_timeout: idleTimeout,
      },
    },
  };
}

function toggleOptionalLimit(
  draft: ProvisionDraft,
  field: "min_vram_mib" | "max_runtime" | "max_spend_cu" | "min_balance_cu" | "idle_timeout",
  enabled: boolean,
): ProvisionDraft {
  switch (field) {
    case "min_vram_mib": {
      const nextVram =
        enabled && parseIntInRange(draft.min_vram_gib, MIN_VRAM_GIB, MAX_VRAM_GIB) === null
          ? String(START_MIN_VRAM_GIB)
          : draft.min_vram_gib;
      return { ...draft, min_vram_enabled: enabled, min_vram_gib: nextVram };
    }
    case "max_runtime": {
      const nextRuntime =
        enabled && parseDurationSecs(draft.max_runtime) === null
          ? secsToDurationDraft(START_MAX_RUNTIME_SECS)
          : draft.max_runtime;
      return { ...draft, max_runtime_enabled: enabled, max_runtime: nextRuntime };
    }
    case "max_spend_cu": {
      const nextSpend =
        enabled && parseFloatInRange(draft.max_spend_cu, MIN_CU_FIELD, MAX_CU_FIELD) === null
          ? String(START_MAX_SPEND_CU)
          : draft.max_spend_cu;
      return { ...draft, max_spend_enabled: enabled, max_spend_cu: nextSpend };
    }
    case "min_balance_cu": {
      const nextBalance =
        enabled && parseFloatInRange(draft.min_balance_cu, MIN_CU_FIELD, MAX_CU_FIELD) === null
          ? String(START_MIN_BALANCE_CU)
          : draft.min_balance_cu;
      return { ...draft, min_balance_enabled: enabled, min_balance_cu: nextBalance };
    }
    case "idle_timeout": {
      const nextIdle =
        enabled && parseDurationSecs(draft.idle_timeout) === null
          ? secsToDurationDraft(START_IDLE_TIMEOUT_SECS)
          : draft.idle_timeout;
      return { ...draft, idle_timeout_enabled: enabled, idle_timeout: nextIdle };
    }
  }
}

interface ProvisionDurationInputsProps {
  readonly idPrefix: string;
  readonly namePrefix: string;
  readonly legend: string;
  readonly value: ProvisionDurationDraft;
  readonly invalid: boolean;
  readonly disabled: boolean;
  readonly errorId?: string;
  readonly t: TranslateFn;
  readonly onChange: (next: ProvisionDurationDraft) => void;
}

function ProvisionDurationInputs({
  idPrefix,
  namePrefix,
  legend,
  value,
  invalid,
  disabled,
  errorId,
  t,
  onChange,
}: ProvisionDurationInputsProps) {
  return (
    <fieldset className="settings-fieldset">
      <legend className="visually-hidden">{legend}</legend>
      <div className="duration-group">
        <label className="unit-field" htmlFor={`${idPrefix}-hours`}>
          <input
            id={`${idPrefix}-hours`}
            name={`${namePrefix}_hours`}
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            min={0}
            max={MAX_DURATION_HOURS}
            step={1}
            value={value.hours}
            disabled={disabled}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => onChange({ ...value, hours: event.target.value })}
          />
          <span className="unit-suffix">{t("app.b3.unit_hours")}</span>
        </label>

        <label className="unit-field" htmlFor={`${idPrefix}-minutes`}>
          <input
            id={`${idPrefix}-minutes`}
            name={`${namePrefix}_minutes`}
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            min={0}
            max={MAX_DURATION_MINUTES}
            step={1}
            value={value.minutes}
            disabled={disabled}
            aria-invalid={invalid ? "true" : undefined}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(event) => onChange({ ...value, minutes: event.target.value })}
          />
          <span className="unit-suffix">{t("app.b3.unit_minutes")}</span>
        </label>
      </div>
    </fieldset>
  );
}

export interface ProvisionFieldsChangeMeta {
  readonly acceleratorChanged?: {
    readonly prev: Accelerator;
    readonly next: Accelerator;
  };
}

export interface ProvisionFieldsProps {
  readonly draft: ProvisionDraft;
  readonly invalidFields: ReadonlySet<ProvisionFieldErrorId>;
  readonly disabled: boolean;
  readonly measuredRate?: RateReading | null;
  readonly errorSummaryId?: string;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onChange: (next: ProvisionDraft, meta?: ProvisionFieldsChangeMeta) => void;
}

export function ProvisionFields({
  draft,
  invalidFields,
  disabled,
  measuredRate = null,
  errorSummaryId,
  locale,
  t,
  onChange,
}: ProvisionFieldsProps) {
  const idBase = useId();
  const acceleratorId = `${idBase}-accelerator`;
  const highMemId = `${idBase}-high-mem`;
  const minVramId = `${idBase}-min-vram`;
  const attemptsId = `${idBase}-attempts`;
  const onExhaustedId = `${idBase}-on-exhausted`;
  const maxSpendId = `${idBase}-max-spend`;
  const minBalanceId = `${idBase}-min-balance`;

  const supportsHighMem = acceleratorSupportsHighMem(draft.accelerator);
  const isGpu = acceleratorIsGpu(draft.accelerator);
  const effectiveHighMem = supportsHighMem && draft.high_mem;

  const rateValue = measuredRate
    ? formatApprox(formatCuRate(measuredRate.cu_per_hour, locale, t), t)
    : formatApprox(formatCuRate(publishedRate(draft.accelerator, effectiveHighMem), locale, t), t);
  const rateHint = measuredRate
    ? t("app.b13.prov_rate_measured", {
        age: formatRelativeAge(Math.max(0, getServerNowSecs() - measuredRate.at), t),
      })
    : t("app.b13.prov_rate_published");

  return (
    <div className="prov-list" data-provision-fields="true">
      <div className="prov-row" data-prov-field="accelerator">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={acceleratorId}>
            {t("app.def.accelerator")}
          </label>
        </div>
        <div className="prov-row-control">
          <select
            id={acceleratorId}
            name="accelerator"
            className="select select-sm select-inline"
            data-prov-accelerator="true"
            value={draft.accelerator}
            disabled={disabled}
            onChange={(event) => {
              const nextAcc = event.target.value as Accelerator;
              const nextDraft: ProvisionDraft = {
                ...draft,
                accelerator: nextAcc,
                high_mem: acceleratorSupportsHighMem(nextAcc) ? draft.high_mem : false,
              };
              onChange(nextDraft, {
                acceleratorChanged: { prev: draft.accelerator, next: nextAcc },
              });
            }}
          >
            {ACCELERATOR_OPTIONS.map((acc) => (
              <option key={acc} value={acc}>
                {t(ACCELERATOR_LABEL_KEYS[acc])}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="prov-row" data-prov-field="high_mem">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={highMemId}>
            {t("app.def.high_mem")}
          </label>
        </div>
        <div className="prov-row-control">
          <input
            id={highMemId}
            name="high_mem"
            type="checkbox"
            role="switch"
            className="switch-input"
            data-prov-high-mem="true"
            checked={effectiveHighMem}
            disabled={disabled || !supportsHighMem}
            onChange={(event) => onChange({ ...draft, high_mem: event.target.checked })}
          />
        </div>
      </div>

      <div className="prov-row" data-prov-field="rate">
        <div className="prov-row-info">
          <span className="field-label">{t("app.b2.runtime_rate")}</span>
          <span className="caption">{rateHint}</span>
        </div>
        <div className="prov-row-control">
          <span className="dialog-paragraph" data-prov-rate="true">
            {rateValue}
          </span>
        </div>
      </div>

      {isGpu && (
        <div className="prov-row" data-prov-field="min_vram">
          <div className="prov-row-info">
            <label className="field-label" htmlFor={minVramId}>
              {t("app.def.min_vram")}
            </label>
            <span className="caption">{t("app.b2.prov_vram_lottery")}</span>
          </div>
          <div className="prov-row-control">
            <div className="optional-control">
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                data-prov-min-vram-toggle="true"
                checked={draft.min_vram_enabled}
                disabled={disabled}
                aria-label={`${t("app.def.min_vram")} — ${t("app.def.limit")}`}
                onChange={(event) =>
                  onChange(toggleOptionalLimit(draft, "min_vram_mib", event.target.checked))
                }
              />
              {draft.min_vram_enabled ? (
                <div className="unit-field">
                  <input
                    id={minVramId}
                    name="min_vram_gib"
                    type="number"
                    inputMode="numeric"
                    className="input input-sm input-num"
                    data-prov-min-vram-gib="true"
                    min={MIN_VRAM_GIB}
                    max={MAX_VRAM_GIB}
                    step={1}
                    value={draft.min_vram_gib}
                    disabled={disabled}
                    aria-invalid={invalidFields.has("min_vram_mib") ? "true" : undefined}
                    aria-describedby={
                      invalidFields.has("min_vram_mib") ? errorSummaryId : undefined
                    }
                    onChange={(event) => onChange({ ...draft, min_vram_gib: event.target.value })}
                  />
                  <span className="unit-suffix">{t("app.unit.gb")}</span>
                </div>
              ) : (
                <span className="caption">{t("app.def.no_limit")}</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="prov-row" data-prov-field="attempts">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={attemptsId}>
            {t("app.def.attempts")}
          </label>
          <span className="caption">{t("app.b2.prov_attempts_billed")}</span>
        </div>
        <div className="prov-row-control">
          <input
            id={attemptsId}
            name="max_attempts"
            type="number"
            inputMode="numeric"
            className="input input-sm input-num"
            data-prov-attempts="true"
            min={MIN_ATTEMPTS}
            max={MAX_ATTEMPTS_CAP}
            step={1}
            value={draft.max_attempts}
            disabled={disabled}
            aria-invalid={invalidFields.has("max_attempts") ? "true" : undefined}
            aria-describedby={invalidFields.has("max_attempts") ? errorSummaryId : undefined}
            onChange={(event) => onChange({ ...draft, max_attempts: event.target.value })}
          />
        </div>
      </div>

      <div className="prov-row" data-prov-field="on_exhausted">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={onExhaustedId}>
            {t("app.def.on_exhausted")}
          </label>
        </div>
        <div className="prov-row-control">
          <select
            id={onExhaustedId}
            name="on_exhausted"
            className="select select-sm select-inline"
            data-prov-on-exhausted="true"
            value={draft.on_exhausted}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, on_exhausted: event.target.value as OnExhausted })
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

      <div className="prov-row" data-prov-field="max_runtime">
        <div className="prov-row-info">
          <span className="field-label">{t("app.def.max_runtime")}</span>
          <span className="caption">{t("app.def.max_runtime_hint")}</span>
        </div>
        <div className="prov-row-control">
          <div className="optional-control">
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={draft.max_runtime_enabled}
              disabled={disabled}
              aria-label={`${t("app.def.max_runtime")} — ${t("app.def.limit")}`}
              onChange={(event) =>
                onChange(toggleOptionalLimit(draft, "max_runtime", event.target.checked))
              }
            />
            {draft.max_runtime_enabled ? (
              <ProvisionDurationInputs
                idPrefix={`${idBase}-max-runtime`}
                namePrefix="max_runtime"
                legend={t("app.def.max_runtime")}
                value={draft.max_runtime}
                invalid={invalidFields.has("max_runtime")}
                disabled={disabled}
                errorId={errorSummaryId}
                t={t}
                onChange={(next) => onChange({ ...draft, max_runtime: next })}
              />
            ) : (
              <span className="caption">{t("app.def.no_limit")}</span>
            )}
          </div>
        </div>
      </div>

      <div className="prov-row" data-prov-field="max_spend">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={maxSpendId}>
            {t("app.def.max_spend")}
          </label>
        </div>
        <div className="prov-row-control">
          <div className="optional-control">
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={draft.max_spend_enabled}
              disabled={disabled}
              aria-label={`${t("app.def.max_spend")} — ${t("app.def.limit")}`}
              onChange={(event) =>
                onChange(toggleOptionalLimit(draft, "max_spend_cu", event.target.checked))
              }
            />
            {draft.max_spend_enabled ? (
              <div className="unit-field">
                <input
                  id={maxSpendId}
                  name="max_spend_cu"
                  type="number"
                  inputMode="decimal"
                  className="input input-sm input-num"
                  min={MIN_CU_FIELD}
                  max={MAX_CU_FIELD}
                  step={CU_INPUT_STEP}
                  value={draft.max_spend_cu}
                  disabled={disabled}
                  aria-invalid={invalidFields.has("max_spend_cu") ? "true" : undefined}
                  aria-describedby={invalidFields.has("max_spend_cu") ? errorSummaryId : undefined}
                  onChange={(event) => onChange({ ...draft, max_spend_cu: event.target.value })}
                />
                <span className="unit-suffix">{t("app.unit.cu")}</span>
              </div>
            ) : (
              <span className="caption">{t("app.def.no_limit")}</span>
            )}
          </div>
        </div>
      </div>

      <div className="prov-row" data-prov-field="min_balance">
        <div className="prov-row-info">
          <label className="field-label" htmlFor={minBalanceId}>
            {t("app.def.min_balance")}
          </label>
        </div>
        <div className="prov-row-control">
          <div className="optional-control">
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={draft.min_balance_enabled}
              disabled={disabled}
              aria-label={`${t("app.def.min_balance")} — ${t("app.def.limit")}`}
              onChange={(event) =>
                onChange(toggleOptionalLimit(draft, "min_balance_cu", event.target.checked))
              }
            />
            {draft.min_balance_enabled ? (
              <div className="unit-field">
                <input
                  id={minBalanceId}
                  name="min_balance_cu"
                  type="number"
                  inputMode="decimal"
                  className="input input-sm input-num"
                  min={MIN_CU_FIELD}
                  max={MAX_CU_FIELD}
                  step={CU_INPUT_STEP}
                  value={draft.min_balance_cu}
                  disabled={disabled}
                  aria-invalid={invalidFields.has("min_balance_cu") ? "true" : undefined}
                  aria-describedby={
                    invalidFields.has("min_balance_cu") ? errorSummaryId : undefined
                  }
                  onChange={(event) => onChange({ ...draft, min_balance_cu: event.target.value })}
                />
                <span className="unit-suffix">{t("app.unit.cu")}</span>
              </div>
            ) : (
              <span className="caption">{t("app.def.no_limit")}</span>
            )}
          </div>
        </div>
      </div>

      <div className="prov-row" data-prov-field="idle_timeout">
        <div className="prov-row-info">
          <span className="field-label">{t("app.def.idle")}</span>
        </div>
        <div className="prov-row-control">
          <div className="optional-control">
            <input
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={draft.idle_timeout_enabled}
              disabled={disabled}
              aria-label={`${t("app.def.idle")} — ${t("app.def.limit")}`}
              onChange={(event) =>
                onChange(toggleOptionalLimit(draft, "idle_timeout", event.target.checked))
              }
            />
            {draft.idle_timeout_enabled ? (
              <ProvisionDurationInputs
                idPrefix={`${idBase}-idle`}
                namePrefix="idle_timeout"
                legend={t("app.def.idle")}
                value={draft.idle_timeout}
                invalid={invalidFields.has("idle_timeout")}
                disabled={disabled}
                errorId={errorSummaryId}
                t={t}
                onChange={(next) => onChange({ ...draft, idle_timeout: next })}
              />
            ) : (
              <span className="caption">{t("app.def.no_limit")}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
