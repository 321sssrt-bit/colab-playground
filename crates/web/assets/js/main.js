import { alertBox, badge, clear, el } from "./components.js";
import { formatEmail, formatUsageBadge } from "./format.js";
import { initI18n, onLocaleChange, t } from "./i18n.js";
import { icon } from "./icons.js";
import { createLoginPage } from "./pages/login.js";
import { createOverviewPage } from "./pages/overview.js";
import { createPlaceholderPage } from "./pages/placeholder.js";
import { createSettingsPage } from "./pages/settings.js";
import { getActiveEmail, getActiveUsage, handleSessionLost, state, subscribe } from "./store.js";
import { initTheme, onThemeChange } from "./theme.js";

const ROUTES = [
  { id: "overview", titleKey: "app.nav.overview", iconName: "overview" },
  { id: "sessions", titleKey: "app.nav.sessions", iconName: "sessions" },
  { id: "plugins", titleKey: "app.nav.plugins", iconName: "plugins" },
  { id: "accounts", titleKey: "app.nav.accounts", iconName: "accounts" },
  { id: "settings", titleKey: "app.nav.settings", iconName: "settings" },
];

const DEFAULT_ROUTE = "overview";

function parseHashRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  return ROUTES.some((r) => r.id === raw) ? raw : DEFAULT_ROUTE;
}

class AppShellController {
  constructor(mountNode) {
    this.mountNode = mountNode;
    this.route = parseHashRoute();
    this.drawerOpen = false;
    this.activePage = null;
    this.activeRouteId = null;
    this.shellMounted = false;

    this.shellEl = null;
    this.skipLinkEl = null;
    this.sidebarEl = null;
    this.shellMainEl = null;
    this.topbarEl = null;
    this.bannerEl = null;
    this.pageHostEl = null;

    this.loginPage = createLoginPage();
    this.pages = {
      overview: createOverviewPage({ navigate: (id) => this.navigate(id) }),
      sessions: createPlaceholderPage({
        titleKey: "app.nav.sessions",
        subtitleKey: "app.sessions.subtitle",
      }),
      plugins: createPlaceholderPage({
        titleKey: "app.nav.plugins",
        subtitleKey: "app.plugins.subtitle",
      }),
      accounts: createPlaceholderPage({
        titleKey: "app.nav.accounts",
        subtitleKey: "app.accounts.subtitle",
      }),
      settings: createSettingsPage(),
    };
  }

  start() {
    window.addEventListener("hashchange", () => {
      const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0];
      if (raw === "main-content") {
        const target = this.pageHostEl?.querySelector("#page-heading") || this.pageHostEl;
        if (target) target.focus();
        return;
      }
      const next = parseHashRoute();
      if (next !== this.route) {
        this.route = next;
        this.closeDrawer();
        if (state.authenticated) {
          this.mountCurrentRoute({ focusMain: true });
          this.renderChrome();
        }
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.drawerOpen) {
        this.closeDrawer({ restoreFocus: true });
      }
    });

    subscribe((_, reason) => {
      if (reason === "auth") {
        this.syncAuthMode();
        return;
      }
      if (!state.authenticated) {
        this.loginPage.update(reason);
        return;
      }
      this.renderChrome();
      if (this.activePage) {
        this.activePage.update(reason);
      }
    });

    onLocaleChange(() => {
      this.updateTitle();
      if (!state.authenticated) {
        this.loginPage.update("locale");
      } else {
        this.renderChrome();
        if (this.activePage) {
          this.activePage.update("locale");
        }
      }
    });

    onThemeChange(() => {
      if (!state.authenticated) {
        this.loginPage.update("theme");
      } else if (this.activePage) {
        this.activePage.update("theme");
      }
    });

    this.syncAuthMode();
  }

  navigate(routeId) {
    if (!ROUTES.some((r) => r.id === routeId)) {
      return;
    }
    this.closeDrawer();
    if (window.location.hash !== `#/${routeId}`) {
      window.location.hash = `#/${routeId}`;
    } else if (this.route !== routeId) {
      this.route = routeId;
      this.mountCurrentRoute({ focusMain: true });
      this.renderChrome();
    }
  }

  updateTitle() {
    if (!state.authenticated) {
      document.title = `${t("web.login.title")} · ${t("app.name")}`;
      return;
    }
    const route = ROUTES.find((r) => r.id === this.route) || ROUTES[0];
    document.title = `${t(route.titleKey)} · ${t("app.name")}`;
  }

  syncAuthMode() {
    if (this.activePage) {
      this.activePage.unmount();
      this.activePage = null;
      this.activeRouteId = null;
    }
    clear(this.mountNode);
    this.shellMounted = false;
    this.shellMainEl = null;
    this.drawerOpen = false;

    if (!state.authenticated) {
      this.loginPage.mount(this.mountNode);
      this.updateTitle();
      return;
    }

    this.loginPage.unmount();
    this.buildShell();
    this.renderChrome();
    this.mountCurrentRoute();
  }

  buildShell() {
    this.sidebarEl = el("aside", { className: "sidebar" });
    this.topbarEl = el("header", { className: "topbar" });
    this.bannerEl = el("div", { className: "status-banner", hidden: true });
    this.pageHostEl = el("main", { id: "main-content", className: "page-host", tabindex: "-1" });
    const backdrop = el("div", {
      className: "drawer-backdrop",
      onClick: () => this.closeDrawer({ restoreFocus: true }),
    });
    this.skipLinkEl = el(
      "a",
      {
        href: "#main-content",
        className: "skip-link visually-hidden",
        onClick: (event) => {
          event.preventDefault();
          const target = this.pageHostEl?.querySelector("#page-heading") || this.pageHostEl;
          if (target) target.focus();
        },
      },
      t("web.shell.skip_to_content")
    );

    this.shellMainEl = el(
      "div",
      { className: "shell-main" },
      this.topbarEl,
      this.bannerEl,
      this.pageHostEl
    );
    this.shellEl = el(
      "div",
      { className: "shell" },
      this.skipLinkEl,
      backdrop,
      this.sidebarEl,
      this.shellMainEl
    );
    this.mountNode.appendChild(this.shellEl);
    this.shellMounted = true;
  }

  openDrawer() {
    this.drawerOpen = true;
    if (this.shellEl) {
      this.shellEl.classList.add("drawer-open");
      const closeBtn = this.sidebarEl?.querySelector('[data-drawer-close="true"]');
      if (closeBtn) closeBtn.focus();
    }
  }

  closeDrawer({ restoreFocus = false } = {}) {
    if (!this.drawerOpen) return;
    this.drawerOpen = false;
    if (this.shellEl) {
      this.shellEl.classList.remove("drawer-open");
      if (restoreFocus) {
        const menuBtn = this.topbarEl?.querySelector('[data-drawer-open="true"]');
        if (menuBtn) menuBtn.focus();
      }
    }
  }

  mountCurrentRoute({ focusMain = false } = {}) {
    if (!this.pageHostEl) return;
    if (this.activeRouteId === this.route && this.activePage) {
      return;
    }
    if (this.activePage) {
      this.activePage.unmount();
    }
    this.activeRouteId = this.route;
    this.activePage = this.pages[this.route] || this.pages[DEFAULT_ROUTE];
    this.activePage.mount(this.pageHostEl);
    // Reset scroll position on route change (mirrors desktop RootView::render).
    if (this.shellMainEl) {
      this.shellMainEl.scrollTop = 0;
    }
    if (window.scrollY > 0) {
      window.scrollTo(0, 0);
    }
    if (focusMain) {
      const heading = this.pageHostEl.querySelector("#page-heading") || this.pageHostEl;
      heading.focus({ preventScroll: true });
    }
    this.updateTitle();
  }

  renderChrome() {
    if (!this.shellMounted) return;
    if (this.skipLinkEl) {
      this.skipLinkEl.textContent = t("web.shell.skip_to_content");
    }
    const isMock = state.snapshot?.backend === "mock";
    const activeEmail = getActiveEmail();
    const accountLabel = activeEmail
      ? formatEmail(activeEmail)
      : t("app.shell.account.signed_out");
    const usageInfo = formatUsageBadge(getActiveUsage());
    const hasUpdate = Boolean(state.updates?.update_available);

    const signOut = () => handleSessionLost({ expired: false });

    // Sidebar (1:1 mirror of titlebar.rs + sidebar.rs)
    clear(this.sidebarEl);
    this.sidebarEl.append(
      el(
        "div",
        { className: "sidebar-brand" },
        el(
          "div",
          { className: "brand-mark" },
          icon("zap", "icon-accent"),
          el("span", { className: "brand-name" }, t("app.name"))
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost btn-icon sidebar-close",
            dataset: { drawerClose: "true" },
            "aria-label": t("web.shell.menu_close"),
            onClick: () => this.closeDrawer({ restoreFocus: true }),
          },
          icon("x")
        )
      ),
      el(
        "div",
        { className: "sidebar-body" },
        el(
          "button",
          {
            type: "button",
            className: "sidebar-account",
            title: accountLabel,
            onClick: () => this.navigate("accounts"),
          },
          icon("user", "icon-muted"),
          el("span", { className: "sidebar-account-text" }, accountLabel),
          icon("chevronDown", "icon-subtle")
        ),
        el(
          "nav",
          { "aria-label": t("web.shell.primary_nav") },
          el(
            "ul",
            { className: "nav-list" },
            ROUTES.map((item) =>
              el(
                "li",
                null,
                el(
                  "a",
                  {
                    href: `#/${item.id}`,
                    className: "nav-link",
                    "aria-current": item.id === this.route ? "page" : null,
                    onClick: () => this.closeDrawer(),
                  },
                  icon(item.iconName),
                  el("span", { className: "nav-label" }, t(item.titleKey)),
                  hasUpdate && item.id === "settings"
                    ? el("span", { className: "nav-count" }, t("app.b7.update_badge"))
                    : null
                )
              )
            )
          )
        ),
        el("div", { className: "sidebar-spacer" }),
        el(
          "div",
          { className: "sidebar-footer" },
          el(
            "div",
            { className: "sidebar-badges" },
            badge(usageInfo.text, usageInfo.stale ? "warning" : "neutral"),
            isMock
              ? el(
                  "span",
                  { title: t("app.shell.backend.mock.hint") },
                  badge(t("app.shell.backend.mock"), "warning")
                )
              : null
          ),
          el(
            "button",
            {
              type: "button",
              className: "btn btn-ghost sidebar-signout",
              onClick: signOut,
            },
            icon("logOut"),
            t("web.shell.sign_out")
          )
        )
      )
    );

    // Mobile-only compact single-line top bar (hidden on desktop)
    clear(this.topbarEl);
    this.topbarEl.append(
      el(
        "div",
        { className: "topbar-left" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost btn-icon",
            dataset: { drawerOpen: "true" },
            "aria-label": t("web.shell.menu_open"),
            "aria-expanded": String(this.drawerOpen),
            onClick: () => this.openDrawer(),
          },
          icon("menu")
        ),
        el(
          "div",
          { className: "brand-mark topbar-brand" },
          icon("zap", "icon-accent"),
          el("span", { className: "brand-name" }, t("app.name"))
        )
      ),
      el(
        "div",
        { className: "topbar-right" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost topbar-signout",
            onClick: signOut,
          },
          icon("logOut"),
          t("web.shell.sign_out")
        )
      )
    );

    // Connection / shutdown banner
    clear(this.bannerEl);
    if (state.snapshot?.shutting_down) {
      this.bannerEl.hidden = false;
      this.bannerEl.appendChild(
        alertBox({ tone: "warning", body: t("web.shell.shutting_down"), live: true })
      );
    } else if (state.connection === "reconnecting") {
      this.bannerEl.hidden = false;
      this.bannerEl.appendChild(
        alertBox({ tone: "warning", body: t("web.shell.reconnecting"), live: true })
      );
    } else {
      this.bannerEl.hidden = true;
    }

    this.updateTitle();
  }
}

async function boot() {
  initTheme();
  await initI18n();
  const mountNode = document.getElementById("app");
  if (!mountNode) return;
  const app = new AppShellController(mountNode);
  app.start();
}

void boot();
