/**
 * Typed Sessions and Forwards HTTP/SSE API adapters built on the shared Bearer client.
 */

import { apiClient, type EventStreamOptions } from "../../lib/api.ts";
import type {
  AccountContext,
  AccountId,
  ApiErrorPayload,
  CoreError,
  ErrorKind,
  ForwardBind,
  GuardReport,
  Runtime,
  RuntimeRef,
  SettingsView,
  TunnelInfo,
  UnixSecs,
  WatchdogInfo,
} from "../../lib/types.ts";

export interface AccountFailureResponse {
  readonly account: AccountId;
  readonly error: ApiErrorPayload;
}

interface SessionsListResponse {
  readonly account_context: AccountContext;
  readonly sampled_at: UnixSecs;
  readonly runtimes: Runtime[];
  readonly errors: AccountFailureResponse[];
  readonly guard: GuardReport | null;
  readonly guard_error: ErrorKind | null;
}

export interface ForwardAddresses {
  readonly open_url: string | null;
  readonly copy_url: string | null;
  readonly openai_base_url: string | null;
  readonly notice_key: string | null;
  readonly warning_key: string | null;
}

export interface ForwardPolicyView {
  readonly all_interfaces_allowed: boolean;
  readonly restriction: "windows_or_wsl" | "loopback_listener" | string | null;
}

export interface ForwardView extends TunnelInfo {
  readonly addresses?: ForwardAddresses | null;
}

interface OpenForwardPayload {
  readonly account_context: AccountContext;
  readonly account: AccountId;
  readonly session: string;
  readonly bind: ForwardBind;
  readonly local_port: number;
  readonly remote_port: number;
  readonly health_path: string | null;
}

interface ClosedForwardResponse {
  readonly billing_continues: boolean;
  readonly notice_key: string;
}

type AutoStopAction =
  | { readonly kind: "extend"; readonly seconds: number }
  | { readonly kind: "set"; readonly seconds: number }
  | { readonly kind: "cancel" };

interface AutoStopResponse {
  readonly app_limit_seconds: number | null;
  readonly watchdog_armed: boolean;
  readonly watchdog: WatchdogInfo | null;
  readonly warning_key: string | null;
}

interface StopAllRemainingItem {
  readonly target: RuntimeRef;
  readonly error: ApiErrorPayload | null;
}

export interface StopAllResponse {
  readonly verified: boolean;
  readonly remaining: readonly StopAllRemainingItem[];
  readonly account_errors: readonly AccountFailureResponse[];
}

interface OverviewReadinessResponse {
  readonly cli_installed: boolean;
  readonly forward_policy?: ForwardPolicyView | null;
}

export type ProvisionProgressEvent =
  | { readonly event: "allocating"; readonly attempt: number; readonly max_attempts: number }
  | { readonly event: "allocated"; readonly attempt: number }
  | {
      readonly event: "allocation_failed";
      readonly attempt: number;
      readonly error: ApiErrorPayload | CoreError;
    }
  | {
      readonly event: "probed";
      readonly attempt?: number;
      readonly gpu: string | null;
      readonly vram_mib: number | null;
    }
  | {
      readonly event: "rejected";
      readonly attempt?: number;
      readonly gpu: string | null;
      readonly vram_mib: number | null;
      readonly min_vram_mib: number;
    }
  | { readonly event: "releasing"; readonly attempt?: number }
  | { readonly event: "reconciling"; readonly attempt?: number }
  | { readonly event: "orphan_detected"; readonly endpoint: string; readonly released: boolean }
  | { readonly event: "retrying"; readonly attempt?: number; readonly delay_secs: number }
  | { readonly event: "watchdog_started"; readonly deadline: UnixSecs | null }
  | { readonly event: "watchdog_failed"; readonly error: ApiErrorPayload | CoreError }
  | {
      readonly event: "ready";
      readonly name?: string;
      readonly gpu: string | null;
      readonly vram_mib: number | null;
      readonly below_spec?: boolean;
    }
  | { readonly event: "failed"; readonly error: ApiErrorPayload | CoreError };

export interface ProvisionFinishedEvent {
  readonly phase: "ready" | "cancelled" | "failed";
  readonly outcome?: {
    readonly hardware?: { readonly gpu: string | null; readonly vram_mib: number | null };
    readonly below_spec?: boolean;
  };
  readonly error?: ApiErrorPayload;
}

export function fetchSessions(signal?: AbortSignal): Promise<SessionsListResponse> {
  return apiClient.request<SessionsListResponse>("/api/sessions", {
    method: "GET",
    signal,
  });
}

export function fetchForwards(signal?: AbortSignal): Promise<ForwardView[]> {
  return apiClient.request<ForwardView[]>("/api/forwards", {
    method: "GET",
    signal,
  });
}

export function openForward(payload: OpenForwardPayload): Promise<ForwardView> {
  return apiClient.request<ForwardView>("/api/forwards", {
    method: "POST",
    body: payload,
  });
}

export function closeForward(id: number): Promise<ClosedForwardResponse> {
  return apiClient.request<ClosedForwardResponse>(`/api/forwards/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    body: {},
  });
}

export function changeAutoStop(
  accountContext: AccountContext,
  target: RuntimeRef,
  action: AutoStopAction,
): Promise<AutoStopResponse> {
  return apiClient.request<AutoStopResponse>("/api/sessions/auto-stop", {
    method: "POST",
    body: {
      account_context: accountContext,
      target,
      action,
    },
  });
}

export function stopRuntime(target: RuntimeRef): Promise<void> {
  return apiClient.request<void>("/api/sessions/stop", {
    method: "POST",
    body: {
      target,
      confirmed: true,
    },
  });
}

export function stopAllRuntimes(): Promise<StopAllResponse> {
  return apiClient.request<StopAllResponse>("/api/sessions/stop-all", {
    method: "POST",
    body: {
      confirmed: true,
    },
  });
}

export function cancelProvision(id: number): Promise<void> {
  return apiClient.request<void>(`/api/sessions/${encodeURIComponent(String(id))}/cancel`, {
    method: "POST",
    body: {},
  });
}

export function openProvisionEventStream(
  id: number,
  options: Omit<EventStreamOptions, "body">,
): Promise<void> {
  return apiClient.openEventStream(`/api/sessions/${encodeURIComponent(String(id))}/events`, {
    ...options,
    body: {},
  });
}

export function fetchSettings(signal?: AbortSignal): Promise<SettingsView> {
  return apiClient.request<SettingsView>("/api/settings", {
    method: "GET",
    signal,
  });
}

export function fetchOverviewReadiness(signal?: AbortSignal): Promise<OverviewReadinessResponse> {
  return apiClient.request<OverviewReadinessResponse>("/api/overview", {
    method: "GET",
    signal,
  });
}
