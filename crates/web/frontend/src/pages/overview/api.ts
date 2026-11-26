/**
 * Overview wire adapters, streaming CLI installer client, checklist state
 * derivation, and ready-state summary helpers.
 */

import { apiClient, ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { SseFrame } from "../../lib/sse.ts";
import type {
  AccountId,
  AccountsView,
  AccountUsageView,
  ApiErrorPayload,
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

export type {
  ForwardPolicyView,
  InstallMethod,
  OverviewResponse,
  ProbeReport,
  UnmanagedRuntimes,
};

export interface InstallLine {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export type InstallFinishedStatus = "succeeded" | "cancelled" | "failed";

export interface InstallFinishedEvent {
  readonly status: InstallFinishedStatus;
  readonly error: ApiErrorPayload | null;
}

export interface InstallStreamCallbacks {
  readonly signal?: AbortSignal;
  readonly onStarted?: (id: number) => void;
  readonly onLine?: (line: InstallLine) => void;
  readonly onFinished?: (event: InstallFinishedEvent) => void;
}

export type ChecklistStepStatus = "checking" | "done" | "todo" | "waiting" | "failed";

export interface ChecklistModel {
  readonly complete: boolean;
  readonly hostStatus: ChecklistStepStatus;
  readonly cliStatus: ChecklistStepStatus;
  readonly keyringStatus: ChecklistStepStatus;
  readonly signinStatus: ChecklistStepStatus;
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

const ANSI_ESCAPE_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    callbacks.onStarted?.(raw.id);
    return;
  }
  if (frame.event === "line" && typeof raw.text === "string") {
    const stream = raw.stream === "stderr" ? "stderr" : "stdout";
    callbacks.onLine?.({ stream, text: stripAnsi(raw.text) });
    return;
  }
  if (
    frame.event === "finished" &&
    (raw.status === "succeeded" || raw.status === "cancelled" || raw.status === "failed")
  ) {
    callbacks.onFinished?.({
      status: raw.status,
      error: parseErrorPayload(raw.error),
    });
  }
}

/**
 * Strips ANSI terminal control sequences so streamed CLI installer output
 * renders cleanly as plain text lines.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

/** Starts a streaming Colab CLI install via `POST /api/overview/cli/install`. */
export function startCliInstallStream(
  method: InstallMethod,
  callbacks: InstallStreamCallbacks,
): Promise<void> {
  return apiClient.openEventStream("/api/overview/cli/install", {
    body: { method },
    signal: callbacks.signal,
    onFrame: (frame) => parseInstallFrame(frame, callbacks),
  });
}

/** Cancels a running Colab CLI install by operation id. */
export function cancelCliInstall(id: number, signal?: AbortSignal): Promise<void> {
  return apiClient.request<void>(`/api/overview/cli/install/${id}/cancel`, {
    method: "POST",
    body: {},
    signal,
  });
}

/** Formats a structured server error payload emitted inside an SSE `finished` frame. */
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

/** Derives the ordered four-step readiness checklist state from the latest overview probe. */
export function deriveChecklist(
  overview: OverviewResponse | null,
  probeError: FormattedApiError | null,
  probing: boolean,
  installing = false,
): ChecklistModel {
  if (overview === null) {
    if (installing) {
      return {
        complete: false,
        hostStatus: "checking",
        cliStatus: "checking",
        keyringStatus: "waiting",
        signinStatus: "waiting",
      };
    }
    return {
      complete: false,
      hostStatus: probeError !== null ? "failed" : "checking",
      cliStatus: "waiting",
      keyringStatus: "waiting",
      signinStatus: "waiting",
    };
  }

  const hostStatus: ChecklistStepStatus = overview.host.ready ? "done" : "todo";
  const cliStatus: ChecklistStepStatus =
    hostStatus !== "done" ? "waiting" : overview.cli_installed ? "done" : "todo";

  let keyringStatus: ChecklistStepStatus;
  if (cliStatus !== "done") {
    keyringStatus = "waiting";
  } else if (
    overview.keyring.status === "unavailable" ||
    overview.accounts_error === "keyring_unavailable"
  ) {
    keyringStatus = "failed";
  } else if (overview.keyring.status === "ready") {
    keyringStatus = "done";
  } else if (!overview.helper_available) {
    keyringStatus = "failed";
  } else if (overview.accounts_error !== null) {
    keyringStatus = "waiting";
  } else {
    keyringStatus = probing ? "checking" : "todo";
  }

  let signinStatus: ChecklistStepStatus;
  if (cliStatus !== "done" || keyringStatus === "failed") {
    signinStatus = "waiting";
  } else if (overview.accounts_error !== null) {
    signinStatus = "failed";
  } else if (keyringStatus !== "done") {
    signinStatus = "waiting";
  } else if (overview.accounts?.active !== null && overview.accounts?.active !== undefined) {
    signinStatus = "done";
  } else {
    signinStatus = "todo";
  }

  return {
    complete:
      hostStatus === "done" &&
      cliStatus === "done" &&
      keyringStatus === "done" &&
      signinStatus === "done",
    hostStatus,
    cliStatus,
    keyringStatus,
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

/**
 * Builds the unmanaged-runtime warning from live SSE snapshot data once
 * available, falling back to `/api/overview`'s initial summary only before the
 * first snapshot arrives so stopping a runtime elsewhere clears it immediately.
 */
export function buildOverviewUnmanagedWarning(
  accountsView: AccountsView | null,
  snapshot: Snapshot | null,
  overviewUnmanaged: UnmanagedRuntimes | null,
  nowSecs: number,
  t: TranslateFn,
): UnmanagedWarningView | null {
  if (snapshot !== null && accountsView !== null) {
    const rows = buildAccountRows(accountsView, snapshot, nowSecs, t);
    const primary = buildUnmanagedWarning(rows, t);
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
    return null;
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
