/**
 * One Managed or Unmanaged runtime card with 15-second focus-preserving uptime
 * and auto-stop countdown leaves, Guard warnings, Watchdog status feedback,
 * mounted Forwards, and account-aware actions.
 */

import { AlertIcon } from "../../components/Icons.tsx";
import { formatCu, formatCuRate, formatDuration } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { GuardDecision, Locale, Runtime } from "../../lib/types.ts";
import type { ForwardView } from "./api.ts";
import { LiveAutoStopCountdown, LiveRuntimeUptime } from "./clock.tsx";
import {
  formatApprox,
  formatConcerns,
  formatErrorMessage,
  formatHardware,
  formatRuntimeCardLabel,
  isWatchdogArmed,
} from "./format.ts";
import { ForwardRow } from "./ForwardRow.tsx";
import { AlertTriangleIcon, LinkIcon, ShieldIcon, SmallInfoIcon, SquareIcon } from "./Icons.tsx";

export interface RuntimeCardProps {
  readonly runtime: Runtime;
  readonly guardDecision: GuardDecision | null;
  readonly forwards: readonly ForwardView[];
  readonly rearmDurationSecs: number;
  readonly stopping: boolean;
  readonly autoStopBusy: boolean;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onExtendAutoStop: (runtime: Runtime) => void;
  readonly onSetAutoStop: (runtime: Runtime) => void;
  readonly onCancelAutoStop: (runtime: Runtime) => void;
  readonly onSwitchAccount: (runtime: Runtime) => void;
  readonly onForwardClosed: () => void;
  /** Optional seam for #44 (single runtime Stop dialog). */
  readonly onRequestStop?: (runtime: Runtime) => void;
  /** Optional seam for #46 (Forward a port dialog). */
  readonly onRequestForward?: (runtime: Runtime) => void;
}

export function RuntimeCard({
  runtime,
  guardDecision,
  forwards,
  rearmDurationSecs,
  stopping,
  autoStopBusy,
  locale,
  t,
  pushToast,
  onExtendAutoStop,
  onSetAutoStop,
  onCancelAutoStop,
  onSwitchAccount,
  onForwardClosed,
  onRequestStop,
  onRequestForward,
}: RuntimeCardProps) {
  const label = formatRuntimeCardLabel(runtime);
  const unknown = t("app.summary.unknown");
  const tracked = runtime.tracked;
  const hardware =
    (tracked ? formatHardware(tracked.gpu, tracked.vram_mib, locale, t) : null) ??
    (runtime.hardware || unknown);

  const startedAt = tracked?.spend?.started_at ?? null;
  const hasStartedAt = typeof startedAt === "number" && Number.isFinite(startedAt);

  const rateText =
    typeof runtime.estimated_rate_cu_per_hour === "number" &&
    Number.isFinite(runtime.estimated_rate_cu_per_hour)
      ? formatApprox(formatCuRate(runtime.estimated_rate_cu_per_hour, locale, t), t)
      : unknown;

  const spendText =
    typeof runtime.estimated_spend_cu === "number" && Number.isFinite(runtime.estimated_spend_cu)
      ? formatApprox(formatCu(runtime.estimated_spend_cu, locale, t), t)
      : unknown;

  const autoStopAt = runtime.auto_stop_at;
  const hasAutoStop = typeof autoStopAt === "number" && Number.isFinite(autoStopAt);
  const armed = isWatchdogArmed(runtime);
  const named = Boolean(runtime.id.name);
  const canManageAutoStop = runtime.on_active_account && runtime.managed && named;
  const rearmText = formatDuration(rearmDurationSecs, t);

  const guardStopFailed =
    guardDecision?.decision.decision === "stop" && !guardDecision.stopped ? guardDecision : null;
  const guardWarnings =
    guardDecision?.decision.decision === "warn" && guardDecision.decision.concerns.length > 0
      ? guardDecision.decision.concerns
      : null;
  const unknownOnlyWarnings = Boolean(
    guardWarnings && guardWarnings.every((c) => c.kind === "usage_unknown"),
  );
  const nearAutoStop = Boolean(
    guardWarnings && guardWarnings.some((c) => c.kind === "limit" && c.limit === "runtime"),
  );

  const hasBadges = !runtime.managed || runtime.high_mem || (hasAutoStop && armed) || stopping;
  const showActions =
    Boolean(onRequestStop) ||
    !runtime.on_active_account ||
    canManageAutoStop ||
    Boolean(onRequestForward) ||
    !named;

  return (
    <article
      className="card session-card"
      data-runtime-card={label}
      data-runtime-managed={runtime.managed ? "true" : "false"}
      data-runtime-active-account={runtime.on_active_account ? "true" : "false"}
    >
      <div className="session-card-header">
        <h3 className="session-card-title">{label}</h3>
        {hasBadges && (
          <div className="session-card-badges">
            {!runtime.managed && (
              <span className="badge badge-warning">{t("app.b2.runtime_unmanaged")}</span>
            )}
            {runtime.high_mem && <span className="badge">{t("app.b2.runtime_high_mem")}</span>}
            {hasAutoStop && armed && (
              <span
                className="badge badge-success"
                title={t("app.b2.prov_watchdog")}
                data-watchdog-armed="true"
              >
                <ShieldIcon className="icon-xs" />
                <span>{t("web.sessions.watchdog_armed")}</span>
              </span>
            )}
            {stopping && <span className="badge badge-info">{t("app.b2.runtime_stopping")}</span>}
          </div>
        )}
      </div>

      <div className="session-stats-grid">
        <div className="session-stat">
          <span className="session-stat-label">{t("app.b2.runtime_hardware")}</span>
          <span className="session-stat-value">{hardware}</span>
        </div>

        <div className="session-stat">
          <span className="session-stat-label">{t("app.b2.runtime_uptime")}</span>
          {hasStartedAt ? (
            <LiveRuntimeUptime startedAt={startedAt} t={t} />
          ) : (
            <span className="session-stat-value">{unknown}</span>
          )}
        </div>

        <div className="session-stat">
          <span className="session-stat-label">{t("app.b2.runtime_rate")}</span>
          <span className="session-stat-value">{rateText}</span>
        </div>

        <div className="session-stat">
          <span className="session-stat-label">{t("app.b2.runtime_spend")}</span>
          <span className="session-stat-value">{spendText}</span>
        </div>

        <div className="session-stat">
          <span className="session-stat-label">{t("app.b2.runtime_auto_stop")}</span>
          {hasAutoStop ? (
            <LiveAutoStopCountdown autoStopAt={autoStopAt} t={t} />
          ) : (
            <span className="session-stat-value">
              {t(runtime.managed ? "app.b2.runtime_auto_stop_off" : "app.b2.runtime_auto_stop_none")}
            </span>
          )}
        </div>
      </div>

      {!runtime.managed && <p className="caption">{t("app.b2.runtime_unmanaged_hint")}</p>}

      {hasAutoStop && !armed && (
        <div className="inline-msg inline-msg-warning" data-auto-stop-app-only={label}>
          <AlertTriangleIcon className="icon-xs icon-warning" />
          <span className="inline-msg-text">{t("app.b5.runtime_auto_stop_app_only")}</span>
        </div>
      )}

      {guardStopFailed && (
        <div className="alert alert-danger" role="alert" data-guard-stop-failed={label}>
          <span className="alert-icon icon-danger">
            <AlertIcon />
          </span>
          <div className="alert-text">
            <p className="alert-title">{t("app.b2.guard_still_billing")}</p>
            {guardStopFailed.error && (
              <p className="alert-body">{formatErrorMessage(guardStopFailed.error, t).message}</p>
            )}
            {onRequestStop && (
              <div className="alert-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={stopping}
                  onClick={() => onRequestStop(runtime)}
                >
                  {t("app.b2.stop_action")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {!guardStopFailed && guardWarnings && (
        <div className="session-guard-warning" data-guard-warning={label}>
          <div
            className={
              unknownOnlyWarnings ? "inline-msg inline-msg-info" : "inline-msg inline-msg-warning"
            }
          >
            {unknownOnlyWarnings ? (
              <SmallInfoIcon className="icon-xs icon-info" />
            ) : (
              <AlertTriangleIcon className="icon-xs icon-warning" />
            )}
            <span className="inline-msg-text">
              {t("app.b2.guard_warn_line", {
                what: formatConcerns(guardWarnings, locale, t),
              })}
            </span>
          </div>
          {nearAutoStop && canManageAutoStop && (
            <div>
              <button
                type="button"
                className="btn btn-sm"
                data-guard-extend={label}
                disabled={autoStopBusy}
                onClick={() => onExtendAutoStop(runtime)}
              >
                {t("app.b2.runtime_extend_by", { time: rearmText })}
              </button>
            </div>
          )}
        </div>
      )}

      {forwards.length > 0 && (
        <div className="session-forwards" data-session-forwards={label}>
          <span className="caption">{t("app.b2.runtime_forwards")}</span>
          <div className="forward-list">
            {forwards.map((fw) => (
              <ForwardRow
                key={fw.id}
                forward={fw}
                t={t}
                pushToast={pushToast}
                onAfterClose={onForwardClosed}
              />
            ))}
          </div>
        </div>
      )}

      {showActions && (
        <div className="session-actions">
          {onRequestStop && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              data-runtime-stop={label}
              disabled={stopping}
              onClick={() => onRequestStop(runtime)}
            >
              {stopping ? <span className="spinner" aria-hidden="true" /> : <SquareIcon />}
              <span>{t("app.b2.stop_action")}</span>
            </button>
          )}

          {!runtime.on_active_account ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                data-runtime-switch={label}
                onClick={() => onSwitchAccount(runtime)}
              >
                <LinkIcon />
                <span>{t("app.b2.runtime_switch")}</span>
              </button>
              <span className="caption">{t("app.b2.runtime_switch_hint")}</span>
            </>
          ) : (
            <>
              {canManageAutoStop && hasAutoStop && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    data-runtime-extend={label}
                    disabled={autoStopBusy}
                    onClick={() => onExtendAutoStop(runtime)}
                  >
                    {t("app.b2.runtime_extend_by", { time: rearmText })}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    data-runtime-cancel-auto-stop={label}
                    disabled={autoStopBusy}
                    onClick={() => onCancelAutoStop(runtime)}
                  >
                    {t("app.b2.runtime_cancel_auto_stop")}
                  </button>
                </>
              )}

              {canManageAutoStop && !hasAutoStop && (
                <button
                  type="button"
                  className="btn btn-sm"
                  data-runtime-set-auto-stop={label}
                  disabled={autoStopBusy}
                  onClick={() => onSetAutoStop(runtime)}
                >
                  {t("app.b3.runtime_set_auto_stop", { time: rearmText })}
                </button>
              )}

              {onRequestForward && (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  data-runtime-forward={label}
                  disabled={!named}
                  title={named ? undefined : t("app.b2.runtime_unnamed_reason")}
                  onClick={() => onRequestForward(runtime)}
                >
                  <LinkIcon />
                  <span>{t("app.b2.forward_title")}</span>
                </button>
              )}

              {!named && <span className="caption">{t("app.b2.runtime_unnamed_reason")}</span>}
            </>
          )}
        </div>
      )}
    </article>
  );
}
