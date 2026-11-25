/**
 * Ordered four-step environment readiness checklist: host tools (WSL or shell),
 * streaming Colab CLI installer with cancel, OS keyring & helper interpreter
 * diagnostics, and Google account sign-in or in-place adoption.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon, CheckCircleIcon } from "../../components/Icons.tsx";
import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { RouteId } from "../../lib/router.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { PendingOperation } from "../../lib/types.ts";
import {
  formatApiError,
  formatErrorKind,
  type FormattedApiError,
} from "../accounts/model.ts";
import {
  cancelCliInstall,
  formatInstallErrorPayload,
  formatInstallMethod,
  INSTALL_LOG_MAX_LINES,
  resolveInstallMethods,
  startCliInstallStream,
  WSL_INSTALL_URL,
  type ChecklistModel,
  type ChecklistStepStatus,
  type InstallLine,
  type InstallMethod,
  type OverviewResponse,
} from "./api.ts";
import {
  CircleIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LogInIcon,
  RefreshIcon,
} from "./Icons.tsx";

type InstallPhase = "idle" | "running" | "done" | "cancelled" | "failed";

const LOG_BOTTOM_THRESHOLD_PX = 24;

export interface ChecklistCardProps {
  readonly overview: OverviewResponse | null;
  readonly checklist: ChecklistModel;
  readonly probeError: FormattedApiError | null;
  readonly probing: boolean;
  readonly runningInstallOp: PendingOperation | null;
  readonly adopting: boolean;
  readonly adoptError: FormattedApiError | null;
  readonly accountChangeBlocked: boolean;
  readonly shuttingDown: boolean;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId) => void;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onCheckAgain: () => Promise<void>;
  readonly onAdoptAccount: () => Promise<void>;
  readonly onInstallSucceeded: () => Promise<void>;
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
  onInstallSucceeded,
}: ChecklistCardProps) {
  const methodSelectId = useId();
  const offeredMethods = resolveInstallMethods(overview);

  const [preferredMethod, setPreferredMethod] = useState<InstallMethod | null>(null);
  const [installPhase, setInstallPhase] = useState<InstallPhase>("idle");
  const [installId, setInstallId] = useState<number | null>(null);
  const [installLines, setInstallLines] = useState<readonly InstallLine[]>([]);
  const [installError, setInstallError] = useState<FormattedApiError | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);

  const mountedRef = useRef(true);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamActiveRef = useRef(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const prevServerOpIdRef = useRef<number | null>(runningInstallOp?.id ?? null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamAbortRef.current?.abort();
      streamAbortRef.current = null;
      streamActiveRef.current = false;
    };
  }, []);

  // Re-probe automatically when a server-side install started elsewhere finishes.
  useEffect(() => {
    const prevId = prevServerOpIdRef.current;
    const nextId = runningInstallOp?.id ?? null;
    prevServerOpIdRef.current = nextId;

    if (prevId !== null && nextId === null && !streamActiveRef.current) {
      setCancelRequested(false);
      setInstallId(null);
      if (installPhase === "running") {
        setInstallPhase("idle");
      }
      void onCheckAgain();
    }
  }, [installPhase, onCheckAgain, runningInstallOp]);

  useEffect(() => {
    const el = logRef.current;
    if (el !== null && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [installLines.length]);

  const handleLogScroll = useCallback(() => {
    const el = logRef.current;
    if (el === null) {
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= LOG_BOTTOM_THRESHOLD_PX;
  }, []);

  const selectedMethod: InstallMethod =
    preferredMethod !== null && offeredMethods.includes(preferredMethod)
      ? preferredMethod
      : offeredMethods[0];

  const activeInstallId = installId ?? runningInstallOp?.id ?? null;
  const installing = installPhase === "running" || runningInstallOp !== null;
  const cancelling = cancelRequested || runningInstallOp?.cancelling === true;

  const handleStartInstall = useCallback(async () => {
    if (installing || shuttingDown) {
      return;
    }
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamActiveRef.current = true;
    stickToBottomRef.current = true;

    setInstallPhase("running");
    setInstallId(null);
    setInstallLines([]);
    setInstallError(null);
    setCancelRequested(false);

    let receivedFinished = false;
    try {
      await startCliInstallStream(selectedMethod, {
        signal: controller.signal,
        onStarted: (id) => {
          if (!mountedRef.current) {
            return;
          }
          setInstallId(id);
        },
        onLine: (line) => {
          if (!mountedRef.current) {
            return;
          }
          setInstallLines((prev) => {
            if (prev.length >= INSTALL_LOG_MAX_LINES) {
              return [...prev.slice(prev.length - INSTALL_LOG_MAX_LINES + 1), line];
            }
            return [...prev, line];
          });
        },
        onFinished: (event) => {
          receivedFinished = true;
          if (!mountedRef.current) {
            return;
          }
          setCancelRequested(false);
          setInstallId(null);
          if (event.status === "succeeded") {
            setInstallPhase("done");
            setInstallError(null);
            void onInstallSucceeded();
          } else if (event.status === "cancelled") {
            setInstallPhase("cancelled");
            setInstallError(null);
          } else {
            setInstallPhase("failed");
            setInstallError(formatInstallErrorPayload(event.error, t));
          }
        },
      });

      if (!mountedRef.current) {
        return;
      }
      if (!receivedFinished) {
        setInstallPhase("failed");
        setInstallError({ message: t("app.err.connection_lost"), hint: null });
        void onCheckAgain();
      }
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      if (error instanceof ApiError && error.isAbort) {
        return;
      }
      if (error instanceof ApiError && error.status === 409 && error.operationId !== null) {
        setInstallId(error.operationId);
        setInstallPhase("running");
        return;
      }
      if (!receivedFinished) {
        setInstallPhase("failed");
        setInstallError(formatApiError(error, t));
      }
    } finally {
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
      streamActiveRef.current = false;
      if (mountedRef.current) {
        setCancelRequested(false);
      }
    }
  }, [installing, onCheckAgain, onInstallSucceeded, selectedMethod, shuttingDown, t]);

  const handleCancelInstall = useCallback(async () => {
    if (activeInstallId === null || cancelling) {
      return;
    }
    setCancelRequested(true);
    try {
      await cancelCliInstall(activeInstallId);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      if (error instanceof ApiError && error.status === 404) {
        setInstallId(null);
        setCancelRequested(false);
        void onCheckAgain();
        return;
      }
      setCancelRequested(false);
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        pushToast({ tone: "danger", body: formatApiError(error, t).message });
      }
    }
  }, [activeInstallId, cancelling, onCheckAgain, pushToast, t]);

  const hostIsWsl = overview?.host.kind === "wsl";
  const hostTitle = t(hostIsWsl ? "app.step.wsl.title" : "app.step.shell.title");

  let hostDescription: string | null = null;
  if (checklist.hostStatus === "checking") {
    hostDescription = t("app.step.checking");
  } else if (checklist.hostStatus === "done" && overview !== null) {
    if (hostIsWsl) {
      const distro = overview.environment.wsl_distros[0] ?? "";
      hostDescription = t("app.step.wsl.done", { distro });
    } else if (overview.host.hint_key !== null) {
      hostDescription = t(overview.host.hint_key);
    } else {
      hostDescription = t("app.step.shell.done");
    }
  } else if (checklist.hostStatus === "todo") {
    hostDescription = t(hostIsWsl ? "app.step.wsl.todo" : "app.step.shell.todo");
  }

  let cliDescription: string | null = null;
  if (checklist.cliStatus === "waiting") {
    cliDescription = t("app.step.waiting");
  } else if (checklist.cliStatus === "done" && overview !== null) {
    cliDescription = overview.environment.colab_version
      ? t("app.step.cli.done", { version: overview.environment.colab_version })
      : t("app.step.cli.done_unknown");
  } else if (checklist.cliStatus === "todo" && !installing) {
    if (installPhase === "done") {
      cliDescription = t("app.install.done");
    } else if (installPhase === "cancelled") {
      cliDescription = t("app.install.cancelled");
    } else {
      cliDescription = t("app.step.cli.todo");
    }
  }

  const helperDescription =
    overview !== null && checklist.cliStatus === "done"
      ? t(overview.helper_available ? "web.overview.helper_ready" : "web.overview.helper_missing")
      : null;

  const keyringUnavailable =
    overview !== null &&
    (overview.keyring.status === "unavailable" ||
      overview.accounts_error === "keyring_unavailable");
  const keyringAlertBody =
    overview !== null && overview.keyring.hint_key !== null
      ? t(overview.keyring.hint_key) || t("app.accounts.keyring.body")
      : t("app.accounts.keyring.body");

  let keyringDescription: string | null = null;
  if (checklist.keyringStatus === "waiting") {
    keyringDescription = t("web.overview.keyring_unknown");
  } else if (checklist.keyringStatus === "checking") {
    keyringDescription = t("app.step.checking");
  } else if (checklist.keyringStatus === "done") {
    keyringDescription = t("web.overview.keyring_ready");
  } else if (checklist.keyringStatus === "todo") {
    keyringDescription = t("web.overview.keyring_unknown");
  }

  const unadopted = overview?.accounts?.unadopted === true;
  const activeEmail =
    overview?.accounts?.active_email ??
    overview?.accounts?.accounts.find((a) => a.id === overview.accounts?.active)?.email ??
    null;

  let signinDescription: string | null = null;
  if (checklist.signinStatus === "waiting") {
    signinDescription = t("app.step.waiting");
  } else if (checklist.signinStatus === "done") {
    signinDescription = t("app.step.signin.done", {
      email: activeEmail ?? t("app.accounts.no_email"),
    });
  } else if (checklist.signinStatus === "todo") {
    signinDescription = t(unadopted ? "app.step.signin.unadopted" : "app.step.signin.todo");
  }

  return (
    <section className="card" data-overview-checklist="true">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.checklist.title")}</h2>
          <p className="card-desc">{t("app.checklist.description")}</p>
        </div>
        <div className="card-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-overview-check-again="true"
            disabled={probing || installing || shuttingDown}
            onClick={() => {
              void onCheckAgain();
            }}
          >
            {probing ? <span className="spinner" aria-hidden="true" /> : <RefreshIcon />}
            <span>{t("app.action.check_again")}</span>
          </button>
        </div>
      </div>

      {overview !== null && probeError !== null && (
        <div className="alert alert-danger" role="alert">
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{probeError.message}</p>
            {probeError.hint !== null && <p className="alert-body">{probeError.hint}</p>}
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
          data-overview-step-status={checklist.cliStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={installing ? "checking" : checklist.cliStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{t("app.step.cli.title")}</p>
            {cliDescription !== null && <p className="checklist-desc">{cliDescription}</p>}

            {checklist.cliStatus === "todo" && (
              <>
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
                  <>
                    {installPhase === "failed" && installError !== null && (
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
                              disabled={shuttingDown}
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
                            disabled={shuttingDown}
                            onChange={(event) => {
                              const next = event.target.value as InstallMethod;
                              if (offeredMethods.includes(next)) {
                                setPreferredMethod(next);
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
                        disabled={shuttingDown}
                        onClick={() => {
                          void handleStartInstall();
                        }}
                      >
                        <DownloadIcon />
                        <span>{t("app.install.start")}</span>
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {installLines.length > 0 && (
              <div
                ref={logRef}
                className="install-log"
                role="log"
                aria-live="off"
                data-install-log="true"
                onScroll={handleLogScroll}
              >
                {installLines.map((line, index) => (
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
          data-overview-step="keyring"
          data-overview-step-status={checklist.keyringStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={checklist.keyringStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{t("web.overview.keyring_title")}</p>
            {keyringDescription !== null && <p className="checklist-desc">{keyringDescription}</p>}
            {helperDescription !== null && <p className="checklist-desc">{helperDescription}</p>}

            {checklist.keyringStatus === "failed" && (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">
                    {keyringUnavailable
                      ? t("app.accounts.keyring.title")
                      : t("web.overview.helper_missing")}
                  </p>
                  {keyringUnavailable && <p className="alert-body">{keyringAlertBody}</p>}
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
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

            {checklist.keyringStatus === "todo" && (
              <div className="checklist-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
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
          data-overview-step="signin"
          data-overview-step-status={checklist.signinStatus}
        >
          <span className="checklist-icon">
            <StepMarker status={checklist.signinStatus} />
          </span>
          <div className="checklist-body">
            <p className="checklist-title">{t("app.step.signin.title")}</p>
            {signinDescription !== null && <p className="checklist-desc">{signinDescription}</p>}

            {checklist.signinStatus === "failed" &&
              overview !== null &&
              overview.accounts_error !== null && (
                <div className="alert alert-danger" role="alert">
                  <span className="alert-icon icon-danger">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">{formatErrorKind(overview.accounts_error, t)}</p>
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
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
                      onClick={() => navigate("accounts")}
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
