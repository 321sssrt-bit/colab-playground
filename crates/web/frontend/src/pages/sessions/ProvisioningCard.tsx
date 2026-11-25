/**
 * In-flight session provisioning summary card attached to `POST /api/sessions/{id}/events`.
 */

import { useEffect, useState } from "react";

import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { ToastInput } from "../../lib/toast.ts";
import type { Locale, PendingOperation } from "../../lib/types.ts";
import { cancelProvision, type ProvisionFinishedEvent } from "./api.ts";
import { formatErrorMessage } from "./format.ts";
import {
  formatProvisionHeadline,
  ProvisionProgress,
  useProvisionStream,
} from "./ProvisionProgress.tsx";

export interface ProvisioningCardProps {
  readonly operation: PendingOperation;
  readonly sessionName: string;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly pushToast: (toast: ToastInput) => number;
  readonly onShowDialog?: () => void;
  readonly onFinished?: (event: ProvisionFinishedEvent, sessionName: string) => void;
}

export function ProvisioningCard({
  operation,
  sessionName,
  locale,
  t,
  pushToast,
  onShowDialog,
  onFinished,
}: ProvisioningCardProps) {
  const [cancelRequested, setCancelRequested] = useState(false);

  useEffect(() => {
    setCancelRequested(false);
  }, [operation.id]);

  const { events, waitingSinceMs } = useProvisionStream({
    operationId: operation.id,
    onFinished: (finished) => {
      onFinished?.(finished, sessionName);
    },
  });

  const cancelling = operation.cancelling || cancelRequested;

  const handleCancel = async () => {
    if (cancelling) {
      return;
    }
    setCancelRequested(true);
    try {
      await cancelProvision(operation.id);
    } catch (error) {
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        pushToast({
          tone: "danger",
          body: formatErrorMessage(error, t).message,
        });
      }
      setCancelRequested(false);
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
        waitingSinceMs={waitingSinceMs}
        locale={locale}
        t={t}
      />

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
