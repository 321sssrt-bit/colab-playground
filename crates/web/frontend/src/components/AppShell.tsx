/**
 * Authenticated responsive application shell: desktop sidebar, mobile modal
 * drawer and two-row topbar (brand, Demo data, sign out, active account, and
 * compute-unit usage badge), connection/shutdown banners, and route-aware
 * focus/scroll management.
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

import { buildUsageBadge, resolveActiveAccount, useUsageClockSecs } from "../lib/format.ts";
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
const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export type AccountSlotPlacement = "sidebar" | "topbar";

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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
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
  readonly reconnectAttempt: number;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onNavigate: (route: RouteId) => void;
  readonly onSignOut: () => void;
  /** Optional hook notified when the mobile modal drawer opens or closes. */
  readonly onModalDrawerChange?: (open: boolean) => void;
  /** Optional renderer replacing the account area in both sidebar and mobile topbar (for #41). */
  readonly renderAccountSlot?: (placement: AccountSlotPlacement) => ReactNode;
  readonly children: ReactNode;
}

export function AppShell({
  route,
  snapshot,
  connectionStatus,
  reconnectAttempt,
  locale,
  t,
  onNavigate,
  onSignOut,
  onModalDrawerChange,
  renderAccountSlot,
  children,
}: AppShellProps) {
  const sidebarId = useId();
  const sidebarRef = useRef<HTMLElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const shellMainRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusRef = useRef<"menu" | "main" | null>(null);

  const [isMobile, setIsMobile] = useState<boolean>(readIsMobileViewport);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const nowSecs = useUsageClockSecs();

  const modalDrawerOpen = isMobile && drawerOpen;
  const drawerHidden = isMobile && !drawerOpen;
  const modalDrawerOpenRef = useRef(modalDrawerOpen);
  modalDrawerOpenRef.current = modalDrawerOpen;

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
    onModalDrawerChange?.(modalDrawerOpen);
    return () => {
      onModalDrawerChange?.(false);
    };
  }, [modalDrawerOpen, onModalDrawerChange]);

  const focusMainRegion = useCallback(() => {
    if (shellMainRef.current) {
      shellMainRef.current.scrollTop = 0;
    }
    if (typeof window !== "undefined" && window.scrollY > 0) {
      window.scrollTo(0, 0);
    }
    mainRef.current?.focus({ preventScroll: true });
  }, []);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    pendingFocusRef.current = restoreFocus ? "menu" : null;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    if (!modalDrawerOpen) {
      // Run deferred focus moves after React commits `inert` removal on `.shell-main`.
      const pending = pendingFocusRef.current;
      pendingFocusRef.current = null;
      if (pending === "menu") {
        menuButtonRef.current?.focus();
      } else if (pending === "main") {
        focusMainRegion();
      }
      return;
    }

    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer(true);
        return;
      }
      if (event.key === "Tab" && sidebarRef.current) {
        const focusable = getFocusableElements(sidebarRef.current);
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey) {
          if (!active || active === first || !sidebarRef.current.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (!active || active === last || !sidebarRef.current.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [modalDrawerOpen, closeDrawer, focusMainRegion]);

  useEffect(() => {
    if (modalDrawerOpenRef.current) {
      pendingFocusRef.current = "main";
      setDrawerOpen(false);
      return;
    }
    setDrawerOpen(false);
    focusMainRegion();
  }, [route, focusMainRegion]);

  const handleLinkClick = useCallback(
    (target: RouteId) => (event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) {
        return;
      }
      event.preventDefault();
      if (target === route) {
        if (modalDrawerOpen) {
          pendingFocusRef.current = "main";
          setDrawerOpen(false);
        } else {
          setDrawerOpen(false);
          focusMainRegion();
        }
        return;
      }
      pendingFocusRef.current = null;
      setDrawerOpen(false);
      onNavigate(target);
    },
    [focusMainRegion, modalDrawerOpen, onNavigate, route],
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
  // Keep the reconnecting banner visible throughout active retry handshakes (`connecting` with attempt > 0).
  const isReconnecting =
    connectionStatus === "reconnecting" ||
    (connectionStatus === "connecting" && reconnectAttempt > 0);
  const runtimeCount = snapshot?.runtimes?.runtimes.length ?? 0;

  const accountTitle = activeAccount.signedIn
    ? activeAccount.label
    : t("app.shell.account.hint");

  const defaultSidebarAccount = (
    <a
      href={routeToHash("accounts")}
      className="sidebar-account"
      title={accountTitle}
      onClick={handleLinkClick("accounts")}
    >
      <UserIcon />
      <span className="sidebar-account-text">{activeAccount.label}</span>
    </a>
  );

  const defaultTopbarAccount = (
    <a
      href={routeToHash("accounts")}
      className="topbar-account"
      title={accountTitle}
      onClick={handleLinkClick("accounts")}
    >
      <UserIcon />
      <span className="topbar-account-text">{activeAccount.label}</span>
    </a>
  );

  return (
    <>
      <a
        className="skip-link visually-hidden"
        href="#main-content"
        aria-hidden={modalDrawerOpen ? "true" : undefined}
        inert={modalDrawerOpen || undefined}
        onClick={handleSkipToMain}
      >
        {t("web.shell.skip_to_content")}
      </a>

      <div className={modalDrawerOpen ? "shell drawer-open" : "shell"}>
        <div
          className="drawer-backdrop"
          aria-hidden="true"
          onClick={() => closeDrawer(true)}
        />

        <aside
          ref={sidebarRef}
          id={sidebarId}
          className="sidebar"
          role={modalDrawerOpen ? "dialog" : undefined}
          aria-modal={modalDrawerOpen ? "true" : undefined}
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
              {renderAccountSlot ? renderAccountSlot("sidebar") : defaultSidebarAccount}
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

        <div
          ref={shellMainRef}
          className="shell-main"
          aria-hidden={modalDrawerOpen ? "true" : undefined}
          inert={modalDrawerOpen || undefined}
        >
          <header className="topbar">
            <div className="topbar-row">
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
            </div>

            <div className="topbar-meta">
              <div className="topbar-account-wrap">
                {renderAccountSlot ? renderAccountSlot("topbar") : defaultTopbarAccount}
              </div>
              <span
                className={usageBadge.tone === "warning" ? "badge badge-warning" : "badge"}
                title={usageBadge.tooltip}
              >
                {usageBadge.text}
              </span>
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
