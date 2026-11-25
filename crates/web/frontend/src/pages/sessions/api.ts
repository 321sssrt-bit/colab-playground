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

export interface SessionsListResponse {
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

export interface ForwardView extends TunnelInfo {
  readonly addresses?: ForwardAddresses | null;
}

export interface ClosedForwardResponse {
  readonly billing_continues: boolean;
  readonly notice_key: string;
}

export type AutoStopAction =
  | { readonly kind: "extend"; readonly seconds: number }
  | { readonly kind: "set"; readonly seconds: number }
  | { readonly kind: "cancel" };

export interface AutoStopResponse {
  readonly app_limit_seconds: number | null;
  readonly watchdog_armed: boolean;
  readonly watchdog: WatchdogInfo | null;
  readonly warning_key: string | null;
}

export interface OverviewReadinessResponse {
  readonly cli_installed: boolean;
}

export type ProvisionProgressEvent =
  | { readonly event: "allocating"; readonly attempt: number; readonly of: number }
  | {
      readonly event: "allocation_failed";
      readonly attempt: number;
      readonly error: ApiErrorPayload | CoreError;
    }
  | { readonly event: "probed"; readonly gpu: string | null; readonly vram_mib: number | null }
  | {
      readonly event: "rejected";
      readonly got_mib: number | null;
      readonly min_mib: number;
    }
  | { readonly event: "releasing" }
  | { readonly event: "reconciling" }
  | { readonly event: "orphan_released" }
  | { readonly event: "orphan_left" }
  | { readonly event: "retrying"; readonly wait_secs: number }
  | { readonly event: "watchdog_started"; readonly deadline: UnixSecs | null }
  | { readonly event: "watchdog_failed"; readonly error: ApiErrorPayload | CoreError }
  | {
      readonly event: "ready";
      readonly gpu: string | null;
      readonly vram_mib: number | null;
      readonly below_spec?: boolean;
    };

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
