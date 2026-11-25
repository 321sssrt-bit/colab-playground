/**
 * Shared display formatters for compute units, burn rates, durations, relative
 * ages, active account identity, and the shell usage badge.
 */

import type { TranslateFn } from "./i18n.ts";
import type { AccountId, AccountUsageView, Locale, Snapshot, UsageSnapshot } from "./types.ts";

const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const SECS_PER_DAY = 86_400;
const USAGE_OLD_THRESHOLD_SECS = 600;
const CU_MIN_FRACTION_DIGITS = 1;
const CU_MAX_FRACTION_DIGITS = 2;

export interface ActiveAccountSummary {
  readonly id: AccountId | null;
  readonly email: string | null;
  readonly label: string;
  readonly signedIn: boolean;
  readonly usage: AccountUsageView | null;
  readonly usageSnapshot: UsageSnapshot | null;
}

export interface UsageBadgeModel {
  readonly text: string;
  readonly tooltip: string;
  readonly tone: "neutral" | "warning";
  readonly outdated: boolean;
}

function formatNumber(value: number, locale: Locale): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: CU_MIN_FRACTION_DIGITS,
      maximumFractionDigits: CU_MAX_FRACTION_DIGITS,
    }).format(safe);
  } catch {
    return safe.toFixed(CU_MAX_FRACTION_DIGITS);
  }
}

export function formatCu(value: number, locale: Locale, t: TranslateFn): string {
  return t("app.fmt.cu", { value: formatNumber(value, locale) });
}

export function formatCuRate(value: number, locale: Locale, t: TranslateFn): string {
  return t("app.fmt.cu_rate", { value: formatNumber(value, locale) });
}

export function formatApprox(value: string, t: TranslateFn): string {
  return t("app.fmt.approx", { value });
}

export function formatDuration(totalSecs: number, t: TranslateFn): string {
  const secs = Number.isFinite(totalSecs) ? Math.max(0, Math.floor(totalSecs)) : 0;
  if (secs < SECS_PER_MINUTE) {
    return t("app.fmt.under_minute");
  }
  const days = Math.floor(secs / SECS_PER_DAY);
  const hours = Math.floor((secs % SECS_PER_DAY) / SECS_PER_HOUR);
  const minutes = Math.floor((secs % SECS_PER_HOUR) / SECS_PER_MINUTE);

  if (days > 0) {
    return hours > 0
      ? t("app.fmt.days_hours", { d: days, h: hours })
      : t("app.b3.fmt_days", { d: days });
  }
  if (hours > 0) {
    return minutes > 0
      ? t("app.fmt.hours_minutes", { h: hours, m: minutes })
      : t("app.b3.fmt_hours", { h: hours });
  }
  return t("app.fmt.minutes", { m: minutes });
}

export function formatRelativeAge(ageSecs: number, t: TranslateFn): string {
  const secs = Number.isFinite(ageSecs) ? Math.max(0, Math.floor(ageSecs)) : 0;
  if (secs < SECS_PER_MINUTE) {
    return t("app.fmt.just_now");
  }
  if (secs < SECS_PER_HOUR) {
    return t("app.fmt.minutes_ago", { n: Math.floor(secs / SECS_PER_MINUTE) });
  }
  if (secs < SECS_PER_DAY) {
    return t("app.fmt.hours_ago", { n: Math.floor(secs / SECS_PER_HOUR) });
  }
  return t("app.fmt.days_ago", { n: Math.floor(secs / SECS_PER_DAY) });
}

export function resolveActiveAccount(
  snapshot: Snapshot | null,
  t: TranslateFn,
): ActiveAccountSummary {
  const activeId = snapshot?.accounts?.active ?? snapshot?.account.active ?? null;
  const accountRecord =
    activeId !== null
      ? (snapshot?.accounts?.accounts.find((item) => item.id === activeId) ?? null)
      : null;
  const usage =
    activeId !== null
      ? (snapshot?.usage.find((item) => item.account === activeId) ?? null)
      : null;
  const usageSnapshot = usage?.snapshot ?? accountRecord?.usage ?? null;
  const email =
    accountRecord?.email ??
    usage?.email ??
    snapshot?.accounts?.active_email ??
    null;

  if (activeId !== null) {
    return {
      id: activeId,
      email,
      label: email ?? t("app.accounts.no_email"),
      signedIn: true,
      usage,
      usageSnapshot,
    };
  }

  return {
    id: null,
    email: null,
    label: t("app.shell.account.signed_out"),
    signedIn: false,
    usage: null,
    usageSnapshot: null,
  };
}

/**
 * Formats the shell compute-unit usage badge and its hover/accessible tooltip.
 * Unknown usage is never treated as zero; stale or old readings are flagged.
 */
export function buildUsageBadge(
  active: ActiveAccountSummary,
  nowSecs: number,
  locale: Locale,
  t: TranslateFn,
): UsageBadgeModel {
  const snap = active.usageSnapshot;
  if (!active.signedIn || snap === null) {
    const hasError = active.usage?.last_error !== null && active.usage?.last_error !== undefined;
    const tipLines = [t("app.shell.usage.hint"), t("app.usage.tip.unknown")];
    if (hasError) {
      tipLines.push(t("app.usage.tip.stale"));
    }
    return {
      text: t("app.shell.usage"),
      tooltip: tipLines.join("\n"),
      tone: hasError ? "warning" : "neutral",
      outdated: false,
    };
  }

  const balance = formatCu(snap.balance_cu, locale, t);
  const rate = formatCuRate(snap.rate_cu_per_hour, locale, t);
  const baseText = t("app.usage.badge", { balance, rate });

  const ageSecs = Math.max(0, Math.floor(nowSecs - snap.fetched_at));
  const isStale = snap.stale || (active.usage?.last_error ?? null) !== null;
  const isOld = ageSecs >= USAGE_OLD_THRESHOLD_SECS;
  const outdated = isStale || isOld;
  const text = outdated ? `${baseText} (${t("app.usage.outdated")})` : baseText;

  const tipLines: string[] = [];
  if (snap.balance_cu <= 0) {
    tipLines.push(t("app.usage.tip.empty"));
  } else if (snap.rate_cu_per_hour <= 0) {
    tipLines.push(t("app.usage.tip.idle"));
  } else if (active.usage?.eta !== null && active.usage?.eta !== undefined) {
    tipLines.push(t("app.usage.tip.left", { time: formatDuration(active.usage.eta, t) }));
  } else {
    tipLines.push(t("app.shell.usage.hint"));
  }

  tipLines.push(t("app.usage.tip.updated", { age: formatRelativeAge(ageSecs, t) }));
  if (isStale) {
    tipLines.push(t("app.usage.tip.stale"));
  } else if (isOld) {
    tipLines.push(t("app.usage.tip.old"));
  }

  return {
    text,
    tooltip: tipLines.join("\n"),
    tone: outdated || snap.balance_cu <= 0 ? "warning" : "neutral",
    outdated,
  };
}
