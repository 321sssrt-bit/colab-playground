/**
 * Wire contracts aligned with `crates/web/src/http.rs`, `crates/web/src/api/mod.rs`,
 * `crates/web/src/state.rs`, and `crates/core/src/*`.
 */

export type BackendKind = "real" | "mock";

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
  backend: BackendKind;
  account: AccountContext;
  accounts: AccountsView | null;
  accounts_error: ErrorKind | null;
  runtimes: RuntimesView | null;
  runtimes_error: ErrorKind | null;
  tunnels: TunnelInfo[];
  usage: AccountUsageView[];
  guard: GuardReport | null;
  guard_error: ErrorKind | null;
  operations: PendingOperation[];
  login_id: number | null;
  shutting_down: boolean;
}
