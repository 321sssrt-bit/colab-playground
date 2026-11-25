/**
 * Pure formatting, grouping, error-translation, and clipboard utilities for Sessions.
 */

import { ApiError } from "../../lib/api.ts";
import { formatCu, formatDuration } from "../../lib/format.ts";
import type { I18nParams, TranslateFn } from "../../lib/i18n.ts";
import type {
  ApiErrorPayload,
  Concern,
  CoreError,
  ErrorKind,
  Limit,
  Locale,
  Runtime,
  RuntimeRef,
} from "../../lib/types.ts";

const MIB_PER_GIB = 1024;
const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const MAX_AUTO_STOP_SECS = 0xffffffff;
export const MAX_HOURS_INPUT = 999;
export const MAX_MINUTES_INPUT = 59;
export const FORWARD_DEFAULT_PORT = 8000;
export const MIN_PORT = 1;
export const MAX_PORT = 65535;
export const RESERVED_VM_PORT = 8080;

const LIMIT_KEYS: Readonly<Record<Limit, string>> = {
  runtime: "app.b2.limit_runtime",
  spend: "app.b2.limit_spend",
  balance: "app.b2.limit_balance",
};

const ERROR_KIND_KEYS: Readonly<Record<ErrorKind, string>> = {
  not_installed: "app.err.not_installed",
  auth_required: "app.err.auth_required",
  not_entitled: "app.err.not_entitled",
  capacity_refused: "app.err.capacity_refused",
  allocation_timeout: "app.err.allocation_timeout",
  ssh_busy: "app.err.ssh_busy",
  session_gone: "app.err.session_gone",
  connection_lost: "app.err.connection_lost",
  exec_timeout: "app.err.exec_timeout",
  port_in_use: "app.err.port_in_use",
  port_reserved: "app.err.port_reserved",
  invalid_input: "app.err.invalid_input",
  no_active_account: "app.err.no_active_account",
  active_account_not_adopted: "app.err.active_not_adopted",
  account_not_active: "app.err.account_not_active",
  account_not_found: "app.err.account_not_found",
  keyring_unavailable: "app.err.keyring_unavailable",
  add_in_progress: "app.err.add_in_progress",
  legacy_token_present: "app.err.legacy_token",
  login_cancelled: "app.err.login_cancelled",
  login_invalid_code: "app.err.login_invalid_code",
  login_verification_failed: "app.err.login_unverified",
  cancelled: "app.err.cancelled",
  unsupported: "app.err.unsupported",
  wsl_unavailable: "app.err.wsl_unavailable",
  command_too_long: "app.err.command_too_long",
  session_limit_reached: "app.err.session_limit",
  busy: "app.err.busy",
  data_dir_in_use: "app.err.data_dir_in_use",
  provision_exhausted: "app.err.provision_exhausted",
  orphan_suspected: "app.err.orphan_suspected",
  manifest_invalid: "app.err.manifest_invalid",
  plugin_exists: "app.err.plugin_exists",
  plugin_not_found: "app.err.plugin_not_found",
  plugin_run_failed: "app.err.plugin_run_failed",
  health_check_failed: "app.err.health_check_failed",
  git_failed: "app.err.git_failed",
  install_failed: "app.err.install_failed",
  http: "app.err.http",
  http_unavailable: "app.err.http_unavailable",
  rate_limited: "app.b7.err_rate_limited",
  parse: "app.err.parse",
  io: "app.err.io",
  timeout: "app.err.timeout",
  unsupported_cli_version: "app.err.unsupported_cli",
  update_unverified: "app.b12.err_update_unverified",
  update_unavailable: "app.b12.err_update_unavailable",
  other: "app.err.other",
};

export interface FormattedError {
  readonly message: string;
  readonly hint: string | null;
}

interface RuntimeGroup {
  readonly account: string;
  readonly email: string | null;
  readonly active: boolean;
  readonly runtimes: readonly Runtime[];
}

interface DurationParts {
  readonly hours: number;
  readonly minutes: number;
}

export function runtimeKey(ref: RuntimeRef | null | undefined): string {
  if (!ref) {
    return "";
  }
  return `${ref.account}/${ref.endpoint || ""}`;
}

export function formatRuntimeCardLabel(runtime: Runtime): string {
  return runtime.id.name ?? (runtime.hardware || runtime.id.endpoint);
}

export function formatEmail(email: string | null | undefined, t: TranslateFn): string {
  return email && email.trim().length > 0 ? email : t("app.accounts.no_email");
}

export function formatApprox(value: string, t: TranslateFn): string {
  return t("app.fmt.approx", { value });
}

export function formatVram(vramMib: number, locale: Locale, t: TranslateFn): string {
  const gb = Math.max(1, Math.round(vramMib / MIB_PER_GIB));
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(gb);
  } catch {
    formatted = String(gb);
  }
  return t("app.b2.fmt_gb", { n: formatted });
}

export function formatHardware(
  gpu: string | null | undefined,
  vramMib: number | null | undefined,
  locale: Locale,
  t: TranslateFn,
): string | null {
  const hasGpu = typeof gpu === "string" && gpu.trim().length > 0;
  const hasVram = typeof vramMib === "number" && Number.isFinite(vramMib) && vramMib > 0;
  if (hasGpu && hasVram) {
    return `${gpu} · ${formatVram(vramMib, locale, t)}`;
  }
  if (hasGpu) {
    return gpu;
  }
  if (hasVram) {
    return formatVram(vramMib, locale, t);
  }
  return null;
}

export function formatShortWait(secs: number, t: TranslateFn): string {
  const safe = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0;
  if (safe < SECS_PER_MINUTE) {
    return t("app.b2.fmt_seconds", { n: safe });
  }
  return formatDuration(safe, t);
}

export function formatConcern(concern: Concern, locale: Locale, t: TranslateFn): string {
  if (concern.kind === "usage_unknown") {
    const limitKey = LIMIT_KEYS[concern.limit];
    return t("app.b2.guard_unknown", { limit: t(limitKey) });
  }
  const rawCurrent =
    concern.limit === "runtime"
      ? formatDuration(Math.max(0, concern.current), t)
      : formatCu(concern.current, locale, t);
  const current = concern.estimated ? formatApprox(rawCurrent, t) : rawCurrent;
  const limit =
    concern.limit === "runtime"
      ? formatDuration(Math.max(0, concern.threshold), t)
      : formatCu(concern.threshold, locale, t);

  if (concern.limit === "runtime") {
    return t("app.b2.guard_runtime", { current, limit });
  }
  if (concern.limit === "spend") {
    return t("app.b2.guard_spend", { current, limit });
  }
  return t("app.b2.guard_balance", { current, limit });
}

export function formatConcerns(
  concerns: readonly Concern[],
  locale: Locale,
  t: TranslateFn,
): string {
  return concerns
    .map((item) => formatConcern(item, locale, t))
    .filter((text) => text.length > 0)
    .join(t("app.fmt.list_separator"));
}

function isKnownErrorKind(value: string): value is ErrorKind {
  return Object.hasOwn(ERROR_KIND_KEYS, value);
}

export function formatErrorKind(
  kind: string | null | undefined,
  t: TranslateFn,
  args?: I18nParams,
): string {
  if (!kind || !isKnownErrorKind(kind)) {
    return t("app.err.other");
  }
  return t(ERROR_KIND_KEYS[kind], args);
}

export function formatErrorMessage(
  error: ApiError | ApiErrorPayload | CoreError | ErrorKind | unknown,
  t: TranslateFn,
): FormattedError {
  if (!error) {
    return { message: t("app.err.other"), hint: null };
  }
  if (typeof error === "string") {
    return { message: formatErrorKind(error, t), hint: null };
  }
  if (error instanceof ApiError) {
    const keys = { message_key: error.messageKey, hint_key: error.hintKey };
    const message = keys.message_key
      ? t(keys.message_key, error.args)
      : formatErrorKind(error.kind, t, error.args);
    const hint = keys.hint_key ? t(keys.hint_key, error.args) : null;
    return {
      message: message || formatErrorKind(error.kind, t, error.args),
      hint: hint || null,
    };
  }
  if (typeof error === "object") {
    const candidate = error as Partial<ApiErrorPayload & CoreError>;
    const args = candidate.args ?? candidate.params;
    if (typeof candidate.message_key === "string" && candidate.message_key.length > 0) {
      const payload = {
        message_key: candidate.message_key,
        hint_key: typeof candidate.hint_key === "string" ? candidate.hint_key : null,
      };
      const message = t(payload.message_key, args);
      const hint = payload.hint_key ? t(payload.hint_key, args) : null;
      return {
        message: message || formatErrorKind(candidate.kind, t, args),
        hint: hint || null,
      };
    }
    if (typeof candidate.kind === "string") {
      return { message: formatErrorKind(candidate.kind, t, args), hint: null };
    }
  }
  return { message: t("app.err.other"), hint: null };
}

export function isWatchdogArmed(runtime: Runtime): boolean {
  const wd = runtime.tracked?.watchdog ?? null;
  return Boolean(wd && wd.armed && !wd.cancelled && wd.deadline !== null);
}

export function splitDurationHoursMinutes(totalSecs: number): DurationParts {
  const safe = Number.isFinite(totalSecs) ? Math.max(0, Math.floor(totalSecs)) : 0;
  const hours = Math.floor(safe / SECS_PER_HOUR);
  const minutes = Math.floor((safe % SECS_PER_HOUR) / SECS_PER_MINUTE);
  return { hours, minutes };
}

export function composeDurationSeconds(hoursText: string, minutesText: string): number | null {
  const hTrim = hoursText.trim();
  const mTrim = minutesText.trim();
  const hours = hTrim === "" ? 0 : Number(hTrim);
  const minutes = mTrim === "" ? 0 : Number(mTrim);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    minutes < 0 ||
    hours > MAX_HOURS_INPUT ||
    minutes > MAX_MINUTES_INPUT
  ) {
    return null;
  }
  const total = hours * SECS_PER_HOUR + minutes * SECS_PER_MINUTE;
  if (total <= 0 || total > MAX_AUTO_STOP_SECS) {
    return null;
  }
  return total;
}

export function parseForwardPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    return null;
  }
  return value;
}

export function validateHealthPath(
  raw: string,
): { readonly ok: true; readonly value: string | null } | { readonly ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (!trimmed.startsWith("/") || /[\s\p{Cc}]/u.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, value: trimmed };
}

export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Groups runtimes by account ID (not email, since accounts may lack an email),
 * ordering the active account group first while preserving runtime order.
 */
export function groupRuntimesByAccount(runtimes: readonly Runtime[]): RuntimeGroup[] {
  const buckets = new Map<string, Runtime[]>();
  for (const rt of runtimes) {
    const existing = buckets.get(rt.id.account);
    if (existing) {
      existing.push(rt);
    } else {
      buckets.set(rt.id.account, [rt]);
    }
  }
  const groups: RuntimeGroup[] = [];
  for (const [account, list] of buckets) {
    groups.push({
      account,
      email: list[0]?.account_email ?? null,
      active: Boolean(list[0]?.on_active_account),
      runtimes: list,
    });
  }
  groups.sort((a, b) => Number(b.active) - Number(a.active));
  return groups;
}

export async function copyTextToClipboard(
  text: string,
  hostEl?: HTMLElement | null,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to selection copy on non-secure HTTP origins.
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  const host = hostEl ?? document.body;
  if (!host) {
    return false;
  }
  const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const proxy = document.createElement("textarea");
  proxy.className = "clipboard-proxy";
  proxy.readOnly = true;
  proxy.setAttribute("aria-hidden", "true");
  proxy.tabIndex = -1;
  proxy.value = text;
  host.appendChild(proxy);
  let copied = false;
  try {
    proxy.focus({ preventScroll: true });
    proxy.select();
    proxy.setSelectionRange(0, text.length);
    copied = Boolean(document.execCommand("copy"));
  } catch {
    copied = false;
  } finally {
    proxy.remove();
    if (prevActive && prevActive.isConnected) {
      prevActive.focus({ preventScroll: true });
    }
  }
  return copied;
}
