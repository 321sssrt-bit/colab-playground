/**
 * Hash-based router (`#/<route>`) for the five fixed top-level pages.
 *
 * Uses `#/<route>` exclusively because the embedded Web Server serves HTML only
 * at `/`, preserving direct bookmarks, reloads, and browser Back/Forward without 404s.
 */

import { useSyncExternalStore } from "react";

import type { TranslateFn } from "./i18n.ts";

export type RouteId = "overview" | "sessions" | "plugins" | "accounts" | "settings";

/** Section pinned to the top of Settings when another page links there directly. */
export type SettingsFocus = "limit" | "host";

export const ROUTES: readonly RouteId[] = [
  "overview",
  "sessions",
  "plugins",
  "accounts",
  "settings",
];

export const DEFAULT_ROUTE: RouteId = "overview";

const ROUTE_SET: ReadonlySet<string> = new Set<string>(ROUTES);
const SETTINGS_FOCUS_SET: ReadonlySet<string> = new Set<string>(["limit", "host"]);

const ROUTE_TITLE_KEYS = {
  overview: "app.nav.overview",
  sessions: "app.nav.sessions",
  plugins: "app.nav.plugins",
  accounts: "app.nav.accounts",
  settings: "app.nav.settings",
} as const;

export interface ParsedHashRoute {
  readonly route: RouteId;
  readonly canonical: boolean;
}

export interface NavigateOptions {
  readonly replace?: boolean;
  readonly settingsFocus?: SettingsFocus | null;
}

export interface RouterSnapshot {
  readonly route: RouteId;
  readonly settingsFocus: SettingsFocus | null;
}

export interface RouterStoreOptions {
  readonly win?: Pick<
    Window,
    "location" | "history" | "addEventListener" | "removeEventListener"
  > | null;
}

export interface RouterStore {
  getRoute(): RouteId;
  getSettingsFocus(): SettingsFocus | null;
  getState(): RouterSnapshot;
  subscribe(listener: () => void): () => void;
  navigate(route: RouteId, options?: NavigateOptions): void;
  ensureCanonicalHash(): void;
  dispose(): void;
}

export function isRouteId(value: string): value is RouteId {
  return ROUTE_SET.has(value);
}

export function isSettingsFocus(value: string): value is SettingsFocus {
  return SETTINGS_FOCUS_SET.has(value);
}

export function routeToHash(route: RouteId, settingsFocus?: SettingsFocus | null): string {
  if (route === "settings" && settingsFocus && isSettingsFocus(settingsFocus)) {
    return `#/settings?focus=${settingsFocus}`;
  }
  return `#/${route}`;
}

export function parseSettingsFocus(rawHash: string): SettingsFocus | null {
  const withoutHash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const withoutLeadingSlash = withoutHash.startsWith("/") ? withoutHash.slice(1) : withoutHash;
  const queryIndex = withoutLeadingSlash.indexOf("?");
  if (queryIndex < 0) {
    return null;
  }
  const segment = withoutLeadingSlash.slice(0, queryIndex).split("/", 1)[0]?.toLowerCase() ?? "";
  if (segment !== "settings") {
    return null;
  }
  const params = new URLSearchParams(withoutLeadingSlash.slice(queryIndex + 1));
  const focus = params.get("focus")?.toLowerCase() ?? "";
  return isSettingsFocus(focus) ? focus : null;
}

export function parseHashRoute(rawHash: string): ParsedHashRoute {
  const withoutHash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const withoutLeadingSlash = withoutHash.startsWith("/") ? withoutHash.slice(1) : withoutHash;
  const segment = withoutLeadingSlash.split(/[/?]/, 1)[0]?.toLowerCase() ?? "";

  if (isRouteId(segment)) {
    const focus = segment === "settings" ? parseSettingsFocus(rawHash) : null;
    const canonicalHash = routeToHash(segment, focus);
    return {
      route: segment,
      canonical: rawHash === canonicalHash,
    };
  }

  return {
    route: DEFAULT_ROUTE,
    canonical: false,
  };
}

export function getRouteTitle(route: RouteId, t: TranslateFn): string {
  return t(ROUTE_TITLE_KEYS[route]);
}

export function formatDocumentTitle(route: RouteId, t: TranslateFn): string {
  const appName = t("app.name");
  const pageTitle = getRouteTitle(route, t);
  if (!pageTitle) {
    return appName;
  }
  return appName ? `${pageTitle} — ${appName}` : pageTitle;
}

/**
 * Creates a reactive hash-route store synchronized with browser navigation.
 */
export function createRouterStore(options: RouterStoreOptions = {}): RouterStore {
  const win =
    options.win !== undefined
      ? options.win
      : typeof window !== "undefined"
        ? window
        : null;

  const initialRoute = win ? parseHashRoute(win.location.hash).route : DEFAULT_ROUTE;
  const initialFocus =
    win && initialRoute === "settings" ? parseSettingsFocus(win.location.hash) : null;

  let snapshot: RouterSnapshot = {
    route: initialRoute,
    settingsFocus: initialFocus,
  };
  let disposed = false;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Isolate subscriber exceptions so all route consumers stay synchronized.
      }
    }
  };

  const replaceHashInPlace = (route: RouteId, focus: SettingsFocus | null): void => {
    if (!win) {
      return;
    }
    const targetHash = routeToHash(route, focus);
    if (win.location.hash === targetHash) {
      return;
    }
    try {
      const base = `${win.location.pathname}${win.location.search}`;
      win.history.replaceState(null, "", `${base}${targetHash}`);
    } catch {
      win.location.hash = targetHash;
    }
  };

  const syncFromLocation = (normalizeInvalid: boolean): void => {
    if (disposed || !win) {
      return;
    }
    const parsed = parseHashRoute(win.location.hash);
    const nextFocus = parsed.route === "settings" ? parseSettingsFocus(win.location.hash) : null;
    if (normalizeInvalid && !parsed.canonical) {
      replaceHashInPlace(parsed.route, nextFocus);
    }
    if (parsed.route !== snapshot.route || nextFocus !== snapshot.settingsFocus) {
      snapshot = { route: parsed.route, settingsFocus: nextFocus };
      emit();
    }
  };

  const onHashChange = (): void => {
    syncFromLocation(true);
  };

  win?.addEventListener("hashchange", onHashChange);

  return {
    getRoute(): RouteId {
      return snapshot.route;
    },

    getSettingsFocus(): SettingsFocus | null {
      return snapshot.settingsFocus;
    },

    getState(): RouterSnapshot {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    navigate(route: RouteId, navOptions: NavigateOptions = {}): void {
      if (disposed) {
        return;
      }
      const nextFocus =
        route === "settings" && navOptions.settingsFocus && isSettingsFocus(navOptions.settingsFocus)
          ? navOptions.settingsFocus
          : null;
      const targetHash = routeToHash(route, nextFocus);
      if (win) {
        if (navOptions.replace) {
          replaceHashInPlace(route, nextFocus);
        } else if (win.location.hash !== targetHash) {
          win.location.hash = targetHash;
        }
      }
      if (route !== snapshot.route || nextFocus !== snapshot.settingsFocus) {
        snapshot = { route, settingsFocus: nextFocus };
        emit();
      }
    },

    ensureCanonicalHash(): void {
      syncFromLocation(true);
    },

    dispose(): void {
      disposed = true;
      win?.removeEventListener("hashchange", onHashChange);
      listeners.clear();
    },
  };
}

/** Shared browser hash-router instance. */
export const routerStore: RouterStore = createRouterStore();

/**
 * React hook returning the active hash route, optional Settings focus, and navigation helper.
 */
export function useRouter(store: RouterStore = routerStore): {
  readonly route: RouteId;
  readonly settingsFocus: SettingsFocus | null;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
} {
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return {
    route: state.route,
    settingsFocus: state.settingsFocus,
    navigate: store.navigate,
  };
}
