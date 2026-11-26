/**
 * Global application-scope controller for `AddAccountDialog`,
 * `RemoveAccountDialog`, and one-shot `recovered_pending_add` dismissal.
 *
 * Keeps OAuth sign-in, backend cancellation/rollback settlement, and saved
 * account removal alive across route transitions, and exposes `openAddAccountDialog`
 * so any route (such as Overview's Sign in step) can open the sign-in flow in place.
 */

import { useSyncExternalStore } from "react";

import { apiClient, ApiError, type ApiClient } from "./api.ts";
import { appDataStore, isAccountChangeBlocked, type AppDataStore } from "./appCache.ts";
import { i18nStore, type TranslateFn } from "./i18n.ts";
import { webStore, type WebStore } from "./store.ts";
import { toastStore, type ToastStore } from "./toast.ts";
import type { Snapshot } from "./types.ts";
import {
  beginAccountLogin,
  cancelAccountLogin,
  dismissRecoveredPendingAdd,
  findActiveServerLoginId,
  formatApiError,
  formatApiErrorPayload,
  getAccountRemoveBlock,
  removeSavedAccount,
  submitAccountLoginCode,
  type FormattedApiError,
  type RemoveTarget,
} from "../pages/accounts/model.ts";

export type AddPhase =
  | { readonly kind: "intro" }
  | { readonly kind: "other_active"; readonly loginId: number }
  | { readonly kind: "starting" }
  | { readonly kind: "code"; readonly loginId: number; readonly authUrl: string }
  | { readonly kind: "submitting"; readonly loginId: number; readonly authUrl: string }
  | { readonly kind: "cancelling"; readonly reopenIntroAfter: boolean }
  | { readonly kind: "expired" }
  | {
      readonly kind: "failed";
      readonly error: FormattedApiError;
      readonly rolledBack: boolean;
      readonly busyConflict?: boolean;
    };

export interface AddAccountDialogState {
  readonly open: boolean;
  readonly openSeq: number;
  readonly phase: AddPhase;
}

export interface RemoveAccountDialogState {
  readonly target: RemoveTarget | null;
  readonly openSeq: number;
  readonly removing: boolean;
  readonly error: FormattedApiError | null;
}

export interface AccountDialogsState {
  readonly add: AddAccountDialogState;
  readonly remove: RemoveAccountDialogState;
  readonly recoveredDismissed: boolean;
}

export interface AccountDialogsStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
  readonly appData?: Pick<AppDataStore, "getState">;
  readonly toast?: Pick<ToastStore, "push">;
  readonly t?: TranslateFn;
}

export interface AccountDialogsStore {
  getState(): AccountDialogsState;
  subscribe(listener: () => void): () => void;
  /** Opens the global OAuth sign-in dialog from any route. */
  openAddAccount(): void;
  /** Starts `POST /api/accounts/login` from intro, failed, or expired phase. */
  startAddLogin(): Promise<void>;
  /** Submits the pasted OAuth authorization code. */
  submitAddLoginCode(code: string): Promise<void>;
  /** Cancels an active sign-in from another tab and returns to intro. */
  cancelExistingLogin(): Promise<void>;
  /** Cancels or closes the add-account dialog (disabled during submitting/cancelling). */
  cancelOrCloseAddAccount(): void;
  /** Opens the global saved-account removal confirmation dialog. */
  openRemoveAccount(target: RemoveTarget): void;
  /** Closes the remove-account dialog when not mid-request. */
  closeRemoveAccount(): void;
  /** Executes `DELETE /api/accounts/{id}`, surviving route transitions to deliver feedback. */
  confirmRemoveAccount(): Promise<void>;
  /** Dismisses the server-latched `recovered_pending_add` notice via `POST /api/accounts/recovered/dismiss`. */
  dismissRecoveredPendingAdd(): Promise<void>;
  dispose(): void;
}

const INITIAL_ADD_STATE: AddAccountDialogState = {
  open: false,
  openSeq: 0,
  phase: { kind: "intro" },
};

const INITIAL_REMOVE_STATE: RemoveAccountDialogState = {
  target: null,
  openSeq: 0,
  removing: false,
  error: null,
};

const INITIAL_STATE: AccountDialogsState = {
  add: INITIAL_ADD_STATE,
  remove: INITIAL_REMOVE_STATE,
  recoveredDismissed: false,
};

function isLoginOpRunningFor(snapshot: Snapshot, loginId: number): boolean {
  return snapshot.operations.some(
    (pending) =>
      pending.operation.kind === "login" &&
      (pending.operation.login_id === undefined || pending.operation.login_id === loginId),
  );
}

function isTransportUnknownError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.kind === "connection_lost";
}

interface PendingSubmitRecovery {
  readonly seq: number;
  readonly loginId: number;
  readonly preAccountIds: ReadonlySet<string>;
  readonly preActive: string | null;
  readonly error: unknown;
}

/**
 * Creates an isolated application-level store for account dialogs and recovery
 * notice dismissal.
 */
export function createAccountDialogsStore(
  options: AccountDialogsStoreOptions = {},
): AccountDialogsStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;
  const appData = options.appData ?? appDataStore;
  const toast = options.toast ?? toastStore;
  const t = options.t ?? i18nStore.t;

  let state: AccountDialogsState = INITIAL_STATE;
  let disposed = false;

  let loginSeq = 0;
  let postBeginVersion: number | null = null;
  let cancelStartRequested = false;
  let cancelInFlight = false;
  let pendingSubmitRecovery: PendingSubmitRecovery | null = null;
  let addController: AbortController | null = null;
  let cancelController: AbortController | null = null;
  let syncController: AbortController | null = null;

  let removeSeq = 0;
  let removeController: AbortController | null = null;

  let dismissRecoveredInFlight = false;
  let dismissRecoveredController: AbortController | null = null;

  let prevConnectionStatus = store.getState().connectionStatus;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all dialog renderers remain synchronized.
      }
    }
  };

  const setState = (next: AccountDialogsState): void => {
    if (
      next.add === state.add &&
      next.remove === state.remove &&
      next.recoveredDismissed === state.recoveredDismissed
    ) {
      return;
    }
    state = next;
    emit();
  };

  const setAddPhase = (phase: AddPhase): void => {
    setState({
      ...state,
      add: {
        ...state.add,
        phase,
      },
    });
  };

  const abortAddControllers = (): void => {
    addController?.abort();
    addController = null;
    cancelController?.abort();
    cancelController = null;
    syncController?.abort();
    syncController = null;
  };

  const closeAddDialogInternal = (): void => {
    loginSeq += 1;
    postBeginVersion = null;
    cancelStartRequested = false;
    cancelInFlight = false;
    pendingSubmitRecovery = null;
    abortAddControllers();
    if (!state.add.open) {
      return;
    }
    setState({
      ...state,
      add: {
        ...state.add,
        open: false,
        phase: { kind: "intro" },
      },
    });
  };

  const reset = (): void => {
    loginSeq += 1;
    postBeginVersion = null;
    cancelStartRequested = false;
    cancelInFlight = false;
    pendingSubmitRecovery = null;
    abortAddControllers();

    removeSeq += 1;
    removeController?.abort();
    removeController = null;

    dismissRecoveredInFlight = false;
    dismissRecoveredController?.abort();
    dismissRecoveredController = null;

    setState(INITIAL_STATE);
  };

  const syncPromptSnapshot = async (loginId: number, seq: number): Promise<void> => {
    const generation = client.getSessionGeneration();
    syncController?.abort();
    const controller = new AbortController();
    syncController = controller;
    try {
      const latest = await store.refreshSnapshot(controller.signal);
      if (syncController === controller) {
        syncController = null;
      }
      if (
        disposed ||
        generation !== client.getSessionGeneration() ||
        seq !== loginSeq ||
        !state.add.open
      ) {
        return;
      }
      const current = state.add.phase;
      if (current.kind !== "code" || current.loginId !== loginId) {
        return;
      }
      postBeginVersion = latest.version;
      if (latest.login_id !== loginId && !isLoginOpRunningFor(latest, loginId)) {
        setAddPhase({ kind: "expired" });
      }
    } catch {
      if (syncController === controller) {
        syncController = null;
      }
    }
  };

  const finishCancelledFlow = (reopenIntroAfter: boolean): void => {
    toast.push({ tone: "info", body: t("web.add.cancelled_notice") });
    if (reopenIntroAfter) {
      postBeginVersion = null;
      setAddPhase({ kind: "intro" });
    } else {
      closeAddDialogInternal();
    }
  };

  const performCancelLogin = async (
    loginId: number,
    reopenIntroAfter: boolean,
    seq: number,
  ): Promise<void> => {
    if (cancelInFlight) {
      return;
    }
    cancelInFlight = true;
    const generation = client.getSessionGeneration();
    syncController?.abort();
    syncController = null;
    setAddPhase({ kind: "cancelling", reopenIntroAfter });

    const controller = new AbortController();
    cancelController = controller;

    try {
      const settlement = await cancelAccountLogin(loginId, controller.signal, client);
      if (cancelController === controller) {
        cancelController = null;
      }
      cancelInFlight = false;

      if (
        disposed ||
        generation !== client.getSessionGeneration() ||
        seq !== loginSeq ||
        !state.add.open
      ) {
        return;
      }

      void store.refreshSnapshot().catch(() => {});

      if (settlement !== undefined && settlement !== null) {
        if (settlement.outcome === "completed") {
          const emailLabel = settlement.account?.email ?? t("app.accounts.no_email");
          toast.push({ tone: "success", body: t("app.add.done", { email: emailLabel }) });
          closeAddDialogInternal();
          return;
        }
        if (settlement.outcome === "failed") {
          setAddPhase({
            kind: "failed",
            error: formatApiErrorPayload(settlement.error, t),
            rolledBack: settlement.accounts_error == null,
          });
          return;
        }
      }

      finishCancelledFlow(reopenIntroAfter);
    } catch (error) {
      if (cancelController === controller) {
        cancelController = null;
      }
      cancelInFlight = false;

      if (
        disposed ||
        generation !== client.getSessionGeneration() ||
        seq !== loginSeq ||
        !state.add.open
      ) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      // Treat an already-expired or already-cancelled login as cleanly rolled back.
      if (error instanceof ApiError && (error.kind === "login_cancelled" || error.kind === "cancelled")) {
        void store.refreshSnapshot().catch(() => {});
        finishCancelledFlow(reopenIntroAfter);
        return;
      }
      setAddPhase({
        kind: "failed",
        error: formatApiError(error, t),
        rolledBack: false,
      });
    }
  };

  const reconcilePendingSubmit = (snapshot: Snapshot): void => {
    const pending = pendingSubmitRecovery;
    if (
      pending === null ||
      pending.seq !== loginSeq ||
      !state.add.open ||
      state.add.phase.kind !== "submitting" ||
      state.add.phase.loginId !== pending.loginId
    ) {
      return;
    }
    if (isLoginOpRunningFor(snapshot, pending.loginId) || snapshot.login_id === pending.loginId) {
      return;
    }
    pendingSubmitRecovery = null;
    const accounts = snapshot.accounts?.accounts ?? [];
    const activeId = snapshot.accounts?.active ?? snapshot.account.active;
    const addedAccount =
      accounts.find((account) => !pending.preAccountIds.has(account.id)) ??
      (activeId !== null && activeId !== pending.preActive
        ? (accounts.find((account) => account.id === activeId) ?? null)
        : null);
    if (addedAccount !== null) {
      const emailLabel = addedAccount.email ?? t("app.accounts.no_email");
      toast.push({ tone: "success", body: t("app.add.done", { email: emailLabel }) });
      closeAddDialogInternal();
      return;
    }
    // Connection dropped before the response arrived and no new active account appeared;
    // do not claim rollback succeeded when the server outcome is unknown.
    setAddPhase({
      kind: "failed",
      error: formatApiError(pending.error, t),
      rolledBack: false,
    });
  };

  const syncWithSnapshot = (): void => {
    const storeState = store.getState();
    const { snapshot, connectionStatus } = storeState;

    if (prevConnectionStatus !== "connected" && connectionStatus === "connected") {
      if (state.add.open && state.add.phase.kind === "code" && postBeginVersion === null) {
        void syncPromptSnapshot(state.add.phase.loginId, loginSeq);
      } else if (pendingSubmitRecovery !== null) {
        const pendingSeq = pendingSubmitRecovery.seq;
        const generation = client.getSessionGeneration();
        void store
          .refreshSnapshot()
          .then((latest) => {
            if (!disposed && generation === client.getSessionGeneration() && pendingSeq === loginSeq) {
              reconcilePendingSubmit(latest);
            }
          })
          .catch(() => {});
      }
    }
    prevConnectionStatus = connectionStatus;

    if (snapshot === null) {
      return;
    }

    if (
      state.recoveredDismissed &&
      !dismissRecoveredInFlight &&
      snapshot.accounts !== null &&
      !snapshot.accounts.recovered_pending_add
    ) {
      setState({ ...state, recoveredDismissed: false });
    }

    if (state.remove.target !== null && !state.remove.removing && snapshot.accounts !== null) {
      const stillExists = snapshot.accounts.accounts.some(
        (account) => account.id === state.remove.target?.id,
      );
      if (!stillExists) {
        setState({
          ...state,
          remove: {
            ...state.remove,
            target: null,
            removing: false,
            error: null,
          },
        });
      }
    }

    if (!state.add.open) {
      return;
    }

    const phase = state.add.phase;
    if (phase.kind === "submitting") {
      reconcilePendingSubmit(snapshot);
      return;
    }

    if (phase.kind === "intro" || (phase.kind === "failed" && phase.busyConflict)) {
      const activeServerLoginId = findActiveServerLoginId(snapshot);
      if (activeServerLoginId !== null) {
        setAddPhase({ kind: "other_active", loginId: activeServerLoginId });
      }
      return;
    }

    if (phase.kind === "other_active") {
      const activeServerLoginId = findActiveServerLoginId(snapshot);
      if (activeServerLoginId === null) {
        setAddPhase({ kind: "intro" });
      } else if (activeServerLoginId !== phase.loginId) {
        setAddPhase({ kind: "other_active", loginId: activeServerLoginId });
      }
      return;
    }

    if (phase.kind === "code") {
      const serverLoginId = snapshot.login_id;
      if (serverLoginId === phase.loginId) {
        if (postBeginVersion === null) {
          postBeginVersion = snapshot.version;
        }
        return;
      }
      const loginOpRunning = isLoginOpRunningFor(snapshot, phase.loginId);
      if (
        (serverLoginId !== null && serverLoginId !== phase.loginId) ||
        (postBeginVersion !== null &&
          snapshot.version >= postBeginVersion &&
          serverLoginId === null &&
          !loginOpRunning)
      ) {
        setAddPhase({ kind: "expired" });
      }
    }
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
    syncWithSnapshot();
  });

  const openAddAccount = (): void => {
    if (disposed || state.add.open) {
      return;
    }
    const snapshot = store.getState().snapshot;
    if (snapshot?.shutting_down) {
      return;
    }
    const activeServerLoginId = findActiveServerLoginId(snapshot);
    if (activeServerLoginId === null && isAccountChangeBlocked(snapshot, appData.getState())) {
      toast.push({ tone: "warning", body: t("app.b2.account_change_blocked") });
      return;
    }
    loginSeq += 1;
    postBeginVersion = null;
    cancelStartRequested = false;
    cancelInFlight = false;
    abortAddControllers();
    setState({
      ...state,
      add: {
        open: true,
        openSeq: state.add.openSeq + 1,
        phase:
          activeServerLoginId !== null
            ? { kind: "other_active", loginId: activeServerLoginId }
            : { kind: "intro" },
      },
    });
  };

  const startAddLogin = async (): Promise<void> => {
    if (disposed || !state.add.open) {
      return;
    }
    const snapshot = store.getState().snapshot;
    if (snapshot === null || snapshot.shutting_down) {
      return;
    }
    if (isAccountChangeBlocked(snapshot, appData.getState())) {
      const activeServerLoginId = findActiveServerLoginId(snapshot);
      if (activeServerLoginId !== null) {
        setAddPhase({ kind: "other_active", loginId: activeServerLoginId });
      }
      return;
    }

    const seq = ++loginSeq;
    const generation = client.getSessionGeneration();
    cancelStartRequested = false;
    cancelInFlight = false;
    pendingSubmitRecovery = null;
    postBeginVersion = null;
    abortAddControllers();
    setAddPhase({ kind: "starting" });

    const controller = new AbortController();
    addController = controller;

    try {
      const prompt = await beginAccountLogin(snapshot.account, controller.signal, client);
      if (addController === controller) {
        addController = null;
      }
      if (disposed || generation !== client.getSessionGeneration()) {
        return;
      }

      if (cancelStartRequested || !state.add.open || seq !== loginSeq) {
        // `201 Created` guarantees this tab owns `prompt.id`, so rolling it back never touches another tab.
        if (!cancelInFlight) {
          await performCancelLogin(prompt.id, false, seq);
        }
        return;
      }

      setAddPhase({ kind: "code", loginId: prompt.id, authUrl: prompt.auth_url });
      void syncPromptSnapshot(prompt.id, seq);
    } catch (error) {
      if (addController === controller) {
        addController = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== loginSeq) {
        return;
      }
      if (cancelStartRequested) {
        if (cancelInFlight) {
          return;
        }
        // Aborting `POST /api/accounts/login` triggers backend `CancelBeginOnDrop` only when
        // this request owned the start slot; never send `DELETE` using a shared snapshot login id.
        try {
          await store.refreshSnapshot();
        } catch {
          // Still close cleanly if snapshot refresh fails after cancelling start.
        }
        if (
          !disposed &&
          generation === client.getSessionGeneration() &&
          seq === loginSeq &&
          state.add.open &&
          !cancelInFlight
        ) {
          finishCancelledFlow(false);
        }
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (error instanceof ApiError && (error.kind === "add_in_progress" || error.kind === "busy")) {
        let latestSnapshot = store.getState().snapshot;
        if (findActiveServerLoginId(latestSnapshot) === null) {
          try {
            latestSnapshot = await store.refreshSnapshot();
          } catch {
            latestSnapshot = store.getState().snapshot;
          }
          if (
            disposed ||
            generation !== client.getSessionGeneration() ||
            seq !== loginSeq ||
            !state.add.open
          ) {
            return;
          }
        }
        const activeServerLoginId = findActiveServerLoginId(latestSnapshot);
        if (activeServerLoginId !== null) {
          setAddPhase({ kind: "other_active", loginId: activeServerLoginId });
          return;
        }
        setAddPhase({
          kind: "failed",
          error: formatApiError(error, t),
          rolledBack: false,
          busyConflict: true,
        });
        return;
      }
      void store.refreshSnapshot().catch(() => {});
      setAddPhase({
        kind: "failed",
        error: formatApiError(error, t),
        rolledBack: true,
      });
    }
  };

  const submitAddLoginCode = async (rawCode: string): Promise<void> => {
    if (disposed || !state.add.open || state.add.phase.kind !== "code") {
      return;
    }
    const trimmed = rawCode.trim();
    if (trimmed.length === 0) {
      return;
    }

    const seq = loginSeq;
    const generation = client.getSessionGeneration();
    const { loginId, authUrl } = state.add.phase;
    const preSnapshot = store.getState().snapshot;
    const preAccountIds = new Set(
      (preSnapshot?.accounts?.accounts ?? []).map((account) => account.id),
    );
    const preActive = preSnapshot?.accounts?.active ?? preSnapshot?.account.active ?? null;
    pendingSubmitRecovery = null;
    syncController?.abort();
    syncController = null;
    setAddPhase({ kind: "submitting", loginId, authUrl });

    const controller = new AbortController();
    addController = controller;

    try {
      const account = await submitAccountLoginCode(loginId, trimmed, controller.signal, client);
      if (addController === controller) {
        addController = null;
      }
      if (
        disposed ||
        generation !== client.getSessionGeneration() ||
        seq !== loginSeq ||
        !state.add.open
      ) {
        return;
      }
      const emailLabel = account.email ?? t("app.accounts.no_email");
      toast.push({ tone: "success", body: t("app.add.done", { email: emailLabel }) });
      void store.refreshSnapshot().catch(() => {});
      closeAddDialogInternal();
    } catch (error) {
      if (addController === controller) {
        addController = null;
      }
      if (
        disposed ||
        generation !== client.getSessionGeneration() ||
        seq !== loginSeq ||
        !state.add.open
      ) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        return;
      }
      if (isTransportUnknownError(error)) {
        pendingSubmitRecovery = {
          seq,
          loginId,
          preAccountIds,
          preActive,
          error,
        };
        try {
          const latest = await store.refreshSnapshot();
          if (
            disposed ||
            generation !== client.getSessionGeneration() ||
            seq !== loginSeq ||
            !state.add.open
          ) {
            return;
          }
          reconcilePendingSubmit(latest);
        } catch {
          // Stay locked in submitting until connectivity returns and SSE/snapshot reconciles.
        }
        return;
      }
      void store.refreshSnapshot().catch(() => {});
      if (
        error instanceof ApiError &&
        (error.kind === "login_cancelled" || error.kind === "cancelled")
      ) {
        setAddPhase({ kind: "expired" });
        return;
      }
      setAddPhase({
        kind: "failed",
        error: formatApiError(error, t),
        rolledBack: true,
      });
    }
  };

  const cancelExistingLogin = async (): Promise<void> => {
    if (disposed || !state.add.open || state.add.phase.kind !== "other_active") {
      return;
    }
    await performCancelLogin(state.add.phase.loginId, true, loginSeq);
  };

  const cancelOrCloseAddAccount = (): void => {
    if (disposed || !state.add.open) {
      return;
    }
    const current = state.add.phase;
    // Never dismiss or cancel locally while submitting or rolling back on the backend.
    if (current.kind === "submitting" || current.kind === "cancelling") {
      return;
    }
    if (current.kind === "starting") {
      cancelStartRequested = true;
      setAddPhase({ kind: "cancelling", reopenIntroAfter: false });
      // Abort the pending HTTP request so backend `CancelBeginOnDrop` cancels only our own start.
      addController?.abort();
      addController = null;
      return;
    }
    if (current.kind === "code") {
      void performCancelLogin(current.loginId, false, loginSeq);
      return;
    }
    closeAddDialogInternal();
  };

  const openRemoveAccount = (target: RemoveTarget): void => {
    if (disposed || state.remove.removing) {
      return;
    }
    removeSeq += 1;
    setState({
      ...state,
      remove: {
        target,
        openSeq: state.remove.openSeq + 1,
        removing: false,
        error: null,
      },
    });
  };

  const closeRemoveAccount = (): void => {
    if (disposed || state.remove.removing || state.remove.target === null) {
      return;
    }
    removeSeq += 1;
    setState({
      ...state,
      remove: {
        ...state.remove,
        target: null,
        removing: false,
        error: null,
      },
    });
  };

  const confirmRemoveAccount = async (): Promise<void> => {
    const current = state.remove.target;
    const liveSnapshot = store.getState().snapshot;
    if (disposed || current === null || state.remove.removing || liveSnapshot === null) {
      return;
    }
    if (
      getAccountRemoveBlock(current.id, liveSnapshot) !== null ||
      isAccountChangeBlocked(liveSnapshot, appData.getState()) ||
      liveSnapshot.shutting_down
    ) {
      return;
    }

    const seq = ++removeSeq;
    const generation = client.getSessionGeneration();
    removeController?.abort();
    const controller = new AbortController();
    removeController = controller;

    setState({
      ...state,
      remove: {
        ...state.remove,
        removing: true,
        error: null,
      },
    });

    try {
      await removeSavedAccount(current.id, liveSnapshot.account, controller.signal, client);
      if (removeController === controller) {
        removeController = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== removeSeq) {
        return;
      }
      toast.push({ tone: "success", body: t("app.remove.done", { email: current.emailLabel }) });
      void store.refreshSnapshot().catch(() => {});
      setState({
        ...state,
        remove: {
          ...state.remove,
          target: null,
          removing: false,
          error: null,
        },
      });
    } catch (error) {
      if (removeController === controller) {
        removeController = null;
      }
      if (disposed || generation !== client.getSessionGeneration() || seq !== removeSeq) {
        return;
      }
      if (error instanceof ApiError && (error.isAbort || error.isUnauthorized)) {
        setState({
          ...state,
          remove: {
            ...state.remove,
            removing: false,
          },
        });
        return;
      }
      setState({
        ...state,
        remove: {
          ...state.remove,
          removing: false,
          error: formatApiError(error, t),
        },
      });
    }
  };

  const dismissRecovered = async (): Promise<void> => {
    if (disposed || dismissRecoveredInFlight) {
      return;
    }
    const generation = client.getSessionGeneration();
    dismissRecoveredInFlight = true;
    dismissRecoveredController?.abort();
    const controller = new AbortController();
    dismissRecoveredController = controller;
    setState({ ...state, recoveredDismissed: true });

    try {
      await dismissRecoveredPendingAdd(controller.signal, client);
      if (dismissRecoveredController === controller) {
        dismissRecoveredController = null;
      }
      dismissRecoveredInFlight = false;
      if (disposed || generation !== client.getSessionGeneration()) {
        return;
      }
      void store.refreshSnapshot().catch(() => {});
    } catch (error) {
      if (dismissRecoveredController === controller) {
        dismissRecoveredController = null;
      }
      dismissRecoveredInFlight = false;
      if (disposed || generation !== client.getSessionGeneration()) {
        return;
      }
      if (!(error instanceof ApiError && (error.isAbort || error.isUnauthorized))) {
        setState({ ...state, recoveredDismissed: false });
      }
    }
  };

  return {
    getState(): AccountDialogsState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openAddAccount,
    startAddLogin,
    submitAddLoginCode,
    cancelExistingLogin,
    cancelOrCloseAddAccount,
    openRemoveAccount,
    closeRemoveAccount,
    confirmRemoveAccount,
    dismissRecoveredPendingAdd: dismissRecovered,
    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      unsubscribeStore();
      reset();
      listeners.clear();
    },
  };
}

/** Shared global controller for account dialogs and recovery notice dismissal. */
export const accountDialogsStore: AccountDialogsStore = createAccountDialogsStore();

/** Opens the global `AddAccountDialog` from any route without threading props through `App.tsx`. */
export function openAddAccountDialog(): void {
  accountDialogsStore.openAddAccount();
}

/** Opens the global `RemoveAccountDialog` for a saved account from any route. */
export function openRemoveAccountDialog(target: RemoveTarget): void {
  accountDialogsStore.openRemoveAccount(target);
}

/** React hook subscribing a component to `accountDialogsStore`. */
export function useAccountDialogsStore(
  store: AccountDialogsStore = accountDialogsStore,
): AccountDialogsState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
