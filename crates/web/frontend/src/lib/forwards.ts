/**
 * Application-wide port-forward subscription and address cache.
 *
 * Subscribes continuously to `webStore` snapshot updates and `forward` SSE
 * transitions across all routes so tunnel state, health checks, and
 * server-validated addresses stay warm while away from Sessions or Plugins.
 */

import { useSyncExternalStore } from "react";

import { apiClient, attachAbortSignal, type ApiClient } from "./api.ts";
import { webStore, type WebStore } from "./store.ts";
import type {
  ForwardAddresses,
  ForwardView,
  Runtime,
  Snapshot,
  TunnelEvent,
  TunnelInfo,
  TunnelState,
} from "./types.ts";

export interface ForwardLiveOverlay {
  readonly snapshotVersion: number;
  readonly state?: TunnelState;
  readonly healthy?: boolean | null;
}

export interface ForwardsStoreState {
  readonly snapshotVersion: number;
  readonly addressesById: Readonly<Record<number, ForwardAddresses>>;
  readonly overlaysById: Readonly<Record<number, ForwardLiveOverlay>>;
}

export interface ForwardsStoreOptions {
  readonly client?: ApiClient;
  readonly store?: WebStore;
}

export interface ForwardsStore {
  getState(): ForwardsStoreState;
  subscribe(listener: () => void): () => void;
  refresh(signal?: AbortSignal): Promise<ForwardView[]>;
  recordForward(view: ForwardView): void;
  applyEvent(event: TunnelEvent): void;
  getEffectiveTunnel(tunnel: TunnelInfo, snapshotVersion: number): TunnelInfo;
  selectForwardsForRuntime(runtime: Runtime, snapshot: Snapshot): readonly ForwardView[];
  dispose(): void;
}

const INITIAL_STATE: ForwardsStoreState = {
  snapshotVersion: 0,
  addressesById: {},
  overlaysById: {},
};

function tunnelAddressKey(tunnel: TunnelInfo): string {
  return `${tunnel.spec.bind}:${tunnel.spec.local_port}:${tunnel.spec.remote_port}`;
}

/**
 * Applies a same-version live SSE `forward` overlay onto a `TunnelInfo` from `Snapshot`.
 */
export function applyForwardOverlayToTunnel(
  tunnel: TunnelInfo,
  overlaysById: Readonly<Record<number, ForwardLiveOverlay>>,
  snapshotVersion: number,
): TunnelInfo {
  const overlay = overlaysById[tunnel.id];
  const activeOverlay =
    overlay && overlay.snapshotVersion === snapshotVersion ? overlay : null;
  if (!activeOverlay) {
    return tunnel;
  }
  return {
    ...tunnel,
    state: activeOverlay.state ?? tunnel.state,
    healthy: activeOverlay.healthy !== undefined ? activeOverlay.healthy : tunnel.healthy,
  };
}

/**
 * Selects live forwards for one runtime by merging authoritative `snapshot.tunnels`,
 * same-version SSE `forward` overlays, and cached server-validated addresses.
 */
export function selectRuntimeForwards(
  runtime: Runtime,
  forwardsState: ForwardsStoreState,
  snapshot: Snapshot,
): readonly ForwardView[] {
  if (!runtime.id.name) {
    return [];
  }
  const out: ForwardView[] = [];
  for (const tunnel of snapshot.tunnels) {
    if (tunnel.spec.account !== runtime.id.account || tunnel.spec.session !== runtime.id.name) {
      continue;
    }
    const effective = applyForwardOverlayToTunnel(
      tunnel,
      forwardsState.overlaysById,
      snapshot.version,
    );
    out.push({
      ...effective,
      addresses: forwardsState.addressesById[tunnel.id] ?? null,
    });
  }
  return out;
}

/**
 * Creates a globally active port-forward store bound to `ApiClient` and `WebStore`.
 */
export function createForwardsStore(options: ForwardsStoreOptions = {}): ForwardsStore {
  const client = options.client ?? apiClient;
  const store = options.store ?? webStore;

  let state: ForwardsStoreState = INITIAL_STATE;
  let disposed = false;
  let mutationSeq = 0;
  let hydratePending = false;
  let pendingRecordedIds = new Set<number>();
  let tunnelSignatures = new Map<number, string>();
  let inFlight: {
    readonly generation: number;
    readonly seq: number;
    readonly controller: AbortController;
    readonly promise: Promise<ForwardView[]>;
  } | null = null;

  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all forward consumers converge cleanly.
      }
    }
  };

  const setState = (patch: Partial<ForwardsStoreState>): void => {
    const next: ForwardsStoreState = { ...state, ...patch };
    if (
      next.snapshotVersion === state.snapshotVersion &&
      next.addressesById === state.addressesById &&
      next.overlaysById === state.overlaysById
    ) {
      return;
    }
    state = next;
    emit();
  };

  const cancelInFlight = (): void => {
    if (inFlight !== null) {
      inFlight.controller.abort();
      inFlight = null;
    }
  };

  const reset = (): void => {
    cancelInFlight();
    mutationSeq += 1;
    hydratePending = false;
    pendingRecordedIds = new Set<number>();
    tunnelSignatures = new Map<number, string>();
    setState(INITIAL_STATE);
  };

  const refresh = (signal?: AbortSignal): Promise<ForwardView[]> => {
    if (disposed || !client.isAuthenticated()) {
      return Promise.resolve([]);
    }
    const generation = client.getSessionGeneration();
    if (inFlight !== null && inFlight.generation === generation) {
      return attachAbortSignal(inFlight.promise, signal);
    }
    const seq = ++mutationSeq;
    const controller = new AbortController();
    const promise = client
      .request<ForwardView[]>("/api/forwards", {
        method: "GET",
        signal: controller.signal,
      })
      .then((list) => {
        if (!disposed && client.getSessionGeneration() === generation) {
          const nextAddresses: Record<number, ForwardAddresses> =
            seq === mutationSeq ? {} : { ...state.addressesById };
          for (const fw of list) {
            if (fw.addresses) {
              nextAddresses[fw.id] = fw.addresses;
            }
          }
          setState({ addressesById: nextAddresses });
        }
        return list;
      })
      .finally(() => {
        if (inFlight?.promise === promise) {
          inFlight = null;
          if (!disposed && hydratePending && client.getSessionGeneration() === generation) {
            hydratePending = false;
            void refresh().catch(() => {});
          }
        }
      });
    inFlight = { generation, seq, controller, promise };
    return attachAbortSignal(promise, signal);
  };

  const syncFromStore = (): void => {
    if (disposed) {
      return;
    }
    const storeState = store.getState();
    if (storeState.authStatus !== "authenticated") {
      reset();
      return;
    }
    const snapshot = storeState.snapshot;
    if (!snapshot) {
      return;
    }

    let nextAddresses: Record<number, ForwardAddresses> | null = null;
    let needsHydrate = false;
    const nextSignatures = new Map<number, string>();
    const liveIds = new Set<number>();

    for (const tunnel of snapshot.tunnels) {
      liveIds.add(tunnel.id);
      pendingRecordedIds.delete(tunnel.id);
      const sig = tunnelAddressKey(tunnel);
      nextSignatures.set(tunnel.id, sig);
      const prevSig = tunnelSignatures.get(tunnel.id);
      if (!Object.hasOwn(state.addressesById, tunnel.id) || (prevSig !== undefined && prevSig !== sig)) {
        needsHydrate = true;
      }
    }

    for (const rawId of Object.keys(state.addressesById)) {
      const id = Number(rawId);
      if (!liveIds.has(id) && !pendingRecordedIds.has(id)) {
        if (nextAddresses === null) {
          nextAddresses = { ...state.addressesById };
        }
        delete nextAddresses[id];
      }
    }

    tunnelSignatures = nextSignatures;

    const versionAdvanced = snapshot.version > state.snapshotVersion;
    if (versionAdvanced || nextAddresses !== null) {
      setState({
        ...(versionAdvanced ? { snapshotVersion: snapshot.version } : {}),
        ...(versionAdvanced && Object.keys(state.overlaysById).length > 0
          ? { overlaysById: {} }
          : {}),
        ...(nextAddresses !== null ? { addressesById: nextAddresses } : {}),
      });
    }

    if (needsHydrate) {
      if (inFlight !== null && inFlight.generation === client.getSessionGeneration()) {
        hydratePending = true;
      } else {
        void refresh().catch(() => {});
      }
    }
  };

  const applyEvent = (event: TunnelEvent): void => {
    if (disposed || !client.isAuthenticated()) {
      return;
    }
    const baseVersion = store.getState().snapshot?.version ?? state.snapshotVersion;
    const prev = state.overlaysById[event.id];
    const base: ForwardLiveOverlay =
      prev && prev.snapshotVersion === baseVersion ? prev : { snapshotVersion: baseVersion };
    const next: ForwardLiveOverlay =
      event.event === "state"
        ? { ...base, state: event.state }
        : { ...base, healthy: event.healthy };
    setState({
      snapshotVersion: Math.max(state.snapshotVersion, baseVersion),
      overlaysById: {
        ...state.overlaysById,
        [event.id]: next,
      },
    });
    if (
      event.event === "state" &&
      event.state.state === "up" &&
      !Object.hasOwn(state.addressesById, event.id)
    ) {
      void refresh().catch(() => {});
    }
  };

  const unsubscribeStore = store.subscribe(syncFromStore);
  const unsubscribeForwards = store.subscribeForwards(applyEvent);
  syncFromStore();

  return {
    getState(): ForwardsStoreState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    refresh,

    recordForward(view: ForwardView): void {
      if (disposed || !view.addresses) {
        return;
      }
      mutationSeq += 1;
      pendingRecordedIds.add(view.id);
      setState({
        addressesById: {
          ...state.addressesById,
          [view.id]: view.addresses,
        },
      });
    },

    applyEvent,

    getEffectiveTunnel(tunnel: TunnelInfo, snapshotVersion: number): TunnelInfo {
      return applyForwardOverlayToTunnel(tunnel, state.overlaysById, snapshotVersion);
    },

    selectForwardsForRuntime(runtime: Runtime, snapshot: Snapshot): readonly ForwardView[] {
      return selectRuntimeForwards(runtime, state, snapshot);
    },

    dispose(): void {
      disposed = true;
      unsubscribeStore();
      unsubscribeForwards();
      cancelInFlight();
      listeners.clear();
    },
  };
}

/** Shared global port-forward store bound to `apiClient` and `webStore`. */
export const forwardsStore: ForwardsStore = createForwardsStore();

/** React hook subscribing a component to the global port-forward store. */
export function useForwardsStore(store: ForwardsStore = forwardsStore): ForwardsStoreState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
