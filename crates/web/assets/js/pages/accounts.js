import {
  openAddAccountDialog,
  openRemoveAccountDialog,
  openSwitchAccountDialog,
} from "../account-dialogs.js";
import {
  alertBox,
  badge,
  busyLine,
  clear,
  el,
  emptyState,
  inlineMessage,
} from "../components.js";
import {
  formatAge,
  formatApiError,
  formatCu,
  formatCuRate,
  formatEmail,
  formatErrorKind,
  formatTimeLeft,
} from "../format.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  adoptAccount,
  clearAccountNotice,
  dismissRecoveredNotice,
  getAccountTotals,
  getAccountsView,
  getRemoveBlock,
  getUnmanagedAccounts,
  getUsageForAccount,
  loadOverview,
  refreshAccountsUsage,
  state,
} from "../store.js";

export function createAccountsPage({ navigate }) {
  let root = null;
  let headerEl = null;
  let bodyEl = null;

  function resolveStatus() {
    const overview = state.overview;
    const accountsError = state.snapshot?.accounts_error || overview?.accounts_error || null;
    const view = getAccountsView();

    if (accountsError === "not_installed" || (overview && overview.cli_installed === false)) {
      return { kind: "needs_cli" };
    }
    if (
      accountsError === "keyring_unavailable" ||
      overview?.keyring?.status === "unavailable"
    ) {
      return { kind: "keyring_unavailable", hintKey: overview?.keyring?.hint_key || null };
    }
    if (accountsError && !view) {
      return { kind: "failed", error: accountsError };
    }
    if (!view) {
      return { kind: "checking" };
    }
    if (view.unadopted) {
      return { kind: "unadopted", email: view.active_email || null, view };
    }
    if (view.active) {
      return { kind: "signed_in", view };
    }
    return { kind: "signed_out", view };
  }

  function renderHeader(status) {
    if (!headerEl) return;
    const canAdd =
      status.kind === "signed_in" ||
      status.kind === "signed_out" ||
      status.kind === "unadopted";
    clear(headerEl);
    headerEl.append(
      el(
        "div",
        { className: "page-header-heading" },
        el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t("app.nav.accounts")),
        el("p", { className: "page-subtitle" }, t("app.accounts.subtitle"))
      ),
      el(
        "div",
        { className: "page-header-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            dataset: { accountsAdd: "true" },
            disabled: !canAdd,
            onClick: () => openAddAccountDialog(),
          },
          icon("userPlus"),
          t("app.action.add_account")
        )
      )
    );
  }

  function renderTotalsCard() {
    const summary = getAccountTotals();
    const known = summary.known > 0;
    const balance = known ? formatCu(summary.balanceCu) : t("app.summary.unknown");
    const rate = known ? formatCuRate(summary.rateCuPerHour) : t("app.summary.unknown");
    const runtimes = known ? String(summary.runtimes) : t("app.summary.unknown");

    const missingText =
      summary.unknown > 0
        ? summary.unknown === 1
          ? t("app.accounts.total.missing_one")
          : t("app.accounts.total.missing_many", { count: summary.unknown })
        : null;

    const refreshBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-ghost btn-icon",
        dataset: { accountsRefresh: "true" },
        "aria-label": t("app.usage.refresh"),
        title: t("app.usage.refresh"),
        disabled: state.accountsBusy.refresh,
        onClick: () => {
          void refreshAccountsUsage().catch(() => {});
        },
      },
      icon("refresh")
    );

    const cell = (label, value) =>
      el(
        "div",
        { className: "kpi-tile" },
        el("span", { className: "kpi-label" }, label),
        el("span", { className: "totals-value" }, value)
      );

    return el(
      "section",
      { className: "card card-compact", dataset: { accountsTotals: "true" } },
      el(
        "div",
        { className: "card-header" },
        el("h2", { className: "card-title" }, t("app.accounts.total.title")),
        refreshBtn
      ),
      el(
        "div",
        { className: "kpi-grid" },
        cell(t("app.accounts.balance"), balance),
        cell(t("app.accounts.rate"), rate),
        cell(t("app.summary.runtimes"), runtimes)
      ),
      missingText ? el("p", { className: "caption" }, missingText) : null,
      state.accountsUsageError
        ? inlineMessage({
            tone: "warning",
            text: formatApiError(state.accountsUsageError).message,
          })
        : null
    );
  }

  function renderUnmanagedWarning() {
    const unmanaged = getUnmanagedAccounts();
    if (unmanaged.length === 0) {
      return null;
    }
    const counted = unmanaged.filter((item) => item.count !== null);
    let titleKey = "app.unmanaged.title";
    if (counted.length === 0) {
      titleKey = "app.unmanaged.unknown_title";
    } else if (counted.every((item) => item.stale)) {
      titleKey = "app.unmanaged.last_title";
    }
    const lines = unmanaged.map((item) => {
      const email = formatEmail(item.email);
      if (item.count === null) {
        return t("app.unmanaged.unknown", { email });
      }
      if (item.stale) {
        return item.count === 1
          ? t("app.unmanaged.last_one", { email })
          : t("app.unmanaged.last_many", { email, count: item.count });
      }
      return item.count === 1
        ? t("app.unmanaged.one", { email })
        : t("app.unmanaged.many", { email, count: item.count });
    });

    return alertBox({
      tone: "warning",
      title: t(titleKey),
      body: lines.join("\n"),
      actions: el(
        "button",
        {
          type: "button",
          className: "btn btn-sm",
          onClick: () => navigate("sessions"),
        },
        t("app.action.view_sessions")
      ),
    });
  }

  function renderAccountCard(account, active, busy) {
    const email = formatEmail(account.email);
    const usage = getUsageForAccount(account.id, account);
    const snap = usage?.snapshot || null;
    const stale = Boolean(snap?.stale);
    const block = getRemoveBlock(account.id);
    const blockReason =
      block === "active"
        ? t("app.accounts.remove_active")
        : block === "running"
          ? t("app.accounts.remove_running")
          : null;

    const actions = [];
    if (!active) {
      actions.push(
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            dataset: { accountSwitch: account.id },
            disabled: busy,
            onClick: () => openSwitchAccountDialog(account),
          },
          t("app.accounts.switch")
        )
      );
    }
    actions.push(
      el(
        "button",
        {
          type: "button",
          className: "btn btn-sm btn-ghost",
          dataset: { accountRemove: account.id },
          disabled: busy || block !== null,
          title: blockReason || null,
          onClick: () => openRemoveAccountDialog(account),
        },
        icon("trash2"),
        t("app.accounts.remove")
      )
    );

    const stat = (label, value) =>
      el(
        "div",
        { className: "account-stat" },
        el("span", { className: "account-stat-label" }, label),
        el("span", { className: "account-stat-value" }, value)
      );

    const balance = snap ? formatCu(snap.balance_cu) : t("app.summary.unknown");
    const rate = snap ? formatCuRate(snap.rate_cu_per_hour) : t("app.summary.unknown");
    const left = formatTimeLeft(usage);
    const updated = snap ? formatAge(snap.fetched_at) : t("app.summary.unknown");

    const usageFailure =
      usage?.last_error && (!snap || stale)
        ? inlineMessage({
            tone: "warning",
            text: `${t("app.accounts.usage_failed")} ${formatApiError(usage.last_error).message}`,
          })
        : null;

    return el(
      "article",
      {
        className: "card card-compact",
        dataset: { accountCard: account.id, accountActive: active ? "true" : "false" },
      },
      el(
        "div",
        { className: "account-card-header" },
        el(
          "div",
          { className: "account-identity" },
          el("span", { className: "account-email" }, email),
          active ? badge(t("app.accounts.active"), "success") : null
        ),
        el("div", { className: "account-actions" }, actions)
      ),
      el(
        "div",
        { className: "account-stats-grid" },
        stat(t("app.accounts.balance"), balance),
        stat(t("app.accounts.rate"), rate),
        stat(t("app.accounts.time_left"), left),
        stat(t("app.accounts.updated"), updated),
        stale ? badge(t("app.usage.outdated"), "warning") : null
      ),
      usageFailure,
      blockReason ? el("p", { className: "account-block-note" }, blockReason) : null
    );
  }

  function renderBody(status) {
    if (!bodyEl) return;
    clear(bodyEl);

    if (status.kind === "checking") {
      bodyEl.appendChild(busyLine(t("app.accounts.loading")));
      return;
    }

    if (status.kind === "needs_cli") {
      bodyEl.appendChild(
        emptyState({
          iconName: "terminal",
          title: t("app.err.not_installed"),
          body: t("app.accounts.needs_cli"),
          action: el(
            "button",
            {
              type: "button",
              className: "btn",
              onClick: () => navigate("overview"),
            },
            t("app.action.install_cli")
          ),
        })
      );
      return;
    }

    if (status.kind === "keyring_unavailable") {
      bodyEl.appendChild(
        alertBox({
          tone: "danger",
          title: t("app.accounts.keyring.title"),
          body: status.hintKey ? t(status.hintKey) : t("app.accounts.keyring.body"),
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              onClick: () => {
                void loadOverview();
                void refreshAccountsUsage().catch(() => {});
              },
            },
            t("app.action.check_again")
          ),
        })
      );
      return;
    }

    if (status.kind === "failed") {
      bodyEl.appendChild(
        alertBox({
          tone: "danger",
          title: formatErrorKind(status.error),
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              onClick: () => {
                void refreshAccountsUsage().catch(() => {});
              },
            },
            t("app.action.retry")
          ),
        })
      );
      return;
    }

    const view = status.view;

    if (state.accountNotice) {
      bodyEl.appendChild(
        alertBox({
          tone: state.accountNotice.tone || "info",
          body: state.accountNotice.message,
          onDismiss: () => clearAccountNotice(),
          live: true,
        })
      );
    }

    if (view.recovered_pending_add && !state.dismissedRecovered) {
      bodyEl.appendChild(
        alertBox({
          tone: "info",
          title: t("app.accounts.recovered.title"),
          body: t("app.accounts.recovered.body"),
          onDismiss: () => dismissRecoveredNotice(),
        })
      );
    }

    if (status.kind === "unadopted") {
      const title = status.email
        ? t("app.accounts.unadopted.title", { email: status.email })
        : t("app.accounts.unadopted.title_no_email");
      bodyEl.appendChild(
        alertBox({
          tone: "info",
          title,
          body: t("app.accounts.unadopted.body"),
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-primary",
              disabled: state.accountsBusy.adopt,
              onClick: () => {
                void adoptAccount().catch(() => {});
              },
            },
            t("app.accounts.adopt")
          ),
        })
      );
    }

    const rows = Array.isArray(view.accounts) ? view.accounts : [];
    if (rows.length === 0) {
      bodyEl.appendChild(
        emptyState({
          iconName: "accounts",
          title: t("app.accounts.empty.title"),
          body: t("app.accounts.empty.body"),
          action: el(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: () => openAddAccountDialog(),
            },
            icon("userPlus"),
            t("app.action.add_account")
          ),
        })
      );
      return;
    }

    bodyEl.appendChild(renderTotalsCard());
    const unmanaged = renderUnmanagedWarning();
    if (unmanaged) {
      bodyEl.appendChild(unmanaged);
    }

    const busy = state.accountsBusy.switch || state.accountsBusy.remove;
    for (const account of rows) {
      bodyEl.appendChild(renderAccountCard(account, view.active === account.id, busy));
    }
  }

  function renderAll() {
    const status = resolveStatus();
    renderHeader(status);
    renderBody(status);
  }

  return {
    mount(container) {
      root = container;
      clear(root);
      headerEl = el("header", { className: "page-header page-header-row" });
      bodyEl = el("div", { className: "page-sections" });
      root.append(headerEl, bodyEl);
      renderAll();
      if (!state.overview && !state.overviewLoading) {
        void loadOverview({ silent: true });
      }
    },
    update(reason) {
      if (!root) return;
      if (
        reason === "locale" ||
        reason === "snapshot" ||
        reason === "overview" ||
        reason === "accounts"
      ) {
        renderAll();
      }
    },
    unmount() {
      root = null;
      headerEl = null;
      bodyEl = null;
    },
  };
}
