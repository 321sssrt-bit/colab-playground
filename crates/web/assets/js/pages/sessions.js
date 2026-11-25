import { openSwitchAccountDialog } from "../account-dialogs.js";
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
  formatApiError,
  formatApprox,
  formatConcern,
  formatConcerns,
  formatCu,
  formatCuRate,
  formatDurationSecs,
  formatEmail,
  formatErrorKind,
  formatHardware,
  formatRuntimeCardLabel,
} from "../format.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  isNewSessionDialogOpen,
  openAutoStopDialog,
  openCancelAutoStopDialog,
  openForwardDialog,
  openNewSessionDialog,
  openStopAllDialog,
  openStopRuntimeDialog,
  provisionHeadline,
  renderForwardRow,
  renderProvisionProgress,
} from "../session-dialogs.js";
import {
  cancelSessionProvision,
  clearEndedSessions,
  getAccountsView,
  getBackendNowSecs,
  getForwardsForRuntime,
  getRearmDurationSecs,
  isProvisionRunning,
  isRuntimeAutoStopBusy,
  isRuntimeStopping,
  isStopAllRunning,
  loadForwards,
  loadOverview,
  loadSessions,
  state,
} from "../store.js";

const TICK_INTERVAL_MS = 15000;

function runtimeKey(ref) {
  if (!ref) return "";
  return `${ref.account}/${ref.endpoint || ""}`;
}

function captureFocusKey(container) {
  if (!container || document.querySelector("dialog[open]")) return null;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) {
    return null;
  }
  return active.dataset.focusKey || null;
}

function restoreFocusKey(container, key) {
  if (!container || !key || document.querySelector("dialog[open]")) return;
  const candidates = container.querySelectorAll("[data-focus-key]");
  for (const node of candidates) {
    if (node instanceof HTMLElement && node.dataset.focusKey === key && !node.hasAttribute("disabled")) {
      node.focus({ preventScroll: true });
      return;
    }
  }
}

export function createSessionsPage({ navigate }) {
  let root = null;
  let headerEl = null;
  let bodyEl = null;
  let tickTimer = null;

  function isEnvironmentReady() {
    const overview = state.overview;
    const cliInstalled = overview ? Boolean(overview.cli_installed) : state.snapshot?.accounts_error !== "not_installed";
    const accounts = getAccountsView();
    const hasAccounts = Boolean(accounts && Array.isArray(accounts.accounts) && accounts.accounts.length > 0);
    return cliInstalled && hasAccounts;
  }

  function findAccountRecord(accountId) {
    const accounts = getAccountsView()?.accounts || [];
    return accounts.find((a) => a.id === accountId) || null;
  }

  function guardDecisionFor(runtime) {
    const decisions = state.snapshot?.guard?.decisions;
    if (!Array.isArray(decisions)) return null;
    const key = runtimeKey(runtime.id);
    return decisions.find((item) => runtimeKey(item?.session) === key) || null;
  }

  function renderHeader() {
    if (!headerEl) return;
    const focusKey = captureFocusKey(headerEl);
    const ready = isEnvironmentReady();
    const runtimes = state.snapshot?.runtimes?.runtimes || [];
    const hasWorkToStop =
      runtimes.length > 0 ||
      isProvisionRunning() ||
      Boolean(state.snapshot?.runtimes_error) ||
      Boolean(state.sessionsError) ||
      (state.snapshot?.runtimes?.errors?.length || 0) > 0;
    const refreshing = state.sessionsLoading || state.sessionsRefreshing;

    clear(headerEl);
    headerEl.append(
      el(
        "div",
        { className: "page-header-heading" },
        el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t("app.nav.sessions")),
        el("p", { className: "page-subtitle" }, t("app.sessions.subtitle"))
      ),
      el(
        "div",
        { className: "page-header-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost btn-icon",
            dataset: { sessionsRefresh: "true", focusKey: "header:refresh" },
            "aria-label": t("app.b2.sessions_refresh"),
            title: t("app.b2.sessions_refresh"),
            disabled: !ready || refreshing,
            onClick: () => {
              void loadSessions({ silent: true });
            },
          },
          icon("refresh")
        ),
        ready && hasWorkToStop
          ? el(
              "button",
              {
                type: "button",
                className: "btn",
                dataset: { sessionsStopAll: "true", focusKey: "header:stop-all" },
                disabled: isStopAllRunning(),
                onClick: () => openStopAllDialog(),
              },
              icon("square"),
              t("web.sessions.stop_all")
            )
          : null,
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            dataset: { sessionsNew: "true", focusKey: "header:new" },
            disabled: !ready,
            onClick: () => openNewSessionDialog(),
          },
          icon("plus"),
          t("app.b2.new_title")
        )
      )
    );
    restoreFocusKey(headerEl, focusKey);
  }

  function renderProvisioningCard() {
    if (state.provision.phase !== "running" || isNewSessionDialogOpen()) {
      return null;
    }
    const cancelling = Boolean(state.provision.cancelling);
    return el(
      "section",
      { className: "card card-compact", dataset: { sessionsProvisioning: "true" } },
      el(
        "div",
        { className: "card-header" },
        el(
          "div",
          { className: "card-heading" },
          el(
            "h2",
            { className: "card-title" },
            t("app.b2.sessions_starting", { name: state.provision.sessionName || "" })
          ),
          el("p", { className: "card-desc" }, provisionHeadline(state.provision.events))
        )
      ),
      ...renderProvisionProgress(state.provision, true),
      el(
        "div",
        { className: "session-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost",
            dataset: { provisioningShow: "true", focusKey: "prov:show" },
            onClick: () => openNewSessionDialog(),
          },
          t("app.b2.action_show")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-danger",
            dataset: { provisioningCancel: "true", focusKey: "prov:cancel" },
            disabled: cancelling,
            onClick: () => {
              void cancelSessionProvision();
            },
          },
          cancelling ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
          t(cancelling ? "app.b2.new_cancelling" : "app.action.cancel")
        )
      )
    );
  }

  function renderRuntimeCard(runtime) {
    const label = formatRuntimeCardLabel(runtime);
    const nowSecs = getBackendNowSecs();
    const unknown = t("app.summary.unknown");
    const tracked = runtime.tracked || null;
    const hardware =
      (tracked ? formatHardware(tracked.gpu, tracked.vram_mib) : null) ||
      runtime.hardware ||
      unknown;

    const startedAt = tracked?.spend?.started_at;
    const uptime =
      typeof startedAt === "number" && Number.isFinite(startedAt)
        ? formatDurationSecs(Math.max(0, nowSecs - startedAt))
        : unknown;

    const rate =
      typeof runtime.estimated_rate_cu_per_hour === "number" &&
      Number.isFinite(runtime.estimated_rate_cu_per_hour)
        ? formatApprox(formatCuRate(runtime.estimated_rate_cu_per_hour))
        : unknown;

    const spend =
      typeof runtime.estimated_spend_cu === "number" &&
      Number.isFinite(runtime.estimated_spend_cu)
        ? formatApprox(formatCu(runtime.estimated_spend_cu))
        : unknown;

    const hasAutoStop =
      typeof runtime.auto_stop_at === "number" && Number.isFinite(runtime.auto_stop_at);
    const autoStop = hasAutoStop
      ? t("app.b2.runtime_auto_stop_in", {
          time: formatDurationSecs(Math.max(0, runtime.auto_stop_at - nowSecs)),
        })
      : runtime.managed
        ? t("app.b2.runtime_auto_stop_off")
        : t("app.b2.runtime_auto_stop_none");

    const watchdog = tracked?.watchdog || null;
    const armed = Boolean(watchdog && watchdog.armed && !watchdog.cancelled && watchdog.deadline);
    const stopping = isRuntimeStopping(runtime.id);
    const autoStopBusy = isRuntimeAutoStopBusy(runtime.id);

    const badges = [];
    if (!runtime.managed) {
      badges.push(badge(t("app.b2.runtime_unmanaged"), "warning"));
    }
    if (runtime.high_mem) {
      badges.push(badge(t("app.b2.runtime_high_mem"), "neutral"));
    }
    if (hasAutoStop && armed) {
      badges.push(
        el(
          "span",
          {
            className: "badge badge-success",
            title: t("app.b2.prov_watchdog"),
            dataset: { watchdogArmed: "true" },
          },
          icon("shield", "icon-xs"),
          t("web.sessions.watchdog_armed")
        )
      );
    }
    if (stopping) {
      badges.push(badge(t("app.b2.runtime_stopping"), "info"));
    }

    const key = runtimeKey(runtime.id);
    const stat = (statLabel, statValue, valueDataset = null) =>
      el(
        "div",
        { className: "session-stat" },
        el("span", { className: "session-stat-label" }, statLabel),
        el(
          "span",
          valueDataset ? { className: "session-stat-value", dataset: valueDataset } : { className: "session-stat-value" },
          statValue
        )
      );

    const cardChildren = [
      el(
        "div",
        { className: "session-card-header" },
        el("h3", { className: "session-card-title" }, label),
        badges.length > 0 ? el("div", { className: "session-card-badges" }, badges) : null
      ),
      el(
        "div",
        { className: "session-stats-grid" },
        stat(t("app.b2.runtime_hardware"), hardware),
        stat(
          t("app.b2.runtime_uptime"),
          uptime,
          typeof startedAt === "number" && Number.isFinite(startedAt)
            ? { runtimeUptimeSince: String(startedAt) }
            : null
        ),
        stat(t("app.b2.runtime_rate"), rate),
        stat(t("app.b2.runtime_spend"), spend),
        stat(
          t("app.b2.runtime_auto_stop"),
          autoStop,
          hasAutoStop ? { runtimeAutoStopAt: String(runtime.auto_stop_at) } : null
        )
      ),
    ];

    if (!runtime.managed) {
      cardChildren.push(el("p", { className: "caption" }, t("app.b2.runtime_unmanaged_hint")));
    }

    if (hasAutoStop && !armed) {
      cardChildren.push(
        inlineMessage({
          tone: "warning",
          text: t("app.b5.runtime_auto_stop_app_only"),
        })
      );
    }

    const decision = guardDecisionFor(runtime);
    if (decision?.decision?.decision === "stop" && !decision.stopped) {
      cardChildren.push(
        alertBox({
          tone: "danger",
          title: t("app.b2.guard_still_billing"),
          body: decision.error ? formatApiError(decision.error).message : null,
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              dataset: { focusKey: `rt:${key}:guard-stop` },
              onClick: () => openStopRuntimeDialog(runtime),
            },
            t("app.b2.stop_action")
          ),
        })
      );
    } else if (
      decision?.decision?.decision === "warn" &&
      Array.isArray(decision.decision.concerns) &&
      decision.decision.concerns.length > 0
    ) {
      const concerns = decision.decision.concerns;
      const unknownOnly = concerns.every((c) => c?.kind === "usage_unknown");
      const nearAutoStop = concerns.some((c) => c?.kind === "limit" && c?.limit === "runtime");
      const rearmSecs = getRearmDurationSecs();
      cardChildren.push(
        el(
          "div",
          { className: "session-guard-warning", dataset: { guardWarning: label } },
          inlineMessage({
            tone: unknownOnly ? "info" : "warning",
            text: t("app.b2.guard_warn_line", { what: formatConcerns(concerns) }),
          }),
          nearAutoStop && runtime.on_active_account
            ? el(
                "div",
                null,
                el(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-sm",
                    dataset: { focusKey: `rt:${key}:guard-extend` },
                    onClick: () => openAutoStopDialog(runtime, "extend"),
                  },
                  t("app.b2.runtime_extend_by", { time: formatDurationSecs(rearmSecs) })
                )
              )
            : null
        )
      );
    }

    const forwards = getForwardsForRuntime(runtime);
    if (forwards.length > 0) {
      cardChildren.push(
        el(
          "div",
          { className: "session-forwards", dataset: { sessionForwards: label } },
          el("span", { className: "caption" }, t("app.b2.runtime_forwards")),
          el(
            "div",
            { className: "forward-list" },
            forwards.map((fw) => renderForwardRow(fw))
          )
        )
      );
    }

    const actionNodes = [
      el(
        "button",
        {
          type: "button",
          className: "btn btn-sm btn-danger",
          dataset: { runtimeStop: label, focusKey: `rt:${key}:stop` },
          disabled: stopping,
          onClick: () => openStopRuntimeDialog(runtime),
        },
        stopping ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("square"),
        t("app.b2.stop_action")
      ),
    ];

    if (!runtime.on_active_account) {
      const accountRecord = findAccountRecord(runtime.id.account) || {
        id: runtime.id.account,
        email: runtime.account_email,
      };
      actionNodes.push(
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            dataset: { runtimeSwitch: label, focusKey: `rt:${key}:switch` },
            onClick: () => openSwitchAccountDialog(accountRecord),
          },
          icon("link"),
          t("app.b2.runtime_switch")
        ),
        el("span", { className: "caption" }, t("app.b2.runtime_switch_hint"))
      );
    } else {
      const named = Boolean(runtime.id?.name);
      const rearmText = formatDurationSecs(getRearmDurationSecs());
      if (named && hasAutoStop) {
        actionNodes.push(
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              dataset: { runtimeExtend: label, focusKey: `rt:${key}:extend` },
              disabled: autoStopBusy,
              onClick: () => openAutoStopDialog(runtime, "extend"),
            },
            t("app.b2.runtime_extend_by", { time: rearmText })
          ),
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-ghost",
              dataset: { runtimeCancelAutoStop: label, focusKey: `rt:${key}:cancel-auto-stop` },
              disabled: autoStopBusy,
              onClick: () => openCancelAutoStopDialog(runtime),
            },
            t("app.b2.runtime_cancel_auto_stop")
          )
        );
      } else if (named && runtime.managed) {
        actionNodes.push(
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              dataset: { runtimeSetAutoStop: label, focusKey: `rt:${key}:set-auto-stop` },
              disabled: autoStopBusy,
              onClick: () => openAutoStopDialog(runtime, "set"),
            },
            t("app.b3.runtime_set_auto_stop", { time: rearmText })
          )
        );
      }
      actionNodes.push(
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost",
            dataset: { runtimeForward: label, focusKey: `rt:${key}:forward` },
            disabled: !named,
            title: named ? null : t("app.b2.runtime_unnamed_reason"),
            onClick: () => openForwardDialog(runtime),
          },
          icon("link"),
          t("app.b2.forward_title")
        )
      );
    }

    cardChildren.push(el("div", { className: "session-actions" }, actionNodes));

    return el(
      "article",
      {
        className: "card session-card",
        dataset: {
          runtimeCard: label,
          runtimeManaged: runtime.managed ? "true" : "false",
          runtimeActiveAccount: runtime.on_active_account ? "true" : "false",
        },
      },
      cardChildren
    );
  }

  function renderGroups(runtimes) {
    const groups = [];
    for (const rt of runtimes) {
      const existing = groups.find((list) => list[0].id.account === rt.id.account);
      if (existing) {
        existing.push(rt);
      } else {
        groups.push([rt]);
      }
    }
    groups.sort((a, b) => Number(Boolean(b[0].on_active_account)) - Number(Boolean(a[0].on_active_account)));

    return groups.map((list) => {
      const active = Boolean(list[0].on_active_account);
      const email = formatEmail(list[0].account_email);
      const heading = active
        ? t("app.b2.sessions_group_active", { email })
        : t("app.b2.sessions_group", { email });
      const countText =
        list.length === 1
          ? t("app.b2.sessions_count_one")
          : t("app.b2.sessions_count_many", { count: list.length });
      return el(
        "section",
        { className: "session-group", dataset: { sessionGroup: list[0].id.account } },
        el(
          "div",
          { className: "session-group-header" },
          el("h2", { className: "session-group-title" }, heading),
          el("span", { className: "caption" }, countText)
        ),
        el(
          "div",
          { className: "session-group-list" },
          list.map((rt) => renderRuntimeCard(rt))
        )
      );
    });
  }

  function renderEndedCard() {
    if (!Array.isArray(state.sessionsEnded) || state.sessionsEnded.length === 0) {
      return null;
    }
    const rows = state.sessionsEnded.map((item) => {
      const email = formatEmail(item.email);
      let iconNode;
      let why;
      if (item.reason?.kind === "guard") {
        iconNode = icon("shield", "icon-danger");
        why = t("app.b2.ended_guard", { why: formatConcern(item.reason.concern) });
      } else if (item.reason?.kind === "vanished") {
        iconNode = icon("circleStop", "icon-muted");
        why = t("app.b2.ended_vanished");
      } else {
        iconNode = icon("square", "icon-muted");
        why = t("app.b2.ended_user");
      }
      return el(
        "div",
        { className: "ended-row" },
        el("span", { className: "ended-icon" }, iconNode),
        el(
          "div",
          { className: "ended-text" },
          el("div", { className: "ended-line" }, t("app.b2.ended_line", { name: item.label, email })),
          el("div", { className: "caption" }, why)
        )
      );
    });

    return el(
      "section",
      { className: "card card-compact", dataset: { sessionsEnded: "true" } },
      el(
        "div",
        { className: "card-header" },
        el("h2", { className: "card-title" }, t("app.b2.ended_title")),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm btn-ghost",
            dataset: { focusKey: "ended:clear" },
            onClick: () => clearEndedSessions(),
          },
          t("app.b2.action_clear")
        )
      ),
      el("div", { className: "ended-list" }, rows)
    );
  }

  function updateCountdowns() {
    if (!bodyEl) return;
    const nowSecs = getBackendNowSecs();
    for (const node of bodyEl.querySelectorAll("[data-runtime-uptime-since]")) {
      const startedAt = Number(node.dataset.runtimeUptimeSince);
      if (Number.isFinite(startedAt)) {
        node.textContent = formatDurationSecs(Math.max(0, nowSecs - startedAt));
      }
    }
    for (const node of bodyEl.querySelectorAll("[data-runtime-auto-stop-at]")) {
      const autoStopAt = Number(node.dataset.runtimeAutoStopAt);
      if (Number.isFinite(autoStopAt)) {
        node.textContent = t("app.b2.runtime_auto_stop_in", {
          time: formatDurationSecs(Math.max(0, autoStopAt - nowSecs)),
        });
      }
    }
  }

  function renderBody() {
    if (!bodyEl) return;
    const focusKey = captureFocusKey(bodyEl);
    clear(bodyEl);

    if (!isEnvironmentReady()) {
      bodyEl.appendChild(
        emptyState({
          iconName: "sessions",
          title: t("app.b2.sessions_setup_title"),
          body: t("app.b2.sessions_setup_body"),
          action: el(
            "button",
            {
              type: "button",
              className: "btn",
              dataset: { focusKey: "setup:overview" },
              onClick: () => navigate("overview"),
            },
            t("app.b2.sessions_setup_action")
          ),
        })
      );
      restoreFocusKey(bodyEl, focusKey);
      return;
    }

    const provCard = renderProvisioningCard();
    if (provCard) {
      bodyEl.appendChild(provCard);
    }

    if (state.snapshot?.guard_error) {
      bodyEl.appendChild(
        inlineMessage({
          tone: "warning",
          text: t("app.b2.guard_round_failed", {
            why: formatErrorKind(state.snapshot.guard_error),
          }),
        })
      );
    }

    const runtimesView = state.snapshot?.runtimes || null;
    const runtimesErr = state.snapshot?.runtimes_error || null;
    const refreshError = state.sessionsError || null;

    if (refreshError || runtimesErr) {
      const formatted = refreshError ? formatApiError(refreshError) : null;
      const errBody = formatted
        ? [formatted.message, formatted.hint].filter(Boolean).join("\n")
        : formatErrorKind(runtimesErr);
      bodyEl.appendChild(
        alertBox({
          tone: "danger",
          title: t("app.b2.sessions_failed"),
          body: errBody,
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              dataset: { focusKey: "retry:sessions" },
              onClick: () => {
                void loadSessions({ silent: Boolean(runtimesView) });
              },
            },
            t("app.action.retry")
          ),
        })
      );
    }

    if (!runtimesView) {
      if (!refreshError && !runtimesErr) {
        bodyEl.appendChild(busyLine(t("app.b2.sessions_loading")));
      }
    } else {
      const accountErrors =
        Array.isArray(state.sessionsAccountErrors) && state.sessionsAccountErrors.length > 0
          ? state.sessionsAccountErrors
          : Array.isArray(runtimesView?.errors)
            ? runtimesView.errors
            : [];
      for (const failure of accountErrors) {
        const acct = findAccountRecord(failure.account);
        const email = formatEmail(acct?.email);
        const formatted = formatApiError(failure.error);
        bodyEl.appendChild(
          alertBox({
            tone: "danger",
            title: t("app.b2.sessions_account_failed", { email }),
            body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
          })
        );
      }

      const runtimes = Array.isArray(runtimesView?.runtimes) ? runtimesView.runtimes : [];
      if (runtimes.length === 0) {
        const titleKey =
          accountErrors.length === 0
            ? "app.sessions.empty.title"
            : "app.b10.sessions_empty_partial_title";
        bodyEl.appendChild(
          emptyState({
            iconName: "sessions",
            title: t(titleKey),
            body: t("app.sessions.empty.body"),
            action: el(
              "button",
              {
                type: "button",
                className: "btn btn-primary",
                dataset: { focusKey: "empty:new" },
                onClick: () => openNewSessionDialog(),
              },
              icon("plus"),
              t("app.b2.new_title")
            ),
          })
        );
      } else {
        bodyEl.appendChild(el("p", { className: "caption" }, t("app.b3.sessions_estimate_note")));
        for (const groupEl of renderGroups(runtimes)) {
          bodyEl.appendChild(groupEl);
        }
      }
    }

    const endedCard = renderEndedCard();
    if (endedCard) {
      bodyEl.appendChild(endedCard);
    }
    restoreFocusKey(bodyEl, focusKey);
  }

  function renderAll() {
    renderHeader();
    renderBody();
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
      void loadSessions({ silent: Boolean(state.snapshot?.runtimes) });
      void loadForwards();
      tickTimer = window.setInterval(() => {
        if (root && (state.snapshot?.runtimes?.runtimes?.length || 0) > 0) {
          updateCountdowns();
        }
      }, TICK_INTERVAL_MS);
    },
    update(reason) {
      if (!root) return;
      if (
        reason === "locale" ||
        reason === "snapshot" ||
        reason === "overview" ||
        reason === "sessions" ||
        reason === "forwards" ||
        reason === "provision" ||
        reason === "settings"
      ) {
        renderAll();
      }
    },
    unmount() {
      if (tickTimer !== null) {
        window.clearInterval(tickTimer);
        tickTimer = null;
      }
      root = null;
      headerEl = null;
      bodyEl = null;
    },
  };
}
