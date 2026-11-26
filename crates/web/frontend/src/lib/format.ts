/**
 * Shared display formatters for compute units, burn rates, durations, relative
 * ages, active account identity, and the shell usage badge.
 */

import { useServerClockSecs } from "./clock.ts";
import type { TranslateFn } from "./i18n.ts";
import type { AccountId, AccountUsageView, Locale, Snapshot, UsageSnapshot } from "./types.ts";

const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const SECS_PER_DAY = 86_400;
/** Mirrors `colab_playground_core::guard::USAGE_STALE_AFTER` (5 minutes). */
export const USAGE_STALE_AFTER_SECS = 5 * SECS_PER_MINUTE;
const USAGE_CLOCK_INTERVAL_MS = 30_000;
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

export interface UsageFreshness {
  readonly ageSecs: number;
  readonly isStale: boolean;
  readonly isOld: boolean;
  readonly outdated: boolean;
}

/**
 * React hook returning the current backend-anchored Unix timestamp in seconds,
 * updated periodically so usage age tooltips and staleness thresholds converge
 * accurately regardless of browser wall-clock skew.
 */
export function useUsageClockSecs(): number {
  return useServerClockSecs(USAGE_CLOCK_INTERVAL_MS);
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
 * Evaluates whether a usage reading is stale (a later fetch failed or was
 * restored without verification) or old (older than `USAGE_STALE_AFTER_SECS`).
 * Aging never overwrites the failed-refresh `isStale` flag.
 */
export function evaluateUsageSampleFreshness(
  usageSnap: UsageSnapshot | null,
  usageView: AccountUsageView | null,
  nowSecs: number,
): UsageFreshness | null {
  if (usageSnap === null) {
    return null;
  }
  const ageSecs = Math.max(0, Math.floor(nowSecs - usageSnap.fetched_at));
  const isStale = usageSnap.stale || (usageView?.last_error ?? null) !== null;
  const isOld = ageSecs > USAGE_STALE_AFTER_SECS;
  return {
    ageSecs,
    isStale,
    isOld,
    outdated: isStale || isOld,
  };
}

/**
 * Evaluates whether an active account's usage reading is stale (failed refresh)
 * or old (past the freshness threshold).
 */
export function evaluateUsageFreshness(
  active: ActiveAccountSummary,
  nowSecs: number,
): UsageFreshness | null {
  if (!active.signedIn) {
    return null;
  }
  return evaluateUsageSampleFreshness(active.usageSnapshot, active.usage, nowSecs);
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
  const freshness = evaluateUsageFreshness(active, nowSecs);
  if (!active.signedIn || snap === null || freshness === null) {
    const hasError = (active.usage?.last_error ?? null) !== null;
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
  const text = freshness.outdated ? `${baseText} (${t("app.usage.outdated")})` : baseText;

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

  tipLines.push(t("app.usage.tip.updated", { age: formatRelativeAge(freshness.ageSecs, t) }));
  if (freshness.isStale) {
    tipLines.push(t("app.usage.tip.stale"));
  } else if (freshness.isOld) {
    tipLines.push(t("app.usage.tip.old"));
  }

  return {
    text,
    tooltip: tipLines.join("\n"),
    tone: freshness.outdated || snap.balance_cu <= 0 ? "warning" : "neutral",
    outdated: freshness.outdated,
  };
}
