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

const GPU_ACCELERATORS = new Set(["T4", "L4", "G4", "A100", "H100"]);
const SINGLE_SHAPE_ACCELERATORS = new Set(["L4", "V5E1", "V6E1"]);
const MIB_PER_GIB = 1024;

export function acceleratorLabel(code) {
  return t(ACCELERATOR_KEYS[code] || "app.acc.none");
}

export function acceleratorIsGpu(code) {
  return GPU_ACCELERATORS.has(code);
}

export function acceleratorSupportsHighMem(code) {
  return !SINGLE_SHAPE_ACCELERATORS.has(code);
}

export function acceleratorNamePrefix(code) {
  if (!code || code === "NONE") {
    return "cpu";
  }
  return String(code).toLowerCase();
}

export function isLoopbackHostname(hostname) {
  if (!hostname || typeof hostname !== "string") {
    return false;
  }
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return clean === "localhost" || clean === "::1" || clean === "127.0.0.1" || clean.startsWith("127.");
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

export function formatApprox(value) {
  return t("app.fmt.approx", { value });
}

export function formatCu(value) {
  return t("app.fmt.cu", { value: formatNumber(value, 2) });
}

export function formatCuRate(value) {
  return t("app.fmt.cu_rate", { value: formatNumber(value, 2) });
}

export function formatVram(vramMib) {
  const gb = Math.max(1, Math.round((Number(vramMib) || 0) / MIB_PER_GIB));
  return t("app.b2.fmt_gb", { n: gb });
}

export function formatHardware(gpu, vramMib) {
  const hasGpu = typeof gpu === "string" && gpu.trim().length > 0;
  const hasVram = typeof vramMib === "number" && Number.isFinite(vramMib) && vramMib > 0;
  if (hasGpu && hasVram) {
    return `${gpu} · ${formatVram(vramMib)}`;
  }
  if (hasGpu) {
    return gpu;
  }
  if (hasVram) {
    return formatVram(vramMib);
  }
  return null;
}

export function formatShortWait(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  if (s < SECS_PER_MINUTE) {
    return t("app.b2.fmt_seconds", { n: s });
  }
  return formatDurationSecs(s);
}

const LIMIT_KEYS = {
  runtime: "app.b2.limit_runtime",
  spend: "app.b2.limit_spend",
  balance: "app.b2.limit_balance",
};

export function formatConcern(concern) {
  if (!concern || typeof concern !== "object") {
    return "";
  }
  if (concern.kind === "usage_unknown") {
    const limit = t(LIMIT_KEYS[concern.limit] || "app.b2.limit_runtime");
    return t("app.b2.guard_unknown", { limit });
  }
  if (concern.kind === "limit") {
    if (concern.limit === "runtime") {
      return t("app.b2.guard_runtime", {
        current: formatDurationSecs(concern.current),
        limit: formatDurationSecs(concern.threshold),
      });
    }
    if (concern.limit === "spend") {
      return t("app.b2.guard_spend", {
        current: formatApprox(formatCu(concern.current)),
        limit: formatCu(concern.threshold),
      });
    }
    if (concern.limit === "balance") {
      return t("app.b2.guard_balance", {
        current: formatCu(concern.current),
        limit: formatCu(concern.threshold),
      });
    }
  }
  return "";
}

export function formatConcerns(concerns) {
  if (!Array.isArray(concerns)) {
    return "";
  }
  return concerns
    .map((item) => formatConcern(item))
    .filter(Boolean)
    .join(t("app.fmt.list_separator"));
}

export function formatRuntimeCardLabel(runtime) {
  if (!runtime) return "";
  if (runtime.id?.name) return runtime.id.name;
  if (runtime.hardware) return runtime.hardware;
  return runtime.id?.endpoint || "";
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

export function formatAge(fetchedAtSecs, nowSecs = Math.floor(Date.now() / 1000)) {
  if (typeof fetchedAtSecs !== "number" || !Number.isFinite(fetchedAtSecs)) {
    return t("app.summary.unknown");
  }
  const diff = Math.max(0, Math.floor(nowSecs - fetchedAtSecs));
  if (diff < SECS_PER_MINUTE) {
    return t("app.fmt.just_now");
  }
  if (diff < SECS_PER_HOUR) {
    return t("app.fmt.minutes_ago", { n: Math.floor(diff / SECS_PER_MINUTE) });
  }
  if (diff < SECS_PER_DAY) {
    return t("app.fmt.hours_ago", { n: Math.floor(diff / SECS_PER_HOUR) });
  }
  return t("app.fmt.days_ago", { n: Math.floor(diff / SECS_PER_DAY) });
}

export function formatUsageTip(usageView) {
  const snap = usageView?.snapshot;
  if (!snap) {
    return t("app.usage.tip.unknown");
  }
  const lines = [t("app.shell.usage.hint")];
  const etaSecs = usageView.eta;
  if (etaSecs === null || etaSecs === undefined) {
    lines.push(t("app.usage.tip.idle"));
  } else if (etaSecs <= 0) {
    lines.push(t("app.usage.tip.empty"));
  } else {
    lines.push(t("app.usage.tip.left", { time: formatDurationSecs(etaSecs) }));
  }
  lines.push(t("app.usage.tip.updated", { age: formatAge(snap.fetched_at) }));
  if (snap.stale) {
    lines.push(t("app.usage.tip.stale"));
  }
  return lines.join("\n");
}

export function formatRuntimeLabel(runtimeRef, runtimesList = []) {
  if (!runtimeRef) return "";
  const matched = Array.isArray(runtimesList)
    ? runtimesList.find(
        (rt) => rt?.id?.account === runtimeRef.account && rt?.id?.endpoint === runtimeRef.endpoint
      )
    : null;
  if (matched?.id?.name) {
    return matched.id.name;
  }
  if (runtimeRef.name) {
    return runtimeRef.name;
  }
  if (matched?.hardware) {
    return `${matched.hardware} · ${runtimeRef.endpoint}`;
  }
  return runtimeRef.endpoint || "";
}

const ERROR_KIND_KEYS = {
  not_installed: "app.err.not_installed",
  keyring_unavailable: "app.err.keyring_unavailable",
  auth_required: "app.err.auth_required",
  not_entitled: "app.err.not_entitled",
  capacity_refused: "app.err.capacity_refused",
  allocation_timeout: "app.err.allocation_timeout",
  ssh_busy: "app.err.ssh_busy",
  session_gone: "app.err.session_gone",
  connection_lost: "app.err.connection_lost",
  exec_timeout: "app.err.exec_timeout",
  port_in_use: "app.err.port_in_use",
  port_reserved: "app.err.port_reserved",
  no_active_account: "app.err.no_active_account",
  active_not_adopted: "app.err.active_not_adopted",
  account_not_found: "app.err.account_not_found",
  account_not_active: "app.err.account_not_active",
  add_in_progress: "app.err.add_in_progress",
  legacy_token: "app.err.legacy_token",
  login_cancelled: "app.err.login_cancelled",
  login_invalid_code: "app.err.login_invalid_code",
  login_unverified: "app.err.login_unverified",
  unsupported: "app.err.unsupported",
  wsl_unavailable: "app.err.wsl_unavailable",
  command_too_long: "app.err.command_too_long",
  session_limit_reached: "app.err.session_limit",
  busy: "app.err.busy",
  data_dir_in_use: "app.err.data_dir_in_use",
  provision_exhausted: "app.err.provision_exhausted",
  orphan_suspected: "app.err.orphan_suspected",
  manifest_invalid: "app.err.manifest_invalid",
  plugin_exists: "app.err.plugin_exists",
  plugin_not_found: "app.err.plugin_not_found",
  plugin_run_failed: "app.err.plugin_run_failed",
  health_check_failed: "app.err.health_check_failed",
  git_failed: "app.err.git_failed",
  install_failed: "app.err.install_failed",
  cancelled: "app.err.cancelled",
  invalid_input: "app.err.invalid_input",
  http: "app.err.http",
  http_unavailable: "app.err.http_unavailable",
  rate_limited: "app.b7.err_rate_limited",
  parse: "app.err.parse",
  io: "app.err.io",
  timeout: "app.err.timeout",
  unsupported_cli: "app.err.unsupported_cli",
};

export function formatErrorKind(kind, args = null) {
  if (!kind || typeof kind !== "string") {
    return t("app.err.other");
  }
  const key = ERROR_KIND_KEYS[kind];
  return key ? t(key, args) : t("app.err.other");
}

export function formatApiError(errPayload) {
  if (!errPayload) {
    return { message: t("app.err.other"), hint: null, kind: null, actionKey: null };
  }
  if (typeof errPayload === "string") {
    return { message: formatErrorKind(errPayload), hint: null, kind: errPayload, actionKey: null };
  }
  if (typeof errPayload !== "object") {
    return { message: t("app.err.other"), hint: null, kind: null, actionKey: null };
  }
  const err = errPayload.error || errPayload;
  const args = err.args || err.params || null;
  const message = err.message_key
    ? t(err.message_key, args)
    : err.kind
      ? formatErrorKind(err.kind, args)
      : t("app.err.other");
  const hint = err.hint_key ? t(err.hint_key, args) : null;
  return {
    message,
    hint,
    kind: err.kind || null,
    actionKey: err.action_key || null,
  };
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
