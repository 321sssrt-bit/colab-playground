/**
 * Pure presentation and address-resolution helpers for Plugin run logs and Endpoint cards.
 *
 * Security boundary: never fabricates a browser origin or remote host on the client.
 * Server-validated origins come strictly from `ForwardAddresses`; manifest `path` and
 * `kind` are re-applied on top of that origin so reopening or re-binding a forward
 * never falls back to `/` or a hardcoded `/v1`.
 */

import type { AccountId, TunnelInfo, TunnelState } from "../../lib/types.ts";
import type { ForwardAddresses } from "../sessions/api.ts";
import { safeHttpUrl } from "../sessions/format.ts";
import type { ResolvedEndpoint } from "./types.ts";

const ESC_PREFIX = String.fromCharCode(0x1b);
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC_PREFIX}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|${ESC_PREFIX}\\\\))`,
  "g",
);

export interface ForwardLiveOverlay {
  readonly snapshotVersion: number;
  readonly state?: TunnelState;
  readonly healthy?: boolean | null;
}

export interface ResolvedEndpointUrls {
  readonly origin: string | null;
  readonly openUrl: string | null;
  readonly copyUrl: string | null;
  readonly openaiBaseUrl: string | null;
  readonly notice_key: string | null;
  readonly warning_key: string | null;
}

/**
 * Strips ANSI terminal escape codes so streamed plugin logs render cleanly as plain text.
 */
export function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "");
}

/**
 * Normalizes a manifest endpoint path the same way `ForwardAddresses::for_request` does:
 * strips trailing slashes (`"/"` becomes `""`, `"/custom/v1/"` becomes `"/custom/v1"`).
 */
export function normalizeEndpointPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\/+$/, "");
  if (trimmed === "") {
    return "";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * Extracts a validated `http:` or `https:` origin from server-supplied `ForwardAddresses`.
 * Returns `null` whenever the server withheld browser links (e.g. remote loopback notice).
 */
function extractValidatedOrigin(addresses: ForwardAddresses | null | undefined): string | null {
  if (!addresses) {
    return null;
  }
  const candidates = [addresses.open_url, addresses.copy_url, addresses.openai_base_url];
  for (const candidate of candidates) {
    const safe = safeHttpUrl(candidate);
    if (safe) {
      try {
        return new URL(safe).origin;
      } catch {
        // Ignore unparseable URL candidates.
      }
    }
  }
  return null;
}

/**
 * Re-applies the manifest's declared `path` and `kind` over the server-validated origin.
 * Matches `ForwardAddresses::for_request` in `crates/web/src/api/forwards.rs`.
 */
export function resolveEndpointAddresses(
  addresses: ForwardAddresses | null | undefined,
  endpoint: ResolvedEndpoint,
): ResolvedEndpointUrls {
  const origin = extractValidatedOrigin(addresses);
  const notice_key = addresses?.notice_key ?? null;
  const warning_key = addresses?.warning_key ?? null;

  if (!origin) {
    return {
      origin: null,
      openUrl: null,
      copyUrl: null,
      openaiBaseUrl: null,
      notice_key,
      warning_key,
    };
  }

  const cleanPath = normalizeEndpointPath(endpoint.path);
  const fullUrl = `${origin}${cleanPath}`;

  if (endpoint.kind === "openai") {
    return {
      origin,
      openUrl: origin,
      copyUrl: fullUrl,
      openaiBaseUrl: fullUrl,
      notice_key,
      warning_key,
    };
  }

  return {
    origin,
    openUrl: fullUrl,
    copyUrl: fullUrl,
    openaiBaseUrl: null,
    notice_key,
    warning_key,
  };
}

/**
 * Builds the server-local loopback URL for an OpenAI cURL example when the browser is
 * connected remotely to a loopback-bound forward (`web.forward.server_local`).
 */
export function buildServerLocalEndpointUrl(localPort: number, endpoint: ResolvedEndpoint): string {
  const cleanPath = normalizeEndpointPath(endpoint.path);
  return `http://127.0.0.1:${localPort}${cleanPath}`;
}

/**
 * Formats a fallback bind address label when the server withholds browser-reachable URLs.
 */
export function formatEndpointBindFallback(
  tunnel: TunnelInfo,
  endpoint: ResolvedEndpoint,
): string {
  const host = tunnel.spec.bind === "all_interfaces" ? "0.0.0.0" : "127.0.0.1";
  const cleanPath = normalizeEndpointPath(endpoint.path);
  return `${host}:${tunnel.spec.local_port}${cleanPath}`;
}

/**
 * Builds an OpenAI-compatible `curl` example using the resolved base URL and model output.
 */
export function buildOpenAiCurl(
  baseUrl: string,
  modelId: string,
  hasSecretInput: boolean,
): string {
  const safeBase = baseUrl.replace(/\/+$/, "");
  const payload = JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "Hello" }],
  }).replace(/'/g, "'\\''");
  const auth = hasSecretInput ? ' \\\n  -H "Authorization: Bearer $API_KEY"' : "";
  return `curl ${safeBase}/chat/completions \\\n  -H "Content-Type: application/json"${auth} \\\n  -d '${payload}'`;
}

/**
 * Picks the active live tunnel matching a plugin endpoint from `snapshot.tunnels`
 * and applies any same-version SSE `forward` transition overlays.
 */
export function selectEndpointTunnel(
  tunnels: readonly TunnelInfo[],
  account: AccountId,
  session: string,
  remotePort: number,
  overlaysById: Readonly<Record<number, ForwardLiveOverlay>>,
  snapshotVersion: number,
): TunnelInfo | null {
  for (const tunnel of tunnels) {
    if (
      tunnel.spec.account !== account ||
      tunnel.spec.session !== session ||
      tunnel.spec.remote_port !== remotePort
    ) {
      continue;
    }
    const overlay = overlaysById[tunnel.id];
    const activeOverlay =
      overlay && overlay.snapshotVersion === snapshotVersion ? overlay : null;
    const effectiveState = activeOverlay?.state ?? tunnel.state;
    if (effectiveState.state === "failed" || effectiveState.state === "stopped") {
      continue;
    }
    return {
      ...tunnel,
      state: effectiveState,
      healthy: activeOverlay?.healthy !== undefined ? activeOverlay.healthy : tunnel.healthy,
    };
  }
  return null;
}
