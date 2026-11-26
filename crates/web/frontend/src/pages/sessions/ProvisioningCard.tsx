/**
 * In-flight session provisioning summary card backed by the store-owned
 * `POST /api/sessions/{id}/events` tracker so hiding/reopening never resets
 * progress or slow-answer timing.
 */

import { useEffect, useState } from "react";

import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Locale, PendingOperation } from "../../lib/types.ts";
import { cancelProvision } from "./api.ts";
import { formatErrorMessage } from "./format.ts";
import { SmallInfoIcon } from "./Icons.tsx";
import { formatProvisionHeadline, ProvisionProgress } from "./ProvisionProgress.tsx";
import { trackProvision, type TrackedProvision } from "./store.ts";

export interface ProvisioningCardProps {
  readonly operation: PendingOperation | null;
  readonly trackedProvision: TrackedProvision | null;
  readonly sessionName: string;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onShowDialog?: () => void;
}

export function ProvisioningCard({
  operation,
  trackedProvision,
  sessionName,
  locale,
  t,
  pushToast,
  onShowDialog,
}: ProvisioningCardProps) {
  const operationId = operation?.id ?? trackedProvision?.operationId ?? null;
  const [cancelRequested, setCancelRequested] = useState(false);

  useEffect(() => {
    setCancelRequested(false);
    if (operationId !== null) {
      trackProvision(operationId, sessionName);
    }
  }, [operationId, sessionName]);

  if (operationId === null) {
    return null;
  }

  const events =
    trackedProvision && trackedProvision.operationId === operationId ? trackedProvision.events : [];
  const waitingSinceSecs =
    trackedProvision && trackedProvision.operationId === operationId
      ? trackedProvision.waitingSinceSecs
      : null;
  const reconnecting =
    trackedProvision !== null &&
    trackedProvision.operationId === operationId &&
    trackedProvision.reconnecting;
  const cancelling = Boolean(operation?.cancelling) || cancelRequested;

  const handleCancel = async () => {
    if (cancelling) {
      return;
    }
    setCancelRequested(true);
    try {
      await cancelProvision(operationId);
    } catch (error) {
      if (!(error instanceof ApiError && (error.isUnauthorized || error.kind === "provision_not_found"))) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
        setCancelRequested(false);
      }
    }
  };

  return (
    <section className="card card-compact" data-sessions-provisioning="true">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">{t("app.b2.sessions_starting", { name: sessionName })}</h2>
          <p className="card-desc">{formatProvisionHeadline(events, t)}</p>
        </div>
      </div>

      <ProvisionProgress
        events={events}
        live={true}
        waitingSinceSecs={waitingSinceSecs}
        locale={locale}
        t={t}
      />

      {reconnecting && (
        <div className="inline-msg inline-msg-info" role="status">
          <SmallInfoIcon className="icon-xs icon-info" />
          <span className="inline-msg-text">{t("web.shell.reconnecting")}</span>
        </div>
      )}

      <div className="session-actions">
        {onShowDialog && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-provisioning-show="true"
            onClick={onShowDialog}
          >
            {t("app.b2.action_show")}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-danger"
          data-provisioning-cancel="true"
          disabled={cancelling}
          onClick={() => {
            void handleCancel();
          }}
        >
          {cancelling && <span className="spinner" aria-hidden="true" />}
          <span>{t(cancelling ? "app.b2.new_cancelling" : "app.action.cancel")}</span>
        </button>
      </div>
    </section>
  );
}
