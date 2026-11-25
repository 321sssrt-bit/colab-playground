import {
  initAccountDialogs,
  openAddAccountDialog,
  openSwitchAccountDialog,
} from "./account-dialogs.js";
import { alertBox, badge, clear, el, toastCard } from "./components.js";
import { formatEmail, formatUsageBadge, formatUsageTip } from "./format.js";
import { initI18n, onLocaleChange, t } from "./i18n.js";
import { icon } from "./icons.js";
import { createAccountsPage } from "./pages/accounts.js";
import { createLoginPage } from "./pages/login.js";
import { createOverviewPage } from "./pages/overview.js";
import { createPlaceholderPage } from "./pages/placeholder.js";
import { createSettingsPage } from "./pages/settings.js";
import {
  clearAccountNotice,
  getAccountsView,
  getActiveEmail,
  getActiveUsage,
  handleSessionLost,
  state,
  subscribe,
} from "./store.js";
import { initTheme, onThemeChange } from "./theme.js";

const SUPPORTS_POPOVER = Object.hasOwn(HTMLElement.prototype, "popover");
const SUPPORTS_ANCHOR_MENU =
  SUPPORTS_POPOVER &&
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("position-area", "block-end");
const SUPPORTS_INVOKER_COMMANDS = "commandForElement" in HTMLButtonElement.prototype;
const SUPPORTS_FOCUSGROUP = "focusGroup" in HTMLElement.prototype;

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
    this.sidebarBrandEl = null;
    this.sidebarAccountHostEl = null;
    this.sidebarNavEl = null;
    this.sidebarFooterEl = null;
    this.shellMainEl = null;
    this.topbarEl = null;
    this.bannerEl = null;
    this.pageHostEl = null;

    this.accountMenuOpen = false;
    this.accountMenuDirty = false;
    this.accountMenuEnterOnOpen = false;
    this.accountMenuPointerDown = false;
    this.accountMenuCloseFn = null;

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
      accounts: createAccountsPage({ navigate: (id) => this.navigate(id) }),
      settings: createSettingsPage(),
    };
  }

  start() {
    initAccountDialogs();

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
        this.closeAccountMenu();
        this.closeDrawer();
        if (state.authenticated) {
          this.mountCurrentRoute({ focusMain: true });
          this.renderChrome();
        }
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (this.accountMenuOpen) {
          this.closeAccountMenu({ restoreFocus: true });
          return;
        }
        if (this.drawerOpen) {
          this.closeDrawer({ restoreFocus: true });
        }
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (!this.accountMenuOpen || SUPPORTS_ANCHOR_MENU) return;
      if (!this.sidebarAccountHostEl?.contains(event.target)) {
        this.closeAccountMenu();
      }
    });

    document.addEventListener("focusin", (event) => {
      if (!this.accountMenuOpen) return;
      if (!this.sidebarAccountHostEl?.contains(event.target)) {
        this.closeAccountMenu();
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
    this.closeAccountMenu();
    if (this.activePage) {
      this.activePage.unmount();
      this.activePage = null;
      this.activeRouteId = null;
    }
    clear(this.mountNode);
    this.shellMounted = false;
    this.sidebarEl = null;
    this.sidebarBrandEl = null;
    this.sidebarAccountHostEl = null;
    this.sidebarNavEl = null;
    this.sidebarFooterEl = null;
    this.shellMainEl = null;
    this.drawerOpen = false;

    if (!state.authenticated) {
      this.renderToastViewport();
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
    this.sidebarBrandEl = el("div", { className: "sidebar-brand" });
    this.sidebarAccountHostEl = el("div", { className: "sidebar-account-wrap" });
    this.sidebarNavEl = el("nav");
    this.sidebarFooterEl = el("div", { className: "sidebar-footer" });
    this.sidebarEl = el(
      "aside",
      { className: "sidebar" },
      this.sidebarBrandEl,
      el(
        "div",
        { className: "sidebar-body" },
        this.sidebarAccountHostEl,
        this.sidebarNavEl,
        el("div", { className: "sidebar-spacer" }),
        this.sidebarFooterEl
      )
    );
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

  closeAccountMenu({ restoreFocus = false } = {}) {
    if (this.accountMenuCloseFn) {
      this.accountMenuCloseFn({ restoreFocus });
    }
    this.accountMenuOpen = false;
  }

  renderAccountSwitcher() {
    if (!this.sidebarAccountHostEl) return;
    clear(this.sidebarAccountHostEl);
    this.accountMenuCloseFn = null;
    this.accountMenuOpen = false;
    this.accountMenuDirty = false;

    const accountsView = getAccountsView();
    const accountsList = Array.isArray(accountsView?.accounts) ? accountsView.accounts : [];
    const signedIn = Boolean(accountsView?.active && accountsList.length > 0);

    if (!signedIn) {
      this.sidebarAccountHostEl.appendChild(
        el(
          "button",
          {
            type: "button",
            className: "sidebar-account",
            dataset: { sidebarAccount: "signed-out" },
            title: t("app.shell.account.hint"),
            onClick: () => this.navigate("accounts"),
          },
          icon("userPlus", "icon-muted"),
          el("span", { className: "sidebar-account-text" }, t("app.shell.account.signed_out"))
        )
      );
      return;
    }

    const activeEmail = formatEmail(getActiveEmail());
    const triggerId = "sidebar-account-trigger";
    const menuId = "sidebar-account-menu";
    const groupLabelId = "sidebar-account-group-label";

    const triggerAttrs = {
      id: triggerId,
      type: "button",
      className: "sidebar-account",
      dataset: { sidebarAccount: "switcher" },
      title: activeEmail,
      "aria-haspopup": "menu",
      "aria-expanded": "false",
    };
    if (SUPPORTS_ANCHOR_MENU) {
      if (SUPPORTS_INVOKER_COMMANDS) {
        triggerAttrs.commandfor = menuId;
        triggerAttrs.command = "toggle-popover";
      } else {
        triggerAttrs.popovertarget = menuId;
      }
    }

    const trigger = el(
      "button",
      triggerAttrs,
      icon("user", "icon-muted"),
      el("span", { className: "sidebar-account-text" }, activeEmail),
      icon("chevronDown", "icon-subtle")
    );

    const listEl = el("div", {
      className: "account-menu-list",
      focusgroup: "menu nomemory",
      "aria-labelledby": triggerId,
    });
    if (!SUPPORTS_FOCUSGROUP) {
      listEl.setAttribute("role", "menu");
    }

    const menuEl = el("div", {
      id: menuId,
      className: "account-menu-popover",
      popover: SUPPORTS_ANCHOR_MENU ? "auto" : null,
      hidden: SUPPORTS_ANCHOR_MENU ? null : true,
    });
    menuEl.appendChild(listEl);

    const focusFirstItem = () => {
      const first = listEl.querySelector("button:not(:disabled)");
      if (first) first.focus({ preventScroll: true });
    };

    const setOpenState = (open) => {
      this.accountMenuOpen = open;
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open && this.accountMenuDirty) {
        this.accountMenuDirty = false;
        this.renderAccountSwitcher();
      }
    };

    const closeMenu = ({ restoreFocus = false } = {}) => {
      if (SUPPORTS_ANCHOR_MENU) {
        if (menuEl.matches(":popover-open")) {
          menuEl.hidePopover();
        }
      } else if (!menuEl.hidden) {
        menuEl.hidden = true;
        setOpenState(false);
      }
      if (restoreFocus && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
    this.accountMenuCloseFn = closeMenu;

    const activateItem = (action) => {
      closeMenu();
      this.closeDrawer();
      action();
    };

    const radioItems = accountsList.map((account) => {
      const isActive = accountsView.active === account.id;
      const email = formatEmail(account.email);
      return el(
        "button",
        {
          type: "button",
          className: "account-menu-item",
          role: "menuitemradio",
          "aria-checked": isActive ? "true" : "false",
          dataset: { switcherAccount: account.id },
          onClick: () => {
            activateItem(() => {
              if (!isActive) {
                openSwitchAccountDialog(account);
              }
            });
          },
        },
        el("span", { className: "account-menu-item-label" }, email)
      );
    });

    const plainItemRole = SUPPORTS_FOCUSGROUP ? null : "menuitem";
    const addItem = el(
      "button",
      {
        type: "button",
        className: "account-menu-item",
        role: plainItemRole,
        dataset: { switcherAdd: "true" },
        onClick: () => activateItem(() => openAddAccountDialog()),
      },
      icon("userPlus", "icon-muted"),
      el("span", { className: "account-menu-item-label" }, t("app.switcher.add"))
    );

    const manageItem = el(
      "button",
      {
        type: "button",
        className: "account-menu-item",
        role: plainItemRole,
        dataset: { switcherManage: "true" },
        onClick: () => activateItem(() => this.navigate("accounts")),
      },
      icon("accounts", "icon-muted"),
      el("span", { className: "account-menu-item-label" }, t("app.switcher.manage"))
    );

    listEl.append(
      el("div", { id: groupLabelId, className: "account-menu-heading" }, t("app.switcher.group")),
      el("div", { className: "account-menu-group", role: "group", "aria-labelledby": groupLabelId }, radioItems),
      el("hr", { className: "account-menu-separator" }),
      addItem,
      manageItem
    );

    trigger.addEventListener("pointerdown", () => {
      this.accountMenuPointerDown = true;
    });

    trigger.addEventListener("click", () => {
      if (!SUPPORTS_ANCHOR_MENU) {
        const opening = menuEl.hidden;
        menuEl.hidden = !opening;
        setOpenState(opening);
        if (opening && !this.accountMenuPointerDown) {
          focusFirstItem();
        }
      } else if (!this.accountMenuPointerDown) {
        this.accountMenuEnterOnOpen = true;
      }
      this.accountMenuPointerDown = false;
    });

    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (this.accountMenuOpen) {
          focusFirstItem();
        } else if (SUPPORTS_ANCHOR_MENU) {
          this.accountMenuEnterOnOpen = true;
          trigger.click();
        } else {
          menuEl.hidden = false;
          setOpenState(true);
          focusFirstItem();
        }
      }
    });

    if (SUPPORTS_ANCHOR_MENU) {
      menuEl.addEventListener("toggle", (event) => {
        const opening = event.newState === "open";
        setOpenState(opening);
        if (opening && this.accountMenuEnterOnOpen) {
          this.accountMenuEnterOnOpen = false;
          focusFirstItem();
        } else {
          this.accountMenuEnterOnOpen = false;
        }
      });
    }

    listEl.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        closeMenu();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ restoreFocus: true });
        return;
      }
      if (
        !SUPPORTS_FOCUSGROUP &&
        ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        const items = [...listEl.querySelectorAll("button:not(:disabled)")];
        const current = items.indexOf(document.activeElement);
        if (current < 0 || items.length === 0) return;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        event.preventDefault();
        items[next].focus({ preventScroll: true });
      }
    });

    this.sidebarAccountHostEl.append(trigger, menuEl);
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
    this.closeAccountMenu();
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
    const activeUsage = getActiveUsage();
    const usageInfo = formatUsageBadge(activeUsage);
    const usageTip = formatUsageTip(activeUsage);
    const hasUpdate = Boolean(state.updates?.update_available);

    const signOut = () => handleSessionLost({ expired: false });

    // Brand strip (1:1 mirror of titlebar.rs)
    clear(this.sidebarBrandEl);
    this.sidebarBrandEl.append(
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
    );

    // Account switcher: isolate open popup menu from background SSE snapshot re-renders.
    if (this.accountMenuOpen) {
      this.accountMenuDirty = true;
    } else {
      this.renderAccountSwitcher();
    }

    this.sidebarNavEl.setAttribute("aria-label", t("web.shell.primary_nav"));
    clear(this.sidebarNavEl);
    this.sidebarNavEl.appendChild(
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
    );

    clear(this.sidebarFooterEl);
    this.sidebarFooterEl.append(
      el(
        "div",
        { className: "sidebar-badges" },
        el("span", { title: usageTip }, badge(usageInfo.text, usageInfo.stale ? "warning" : "neutral")),
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
      this.bannerEl.appendChild(
        alertBox({ tone: "warning", body: t("web.shell.shutting_down"), live: true })
      );
    } else if (state.connection === "reconnecting") {
      this.bannerEl.appendChild(
        alertBox({ tone: "warning", body: t("web.shell.reconnecting"), live: true })
      );
    }
    this.bannerEl.hidden = this.bannerEl.childElementCount === 0;

    this.renderToastViewport();
    this.updateTitle();
  }

  renderToastViewport() {
    const viewport = document.getElementById("toast-viewport");
    if (!viewport) return;
    clear(viewport);
    if (!state.authenticated || !state.accountNotice) {
      viewport.hidden = true;
      return;
    }
    viewport.hidden = false;
    viewport.appendChild(
      toastCard({
        tone: state.accountNotice.tone || "info",
        body: state.accountNotice.message,
        onDismiss: () => clearAccountNotice(),
      })
    );
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
