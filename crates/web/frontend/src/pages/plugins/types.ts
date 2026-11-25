/**
 * Wire types for the Plugins management and live run endpoints (`/api/plugins`,
 * `/api/plugins/previews`, `/api/plugins/hf/token`, `/api/plugins/runs`, and
 * `/api/plugins/runs/{id}/events`).
 * Aligned with `crates/core/src/plugins.rs`, `crates/core/src/vm.rs`,
 * `crates/web/src/api/plugins.rs`, and `crates/web/src/state/plugins.rs`.
 */

import type { AccountId, ApiErrorPayload } from "../../lib/types.ts";
import type { ForwardView, ProvisionProgressEvent } from "../sessions/api.ts";

export type LocalizedText = Readonly<Record<string, string>>;

export type PluginSource = { readonly kind: "bundled" } | { readonly kind: "user" };

export type PluginOrigin =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "git"; readonly url: string };

export type PluginInputKind = "text" | "number" | "bool" | "select" | "secret" | "hf-model";

export interface PluginInputSpec {
  readonly id: string;
  readonly type: PluginInputKind;
  readonly required: boolean;
  readonly label: LocalizedText;
  readonly help: LocalizedText;
}

export interface PluginStageSpec {
  readonly id: string;
  readonly label: LocalizedText;
}

export interface PluginEndpointSpec {
  readonly id: string;
  readonly path: string;
  readonly kind: string;
  readonly label: LocalizedText;
}

export interface ResolvedEndpoint {
  readonly id: string;
  readonly remote_port: number;
  readonly path: string;
  readonly health: string | null;
  readonly kind: string;
  readonly label: LocalizedText;
}

export type PluginCapability = "hf_token";

export interface PluginRunSpec {
  readonly script: string;
}

export interface PluginManifest {
  readonly api: number;
  readonly id: string;
  readonly version: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly inputs: readonly PluginInputSpec[];
  readonly run: PluginRunSpec;
  readonly stages: readonly PluginStageSpec[];
  readonly endpoints: readonly PluginEndpointSpec[];
  readonly needs: readonly PluginCapability[];
}

export interface PluginInfo {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly enabled: boolean;
}

export interface PluginPreviewResponse {
  readonly preview_id: string;
  readonly manifest: PluginManifest;
  readonly script_bytes: number;
  readonly replaces_version: string | null;
  readonly warning_key: string;
}

export interface HfTokenStatus {
  readonly saved: boolean;
}

export interface PluginRunMetadata {
  readonly plugin: string;
  readonly account: AccountId;
  readonly session: string;
  readonly provisions: boolean;
}

export interface PluginRunSummary extends PluginRunMetadata {
  readonly id: number;
  readonly finished: boolean;
}

export type PluginRunState = "starting" | "running" | "ready" | "failed";

export interface PluginRunStatus {
  readonly state: PluginRunState;
  readonly stage: string | null;
  readonly progress: number | null;
  readonly message: string | null;
  readonly outputs: Readonly<Record<string, unknown>>;
}

export interface PluginRunOutcome {
  readonly session: string;
  readonly account: AccountId;
  readonly run_id: string;
  readonly status: PluginRunStatus;
}

export interface PluginRunEndpointResult {
  readonly endpoint: ResolvedEndpoint;
  readonly error: ApiErrorPayload | null;
  readonly forward: ForwardView | null;
}

export type PluginRunPhase = "running" | "ready" | "cancelled" | "failed";

export interface PluginRunFinishedEvent {
  readonly phase: Exclude<PluginRunPhase, "running">;
  readonly run: PluginRunMetadata;
  readonly outcome: PluginRunOutcome | null;
  readonly endpoints: readonly PluginRunEndpointResult[];
  readonly error: ApiErrorPayload | null;
}

export type PluginRunLogEntry =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "history_skipped" }
  | { readonly kind: "log_skipped"; readonly path: string; readonly message_key: string };

export interface PluginRunDetail {
  readonly id: number;
  readonly plugin: string;
  readonly account: AccountId;
  readonly session: string;
  readonly provisions: boolean;
  readonly launched: boolean;
  readonly provisionAllocated: boolean;
  readonly runId: string | null;
  readonly phase: PluginRunPhase;
  readonly provisionEvents: readonly ProvisionProgressEvent[];
  readonly latestProvisionAtMs: number;
  readonly status: PluginRunStatus | null;
  readonly logEntries: readonly PluginRunLogEntry[];
  readonly outcome: PluginRunOutcome | null;
  readonly endpoints: readonly PluginRunEndpointResult[];
  readonly error: ApiErrorPayload | null;
  readonly streamError: unknown | null;
  readonly cancelRequested: boolean;
  readonly finishedLive: boolean;
}
