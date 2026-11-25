/**
 * Accounts page domain model: API calls, localized error rendering, usage totals,
 * per-account row derivation, unmanaged runtime warnings, and remove protection.
 */

import { apiClient, ApiError } from "../../lib/api.ts";
import { formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type {
  Account,
  AccountContext,
  AccountId,
  AccountsView,
  AccountUsageView,
  CoreError,
  ErrorKind,
  Snapshot,
  UsageSnapshot,
} from "../../lib/types.ts";

const USAGE_OLD_THRESHOLD_SECS = 600;

export interface HostCheck {
  readonly kind: "wsl" | "shell_tools";
  readonly ready: boolean;
  readonly hint_key: string | null;
}

export interface KeyringCheck {
  readonly status: "unavailable" | "ready" | "unknown";
  readonly hint_key: string | null;
}

export interface OverviewDiagnostics {
  readonly host: HostCheck;
  readonly cli_installed: boolean;
  readonly helper_available: boolean;
  readonly keyring: KeyringCheck;
  readonly accounts_error: ErrorKind | null;
}

export interface AccountsApiResponse {
  readonly account_context: AccountContext;
  readonly accounts: AccountsView;
  readonly usage: AccountUsageView[];
  readonly login_id: number | null;
}

export interface LoginPrompt {
  readonly id: number;
  readonly auth_url: string;
}

export type RemoveBlock = "active" | "running";

export interface AccountRowView {
  readonly account: Account;
  readonly emailLabel: string;
  readonly active: boolean;
  readonly usage: AccountUsageView | null;
  readonly usageSnapshot: UsageSnapshot | null;
  readonly isStale: boolean;
  readonly ageSecs: number | null;
  readonly removeBlock: RemoveBlock | null;
}

export interface AccountsTotalsView {
  readonly known: number;
  readonly unknown: number;
  readonly balanceCu: number;
  readonly rateCuPerHour: number;
  readonly runtimes: number;
}

export interface UnmanagedWarningView {
  readonly title: string;
  readonly body: string;
}

export type AccountsGateState =
  | { readonly kind: "loading" }
  | { readonly kind: "needs_wsl" }
  | { readonly kind: "needs_shell" }
  | { readonly kind: "needs_cli" }
  | { readonly kind: "keyring_unavailable"; readonly hint_key: string | null }
  | { readonly kind: "error"; readonly errorKind: ErrorKind }
  | { readonly kind: "ready"; readonly accounts: AccountsView };

const ERROR_KIND_KEYS = {
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
} as const satisfies Record<ErrorKind, string>;

function hasErrorKindKey(kind: string): kind is ErrorKind {
  return Object.prototype.hasOwnProperty.call(ERROR_KIND_KEYS, kind);
}

export function formatErrorKind(
  kind: ErrorKind,
  t: TranslateFn,
  params?: Readonly<Record<string, string>>,
): string {
  if (hasErrorKindKey(kind)) {
    return t(ERROR_KIND_KEYS[kind], params);
  }
  return t("app.err.unknown", { kind });
}

export function formatCoreError(error: CoreError, t: TranslateFn): string {
  return formatErrorKind(error.kind, t, error.params);
}

export interface FormattedApiError {
  readonly message: string;
  readonly hint: string | null;
}

export function formatApiError(error: unknown, t: TranslateFn): FormattedApiError {
  if (error instanceof ApiError) {
    // Wrap server-provided keys in `*_key` fields so the static i18n checker recognizes them.
    const keys = {
      message_key: error.messageKey,
      hint_key: error.hintKey,
    };
    const fromServer = keys.message_key ? t(keys.message_key, error.args) : "";
    const message =
      fromServer ||
      (hasErrorKindKey(error.kind)
        ? t(ERROR_KIND_KEYS[error.kind], error.args)
        : t("app.err.other"));
    const hint = keys.hint_key ? t(keys.hint_key, error.args) || null : null;
    return { message, hint };
  }
  return { message: t("app.err.other"), hint: null };
}

export function isValidExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a hidden textarea selection when the Clipboard API is restricted.
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  const textarea = document.createElement("textarea");
  textarea.className = "clipboard-proxy";
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export function fetchOverviewDiagnostics(signal?: AbortSignal): Promise<OverviewDiagnostics> {
  return apiClient.request<OverviewDiagnostics>("/api/overview", {
    method: "GET",
    signal,
  });
}

export function refreshAccountsUsage(signal?: AbortSignal): Promise<AccountsApiResponse> {
  return apiClient.request<AccountsApiResponse>("/api/accounts/usage/refresh", {
    method: "POST",
    body: {},
    signal,
  });
}

export function adoptActiveAccount(
  accountContext: AccountContext,
  signal?: AbortSignal,
): Promise<Account> {
  return apiClient.request<Account>("/api/accounts/adopt", {
    method: "POST",
    body: { account_context: accountContext },
    signal,
  });
}

export function beginAccountLogin(
  accountContext: AccountContext,
  signal?: AbortSignal,
): Promise<LoginPrompt> {
  return apiClient.request<LoginPrompt>("/api/accounts/login", {
    method: "POST",
    body: { account_context: accountContext },
    signal,
  });
}

export function submitAccountLoginCode(
  loginId: number,
  code: string,
  signal?: AbortSignal,
): Promise<Account> {
  return apiClient.request<Account>(`/api/accounts/login/${loginId}`, {
    method: "POST",
    body: { code },
    signal,
  });
}

export function cancelAccountLogin(loginId: number, signal?: AbortSignal): Promise<void> {
  return apiClient.request<void>(`/api/accounts/login/${loginId}`, {
    method: "DELETE",
    body: {},
    signal,
  });
}

export function removeSavedAccount(
  accountId: AccountId,
  accountContext: AccountContext,
  signal?: AbortSignal,
): Promise<void> {
  return apiClient.request<void>(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    body: { account_context: accountContext },
    signal,
  });
}

export function isUsageOutdated(
  usageSnap: UsageSnapshot | null,
  usageView: AccountUsageView | null,
  nowSecs: number,
): boolean {
  if (usageSnap === null) {
    return false;
  }
  const ageSecs = Math.max(0, Math.floor(nowSecs - usageSnap.fetched_at));
  return (
    usageSnap.stale ||
    (usageView?.last_error ?? null) !== null ||
    ageSecs >= USAGE_OLD_THRESHOLD_SECS
  );
}

export function formatAccountTimeLeft(
  usageView: AccountUsageView | null,
  usageSnap: UsageSnapshot | null,
  t: TranslateFn,
): string {
  if (usageSnap === null) {
    return t("app.summary.unknown");
  }
  if (usageView !== null) {
    if (usageView.eta === null) {
      return usageSnap.balance_cu <= 0 ? t("app.summary.empty") : t("app.summary.not_burning");
    }
    if (usageView.eta <= 0) {
      return t("app.summary.empty");
    }
    return t("app.fmt.approx", { value: formatDuration(usageView.eta, t) });
  }
  if (usageSnap.balance_cu <= 0) {
    return t("app.summary.empty");
  }
  if (usageSnap.rate_cu_per_hour <= 0) {
    return t("app.summary.not_burning");
  }
  return t("app.summary.unknown");
}

export function isAccountChangeBlocked(snapshot: Snapshot | null): boolean {
  if (snapshot === null) {
    return false;
  }
  return snapshot.operations.some((pending) => {
    const op = pending.operation;
    return (
      op.kind === "provision" ||
      op.kind === "plugin_run" ||
      op.kind === "switch_account" ||
      (op.kind === "domain" &&
        (op.name === "adopt_account" || op.name === "remove_account" || op.name === "install_cli"))
    );
  });
}

export function resolveAccountsGate(
  snapshot: Snapshot | null,
  diagnostics: OverviewDiagnostics | null,
): AccountsGateState {
  if (snapshot === null) {
    return { kind: "loading" };
  }

  // Live SSE errors and recovered account snapshots take precedence over an older probe.
  if (snapshot.accounts_error !== null) {
    if (snapshot.accounts_error === "wsl_unavailable") {
      return { kind: "needs_wsl" };
    }
    if (snapshot.accounts_error === "not_installed") {
      return { kind: "needs_cli" };
    }
    if (snapshot.accounts_error === "keyring_unavailable") {
      return { kind: "keyring_unavailable", hint_key: diagnostics?.keyring.hint_key ?? null };
    }
    return { kind: "error", errorKind: snapshot.accounts_error };
  }

  if (snapshot.accounts !== null) {
    return { kind: "ready", accounts: snapshot.accounts };
  }

  if (diagnostics !== null) {
    if (!diagnostics.host.ready) {
      return diagnostics.host.kind === "wsl" ? { kind: "needs_wsl" } : { kind: "needs_shell" };
    }
    if (!diagnostics.cli_installed) {
      return { kind: "needs_cli" };
    }
    if (diagnostics.keyring.status === "unavailable") {
      return { kind: "keyring_unavailable", hint_key: diagnostics.keyring.hint_key };
    }
    if (diagnostics.accounts_error !== null) {
      if (diagnostics.accounts_error === "wsl_unavailable") {
        return { kind: "needs_wsl" };
      }
      if (diagnostics.accounts_error === "not_installed") {
        return { kind: "needs_cli" };
      }
      if (diagnostics.accounts_error === "keyring_unavailable") {
        return { kind: "keyring_unavailable", hint_key: diagnostics.keyring.hint_key };
      }
      return { kind: "error", errorKind: diagnostics.accounts_error };
    }
  }

  return { kind: "loading" };
}

export function getAccountRemoveBlock(
  accountId: AccountId,
  snapshot: Snapshot,
): RemoveBlock | null {
  const activeId = snapshot.accounts?.active ?? snapshot.account.active;
  if (activeId === accountId) {
    return "active";
  }
  const hasListedRuntime =
    snapshot.runtimes?.runtimes.some((runtime) => runtime.id.account === accountId) ?? false;
  if (hasListedRuntime) {
    return "running";
  }
  const usageView = snapshot.usage.find((item) => item.account === accountId) ?? null;
  const accountRecord =
    snapshot.accounts?.accounts.find((item) => item.id === accountId) ?? null;
  const usageSnapshot = usageView?.snapshot ?? accountRecord?.usage ?? null;
  if (usageSnapshot !== null && usageSnapshot.assignments > 0) {
    return "running";
  }
  return null;
}

export function buildAccountRows(
  accountsView: AccountsView,
  snapshot: Snapshot,
  nowSecs: number,
  t: TranslateFn,
): AccountRowView[] {
  const usageByAccount = new Map<AccountId, AccountUsageView>();
  for (const item of snapshot.usage) {
    usageByAccount.set(item.account, item);
  }

  return accountsView.accounts.map((account) => {
    const usage = usageByAccount.get(account.id) ?? null;
    const usageSnapshot = usage?.snapshot ?? account.usage ?? null;
    const active = accountsView.active === account.id;
    const emailLabel = account.email ?? usage?.email ?? t("app.accounts.no_email");
    const ageSecs =
      usageSnapshot !== null ? Math.max(0, Math.floor(nowSecs - usageSnapshot.fetched_at)) : null;
    const isStale = isUsageOutdated(usageSnapshot, usage, nowSecs);
    const removeBlock = getAccountRemoveBlock(account.id, snapshot);

    return {
      account,
      emailLabel,
      active,
      usage,
      usageSnapshot,
      isStale,
      ageSecs,
      removeBlock,
    };
  });
}

export function computeAccountsTotals(rows: readonly AccountRowView[]): AccountsTotalsView {
  let known = 0;
  let unknown = 0;
  let balanceCu = 0;
  let rateCuPerHour = 0;
  let runtimes = 0;

  for (const row of rows) {
    if (row.usageSnapshot !== null) {
      known += 1;
      balanceCu += row.usageSnapshot.balance_cu;
      rateCuPerHour += row.usageSnapshot.rate_cu_per_hour;
      runtimes += row.usageSnapshot.assignments;
    } else {
      unknown += 1;
    }
  }

  return { known, unknown, balanceCu, rateCuPerHour, runtimes };
}

export function buildUnmanagedWarning(
  rows: readonly AccountRowView[],
  t: TranslateFn,
): UnmanagedWarningView | null {
  interface UnmanagedEntry {
    readonly email: string;
    readonly count: number | null;
    readonly stale: boolean;
  }

  const entries: UnmanagedEntry[] = [];
  for (const row of rows) {
    const usage = row.usage;
    const snap = row.usageSnapshot;
    if (usage === null || snap === null) {
      continue;
    }
    if (!usage.ownership_verified && snap.assignments > 0) {
      entries.push({ email: row.emailLabel, count: null, stale: row.isStale });
    } else if (usage.unmanaged_runtimes > 0) {
      entries.push({ email: row.emailLabel, count: usage.unmanaged_runtimes, stale: row.isStale });
    }
  }

  if (entries.length === 0) {
    return null;
  }

  const counted = entries.filter((entry) => entry.count !== null);
  const title =
    counted.length === 0
      ? t("app.unmanaged.unknown_title")
      : counted.every((entry) => entry.stale)
        ? t("app.unmanaged.last_title")
        : t("app.unmanaged.title");

  const lines = entries.map((entry) => {
    if (entry.count === null) {
      return t("app.unmanaged.unknown", { email: entry.email });
    }
    if (entry.stale) {
      return entry.count === 1
        ? t("app.unmanaged.last_one", { email: entry.email })
        : t("app.unmanaged.last_many", { count: entry.count, email: entry.email });
    }
    return entry.count === 1
      ? t("app.unmanaged.one", { email: entry.email })
      : t("app.unmanaged.many", { count: entry.count, email: entry.email });
  });

  return { title, body: lines.join("\n") };
}
