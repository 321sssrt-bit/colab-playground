/**
 * Ordered three-step environment readiness checklist aligned with upstream
 * `crates/app/src/ui/pages/overview.rs`: host tools (WSL or shell),
 * persistent streaming/replaying Colab CLI installer with `fa25d8c` not-found
 * warning loop, and Google account sign-in (in-place modal) or adoption.
 */

import { useCallback, useEffect, useId, useRef } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import { openAddAccountDialog } from "../../lib/accountDialogs.ts";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { NavigateOptions, RouteId } from "../../lib/router.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { ErrorKind, InstallMethod, PendingOperation } from "../../lib/types.ts";
import {
  formatApiError,
  formatErrorKind,
  type FormattedApiError,
} from "../accounts/model.ts";
import {
  formatInstallErrorPayload,
  formatInstallMethod,
  resolveInstallMethods,
  WSL_INSTALL_URL,
  type ChecklistModel,
  type ChecklistStepStatus,
  type OverviewResponse,
} from "./api.ts";
import {
  CircleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LogInIcon,
  RefreshIcon,
} from "./Icons.tsx";
import { cliInstallStore, useCliInstallStore } from "./installStore.ts";

const LOG_BOTTOM_THRESHOLD_PX = 24;

export interface ChecklistCardProps {
  readonly overview: OverviewResponse | null;
  readonly checklist: ChecklistModel;
  readonly probeError: FormattedApiError | null;
  readonly probeErrorKind: ErrorKind | null;
  readonly probing: boolean;
  readonly runningInstallOp: PendingOperation | null;
  readonly adopting: boolean;
  readonly adoptError: FormattedApiError | null;
  readonly accountChangeBlocked: boolean;
  readonly shuttingDown: boolean;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onCheckAgain: () => Promise<void>;
  readonly onAdoptAccount: () => Promise<void>;
}

function StepMarker({ status }: { readonly status: ChecklistStepStatus }) {
  switch (status) {
    case "checking":
      return <span className="spinner" aria-hidden="true" />;
    case "done":
      return (
        <span className="icon-success">
          <CheckCircleIcon />
        </span>
      );
    case "failed":
      return (
        <span className="icon-danger">
          <AlertIcon />
        </span>
      );
    case "todo":
      return <CircleIcon className="icon-accent" />;
    case "waiting":
      return <CircleIcon className="icon-subtle" />;
  }
}

export function ChecklistCard({
  overview,
  checklist,
  probeError,
  probeErrorKind,
  probing,
  runningInstallOp,
  adopting,
  adoptError,
  accountChangeBlocked,
  shuttingDown,
  t,
  navigate,
  pushToast,
  onCheckAgain,
  onAdoptAccount,
}: ChecklistCardProps) {
  const methodSelectId = useId();
  const offeredMethods = resolveInstallMethods(overview);
  const installState = useCliInstallStore();

  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [installState.lines]);

  const handleLogScroll = useCallback(() => {
    const el = logRef.current;
    if (el === null) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= LOG_BOTTOM_THRESHOLD_PX;
  }, []);

  const selectedMethod: InstallMethod =
    installState.preferredMethod !== null && offeredMethods.includes(installState.preferredMethod)
      ? installState.preferredMethod
      : offeredMethods[0];

  const activeInstallId = installState.id ?? runningInstallOp?.id ?? null;
  const installing =
    installState.phase === "running" ||
    (runningInstallOp !== null && installState.phase === "idle");
  const checkingAfterInstall =
    installState.phase === "checking" ||
    ((installState.phase === "not_found" || installState.phase === "probe_failed") && probing);
  const cancelling = installState.cancelling || runningInstallOp?.cancelling === true;

  const handleStartInstall = useCallback(async () => {
    if (installing || checkingAfterInstall || shuttingDown) {
      return;
    }
    stickToBottomRef.current = true;
    await cliInstallStore.startInstall(selectedMethod);
  }, [checkingAfterInstall, installing, selectedMethod, shuttingDown]);

  const handleCancelInstall = useCallback(async () => {
    try {
      await cliInstallStore.cancelInstall();
    } catch (error) {
      if (!(error instanceof ApiError && (error.isUnauthorized || error.isAbort))) {
        pushToast({ tone: "danger", body: formatApiError(error, t).message });
      }
    }
  }, [pushToast, t]);

  const hostIsWsl = overview?.host.kind === "wsl";
  const hostTitle = t(hostIsWsl ? "app.step.wsl.title" : "app.step.shell.title");

  let hostDescription: string | null = null;
  if (checklist.hostStatus === "checking") {
    hostDescription = t("app.step.checking");
  } else if (checklist.hostStatus === "done" && overview !== null) {
    if (hostIsWsl) {
      const distro = overview.host.wsl_distro ?? overview.environment.wsl_distros[0] ?? "";
      hostDescription = t("app.step.wsl.done", { distro });
    } else if (overview.host.hint_key !== null) {
      hostDescription = t(overview.host.hint_key);
    } else {
      hostDescription = t("app.step.shell.done");
    }
  } else if (checklist.hostStatus === "todo") {
    hostDescription = t(hostIsWsl ? "app.step.wsl.todo" : "app.step.shell.todo");
  }

  const cliStepStatus: ChecklistStepStatus =
    installing || checkingAfterInstall ? "checking" : checklist.cliStatus;
  const showCliInstallSection = checklist.cliStatus === "todo" || installing || checkingAfterInstall;

  let cliDescription: string | null = null;
  if (checkingAfterInstall) {
    cliDescription = t("app.step.checking");
  } else if (!installing) {
    if (checklist.cliStatus === "waiting") {
      cliDescription = t("app.step.waiting");
    } else if (checklist.cliStatus === "done" && overview !== null) {
      cliDescription = overview.environment.colab_version
        ? t("app.step.cli.done", { version: overview.environment.colab_version })
        : t("app.step.cli.done_unknown");
    } else if (checklist.cliStatus === "todo") {
      if (installState.phase === "not_found") {
        cliDescription = null;
      } else if (installState.phase === "cancelled") {
        cliDescription = t("app.install.cancelled");
      } else {
        cliDescription = t("app.step.cli.todo");
      }
    }
  }

  const installError: FormattedApiError | null =
    installState.phase === "failed" || installState.phase === "probe_failed"
      ? installState.streamError !== null
        ? formatApiError(installState.streamError, t)
        : formatInstallErrorPayload(installState.error, t)
      : null;

  // Wrap server-provided keys in `*_key` fields so the static i18n checker recognizes them.
  const notFoundKeys = {
    title_key: installState.warningTitleKey,
    body_key: installState.warningBodyKey,
  };
  const notFoundTitle =
    (notFoundKeys.title_key ? t(notFoundKeys.title_key) : "") || t("app.install.not_found.title");
  const notFoundBody =
    (notFoundKeys.body_key ? t(notFoundKeys.body_key) : "") || t("app.install.not_found.body");

  const unadopted = overview?.accounts?.unadopted === true;
  const activeEmail =
    overview?.accounts?.active_email ??
    overview?.accounts?.accounts.find((a) => a.id === overview.accounts?.active)?.email ??
    null;

  let signinDescription: string | null = null;
  if (checklist.signinStatus === "checking") {
    signinDescription = t("app.step.checking");
  } else if (checklist.signinStatus === "waiting") {
    signinDescription = t("app.step.waiting");
  } else if (checklist.signinStatus === "done") {
    signinDescription = t("app.step.signin.done", {
      email: activeEmail ?? t("app.accounts.no_email"),
    });
  } else if (checklist.signinStatus === "todo") {
    signinDescription = t(unadopted ? "app.step.signin.unadopted" : "app.step.signin.todo");
  }

  const signinKeyringUnavailable =
    overview !== null &&
    (overview.accounts_error === "keyring_unavailable" ||
      (overview.accounts_error === null && overview.keyring.status === "unavailable"));
  const signinErrorTitle =
    checklist.signinStatus === "failed" && overview !== null
      ? signinKeyringUnavailable
        ? t("app.err.keyring_unavailable")
        : overview.accounts_error !== null
          ? formatErrorKind(overview.accounts_error, t)
          : t("app.err.other")
      : null;
  const signinErrorBody =
    checklist.signinStatus === "failed" && overview !== null && signinKeyringUnavailable
      ? (overview.keyring.hint_key !== null ? t(overview.keyring.hint_key) : "") ||
        t("app.ns.unlock_keyring")
      : null;

  return (
    <section className="card" data-overview-checklist="true">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.checklist.title")}</h2>
          <p className="card-desc">{t("app.checklist.description")}</p>
        </div>
      </div>

      {overview !== null && probeError !== null && probeErrorKind !== "not_installed" && (
        <div className="alert alert-danger" role="alert">
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{probeError.message}</p>
            {probeError.hint !== null && <p className="alert-body">{probeError.hint}</p>}
            <div className="alert-actions">
              <button
                type="button"
                className="btn btn-sm"
                data-overview-check-again="true"
                disabled={probing || installing || shuttingDown}
                onClick={() => {
                  void onCheckAgain();
                }}
              >
                {t("app.action.check_again")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ol className="checklist" role="list">
        <li
          className="checklist-item"
          data-overview-step="host"
          data-overview-step-status={checklist.hostStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={checklist.hostStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{hostTitle}</p>
            {hostDescription !== null && <p className="checklist-desc">{hostDescription}</p>}

            {checklist.hostStatus === "failed" && probeError !== null && (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{probeError.message}</p>
                  {probeError.hint !== null && <p className="alert-body">{probeError.hint}</p>}
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-overview-check-again="true"
                      disabled={probing || shuttingDown}
                      onClick={() => {
                        void onCheckAgain();
                      }}
                    >
                      {t("app.action.check_again")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {checklist.hostStatus === "todo" && (
              <div className="checklist-actions">
                {hostIsWsl && (
                  <a
                    className="btn btn-sm"
                    href={WSL_INSTALL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLinkIcon />
                    <span>{t("app.action.install_wsl")}</span>
                  </a>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-overview-check-again="true"
                  disabled={probing || shuttingDown}
                  onClick={() => {
                    void onCheckAgain();
                  }}
                >
                  <RefreshIcon />
                  <span>{t("app.action.check_again")}</span>
                </button>
              </div>
            )}
          </div>
        </li>

        <li
          className="checklist-item"
          data-overview-step="cli"
          data-overview-step-status={cliStepStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={cliStepStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{t("app.step.cli.title")}</p>
            {cliDescription !== null && <p className="checklist-desc">{cliDescription}</p>}

            {installing ? (
              <div className="checklist-actions">
                <div className="busy-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>{t("app.install.running")}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  data-install-cancel="true"
                  disabled={activeInstallId === null || cancelling || shuttingDown}
                  onClick={() => {
                    void handleCancelInstall();
                  }}
                >
                  {cancelling && <span className="spinner" aria-hidden="true" />}
                  <span>{t(cancelling ? "app.install.cancelling" : "app.action.cancel")}</span>
                </button>
              </div>
            ) : (
              checklist.cliStatus === "todo" && (
                <>
                  {installState.phase === "not_found" && !checkingAfterInstall && (
                    <div className="alert alert-warning" role="alert" data-install-not-found="true">
                      <span className="alert-icon icon-warning">
                        <AlertIcon />
                      </span>
                      <div className="alert-text">
                        <p className="alert-title">{notFoundTitle}</p>
                        <p className="alert-body">{notFoundBody}</p>
                        <div className="alert-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            data-install-open-settings="true"
                            onClick={() => navigate("settings", { settingsFocus: "host" })}
                          >
                            {t("app.b3.new_open_settings")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            data-install-check-again="true"
                            disabled={probing || shuttingDown}
                            onClick={() => {
                              void onCheckAgain();
                            }}
                          >
                            <RefreshIcon />
                            <span>{t("app.action.check_again")}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {installState.phase === "probe_failed" &&
                    !checkingAfterInstall &&
                    installError !== null && (
                      <div className="alert alert-danger" role="alert">
                        <span className="alert-icon icon-danger">
                          <AlertIcon />
                        </span>
                        <div className="alert-text">
                          <p className="alert-title">{installError.message}</p>
                          {installError.hint !== null && (
                            <p className="alert-body">{installError.hint}</p>
                          )}
                          <div className="alert-actions">
                            <button
                              type="button"
                              className="btn btn-sm"
                              data-install-check-again="true"
                              disabled={probing || shuttingDown}
                              onClick={() => {
                                void onCheckAgain();
                              }}
                            >
                              {t("app.action.check_again")}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}

                  {installState.phase === "failed" && installError !== null && (
                    <div className="alert alert-danger" role="alert">
                      <span className="alert-icon icon-danger">
                        <AlertIcon />
                      </span>
                      <div className="alert-text">
                        <p className="alert-title">{t("app.install.failed")}</p>
                        <p className="alert-body">{installError.message}</p>
                        {installError.hint !== null && (
                          <p className="alert-body">{installError.hint}</p>
                        )}
                        <div className="alert-actions">
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={checkingAfterInstall || shuttingDown}
                            onClick={() => {
                              void handleStartInstall();
                            }}
                          >
                            {t("app.action.retry")}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="checklist-actions">
                    {offeredMethods.length > 1 ? (
                      <>
                        <label htmlFor={methodSelectId} className="caption">
                          {t("app.install.method_label")}
                        </label>
                        <select
                          id={methodSelectId}
                          className="select select-sm select-inline"
                          data-install-method="true"
                          value={selectedMethod}
                          disabled={checkingAfterInstall || shuttingDown}
                          onChange={(event) => {
                            const next = event.target.value as InstallMethod;
                            if (offeredMethods.includes(next)) {
                              cliInstallStore.setPreferredMethod(next);
                            }
                          }}
                        >
                          {offeredMethods.map((method) => (
                            <option key={method} value={method}>
                              {formatInstallMethod(method, t)}
                            </option>
                          ))}
                        </select>
                      </>
                    ) : (
                      <span className="caption">{formatInstallMethod(selectedMethod, t)}</span>
                    )}

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-install-start="true"
                      disabled={checkingAfterInstall || shuttingDown}
                      onClick={() => {
                        void handleStartInstall();
                      }}
                    >
                      <DownloadIcon />
                      <span>{t("app.install.start")}</span>
                    </button>
                  </div>
                </>
              )
            )}

            {showCliInstallSection && installState.lines.length > 0 && (
              <div
                ref={logRef}
                className="install-log"
                role="log"
                aria-live="off"
                data-install-log="true"
                onScroll={handleLogScroll}
              >
                {installState.lines.map((line, index) => (
                  <div
                    key={index}
                    className={line.stream === "stderr" ? "log-stderr" : undefined}
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </li>

        <li
          className="checklist-item"
          data-overview-step="signin"
          data-overview-step-status={checklist.signinStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={checklist.signinStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{t("app.step.signin.title")}</p>
            {signinDescription !== null && <p className="checklist-desc">{signinDescription}</p>}

            {checklist.signinStatus === "failed" && signinErrorTitle !== null && (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{signinErrorTitle}</p>
                  {signinErrorBody !== null && <p className="alert-body">{signinErrorBody}</p>}
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      data-overview-check-again="true"
                      disabled={probing || shuttingDown}
                      onClick={() => {
                        void onCheckAgain();
                      }}
                    >
                      {t("app.action.check_again")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {checklist.signinStatus === "todo" && (
              <>
                {adoptError !== null && (
                  <div className="inline-msg inline-msg-danger" role="alert">
                    <AlertIcon />
                    <span className="inline-msg-text">{adoptError.message}</span>
                  </div>
                )}
                <div className="checklist-actions">
                  {unadopted ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-overview-adopt="true"
                      disabled={adopting || accountChangeBlocked || shuttingDown}
                      title={
                        accountChangeBlocked ? t("app.b2.account_change_blocked") : undefined
                      }
                      onClick={() => {
                        void onAdoptAccount();
                      }}
                    >
                      {adopting && <span className="spinner" aria-hidden="true" />}
                      <span>{t("app.accounts.adopt")}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      data-overview-sign-in="true"
                      disabled={shuttingDown}
                      onClick={() => openAddAccountDialog()}
                    >
                      <LogInIcon />
                      <span>{t("app.action.sign_in")}</span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </li>
      </ol>
    </section>
  );
}
