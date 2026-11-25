/**
 * About information card: current version, read-only update check with external
 * GitHub Releases link, Demo/Real backend badge, and one-click copy of the
 * server configuration directory path.
 */

import { memo, useCallback } from "react";

import type { Dictionary, TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { BackendKind } from "../../lib/types.ts";
import { isSafeHttpUrl, type UpdateNotice } from "./api.ts";

function CopyIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back to a hidden textarea when Clipboard API is unavailable (e.g. non-HTTPS origin).
    }
  }
  if (typeof document === "undefined") {
    return false;
  }
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const proxy = document.createElement("textarea");
  proxy.className = "clipboard-proxy";
  proxy.setAttribute("readonly", "");
  proxy.value = text;
  document.body.appendChild(proxy);
  try {
    proxy.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    proxy.remove();
    previousFocus?.focus();
  }
}

export interface AboutSectionProps {
  readonly backendKind: BackendKind | null;
  readonly configDir: string | null;
  readonly updateNotice: UpdateNotice | null;
  readonly checkingUpdates: boolean;
  readonly updateError: string | null;
  readonly dict: Dictionary | null;
  readonly t: TranslateFn;
  readonly onCheckUpdates: () => void;
  readonly pushToast: (toast: ToastInput) => number;
}

export const AboutSection = memo(function AboutSection({
  backendKind,
  configDir,
  updateNotice,
  checkingUpdates,
  updateError,
  t,
  onCheckUpdates,
  pushToast,
}: AboutSectionProps) {
  const safeReleasesUrl =
    updateNotice && isSafeHttpUrl(updateNotice.releases_url) ? updateNotice.releases_url : null;

  const handleCopyConfigDir = useCallback(async () => {
    if (configDir === null) {
      return;
    }
    const copied = await copyTextToClipboard(configDir);
    if (copied) {
      pushToast({ tone: "success", body: t("web.shell.copied") });
    } else {
      pushToast({ tone: "warning", body: t("web.shell.copy_failed") });
    }
  }, [configDir, pushToast, t]);

  const updateStatusText = checkingUpdates
    ? t("app.b7.update_checking")
    : updateError !== null
      ? t("app.b7.update_failed", { why: updateError })
      : updateNotice === null
        ? t("app.b7.update_not_checked")
        : updateNotice.update_available
          ? t("web.settings.update_available_generic")
          : t("app.b7.update_up_to_date");

  return (
    <section className="card settings-section">
      <div className="card-heading">
        <h2 className="card-title">{t("app.settings.about.title")}</h2>
        <p className="card-desc">{t("app.settings.about.description")}</p>
      </div>

      <div className="settings-list">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.settings.version.title")}</span>
          </div>
          <div className="settings-row-control">
            <span className="mono">
              {updateNotice !== null
                ? updateNotice.current_version
                : updateError !== null
                  ? t("app.summary.unknown")
                  : "—"}
            </span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.b7.update_title")}</span>
            <p className="settings-row-desc">{updateStatusText}</p>
          </div>
          <div className="settings-row-control">
            {updateNotice?.update_available && (
              <span className="badge badge-info">{t("app.b7.update_badge")}</span>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={checkingUpdates}
              aria-busy={checkingUpdates || undefined}
              onClick={onCheckUpdates}
            >
              {checkingUpdates && <span className="spinner" aria-hidden="true" />}
              <span>
                {updateError !== null ? t("app.b7.update_try_again") : t("app.b7.update_check")}
              </span>
            </button>
            {safeReleasesUrl !== null && (
              <a
                className={
                  updateNotice?.update_available ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost"
                }
                href={safeReleasesUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLinkIcon />
                <span>{t("app.b7.update_open_page")}</span>
              </a>
            )}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.settings.backend.title")}</span>
            <p className="settings-row-desc">{t("app.settings.backend.description")}</p>
          </div>
          <div className="settings-row-control">
            {backendKind === "mock" ? (
              <span className="badge badge-warning">{t("app.backend.mock")}</span>
            ) : backendKind === "real" ? (
              <span className="badge badge-info">{t("app.backend.real")}</span>
            ) : (
              <span className="caption">—</span>
            )}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("web.settings.config_dir")}</span>
          </div>
          <div className="settings-row-control">
            {configDir !== null ? (
              <div className="config-path-box">
                <code className="config-path-code" title={configDir}>
                  {configDir}
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    void handleCopyConfigDir();
                  }}
                >
                  <CopyIcon />
                  <span>{t("web.settings.copy_config_dir")}</span>
                </button>
              </div>
            ) : (
              <span className="caption">{t("app.settings.file.unsaved")}</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
});
