/**
 * Wire contracts aligned with `crates/web/src/http.rs`, `crates/web/src/api/mod.rs`,
 * `crates/web/src/state.rs`, and `crates/core/src/*`.
 */

export type BackendKind = "real" | "mock";

export type Locale = "en-US" | "zh-CN" | "zh-TW" | "ja-JP" | "ko-KR";

export type LanguagePref = "system" | Locale;

export type AppearancePref = "system" | "light" | "dark";

export interface SettingsNotice {
  readonly corrupt: boolean;
  readonly corrupt_backup: string | null;
  readonly reset_defaults: readonly string[];
}

export interface DismissSettingsNoticeResponse {
  readonly notice: SettingsNotice | null;
}

export interface SettingsView {
  language: LanguagePref;
  appearance: AppearancePref;
  defaults: Record<string, unknown>;
  check_updates?: boolean;
  wsl_distro?: string | null;
  colab_path?: string | null;
  colab_python?: string | null;
  uses_wsl?: boolean;
  config_dir: string | null;
  settings_file?: string | null;
  load_status: "no_config_dir" | "missing" | "loaded" | "corrupt";
  corrupt_backup: string | null;
  reset_defaults: string[];
  settings_notice?: SettingsNotice | null;
}

export interface SettingsPatch {
  language?: LanguagePref;
  appearance?: AppearancePref;
  defaults?: Record<string, unknown>;
  check_updates?: boolean;
  wsl_distro?: string | null;
  colab_path?: string | null;
  colab_python?: string | null;
}

export type AccountId = string;

export type TunnelId = number;

export type UnixSecs = number;

export type DurationSecs = number;

export type ErrorKind =
  | "not_installed"
  | "auth_required"
  | "not_entitled"
  | "capacity_refused"
  | "allocation_timeout"
  | "ssh_busy"
  | "session_gone"
  | "connection_lost"
  | "exec_timeout"
  | "port_in_use"
  | "port_reserved"
  | "invalid_input"
  | "no_active_account"
  | "active_account_not_adopted"
  | "account_not_active"
  | "account_not_found"
  | "keyring_unavailable"
  | "add_in_progress"
  | "legacy_token_present"
  | "login_cancelled"
  | "login_invalid_code"
  | "login_verification_failed"
  | "cancelled"
  | "unsupported"
  | "wsl_unavailable"
  | "command_too_long"
  | "session_limit_reached"
  | "busy"
  | "data_dir_in_use"
  | "provision_exhausted"
  | "orphan_suspected"
  | "manifest_invalid"
  | "plugin_exists"
  | "plugin_not_found"
  | "plugin_run_failed"
  | "health_check_failed"
  | "git_failed"
  | "install_failed"
  | "http"
  | "http_unavailable"
  | "rate_limited"
  | "parse"
  | "io"
  | "timeout"
  | "unsupported_cli_version"
  | "update_unverified"
  | "update_unavailable"
  | "other";

export type NextStep =
  | "none"
  | "try_again"
  | "retry_later"
  | "switch_account"
  | "add_account"
  | "sign_in_again"
  | "unlock_keyring"
  | "choose_other_accelerator"
  | "stop_a_session"
  | "choose_other_port"
  | "close_other_connection"
  | "install_cli"
  | "install_wsl"
  | "update_app"
  | "check_input"
  | "check_network"
  | "refresh"
  | "review_runtimes"
  | "view_log"
  | "report_problem";

export interface CoreError {
  kind: ErrorKind;
  params: Record<string, string>;
  detail: string;
  next_step: NextStep;
}

export interface ApiErrorPayload {
  kind: string;
  message_key: string;
  args: Record<string, string>;
  hint_key: string | null;
  action_key: string | null;
  operation_id: number | null;
}

export interface AccountContext {
  revision: number;
  active: AccountId | null;
}

export interface UsageSnapshot {
  balance_cu: number;
  rate_cu_per_hour: number;
  assignments: number;
  fetched_at: UnixSecs;
  stale: boolean;
}

export interface BalancePoint {
  at: UnixSecs;
  balance_cu: number;
}

export interface RateReading {
  cu_per_hour: number;
  at: UnixSecs;
}

export interface HardwareRate {
  accelerator: Accelerator;
  high_mem: boolean;
  reading: RateReading;
}

export interface Account {
  id: AccountId;
  email: string | null;
  created_at: UnixSecs;
  updated_at: UnixSecs;
  usage: UsageSnapshot | null;
}

export interface AccountsView {
  accounts: Account[];
  active: AccountId | null;
  has_token: boolean;
  unadopted: boolean;
  active_email: string | null;
  recovered_pending_add: boolean;
}

export type Accelerator =
  | "NONE"
  | "T4"
  | "L4"
  | "G4"
  | "A100"
  | "H100"
  | "V5E1"
  | "V6E1";

export interface GuardPolicy {
  max_runtime: DurationSecs | null;
  max_spend_cu: number | null;
  min_balance_cu: number | null;
  idle_timeout: DurationSecs | null;
}

export interface SpendMeter {
  started_at: UnixSecs;
  spend_cu: number;
  rate_known: boolean;
  estimated: boolean;
  integrated_to: UnixSecs;
  last_share_cu_per_hour: number | null;
  last_observed: UnixSecs | null;
}

export type Limit = "runtime" | "spend" | "balance";

export type Concern =
  | {
      kind: "limit";
      limit: Limit;
      current: number;
      threshold: number;
      estimated: boolean;
    }
  | {
      kind: "usage_unknown";
      limit: Limit;
    };

export type Decision =
  | { decision: "ok" }
  | { decision: "warn"; concerns: Concern[] }
  | { decision: "stop"; concerns: Concern };

export type StopReason =
  | { kind: "user" }
  | { kind: "guard"; concern: Concern }
  | { kind: "provision" }
  | { kind: "vanished" };

export interface StopRecord {
  at: UnixSecs;
  reason: StopReason;
}

export interface WatchdogInfo {
  deadline: UnixSecs | null;
  idle_timeout: DurationSecs | null;
  cancelled: boolean;
  armed: boolean;
}

export interface TrackedSession {
  name: string;
  account: AccountId;
  endpoint: string | null;
  accelerator: Accelerator;
  high_mem: boolean;
  gpu: string | null;
  vram_mib: number | null;
  policy: GuardPolicy;
  spend: SpendMeter;
  watchdog: WatchdogInfo | null;
  stopped: StopRecord | null;
  measured_rate: RateReading | null;
}

export interface RuntimeRef {
  account: AccountId;
  endpoint: string;
  name: string | null;
}

export interface Runtime {
  id: RuntimeRef;
  account_email: string | null;
  on_active_account: boolean;
  accelerator: Accelerator | null;
  hardware: string;
  high_mem: boolean;
  managed: boolean;
  tracked: TrackedSession | null;
  estimated_rate_cu_per_hour: number | null;
  estimated_spend_cu: number | null;
  auto_stop_at: UnixSecs | null;
  tunnels: TunnelId[];
}

export interface AccountError {
  account: AccountId;
  error: CoreError;
}

export interface RuntimesView {
  runtimes: Runtime[];
  errors: AccountError[];
}

export type ForwardBind = "loopback" | "all_interfaces";

export interface TunnelSpec {
  account: AccountId;
  session: string;
  bind: ForwardBind;
  local_port: number;
  remote_port: number;
  health_path: string | null;
}

export type TunnelState =
  | { state: "starting" }
  | { state: "up" }
  | { state: "reconnecting"; attempt: number; delay_secs: number }
  | { state: "failed"; error: CoreError }
  | { state: "stopped" };

export interface TunnelInfo {
  id: TunnelId;
  spec: TunnelSpec;
  state: TunnelState;
  healthy: boolean | null;
}

export type TunnelEvent =
  | { event: "state"; id: TunnelId; state: TunnelState }
  | { event: "health"; id: TunnelId; healthy: boolean };

export interface AccountUsageView {
  account: AccountId;
  email: string | null;
  snapshot: UsageSnapshot | null;
  eta: DurationSecs | null;
  history: BalancePoint[];
  unmanaged_runtimes: number;
  ownership_verified: boolean;
  session_rates: Record<string, number>;
  last_error: CoreError | null;
}

export interface GuardDecision {
  session: RuntimeRef;
  decision: Decision;
  stopped: boolean;
  error: CoreError | null;
}

export interface GuardReport {
  decisions: GuardDecision[];
  vanished: RuntimeRef[];
  usage: AccountUsageView[];
}

export type GuardEventKind =
  | { kind: "warn"; concerns: Concern[] }
  | { kind: "stop_failed"; concern: Concern; error: CoreError }
  | { kind: "stopped"; concern: Concern }
  | { kind: "vanished" };

export type GuardEvent = {
  id: number;
  at: UnixSecs;
  session: RuntimeRef;
  label: string;
  email: string | null;
} & GuardEventKind;

export type EndReason =
  | { kind: "user" }
  | { kind: "guard"; concern: Concern }
  | { kind: "vanished" };

export interface EndedRuntime {
  runtime: RuntimeRef;
  label: string;
  email: string | null;
  reason: EndReason;
  at: UnixSecs | null;
}

export type Operation =
  | { kind: "provision"; session: string }
  | { kind: "plugin_run"; plugin: string; session: string }
  | { kind: "switch_account"; to: AccountId }
  | { kind: "login"; login_id?: number }
  | { kind: "domain"; name: string; key: string };

export interface PendingOperation {
  id: number;
  operation: Operation;
  cancelling: boolean;
}

export interface Snapshot {
  version: number;
  server_now?: UnixSecs;
  backend: BackendKind;
  account: AccountContext;
  accounts: AccountsView | null;
  accounts_error: ErrorKind | null;
  runtimes: RuntimesView | null;
  runtimes_error: ErrorKind | null;
  tunnels: TunnelInfo[];
  usage: AccountUsageView[];
  measured_rates?: HardwareRate[];
  guard: GuardReport | null;
  guard_events?: GuardEvent[];
  guard_error: ErrorKind | null;
  ended?: EndedRuntime[];
  settings_notice?: SettingsNotice | null;
  operations: PendingOperation[];
  login_id: number | null;
  shutting_down: boolean;
}

export type InstallMethod = "uv" | "install_uv_then_cli" | "pip_user";

export interface ProbeReport {
  readonly wsl_installed: boolean;
  readonly wsl_distros: readonly string[];
  readonly bash: string | null;
  readonly ssh: string | null;
  readonly ssh_keygen: string | null;
  readonly git: string | null;
  readonly uv: string | null;
  readonly python3: string | null;
  readonly colab: string | null;
  readonly colab_version: string | null;
  readonly helper_python: string | null;
  readonly keyring_ok: boolean;
  readonly ssh_key_present: boolean;
  readonly home: string | null;
  readonly errors: readonly string[];
}

export interface HostCheck {
  readonly kind: "wsl" | "shell_tools";
  readonly ready: boolean;
  readonly hint_key: string | null;
}

export interface KeyringCheck {
  readonly status: "unavailable" | "ready" | "unknown";
  readonly hint_key: string | null;
}

export interface ForwardPolicyView {
  readonly all_interfaces_allowed: boolean;
  readonly restriction: "windows_or_wsl" | "loopback_listener" | string | null;
}

export interface UnmanagedRuntimes {
  readonly count: number | null;
  readonly incomplete: boolean;
  readonly unverified_accounts: readonly AccountId[];
  readonly warning_key: string | null;
}

export interface OverviewResponse {
  readonly environment: ProbeReport;
  readonly host: HostCheck;
  readonly forward_policy: ForwardPolicyView;
  readonly cli_installed: boolean;
  readonly helper_available: boolean;
  readonly keyring: KeyringCheck;
  readonly accounts: AccountsView | null;
  readonly accounts_error: ErrorKind | null;
  readonly usage: readonly AccountUsageView[];
  readonly measured_rates?: readonly HardwareRate[];
  readonly sampled_at?: UnixSecs;
  readonly unmanaged_runtimes: UnmanagedRuntimes;
  readonly install_methods: readonly InstallMethod[];
}

export interface ForwardAddresses {
  readonly open_url: string | null;
  readonly copy_url: string | null;
  readonly openai_base_url: string | null;
  readonly notice_key: string | null;
  readonly warning_key: string | null;
}

export interface ForwardView extends TunnelInfo {
  readonly addresses?: ForwardAddresses | null;
}

export interface AccountFailureResponse {
  readonly account: AccountId;
  readonly error: ApiErrorPayload;
}

export interface SessionsListResponse {
  readonly account_context: AccountContext;
  readonly sampled_at: UnixSecs;
  readonly runtimes: Runtime[];
  readonly errors: AccountFailureResponse[];
  readonly guard: GuardReport | null;
  readonly guard_events?: readonly GuardEvent[];
  readonly guard_error: ErrorKind | null;
  readonly ended?: readonly EndedRuntime[];
}

export interface AccountsApiResponse {
  readonly account_context: AccountContext;
  readonly accounts: AccountsView;
  readonly usage: AccountUsageView[];
  readonly login_id: number | null;
  readonly sampled_at?: UnixSecs;
}

export interface StopAllRemainingItem {
  readonly target: RuntimeRef;
  readonly error: ApiErrorPayload | null;
}

export interface StopAllResponse {
  readonly verified: boolean;
  readonly remaining: readonly StopAllRemainingItem[];
  readonly account_errors: readonly AccountFailureResponse[];
}

export type UpdateCheckStatus = "idle" | "up_to_date" | "available" | "failed";

export interface UpdateNoticeResponse {
  readonly current_version: string;
  readonly update_available: boolean;
  readonly releases_url: string;
  readonly release_url: string | null;
  readonly latest_version: string | null;
  readonly status: UpdateCheckStatus;
  readonly checked_at: UnixSecs | null;
  readonly check_updates: boolean;
  readonly error: ApiErrorPayload | null;
  readonly persist_error: ApiErrorPayload | null;
}
