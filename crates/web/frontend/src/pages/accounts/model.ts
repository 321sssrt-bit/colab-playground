/**
 * Accounts page domain model: API calls, localized error rendering, usage totals,
 * per-account row derivation, unmanaged runtime warnings, and remove protection.
 */

import { apiClient, ApiError, type ApiClient } from "../../lib/api.ts";
import { isAccountChangeBlocked } from "../../lib/appCache.ts";
import { evaluateUsageSampleFreshness, formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type {
  Accelerator,
  Account,
  AccountContext,
  AccountId,
  AccountsApiResponse,
  AccountsView,
  AccountUsageView,
  ApiErrorPayload,
  CoreError,
  ErrorKind,
  HostCheck,
  KeyringCheck,
  RuntimeRef,
  Snapshot,
  TrackedSession,
  TunnelId,
  TunnelInfo,
  UnixSecs,
  UsageSnapshot,
} from "../../lib/types.ts";

export { isAccountChangeBlocked };
export type { AccountsApiResponse, HostCheck, KeyringCheck };

export interface SwitchTarget {
  readonly id: AccountId;
  readonly emailLabel: string;
}

export interface RemoveTarget {
  readonly id: AccountId;
  readonly emailLabel: string;
}

export interface SwitchConfirmation {
  readonly from: AccountId | null;
  readonly to: AccountId;
  readonly forwards: TunnelId[];
  readonly managed: [string, string | null][];
  readonly unmanaged: string[] | null;
}

export interface AccountSwitchApproval {
  readonly account_context: AccountContext;
  readonly confirmation: SwitchConfirmation;
}

export interface SwitchImpact {
  readonly from: AccountId | null;
  readonly to: AccountId;
  readonly tunnels_closing: TunnelInfo[];
  readonly sessions_left_running: TrackedSession[];
  readonly unmanaged_left_running: RuntimeRef[] | null;
}

export interface AccountSwitchPreview extends AccountSwitchApproval {
  readonly impact: SwitchImpact;
  readonly sampled_at?: UnixSecs;
}

export interface OverviewDiagnostics {
  readonly host: HostCheck;
  readonly cli_installed: boolean;
  readonly helper_available: boolean;
  readonly keyring: KeyringCheck;
  readonly accounts_error: ErrorKind | null;
}

export interface LoginPrompt {
  readonly id: number;
  readonly auth_url: string;
}

export interface CancelLoginSettlement {
  readonly outcome: "cancelled" | "completed" | "failed";
  readonly account_context?: AccountContext;
  readonly accounts?: AccountsView;
  readonly accounts_error?: ErrorKind;
  readonly account?: Account;
  readonly error?: ApiErrorPayload;
}

export type RemoveBlock = "active" | "running";

export interface AccountRowView {
  readonly account: Account;
  readonly emailLabel: string;
  readonly active: boolean;
  readonly usage: AccountUsageView | null;
  readonly usageSnapshot: UsageSnapshot | null;
  readonly isStale: boolean;
  readonly isFailed: boolean;
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

export function formatApiErrorPayload(
  payload: ApiErrorPayload | null | undefined,
  t: TranslateFn,
): FormattedApiError {
  if (!payload) {
    return { message: t("app.err.other"), hint: null };
  }
  const fromServer = payload.message_key ? t(payload.message_key, payload.args) : "";
  const message =
    fromServer ||
    (hasErrorKindKey(payload.kind)
      ? t(ERROR_KIND_KEYS[payload.kind], payload.args)
      : t("app.err.other"));
  const hint = payload.hint_key ? t(payload.hint_key, payload.args) || null : null;
  return { message, hint };
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

export function beginAccountLogin(
  accountContext: AccountContext,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<LoginPrompt> {
  return client.request<LoginPrompt>("/api/accounts/login", {
    method: "POST",
    body: { account_context: accountContext },
    signal,
  });
}

export function submitAccountLoginCode(
  loginId: number,
  code: string,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<Account> {
  return client.request<Account>(`/api/accounts/login/${loginId}`, {
    method: "POST",
    body: { code },
    signal,
  });
}

export function cancelAccountLogin(
  loginId: number,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<CancelLoginSettlement | undefined> {
  return client.request<CancelLoginSettlement | undefined>(`/api/accounts/login/${loginId}`, {
    method: "DELETE",
    body: {},
    signal,
  });
}

export function dismissRecoveredPendingAdd(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  return client.request<void>("/api/accounts/recovered/dismiss", {
    method: "POST",
    body: {},
    signal,
  });
}

/**
 * Returns the active server login id visible in a snapshot (either an awaiting
 * `PendingLogin` prompt or an in-flight `Operation::Login` start/submit/cancel).
 */
export function findActiveServerLoginId(snapshot: Snapshot | null): number | null {
  if (snapshot === null) {
    return null;
  }
  if (snapshot.login_id !== null) {
    return snapshot.login_id;
  }
  for (const pending of snapshot.operations) {
    if (pending.operation.kind === "login") {
      return pending.operation.login_id ?? pending.id;
    }
  }
  return null;
}

/**
 * Returns true when the server snapshot shows the given login id is actively
 * being cancelled/rolled back.
 */
export function isServerLoginCancelling(snapshot: Snapshot | null, loginId: number): boolean {
  if (snapshot === null) {
    return false;
  }
  return snapshot.operations.some(
    (pending) =>
      pending.operation.kind === "login" &&
      (pending.operation.login_id ?? pending.id) === loginId &&
      pending.cancelling,
  );
}

export function removeSavedAccount(
  accountId: AccountId,
  accountContext: AccountContext,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  return client.request<void>(`/api/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    body: { account_context: accountContext },
    signal,
  });
}

export function previewAccountSwitch(
  accountId: AccountId,
  signal?: AbortSignal,
): Promise<AccountSwitchPreview> {
  return apiClient.request<AccountSwitchPreview>(
    `/api/accounts/${encodeURIComponent(accountId)}/switch`,
    {
      method: "GET",
      signal,
    },
  );
}

export function confirmAccountSwitch(
  accountId: AccountId,
  approval: AccountSwitchApproval,
  signal?: AbortSignal,
): Promise<AccountsView> {
  return apiClient.request<AccountsView>(
    `/api/accounts/${encodeURIComponent(accountId)}/switch`,
    {
      method: "POST",
      body: approval,
      signal,
    },
  );
}

const ACCELERATOR_KEYS = {
  NONE: "app.acc.none",
  T4: "app.acc.t4",
  L4: "app.acc.l4",
  G4: "app.acc.g4",
  A100: "app.acc.a100",
  H100: "app.acc.h100",
  V5E1: "app.acc.v5e1",
  V6E1: "app.acc.v6e1",
} as const satisfies Record<Accelerator, string>;

export function formatAcceleratorLabel(accelerator: Accelerator, t: TranslateFn): string {
  return t(ACCELERATOR_KEYS[accelerator]);
}

export function resolveAccountEmailLabel(
  accountId: AccountId,
  snapshot: Snapshot | null,
  t: TranslateFn,
  fallback?: string,
): string {
  const account = snapshot?.accounts?.accounts.find((item) => item.id === accountId);
  const usage = snapshot?.usage.find((item) => item.account === accountId);
  return account?.email ?? usage?.email ?? fallback ?? t("app.accounts.no_email");
}

export function resolveUnmanagedRuntimeLabel(
  runtimeRef: RuntimeRef,
  snapshot: Snapshot | null,
): string {
  const listed = snapshot?.runtimes?.runtimes.find(
    (runtime) =>
      runtime.id.account === runtimeRef.account && runtime.id.endpoint === runtimeRef.endpoint,
  );
  if (listed) {
    return listed.id.name ?? listed.hardware;
  }
  return runtimeRef.name ?? runtimeRef.endpoint;
}

export function isSwitchImpactEmpty(impact: SwitchImpact): boolean {
  // Unknown unmanaged runtimes (`null`) may still be billing and must never be treated as empty.
  return (
    impact.tunnels_closing.length === 0 &&
    impact.sessions_left_running.length === 0 &&
    impact.unmanaged_left_running !== null &&
    impact.unmanaged_left_running.length === 0
  );
}

export function isSwitchConflictError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.kind === "switch_impact_changed" || error.kind === "account_not_active")
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
  if (usageSnap.rate_cu_per_hour <= 0) {
    return t("app.summary.not_burning");
  }
  if (usageView !== null) {
    if (usageView.eta === null) {
      return t("app.summary.not_burning");
    }
    if (usageView.eta <= 0) {
      return t("app.summary.empty");
    }
    return t("app.fmt.approx", { value: formatDuration(usageView.eta, t) });
  }
  if (usageSnap.balance_cu <= 0) {
    return t("app.summary.empty");
  }
  return t("app.summary.unknown");
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

  const rows = accountsView.accounts.map((account) => {
    const usage = usageByAccount.get(account.id) ?? null;
    const usageSnapshot = usage?.snapshot ?? account.usage ?? null;
    const active = accountsView.active === account.id;
    const emailLabel = account.email ?? usage?.email ?? t("app.accounts.no_email");
    const freshness = evaluateUsageSampleFreshness(usageSnapshot, usage, nowSecs);
    const ageSecs = freshness?.ageSecs ?? null;
    const isStale = freshness?.outdated ?? false;
    const isFailed = freshness?.isStale ?? false;
    const removeBlock = getAccountRemoveBlock(account.id, snapshot);

    return {
      account,
      emailLabel,
      active,
      usage,
      usageSnapshot,
      isStale,
      isFailed,
      ageSecs,
      removeBlock,
    };
  });
  // Keep the active account pinned first while preserving the relative order of inactive accounts.
  rows.sort((a, b) => Number(b.active) - Number(a.active));
  return rows;
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
