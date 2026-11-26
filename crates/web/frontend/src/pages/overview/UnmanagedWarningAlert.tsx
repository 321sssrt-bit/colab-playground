/**
 * Shared warning banner for unmanaged billing runtimes rendered on Overview in
 * both checklist and ready states.
 */

import { AlertIcon } from "../../components/Icons.tsx";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { NavigateOptions, RouteId } from "../../lib/router.ts";
import type { UnmanagedWarningView } from "../accounts/model.ts";

export interface UnmanagedWarningAlertProps {
  readonly warning: UnmanagedWarningView;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
}

export function UnmanagedWarningAlert({
  warning,
  t,
  navigate,
}: UnmanagedWarningAlertProps) {
  return (
    <div
      className="alert alert-warning overview-unmanaged-alert"
      role="alert"
      data-overview-unmanaged="true"
    >
      <span className="alert-icon icon-warning">
        <AlertIcon />
      </span>
      <div className="alert-text">
        <p className="alert-title">{warning.title}</p>
        <p className="alert-body">{warning.body}</p>
        <div className="alert-actions">
          <button
            type="button"
            className="btn btn-sm"
            data-overview-view-sessions="true"
            onClick={() => navigate("sessions")}
          >
            {t("app.action.view_sessions")}
          </button>
        </div>
      </div>
    </div>
  );
}
