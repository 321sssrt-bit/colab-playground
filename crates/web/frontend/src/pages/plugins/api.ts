/**
 * Plugins management API client and pure formatting/origin helpers.
 */

import { apiClient, ApiError, type ApiClient, type EventStreamOptions } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import type {
  HfTokenStatus,
  LocalizedText,
  PluginInfo,
  PluginOrigin,
  PluginPreviewResponse,
  PluginRunSummary,
} from "./types.ts";

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MIB_PER_GIB = 1024;
const MIN_DISPLAY_KIB = 0.1;
const SIZE_FRACTION_DIGITS = 1;

const SCP_GIT_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:[\]@_-]+:[^-]/;

/**
 * Classifies a user-entered plugin source as a Git URL or a server directory path,
 * matching the desktop rule plus SCP-style `user@host:path` remotes accepted by core.
 */
export function parsePluginOrigin(raw: string): PluginOrigin {
  const trimmed = raw.trim();
  const isGit =
    trimmed.includes("://") ||
    trimmed.startsWith("git@") ||
    (!trimmed.startsWith("/") && !trimmed.startsWith("~") && SCP_GIT_URL_RE.test(trimmed));
  return isGit ? { kind: "git", url: trimmed } : { kind: "folder", path: trimmed };
}

/**
 * Picks the best translation for `locale` matching `LocalizedText::get` in `crates/core/src/plugins.rs`:
 * exact match, case-insensitive match, same base language, `en`, first entry, then `fallback`.
 */
export function resolveLocalizedText(
  text: LocalizedText | undefined,
  locale: Locale,
  fallback: string,
): string {
  if (!text) {
    return fallback;
  }
  const direct = text[locale];
  if (direct !== undefined) {
    return direct;
  }
  const entries = Object.entries(text);
  if (entries.length === 0) {
    return fallback;
  }
  const lowerLocale = locale.toLowerCase();
  const ciMatch = entries.find(([key]) => key.toLowerCase() === lowerLocale);
  if (ciMatch) {
    return ciMatch[1];
  }
  const baseLang = lowerLocale.split("-")[0];
  const langMatch = entries.find(([key]) => key.toLowerCase().split("-")[0] === baseLang);
  if (langMatch) {
    return langMatch[1];
  }
  if (text.en !== undefined) {
    return text.en;
  }
  return entries[0][1];
}

function formatOneDecimal(value: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: SIZE_FRACTION_DIGITS,
      maximumFractionDigits: SIZE_FRACTION_DIGITS,
    }).format(value);
  } catch {
    return value.toFixed(SIZE_FRACTION_DIGITS);
  }
}

/**
 * Formats a plugin script size in KB, MB, or GB using the 5-locale shared catalog.
 */
export function formatScriptBytes(bytes: number, locale: Locale, t: TranslateFn): string {
  const safe = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  const mib = safe / BYTES_PER_MIB;
  if (mib >= MIB_PER_GIB) {
    return t("app.b2.fmt_gb", { n: formatOneDecimal(mib / MIB_PER_GIB, locale) });
  }
  if (mib >= 1) {
    return t("app.b2.fmt_mb", { n: formatOneDecimal(mib, locale) });
  }
  const kib = Math.max(safe / BYTES_PER_KIB, MIN_DISPLAY_KIB);
  return t("app.b2.fmt_kb", { n: formatOneDecimal(kib, locale) });
}

/**
 * Translates an `ApiError` (or unknown failure) into user-visible localized text.
 */
export function formatPluginApiError(error: unknown, t: TranslateFn): string {
  if (error instanceof ApiError) {
    // Re-wrap server-provided keys with `*_key` fields so static i18n checks accept them.
    const serverKeys = {
      message_key: error.messageKey,
      hint_key: error.hintKey,
    };
    const primary = serverKeys.message_key
      ? t(serverKeys.message_key, error.args)
      : error.status === 0
        ? t("app.err.http")
        : t("app.err.other");
    const hint = serverKeys.hint_key ? t(serverKeys.hint_key) : "";
    if (primary && hint && hint !== primary) {
      return `${primary}\n${hint}`;
    }
    return primary || t("app.err.other");
  }
  return t("app.err.other");
}

export async function listPlugins(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PluginInfo[]> {
  return client.request<PluginInfo[]>("/api/plugins", { method: "GET", signal });
}

export async function setPluginEnabled(
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  await client.request<void>(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { enabled },
    signal,
  });
}

export async function previewPlugin(
  origin: PluginOrigin,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PluginPreviewResponse> {
  return client.request<PluginPreviewResponse>("/api/plugins/previews", {
    method: "POST",
    body: origin,
    signal,
  });
}

export async function installPluginPreview(
  previewId: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PluginInfo> {
  return client.request<PluginInfo>(`/api/plugins/previews/${encodeURIComponent(previewId)}`, {
    method: "POST",
    body: {},
    signal,
  });
}

export async function discardPluginPreview(
  previewId: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  await client.request<void>(`/api/plugins/previews/${encodeURIComponent(previewId)}`, {
    method: "DELETE",
    body: {},
    signal,
  });
}

export async function removePlugin(
  id: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  await client.request<void>(`/api/plugins/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: {},
    signal,
  });
}

export async function getHfTokenStatus(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<HfTokenStatus> {
  return client.request<HfTokenStatus>("/api/plugins/hf/token", {
    method: "GET",
    signal,
  });
}

export async function saveHfToken(
  token: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<HfTokenStatus> {
  return client.request<HfTokenStatus>("/api/plugins/hf/token", {
    method: "PUT",
    body: { token },
    signal,
  });
}

export async function deleteHfToken(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<HfTokenStatus> {
  return client.request<HfTokenStatus>("/api/plugins/hf/token", {
    method: "DELETE",
    body: {},
    signal,
  });
}

export async function listPluginRuns(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PluginRunSummary[]> {
  return client.request<PluginRunSummary[]>("/api/plugins/runs", {
    method: "GET",
    signal,
  });
}

export async function cancelPluginRun(
  id: number,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  await client.request<void>(`/api/plugins/runs/${encodeURIComponent(String(id))}/cancel`, {
    method: "POST",
    body: {},
    signal,
  });
}

export function openPluginRunEventStream(
  id: number,
  options: Omit<EventStreamOptions, "body">,
  client: ApiClient = apiClient,
): Promise<void> {
  return client.openEventStream(`/api/plugins/runs/${encodeURIComponent(String(id))}/events`, {
    ...options,
    body: {},
  });
}
