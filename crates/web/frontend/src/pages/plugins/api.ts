/**
 * Plugins management API client and pure formatting/origin helpers.
 */

import { apiClient, ApiError, type ApiClient, type EventStreamOptions } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import type {
  AcceptedPluginRun,
  GgufEstimateRequest,
  GgufEstimateResponse,
  HfModel,
  HfTokenState,
  HfTokenStatus,
  KvType,
  LocalizedText,
  PluginInfo,
  PluginOrigin,
  PluginPreviewResponse,
  PluginRunPhase,
  PluginRunSummary,
  PluginRunTemplateSpec,
  StartPluginRunRequest,
} from "./types.ts";
import type { Accelerator, PendingOperation } from "../../lib/types.ts";

const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
const MIB_PER_GIB = 1024;
const MIN_DISPLAY_KIB = 0.1;
const SIZE_FRACTION_DIGITS = 1;

const SCP_GIT_URL_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:[\]@_-]+:[^-]/;
// Mirrors `crates/core/src/plugins.rs::is_repo_id`.
const HF_REPO_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,95}$/;

export function isValidHfRepoId(raw: string): boolean {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || trimmed.indexOf("/", slash + 1) !== -1) {
    return false;
  }
  const owner = trimmed.slice(0, slash);
  const name = trimmed.slice(slash + 1);
  return HF_REPO_SEGMENT_RE.test(owner) && HF_REPO_SEGMENT_RE.test(name);
}

export function formatInteger(value: number, locale: Locale): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(safe);
  } catch {
    return String(safe);
  }
}

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

export interface HfTokenBadgeMeta {
  readonly status: "saved" | "none" | "error" | "loading";
  readonly className: string;
  readonly text: string;
}

/**
 * Resolves the status badge presentation for the Hugging Face token cache state.
 * Shared by the Plugins list card and the modal token dialog so error states always
 * surface clearly and never retain a stale `saved` badge.
 */
export function getHfTokenBadgeMeta(hfToken: HfTokenState, t: TranslateFn): HfTokenBadgeMeta {
  if (hfToken.kind === "ready") {
    return hfToken.saved
      ? {
          status: "saved",
          className: "badge badge-success",
          text: t("app.b2.hf_token_stored"),
        }
      : {
          status: "none",
          className: "badge",
          text: t("app.b2.hf_token_none"),
        };
  }
  if (hfToken.kind === "error") {
    return {
      status: "error",
      className: "badge badge-warning",
      text: t("app.b2.hf_token_unknown"),
    };
  }
  return {
    status: "loading",
    className: "badge",
    text: t("app.summary.unknown"),
  };
}

/**
 * Resolves the display phase for a Plugins list top run banner, preferring terminal
 * phases from `RunSummary.phase` or live SSE updates so banners never stall on "running".
 */
export function resolvePluginRunBannerPhase(
  run: Pick<PluginRunSummary, "phase" | "finished">,
  knownPhase: PluginRunPhase | undefined,
): PluginRunPhase | null {
  if (run.phase && run.phase !== "running") {
    return run.phase;
  }
  if (knownPhase && knownPhase !== "running") {
    return knownPhase;
  }
  if (run.phase === "running" || !run.finished) {
    return "running";
  }
  return null;
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

export async function cancelPluginPreview(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  await client.request<void>("/api/plugins/previews/cancel", {
    method: "POST",
    body: {},
    signal,
  });
}

/**
 * Finds the active `inspect_plugin` operation ID in `snapshot.operations`, if any.
 */
export function findInspectPluginOpId(
  operations: readonly PendingOperation[] | undefined,
): number | null {
  if (!operations) {
    return null;
  }
  const matched = operations.find(
    ({ operation }) => operation.kind === "domain" && operation.name === "inspect_plugin",
  );
  return matched ? matched.id : null;
}

/**
 * Returns true only when this tab's preview check did not collide with an `inspect_plugin`
 * operation already running before submit and an `inspect_plugin` op is currently active.
 * Prevents a second tab that hit (or is about to hit) `409 Busy` from cancelling tab A's check.
 */
export function shouldSendGlobalPreviewCancel(
  preExistingInspectOpId: number | null,
  currentOperations: readonly PendingOperation[] | undefined,
): boolean {
  if (preExistingInspectOpId !== null) {
    return false;
  }
  return findInspectPluginOpId(currentOperations) !== null;
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

export async function fetchPluginRunTemplate(
  id: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<PluginRunTemplateSpec> {
  return client.request<PluginRunTemplateSpec>(`/api/plugins/${encodeURIComponent(id)}/template`, {
    method: "GET",
    signal,
  });
}

export async function searchHfModels(
  query: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<HfModel[]> {
  return client.request<HfModel[]>("/api/plugins/hf/search", {
    method: "POST",
    body: { query },
    signal,
  });
}

export interface HfGgufFitParams {
  readonly accelerator: Accelerator | null;
  readonly vramMib: number | null;
  readonly ctx: number;
  readonly quant: string | null;
  readonly kv: KvType | null;
}

export function buildGgufFitKey(repo: string, params: HfGgufFitParams): string {
  return JSON.stringify([
    repo,
    params.accelerator,
    params.vramMib,
    params.ctx,
    params.quant,
    params.kv,
  ]);
}

export interface GgufFetchPlan {
  readonly action: "skip" | "fetch";
  readonly showLoading: boolean;
  readonly refresh: boolean;
}

/**
 * Decides how `HfModelField` should query `POST /api/plugins/hf/gguf`:
 * - Exact cached `(repo, fitParams)` match skips the request (e.g. restored draft).
 * - Parameter-only changes on the same loaded repo recalculate via the backend's
 *   cached GGUF listing (`refresh: false`) without clearing the preview to loading.
 * - Explicit refresh ("List files") sets `refresh: true` to bypass the backend cache.
 */
export function planGgufEstimateFetch(params: {
  readonly targetRepo: string;
  readonly targetFitKey: string;
  readonly currentKind: "idle" | "loading" | "ready" | "error";
  readonly currentRepo: string | null;
  readonly currentFitKey: string | null;
  readonly forceRefresh: boolean;
}): GgufFetchPlan {
  if (
    !params.forceRefresh &&
    params.currentKind === "ready" &&
    params.currentRepo === params.targetRepo &&
    params.currentFitKey === params.targetFitKey
  ) {
    return { action: "skip", showLoading: false, refresh: false };
  }
  const sameRepoParamRecalc =
    !params.forceRefresh &&
    params.currentKind === "ready" &&
    params.currentRepo === params.targetRepo;
  return {
    action: "fetch",
    showLoading: !sameRepoParamRecalc,
    refresh: params.forceRefresh,
  };
}

export async function fetchHfGgufEstimate(
  request: GgufEstimateRequest,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<GgufEstimateResponse> {
  return client.request<GgufEstimateResponse>("/api/plugins/hf/gguf", {
    method: "POST",
    body: request,
    signal,
  });
}

export async function startPluginRun(
  request: StartPluginRunRequest,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<AcceptedPluginRun> {
  return client.request<AcceptedPluginRun>("/api/plugins/runs", {
    method: "POST",
    body: request,
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
