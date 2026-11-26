/**
 * Global one-time settings corrupt/reset notice store.
 *
 * Observes `Snapshot.settings_notice` and `SettingsView.settings_notice` across
 * all routes, displays the warning once per notice, and persists dismissal to
 * `POST /api/settings/notice/dismiss` so navigating between pages or re-entering
 * Settings never repeats it.
 */

import { useSyncExternalStore } from "react";

import { apiClient, type ApiClient } from "../../lib/api.ts";
import type { DismissSettingsNoticeResponse, SettingsNotice } from "../../lib/types.ts";
import { normalizeSettingsNotice } from "./api.ts";

export type NoticePart = "corrupt" | "reset";

export interface SettingsNoticeState {
  readonly notice: SettingsNotice | null;
  readonly showCorrupt: boolean;
  readonly showReset: boolean;
}

export interface SettingsNoticeStore {
  getState(): SettingsNoticeState;
  subscribe(listener: () => void): () => void;
  observe(notice: SettingsNotice | null | undefined): void;
  dismissPart(part: NoticePart): Promise<void>;
  dispose(): void;
}

function noticeSignature(notice: SettingsNotice): string {
  return JSON.stringify([notice.corrupt, notice.corrupt_backup, notice.reset_defaults]);
}

function computeState(
  notice: SettingsNotice | null,
  corruptDismissed: boolean,
  resetDismissed: boolean,
): SettingsNoticeState {
  const showCorrupt = notice !== null && notice.corrupt && !corruptDismissed;
  const showReset = notice !== null && notice.reset_defaults.length > 0 && !resetDismissed;
  if (!showCorrupt && !showReset) {
    return { notice: null, showCorrupt: false, showReset: false };
  }
  return { notice, showCorrupt, showReset };
}

/**
 * Creates an isolated global store for one-time settings load notices.
 */
export function createSettingsNoticeStore(client: ApiClient = apiClient): SettingsNoticeStore {
  let disposed = false;
  let activeNotice: SettingsNotice | null = null;
  let activeSignature: string | null = null;
  let corruptDismissed = false;
  let resetDismissed = false;
  const dismissedSignatures = new Set<string>();
  let state: SettingsNoticeState = {
    notice: null,
    showCorrupt: false,
    showReset: false,
  };
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so the global banner stays consistent.
      }
    }
  };

  const syncState = (): void => {
    const next = computeState(activeNotice, corruptDismissed, resetDismissed);
    if (
      next.notice === state.notice &&
      next.showCorrupt === state.showCorrupt &&
      next.showReset === state.showReset
    ) {
      return;
    }
    state = next;
    emit();
  };

  const resetSession = (): void => {
    activeNotice = null;
    activeSignature = null;
    corruptDismissed = false;
    resetDismissed = false;
    dismissedSignatures.clear();
    syncState();
  };

  const unsubscribeAuth = client.subscribeAuth((event) => {
    if (disposed) {
      return;
    }
    if (
      event.type === "logged_out" ||
      event.type === "unauthorized" ||
      event.type === "authenticated"
    ) {
      resetSession();
    }
  });

  return {
    getState(): SettingsNoticeState {
      return state;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    observe(rawNotice: SettingsNotice | null | undefined): void {
      if (disposed || rawNotice === undefined) {
        return;
      }
      const normalized = normalizeSettingsNotice(rawNotice);
      if (normalized === null) {
        // Never dismiss an unacknowledged notice already shown to the user (for example,
        // when login preference sync sends an automatic PATCH /api/settings).
        return;
      }

      const signature = noticeSignature(normalized);
      if (dismissedSignatures.has(signature)) {
        return;
      }
      if (signature === activeSignature) {
        return;
      }

      activeNotice = normalized;
      activeSignature = signature;
      corruptDismissed = !normalized.corrupt;
      resetDismissed = normalized.reset_defaults.length === 0;
      syncState();
    },

    async dismissPart(part: NoticePart): Promise<void> {
      if (disposed || activeNotice === null || activeSignature === null) {
        return;
      }
      if (part === "corrupt") {
        corruptDismissed = true;
      } else {
        resetDismissed = true;
      }

      const stillVisible =
        (activeNotice.corrupt && !corruptDismissed) ||
        (activeNotice.reset_defaults.length > 0 && !resetDismissed);

      if (stillVisible) {
        syncState();
        return;
      }

      dismissedSignatures.add(activeSignature);
      activeNotice = null;
      activeSignature = null;
      syncState();

      if (!client.isAuthenticated()) {
        return;
      }
      try {
        await client.request<DismissSettingsNoticeResponse>("/api/settings/notice/dismiss", {
          method: "POST",
          body: {},
        });
      } catch {
        // Keep the notice dismissed in this session even if the server acknowledgement fails.
      }
    },

    dispose(): void {
      disposed = true;
      unsubscribeAuth();
      listeners.clear();
    },
  };
}

/** Shared global store for one-time settings corrupt/reset notices. */
export const settingsNoticeStore: SettingsNoticeStore = createSettingsNoticeStore();

export function useSettingsNoticeStore(
  store: SettingsNoticeStore = settingsNoticeStore,
): SettingsNoticeState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
