/**
 * Ready Plugin Endpoint card: health status badge, Forward switch, `forward_policy`-aware
 * bind address selector, Copy & Open in browser actions, and OpenAI cURL example.
 *
 * Re-applies the manifest's declared `path` and `kind` over the server-validated origin
 * so closing/reopening or switching bind addresses never loses custom paths or cURL URLs.
 */

import { useEffect, useId, useRef, useState } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import { webStore } from "../../lib/store.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type {
  AccountContext,
  ApiErrorPayload,
  ForwardBind,
  Locale,
  TunnelInfo,
} from "../../lib/types.ts";
import {
  closeForward,
  openForward,
  type ForwardAddresses,
  type ForwardPolicyView,
} from "../sessions/api.ts";
import {
  copyTextToClipboard,
  formatErrorMessage,
  type FormattedError,
} from "../sessions/format.ts";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  SmallInfoIcon,
} from "../sessions/Icons.tsx";
import { resolveLocalizedText } from "./api.ts";
import {
  buildOpenAiCurl,
  buildServerLocalEndpointUrl,
  formatEndpointBindFallback,
  resolveEndpointAddresses,
} from "./endpoint.ts";
import { cachePluginForwardAddresses, refreshPluginForwards } from "./runStore.ts";
import type { PluginRunOutcome, ResolvedEndpoint } from "./types.ts";

const COPY_FEEDBACK_MS = 2000;
const FALLBACK_MODEL_ID = "MODEL";

export interface EndpointCardProps {
  readonly endpoint: ResolvedEndpoint;
  readonly outcome: PluginRunOutcome;
  readonly initialError: ApiErrorPayload | null;
  readonly activeTunnel: TunnelInfo | null;
  readonly serverAddresses: ForwardAddresses | null;
  readonly forwardPolicy: ForwardPolicyView | null;
  readonly forwardPolicyLoading: boolean;
  readonly forwardPolicyError: unknown | null;
  readonly onRetryForwardPolicy: () => void;
  readonly currentAccountContext: AccountContext | null;
  readonly hasSecretInput: boolean;
  readonly shuttingDown: boolean;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
}

function renderHealthBadge(tunnel: TunnelInfo | null, t: TranslateFn) {
  if (!tunnel) {
    return <span className="badge">{t("app.b2.endpoint_not_forwarded")}</span>;
  }
  switch (tunnel.state.state) {
    case "starting":
      return <span className="badge badge-info">{t("app.b2.tunnel_starting")}</span>;
    case "up":
      if (tunnel.healthy === true) {
        return <span className="badge badge-success">{t("app.b2.endpoint_healthy")}</span>;
      }
      if (tunnel.healthy === false) {
        return <span className="badge badge-warning">{t("app.b2.endpoint_unhealthy")}</span>;
      }
      return <span className="badge badge-success">{t("app.b2.tunnel_up")}</span>;
    case "reconnecting":
      return <span className="badge badge-warning">{t("app.b2.tunnel_reconnecting_short")}</span>;
    case "failed":
      return <span className="badge badge-danger">{t("app.b2.tunnel_failed")}</span>;
    case "stopped":
      return <span className="badge">{t("app.b2.tunnel_stopped")}</span>;
  }
}

export function EndpointCard({
  endpoint,
  outcome,
  initialError,
  activeTunnel,
  serverAddresses,
  forwardPolicy,
  forwardPolicyLoading,
  forwardPolicyError,
  onRetryForwardPolicy,
  currentAccountContext,
  hasSecretInput,
  shuttingDown,
  locale,
  t,
  pushToast,
}: EndpointCardProps) {
  const switchId = useId();
  const bindSelectId = useId();
  const cardRef = useRef<HTMLElement | null>(null);
  const copyUrlTimerRef = useRef<number | null>(null);
  const copyCurlTimerRef = useRef<number | null>(null);

  const [preferredBind, setPreferredBind] = useState<ForwardBind>(
    activeTunnel?.spec.bind ?? "loopback",
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<FormattedError | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);

  const activeTunnelBind = activeTunnel?.spec.bind ?? null;
  useEffect(() => {
    if (activeTunnelBind !== null) {
      setPreferredBind(activeTunnelBind);
    }
  }, [activeTunnelBind]);

  useEffect(() => {
    return () => {
      if (copyUrlTimerRef.current !== null) {
        window.clearTimeout(copyUrlTimerRef.current);
      }
      if (copyCurlTimerRef.current !== null) {
        window.clearTimeout(copyCurlTimerRef.current);
      }
    };
  }, []);

  const label = resolveLocalizedText(endpoint.label, locale, endpoint.id);
  const allInterfacesAllowed = Boolean(forwardPolicy?.all_interfaces_allowed);
  const effectiveBind: ForwardBind = activeTunnel
    ? activeTunnel.spec.bind
    : allInterfacesAllowed
      ? preferredBind
      : "loopback";
  const isAllInterfaces = activeTunnel?.spec.bind === "all_interfaces";
  const isAccountActive = currentAccountContext?.active === outcome.account;

  const resolved = resolveEndpointAddresses(serverAddresses, endpoint);
  const isUp = activeTunnel?.state.state === "up";
  const openUrl = isUp ? resolved.openUrl : null;
  const copyUrl = activeTunnel ? (resolved.copyUrl ?? resolved.openUrl) : null;
  const displayAddr = activeTunnel
    ? (copyUrl ?? formatEndpointBindFallback(activeTunnel, endpoint))
    : null;

  const isServerLocalNotice = resolved.notice_key === "web.forward.server_local";
  const openaiBaseUrl =
    endpoint.kind === "openai" && activeTunnel
      ? (resolved.openaiBaseUrl ??
        (isServerLocalNotice
          ? buildServerLocalEndpointUrl(activeTunnel.spec.local_port, endpoint)
          : null))
      : null;

  const rawModelId = outcome.status.outputs?.model_id;
  const modelId =
    typeof rawModelId === "string" && rawModelId.trim().length > 0
      ? rawModelId
      : FALLBACK_MODEL_ID;
  const curlCommand =
    openaiBaseUrl !== null ? buildOpenAiCurl(openaiBaseUrl, modelId, hasSecretInput) : null;

  const showRestrictionNotice = forwardPolicy !== null && !forwardPolicy.all_interfaces_allowed;
  const restrictionMessage = showRestrictionNotice
    ? forwardPolicy.restriction === "windows_or_wsl"
      ? t("web.forward.bind_windows_or_wsl")
      : t("web.forward.bind_loopback_listener")
    : null;
  const formattedPolicyError =
    forwardPolicy === null && !forwardPolicyLoading && forwardPolicyError
      ? formatErrorMessage(forwardPolicyError, t)
      : null;
  const displayedError =
    actionError ?? (!activeTunnel && initialError ? formatErrorMessage(initialError, t) : null);

  const handleCopy = async (text: string, kind: "url" | "curl") => {
    const ok = await copyTextToClipboard(text, cardRef.current);
    if (ok) {
      pushToast({ tone: "info", body: t("web.shell.copied") });
      if (kind === "url") {
        setCopiedUrl(true);
        if (copyUrlTimerRef.current !== null) {
          window.clearTimeout(copyUrlTimerRef.current);
        }
        copyUrlTimerRef.current = window.setTimeout(() => {
          copyUrlTimerRef.current = null;
          setCopiedUrl(false);
        }, COPY_FEEDBACK_MS);
      } else {
        setCopiedCurl(true);
        if (copyCurlTimerRef.current !== null) {
          window.clearTimeout(copyCurlTimerRef.current);
        }
        copyCurlTimerRef.current = window.setTimeout(() => {
          copyCurlTimerRef.current = null;
          setCopiedCurl(false);
        }, COPY_FEEDBACK_MS);
      }
    } else {
      pushToast({ tone: "warning", body: t("web.plugins.endpoint_copy_failed") });
    }
  };

  const openWithBind = async (bind: ForwardBind, localPort: number): Promise<void> => {
    if (!currentAccountContext) {
      return;
    }
    const created = await openForward({
      account_context: currentAccountContext,
      account: outcome.account,
      session: outcome.session,
      bind,
      local_port: localPort,
      remote_port: endpoint.remote_port,
      health_path: endpoint.health,
    });
    cachePluginForwardAddresses(created);
    await webStore.refreshSnapshot().catch(() => {});
    void refreshPluginForwards().catch(() => {});
  };

  const handleToggleForward = async (nextOn: boolean) => {
    if (busy || shuttingDown) {
      return;
    }
    const gen = apiClient.getSessionGeneration();
    setBusy(true);
    setActionError(null);

    try {
      if (nextOn) {
        if (!isAccountActive || !currentAccountContext) {
          setActionError({ message: t("app.b2.runtime_switch_hint"), hint: null });
          return;
        }
        const bindToUse: ForwardBind = allInterfacesAllowed ? preferredBind : "loopback";
        await openWithBind(bindToUse, endpoint.remote_port);
      } else if (activeTunnel) {
        const closed = await closeForward(activeTunnel.id);
        if (apiClient.getSessionGeneration() !== gen) {
          return;
        }
        const body = closed.notice_key
          ? t(closed.notice_key)
          : t("app.b2.forward_closed_billing");
        pushToast({
          tone: "info",
          title: t("app.b2.forward_closed"),
          body,
        });
        await webStore.refreshSnapshot().catch(() => {});
        void refreshPluginForwards().catch(() => {});
      }
    } catch (error) {
      if (apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        setActionError(formatErrorMessage(error, t));
      }
    } finally {
      if (apiClient.getSessionGeneration() === gen) {
        setBusy(false);
      }
    }
  };

  const handleBindChange = async (nextBind: ForwardBind) => {
    if (busy || shuttingDown) {
      return;
    }
    if (nextBind === "all_interfaces" && !allInterfacesAllowed) {
      return;
    }
    setPreferredBind(nextBind);
    setActionError(null);

    if (!activeTunnel || activeTunnel.spec.bind === nextBind) {
      return;
    }
    if (!isAccountActive || !currentAccountContext) {
      setActionError({ message: t("app.b2.runtime_switch_hint"), hint: null });
      return;
    }

    const gen = apiClient.getSessionGeneration();
    const localPort = activeTunnel.spec.local_port;
    setBusy(true);

    try {
      await closeForward(activeTunnel.id);
      if (apiClient.getSessionGeneration() !== gen) {
        return;
      }
      await openWithBind(nextBind, localPort);
    } catch (error) {
      if (apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        setActionError(formatErrorMessage(error, t));
      }
      void webStore.refreshSnapshot().catch(() => {});
      void refreshPluginForwards().catch(() => {});
    } finally {
      if (apiClient.getSessionGeneration() === gen) {
        setBusy(false);
      }
    }
  };

  const forwardSwitchDisabled =
    busy || shuttingDown || (!activeTunnel && !isAccountActive);
  const bindSelectDisabled =
    busy ||
    shuttingDown ||
    (!allInterfacesAllowed && effectiveBind === "loopback") ||
    (activeTunnel !== null && !isAccountActive);

  return (
    <section
      ref={cardRef}
      className="card card-compact"
      data-endpoint-card={endpoint.id}
      data-endpoint-kind={endpoint.kind}
    >
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{label}</h2>
        </div>
        <div className="card-actions">
          {isAllInterfaces && (
            <span className="badge badge-warning">{t("web.forward.bind_badge_all")}</span>
          )}
          {renderHealthBadge(activeTunnel, t)}
        </div>
      </div>

      {activeTunnel && displayAddr ? (
        <div className="endpoint-addr-row" data-endpoint-addr-row={endpoint.id}>
          <span className="endpoint-url mono" data-endpoint-url={endpoint.id}>
            {displayAddr}
          </span>
          {copyUrl && (
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon"
              data-endpoint-copy={endpoint.id}
              aria-label={t("copy.button")}
              title={t("copy.button")}
              onClick={() => {
                void handleCopy(copyUrl, "url");
              }}
            >
              <span className="btn-icon-slot">
                {copiedUrl ? <CheckIcon className="icon-success" /> : <CopyIcon />}
              </span>
            </button>
          )}
          {openUrl ? (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm"
              data-endpoint-open={endpoint.id}
            >
              <ExternalLinkIcon />
              <span>{t("app.b2.action_open_browser")}</span>
            </a>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              data-endpoint-open={endpoint.id}
              disabled
            >
              <ExternalLinkIcon />
              <span>{t("app.b2.action_open_browser")}</span>
            </button>
          )}
        </div>
      ) : (
        <p className="caption" data-endpoint-not-forwarded="true">
          {t("web.plugins.endpoint_not_forwarded_note")}
        </p>
      )}

      {resolved.notice_key && (
        <div className="inline-msg inline-msg-info" data-endpoint-notice={resolved.notice_key}>
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">{t(resolved.notice_key)}</span>
        </div>
      )}

      {(resolved.warning_key || isAllInterfaces) && (
        <div className="inline-msg inline-msg-warning" data-endpoint-warning="downstream_auth">
          <AlertTriangleIcon className="icon-xs icon-warning" />
          <span className="inline-msg-text">
            {resolved.warning_key
              ? t(resolved.warning_key)
              : t("web.forward.downstream_auth")}
          </span>
        </div>
      )}

      <div className="endpoint-controls-row">
        <label className="switch-label" htmlFor={switchId}>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            className="switch-input"
            data-endpoint-forward-toggle={endpoint.id}
            checked={Boolean(activeTunnel)}
            disabled={forwardSwitchDisabled}
            onChange={(event) => {
              void handleToggleForward(event.target.checked);
            }}
          />
          <span>{t("app.b2.endpoint_forward")}</span>
        </label>
        <span className="caption">{t("app.b2.forward_billing_note")}</span>
      </div>

      <div className="endpoint-bind-row">
        <label className="field-label" htmlFor={bindSelectId}>
          {t("web.forward.bind_label")}
        </label>
        <select
          id={bindSelectId}
          className="select select-sm select-compact"
          data-endpoint-bind={endpoint.id}
          value={effectiveBind}
          disabled={bindSelectDisabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "loopback" || value === "all_interfaces") {
              void handleBindChange(value);
            }
          }}
        >
          <option value="loopback">{t("web.forward.bind_loopback")}</option>
          <option value="all_interfaces" disabled={!allInterfacesAllowed}>
            {t("web.forward.bind_all")}
          </option>
        </select>
        {busy && <span className="spinner" aria-hidden="true" />}
      </div>

      {restrictionMessage && (
        <div
          className="inline-msg inline-msg-info"
          data-endpoint-bind-restriction={forwardPolicy?.restriction ?? "loopback"}
        >
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">{restrictionMessage}</span>
        </div>
      )}

      {formattedPolicyError && (
        <div className="alert alert-warning" role="alert">
          <span className="alert-icon icon-warning">
            <AlertTriangleIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{formattedPolicyError.message}</p>
            {formattedPolicyError.hint && <p className="alert-body">{formattedPolicyError.hint}</p>}
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={onRetryForwardPolicy}
              >
                {t("app.action.retry")}
              </button>
            </div>
          </div>
        </div>
      )}

      {!isAccountActive && (
        <div className="inline-msg inline-msg-info">
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">{t("app.b2.runtime_switch_hint")}</span>
        </div>
      )}

      {displayedError && (
        <div className="alert alert-danger" role="alert" data-endpoint-error={endpoint.id}>
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{displayedError.message}</p>
            {displayedError.hint && <p className="alert-body">{displayedError.hint}</p>}
          </div>
        </div>
      )}

      {curlCommand && (
        <div className="endpoint-curl-block" data-endpoint-curl={endpoint.id}>
          <div className="endpoint-curl-header">
            <span className="caption">{t("app.b2.endpoint_curl")}</span>
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon"
              data-endpoint-curl-copy={endpoint.id}
              aria-label={t("copy.button")}
              title={t("copy.button")}
              onClick={() => {
                void handleCopy(curlCommand, "curl");
              }}
            >
              <span className="btn-icon-slot">
                {copiedCurl ? <CheckIcon className="icon-success" /> : <CopyIcon />}
              </span>
            </button>
          </div>
          <div className="well">
            <pre className="endpoint-curl-code">
              <code>{curlCommand}</code>
            </pre>
          </div>
          {isServerLocalNotice && (
            <p className="caption">{t("web.plugins.endpoint_local_curl")}</p>
          )}
          {hasSecretInput && <p className="caption">{t("app.b2.endpoint_curl_key")}</p>}
        </div>
      )}
    </section>
  );
}
