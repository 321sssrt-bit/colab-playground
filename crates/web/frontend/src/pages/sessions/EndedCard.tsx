/**
 * Recently ended runtimes card with per-entry stop reason and Clear action.
 */

import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import { formatConcern, formatEmail, runtimeKey } from "./format.ts";
import { CircleStopIcon, ShieldIcon, SquareIcon } from "./Icons.tsx";
import type { EndedRuntime } from "./store.ts";

export interface EndedCardProps {
  readonly items: readonly EndedRuntime[];
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onClear: () => void;
}

export function EndedCard({ items, locale, t, onClear }: EndedCardProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="card card-compact" data-sessions-ended="true">
      <div className="card-header">
        <h2 className="card-title">{t("app.b2.ended_title")}</h2>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-ended-clear="true"
          onClick={onClear}
        >
          {t("app.b2.action_clear")}
        </button>
      </div>

      <div className="ended-list">
        {items.map((item) => {
          const email = formatEmail(item.email, t);
          const why =
            item.reason.kind === "guard"
              ? t("app.b2.ended_guard", { why: formatConcern(item.reason.concern, locale, t) })
              : item.reason.kind === "vanished"
                ? t("app.b2.ended_vanished")
                : t("app.b2.ended_user");

          return (
            <div className="ended-row" key={`${runtimeKey(item.runtime)}-${item.label}`}>
              <span className="ended-icon">
                {item.reason.kind === "guard" ? (
                  <ShieldIcon className="icon-danger" />
                ) : item.reason.kind === "vanished" ? (
                  <CircleStopIcon className="icon-muted" />
                ) : (
                  <SquareIcon className="icon-muted" />
                )}
              </span>
              <div className="ended-text">
                <div className="ended-line">
                  {t("app.b2.ended_line", { name: item.label, email })}
                </div>
                <div className="caption">{why}</div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
