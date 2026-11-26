/**
 * Global one-time banner for corrupt settings.json or reset defaults notices.
 *
 * Rendered at App scope so users see the warning on whichever route they land on
 * first, and dismissing acknowledges `POST /api/settings/notice/dismiss`.
 */

import { AlertIcon, CloseIcon } from "../../components/Icons.tsx";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { NoticePart, SettingsNoticeState } from "./noticeStore.ts";

const RESET_FIELD_LABEL_KEYS = {
  max_runtime: "app.def.max_runtime",
  max_spend_cu: "app.def.max_spend",
  min_balance_cu: "app.def.min_balance",
  idle_timeout: "app.def.idle",
  max_concurrent_sessions: "app.def.concurrent",
  max_attempts: "app.def.attempts",
  retry_delay: "app.def.retry_delay",
  on_exhausted: "app.def.on_exhausted",
  usage_poll_active: "app.def.poll_active",
  usage_poll_idle: "app.def.poll_idle",
  accelerator: "app.def.accelerator",
  high_mem: "app.def.high_mem",
  min_vram_mib: "app.def.min_vram",
  winddown_grace: "app.def.winddown",
} as const;

type KnownResetField = keyof typeof RESET_FIELD_LABEL_KEYS;

function isKnownResetField(name: string): name is KnownResetField {
  return Object.prototype.hasOwnProperty.call(RESET_FIELD_LABEL_KEYS, name);
}

export interface SettingsNoticeBannerProps {
  readonly state: SettingsNoticeState;
  readonly t: TranslateFn;
  readonly onDismiss: (part: NoticePart) => void;
}

export function SettingsNoticeBanner({ state, t, onDismiss }: SettingsNoticeBannerProps) {
  const { notice, showCorrupt, showReset } = state;
  if (!notice || (!showCorrupt && !showReset)) {
    return null;
  }

  const resetFieldNames = showReset
    ? notice.reset_defaults
        .map((field) => (isKnownResetField(field) ? t(RESET_FIELD_LABEL_KEYS[field]) : field))
        .join(t("app.fmt.list_separator"))
    : "";

  return (
    <div className="settings-global-notices" data-settings-notice-region="true">
      {showCorrupt && (
        <div
          className="alert alert-warning"
          role="status"
          data-settings-notice="corrupt"
        >
          <span className="alert-icon icon-warning">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{t("app.toast.settings_reset.title")}</p>
            <p className="alert-body">
              {notice.corrupt_backup !== null
                ? t("app.toast.settings_reset.body", { file: notice.corrupt_backup })
                : t("app.toast.settings_reset.body_lost")}
            </p>
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                data-settings-notice-dismiss="corrupt"
                onClick={() => onDismiss("corrupt")}
              >
                {t("app.action.dismiss")}
              </button>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon alert-dismiss"
            aria-label={t("app.action.dismiss")}
            onClick={() => onDismiss("corrupt")}
          >
            <CloseIcon />
          </button>
        </div>
      )}

      {showReset && (
        <div
          className="alert alert-warning"
          role="status"
          data-settings-notice="reset_defaults"
        >
          <span className="alert-icon icon-warning">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{t("app.toast.defaults_reset.title")}</p>
            <p className="alert-body">
              {t("app.toast.defaults_reset.body", { fields: resetFieldNames })}
            </p>
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                data-settings-notice-dismiss="reset"
                onClick={() => onDismiss("reset")}
              >
                {t("app.action.dismiss")}
              </button>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-icon alert-dismiss"
            aria-label={t("app.action.dismiss")}
            onClick={() => onDismiss("reset")}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
