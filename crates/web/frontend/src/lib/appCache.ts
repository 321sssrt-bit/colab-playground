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
import { i18nStore, type TranslateFn } from "./i18n.ts";
import { webStore, type WebStore } from "./store.ts";
import { toastStore, type ToastStore } from "./toast.ts";
import type {
  Account,
  AccountError,
  AccountFailureResponse,
  AccountsApiResponse,
  OverviewResponse,
  SessionsListResponse,
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

  const cliInstalled =
    snapshot.accounts_error === "not_installed"
      ? false
      : overview.cli_installed || snapshot.accounts !== null || snapshot.runtimes !== null;
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

export interface AppDataState {
  readonly overview: OverviewResponse | null;
  readonly overviewLoading: boolean;
  readonly overviewError: unknown | null;
  readonly sessionsRefreshing: boolean;
  readonly sessionsError: unknown | null;
  readonly sessionsAccountErrors: readonly AccountFailureResponse[] | null;
  readonly refreshingUsage: boolean;
  readonly usageRefreshError: unknown | null;
  readonly adopting: boolean;
  readonly adoptError: unknown | null;
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
  sessionsRefreshing: false,
  sessionsError: null,
  sessionsAccountErrors: null,
  refreshingUsage: false,
  usageRefreshError: null,
  adopting: false,
  adoptError: null,
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

  let overviewInFlight: InFlightRequest<OverviewResponse> | null = null;
  let sessionsInFlight: InFlightRequest<SessionsListResponse> | null = null;
  let usageInFlight: InFlightRequest<AccountsApiResponse> | null = null;
  let adoptInFlight: InFlightRequest<Account> | null = null;

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
      next.sessionsRefreshing === state.sessionsRefreshing &&
      next.sessionsError === state.sessionsError &&
      next.sessionsAccountErrors === state.sessionsAccountErrors &&
      next.refreshingUsage === state.refreshingUsage &&
      next.usageRefreshError === state.usageRefreshError &&
      next.adopting === state.adopting &&
      next.adoptError === state.adoptError
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
  };

  const reset = (): void => {
    abortAllInFlight();
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
    const clearSessionsErrors =
      state.sessionsAccountErrors !== null &&
      snapshot.runtimes !== null &&
      !accountErrorsMatch(state.sessionsAccountErrors, snapshot.runtimes.errors);
    const clearAdoptError =
      state.adoptError !== null && snapshot.accounts !== null && !snapshot.accounts.unadopted;
    if (clearSessionsErrors || clearAdoptError) {
      setState({
        ...(clearSessionsErrors ? { sessionsAccountErrors: null } : {}),
        ...(clearAdoptError ? { adoptError: null } : {}),
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
      .then((response) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          clock.sync(response.sampled_at);
          setState({
            sessionsRefreshing: false,
            sessionsError: null,
            sessionsAccountErrors: response.errors.length > 0 ? response.errors : null,
          });
          void store.refreshSnapshot().catch(() => {});
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
        const afterOverview = store.getState().snapshot;
        if (afterOverview !== null && afterOverview.runtimes !== null) {
          return null;
        }
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
      }
      return refreshSessions(signal);
    },

    refreshSessions,
    refreshUsage,
    adoptAccount,

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
