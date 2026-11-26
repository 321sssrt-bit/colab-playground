/**
 * About information card: accurate current version, licence, project page,
 * GitHub feedback link, manual/automatic update checks synchronized with
 * `updatesStore`, Demo/Real backend badge, and full `settings.json` path with
 * copy button.
 */

import { memo, useCallback, useId } from "react";

import { AlertIcon } from "../../components/Icons.tsx";
import type { Dictionary, TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { BackendKind, UpdateNoticeResponse } from "../../lib/types.ts";
import { isSafeHttpsUrl } from "../../lib/updates.ts";
import { formatApiErrorPayload } from "./api.ts";

const DEFAULT_PROJECT_URL = "https://github.com/321sssrt-bit/colab-playground";
const LICENSE_TEXT = "MIT · Copyright (c) 2026 ScarletKc";
// Injected from root `Cargo.toml` at Vite build/dev time; superseded by `/api/updates` at runtime.
const BUILD_APP_VERSION: string | null =
  typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0 ? __APP_VERSION__ : null;

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

function deriveProjectUrl(releasesUrl: string | null | undefined): string {
  if (!isSafeHttpsUrl(releasesUrl)) {
    return DEFAULT_PROJECT_URL;
  }
  const stripped = releasesUrl.replace(/\/releases\/?$/i, "");
  return isSafeHttpsUrl(stripped) ? stripped : DEFAULT_PROJECT_URL;
}

function buildFeedbackUrl(projectUrl: string, version: string | null): string {
  const platform =
    typeof navigator !== "undefined" && navigator.platform ? navigator.platform : "Web";
  const versionLine = version ? `Colab Playground ${version} (Web)` : "Colab Playground (Web)";
  const body = `\n\n---\n${versionLine}\nPlatform: ${platform}\n`;
  return `${projectUrl}/issues/new?body=${encodeURIComponent(body)}`;
}

export interface AboutSectionProps {
  readonly backendKind: BackendKind | null;
  readonly settingsFile: string | null;
  readonly configDir: string | null;
  readonly checkUpdates: boolean;
  readonly savingCheckUpdates: boolean;
  readonly checkUpdatesError: string | null;
  readonly updateNotice: UpdateNoticeResponse | null;
  readonly checkingUpdates: boolean;
  readonly updateError: string | null;
  readonly dict: Dictionary | null;
  readonly t: TranslateFn;
  readonly onCheckUpdates: () => void;
  readonly onToggleCheckUpdates: (enabled: boolean) => void;
  readonly pushToast: (toast: ToastInput) => number;
}

export const AboutSection = memo(function AboutSection({
  backendKind,
  settingsFile,
  configDir,
  checkUpdates,
  savingCheckUpdates,
  checkUpdatesError,
  updateNotice,
  checkingUpdates,
  updateError,
  t,
  onCheckUpdates,
  onToggleCheckUpdates,
  pushToast,
}: AboutSectionProps) {
  const autoCheckId = useId();
  const displaySettingsPath = settingsFile ?? configDir;

  const projectUrl = deriveProjectUrl(updateNotice?.releases_url);
  const projectLabel = projectUrl.replace(/^https:\/\//i, "");
  const currentVersion = updateNotice?.current_version ?? BUILD_APP_VERSION;
  const feedbackUrl = buildFeedbackUrl(projectUrl, currentVersion);

  const safeReleaseUrl =
    updateNotice?.update_available && isSafeHttpsUrl(updateNotice.release_url)
      ? updateNotice.release_url
      : isSafeHttpsUrl(updateNotice?.releases_url)
        ? updateNotice.releases_url
        : `${projectUrl}/releases`;

  const handleCopySettingsPath = useCallback(async () => {
    if (displaySettingsPath === null) {
      return;
    }
    const copied = await copyTextToClipboard(displaySettingsPath);
    if (copied) {
      pushToast({ tone: "success", body: t("web.shell.copied") });
    } else {
      pushToast({ tone: "warning", body: t("web.shell.copy_failed") });
    }
  }, [displaySettingsPath, pushToast, t]);

  const backendFailed = updateNotice?.status === "failed";
  const failed = updateError !== null || backendFailed;
  const failedWhy =
    updateError !== null
      ? updateError
      : backendFailed
        ? formatApiErrorPayload(updateNotice.error, t)
        : null;

  const updateStatusText = checkingUpdates
    ? t("app.b7.update_checking")
    : updateNotice?.status === "available" && updateNotice.latest_version
      ? t("app.b7.update_available", { version: updateNotice.latest_version })
      : failed && failedWhy !== null
        ? t("app.b7.update_failed", { why: failedWhy })
        : updateNotice?.status === "up_to_date"
          ? t("app.b7.update_up_to_date")
          : t("app.b7.update_not_checked");

  return (
    <section className="card settings-section" data-settings-about="true">
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
            <span className="mono" data-about-version="true">
              {currentVersion ?? "—"}
            </span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.b8.settings_license_title")}</span>
          </div>
          <div className="settings-row-control">
            <span data-about-license="true">{LICENSE_TEXT}</span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.b8.settings_project_title")}</span>
          </div>
          <div className="settings-row-control">
            <a
              className="btn btn-sm btn-ghost"
              href={projectUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-about-project="true"
            >
              <ExternalLinkIcon />
              <span>{projectLabel}</span>
            </a>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.b12.settings_feedback_title")}</span>
            <p className="settings-row-desc">{t("app.b12.settings_feedback_description")}</p>
          </div>
          <div className="settings-row-control">
            <a
              className="btn btn-sm"
              href={feedbackUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-about-feedback="true"
            >
              <ExternalLinkIcon />
              <span>{t("app.b12.feedback_give")}</span>
            </a>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-title">{t("app.b7.update_title")}</span>
            <p className="settings-row-desc" data-about-update-status="true">
              {updateStatusText}
            </p>
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
              data-about-update-check="true"
              onClick={onCheckUpdates}
            >
              {checkingUpdates && <span className="spinner" aria-hidden="true" />}
              <span>{failed ? t("app.b7.update_try_again") : t("app.b7.update_check")}</span>
            </button>
            <a
              className={
                updateNotice?.update_available ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost"
              }
              href={safeReleaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-about-update-open="true"
            >
              <ExternalLinkIcon />
              <span>{t("app.b7.update_open_page")}</span>
            </a>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <label className="settings-row-title" htmlFor={autoCheckId}>
              {t("app.b7.update_auto")}
            </label>
            <p className="settings-row-desc">{t("app.b7.update_auto_hint")}</p>
          </div>
          <div className="settings-row-control">
            <input
              id={autoCheckId}
              name="check_updates"
              type="checkbox"
              role="switch"
              className="switch-input"
              checked={checkUpdates}
              disabled={savingCheckUpdates}
              data-about-update-auto="true"
              onChange={(event) => onToggleCheckUpdates(event.target.checked)}
            />
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
            <span className="settings-row-title">{t("app.settings.file.title")}</span>
          </div>
          <div className="settings-row-control">
            {displaySettingsPath !== null ? (
              <div className="settings-file-box">
                <code
                  className="settings-file-path"
                  title={displaySettingsPath}
                  data-about-settings-file="true"
                >
                  {displaySettingsPath}
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-about-copy-file="true"
                  onClick={() => {
                    void handleCopySettingsPath();
                  }}
                >
                  <CopyIcon />
                  <span>{t("copy.button")}</span>
                </button>
              </div>
            ) : (
              <span className="caption">{t("app.settings.file.unsaved")}</span>
            )}
          </div>
        </div>
      </div>

      {checkUpdatesError !== null && (
        <div
          className="alert alert-danger settings-inline-alert"
          role="alert"
          data-about-update-auto-error="true"
        >
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{t("app.toast.save_failed.title")}</p>
            <p className="alert-body">{checkUpdatesError}</p>
          </div>
        </div>
      )}
    </section>
  );
});
