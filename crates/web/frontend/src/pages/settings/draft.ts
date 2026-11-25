/**
 * Pure draft model, per-field diffing, validation, and partial-patch builder
 * for the isolated Defaults form.
 *
 * Only fields edited by the user (or explicitly reset to core defaults) are
 * validated and included in the PATCH payload, so untouched backend values
 * (such as sub-minute durations, non-GiB-aligned VRAM thresholds, or
 * backend-accepted values outside UI input bounds) are never silently
 * rewritten or falsely flagged as unsaved.
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
import type { RuntimeDefaultsPatch } from "./api.ts";

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

export type DefaultsFieldKey = keyof RuntimeDefaults;

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

export type BuildPatchResult =
  | { readonly ok: true; readonly patch: RuntimeDefaultsPatch; readonly hasChanges: boolean }
  | { readonly ok: false; readonly invalidFields: ReadonlySet<DefaultsFieldId> };

const INTEGER_RE = /^\d+$/;

const ALL_DEFAULT_FIELDS: readonly DefaultsFieldKey[] = [
  "max_runtime",
  "max_spend_cu",
  "min_balance_cu",
  "idle_timeout",
  "max_concurrent_sessions",
  "max_attempts",
  "retry_delay",
  "on_exhausted",
  "usage_poll_active",
  "usage_poll_idle",
  "accelerator",
  "high_mem",
  "min_vram_mib",
  "winddown_grace",
];

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

function durationDraftEqual(a: DurationDraft, b: DurationDraft, withSeconds: boolean): boolean {
  return (
    a.hours.trim() === b.hours.trim() &&
    a.minutes.trim() === b.minutes.trim() &&
    (!withSeconds || a.seconds.trim() === b.seconds.trim())
  );
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

function isFieldDraftModified(
  draft: DefaultsDraft,
  initial: DefaultsDraft,
  field: DefaultsFieldKey,
): boolean {
  switch (field) {
    case "max_runtime":
      return (
        draft.max_runtime_enabled !== initial.max_runtime_enabled ||
        (draft.max_runtime_enabled && !durationDraftEqual(draft.max_runtime, initial.max_runtime, false))
      );
    case "max_spend_cu":
      return (
        draft.max_spend_enabled !== initial.max_spend_enabled ||
        (draft.max_spend_enabled && draft.max_spend_cu.trim() !== initial.max_spend_cu.trim())
      );
    case "min_balance_cu":
      return (
        draft.min_balance_enabled !== initial.min_balance_enabled ||
        (draft.min_balance_enabled && draft.min_balance_cu.trim() !== initial.min_balance_cu.trim())
      );
    case "idle_timeout":
      return (
        draft.idle_timeout_enabled !== initial.idle_timeout_enabled ||
        (draft.idle_timeout_enabled && !durationDraftEqual(draft.idle_timeout, initial.idle_timeout, false))
      );
    case "max_concurrent_sessions":
      return draft.max_concurrent_sessions.trim() !== initial.max_concurrent_sessions.trim();
    case "max_attempts":
      return draft.max_attempts.trim() !== initial.max_attempts.trim();
    case "retry_delay":
      return !durationDraftEqual(draft.retry_delay, initial.retry_delay, true);
    case "on_exhausted":
      return draft.on_exhausted !== initial.on_exhausted;
    case "usage_poll_active":
      return !durationDraftEqual(draft.usage_poll_active, initial.usage_poll_active, true);
    case "usage_poll_idle":
      return !durationDraftEqual(draft.usage_poll_idle, initial.usage_poll_idle, true);
    case "accelerator":
      return draft.accelerator !== initial.accelerator;
    case "high_mem":
      return draft.high_mem !== initial.high_mem;
    case "min_vram_mib":
      return (
        draft.min_vram_enabled !== initial.min_vram_enabled ||
        (draft.min_vram_enabled && draft.min_vram_gib.trim() !== initial.min_vram_gib.trim())
      );
    case "winddown_grace":
      return !durationDraftEqual(draft.winddown_grace, initial.winddown_grace, true);
  }
}

export function diffFieldsFromCore(serverDefaults: RuntimeDefaults): ReadonlySet<DefaultsFieldKey> {
  const diff = new Set<DefaultsFieldKey>();
  for (const field of ALL_DEFAULT_FIELDS) {
    if (serverDefaults[field] !== CORE_DEFAULTS[field]) {
      diff.add(field);
    }
  }
  return diff;
}

export function buildDefaultsPatch(
  draft: DefaultsDraft,
  serverDefaults: RuntimeDefaults,
  forceInclude: ReadonlySet<DefaultsFieldKey> = new Set<DefaultsFieldKey>(),
): BuildPatchResult {
  const initial = defaultsToDraft(serverDefaults);
  const invalidFields = new Set<DefaultsFieldId>();
  const patch: { -readonly [K in DefaultsFieldKey]?: RuntimeDefaults[K] } = {};

  const shouldEvaluate = (field: DefaultsFieldKey): boolean =>
    forceInclude.has(field) || isFieldDraftModified(draft, initial, field);

  if (shouldEvaluate("max_runtime")) {
    if (!draft.max_runtime_enabled) {
      if (serverDefaults.max_runtime !== null) {
        patch.max_runtime = null;
      }
    } else {
      const parsed = parseDurationDraft(draft.max_runtime, {
        withSeconds: false,
        minSecs: MIN_DURATION_SECS,
      });
      if (parsed === null) {
        invalidFields.add("max_runtime");
      } else if (parsed !== serverDefaults.max_runtime) {
        patch.max_runtime = parsed;
      }
    }
  }

  if (shouldEvaluate("max_spend_cu")) {
    if (!draft.max_spend_enabled) {
      if (serverDefaults.max_spend_cu !== null) {
        patch.max_spend_cu = null;
      }
    } else {
      const parsed = parseFloatInRange(draft.max_spend_cu, MIN_CU_FIELD, MAX_CU_FIELD);
      if (parsed === null) {
        invalidFields.add("max_spend_cu");
      } else if (parsed !== serverDefaults.max_spend_cu) {
        patch.max_spend_cu = parsed;
      }
    }
  }

  if (shouldEvaluate("min_balance_cu")) {
    if (!draft.min_balance_enabled) {
      if (serverDefaults.min_balance_cu !== null) {
        patch.min_balance_cu = null;
      }
    } else {
      const parsed = parseFloatInRange(draft.min_balance_cu, MIN_CU_FIELD, MAX_CU_FIELD);
      if (parsed === null) {
        invalidFields.add("min_balance_cu");
      } else if (parsed !== serverDefaults.min_balance_cu) {
        patch.min_balance_cu = parsed;
      }
    }
  }

  if (shouldEvaluate("idle_timeout")) {
    if (!draft.idle_timeout_enabled) {
      if (serverDefaults.idle_timeout !== null) {
        patch.idle_timeout = null;
      }
    } else {
      const parsed = parseDurationDraft(draft.idle_timeout, {
        withSeconds: false,
        minSecs: MIN_DURATION_SECS,
      });
      if (parsed === null) {
        invalidFields.add("idle_timeout");
      } else if (parsed !== serverDefaults.idle_timeout) {
        patch.idle_timeout = parsed;
      }
    }
  }

  if (shouldEvaluate("max_concurrent_sessions")) {
    const parsed = parseIntInRange(
      draft.max_concurrent_sessions,
      MIN_CONCURRENT_SESSIONS,
      MAX_CONCURRENT_SESSIONS,
    );
    if (parsed === null) {
      invalidFields.add("max_concurrent_sessions");
    } else if (parsed !== serverDefaults.max_concurrent_sessions) {
      patch.max_concurrent_sessions = parsed;
    }
  }

  if (shouldEvaluate("max_attempts")) {
    const parsed = parseIntInRange(draft.max_attempts, MIN_ATTEMPTS, MAX_ATTEMPTS_CAP);
    if (parsed === null) {
      invalidFields.add("max_attempts");
    } else if (parsed !== serverDefaults.max_attempts) {
      patch.max_attempts = parsed;
    }
  }

  if (shouldEvaluate("retry_delay")) {
    const parsed = parseDurationDraft(draft.retry_delay, {
      withSeconds: true,
      minSecs: MIN_DURATION_SECS,
    });
    if (parsed === null) {
      invalidFields.add("retry_delay");
    } else if (parsed !== serverDefaults.retry_delay) {
      patch.retry_delay = parsed;
    }
  }

  if (shouldEvaluate("on_exhausted") && draft.on_exhausted !== serverDefaults.on_exhausted) {
    patch.on_exhausted = draft.on_exhausted;
  }

  if (shouldEvaluate("accelerator") && draft.accelerator !== serverDefaults.accelerator) {
    patch.accelerator = draft.accelerator;
  }

  if (shouldEvaluate("high_mem") && draft.high_mem !== serverDefaults.high_mem) {
    patch.high_mem = draft.high_mem;
  }

  if (shouldEvaluate("min_vram_mib")) {
    if (!draft.min_vram_enabled) {
      if (serverDefaults.min_vram_mib !== null) {
        patch.min_vram_mib = null;
      }
    } else {
      const parsedGib = parseIntInRange(draft.min_vram_gib, MIN_VRAM_GIB, MAX_VRAM_GIB);
      if (parsedGib === null) {
        invalidFields.add("min_vram_mib");
      } else {
        const parsedMib = parsedGib * MIB_PER_GIB;
        if (parsedMib !== serverDefaults.min_vram_mib) {
          patch.min_vram_mib = parsedMib;
        }
      }
    }
  }

  if (shouldEvaluate("winddown_grace")) {
    const parsed = parseDurationDraft(draft.winddown_grace, {
      withSeconds: true,
      minSecs: 0,
    });
    if (parsed === null) {
      invalidFields.add("winddown_grace");
    } else if (parsed !== serverDefaults.winddown_grace) {
      patch.winddown_grace = parsed;
    }
  }

  if (shouldEvaluate("usage_poll_active")) {
    const parsed = parseDurationDraft(draft.usage_poll_active, {
      withSeconds: true,
      minSecs: MIN_DURATION_SECS,
    });
    if (parsed === null) {
      invalidFields.add("usage_poll_active");
    } else if (parsed !== serverDefaults.usage_poll_active) {
      patch.usage_poll_active = parsed;
    }
  }

  if (shouldEvaluate("usage_poll_idle")) {
    const parsed = parseDurationDraft(draft.usage_poll_idle, {
      withSeconds: true,
      minSecs: MIN_DURATION_SECS,
    });
    if (parsed === null) {
      invalidFields.add("usage_poll_idle");
    } else if (parsed !== serverDefaults.usage_poll_idle) {
      patch.usage_poll_idle = parsed;
    }
  }

  if (invalidFields.size > 0) {
    return { ok: false, invalidFields };
  }

  return {
    ok: true,
    patch,
    hasChanges: Object.keys(patch).length > 0,
  };
}

export function isDraftDirty(
  draft: DefaultsDraft,
  serverDefaults: RuntimeDefaults,
  forceInclude: ReadonlySet<DefaultsFieldKey> = new Set<DefaultsFieldKey>(),
): boolean {
  const result = buildDefaultsPatch(draft, serverDefaults, forceInclude);
  return !result.ok || result.hasChanges;
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

export function isDraftAtCoreDefaults(
  draft: DefaultsDraft,
  serverDefaults: RuntimeDefaults,
  forceInclude: ReadonlySet<DefaultsFieldKey> = new Set<DefaultsFieldKey>(),
): boolean {
  const result = buildDefaultsPatch(draft, serverDefaults, forceInclude);
  if (!result.ok) {
    return false;
  }
  const effective: RuntimeDefaults = { ...serverDefaults, ...result.patch };
  return ALL_DEFAULT_FIELDS.every((field) => effective[field] === CORE_DEFAULTS[field]);
}
