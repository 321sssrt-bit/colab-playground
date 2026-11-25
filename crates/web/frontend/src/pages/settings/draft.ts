/**
 * Pure draft model, validation, and dirty-state comparison for the isolated
 * Defaults form. Keeps raw text while editing so incomplete numeric input is
 * never overwritten mid-keystroke.
 */

import {
  CORE_DEFAULTS,
  MAX_ATTEMPTS_CAP,
  MAX_CONCURRENT_SESSIONS,
  MAX_CU_FIELD,
  MAX_DURATION_HOURS,
  MAX_DURATION_MINUTES,
  MAX_DURATION_SECONDS,
  MAX_VRAM_GIB,
  MIB_PER_GIB,
  MIN_ATTEMPTS,
  MIN_CONCURRENT_SESSIONS,
  MIN_CU_FIELD,
  MIN_DURATION_SECS,
  MIN_VRAM_GIB,
  MINUTES_PER_HOUR,
  SECS_PER_HOUR,
  SECS_PER_MINUTE,
  START_IDLE_TIMEOUT_SECS,
  START_MAX_RUNTIME_SECS,
  START_MAX_SPEND_CU,
  START_MIN_BALANCE_CU,
  START_MIN_VRAM_GIB,
  type OnExhausted,
  type RuntimeDefaults,
} from "../../lib/constants.ts";
import type { Accelerator } from "../../lib/types.ts";

export interface DurationDraft {
  readonly hours: string;
  readonly minutes: string;
  readonly seconds: string;
}

export interface DefaultsDraft {
  readonly max_runtime_enabled: boolean;
  readonly max_runtime: DurationDraft;
  readonly max_spend_enabled: boolean;
  readonly max_spend_cu: string;
  readonly min_balance_enabled: boolean;
  readonly min_balance_cu: string;
  readonly idle_timeout_enabled: boolean;
  readonly idle_timeout: DurationDraft;
  readonly max_concurrent_sessions: string;
  readonly max_attempts: string;
  readonly retry_delay: DurationDraft;
  readonly on_exhausted: OnExhausted;
  readonly accelerator: Accelerator;
  readonly high_mem: boolean;
  readonly min_vram_enabled: boolean;
  readonly min_vram_gib: string;
  readonly winddown_grace: DurationDraft;
  readonly usage_poll_active: DurationDraft;
  readonly usage_poll_idle: DurationDraft;
}

export type DefaultsFieldId =
  | "max_runtime"
  | "max_spend_cu"
  | "min_balance_cu"
  | "idle_timeout"
  | "max_concurrent_sessions"
  | "max_attempts"
  | "retry_delay"
  | "min_vram_mib"
  | "winddown_grace"
  | "usage_poll_active"
  | "usage_poll_idle";

export type ParseDraftResult =
  | { readonly ok: true; readonly value: RuntimeDefaults }
  | { readonly ok: false; readonly invalidFields: ReadonlySet<DefaultsFieldId> };

const INTEGER_RE = /^\d+$/;

function secsToDurationDraft(totalSecs: number, withSeconds: boolean): DurationDraft {
  const safe = Math.max(0, Math.round(totalSecs));
  if (!withSeconds && safe > 0 && safe < SECS_PER_MINUTE) {
    // Sub-minute values sanitized by the backend stay representable in hours+minutes controls.
    return { hours: "0", minutes: "1", seconds: "0" };
  }
  const hours = Math.min(MAX_DURATION_HOURS, Math.floor(safe / SECS_PER_HOUR));
  const minutes = Math.floor((safe % SECS_PER_HOUR) / SECS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = withSeconds ? safe % SECS_PER_MINUTE : 0;
  return {
    hours: String(hours),
    minutes: String(minutes),
    seconds: String(seconds),
  };
}

export function defaultsToDraft(d: RuntimeDefaults): DefaultsDraft {
  return {
    max_runtime_enabled: d.max_runtime !== null,
    max_runtime: secsToDurationDraft(d.max_runtime ?? START_MAX_RUNTIME_SECS, false),
    max_spend_enabled: d.max_spend_cu !== null,
    max_spend_cu: String(d.max_spend_cu ?? START_MAX_SPEND_CU),
    min_balance_enabled: d.min_balance_cu !== null,
    min_balance_cu: String(d.min_balance_cu ?? START_MIN_BALANCE_CU),
    idle_timeout_enabled: d.idle_timeout !== null,
    idle_timeout: secsToDurationDraft(d.idle_timeout ?? START_IDLE_TIMEOUT_SECS, false),
    max_concurrent_sessions: String(d.max_concurrent_sessions),
    max_attempts: String(d.max_attempts),
    retry_delay: secsToDurationDraft(d.retry_delay, true),
    on_exhausted: d.on_exhausted,
    accelerator: d.accelerator,
    high_mem: d.high_mem,
    min_vram_enabled: d.min_vram_mib !== null,
    min_vram_gib: String(
      d.min_vram_mib !== null
        ? Math.max(MIN_VRAM_GIB, Math.round(d.min_vram_mib / MIB_PER_GIB))
        : START_MIN_VRAM_GIB,
    ),
    winddown_grace: secsToDurationDraft(d.winddown_grace, true),
    usage_poll_active: secsToDurationDraft(d.usage_poll_active, true),
    usage_poll_idle: secsToDurationDraft(d.usage_poll_idle, true),
  };
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

function parseDurationDraft(
  draft: DurationDraft,
  options: { readonly withSeconds: boolean; readonly minSecs: number },
): number | null {
  const hours = parseIntInRange(draft.hours, 0, MAX_DURATION_HOURS);
  const minutes = parseIntInRange(draft.minutes, 0, MAX_DURATION_MINUTES);
  const seconds = options.withSeconds
    ? parseIntInRange(draft.seconds, 0, MAX_DURATION_SECONDS)
    : 0;
  if (hours === null || minutes === null || seconds === null) {
    return null;
  }
  const total = hours * SECS_PER_HOUR + minutes * SECS_PER_MINUTE + seconds;
  if (total < options.minSecs) {
    return null;
  }
  return total;
}

export function parseDefaultsDraft(draft: DefaultsDraft): ParseDraftResult {
  const invalidFields = new Set<DefaultsFieldId>();

  let maxRuntime: number | null = null;
  if (draft.max_runtime_enabled) {
    const parsed = parseDurationDraft(draft.max_runtime, {
      withSeconds: false,
      minSecs: MIN_DURATION_SECS,
    });
    if (parsed === null) {
      invalidFields.add("max_runtime");
    } else {
      maxRuntime = parsed;
    }
  }

  let maxSpend: number | null = null;
  if (draft.max_spend_enabled) {
    const parsed = parseFloatInRange(draft.max_spend_cu, MIN_CU_FIELD, MAX_CU_FIELD);
    if (parsed === null) {
      invalidFields.add("max_spend_cu");
    } else {
      maxSpend = parsed;
    }
  }

  let minBalance: number | null = null;
  if (draft.min_balance_enabled) {
    const parsed = parseFloatInRange(draft.min_balance_cu, MIN_CU_FIELD, MAX_CU_FIELD);
    if (parsed === null) {
      invalidFields.add("min_balance_cu");
    } else {
      minBalance = parsed;
    }
  }

  let idleTimeout: number | null = null;
  if (draft.idle_timeout_enabled) {
    const parsed = parseDurationDraft(draft.idle_timeout, {
      withSeconds: false,
      minSecs: MIN_DURATION_SECS,
    });
    if (parsed === null) {
      invalidFields.add("idle_timeout");
    } else {
      idleTimeout = parsed;
    }
  }

  const maxConcurrent = parseIntInRange(
    draft.max_concurrent_sessions,
    MIN_CONCURRENT_SESSIONS,
    MAX_CONCURRENT_SESSIONS,
  );
  if (maxConcurrent === null) {
    invalidFields.add("max_concurrent_sessions");
  }

  const maxAttempts = parseIntInRange(draft.max_attempts, MIN_ATTEMPTS, MAX_ATTEMPTS_CAP);
  if (maxAttempts === null) {
    invalidFields.add("max_attempts");
  }

  const retryDelay = parseDurationDraft(draft.retry_delay, {
    withSeconds: true,
    minSecs: MIN_DURATION_SECS,
  });
  if (retryDelay === null) {
    invalidFields.add("retry_delay");
  }

  let minVramMib: number | null = null;
  if (draft.min_vram_enabled) {
    const parsedGib = parseIntInRange(draft.min_vram_gib, MIN_VRAM_GIB, MAX_VRAM_GIB);
    if (parsedGib === null) {
      invalidFields.add("min_vram_mib");
    } else {
      minVramMib = parsedGib * MIB_PER_GIB;
    }
  }

  const winddownGrace = parseDurationDraft(draft.winddown_grace, {
    withSeconds: true,
    minSecs: 0,
  });
  if (winddownGrace === null) {
    invalidFields.add("winddown_grace");
  }

  const pollActive = parseDurationDraft(draft.usage_poll_active, {
    withSeconds: true,
    minSecs: MIN_DURATION_SECS,
  });
  if (pollActive === null) {
    invalidFields.add("usage_poll_active");
  }

  const pollIdle = parseDurationDraft(draft.usage_poll_idle, {
    withSeconds: true,
    minSecs: MIN_DURATION_SECS,
  });
  if (pollIdle === null) {
    invalidFields.add("usage_poll_idle");
  }

  if (
    invalidFields.size > 0 ||
    maxConcurrent === null ||
    maxAttempts === null ||
    retryDelay === null ||
    winddownGrace === null ||
    pollActive === null ||
    pollIdle === null
  ) {
    return { ok: false, invalidFields };
  }

  return {
    ok: true,
    value: {
      max_runtime: maxRuntime,
      max_spend_cu: maxSpend,
      min_balance_cu: minBalance,
      idle_timeout: idleTimeout,
      max_concurrent_sessions: maxConcurrent,
      max_attempts: maxAttempts,
      retry_delay: retryDelay,
      on_exhausted: draft.on_exhausted,
      usage_poll_active: pollActive,
      usage_poll_idle: pollIdle,
      accelerator: draft.accelerator,
      high_mem: draft.high_mem,
      min_vram_mib: minVramMib,
      winddown_grace: winddownGrace,
    },
  };
}

export function areDefaultsEqual(a: RuntimeDefaults, b: RuntimeDefaults): boolean {
  return (
    a.max_runtime === b.max_runtime &&
    a.max_spend_cu === b.max_spend_cu &&
    a.min_balance_cu === b.min_balance_cu &&
    a.idle_timeout === b.idle_timeout &&
    a.max_concurrent_sessions === b.max_concurrent_sessions &&
    a.max_attempts === b.max_attempts &&
    a.retry_delay === b.retry_delay &&
    a.on_exhausted === b.on_exhausted &&
    a.usage_poll_active === b.usage_poll_active &&
    a.usage_poll_idle === b.usage_poll_idle &&
    a.accelerator === b.accelerator &&
    a.high_mem === b.high_mem &&
    a.min_vram_mib === b.min_vram_mib &&
    a.winddown_grace === b.winddown_grace
  );
}

function canonicalizeBaseline(baseline: RuntimeDefaults): RuntimeDefaults {
  const roundTripped = parseDefaultsDraft(defaultsToDraft(baseline));
  return roundTripped.ok ? roundTripped.value : baseline;
}

export function isDraftDirty(draft: DefaultsDraft, baseline: RuntimeDefaults): boolean {
  const parsed = parseDefaultsDraft(draft);
  if (!parsed.ok) {
    return true;
  }
  return !areDefaultsEqual(parsed.value, canonicalizeBaseline(baseline));
}

export function toggleOptionalField(
  draft: DefaultsDraft,
  field: "max_runtime" | "max_spend_cu" | "min_balance_cu" | "idle_timeout" | "min_vram_mib",
  enabled: boolean,
): DefaultsDraft {
  switch (field) {
    case "max_runtime": {
      const nextDuration =
        enabled &&
        parseDurationDraft(draft.max_runtime, {
          withSeconds: false,
          minSecs: MIN_DURATION_SECS,
        }) === null
          ? secsToDurationDraft(START_MAX_RUNTIME_SECS, false)
          : draft.max_runtime;
      return { ...draft, max_runtime_enabled: enabled, max_runtime: nextDuration };
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
        enabled &&
        parseDurationDraft(draft.idle_timeout, {
          withSeconds: false,
          minSecs: MIN_DURATION_SECS,
        }) === null
          ? secsToDurationDraft(START_IDLE_TIMEOUT_SECS, false)
          : draft.idle_timeout;
      return { ...draft, idle_timeout_enabled: enabled, idle_timeout: nextIdle };
    }
    case "min_vram_mib": {
      const nextVram =
        enabled && parseIntInRange(draft.min_vram_gib, MIN_VRAM_GIB, MAX_VRAM_GIB) === null
          ? String(START_MIN_VRAM_GIB)
          : draft.min_vram_gib;
      return { ...draft, min_vram_enabled: enabled, min_vram_gib: nextVram };
    }
  }
}

export function isDraftAtCoreDefaults(draft: DefaultsDraft): boolean {
  const parsed = parseDefaultsDraft(draft);
  return parsed.ok && areDefaultsEqual(parsed.value, CORE_DEFAULTS);
}
