/**
 * Settings and read-only update check API helpers bound to `/api/settings` and `/api/updates`.
 */

import { apiClient, ApiError } from "../../lib/api.ts";
import {
  ACCELERATOR_OPTIONS,
  CORE_DEFAULTS,
  ON_EXHAUSTED_OPTIONS,
  type OnExhausted,
  type RuntimeDefaults,
} from "../../lib/constants.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Accelerator, SettingsView } from "../../lib/types.ts";

export interface LoadedSettings {
  readonly defaults: RuntimeDefaults;
  readonly configDir: string | null;
  readonly loadStatus: SettingsView["load_status"];
  readonly corruptBackup: string | null;
  readonly resetDefaults: readonly string[];
}

export interface UpdateNotice {
  readonly current_version: string;
  readonly update_available: boolean;
  readonly releases_url: string;
}

const ACCELERATOR_SET: ReadonlySet<string> = new Set<string>(ACCELERATOR_OPTIONS);
const ON_EXHAUSTED_SET: ReadonlySet<string> = new Set<string>(ON_EXHAUSTED_OPTIONS);

function readOptionalNumber(value: unknown, fallback: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return fallback;
}

function readOptionalNonNegInt(value: unknown, fallback: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}

function readNonNegInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  return fallback;
}

function readAccelerator(value: unknown): Accelerator {
  return typeof value === "string" && ACCELERATOR_SET.has(value)
    ? (value as Accelerator)
    : CORE_DEFAULTS.accelerator;
}

function readOnExhausted(value: unknown): OnExhausted {
  return typeof value === "string" && ON_EXHAUSTED_SET.has(value)
    ? (value as OnExhausted)
    : CORE_DEFAULTS.on_exhausted;
}

function normalizeRuntimeDefaults(raw: Record<string, unknown>): RuntimeDefaults {
  return {
    max_runtime: readOptionalNonNegInt(raw.max_runtime, CORE_DEFAULTS.max_runtime),
    max_spend_cu: readOptionalNumber(raw.max_spend_cu, CORE_DEFAULTS.max_spend_cu),
    min_balance_cu: readOptionalNumber(raw.min_balance_cu, CORE_DEFAULTS.min_balance_cu),
    idle_timeout: readOptionalNonNegInt(raw.idle_timeout, CORE_DEFAULTS.idle_timeout),
    max_concurrent_sessions: readNonNegInt(
      raw.max_concurrent_sessions,
      CORE_DEFAULTS.max_concurrent_sessions,
    ),
    max_attempts: readNonNegInt(raw.max_attempts, CORE_DEFAULTS.max_attempts),
    retry_delay: readNonNegInt(raw.retry_delay, CORE_DEFAULTS.retry_delay),
    on_exhausted: readOnExhausted(raw.on_exhausted),
    usage_poll_active: readNonNegInt(raw.usage_poll_active, CORE_DEFAULTS.usage_poll_active),
    usage_poll_idle: readNonNegInt(raw.usage_poll_idle, CORE_DEFAULTS.usage_poll_idle),
    accelerator: readAccelerator(raw.accelerator),
    high_mem: typeof raw.high_mem === "boolean" ? raw.high_mem : CORE_DEFAULTS.high_mem,
    min_vram_mib: readOptionalNonNegInt(raw.min_vram_mib, CORE_DEFAULTS.min_vram_mib),
    winddown_grace: readNonNegInt(raw.winddown_grace, CORE_DEFAULTS.winddown_grace),
  };
}

function toLoadedSettings(view: SettingsView): LoadedSettings {
  return {
    defaults: normalizeRuntimeDefaults(view.defaults),
    configDir: typeof view.config_dir === "string" ? view.config_dir : null,
    loadStatus: view.load_status,
    corruptBackup: typeof view.corrupt_backup === "string" ? view.corrupt_backup : null,
    resetDefaults: Array.isArray(view.reset_defaults)
      ? view.reset_defaults.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export async function fetchSettings(signal?: AbortSignal): Promise<LoadedSettings> {
  const view = await apiClient.request<SettingsView>("/api/settings", {
    method: "GET",
    signal,
  });
  return toLoadedSettings(view);
}

export type RuntimeDefaultsPatch = Partial<RuntimeDefaults>;

export async function patchDefaults(
  defaults: RuntimeDefaultsPatch,
  signal?: AbortSignal,
): Promise<LoadedSettings> {
  const view = await apiClient.request<SettingsView>("/api/settings", {
    method: "PATCH",
    body: { defaults },
    signal,
  });
  return toLoadedSettings(view);
}

export async function fetchUpdates(signal?: AbortSignal): Promise<UpdateNotice> {
  return apiClient.request<UpdateNotice>("/api/updates", {
    method: "GET",
    signal,
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.isAbort;
}

export function isSafeHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function formatSettingsError(error: unknown, t: TranslateFn): string {
  if (error instanceof ApiError) {
    if (error.messageKey) {
      const serverMsg = { key: error.messageKey };
      const primary = t(serverMsg.key, error.args);
      if (primary) {
        if (error.hintKey) {
          const hintMsg = { key: error.hintKey };
          const hint = t(hintMsg.key, error.args);
          if (hint) {
            return `${primary} ${hint}`;
          }
        }
        return primary;
      }
    }
    if (error.status === 0) {
      return t("app.err.http");
    }
    if (error.status === 503) {
      return t("app.err.http_unavailable");
    }
  }
  return t("app.err.other");
}
