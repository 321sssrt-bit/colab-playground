/**
 * Pure provisioning specification, measured-rate lookup, name-suggestion,
 * SSE frame parsing, and server-clock slow-answer logic shared across
 * `ProvisionFields`, `ProvisionProgress`, `NewSessionDialog`, and `sessionsStore`.
 */

import {
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
  SECS_PER_HOUR,
  SECS_PER_MINUTE,
  START_IDLE_TIMEOUT_SECS,
  START_MAX_RUNTIME_SECS,
  START_MAX_SPEND_CU,
  START_MIN_BALANCE_CU,
  START_MIN_VRAM_GIB,
  type OnExhausted,
} from "../../lib/constants.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type {
  Accelerator,
  HardwareRate,
  Locale,
  RateReading,
  Runtime,
  UnixSecs,
} from "../../lib/types.ts";
import type {
  ProvisionFinishedEvent,
  ProvisionProgressEvent,
  ProvisionSpec,
} from "./api.ts";
import { formatErrorMessage, formatHardware, formatShortWait, formatVram } from "./format.ts";

export const MAX_SESSION_NAME_LEN = 63;
export const SLOW_ANSWER_SECS = 60;

const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTEGER_RE = /^\d+$/;

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

export type BuildProvisionSpecResult =
  | { readonly ok: true; readonly spec: ProvisionSpec }
  | { readonly ok: false; readonly invalidFields: ReadonlySet<ProvisionFieldErrorId> };

export interface ProvisionSentence {
  readonly text: string;
  readonly tone: "busy" | "good" | "warn" | "bad" | "neutral";
}

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
 * Updates the suggested session name when switching accelerators, and updates the
 * visible input text only when the field is empty or still holds the previous
 * suggested name (mirroring upstream `offer_input`).
 */
export function resolveNextSuggestedName(
  currentDraft: string,
  prevSuggested: string,
  prevAccelerator: Accelerator,
  nextAccelerator: Accelerator,
): { readonly suggestedName: string; readonly nextDraft: string } {
  if (prevSuggested.length === 0) {
    return { suggestedName: prevSuggested, nextDraft: currentDraft };
  }
  const oldPrefix = `${acceleratorPrefix(prevAccelerator)}-`;
  const newPrefix = `${acceleratorPrefix(nextAccelerator)}-`;
  const nextSuggested = prevSuggested.startsWith(oldPrefix)
    ? `${newPrefix}${prevSuggested.slice(oldPrefix.length)}`
    : prevSuggested;
  const trimmedCurrent = currentDraft.trim();
  const shouldApply = trimmedCurrent.length === 0 || trimmedCurrent === prevSuggested;
  return {
    suggestedName: nextSuggested,
    nextDraft: shouldApply ? nextSuggested : currentDraft,
  };
}

/**
 * Finds the latest measured burn rate matching `(accelerator, effectiveHighMem)`,
 * consulting persisted historical `measuredRates` (surviving runtime stops) and
 * live tracked runtimes, returning the reading with the newest timestamp.
 */
export function findMeasuredRate(
  runtimes: readonly Runtime[] | null | undefined,
  accelerator: Accelerator,
  highMem: boolean,
  measuredRates?: readonly HardwareRate[] | null,
): RateReading | null {
  const effectiveHighMem = highMem && acceleratorSupportsHighMem(accelerator);
  let latest: RateReading | null = null;

  if (measuredRates && measuredRates.length > 0) {
    for (const entry of measuredRates) {
      const entryHighMem = entry.high_mem && acceleratorSupportsHighMem(entry.accelerator);
      if (entry.accelerator !== accelerator || entryHighMem !== effectiveHighMem) {
        continue;
      }
      if (!latest || entry.reading.at > latest.at) {
        latest = entry.reading;
      }
    }
  }

  if (runtimes && runtimes.length > 0) {
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
  }

  return latest;
}

export function secsToDurationDraft(totalSecs: number): ProvisionDurationDraft {
  const safe = Math.max(0, Math.round(totalSecs));
  if (safe > 0 && safe < SECS_PER_MINUTE) {
    return { hours: "0", minutes: "1" };
  }
  const hours = Math.min(MAX_DURATION_HOURS, Math.floor(safe / SECS_PER_HOUR));
  const minutes = Math.floor((safe % SECS_PER_HOUR) / SECS_PER_MINUTE) % MINUTES_PER_HOUR;
  return { hours: String(hours), minutes: String(minutes) };
}

export function parseIntInRange(raw: string, min: number, max: number): number | null {
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

export function parseFloatInRange(raw: string, min: number, max: number): number | null {
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

export function parseDurationSecs(draft: ProvisionDurationDraft): number | null {
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
  const minVramMib =
    isGpu && spec.min_vram_mib !== null && spec.min_vram_mib > 0 ? spec.min_vram_mib : null;
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
  fallbackName?: string | null,
): BuildProvisionSpecResult {
  const initialDraft = baseSpec ? specToProvisionDraft(baseSpec) : null;
  const invalidFields = new Set<ProvisionFieldErrorId>();
  const trimmedInput = name.trim();
  const trimmedFallback = fallbackName?.trim() ?? "";
  // Clearing the session name falls back to the suggested name, matching upstream `start_provision`.
  const trimmedName = trimmedInput.length > 0 ? trimmedInput : trimmedFallback;
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

export function parseProvisionEvent(raw: string): ProvisionProgressEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "event" in parsed) {
      return parsed as ProvisionProgressEvent;
    }
  } catch {
    // Ignore malformed SSE event frames.
  }
  return null;
}

export function parseFinishedEvent(raw: string): ProvisionFinishedEvent | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "phase" in parsed) {
      return parsed as ProvisionFinishedEvent;
    }
  } catch {
    // Ignore malformed SSE finished frames.
  }
  return null;
}

export function formatProvisionSentence(
  ev: ProvisionProgressEvent,
  completed: boolean,
  locale: Locale,
  t: TranslateFn,
): ProvisionSentence | null {
  const hw = (gpu: string | null, vramMib: number | null) =>
    formatHardware(gpu, vramMib, locale, t) ?? t("app.b2.prov_no_gpu");

  switch (ev.event) {
    case "allocating":
      return {
        text: t(completed ? "app.b3.prov_allocated" : "app.b2.prov_allocating", {
          n: ev.attempt,
          of: ev.max_attempts,
        }),
        tone: "busy",
      };
    case "allocated":
    case "failed":
      return null;
    case "allocation_failed":
      return {
        text: t("app.b2.prov_allocation_failed", {
          why: formatErrorMessage(ev.error, t).message,
        }),
        tone: "warn",
      };
    case "probed":
      return {
        text: t("app.b2.prov_probed", { hardware: hw(ev.gpu, ev.vram_mib) }),
        tone: "neutral",
      };
    case "rejected":
      return {
        text: t("app.b2.prov_rejected", {
          got: ev.vram_mib !== null ? formatVram(ev.vram_mib, locale, t) : t("app.summary.unknown"),
          min: formatVram(ev.min_vram_mib, locale, t),
        }),
        tone: "warn",
      };
    case "releasing":
      return {
        text: t(completed ? "app.b3.prov_released" : "app.b2.prov_releasing"),
        tone: "busy",
      };
    case "reconciling":
      return {
        text: t(completed ? "app.b11.prov_reconciled" : "app.b11.prov_reconciling"),
        tone: "busy",
      };
    case "orphan_detected":
      return ev.released
        ? { text: t("app.b2.prov_orphan_released"), tone: "neutral" }
        : { text: t("app.b2.prov_orphan_left"), tone: "bad" };
    case "retrying":
      return {
        text: t(completed ? "app.b3.prov_retried" : "app.b2.prov_retrying", {
          time: formatShortWait(ev.delay_secs, t),
        }),
        tone: "busy",
      };
    case "watchdog_started":
      return {
        text: t(ev.deadline !== null ? "app.b2.prov_watchdog" : "app.b2.prov_watchdog_no_deadline"),
        tone: "good",
      };
    case "watchdog_failed":
      return { text: t("app.b2.prov_watchdog_failed"), tone: "bad" };
    case "ready":
      return {
        text: t(ev.below_spec ? "app.b2.prov_ready_below" : "app.b2.prov_ready", {
          hardware: hw(ev.gpu, ev.vram_mib),
        }),
        tone: ev.below_spec ? "warn" : "good",
      };
    default:
      return null;
  }
}

export function formatProvisionHeadline(
  events: readonly ProvisionProgressEvent[],
  t: TranslateFn,
): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev.event === "allocating") {
      return t("app.b2.prov_attempt", { n: ev.attempt, of: ev.max_attempts });
    }
    if (ev.event === "reconciling") {
      return t("app.b11.prov_reconciling");
    }
  }
  return t("app.b2.prov_starting");
}

export function hasProvisionLines(
  events: readonly ProvisionProgressEvent[],
  locale: Locale,
  t: TranslateFn,
): boolean {
  return events.some((ev) => formatProvisionSentence(ev, true, locale, t) !== null);
}

/**
 * Mirrors upstream `ProvisionProgress::unanswered_for`: returns elapsed seconds once an
 * unanswered `allocating` attempt reaches `SLOW_ANSWER_SECS` on the backend clock domain.
 */
export function computeUnansweredForSecs(
  events: readonly ProvisionProgressEvent[],
  waitingSinceSecs: UnixSecs | null,
  nowSecs: UnixSecs,
): number | null {
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  if (lastEvent?.event !== "allocating" || waitingSinceSecs === null) {
    return null;
  }
  if (!Number.isFinite(waitingSinceSecs) || !Number.isFinite(nowSecs) || nowSecs < waitingSinceSecs) {
    return null;
  }
  const waitedSecs = Math.floor(nowSecs - waitingSinceSecs);
  return waitedSecs >= SLOW_ANSWER_SECS ? waitedSecs : null;
}
