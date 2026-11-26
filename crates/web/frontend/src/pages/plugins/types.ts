/**
 * Wire types for the Plugins management and live run endpoints (`/api/plugins`,
 * `/api/plugins/previews`, `/api/plugins/hf/token`, `/api/plugins/runs`, and
 * `/api/plugins/runs/{id}/events`).
 * Aligned with `crates/core/src/plugins.rs`, `crates/core/src/vm.rs`,
 * `crates/web/src/api/plugins.rs`, and `crates/web/src/state/plugins.rs`.
 */

import type {
  Accelerator,
  AccountContext,
  AccountId,
  ApiErrorPayload,
  Runtime,
  RuntimeRef,
} from "../../lib/types.ts";
import type { ForwardView, ProvisionProgressEvent, ProvisionSpec } from "../sessions/api.ts";
import type { ProvisionDraft } from "../sessions/ProvisionFields.tsx";

export type LocalizedText = Readonly<Record<string, string>>;

export type PluginSource = { readonly kind: "bundled" } | { readonly kind: "user" };

export type PluginOrigin =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "git"; readonly url: string };

export type PluginInputKind = "text" | "number" | "bool" | "select" | "secret" | "hf-model";

export type PluginInputValue = boolean | number | string;

export interface PluginInputSpec {
  readonly id: string;
  readonly type: PluginInputKind;
  readonly required: boolean;
  readonly label: LocalizedText;
  readonly help: LocalizedText;
  readonly default?: PluginInputValue | null;
  readonly options?: readonly string[];
  readonly min?: number | null;
  readonly max?: number | null;
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

type PluginRunTarget =
  | { readonly kind: "existing"; readonly name: string }
  | ({ readonly kind: "provision" } & ProvisionSpec);

export interface PluginRunTemplateSpec {
  readonly plugin: string;
  readonly inputs: Readonly<Record<string, PluginInputValue>>;
  readonly target: PluginRunTarget;
  readonly stop_on_failure: boolean;
}

export interface StartPluginRunRequest {
  readonly account_context: AccountContext;
  readonly spec: PluginRunTemplateSpec;
  readonly existing: RuntimeRef | null;
}

export interface AcceptedPluginRun {
  readonly id: number;
}

export interface HfModel {
  readonly id: string;
  readonly downloads: number;
  readonly likes: number;
  readonly gated: boolean;
}

export type KvType = "f16" | "q8_0" | "q4_0";

export interface GgufFile {
  readonly path: string;
  readonly size: number;
}

export interface GgufVariant {
  readonly quant: string;
  readonly files: readonly string[];
  readonly size: number;
}

export interface GgufListing {
  readonly variants: readonly GgufVariant[];
  readonly mmproj: readonly GgufFile[];
}

export interface GgufFitOptions {
  readonly vram_mib?: number | null;
  readonly ctx?: number;
  readonly model_ctx?: number | null;
  readonly kv_bytes_per_token?: number | null;
  readonly mmproj_bytes?: number;
  readonly kv?: KvType | null;
}

export interface GgufEstimateRequest {
  readonly repo: string;
  readonly accelerator?: Accelerator | null;
  readonly fit?: GgufFitOptions;
  readonly quant?: string | null;
  readonly refresh?: boolean;
}

export interface GgufFitChoice {
  readonly quant: string;
  readonly kv: KvType;
  readonly ctx: number;
  readonly estimate_mib: number;
  readonly budget_mib: number;
  readonly ctx_reduced: boolean;
  readonly kv_reduced: boolean;
}

export interface GgufFitEntry {
  readonly vram_mib: number;
  readonly fit: GgufFitChoice | null;
  readonly fit_error: ApiErrorPayload | null;
}

export interface GgufEstimateResponse {
  readonly listing: GgufListing;
  readonly fits: readonly GgufFitEntry[];
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
  readonly phase: PluginRunPhase;
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
  readonly phase: PluginRunPhase;
  readonly provisionEvents: readonly ProvisionProgressEvent[];
  readonly latestProvisionAtMs: number;
  readonly status: PluginRunStatus | null;
  readonly logEntries: readonly PluginRunLogEntry[];
  readonly logSkipped: { readonly path: string; readonly message_key: string } | null;
  readonly outcome: PluginRunOutcome | null;
  readonly endpoints: readonly PluginRunEndpointResult[];
  readonly error: ApiErrorPayload | null;
  readonly streamError: unknown | null;
  readonly cancelRequested: boolean;
  readonly finishedLive: boolean;
}

export interface PluginRunBillingCheck {
  readonly runId: number;
  readonly status: "checking" | "verified" | "error";
  readonly runtime: Runtime | null;
  readonly accountErrored: boolean;
  readonly snapshotVersion: number;
}

export type PluginRunBillingPhase = "checking" | "billing" | "unknown" | "no_session" | "stopped";

export interface PluginRunBillingState {
  readonly phase: PluginRunBillingPhase;
  readonly runtime: Runtime | null;
}

export type HfTokenState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly saved: boolean }
  | { readonly kind: "error"; readonly error: unknown };

export interface GgufPreviewData {
  readonly repo: string;
  readonly requestedCtx: number;
  readonly fitKey: string;
  readonly response: GgufEstimateResponse;
}

export interface PluginDeployHfDraft {
  readonly searchQuery: string;
  readonly searchModels: readonly HfModel[] | null;
  readonly activeRepo: string | null;
  readonly ggufPreview: GgufPreviewData | null;
}

export interface SelectedExistingTarget {
  readonly name: string;
  readonly account: AccountId;
  readonly runtime: RuntimeRef;
}

export type TargetLost =
  | { readonly kind: "ended"; readonly name: string }
  | { readonly kind: "other_account"; readonly name: string };

export interface PluginDeployFormDraft {
  readonly pluginId: string;
  readonly openSeq: number;
  readonly loadPhase: "loading" | "ready" | "error";
  readonly loadError: unknown | null;
  readonly textValues: Readonly<Record<string, string>>;
  readonly boolValues: Readonly<Record<string, boolean>>;
  readonly baseProvisionSpec: ProvisionSpec | null;
  readonly provisionDraft: ProvisionDraft | null;
  readonly sessionName: string;
  readonly retryDelaySecs: number;
  readonly stopOnFailure: boolean;
  readonly selectedExisting: SelectedExistingTarget | null;
  readonly targetLost: TargetLost | null;
  readonly originAccountContext: AccountContext | null;
  readonly hfByInputId: Readonly<Record<string, PluginDeployHfDraft>>;
}
