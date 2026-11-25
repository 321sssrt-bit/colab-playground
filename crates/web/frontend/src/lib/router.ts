/**
 * Hash-based router (`#/<route>`) for the five fixed top-level pages.
 *
 * Uses `#/<route>` exclusively because the embedded Web Server serves HTML only
 * at `/`, preserving direct bookmarks, reloads, and browser Back/Forward without 404s.
 */

import { useSyncExternalStore } from "react";

import type { TranslateFn } from "./i18n.ts";

export type RouteId = "overview" | "sessions" | "plugins" | "accounts" | "settings";

export const ROUTES: readonly RouteId[] = [
  "overview",
  "sessions",
  "plugins",
  "accounts",
  "settings",
];

export const DEFAULT_ROUTE: RouteId = "overview";

const ROUTE_SET: ReadonlySet<string> = new Set<string>(ROUTES);

const ROUTE_TITLE_KEYS = {
  overview: "app.nav.overview",
  sessions: "app.nav.sessions",
  plugins: "app.nav.plugins",
  accounts: "app.nav.accounts",
  settings: "app.nav.settings",
} as const;

const ROUTE_SUBTITLE_KEYS = {
  overview: "app.overview.subtitle",
  sessions: "app.sessions.subtitle",
  plugins: "app.plugins.subtitle",
  accounts: "app.accounts.subtitle",
  settings: "app.settings.subtitle",
} as const;

export interface ParsedHashRoute {
  readonly route: RouteId;
  readonly canonical: boolean;
}

export interface NavigateOptions {
  readonly replace?: boolean;
}

export interface RouterStoreOptions {
  readonly win?: Pick<
    Window,
    "location" | "history" | "addEventListener" | "removeEventListener"
  > | null;
}

export interface RouterStore {
  getRoute(): RouteId;
  subscribe(listener: () => void): () => void;
  navigate(route: RouteId, options?: NavigateOptions): void;
  ensureCanonicalHash(): void;
  dispose(): void;
}

export function isRouteId(value: string): value is RouteId {
  return ROUTE_SET.has(value);
}

export function routeToHash(route: RouteId): string {
  return `#/${route}`;
}

export function parseHashRoute(rawHash: string): ParsedHashRoute {
  const withoutHash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  const withoutLeadingSlash = withoutHash.startsWith("/") ? withoutHash.slice(1) : withoutHash;
  const segment = withoutLeadingSlash.split(/[/?]/, 1)[0]?.toLowerCase() ?? "";

  if (isRouteId(segment)) {
    const canonicalHash = routeToHash(segment);
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

export function getRouteSubtitle(route: RouteId, t: TranslateFn): string {
  return t(ROUTE_SUBTITLE_KEYS[route]);
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

  let currentRoute: RouteId = win ? parseHashRoute(win.location.hash).route : DEFAULT_ROUTE;
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

  const replaceHashInPlace = (route: RouteId): void => {
    if (!win) {
      return;
    }
    const targetHash = routeToHash(route);
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
    if (normalizeInvalid && !parsed.canonical) {
      replaceHashInPlace(parsed.route);
    }
    if (parsed.route !== currentRoute) {
      currentRoute = parsed.route;
      emit();
    }
  };

  const onHashChange = (): void => {
    syncFromLocation(true);
  };

  win?.addEventListener("hashchange", onHashChange);

  return {
    getRoute(): RouteId {
      return currentRoute;
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
      const targetHash = routeToHash(route);
      if (win) {
        if (navOptions.replace) {
          replaceHashInPlace(route);
        } else if (win.location.hash !== targetHash) {
          win.location.hash = targetHash;
        }
      }
      if (route !== currentRoute) {
        currentRoute = route;
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
 * React hook returning the active hash route and navigation helper.
 */
export function useRouter(store: RouterStore = routerStore): {
  readonly route: RouteId;
  readonly navigate: (route: RouteId, options?: NavigateOptions) => void;
} {
  const route = useSyncExternalStore(store.subscribe, store.getRoute, store.getRoute);
  return { route, navigate: store.navigate };
}
