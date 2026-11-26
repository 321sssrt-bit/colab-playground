/**
 * Overview wire adapters, streaming/replay CLI installer client, upstream
 * three-step checklist state derivation, quick-deploy filtering, and
 * ready/checklist unmanaged runtime warning builders.
 */

import { apiClient, ApiError, type ApiClient } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { SseFrame } from "../../lib/sse.ts";
import type {
  AccountId,
  AccountsView,
  AccountUsageView,
  ApiErrorPayload,
  CliInstallLine,
  CliInstallPhase,
  CliInstallView,
  ErrorKind,
  ForwardPolicyView,
  InstallMethod,
  OverviewResponse,
  PendingOperation,
  ProbeReport,
  Snapshot,
  UnmanagedRuntimes,
} from "../../lib/types.ts";
import {
  buildAccountRows,
  buildUnmanagedWarning,
  formatApiError,
  type FormattedApiError,
  type UnmanagedWarningView,
} from "../accounts/model.ts";
import type { PluginInfo } from "../plugins/types.ts";

export type {
  CliInstallLine,
  CliInstallPhase,
  CliInstallView,
  ForwardPolicyView,
  InstallMethod,
  OverviewResponse,
  ProbeReport,
  UnmanagedRuntimes,
};

export type InstallLine = CliInstallLine;

export type InstallFinishedStatus = "succeeded" | "cancelled" | "failed";

export interface InstallFinishedEvent {
  readonly status: InstallFinishedStatus;
  readonly phase: CliInstallPhase;
  readonly cli_installed: boolean;
  readonly warning_title_key: string | null;
  readonly warning_body_key: string | null;
  readonly error: ApiErrorPayload | null;
}

export interface InstallStreamCallbacks {
  readonly signal?: AbortSignal;
  readonly onStarted?: (id: number, method: InstallMethod | null) => void;
  readonly onLine?: (line: InstallLine) => void;
  readonly onFinished?: (event: InstallFinishedEvent) => void;
}

export type ChecklistStepStatus = "checking" | "done" | "todo" | "waiting" | "failed";

export interface ChecklistModel {
  readonly complete: boolean;
  readonly hostStatus: ChecklistStepStatus;
  readonly cliStatus: ChecklistStepStatus;
  readonly signinStatus: ChecklistStepStatus;
}

export interface DeriveChecklistOptions {
  readonly probeErrorKind?: ErrorKind | null;
  readonly installing?: boolean;
}

export interface OverviewRuntimesSummary {
  readonly known: number;
  readonly totalRuntimes: number;
  readonly incomplete: boolean;
  readonly uncountedNote: string | null;
}

export const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";

export const INSTALL_LOG_MAX_LINES = 5000;

export const INSTALL_METHOD_KEYS = {
  uv: "app.install.uv",
  install_uv_then_cli: "app.install.uv_first",
  pip_user: "app.install.pip",
} as const satisfies Record<InstallMethod, string>;

const MAX_UNCOUNTED_EMAILS = 2;

const CLI_INSTALL_PHASES: ReadonlySet<string> = new Set<CliInstallPhase>([
  "idle",
  "running",
  "checking",
  "succeeded",
  "not_found",
  "probe_failed",
  "cancelled",
  "failed",
]);

const INSTALL_METHODS: ReadonlySet<string> = new Set<InstallMethod>([
  "uv",
  "install_uv_then_cli",
  "pip_user",
]);

const ANSI_ESCAPE_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCliInstallPhase(value: unknown): value is CliInstallPhase {
  return typeof value === "string" && CLI_INSTALL_PHASES.has(value);
}

function isInstallMethod(value: unknown): value is InstallMethod {
  return typeof value === "string" && INSTALL_METHODS.has(value);
}

function parseErrorPayload(raw: unknown): ApiErrorPayload | null {
  if (!isRecord(raw) || typeof raw.kind !== "string" || typeof raw.message_key !== "string") {
    return null;
  }
  const args: Record<string, string> = {};
  if (isRecord(raw.args)) {
    for (const [key, value] of Object.entries(raw.args)) {
      if (typeof value === "string") {
        args[key] = value;
      }
    }
  }
  return {
    kind: raw.kind,
    message_key: raw.message_key,
    args,
    hint_key: typeof raw.hint_key === "string" ? raw.hint_key : null,
    action_key: typeof raw.action_key === "string" ? raw.action_key : null,
    operation_id: typeof raw.operation_id === "number" ? raw.operation_id : null,
  };
}

function parseInstallFrame(frame: SseFrame, callbacks: InstallStreamCallbacks): void {
  let raw: unknown;
  try {
    raw = JSON.parse(frame.data);
  } catch {
    return;
  }
  if (!isRecord(raw)) {
    return;
  }
  if (frame.event === "started" && typeof raw.id === "number" && Number.isFinite(raw.id)) {
    callbacks.onStarted?.(raw.id, isInstallMethod(raw.method) ? raw.method : null);
    return;
  }
  if (frame.event === "line" && typeof raw.text === "string") {
    const stream = raw.stream === "stderr" ? "stderr" : "stdout";
    callbacks.onLine?.({ stream, text: stripAnsi(raw.text) });
    return;
  }
  if (frame.event === "finished") {
    const rawStatus =
      raw.status === "succeeded" || raw.status === "cancelled" || raw.status === "failed"
        ? raw.status
        : null;
    const phase: CliInstallPhase | null = isCliInstallPhase(raw.phase)
      ? raw.phase
      : rawStatus === "succeeded"
        ? "succeeded"
        : rawStatus === "cancelled"
          ? "cancelled"
          : rawStatus === "failed"
            ? "failed"
            : null;
    if (phase === null) {
      return;
    }
    const status: InstallFinishedStatus =
      rawStatus ?? (phase === "succeeded" ? "succeeded" : phase === "cancelled" ? "cancelled" : "failed");
    callbacks.onFinished?.({
      status,
      phase,
      cli_installed:
        typeof raw.cli_installed === "boolean" ? raw.cli_installed : phase === "succeeded",
      warning_title_key: typeof raw.warning_title_key === "string" ? raw.warning_title_key : null,
      warning_body_key: typeof raw.warning_body_key === "string" ? raw.warning_body_key : null,
      error: parseErrorPayload(raw.error),
    });
  }
}

/**
 * Strips ANSI terminal control sequences so streamed or replayed CLI installer
 * output renders cleanly as plain text lines.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Strips ANSI sequences and caps hydrated install lines to `INSTALL_LOG_MAX_LINES`. */
export function sanitizeInstallLines(lines: readonly CliInstallLine[]): readonly InstallLine[] {
  const sliced =
    lines.length > INSTALL_LOG_MAX_LINES
      ? lines.slice(lines.length - INSTALL_LOG_MAX_LINES)
      : lines;
  return sliced.map((line) => ({
    stream: line.stream === "stderr" ? "stderr" : "stdout",
    text: stripAnsi(line.text),
  }));
}

/** Reads the latest server-side CLI install snapshot via `GET /api/overview/cli/install`. */
export function getCliInstallStatus(
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<CliInstallView> {
  return client.request<CliInstallView>("/api/overview/cli/install", {
    method: "GET",
    signal,
  });
}

/** Starts a streaming Colab CLI install via `POST /api/overview/cli/install`. */
export function startCliInstallStream(
  method: InstallMethod,
  callbacks: InstallStreamCallbacks,
  client: ApiClient = apiClient,
): Promise<void> {
  return client.openEventStream("/api/overview/cli/install", {
    body: { method },
    signal: callbacks.signal,
    onFrame: (frame) => parseInstallFrame(frame, callbacks),
  });
}

/**
 * Attaches to a server-side CLI install replay/live stream via
 * `POST /api/overview/cli/install/{id}/events` (or `/events` for latest).
 */
export function subscribeCliInstallEvents(
  id: number | null,
  callbacks: InstallStreamCallbacks,
  client: ApiClient = apiClient,
): Promise<void> {
  const path =
    id !== null ? `/api/overview/cli/install/${id}/events` : "/api/overview/cli/install/events";
  return client.openEventStream(path, {
    body: {},
    signal: callbacks.signal,
    onFrame: (frame) => parseInstallFrame(frame, callbacks),
  });
}

/** Cancels a running Colab CLI install by operation id. */
export function cancelCliInstall(
  id: number,
  signal?: AbortSignal,
  client: ApiClient = apiClient,
): Promise<void> {
  return client.request<void>(`/api/overview/cli/install/${id}/cancel`, {
    method: "POST",
    body: {},
    signal,
  });
}

/** Formats a structured server error payload emitted inside an SSE `finished` frame or status view. */
export function formatInstallErrorPayload(
  payload: ApiErrorPayload | null,
  t: TranslateFn,
): FormattedApiError {
  if (payload === null) {
    return { message: t("app.err.install_failed"), hint: null };
  }
  return formatApiError(
    new ApiError({
      status: 500,
      kind: payload.kind,
      messageKey: payload.message_key,
      args: payload.args,
      hintKey: payload.hint_key,
      actionKey: payload.action_key,
      operationId: payload.operation_id,
    }),
    t,
  );
}

/** Finds an active `install_cli` server operation in the live SSE snapshot. */
export function findRunningInstallOp(snapshot: Snapshot | null): PendingOperation | null {
  if (snapshot === null) {
    return null;
  }
  return (
    snapshot.operations.find(
      (pending) =>
        pending.operation.kind === "domain" && pending.operation.name === "install_cli",
    ) ?? null
  );
}

/** Translates an install method into its localized label. */
export function formatInstallMethod(method: InstallMethod, t: TranslateFn): string {
  return t(INSTALL_METHOD_KEYS[method]);
}

/** Resolves the offered CLI install methods, falling back to the default uv bootstrap. */
export function resolveInstallMethods(overview: OverviewResponse | null): readonly InstallMethod[] {
  if (overview !== null && overview.install_methods.length > 0) {
    return overview.install_methods;
  }
  return ["install_uv_then_cli"];
}

/**
 * Filters Overview quick-deploy plugins to enabled bundled plugins only,
 * matching upstream `AppState::quick_deploys()`.
 */
export function selectQuickDeployPlugins(
  plugins: readonly PluginInfo[],
): readonly PluginInfo[] {
  return plugins.filter((plugin) => plugin.enabled && plugin.source.kind === "bundled");
}

/**
 * Derives the ordered three-step readiness checklist state (`host`, `cli`, `signin`)
 * matching upstream `crates/app/src/state/environment.rs::checklist`.
 */
export function deriveChecklist(
  overview: OverviewResponse | null,
  probeError: FormattedApiError | null,
  _probing: boolean,
  options: DeriveChecklistOptions = {},
): ChecklistModel {
  const probeErrorKind = options.probeErrorKind ?? null;
  const installing = options.installing === true;

  if (overview === null) {
    if (probeErrorKind === "not_installed") {
      return {
        complete: false,
        hostStatus: "done",
        cliStatus: "todo",
        signinStatus: "waiting",
      };
    }
    if (installing) {
      return {
        complete: false,
        hostStatus: "checking",
        cliStatus: "todo",
        signinStatus: "waiting",
      };
    }
    return {
      complete: false,
      hostStatus: probeError !== null ? "failed" : "checking",
      cliStatus: "waiting",
      signinStatus: "waiting",
    };
  }

  const hostStatus: ChecklistStepStatus = overview.host.ready ? "done" : "todo";
  const cliInstalled = probeErrorKind === "not_installed" ? false : overview.cli_installed;
  const cliStatus: ChecklistStepStatus =
    hostStatus !== "done" ? "waiting" : cliInstalled ? "done" : "todo";

  let signinStatus: ChecklistStepStatus;
  if (cliStatus !== "done") {
    signinStatus = "waiting";
  } else if (overview.accounts_error !== null) {
    signinStatus = "failed";
  } else if (overview.accounts !== null) {
    signinStatus = overview.accounts.active !== null ? "done" : "todo";
  } else if (overview.keyring.status === "unavailable") {
    signinStatus = "failed";
  } else {
    signinStatus = "checking";
  }

  return {
    complete: hostStatus === "done" && cliStatus === "done" && signinStatus === "done",
    hostStatus,
    cliStatus,
    signinStatus,
  };
}

/**
 * Summarizes running runtimes across all saved accounts without treating
 * unknown usage as zero, matching desktop `overview.rs`.
 */
export function summarizeCrossAccountRuntimes(
  accountsView: AccountsView | null,
  usageViews: readonly AccountUsageView[],
  t: TranslateFn,
): OverviewRuntimesSummary {
  if (accountsView === null) {
    return {
      known: 0,
      totalRuntimes: 0,
      incomplete: false,
      uncountedNote: null,
    };
  }

  const usageByAccount = new Map<AccountId, AccountUsageView>();
  for (const item of usageViews) {
    usageByAccount.set(item.account, item);
  }

  let known = 0;
  let totalRuntimes = 0;
  const uncountedEmails: (string | null)[] = [];

  for (const account of accountsView.accounts) {
    const usage = usageByAccount.get(account.id) ?? null;
    const snap = usage?.snapshot ?? account.usage ?? null;
    if (snap !== null) {
      known += 1;
      totalRuntimes += snap.assignments;
    } else {
      uncountedEmails.push(account.email ?? usage?.email ?? null);
    }
  }

  const incomplete = known > 0 && uncountedEmails.length > 0;
  if (!incomplete) {
    return {
      known,
      totalRuntimes,
      incomplete: false,
      uncountedNote: null,
    };
  }

  const allNamed = uncountedEmails.every((email): email is string => email !== null && email !== "");
  let uncountedNote: string;
  if (allNamed && uncountedEmails.length <= MAX_UNCOUNTED_EMAILS) {
    uncountedNote = t("app.b10.summary_not_counted", {
      emails: uncountedEmails.join(t("app.fmt.list_separator")),
    });
  } else if (uncountedEmails.length === 1) {
    uncountedNote = t("app.accounts.total.missing_one");
  } else {
    uncountedNote = t("app.accounts.total.missing_many", { count: uncountedEmails.length });
  }

  return {
    known,
    totalRuntimes,
    incomplete: true,
    uncountedNote,
  };
}

function buildUnmanagedWarningFromRuntimes(
  snapshot: Snapshot,
  accountsView: AccountsView | null,
  t: TranslateFn,
): UnmanagedWarningView | null {
  const runtimes = snapshot.runtimes?.runtimes ?? [];
  const countsByAccount = new Map<AccountId, { email: string; count: number }>();

  for (const runtime of runtimes) {
    if (runtime.managed) {
      continue;
    }
    const existing = countsByAccount.get(runtime.id.account);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const accountEmail =
      runtime.account_email ??
      accountsView?.accounts.find((account) => account.id === runtime.id.account)?.email ??
      t("app.accounts.no_email");
    countsByAccount.set(runtime.id.account, { email: accountEmail, count: 1 });
  }

  if (countsByAccount.size === 0) {
    return null;
  }

  const lines: string[] = [];
  for (const { email, count } of countsByAccount.values()) {
    lines.push(
      count === 1 ? t("app.unmanaged.one", { email }) : t("app.unmanaged.many", { count, email }),
    );
  }
  return {
    title: t("app.unmanaged.title"),
    body: lines.join("\n"),
  };
}

/**
 * Builds the unmanaged-runtime warning for both ready and checklist states from
 * live SSE snapshot data once available, falling back to `/api/overview`'s
 * initial summary only before live runtime data arrives so stopping a runtime
 * clears it immediately.
 */
export function buildOverviewUnmanagedWarning(
  accountsView: AccountsView | null,
  snapshot: Snapshot | null,
  overviewUnmanaged: UnmanagedRuntimes | null,
  nowSecs: number,
  t: TranslateFn,
): UnmanagedWarningView | null {
  if (snapshot !== null) {
    let primary: UnmanagedWarningView | null = null;
    if (accountsView !== null) {
      const rows = buildAccountRows(accountsView, snapshot, nowSecs, t);
      primary = buildUnmanagedWarning(rows, t);
    }
    if (primary === null && snapshot.runtimes !== null) {
      primary = buildUnmanagedWarningFromRuntimes(snapshot, accountsView, t);
    }

    const liveIncomplete =
      snapshot.runtimes_error !== null ||
      (snapshot.runtimes !== null && snapshot.runtimes.errors.length > 0);

    if (primary !== null) {
      if (liveIncomplete) {
        const extra = t("web.runtimes.unmanaged_unknown");
        if (extra && !primary.body.includes(extra)) {
          return {
            title: primary.title,
            body: `${primary.body}\n${extra}`,
          };
        }
      }
      return primary;
    }

    if (liveIncomplete) {
      return {
        title: t("app.unmanaged.unknown_title"),
        body: t("web.runtimes.unmanaged_unknown"),
      };
    }

    if (snapshot.runtimes !== null) {
      return null;
    }
  }

  if (overviewUnmanaged === null || overviewUnmanaged.warning_key === null) {
    return null;
  }

  const body =
    overviewUnmanaged.count !== null
      ? t(overviewUnmanaged.warning_key, { count: overviewUnmanaged.count })
      : t(overviewUnmanaged.warning_key);
  if (!body) {
    return null;
  }
  const title =
    overviewUnmanaged.count === null ? t("app.unmanaged.unknown_title") : t("app.unmanaged.title");
  return { title, body };
}
