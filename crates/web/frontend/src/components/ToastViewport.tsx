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
  readonly onDismiss: (id: number) => void;
}

const TONE_ICON_CLASS: Readonly<Record<ToastTone, string>> = {
  info: "alert-icon icon-info",
  success: "alert-icon icon-success",
  warning: "alert-icon icon-warning",
  danger: "alert-icon icon-danger",
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

export function ToastViewport({ toasts, t, onDismiss }: ToastViewportProps) {
  return (
    <div className="toast-viewport" aria-live="polite" aria-relevant="additions text">
      {toasts.map((toast) => {
        const urgent = toast.tone === "danger" || toast.tone === "warning";
        return (
          <div key={toast.id} className="toast-card" role={urgent ? "alert" : "status"}>
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
