/**
 * Global floating Toast viewport anchored at the bottom-right on desktop and
 * full-width along the bottom edge on mobile.
 */

import type { TranslateFn } from "../lib/i18n.ts";
import type { ToastItem, ToastTone } from "../lib/toast.ts";
import { AlertIcon, CheckCircleIcon, CloseIcon, InfoIcon } from "./Icons.tsx";

export interface ToastViewportProps {
  readonly toasts: readonly ToastItem[];
  readonly t: TranslateFn;
  readonly inert?: boolean;
  readonly onDismiss: (id: number) => void;
}

const TONE_ICON_CLASS: Readonly<Record<ToastTone, string>> = {
  info: "alert-icon icon-info",
  success: "alert-icon icon-success",
  warning: "alert-icon icon-warning",
  danger: "alert-icon icon-danger",
};

const TONE_CARD_CLASS: Readonly<Record<ToastTone, string>> = {
  info: "toast-card toast-card-info",
  success: "toast-card toast-card-success",
  warning: "toast-card toast-card-warning",
  danger: "toast-card toast-card-danger",
};

function renderToneIcon(tone: ToastTone) {
  if (tone === "success") {
    return <CheckCircleIcon />;
  }
  if (tone === "warning" || tone === "danger") {
    return <AlertIcon />;
  }
  return <InfoIcon />;
}

export function ToastViewport({ toasts, t, inert = false, onDismiss }: ToastViewportProps) {
  return (
    <div
      className="toast-viewport"
      aria-live="polite"
      aria-relevant="additions text"
      aria-hidden={inert ? "true" : undefined}
      inert={inert || undefined}
    >
      {toasts.map((toast) => {
        const urgent = toast.tone === "danger" || toast.tone === "warning";
        const persistent = toast.durationMs === null;
        const cardClass = persistent
          ? `${TONE_CARD_CLASS[toast.tone]} toast-card-persistent`
          : TONE_CARD_CLASS[toast.tone];
        return (
          <div
            key={toast.id}
            className={cardClass}
            role={urgent ? "alert" : "status"}
            data-toast-tone={toast.tone}
            data-toast-persistent={persistent ? "true" : undefined}
          >
            <span className={TONE_ICON_CLASS[toast.tone]}>{renderToneIcon(toast.tone)}</span>
            <div className="toast-body">
              {toast.title && <p className="alert-title">{toast.title}</p>}
              <p className="alert-body">{toast.body}</p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon alert-dismiss"
              aria-label={t("app.action.dismiss")}
              onClick={() => onDismiss(toast.id)}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
