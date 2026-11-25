/**
 * Authenticated responsive application shell: desktop sidebar, mobile drawer
 * and topbar, active account area (with extension slot for #41 switcher),
 * live compute-unit usage badge, Demo data badge, connection/shutdown banners,
 * and route-aware focus/scroll management.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { buildUsageBadge, resolveActiveAccount } from "../lib/format.ts";
import type { TranslateFn } from "../lib/i18n.ts";
import { getRouteTitle, ROUTES, routeToHash, type RouteId } from "../lib/router.ts";
import type { ConnectionStatus } from "../lib/store.ts";
import type { Locale, Snapshot } from "../lib/types.ts";
import {
  AccountsIcon,
  AlertIcon,
  BrandIcon,
  CloseIcon,
  LogOutIcon,
  MenuIcon,
  OverviewIcon,
  PluginsIcon,
  SessionsIcon,
  SettingsIcon,
  UserIcon,
} from "./Icons.tsx";

const MOBILE_MEDIA_QUERY = "(max-width: 860px)";
const USAGE_CLOCK_INTERVAL_MS = 30_000;
const MS_PER_SECOND = 1000;

function readIsMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function renderNavIcon(route: RouteId) {
  switch (route) {
    case "overview":
      return <OverviewIcon />;
    case "sessions":
      return <SessionsIcon />;
    case "plugins":
      return <PluginsIcon />;
    case "accounts":
      return <AccountsIcon />;
    case "settings":
      return <SettingsIcon />;
  }
}

export interface AppShellProps {
  readonly route: RouteId;
  readonly snapshot: Snapshot | null;
  readonly connectionStatus: ConnectionStatus;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onNavigate: (route: RouteId) => void;
  readonly onSignOut: () => void;
  /** Optional replacement for the sidebar account area (used by the account switcher menu). */
  readonly accountSlot?: ReactNode;
  readonly children: ReactNode;
}

export function AppShell({
  route,
  snapshot,
  connectionStatus,
  locale,
  t,
  onNavigate,
  onSignOut,
  accountSlot,
  children,
}: AppShellProps) {
  const sidebarId = useId();
  const mainRef = useRef<HTMLElement | null>(null);
  const shellMainRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const [isMobile, setIsMobile] = useState<boolean>(readIsMobileViewport);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nowSecs, setNowSecs] = useState<number>(() => Math.floor(Date.now() / MS_PER_SECOND));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mq = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) {
        setDrawerOpen(false);
      }
    };
    update();
    mq.addEventListener("change", update);
    return () => {
      mq.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowSecs(Math.floor(Date.now() / MS_PER_SECOND));
    }, USAGE_CLOCK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    setDrawerOpen(false);
    if (restoreFocus) {
      menuButtonRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen, closeDrawer]);

  useEffect(() => {
    setDrawerOpen(false);
    if (shellMainRef.current) {
      shellMainRef.current.scrollTop = 0;
    }
    if (typeof window !== "undefined" && window.scrollY > 0) {
      window.scrollTo(0, 0);
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);

  const handleLinkClick = useCallback(
    (target: RouteId) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) {
        return;
      }
      event.preventDefault();
      closeDrawer(false);
      onNavigate(target);
    },
    [closeDrawer, onNavigate],
  );

  const handleSkipToMain = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // Keep the active `#/<route>` hash intact instead of letting the anchor clobber it.
    event.preventDefault();
    mainRef.current?.focus();
  }, []);

  const activeAccount = resolveActiveAccount(snapshot, t);
  const usageBadge = buildUsageBadge(activeAccount, nowSecs, locale, t);
  const isMock = snapshot?.backend === "mock";
  const isShuttingDown = snapshot?.shutting_down === true;
  const isReconnecting = connectionStatus === "reconnecting";
  const runtimeCount = snapshot?.runtimes?.runtimes.length ?? 0;

  const accountTitle = activeAccount.signedIn
    ? activeAccount.label
    : t("app.shell.account.hint");

  const drawerHidden = isMobile && !drawerOpen;

  return (
    <>
      <a
        className="skip-link visually-hidden"
        href="#main-content"
        onClick={handleSkipToMain}
      >
        {t("web.shell.skip_to_content")}
      </a>

      <div className={drawerOpen ? "shell drawer-open" : "shell"}>
        <div
          className="drawer-backdrop"
          aria-hidden="true"
          onClick={() => closeDrawer(true)}
        />

        <aside
          id={sidebarId}
          className="sidebar"
          role={isMobile && drawerOpen ? "dialog" : undefined}
          aria-modal={isMobile && drawerOpen ? "true" : undefined}
          aria-label={t("web.shell.primary_nav")}
          aria-hidden={drawerHidden ? "true" : undefined}
          inert={drawerHidden || undefined}
        >
          <div className="sidebar-brand">
            <div className="brand-mark">
              <BrandIcon />
              <span className="brand-name">{t("app.name")}</span>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              className="btn btn-ghost btn-icon sidebar-close"
              aria-label={t("web.shell.menu_close")}
              onClick={() => closeDrawer(true)}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="sidebar-body">
            <div className="sidebar-account-wrap">
              {accountSlot ?? (
                <a
                  href={routeToHash("accounts")}
                  className="sidebar-account"
                  title={accountTitle}
                  onClick={handleLinkClick("accounts")}
                >
                  <UserIcon />
                  <span className="sidebar-account-text">{activeAccount.label}</span>
                </a>
              )}
            </div>

            <nav aria-label={t("web.shell.primary_nav")}>
              <ul className="nav-list">
                {ROUTES.map((item) => {
                  const active = route === item;
                  return (
                    <li key={item}>
                      <a
                        href={routeToHash(item)}
                        className="nav-link"
                        aria-current={active ? "page" : undefined}
                        onClick={handleLinkClick(item)}
                      >
                        {renderNavIcon(item)}
                        <span className="nav-label">{getRouteTitle(item, t)}</span>
                        {item === "sessions" && runtimeCount > 0 && (
                          <span className="nav-count">{runtimeCount}</span>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="sidebar-spacer" />

            <div className="sidebar-footer">
              <div className="sidebar-badges">
                <span
                  className={usageBadge.tone === "warning" ? "badge badge-warning" : "badge"}
                  title={usageBadge.tooltip}
                >
                  {usageBadge.text}
                </span>
                {isMock && (
                  <span
                    className="badge badge-warning"
                    title={t("app.shell.backend.mock.hint")}
                  >
                    {t("app.shell.backend.mock")}
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn btn-ghost sidebar-signout"
                onClick={onSignOut}
              >
                <LogOutIcon />
                <span>{t("web.shell.sign_out")}</span>
              </button>
            </div>
          </div>
        </aside>

        <div ref={shellMainRef} className="shell-main">
          <header className="topbar">
            <div className="topbar-left">
              <button
                ref={menuButtonRef}
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={drawerOpen ? t("web.shell.menu_close") : t("web.shell.menu_open")}
                aria-expanded={drawerOpen}
                aria-controls={sidebarId}
                onClick={() => setDrawerOpen((prev) => !prev)}
              >
                <MenuIcon />
              </button>
              <div className="brand-mark topbar-brand">
                <BrandIcon />
                <span className="brand-name">{t("app.name")}</span>
              </div>
            </div>

            <div className="topbar-right">
              {isMock && (
                <span
                  className="badge badge-warning"
                  title={t("app.shell.backend.mock.hint")}
                >
                  {t("app.shell.backend.mock")}
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm topbar-signout"
                onClick={onSignOut}
              >
                <LogOutIcon />
                <span>{t("web.shell.sign_out")}</span>
              </button>
            </div>
          </header>

          {(isShuttingDown || isReconnecting) && (
            <div className="status-banner">
              {isShuttingDown && (
                <div className="alert alert-warning" role="alert">
                  <span className="alert-icon icon-warning">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-body">{t("web.shell.shutting_down")}</p>
                  </div>
                </div>
              )}

              {isReconnecting && (
                <div className="alert alert-warning" role="status" aria-live="polite">
                  <span className="alert-icon icon-warning">
                    <AlertIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-body">{t("web.shell.reconnecting")}</p>
                  </div>
                </div>
              )}
            </div>
          )}

          <main ref={mainRef} id="main-content" className="page-host" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
