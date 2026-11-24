import { t } from "./i18n.js";

const SECS_PER_MINUTE = 60;
const SECS_PER_HOUR = 3600;
const SECS_PER_DAY = 86400;

const ACCELERATOR_KEYS = {
  NONE: "app.acc.none",
  T4: "app.acc.t4",
  L4: "app.acc.l4",
  G4: "app.acc.g4",
  A100: "app.acc.a100",
  H100: "app.acc.h100",
  V5E1: "app.acc.v5e1",
  V6E1: "app.acc.v6e1",
};

const INSTALL_METHOD_KEYS = {
  uv: "app.install.uv",
  install_uv_then_cli: "app.install.uv_first",
  pip_user: "app.install.pip",
};

export const ACCELERATORS = ["NONE", "T4", "L4", "G4", "A100", "H100", "V5E1", "V6E1"];

export function acceleratorLabel(code) {
  return t(ACCELERATOR_KEYS[code] || "app.acc.none");
}

export function installMethodLabel(method) {
  return t(INSTALL_METHOD_KEYS[method] || "app.install.uv");
}

export function formatNumber(value, decimals = 2) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  const fixed = value.toFixed(decimals);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");
}

export function formatCu(value) {
  return t("app.fmt.cu", { value: formatNumber(value, 2) });
}

export function formatCuRate(value) {
  return t("app.fmt.cu_rate", { value: formatNumber(value, 2) });
}

export function formatDurationSecs(totalSecs) {
  const secs = Math.max(0, Math.floor(Number(totalSecs) || 0));
  if (secs < SECS_PER_MINUTE) {
    return t("app.fmt.under_minute");
  }
  const days = Math.floor(secs / SECS_PER_DAY);
  const hours = Math.floor((secs % SECS_PER_DAY) / SECS_PER_HOUR);
  const minutes = Math.floor((secs % SECS_PER_HOUR) / SECS_PER_MINUTE);
  if (days > 0) {
    if (hours === 0) {
      return t("app.b3.fmt_days", { d: days });
    }
    return t("app.fmt.days_hours", { d: days, h: hours });
  }
  if (hours > 0) {
    if (minutes === 0) {
      return t("app.b3.fmt_hours", { h: hours });
    }
    return t("app.fmt.hours_minutes", { h: hours, m: minutes });
  }
  return t("app.fmt.minutes", { m: minutes });
}

export function formatEmail(email) {
  return email && email.trim() ? email : t("app.accounts.no_email");
}

// Displays server-computed ETA without calculating balance / rate on the client.
export function formatTimeLeft(usageView) {
  if (!usageView || !usageView.snapshot) {
    return t("app.summary.unknown");
  }
  const etaSecs = usageView.eta;
  if (etaSecs === null || etaSecs === undefined) {
    return t("app.summary.not_burning");
  }
  if (etaSecs <= 0) {
    return t("app.summary.empty");
  }
  return t("app.fmt.approx", { value: formatDurationSecs(etaSecs) });
}

export function formatUsageBadge(usageView) {
  if (!usageView || !usageView.snapshot) {
    return { text: t("app.shell.usage"), stale: false };
  }
  const snap = usageView.snapshot;
  const base = t("app.usage.badge", {
    balance: formatCu(snap.balance_cu),
    rate: formatCuRate(snap.rate_cu_per_hour),
  });
  if (snap.stale) {
    return {
      text: `${base} · ${t("app.usage.outdated")}`,
      stale: true,
    };
  }
  return { text: base, stale: false };
}

export function formatApiError(errPayload) {
  if (!errPayload || typeof errPayload !== "object") {
    return { message: t("app.err.other"), hint: null };
  }
  const err = errPayload.error || errPayload;
  const message = err.message_key
    ? t(err.message_key, err.args || null)
    : t("app.err.other");
  const hint = err.hint_key ? t(err.hint_key, err.args || null) : null;
  return { message, hint };
}

export function splitDuration(totalSecs, includeSeconds) {
  const secs = Math.max(0, Math.floor(Number(totalSecs) || 0));
  const hours = Math.floor(secs / SECS_PER_HOUR);
  const minutes = Math.floor((secs % SECS_PER_HOUR) / SECS_PER_MINUTE);
  const seconds = includeSeconds ? secs % SECS_PER_MINUTE : 0;
  return { hours, minutes, seconds };
}

export function composeDuration(hours, minutes, seconds = 0) {
  const h = Math.max(0, Math.floor(Number(hours) || 0));
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return h * SECS_PER_HOUR + m * SECS_PER_MINUTE + s;
}
