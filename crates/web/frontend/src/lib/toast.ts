/**
 * Global non-blocking Toast notification store shared by the shell and pages.
 */

import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastInput {
  readonly tone?: ToastTone;
  readonly title?: string;
  readonly body: string;
  /** Auto-dismiss timeout in ms; pass `null` to keep until dismissed by the user. */
  readonly durationMs?: number | null;
  /** Invoked only when the user explicitly dismisses this toast (not on sign-out clear). */
  readonly onDismiss?: () => void;
}

export interface DismissToastOptions {
  /** Whether to invoke `onDismiss` callback. Defaults to `true`. */
  readonly notify?: boolean;
}

export interface ToastItem {
  readonly id: number;
  readonly tone: ToastTone;
  readonly title: string | null;
  readonly body: string;
  readonly durationMs: number | null;
}

export interface ToastStoreOptions {
  readonly maxItems?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

export interface ToastStore {
  getToasts(): readonly ToastItem[];
  subscribe(listener: () => void): () => void;
  push(input: ToastInput): number;
  dismiss(id: number, options?: DismissToastOptions): void;
  clear(): void;
  dispose(): void;
}

const DEFAULT_MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 5000;
const DEFAULT_ALERT_DURATION_MS = 8000;

function resolveDurationMs(tone: ToastTone, requested: number | null | undefined): number | null {
  if (requested === null) {
    return null;
  }
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
    return Math.round(requested);
  }
  return tone === "warning" || tone === "danger"
    ? DEFAULT_ALERT_DURATION_MS
    : DEFAULT_DURATION_MS;
}

/**
 * Creates a bounded toast queue with independent auto-dismiss timers.
 */
export function createToastStore(options: ToastStoreOptions = {}): ToastStore {
  const maxItems = Math.max(1, options.maxItems ?? DEFAULT_MAX_TOASTS);
  const setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);

  let nextId = 1;
  let items: readonly ToastItem[] = [];
  let disposed = false;

  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const dismissCallbacks = new Map<number, () => void>();
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so toast updates reach all listeners.
      }
    }
  };

  const cancelTimer = (id: number): void => {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimer(timer);
      timers.delete(id);
    }
  };

  const dismiss = (id: number, dismissOptions: DismissToastOptions = {}): void => {
    cancelTimer(id);
    const callback = dismissCallbacks.get(id);
    dismissCallbacks.delete(id);
    const filtered = items.filter((item) => item.id !== id);
    if (filtered.length === items.length) {
      return;
    }
    items = filtered;
    if (dismissOptions.notify !== false && callback) {
      try {
        callback();
      } catch {
        // Isolate dismiss callback failures so UI updates still settle.
      }
    }
    emit();
  };

  return {
    getToasts(): readonly ToastItem[] {
      return items;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    push(input: ToastInput): number {
      if (disposed) {
        return 0;
      }
      const id = nextId++;
      const tone: ToastTone = input.tone ?? "info";
      const durationMs = resolveDurationMs(tone, input.durationMs);
      const nextItem: ToastItem = {
        id,
        tone,
        title: input.title?.trim() ? input.title : null,
        body: input.body,
        durationMs,
      };
      if (input.onDismiss) {
        dismissCallbacks.set(id, input.onDismiss);
      }

      const nextList = [...items, nextItem];
      // Evict oldest transient toasts first so persistent billing/guard alerts stay visible.
      while (nextList.length > maxItems) {
        const transientIndex = nextList.findIndex(
          (item) => item.id !== id && item.durationMs !== null,
        );
        if (transientIndex !== -1) {
          const [evicted] = nextList.splice(transientIndex, 1);
          if (evicted) {
            cancelTimer(evicted.id);
            dismissCallbacks.delete(evicted.id);
          }
          continue;
        }
        // Keep persistent alerts intact rather than dropping a still-billing warning.
        break;
      }
      items = nextList;

      if (durationMs !== null) {
        const timer = setTimer(() => {
          timers.delete(id);
          dismiss(id, { notify: false });
        }, durationMs);
        timers.set(id, timer);
      }

      emit();
      return id;
    },

    dismiss,

    clear(): void {
      for (const timer of timers.values()) {
        clearTimer(timer);
      }
      timers.clear();
      dismissCallbacks.clear();
      if (items.length === 0) {
        return;
      }
      items = [];
      emit();
    },

    dispose(): void {
      disposed = true;
      this.clear();
      listeners.clear();
    },
  };
}

/** Shared global toast store for the Browser Client. */
export const toastStore: ToastStore = createToastStore();

export function pushToast(input: ToastInput): number {
  return toastStore.push(input);
}

export function dismissToast(id: number, options?: DismissToastOptions): void {
  toastStore.dismiss(id, options);
}

/**
 * React hook subscribing to live global toast notifications.
 */
export function useToasts(store: ToastStore = toastStore): readonly ToastItem[] {
  return useSyncExternalStore(store.subscribe, store.getToasts, store.getToasts);
}
