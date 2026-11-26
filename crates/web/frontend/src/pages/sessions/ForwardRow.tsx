/**
 * Mounted port-forward row rendered on a RuntimeCard (and reusable by #46).
 */

import { useEffect, useRef, useState } from "react";

import { CloseIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import { closeForward, type ForwardView } from "./api.ts";
import { copyTextToClipboard, formatErrorMessage, safeHttpUrl } from "./format.ts";
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  SmallInfoIcon,
} from "./Icons.tsx";

const COPY_FEEDBACK_MS = 2000;

export interface ForwardClosedNotice {
  readonly title: string;
  readonly body: string;
}

export interface ForwardRowProps {
  readonly forward: ForwardView;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onAfterClose?: (notice?: ForwardClosedNotice) => void;
}

function renderStateBadge(forward: ForwardView, t: TranslateFn) {
  switch (forward.state.state) {
    case "starting":
      return <span className="badge badge-info">{t("app.b2.tunnel_starting")}</span>;
    case "up":
      return forward.healthy === false ? (
        <span className="badge badge-warning">{t("app.b2.tunnel_up_unhealthy")}</span>
      ) : (
        <span className="badge badge-success">{t("app.b2.tunnel_up")}</span>
      );
    case "reconnecting":
      return (
        <span className="badge badge-warning">
          {t("app.b2.tunnel_reconnecting", { n: forward.state.attempt })}
        </span>
      );
    case "failed":
      return <span className="badge badge-danger">{t("app.b2.tunnel_failed")}</span>;
    case "stopped":
      return <span className="badge">{t("app.b2.tunnel_stopped")}</span>;
  }
}

export function ForwardRow({ forward, t, pushToast, onAfterClose }: ForwardRowProps) {
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const stateKind = forward.state.state;
  const ready = stateKind === "up";
  const terminal = stateKind === "failed" || stateKind === "stopped";
  const addresses = forward.addresses ?? null;
  const openUrl = safeHttpUrl(addresses?.open_url);
  const copyUrl = addresses?.copy_url ?? addresses?.open_url ?? null;
  const isAllInterfaces = forward.spec.bind === "all_interfaces";
  const bindFallback = `${isAllInterfaces ? "0.0.0.0" : "127.0.0.1"}:${forward.spec.local_port}`;
  const displayAddr = copyUrl ?? openUrl ?? bindFallback;

  const handleCopy = async () => {
    if (!copyUrl) {
      return;
    }
    // Pass the row element so the fallback selection copy stays inside any open modal <dialog>.
    const ok = await copyTextToClipboard(copyUrl, rowRef.current);
    if (ok) {
      setCopied(true);
      pushToast({ tone: "info", body: t("web.shell.copied") });
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, COPY_FEEDBACK_MS);
    } else {
      pushToast({ tone: "warning", body: t("web.shell.copy_link_failed") });
    }
  };

  const handleClose = async () => {
    if (closing) {
      return;
    }
    const gen = apiClient.getSessionGeneration();
    const wasTerminal = terminal;
    setClosing(true);
    try {
      const closed = await closeForward(forward.id);
      if (apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (wasTerminal) {
        // Dismissing a failed/stopped forward silently drops the row without claiming a live tunnel closed.
        onAfterClose?.();
        return;
      }
      const title = t("app.b2.forward_closed");
      const body = closed.notice_key
        ? t(closed.notice_key)
        : t("app.b2.forward_closed_billing");
      pushToast({
        tone: "info",
        title,
        body,
      });
      onAfterClose?.({ title, body });
    } catch (error) {
      if (apiClient.getSessionGeneration() !== gen) {
        return;
      }
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
      }
      setClosing(false);
    }
  };

  const closeLabel = terminal ? t("app.action.dismiss") : t("app.b2.forward_close");
  const failedError =
    forward.state.state === "failed" ? formatErrorMessage(forward.state.error, t).message : null;
  const hasNotes = Boolean(addresses?.notice_key || addresses?.warning_key || failedError);

  return (
    <div
      ref={rowRef}
      className="forward-item"
      data-forward-row={String(forward.id)}
      data-forward-state={stateKind}
    >
      <div className="forward-row-main">
        {renderStateBadge(forward, t)}
        {isAllInterfaces && (
          <span className="badge badge-warning">{t("web.forward.bind_badge_all")}</span>
        )}
        <span className="forward-addr mono">
          {`${displayAddr} → ${forward.spec.remote_port}`}
        </span>
        <span className="forward-row-actions">
          {!terminal && copyUrl && (
            <button
              type="button"
              className="btn btn-sm btn-ghost btn-icon"
              data-forward-copy={String(forward.id)}
              aria-label={t("copy.button")}
              title={t("copy.button")}
              onClick={() => {
                void handleCopy();
              }}
            >
              <span className="btn-icon-slot">
                {copied ? <CheckIcon className="icon-success" /> : <CopyIcon />}
              </span>
            </button>
          )}
          {ready && openUrl && (
            <a
              href={openUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm btn-ghost btn-icon"
              data-forward-open={String(forward.id)}
              aria-label={t("app.b2.action_open_browser")}
              title={t("app.b2.action_open_browser")}
            >
              <ExternalLinkIcon />
            </a>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon"
            data-forward-close={String(forward.id)}
            aria-label={closeLabel}
            title={closeLabel}
            disabled={closing}
            onClick={() => {
              void handleClose();
            }}
          >
            <CloseIcon />
          </button>
        </span>
      </div>

      {hasNotes && (
        <div className="forward-item-notes">
          {addresses?.notice_key && (
            <div className="inline-msg inline-msg-info" data-forward-notice={addresses.notice_key}>
              <SmallInfoIcon className="icon-xs icon-info" />
              <span className="inline-msg-text">{t(addresses.notice_key)}</span>
            </div>
          )}
          {addresses?.warning_key && (
            <div
              className="inline-msg inline-msg-warning"
              data-forward-warning={addresses.warning_key}
            >
              <AlertTriangleIcon className="icon-xs icon-warning" />
              <span className="inline-msg-text">{t(addresses.warning_key)}</span>
            </div>
          )}
          {failedError && <span className="caption">{failedError}</span>}
        </div>
      )}
    </div>
  );
}
