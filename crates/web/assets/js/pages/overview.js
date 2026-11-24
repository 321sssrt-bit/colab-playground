import { alertBox, badge, clear, el } from "../components.js";
import {
  formatApiError,
  formatCu,
  formatCuRate,
  formatEmail,
  formatTimeLeft,
  installMethodLabel,
} from "../format.js";
import { localized, t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  adoptAccount,
  cancelCliInstall,
  getActiveEmail,
  getActiveUsage,
  loadOverview,
  refreshUsage,
  startCliInstall,
  state,
} from "../store.js";

const WSL_INSTALL_URL = "https://learn.microsoft.com/windows/wsl/install";

export function createOverviewPage({ navigate }) {
  let root = null;
  let chosenInstallMethod = null;
  let refreshingUsage = false;
  let adopting = false;

  let headerEl = null;
  let bodyEl = null;

  function isChecklistComplete(overview) {
    if (!overview) return false;
    const accounts = state.snapshot?.accounts || overview.accounts;
    return Boolean(
      overview.host?.ready &&
        overview.cli_installed &&
        overview.keyring?.status === "ready" &&
        accounts?.active
    );
  }

  function renderSummaryCard() {
    const usage = getActiveUsage();
    const snap = usage?.snapshot || null;
    const balance = snap ? formatCu(snap.balance_cu) : t("app.summary.unknown");
    const rate = snap ? formatCuRate(snap.rate_cu_per_hour) : t("app.summary.unknown");
    const left = formatTimeLeft(usage);

    const runtimesView = state.snapshot?.runtimes || null;
    const runtimesErr = state.snapshot?.runtimes_error || null;
    const accountsList = state.snapshot?.accounts?.accounts || state.overview?.accounts?.accounts || [];
    const incomplete = Boolean(runtimesErr || (runtimesView && runtimesView.errors.length > 0));
    let runtimesValue = t("app.summary.unknown");
    if (runtimesView && !runtimesErr) {
      runtimesValue = String(runtimesView.runtimes.length);
    }

    let runtimesNote = t("app.summary.runtimes_all");
    if (incomplete && runtimesView && runtimesView.errors.length > 0) {
      const emails = runtimesView.errors.map((e) => {
        const found = accountsList.find((a) => a.id === e.account);
        return formatEmail(found?.email);
      });
      runtimesNote =
        emails.length <= 2
          ? t("app.b10.summary_not_counted", { emails: emails.join(t("app.fmt.list_separator")) })
          : t("app.accounts.total.missing_many", { count: emails.length });
    }

    const activeEmail = formatEmail(getActiveEmail());
    const stale = Boolean(snap?.stale);

    const refreshBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-sm btn-ghost",
        disabled: refreshingUsage,
        onClick: async () => {
          refreshingUsage = true;
          renderBody();
          try {
            await refreshUsage();
          } finally {
            refreshingUsage = false;
            renderBody();
          }
        },
      },
      icon("refresh"),
      t("app.usage.refresh")
    );

    const tile = (label, value, extraBadge = null, note = null) =>
      el(
        "div",
        { className: "kpi-tile" },
        el("span", { className: "kpi-label" }, label),
        el(
          "div",
          { className: "kpi-value-row" },
          el("span", { className: "kpi-value" }, value),
          extraBadge
        ),
        note ? el("span", { className: "kpi-note" }, note) : null
      );

    return el(
      "section",
      { className: "card" },
      el(
        "div",
        { className: "card-header" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.summary.title")),
          el("p", { className: "card-desc" }, t("app.summary.active", { email: activeEmail }))
        ),
        el(
          "div",
          { className: "card-actions" },
          stale ? badge(t("app.usage.outdated"), "warning") : null,
          refreshBtn
        )
      ),
      el(
        "div",
        { className: "kpi-grid" },
        tile(t("app.summary.balance"), balance),
        tile(t("app.summary.rate"), rate),
        tile(t("app.summary.time_left"), left),
        tile(
          t("app.summary.runtimes"),
          runtimesValue,
          incomplete ? badge(t("app.b10.summary_incomplete"), "warning") : null,
          runtimesNote
        )
      ),
      stale ? alertBox({ tone: "warning", body: t("app.usage.tip.stale") }) : null
    );
  }

  function renderUnmanagedAlert(overview) {
    const unmanaged = overview?.unmanaged_runtimes;
    if (!unmanaged || !unmanaged.warning_key) {
      return null;
    }
    const body = t(unmanaged.warning_key, { count: unmanaged.count ?? 0 });
    const title = unmanaged.incomplete
      ? t("app.unmanaged.unknown_title")
      : t("app.unmanaged.title");
    return alertBox({
      tone: "warning",
      title,
      body,
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

  function renderChecklistCard(overview) {
    const checkAgainBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-sm btn-ghost",
        disabled: state.overviewLoading,
        onClick: () => {
          void loadOverview();
        },
      },
      icon("refresh"),
      t("app.action.check_again")
    );

    if (!overview) {
      return el(
        "section",
        { className: "card" },
        el(
          "div",
          { className: "card-header" },
          el(
            "div",
            { className: "card-heading" },
            el("h2", { className: "card-title" }, t("app.checklist.title")),
            el("p", { className: "card-desc" }, t("web.overview.loading"))
          ),
          checkAgainBtn
        )
      );
    }

    const env = overview.environment || {};
    const host = overview.host || { kind: "shell_tools", ready: false, hint_key: null };
    const cliInstalled = Boolean(overview.cli_installed);
    const keyring = overview.keyring || { status: "unknown", hint_key: null };
    const accounts = state.snapshot?.accounts || overview.accounts;

    const stepItem = (status, title, desc, extra = null) => {
      const iconNode =
        status === "done"
          ? icon("checkCircle", "icon-success")
          : status === "error"
            ? icon("alertCircle", "icon-danger")
            : status === "waiting"
              ? icon("circle", "icon-muted")
              : icon("circle", "icon-accent");
      return el(
        "li",
        { className: "checklist-item" },
        el("span", { className: "checklist-icon" }, iconNode),
        el(
          "div",
          { className: "checklist-body" },
          el("div", { className: "checklist-title" }, title),
          desc ? el("div", { className: "checklist-desc" }, desc) : null,
          extra
        )
      );
    };

    // Step 1: Host (WSL or Shell tools)
    const isWsl = host.kind === "wsl";
    let hostDesc;
    let hostExtra = null;
    if (host.ready) {
      if (isWsl) {
        const distro = (env.wsl_distros && env.wsl_distros[0]) || "";
        hostDesc = t("app.step.wsl.done", { distro });
      } else {
        hostDesc = host.hint_key ? t(host.hint_key) : t("app.step.shell.done");
      }
    } else if (isWsl) {
      hostDesc = t("app.step.wsl.todo");
      hostExtra = el(
        "div",
        { className: "checklist-actions" },
        el(
          "a",
          {
            href: WSL_INSTALL_URL,
            target: "_blank",
            rel: "noopener noreferrer",
            className: "btn btn-sm",
          },
          icon("externalLink"),
          t("app.action.install_wsl")
        )
      );
    } else {
      hostDesc = t("app.step.shell.todo");
    }

    // Step 2: Colab CLI + streaming installer
    let cliStatus = "waiting";
    let cliDesc = t("app.step.waiting");
    let cliExtra = null;
    if (cliInstalled) {
      cliStatus = "done";
      cliDesc = env.colab_version
        ? t("app.step.cli.done", { version: env.colab_version })
        : t("app.step.cli.done_unknown");
    } else if (host.ready) {
      cliStatus = state.install.phase === "failed" ? "error" : "todo";
      const methods =
        Array.isArray(overview.install_methods) && overview.install_methods.length > 0
          ? overview.install_methods
          : ["uv"];
      if (!chosenInstallMethod || !methods.includes(chosenInstallMethod)) {
        chosenInstallMethod = methods[0];
      }
      if (state.install.running) {
        cliDesc = null;
      } else if (state.install.phase === "cancelled") {
        cliDesc = t("app.install.cancelled");
      } else if (state.install.phase === "succeeded") {
        cliDesc = t("app.install.done");
      } else {
        cliDesc = t("app.step.cli.todo");
      }

      const cliChildren = [];
      if (state.install.running) {
        cliChildren.push(
          el(
            "div",
            { className: "checklist-actions" },
            el("span", { className: "spinner", "aria-hidden": "true" }),
            el("span", { className: "checklist-desc" }, t("app.install.running")),
            el(
              "button",
              {
                type: "button",
                className: "btn btn-sm btn-danger",
                disabled: state.install.cancelling || state.install.id === null,
                onClick: () => {
                  void cancelCliInstall();
                },
              },
              t(state.install.cancelling ? "app.install.cancelling" : "app.action.cancel")
            )
          )
        );
      } else {
        if (state.install.phase === "failed" && state.install.error) {
          const formatted = formatApiError(state.install.error);
          cliChildren.push(
            alertBox({
              tone: "danger",
              title: t("app.install.failed"),
              body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
              live: true,
            })
          );
        }
        const controls = [];
        if (methods.length > 1) {
          const selectId = "cli-install-method";
          const selectEl = el(
            "select",
            {
              id: selectId,
              className: "select select-sm select-inline",
              onChange: (event) => {
                chosenInstallMethod = event.target.value;
              },
            },
            methods.map((method) =>
              el(
                "option",
                { value: method, selected: method === chosenInstallMethod },
                installMethodLabel(method)
              )
            )
          );
          selectEl.value = chosenInstallMethod;
          controls.push(
            el("label", { for: selectId, className: "field-hint" }, t("app.install.method_label")),
            selectEl
          );
        } else {
          controls.push(el("span", { className: "field-hint" }, installMethodLabel(methods[0])));
        }
        controls.push(
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-primary",
              onClick: () => {
                void startCliInstall(chosenInstallMethod);
              },
            },
            icon("download"),
            t("app.install.start")
          )
        );
        cliChildren.push(el("div", { className: "checklist-actions" }, controls));
      }

      if (state.install.lines.length > 0) {
        const logBox = el(
          "div",
          { className: "install-log", role: "log", "aria-live": "off" },
          state.install.lines.map((line) =>
            el(
              "div",
              { className: line.stream === "stderr" ? "log-stderr" : null },
              line.text
            )
          )
        );
        cliChildren.push(logBox);
        window.requestAnimationFrame(() => {
          logBox.scrollTop = logBox.scrollHeight;
        });
      }
      cliExtra = el("div", { className: "checklist-body" }, cliChildren);
    }

    // Step 3: Helper Python & OS Keyring diagnostics
    let keyringStatus = "waiting";
    let keyringDesc = t("web.overview.keyring_unknown");
    let keyringExtra = null;
    if (keyring.status === "ready") {
      keyringStatus = "done";
      keyringDesc = [
        t("web.overview.keyring_ready"),
        overview.helper_available ? t("web.overview.helper_ready") : t("web.overview.helper_missing"),
      ].join(" ");
    } else if (keyring.status === "unavailable") {
      keyringStatus = "error";
      keyringDesc = null;
      keyringExtra = alertBox({
        tone: "danger",
        title: t("app.accounts.keyring.title"),
        body: keyring.hint_key ? t(keyring.hint_key) : t("app.accounts.keyring.body"),
      });
    }

    // Step 4: Google account
    let accountStatus = "waiting";
    let accountDesc = t("app.step.waiting");
    let accountExtra = null;
    if (cliInstalled && keyring.status !== "unavailable") {
      if (accounts?.active) {
        accountStatus = "done";
        accountDesc = t("app.step.signin.done", { email: formatEmail(getActiveEmail()) });
      } else if (accounts?.unadopted) {
        accountStatus = "todo";
        accountDesc = t("app.step.signin.unadopted");
        accountExtra = el(
          "div",
          { className: "checklist-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-primary",
              disabled: adopting,
              onClick: async () => {
                adopting = true;
                renderBody();
                try {
                  await adoptAccount();
                } finally {
                  adopting = false;
                  renderBody();
                }
              },
            },
            t("app.accounts.adopt")
          )
        );
      } else {
        accountStatus = "todo";
        accountDesc = t("app.step.signin.todo");
        accountExtra = el(
          "div",
          { className: "checklist-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-primary",
              onClick: () => navigate("accounts"),
            },
            t("app.action.sign_in")
          )
        );
      }
    }

    return el(
      "section",
      { className: "card" },
      el(
        "div",
        { className: "card-header" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.checklist.title")),
          el("p", { className: "card-desc" }, t("app.checklist.description"))
        ),
        checkAgainBtn
      ),
      el(
        "ul",
        { className: "checklist", role: "list" },
        stepItem(
          host.ready ? "done" : "todo",
          t(isWsl ? "app.step.wsl.title" : "app.step.shell.title"),
          hostDesc,
          hostExtra
        ),
        stepItem(cliStatus, t("app.step.cli.title"), cliDesc, cliExtra),
        stepItem(keyringStatus, t("web.overview.keyring_title"), keyringDesc, keyringExtra),
        stepItem(accountStatus, t("app.step.signin.title"), accountDesc, accountExtra)
      )
    );
  }

  function renderQuickDeploySection() {
    const enabled = (state.plugins || []).filter((p) => p && p.enabled && p.manifest);
    if (enabled.length === 0) {
      return null;
    }
    return el(
      "section",
      { className: "section-stack" },
      el(
        "div",
        { className: "section-heading" },
        el("h2", { className: "section-title" }, t("app.b2.deploy_title")),
        el("p", { className: "card-desc" }, t("app.b2.deploy_subtitle"))
      ),
      el(
        "div",
        { className: "deploy-grid" },
        enabled.map((info) => {
          const name = localized(info.manifest.name) || info.manifest.id;
          const desc = localized(info.manifest.description);
          return el(
            "article",
            { className: "card" },
            el(
              "div",
              { className: "deploy-card-head" },
              el(
                "div",
                { className: "deploy-card-title" },
                icon("rocket", "icon-accent"),
                el("span", null, name)
              ),
              badge(t("app.b2.plugin_version_short", { version: info.manifest.version }), "neutral")
            ),
            desc ? el("p", { className: "card-desc" }, desc) : null,
            el(
              "div",
              { className: "card-actions" },
              el(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm btn-primary",
                  onClick: () => navigate("plugins"),
                },
                icon("rocket"),
                t("app.b2.deploy_action")
              )
            )
          );
        })
      )
    );
  }

  function renderHeader() {
    if (!headerEl) return;
    clear(headerEl);
    headerEl.append(
      el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t("app.nav.overview")),
      el("p", { className: "page-subtitle" }, t("app.overview.subtitle"))
    );
  }

  function renderBody() {
    if (!bodyEl) return;
    clear(bodyEl);

    if (state.overviewError) {
      const formatted = formatApiError(state.overviewError);
      bodyEl.appendChild(
        alertBox({
          tone: "danger",
          title: t("app.backend.start_failed"),
          body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              onClick: () => {
                void loadOverview();
              },
            },
            t("app.action.retry")
          ),
        })
      );
    }

    const overview = state.overview;
    const ready = isChecklistComplete(overview);
    const checklistCard = renderChecklistCard(overview);
    const unmanagedAlert = renderUnmanagedAlert(overview);
    const quickDeploy = renderQuickDeploySection();

    if (ready) {
      bodyEl.appendChild(renderSummaryCard());
      if (unmanagedAlert) bodyEl.appendChild(unmanagedAlert);
      if (quickDeploy) bodyEl.appendChild(quickDeploy);
      bodyEl.appendChild(checklistCard);
    } else {
      bodyEl.appendChild(checklistCard);
      if (unmanagedAlert) bodyEl.appendChild(unmanagedAlert);
      if (quickDeploy) bodyEl.appendChild(quickDeploy);
    }
  }

  return {
    mount(container) {
      root = container;
      clear(root);
      headerEl = el("header", { className: "page-header" });
      bodyEl = el("div", { className: "section-stack" });
      root.append(headerEl, bodyEl);
      renderHeader();
      renderBody();
      if (!state.overview && !state.overviewLoading) {
        void loadOverview();
      }
    },
    update(reason) {
      if (!root) return;
      if (reason === "locale") {
        renderHeader();
      }
      if (
        reason === "locale" ||
        reason === "overview" ||
        reason === "snapshot" ||
        reason === "plugins" ||
        reason === "install"
      ) {
        renderBody();
      }
    },
    unmount() {
      root = null;
      headerEl = null;
      bodyEl = null;
    },
  };
}
