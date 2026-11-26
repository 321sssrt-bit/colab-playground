/**
 * Application-level global data cache, in-flight request deduplication,
 * cross-route account action execution (usage refresh & adoption), and
 * `Slot::Exclusive` conflict detection.
 *
 * Keeps Overview probes, Sessions listings, and account mutations alive across
 * route switches and React StrictMode remounts so navigating between pages never
 * re-fires heavy backend probes or drops in-flight completion feedback.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, attachAbortSignal, type ApiClient } from "./api.ts";
import { serverClock, type ServerClock } from "./clock.ts";
import {
  CORE_DEFAULTS,
  MIN_CONCURRENT_SESSIONS,
  START_MAX_RUNTIME_SECS,
} from "./constants.ts";
import { i18nStore, type TranslateFn } from "./i18n.ts";
import { webStore, type WebStore } from "./store.ts";
import { toastStore, type ToastStore } from "./toast.ts";
import type {
  Account,
  AccountError,
  AccountFailureResponse,
  AccountsApiResponse,
  ErrorKind,
  OverviewResponse,
  SessionsListResponse,
  SettingsView,
  Snapshot,
} from "./types.ts";

/**
 * Domain operations that acquire `Slot::Shared` or `Slot::Exclusive` on the
 * backend and therefore conflict with `Slot::Exclusive` account mutations.
 */
const ACCOUNT_CHANGE_BLOCKING_DOMAIN_OPS: ReadonlySet<string> = new Set([
  "adopt_account",
  "remove_account",
  "install_cli",
  "stop_all_runtimes",
  "stop_runtime",
  "auto_stop",
  "open_forward",
]);

/**
 * Returns true when an account mutation (`switch_account`, `adopt_account`,
 * `remove_account`, or `begin_login`) would collide with an active OAuth prompt,
 * any `Slot::Shared` / `Slot::Exclusive` backend job published in `snapshot.operations`,
 * or a client-initiated `Slot::Shared` / `Slot::Exclusive` request currently in flight
 * in `appDataStore` (such as usage refresh, overview probe, or sessions list).
 */
export function isAccountChangeBlocked(
  snapshot: Snapshot | null,
  appData?: Pick<
    AppDataState,
    "overviewLoading" | "sessionsRefreshing" | "refreshingUsage" | "adopting"
  > | null,
): boolean {
  if (
    appData &&
    (appData.overviewLoading ||
      appData.sessionsRefreshing ||
      appData.refreshingUsage ||
      appData.adopting)
  ) {
    return true;
  }
  if (snapshot === null) {
    return false;
  }
  if (snapshot.login_id !== null) {
    return true;
  }
  return snapshot.operations.some((pending) => {
    const op = pending.operation;
    return (
      op.kind === "provision" ||
      op.kind === "plugin_run" ||
      op.kind === "switch_account" ||
      op.kind === "login" ||
      (op.kind === "domain" && ACCOUNT_CHANGE_BLOCKING_DOMAIN_OPS.has(op.name))
    );
  });
}

function accountErrorsMatch(
  override: readonly AccountFailureResponse[],
  snapshotErrors: readonly AccountError[],
): boolean {
  if (override.length !== snapshotErrors.length) {
    return false;
  }
  const byAccount = new Map<string, string>();
  for (const item of override) {
    byAccount.set(item.account, item.error.kind);
  }
  for (const item of snapshotErrors) {
    if (byAccount.get(item.account) !== item.error.kind) {
      return false;
    }
  }
  return true;
}

/**
 * Account error kinds that the backend can only report after the Colab CLI is
 * installed and invoked (never transient lock/shutdown/host-missing errors).
 */
const CLI_INSTALLED_ACCOUNT_ERRORS: ReadonlySet<ErrorKind> = new Set([
  "keyring_unavailable",
  "auth_required",
  "no_active_account",
  "active_account_not_adopted",
  "legacy_token_present",
  "add_in_progress",
]);

/**
 * Infers live CLI installation state directly from the latest SSE `Snapshot`.
 * Returns `null` when the snapshot does not carry definitive evidence either way
 * (e.g. cold-start empty snapshot or transient `busy` / `cancelled` / `wsl_unavailable` error).
 */
export function isCliInstalledFromSnapshot(snapshot: Snapshot | null): boolean | null {
  if (snapshot === null) {
    return null;
  }
  if (snapshot.accounts_error === "not_installed") {
    return false;
  }
  if (snapshot.accounts !== null || snapshot.runtimes !== null) {
    return true;
  }
  if (
    snapshot.accounts_error !== null &&
    CLI_INSTALLED_ACCOUNT_ERRORS.has(snapshot.accounts_error)
  ) {
    return true;
  }
  return null;
}

/**
 * Overlays live SSE `Snapshot` account, usage, measured-rate, and keyring state
 * onto the cached `OverviewResponse` so Overview converges after sign-in,
 * switching, adoption, usage refresh, or keyring recovery without re-probing
 * `GET /api/overview`.
 */
export function resolveEffectiveOverview(
  overview: OverviewResponse | null,
  snapshot: Snapshot | null,
): OverviewResponse | null {
  if (overview === null || snapshot === null) {
    return overview;
  }
  const hasLiveState =
    snapshot.accounts !== null || snapshot.accounts_error !== null || snapshot.runtimes !== null;
  if (!hasLiveState) {
    return overview;
  }

  const liveCliInstalled = isCliInstalledFromSnapshot(snapshot);
  const cliInstalled = liveCliInstalled !== null ? liveCliInstalled : overview.cli_installed;
  const keyring =
    snapshot.accounts_error === "keyring_unavailable"
      ? {
          status: "unavailable" as const,
          hint_key: overview.keyring.hint_key,
        }
      : cliInstalled && snapshot.accounts !== null && snapshot.accounts_error === null
        ? {
            status: "ready" as const,
            hint_key: null,
          }
        : overview.keyring;

  return {
    ...overview,
    cli_installed: cliInstalled,
    keyring,
    accounts:
      snapshot.accounts_error !== null ? snapshot.accounts : (snapshot.accounts ?? overview.accounts),
    accounts_error: snapshot.accounts_error,
    usage: snapshot.usage,
    measured_rates: snapshot.measured_rates ?? overview.measured_rates,
    sampled_at: snapshot.server_now ?? overview.sampled_at,
  };
}

export interface SessionSettingsSummary {
  readonly rearmDurationSecs: number;
  readonly maxConcurrentSessions: number;
}

export interface SessionDefaultsInput {
  readonly max_runtime?: unknown;
  readonly max_concurrent_sessions?: unknown;
}

function extractSessionSettings(defaults?: SessionDefaultsInput | null): SessionSettingsSummary {
  const configuredRearm = defaults?.max_runtime;
  const rearmDurationSecs =
    typeof configuredRearm === "number" &&
    Number.isFinite(configuredRearm) &&
    configuredRearm > 0
      ? Math.floor(configuredRearm)
      : START_MAX_RUNTIME_SECS;
  const configuredMaxConcurrent = defaults?.max_concurrent_sessions;
  const maxConcurrentSessions =
    typeof configuredMaxConcurrent === "number" &&
    Number.isFinite(configuredMaxConcurrent) &&
    configuredMaxConcurrent >= MIN_CONCURRENT_SESSIONS
      ? Math.floor(configuredMaxConcurrent)
      : CORE_DEFAULTS.max_concurrent_sessions;
  return { rearmDurationSecs, maxConcurrentSessions };
}

export interface AppDataState {
  readonly overview: OverviewResponse | null;
  readonly overviewLoading: boolean;
  readonly overviewError: unknown | null;
  readonly usesWsl: boolean | null;
  readonly usesWslResolved: boolean;
  readonly sessionsRefreshing: boolean;
  readonly sessionsError: unknown | null;
  readonly sessionsAccountErrors: readonly AccountFailureResponse[] | null;
  readonly refreshingUsage: boolean;
  readonly usageRefreshError: unknown | null;
  readonly adopting: boolean;
  readonly adoptError: unknown | null;
  readonly rearmDurationSecs: number;
  readonly maxConcurrentSessions: number;
}

export interface AppDataStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly clock?: ServerClock;
  readonly toast?: ToastStore;
  readonly t?: TranslateFn;
}

export interface AppDataStore {
  getState(): AppDataState;
  subscribe(listener: () => void): () => void;
  /** Returns cached Overview if present; otherwise deduplicates a single `GET /api/overview`. */
  ensureOverview(signal?: AbortSignal): Promise<OverviewResponse>;
  /** Forces a fresh deduplicated `GET /api/overview`, preserving existing cached data while loading. */
  refreshOverview(signal?: AbortSignal): Promise<OverviewResponse>;
  /** Pulls `GET /api/sessions` only when live `snapshot.runtimes` is not yet populated. */
  ensureSessions(signal?: AbortSignal): Promise<SessionsListResponse | null>;
  /** Forces a fresh deduplicated `GET /api/sessions`, syncing server clock and snapshot. */
  refreshSessions(signal?: AbortSignal): Promise<SessionsListResponse>;
  /** Runs deduplicated `POST /api/accounts/usage/refresh` without triggering `/api/overview`. */
  refreshUsage(signal?: AbortSignal): Promise<AccountsApiResponse>;
  /**
   * Adopts the active CLI account using the real backend `AccountContext`
   * (never fabricating `revision: 0`), surviving route unmounts to deliver the
   * completion toast and converge the snapshot.
   */
  adoptAccount(signal?: AbortSignal): Promise<Account>;
  /** Immediately syncs default auto-stop duration & concurrency limit after Settings saves. */
  applySessionDefaults(defaults?: SessionDefaultsInput | null): SessionSettingsSummary;
  /** Deduplicated `GET /api/settings` read that discards stale responses superseded by a save. */
  refreshSessionDefaults(signal?: AbortSignal): Promise<SessionSettingsSummary>;
  dispose(): void;
}

interface InFlightRequest<T> {
  readonly generation: number;
  readonly controller: AbortController;
  readonly promise: Promise<T>;
}

const INITIAL_STATE: AppDataState = {
  overview: null,
  overviewLoading: false,
  overviewError: null,
  usesWsl: null,
  usesWslResolved: false,
  sessionsRefreshing: false,
  sessionsError: null,
  sessionsAccountErrors: null,
  refreshingUsage: false,
  usageRefreshError: null,
  adopting: false,
  adoptError: null,
  rearmDurationSecs: START_MAX_RUNTIME_SECS,
  maxConcurrentSessions: CORE_DEFAULTS.max_concurrent_sessions,
};

/**
 * Creates an isolated application-level data cache and deduplicated action store.
 */
export function createAppDataStore(options: AppDataStoreOptions = {}): AppDataStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const clock = options.clock ?? serverClock;
  const toast = options.toast ?? toastStore;
  const t = options.t ?? i18nStore.t;

  let state: AppDataState = INITIAL_STATE;
  let disposed = false;
  let settingsSeq = 0;
  let prevRebuildingBackend = false;

  let overviewInFlight: InFlightRequest<OverviewResponse> | null = null;
  let sessionsInFlight: InFlightRequest<SessionsListResponse> | null = null;
  let usageInFlight: InFlightRequest<AccountsApiResponse> | null = null;
  let adoptInFlight: InFlightRequest<Account> | null = null;
  let settingsInFlight: InFlightRequest<SessionSettingsSummary> | null = null;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so all page consumers stay synchronized.
      }
    }
  };

  const setState = (patch: Partial<AppDataState>): void => {
    const next: AppDataState = { ...state, ...patch };
    if (
      next.overview === state.overview &&
      next.overviewLoading === state.overviewLoading &&
      next.overviewError === state.overviewError &&
      next.usesWsl === state.usesWsl &&
      next.usesWslResolved === state.usesWslResolved &&
      next.sessionsRefreshing === state.sessionsRefreshing &&
      next.sessionsError === state.sessionsError &&
      next.sessionsAccountErrors === state.sessionsAccountErrors &&
      next.refreshingUsage === state.refreshingUsage &&
      next.usageRefreshError === state.usageRefreshError &&
      next.adopting === state.adopting &&
      next.adoptError === state.adoptError &&
      next.rearmDurationSecs === state.rearmDurationSecs &&
      next.maxConcurrentSessions === state.maxConcurrentSessions
    ) {
      return;
    }
    state = next;
    emit();
  };

  const abortAllInFlight = (): void => {
    overviewInFlight?.controller.abort();
    overviewInFlight = null;
    sessionsInFlight?.controller.abort();
    sessionsInFlight = null;
    usageInFlight?.controller.abort();
    usageInFlight = null;
    adoptInFlight?.controller.abort();
    adoptInFlight = null;
    settingsInFlight?.controller.abort();
    settingsInFlight = null;
    settingsSeq += 1;
  };

  const reset = (): void => {
    abortAllInFlight();
    prevRebuildingBackend = false;
    setState(INITIAL_STATE);
  };

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (event.type === "logged_out" || event.type === "unauthorized" || event.type === "authenticated") {
      reset();
    }
  });

  const unsubscribeStore = store.subscribe(() => {
    if (disposed) {
      return;
    }
    const snapshot = store.getState().snapshot;
    if (!snapshot) {
      return;
    }
    const rebuildingBackend = snapshot.operations.some(
      ({ operation }) => operation.kind === "domain" && operation.name === "rebuild_backend",
    );
    const rebuildFinished = prevRebuildingBackend && !rebuildingBackend;
    prevRebuildingBackend = rebuildingBackend;

    const clearSessionsErrors =
      state.sessionsAccountErrors !== null &&
      snapshot.runtimes !== null &&
      !accountErrorsMatch(state.sessionsAccountErrors, snapshot.runtimes.errors);
    const clearAdoptError =
      state.adoptError !== null && snapshot.accounts !== null && !snapshot.accounts.unadopted;
    if (clearSessionsErrors || clearAdoptError || rebuildFinished) {
      if (rebuildFinished && overviewInFlight !== null) {
        overviewInFlight.controller.abort();
        overviewInFlight = null;
      }
      setState({
        ...(clearSessionsErrors ? { sessionsAccountErrors: null } : {}),
        ...(clearAdoptError ? { adoptError: null } : {}),
        // Host/WSL/CLI-path rebuild invalidates the cached probe so Overview re-probes the new backend.
        ...(rebuildFinished ? { overview: null, overviewLoading: false, overviewError: null } : {}),
      });
    }
  });

  const startOverviewFetch = (signal?: AbortSignal): Promise<OverviewResponse> => {
    const generation = client.getSessionGeneration();
    if (overviewInFlight !== null && overviewInFlight.generation === generation) {
      return attachAbortSignal(overviewInFlight.promise, signal);
    }
    const controller = new AbortController();
    setState({ overviewLoading: true, overviewError: null });
    const promise = client
      .request<OverviewResponse>("/api/overview", {
        method: "GET",
        signal: controller.signal,
      })
      .then((data) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          if (typeof data.sampled_at === "number") {
            clock.sync(data.sampled_at);
          }
          setState({
            overview: data,
            overviewLoading: false,
            overviewError: null,
            usesWsl: data.host.kind === "wsl",
            usesWslResolved: true,
          });
        }
        return data;
      })
      .catch((error: unknown) => {
        if (
          !disposed &&
          client.getSessionGeneration() === generation &&
          !(error instanceof ApiError && (error.isAbort || error.isUnauthorized))
        ) {
          setState({
            overviewLoading: false,
            overviewError: error,
          });
        } else if (!disposed && client.getSessionGeneration() === generation) {
          setState({ overviewLoading: false });
        }
        throw error;
      })
      .finally(() => {
        if (overviewInFlight?.promise === promise) {
          overviewInFlight = null;
        }
      });
    overviewInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const refreshSessions = (signal?: AbortSignal): Promise<SessionsListResponse> => {
    const generation = client.getSessionGeneration();
    if (sessionsInFlight !== null && sessionsInFlight.generation === generation) {
      return attachAbortSignal(sessionsInFlight.promise, signal);
    }
    const controller = new AbortController();
    setState({ sessionsRefreshing: true });
    const promise = client
      .request<SessionsListResponse>("/api/sessions", {
        method: "GET",
        signal: controller.signal,
      })
      .then(async (response) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          clock.sync(response.sampled_at);
          let latestSnapshot = store.getState().snapshot;
          try {
            latestSnapshot = await store.refreshSnapshot(controller.signal);
          } catch {
            latestSnapshot = store.getState().snapshot;
          }
          if (!disposed && client.getSessionGeneration() === generation) {
            const keepAccountErrors =
              response.errors.length > 0 &&
              (latestSnapshot === null ||
                latestSnapshot.runtimes === null ||
                accountErrorsMatch(response.errors, latestSnapshot.runtimes.errors));
            setState({
              sessionsRefreshing: false,
              sessionsError: null,
              sessionsAccountErrors: keepAccountErrors ? response.errors : null,
            });
          }
        }
        return response;
      })
      .catch((error: unknown) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
            setState({ sessionsRefreshing: false });
          } else {
            setState({
              sessionsRefreshing: false,
              sessionsError: error,
            });
          }
        }
        throw error;
      })
      .finally(() => {
        if (sessionsInFlight?.promise === promise) {
          sessionsInFlight = null;
        }
      });
    sessionsInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const refreshUsage = (signal?: AbortSignal): Promise<AccountsApiResponse> => {
    const generation = client.getSessionGeneration();
    if (usageInFlight !== null && usageInFlight.generation === generation) {
      return attachAbortSignal(usageInFlight.promise, signal);
    }
    const controller = new AbortController();
    setState({ refreshingUsage: true, usageRefreshError: null });
    const promise = client
      .request<AccountsApiResponse>("/api/accounts/usage/refresh", {
        method: "POST",
        body: {},
        signal: controller.signal,
      })
      .then((response) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          if (typeof response.sampled_at === "number") {
            clock.sync(response.sampled_at);
          }
          setState({
            refreshingUsage: false,
            usageRefreshError: null,
          });
          void store.refreshSnapshot().catch(() => {});
        }
        return response;
      })
      .catch((error: unknown) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
            setState({ refreshingUsage: false });
          } else {
            setState({
              refreshingUsage: false,
              usageRefreshError: error,
            });
          }
        }
        throw error;
      })
      .finally(() => {
        if (usageInFlight?.promise === promise) {
          usageInFlight = null;
        }
      });
    usageInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const adoptAccount = (signal?: AbortSignal): Promise<Account> => {
    const generation = client.getSessionGeneration();
    if (adoptInFlight !== null && adoptInFlight.generation === generation) {
      return attachAbortSignal(adoptInFlight.promise, signal);
    }
    const controller = new AbortController();
    setState({ adopting: true, adoptError: null });
    const promise = (async (): Promise<Account> => {
      let currentSnapshot = store.getState().snapshot;
      if (currentSnapshot === null || currentSnapshot.accounts === null) {
        currentSnapshot = await store.refreshSnapshot(controller.signal);
      }
      if (disposed || client.getSessionGeneration() !== generation) {
        throw new ApiError({
          status: 0,
          kind: "cancelled",
          message: "adopt cancelled by session transition",
          isAbort: true,
        });
      }
      const adopted = await client.request<Account>("/api/accounts/adopt", {
        method: "POST",
        body: { account_context: currentSnapshot.account },
        signal: controller.signal,
      });
      if (!disposed && client.getSessionGeneration() === generation) {
        const email = adopted.email ?? t("app.accounts.no_email");
        toast.push({
          tone: "success",
          body: t("app.adopt.done", { email }),
        });
        setState({ adopting: false, adoptError: null });
        void store.refreshSnapshot().catch(() => {});
      }
      return adopted;
    })()
      .catch((error: unknown) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
            setState({ adopting: false });
          } else {
            setState({ adopting: false, adoptError: error });
          }
        }
        throw error;
      })
      .finally(() => {
        if (adoptInFlight?.promise === promise) {
          adoptInFlight = null;
        }
      });
    adoptInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const applySessionDefaults = (
    defaults?: SessionDefaultsInput | null,
  ): SessionSettingsSummary => {
    settingsSeq += 1;
    settingsInFlight?.controller.abort();
    settingsInFlight = null;
    const summary = extractSessionSettings(defaults);
    if (!disposed) {
      setState(summary);
    }
    return summary;
  };

  const refreshSessionDefaults = (signal?: AbortSignal): Promise<SessionSettingsSummary> => {
    const generation = client.getSessionGeneration();
    if (settingsInFlight !== null && settingsInFlight.generation === generation) {
      return attachAbortSignal(settingsInFlight.promise, signal);
    }
    const seq = settingsSeq;
    const controller = new AbortController();
    const promise = client
      .request<SettingsView>("/api/settings", {
        method: "GET",
        signal: controller.signal,
      })
      .then((settings) => {
        if (!disposed && client.getSessionGeneration() === generation && seq === settingsSeq) {
          const summary = extractSessionSettings(settings.defaults);
          setState({
            ...summary,
            usesWslResolved: true,
            ...(typeof settings.uses_wsl === "boolean" ? { usesWsl: settings.uses_wsl } : {}),
          });
          return summary;
        }
        return {
          rearmDurationSecs: state.rearmDurationSecs,
          maxConcurrentSessions: state.maxConcurrentSessions,
        };
      })
      .catch(() => {
        if (!disposed && client.getSessionGeneration() === generation && seq === settingsSeq) {
          setState({ usesWslResolved: true });
        }
        return {
          rearmDurationSecs: state.rearmDurationSecs,
          maxConcurrentSessions: state.maxConcurrentSessions,
        };
      })
      .finally(() => {
        if (settingsInFlight?.promise === promise) {
          settingsInFlight = null;
        }
      });
    settingsInFlight = { generation, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  return {
    getState(): AppDataState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ensureOverview(signal?: AbortSignal): Promise<OverviewResponse> {
      if (state.overview !== null) {
        return Promise.resolve(state.overview);
      }
      return startOverviewFetch(signal);
    },

    refreshOverview(signal?: AbortSignal): Promise<OverviewResponse> {
      return startOverviewFetch(signal);
    },

    async ensureSessions(signal?: AbortSignal): Promise<SessionsListResponse | null> {
      const generation = client.getSessionGeneration();
      const snapshot = store.getState().snapshot;
      if (snapshot !== null && snapshot.runtimes !== null) {
        return null;
      }
      if (overviewInFlight !== null && overviewInFlight.generation === generation) {
        try {
          await attachAbortSignal(overviewInFlight.promise, signal);
        } catch (error: unknown) {
          if (error instanceof ApiError && error.isAbort) {
            throw error;
          }
          // Fall through to inspect the live snapshot if the overview probe failed.
        }
        if (disposed || client.getSessionGeneration() !== generation) {
          return null;
        }
      }
      const current = store.getState().snapshot;
      if (current !== null && current.runtimes !== null) {
        return null;
      }
      if (state.overview !== null) {
        try {
          const fresh = await store.refreshSnapshot(signal);
          if (fresh.runtimes !== null) {
            return null;
          }
        } catch (error: unknown) {
          if (error instanceof ApiError && error.isAbort) {
            throw error;
          }
        }
        if (disposed || client.getSessionGeneration() !== generation) {
          return null;
        }
      }
      return refreshSessions(signal);
    },

    refreshSessions,
    refreshUsage,
    adoptAccount,
    applySessionDefaults,
    refreshSessionDefaults,

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      unsubscribeStore();
      abortAllInFlight();
      listeners.clear();
    },
  };
}

/** Shared global data cache and deduplicated action store. */
export const appDataStore: AppDataStore = createAppDataStore();

/** React hook subscribing a component to the global data cache. */
export function useAppDataStore(store: AppDataStore = appDataStore): AppDataState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
