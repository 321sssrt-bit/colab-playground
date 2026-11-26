/**
 * Typed Sessions and Forwards HTTP/SSE API adapters built on the shared Bearer client.
 */

import { apiClient, type EventStreamOptions } from "../../lib/api.ts";
import type { OnExhausted } from "../../lib/constants.ts";
import type {
  Accelerator,
  AccountContext,
  AccountFailureResponse,
  AccountId,
  ApiErrorPayload,
  CoreError,
  DurationSecs,
  ForwardAddresses,
  ForwardBind,
  ForwardPolicyView,
  ForwardView,
  GuardPolicy,
  HardwareRate,
  RuntimeRef,
  SessionsListResponse,
  StopAllRemainingItem,
  StopAllResponse,
  UnixSecs,
  WatchdogInfo,
} from "../../lib/types.ts";

export type {
  AccountFailureResponse,
  ForwardAddresses,
  ForwardPolicyView,
  ForwardView,
  SessionsListResponse,
  StopAllRemainingItem,
  StopAllResponse,
};

export interface SessionTemplateResponse extends ProvisionSpec {
  readonly measured_rates?: readonly HardwareRate[];
  readonly sampled_at?: UnixSecs;
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

export interface ProvisionSpec {
  readonly name: string;
  readonly accelerator: Accelerator;
  readonly high_mem: boolean;
  readonly min_vram_mib: number | null;
  readonly max_attempts: number;
  readonly retry_delay: DurationSecs;
  readonly on_exhausted: OnExhausted;
  readonly guard: GuardPolicy;
}

export interface ProvisionOutcome {
  readonly name: string;
  readonly hardware: {
    readonly gpu: string | null;
    readonly vram_mib: number | null;
  };
  readonly attempts: number;
  readonly below_spec: boolean;
  readonly watchdog: WatchdogInfo | null;
  readonly started_at: UnixSecs;
}

export interface AcceptedProvisionResponse {
  readonly id: number;
}

export interface ProvisionFinishedEvent {
  readonly phase: "ready" | "cancelled" | "failed";
  readonly outcome?: ProvisionOutcome;
  readonly error?: ApiErrorPayload;
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

export function ackGuardEvents(payload: {
  readonly up_to_id?: number;
  readonly ids?: readonly number[];
}): Promise<void> {
  return apiClient.request<void>("/api/sessions/guard/ack", {
    method: "POST",
    body: payload,
  });
}

export function fetchSessionTemplate(signal?: AbortSignal): Promise<SessionTemplateResponse> {
  return apiClient.request<SessionTemplateResponse>("/api/sessions/template", {
    method: "GET",
    signal,
  });
}

export function startProvision(
  accountContext: AccountContext,
  spec: ProvisionSpec,
): Promise<AcceptedProvisionResponse> {
  return apiClient.request<AcceptedProvisionResponse>("/api/sessions", {
    method: "POST",
    body: {
      account_context: accountContext,
      spec,
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
