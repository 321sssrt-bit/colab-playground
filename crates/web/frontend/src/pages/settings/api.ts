/**
 * Settings API helpers bound to `/api/settings` and `/api/settings/notice/dismiss`.
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
import type {
  Accelerator,
  ApiErrorPayload,
  DismissSettingsNoticeResponse,
  SettingsNotice,
  SettingsPatch,
  SettingsView,
} from "../../lib/types.ts";

export interface LoadedSettings {
  readonly defaults: RuntimeDefaults;
  readonly checkUpdates: boolean;
  readonly wslDistro: string | null;
  readonly colabPath: string | null;
  readonly colabPython: string | null;
  readonly usesWsl: boolean;
  readonly configDir: string | null;
  readonly settingsFile: string | null;
  readonly loadStatus: SettingsView["load_status"];
  readonly corruptBackup: string | null;
  readonly resetDefaults: readonly string[];
  readonly settingsNotice: SettingsNotice | null;
}

export type RuntimeDefaultsPatch = Partial<RuntimeDefaults>;

export interface HostSettingsPatch {
  readonly wsl_distro?: string | null;
  readonly colab_path?: string | null;
  readonly colab_python?: string | null;
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

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export function normalizeSettingsNotice(
  raw: SettingsNotice | null | undefined,
): SettingsNotice | null {
  if (!raw) {
    return null;
  }
  const corrupt = raw.corrupt === true;
  const corrupt_backup = typeof raw.corrupt_backup === "string" ? raw.corrupt_backup : null;
  const reset_defaults = Array.isArray(raw.reset_defaults)
    ? raw.reset_defaults.filter((item): item is string => typeof item === "string")
    : [];
  if (!corrupt && reset_defaults.length === 0) {
    return null;
  }
  return { corrupt, corrupt_backup, reset_defaults };
}

function toLoadedSettings(view: SettingsView): LoadedSettings {
  return {
    defaults: normalizeRuntimeDefaults(view.defaults),
    checkUpdates: typeof view.check_updates === "boolean" ? view.check_updates : true,
    wslDistro: readOptionalString(view.wsl_distro),
    colabPath: readOptionalString(view.colab_path),
    colabPython: readOptionalString(view.colab_python),
    usesWsl: view.uses_wsl === true,
    configDir: typeof view.config_dir === "string" ? view.config_dir : null,
    settingsFile: typeof view.settings_file === "string" ? view.settings_file : null,
    loadStatus: view.load_status,
    corruptBackup: typeof view.corrupt_backup === "string" ? view.corrupt_backup : null,
    resetDefaults: Array.isArray(view.reset_defaults)
      ? view.reset_defaults.filter((item): item is string => typeof item === "string")
      : [],
    settingsNotice: normalizeSettingsNotice(view.settings_notice),
  };
}

export async function fetchSettings(signal?: AbortSignal): Promise<LoadedSettings> {
  const view = await apiClient.request<SettingsView>("/api/settings", {
    method: "GET",
    signal,
  });
  return toLoadedSettings(view);
}

async function patchSettings(patch: SettingsPatch, signal?: AbortSignal): Promise<LoadedSettings> {
  const view = await apiClient.request<SettingsView>("/api/settings", {
    method: "PATCH",
    body: patch,
    signal,
  });
  return toLoadedSettings(view);
}

export async function patchDefaults(
  defaults: RuntimeDefaultsPatch,
  signal?: AbortSignal,
): Promise<LoadedSettings> {
  return patchSettings({ defaults }, signal);
}

export async function patchHostSettings(
  patch: HostSettingsPatch,
  signal?: AbortSignal,
): Promise<LoadedSettings> {
  return patchSettings(patch, signal);
}

export async function patchCheckUpdates(
  checkUpdates: boolean,
  signal?: AbortSignal,
): Promise<LoadedSettings> {
  return patchSettings({ check_updates: checkUpdates }, signal);
}

export async function dismissSettingsNotice(
  signal?: AbortSignal,
): Promise<DismissSettingsNoticeResponse> {
  return apiClient.request<DismissSettingsNoticeResponse>("/api/settings/notice/dismiss", {
    method: "POST",
    body: {},
    signal,
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.isAbort;
}

export function isHostInterpreterAloneError(error: unknown): boolean {
  return error instanceof ApiError && error.messageKey === "app.host.interpreter_alone";
}

export function formatApiErrorPayload(
  payload: ApiErrorPayload | null | undefined,
  t: TranslateFn,
): string {
  if (!payload) {
    return t("app.err.other");
  }
  if (payload.message_key) {
    const primary = t(payload.message_key, payload.args);
    if (primary) {
      if (payload.hint_key) {
        const hint = t(payload.hint_key, payload.args);
        if (hint) {
          return `${primary} ${hint}`;
        }
      }
      return primary;
    }
  }
  return t("app.err.other");
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
