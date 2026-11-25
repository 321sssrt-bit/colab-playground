/**
 * Wire types for the Plugins management endpoints (`/api/plugins`, `/api/plugins/previews`,
 * and `/api/plugins/hf/token`).
 * Aligned with `crates/core/src/plugins.rs` and `crates/web/src/api/plugins.rs`.
 */

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

export interface PluginEndpointSpec {
  readonly id: string;
  readonly path: string;
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
