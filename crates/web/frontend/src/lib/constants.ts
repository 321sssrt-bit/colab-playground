/**
 * Centralized form bounds, conversion factors, initial toggle values, and
 * core runtime defaults shared across Settings and future runtime forms.
 *
 * Mirrors `crates/core/src/defaults.rs`, `crates/core/src/provision.rs`,
 * `crates/shared/src/defaults.rs`, `crates/app/src/ui/pages/defaults.rs`,
 * `crates/app/src/ui/runtime_options.rs`, and `crates/app/src/ui/duration_field.rs`.
 */

import type { Accelerator } from "./types.ts";

export type OnExhausted = "stop_and_fail" | "keep_last";

export interface RuntimeDefaults {
  readonly max_runtime: number | null;
  readonly max_spend_cu: number | null;
  readonly min_balance_cu: number | null;
  readonly idle_timeout: number | null;
  readonly max_concurrent_sessions: number;
  readonly max_attempts: number;
  readonly retry_delay: number;
  readonly on_exhausted: OnExhausted;
  readonly usage_poll_active: number;
  readonly usage_poll_idle: number;
  readonly accelerator: Accelerator;
  readonly high_mem: boolean;
  readonly min_vram_mib: number | null;
  readonly winddown_grace: number;
}

export const SECS_PER_MINUTE = 60;
export const MINUTES_PER_HOUR = 60;
export const SECS_PER_HOUR = SECS_PER_MINUTE * MINUTES_PER_HOUR;
export const MIB_PER_GIB = 1024;

export const MIN_DURATION_SECS = 1;
export const MAX_DURATION_HOURS = 999;
export const MAX_DURATION_MINUTES = MINUTES_PER_HOUR - 1;
export const MAX_DURATION_SECONDS = SECS_PER_MINUTE - 1;

export const MIN_CONCURRENT_SESSIONS = 1;
export const MAX_CONCURRENT_SESSIONS = 20;

export const MIN_ATTEMPTS = 1;
export const MAX_ATTEMPTS_CAP = 8;

export const MIN_CU_FIELD = 0;
export const MAX_CU_FIELD = 100_000;
export const CU_INPUT_STEP = 0.1;

export const MIN_VRAM_GIB = 1;
export const MAX_VRAM_GIB = 1024;

export const START_MAX_RUNTIME_SECS = 2 * SECS_PER_HOUR;
export const START_IDLE_TIMEOUT_SECS = 30 * SECS_PER_MINUTE;
export const START_MAX_SPEND_CU = 10;
export const START_MIN_BALANCE_CU = 5;
export const START_MIN_VRAM_GIB = 40;
export const START_MIN_VRAM_MIB = START_MIN_VRAM_GIB * MIB_PER_GIB;

export const ACCELERATOR_OPTIONS: readonly Accelerator[] = [
  "NONE",
  "T4",
  "L4",
  "G4",
  "A100",
  "H100",
  "V5E1",
  "V6E1",
];

export const ON_EXHAUSTED_OPTIONS: readonly OnExhausted[] = ["stop_and_fail", "keep_last"];

export const CORE_DEFAULTS: RuntimeDefaults = {
  max_runtime: START_MAX_RUNTIME_SECS,
  max_spend_cu: null,
  min_balance_cu: null,
  idle_timeout: null,
  max_concurrent_sessions: 2,
  max_attempts: 3,
  retry_delay: 20,
  on_exhausted: "stop_and_fail",
  usage_poll_active: 30,
  usage_poll_idle: 5 * SECS_PER_MINUTE,
  accelerator: "A100",
  high_mem: false,
  min_vram_mib: null,
  winddown_grace: 300,
};
