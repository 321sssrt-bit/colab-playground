import { alertBox, announce, busyLine, clear, el, inlineMessage } from "./components.js";
import {
  acceleratorLabel,
  formatApiError,
  formatDurationSecs,
  formatEmail,
  formatRuntimeLabel,
} from "./format.js";
import { onLocaleChange, t } from "./i18n.js";
import { icon } from "./icons.js";
import {
  beginAccountLogin,
  cancelAccountLogin,
  confirmAccountSwitch,
  fetchInitialSnapshot,
  previewAccountSwitch,
  removeAccount,
  setAccountNotice,
  state,
  submitAccountLogin,
  subscribe,
} from "./store.js";

const DIALOG_ID = "account-dialog";
const TITLE_ID = "account-dialog-title";

let initialized = false;
let activeDialog = null;
let dialogGeneration = 0;

function getDialogEl() {
  return document.getElementById(DIALOG_ID);
}

function safeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function isBusy(dialog) {
  if (!dialog) return false;
  if (dialog.kind === "add") {
    return (
      dialog.phase === "starting" ||
      dialog.phase === "submitting" ||
      dialog.phase === "cancelling" ||
      dialog.phase === "rolling_back" ||
      (dialog.phase === "expired" && Boolean(dialog.rollbackRunning)) ||
      dialog.cancellingExisting
    );
  }
  if (dialog.kind === "switch") {
    return dialog.submitting;
  }
  if (dialog.kind === "remove") {
    return dialog.submitting;
  }
  return false;
}

function hasLoginRollbackOp(snapshot, loginId) {
  const ops = snapshot?.operations;
  if (!Array.isArray(ops)) return false;
  return ops.some(
    (entry) =>
      entry?.operation?.kind === "login" &&
      (entry.operation.login_id === loginId || entry.id === loginId)
  );
}

function hasAnyLoginOp(snapshot) {
  const ops = snapshot?.operations;
  return Array.isArray(ops) && ops.some((entry) => entry?.operation?.kind === "login");
}

function closeDialogNow() {
  dialogGeneration += 1;
  activeDialog = null;
  const dialog = getDialogEl();
  if (dialog) {
    if (dialog.open) {
      dialog.close();
    }
    clear(dialog);
  }
}

function ensureDialogOpen() {
  const dialog = getDialogEl();
  if (!dialog) return null;
  dialog.setAttribute("aria-labelledby", TITLE_ID);
  if (!dialog.open) {
    dialog.showModal();
  }
  return dialog;
}

function renderImpactList(impact) {
  const tunnels = Array.isArray(impact?.tunnels_closing) ? impact.tunnels_closing : [];
  const sessions = Array.isArray(impact?.sessions_left_running) ? impact.sessions_left_running : [];
  const unmanaged = impact?.unmanaged_left_running;

  if (
    tunnels.length === 0 &&
    sessions.length === 0 &&
    Array.isArray(unmanaged) &&
    unmanaged.length === 0
  ) {
    return el("p", { className: "dialog-paragraph" }, t("app.switch.nothing"));
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const runtimesList = state.snapshot?.runtimes?.runtimes || [];
  const groups = [];

  if (tunnels.length > 0) {
    groups.push(
      el(
        "div",
        { className: "impact-group", dataset: { impactGroup: "tunnels" } },
        el("p", { className: "dialog-paragraph" }, t("app.switch.tunnels")),
        el(
          "ul",
          { className: "impact-items" },
          tunnels.map((tunnel) =>
            el(
              "li",
              null,
              t("app.switch.tunnel", {
                local: tunnel?.spec?.local_port ?? "",
                session: tunnel?.spec?.session ?? "",
                remote: tunnel?.spec?.remote_port ?? "",
              })
            )
          )
        )
      )
    );
  }

  if (sessions.length > 0) {
    groups.push(
      el(
        "div",
        { className: "impact-group", dataset: { impactGroup: "sessions" } },
        el("p", { className: "dialog-paragraph" }, t("app.switch.sessions")),
        el(
          "ul",
          { className: "impact-items" },
          sessions.map((session) => {
            const hardware = acceleratorLabel(session.accelerator);
            const deadline =
              session?.watchdog &&
              session.watchdog.armed === true &&
              !session.watchdog.cancelled
                ? session.watchdog.deadline
                : null;
            const remaining =
              typeof deadline === "number" && Number.isFinite(deadline) && deadline > nowSecs
                ? deadline - nowSecs
                : null;
            const text =
              remaining !== null
                ? t("app.switch.session_deadline", {
                    name: session.name,
                    hardware,
                    time: formatDurationSecs(remaining),
                  })
                : t("app.switch.session", {
                    name: session.name,
                    hardware,
                  });
            return el("li", null, text);
          })
        )
      )
    );
  }

  if (unmanaged === null || unmanaged === undefined) {
    groups.push(
      inlineMessage({
        tone: "warning",
        text: t("app.b10.switch_unmanaged_unknown"),
      })
    );
  } else if (Array.isArray(unmanaged) && unmanaged.length > 0) {
    groups.push(
      el(
        "div",
        { className: "impact-group", dataset: { impactGroup: "unmanaged" } },
        el("p", { className: "dialog-paragraph" }, t("app.b3.switch_unmanaged")),
        el(
          "ul",
          { className: "impact-items" },
          unmanaged.map((rt) =>
            el(
              "li",
              null,
              t("app.b3.switch_unmanaged_item", {
                name: formatRuntimeLabel(rt, runtimesList),
              })
            )
          )
        )
      )
    );
  }

  return el("div", { className: "impact-list", dataset: { switchImpact: "true" } }, groups);
}

async function startAddFlow() {
  if (!activeDialog || activeDialog.kind !== "add") return;
  const gen = ++dialogGeneration;
  activeDialog.phase = "starting";
  activeDialog.error = null;
  activeDialog.codeDraft = "";
  activeDialog.loginId = null;
  activeDialog.authUrl = null;
  activeDialog.seenInSnapshot = false;
  renderActiveDialog();

  try {
    const prompt = await beginAccountLogin();
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "add") {
      // Dialog was closed while starting: release the server credential write lock immediately.
      if (prompt?.id !== undefined && prompt?.id !== null) {
        void cancelAccountLogin(prompt.id).catch(() => {});
      }
      return;
    }
    activeDialog.phase = "code";
    activeDialog.loginId = prompt.id;
    activeDialog.authUrl = prompt.auth_url;
    activeDialog.seenInSnapshot = state.snapshot?.login_id === prompt.id;
    renderActiveDialog();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "add") return;
    activeDialog.phase = "failed";
    activeDialog.error = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

async function cancelPendingAddFlow() {
  if (!activeDialog || activeDialog.kind !== "add") return;
  const loginId = activeDialog.loginId;
  if (loginId === null || loginId === undefined) {
    closeDialogNow();
    return;
  }
  const gen = ++dialogGeneration;
  activeDialog.phase = "cancelling";
  activeDialog.error = null;
  renderActiveDialog();

  try {
    await cancelAccountLogin(loginId);
    if (gen !== dialogGeneration) return;
    const notice = t("web.add.cancelled_notice");
    setAccountNotice({ tone: "info", message: notice });
    announce(notice);
    closeDialogNow();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "add") return;
    if (err?.payload?.error?.kind === "login_cancelled") {
      const notice = t("web.add.cancelled_notice");
      setAccountNotice({ tone: "info", message: notice });
      announce(notice);
      closeDialogNow();
      return;
    }
    activeDialog.phase = "failed";
    activeDialog.error = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

async function submitAddCode() {
  if (!activeDialog || activeDialog.kind !== "add" || activeDialog.phase !== "code") return;
  const trimmed = (activeDialog.codeDraft || "").trim();
  if (!trimmed) return;
  const loginId = activeDialog.loginId;
  const gen = ++dialogGeneration;
  activeDialog.phase = "submitting";
  activeDialog.error = null;
  renderActiveDialog();

  try {
    const account = await submitAccountLogin(loginId, trimmed);
    if (gen !== dialogGeneration) return;
    const message = t("app.add.done", { email: formatEmail(account?.email) });
    setAccountNotice({ tone: "success", message });
    announce(message);
    closeDialogNow();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "add") return;
    activeDialog.codeDraft = "";
    if (err?.payload?.error?.kind === "login_cancelled") {
      void fetchInitialSnapshot();
      if (hasLoginRollbackOp(state.snapshot, loginId)) {
        activeDialog.phase = "rolling_back";
        activeDialog.loginId = loginId;
      } else {
        activeDialog.phase = "expired";
        activeDialog.loginId = null;
        activeDialog.rollbackRunning = hasAnyLoginOp(state.snapshot);
      }
    } else {
      activeDialog.loginId = null;
      activeDialog.phase = "failed";
      activeDialog.error = err?.payload || { error: {} };
    }
    renderActiveDialog();
  }
}

async function loadSwitchPreview() {
  if (!activeDialog || activeDialog.kind !== "switch") return;
  const gen = ++dialogGeneration;
  activeDialog.phase = "loading";
  activeDialog.preview = null;
  activeDialog.loadError = null;
  activeDialog.confirmError = null;
  activeDialog.impactChanged = false;
  renderActiveDialog();

  try {
    const preview = await previewAccountSwitch(activeDialog.account.id);
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "switch") return;
    activeDialog.phase = "ready";
    activeDialog.preview = preview;
    renderActiveDialog();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "switch") return;
    activeDialog.phase = "load_error";
    activeDialog.loadError = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

async function executeSwitchAccount() {
  if (
    !activeDialog ||
    activeDialog.kind !== "switch" ||
    activeDialog.phase !== "ready" ||
    !activeDialog.preview ||
    activeDialog.submitting ||
    activeDialog.impactChanged
  ) {
    return;
  }
  const gen = ++dialogGeneration;
  const account = activeDialog.account;
  activeDialog.submitting = true;
  activeDialog.confirmError = null;
  renderActiveDialog();

  try {
    await confirmAccountSwitch(account.id, activeDialog.preview);
    if (gen !== dialogGeneration) return;
    const message = t("app.switch.done", { email: formatEmail(account.email) });
    setAccountNotice({ tone: "success", message });
    announce(message);
    closeDialogNow();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "switch") return;
    activeDialog.submitting = false;
    activeDialog.confirmError = err?.payload || { error: {} };
    const errInfo = err?.payload?.error;
    if (
      errInfo?.message_key === "web.accounts.switch_impact_changed" ||
      errInfo?.kind === "account_not_active"
    ) {
      activeDialog.impactChanged = true;
    }
    renderActiveDialog();
  }
}

async function executeRemoveAccount() {
  if (!activeDialog || activeDialog.kind !== "remove" || activeDialog.submitting) return;
  const gen = ++dialogGeneration;
  const account = activeDialog.account;
  activeDialog.submitting = true;
  activeDialog.error = null;
  renderActiveDialog();

  try {
    await removeAccount(account.id);
    if (gen !== dialogGeneration) return;
    const message = t("app.remove.done", { email: formatEmail(account.email) });
    setAccountNotice({ tone: "success", message });
    announce(message);
    closeDialogNow();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || !activeDialog || activeDialog.kind !== "remove") return;
    activeDialog.submitting = false;
    activeDialog.error = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

function renderAddDialog(dialog, model) {
  dialog.dataset.dialogKind = "add";
  dialog.dataset.dialogPhase = model.phase;
  const title = el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.add.title"));

  if (model.phase === "intro") {
    const existingLoginId = state.snapshot?.login_id;
    const hasExisting = existingLoginId !== null && existingLoginId !== undefined;
    const loginOpRunning = hasAnyLoginOp(state.snapshot);
    const bodyChildren = [
      el("p", { className: "dialog-paragraph" }, t("app.add.intro")),
      inlineMessage({ tone: "info", text: t("app.add.impact") }),
    ];
    if (hasExisting) {
      bodyChildren.push(
        alertBox({
          tone: "warning",
          body: t("web.add.in_progress_other"),
          actions: el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              disabled: model.cancellingExisting,
              onClick: async () => {
                model.cancellingExisting = true;
                renderActiveDialog();
                try {
                  await cancelAccountLogin(existingLoginId);
                } catch {
                  // Snapshot update or retry clarifies remaining lock state.
                } finally {
                  if (activeDialog === model) {
                    model.cancellingExisting = false;
                    renderActiveDialog();
                  }
                }
              },
            },
            t("web.add.cancel_existing")
          ),
        })
      );
    } else if (loginOpRunning) {
      bodyChildren.push(busyLine(t("web.add.cancelling")));
    }
    dialog.append(
      title,
      el("div", { className: "dialog-body" }, bodyChildren),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            onClick: () => closeDialogNow(),
          },
          t("app.action.cancel")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            dataset: { addContinue: "true" },
            disabled: hasExisting || loginOpRunning || model.cancellingExisting,
            autofocus: !hasExisting && !loginOpRunning,
            onClick: () => {
              void startAddFlow();
            },
          },
          icon("externalLink"),
          t("app.add.continue")
        )
      )
    );
    return;
  }

  if (model.phase === "starting") {
    dialog.append(
      title,
      el("div", { className: "dialog-body" }, busyLine(t("app.add.starting"))),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            onClick: () => closeDialogNow(),
          },
          t("app.action.cancel")
        )
      )
    );
    return;
  }

  if (model.phase === "code" || model.phase === "submitting" || model.phase === "cancelling") {
    const busy = model.phase === "submitting" || model.phase === "cancelling";
    const codeInputId = "add-account-code";

    const submitBtn = el(
      "button",
      {
        type: "submit",
        className: "btn btn-primary",
        dataset: { addSubmit: "true" },
        disabled: busy || !(model.codeDraft || "").trim(),
      },
      model.phase === "submitting" ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
      t("app.add.submit")
    );

    const codeInput = el("input", {
      id: codeInputId,
      name: "oauth_code",
      type: "text",
      className: "input mono",
      autocomplete: "off",
      autocorrect: "off",
      autocapitalize: "none",
      spellcheck: "false",
      placeholder: t("app.add.code_placeholder"),
      value: model.codeDraft || "",
      disabled: busy,
      autofocus: !busy,
      onInput: (event) => {
        model.codeDraft = event.target.value;
        submitBtn.disabled = busy || !model.codeDraft.trim();
      },
    });

    const copyBtnLabel = el("span", null, t("copy.button"));
    let copyBtnIcon = icon("copy");
    const copyBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-sm btn-ghost",
        dataset: { addCopyLink: "true" },
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(model.authUrl || "");
            const nextIcon = icon("check");
            copyBtn.replaceChild(nextIcon, copyBtnIcon);
            copyBtnIcon = nextIcon;
            copyBtnLabel.textContent = t("web.shell.copied");
            announce(t("web.shell.copied"));
            window.setTimeout(() => {
              if (!copyBtn.isConnected) return;
              const resetIcon = icon("copy");
              copyBtn.replaceChild(resetIcon, copyBtnIcon);
              copyBtnIcon = resetIcon;
              copyBtnLabel.textContent = t("copy.button");
            }, 2000);
          } catch {
            announce(t("web.shell.copy_link_failed"), "assertive");
          }
        },
      },
      copyBtnIcon,
      copyBtnLabel
    );

    const safeUrl = safeHttpUrl(model.authUrl);
    const oauthBox = el(
      "div",
      { className: "oauth-link-box" },
      el(
        "div",
        { className: "oauth-open-row" },
        safeUrl
          ? el(
              "a",
              {
                href: safeUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                className: "btn",
                dataset: { addOpenLink: "true" },
              },
              icon("externalLink"),
              t("web.add.open_link")
            )
          : null
      ),
      el(
        "div",
        { className: "oauth-url-row" },
        el("span", { className: "oauth-url mono", title: model.authUrl || "" }, model.authUrl || ""),
        copyBtn
      )
    );

    const form = el(
      "form",
      {
        className: "oauth-code-form",
        onSubmit: (event) => {
          event.preventDefault();
          void submitAddCode();
        },
      },
      el(
        "div",
        { className: "field-group" },
        el("label", { for: codeInputId, className: "field-label" }, t("app.add.code_label")),
        codeInput
      ),
      model.phase === "submitting" ? busyLine(t("app.add.submitting")) : null,
      model.phase === "cancelling" ? busyLine(t("web.add.cancelling")) : null,
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            dataset: { addCancel: "true" },
            disabled: busy,
            onClick: () => {
              void cancelPendingAddFlow();
            },
          },
          t("app.action.cancel")
        ),
        submitBtn
      )
    );

    dialog.append(
      title,
      el(
        "div",
        { className: "dialog-body" },
        el("p", { className: "dialog-paragraph" }, t("web.add.open_hint")),
        oauthBox,
        form
      )
    );
    return;
  }

  if (model.phase === "rolling_back") {
    dialog.append(
      title,
      el("div", { className: "dialog-body" }, busyLine(t("web.add.cancelling"))),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            disabled: true,
          },
          t("app.action.close")
        )
      )
    );
    return;
  }

  if (model.phase === "expired") {
    const rollbackRunning = hasAnyLoginOp(state.snapshot);
    model.rollbackRunning = rollbackRunning;
    dialog.append(
      title,
      el(
        "div",
        { className: "dialog-body" },
        alertBox({
          tone: "warning",
          title: t("app.err.login_cancelled"),
          body: t("web.add.expired_or_cancelled"),
          live: true,
        }),
        rollbackRunning
          ? busyLine(t("web.add.cancelling"))
          : el("p", { className: "dialog-caption" }, t("app.add.rolled_back"))
      ),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            disabled: rollbackRunning,
            onClick: () => closeDialogNow(),
          },
          t("app.action.close")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            dataset: { addStartAgain: "true" },
            disabled: rollbackRunning,
            autofocus: !rollbackRunning,
            onClick: () => {
              void startAddFlow();
            },
          },
          t("app.add.start_again")
        )
      )
    );
    return;
  }

  const formatted = formatApiError(model.error);
  dialog.append(
    title,
    el(
      "div",
      { className: "dialog-body" },
      alertBox({
        tone: "danger",
        title: formatted.message,
        body: formatted.hint,
        live: true,
      }),
      el("p", { className: "dialog-caption" }, t("app.add.rolled_back"))
    ),
    el(
      "div",
      { className: "modal-actions" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-ghost",
          onClick: () => closeDialogNow(),
        },
        t("app.action.close")
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          dataset: { addStartAgain: "true" },
          autofocus: true,
          onClick: () => {
            void startAddFlow();
          },
        },
        t("app.add.start_again")
      )
    )
  );
}

function renderSwitchDialog(dialog, model) {
  dialog.dataset.dialogKind = "switch";
  dialog.dataset.dialogPhase = model.phase;
  const email = formatEmail(model.account?.email);
  const title = el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.switch.title", { email }));

  const bodyChildren = [];
  if (model.phase === "loading") {
    bodyChildren.push(busyLine(t("app.switch.loading")));
  } else if (model.phase === "load_error") {
    const formatted = formatApiError(model.loadError);
    bodyChildren.push(
      alertBox({
        tone: "danger",
        title: formatted.message,
        body: formatted.hint,
        actions: el(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            onClick: () => {
              void loadSwitchPreview();
            },
          },
          t("app.action.retry")
        ),
        live: true,
      })
    );
  } else if (model.phase === "ready") {
    bodyChildren.push(renderImpactList(model.preview?.impact));
  }

  if (model.confirmError) {
    const formatted = formatApiError(model.confirmError);
    bodyChildren.push(
      alertBox({
        tone: model.impactChanged ? "warning" : "danger",
        title: formatted.message,
        body: formatted.hint,
        actions: model.impactChanged
          ? el(
              "button",
              {
                type: "button",
                className: "btn btn-sm",
                onClick: () => {
                  void loadSwitchPreview();
                },
              },
              t("web.switch.review_again")
            )
          : null,
        live: true,
      })
    );
  }

  const canConfirm = model.phase === "ready" && !model.submitting && !model.impactChanged;
  dialog.append(
    title,
    el("div", { className: "dialog-body" }, bodyChildren),
    el(
      "div",
      { className: "modal-actions" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-ghost",
          disabled: model.submitting,
          onClick: () => closeDialogNow(),
        },
        t("app.action.cancel")
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          dataset: { switchConfirm: "true" },
          disabled: !canConfirm,
          autofocus: canConfirm,
          onClick: () => {
            void executeSwitchAccount();
          },
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
        t("app.switch.confirm")
      )
    )
  );
}

function renderRemoveDialog(dialog, model) {
  dialog.dataset.dialogKind = "remove";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "confirm";
  const email = formatEmail(model.account?.email);
  const title = el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.remove.title", { email }));

  const bodyChildren = [el("p", { className: "dialog-paragraph" }, t("app.remove.body"))];
  if (model.error) {
    const formatted = formatApiError(model.error);
    bodyChildren.push(
      alertBox({
        tone: "danger",
        title: formatted.message,
        body: formatted.hint,
        live: true,
      })
    );
  }

  dialog.append(
    title,
    el("div", { className: "dialog-body" }, bodyChildren),
    el(
      "div",
      { className: "modal-actions" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn-ghost",
          disabled: model.submitting,
          autofocus: true,
          onClick: () => closeDialogNow(),
        },
        t("app.action.cancel")
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-danger",
          dataset: { removeConfirm: "true" },
          disabled: model.submitting,
          onClick: () => {
            void executeRemoveAccount();
          },
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
        t("app.remove.confirm")
      )
    )
  );
}

function renderActiveDialog() {
  if (!activeDialog) return;
  const dialog = ensureDialogOpen();
  if (!dialog) return;
  clear(dialog);
  if (activeDialog.kind === "add") {
    renderAddDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "switch") {
    renderSwitchDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "remove") {
    renderRemoveDialog(dialog, activeDialog);
  }
  const preferred = dialog.querySelector("[autofocus]:not(:disabled)");
  if (preferred) {
    window.requestAnimationFrame(() => {
      if (preferred.isConnected && dialog.open) {
        preferred.focus({ preventScroll: true });
      }
    });
  }
}

export function initAccountDialogs() {
  if (initialized) return;
  initialized = true;

  const dialog = getDialogEl();
  if (dialog) {
    dialog.addEventListener("cancel", (event) => {
      if (!activeDialog) return;
      if (isBusy(activeDialog)) {
        event.preventDefault();
        return;
      }
      if (activeDialog.kind === "add" && activeDialog.phase === "code") {
        // Intercept Esc during active OAuth flow so the server credential lock rolls back cleanly.
        event.preventDefault();
        void cancelPendingAddFlow();
        return;
      }
      dialogGeneration += 1;
      activeDialog = null;
      clear(dialog);
    });
  }

  subscribe((_, reason) => {
    if (reason === "auth" && !state.authenticated) {
      closeDialogNow();
      return;
    }
    if (reason === "snapshot" && activeDialog?.kind === "add") {
      if (activeDialog.phase === "intro") {
        // Reflect whether another tab started or cleared a pending login.
        renderActiveDialog();
        return;
      }
      if (activeDialog.phase === "code" && activeDialog.loginId !== null) {
        if (state.snapshot?.login_id === activeDialog.loginId) {
          activeDialog.seenInSnapshot = true;
        } else if (activeDialog.seenInSnapshot && state.snapshot?.login_id !== activeDialog.loginId) {
          // Server inactivity timeout or external cancel released login_id; wait for rollback job to finish.
          activeDialog.codeDraft = "";
          if (hasLoginRollbackOp(state.snapshot, activeDialog.loginId)) {
            activeDialog.phase = "rolling_back";
          } else {
            activeDialog.phase = "expired";
            activeDialog.loginId = null;
          }
          renderActiveDialog();
        }
        return;
      }
      if (activeDialog.phase === "rolling_back" && activeDialog.loginId !== null) {
        if (!hasLoginRollbackOp(state.snapshot, activeDialog.loginId)) {
          activeDialog.phase = "expired";
          activeDialog.loginId = null;
          activeDialog.rollbackRunning = hasAnyLoginOp(state.snapshot);
          renderActiveDialog();
        }
        return;
      }
      if (activeDialog.phase === "expired") {
        const running = hasAnyLoginOp(state.snapshot);
        if (running !== Boolean(activeDialog.rollbackRunning)) {
          activeDialog.rollbackRunning = running;
          renderActiveDialog();
        }
      }
    }
  });

  onLocaleChange(() => {
    if (activeDialog) {
      renderActiveDialog();
    }
  });
}

export function openAddAccountDialog() {
  initAccountDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "add",
    phase: "intro",
    loginId: null,
    authUrl: null,
    codeDraft: "",
    error: null,
    seenInSnapshot: false,
    cancellingExisting: false,
  };
  renderActiveDialog();
}

export function openSwitchAccountDialog(account) {
  if (!account || !account.id) return;
  initAccountDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "switch",
    account,
    phase: "loading",
    preview: null,
    loadError: null,
    confirmError: null,
    impactChanged: false,
    submitting: false,
  };
  renderActiveDialog();
  void loadSwitchPreview();
}

export function openRemoveAccountDialog(account) {
  if (!account || !account.id) return;
  initAccountDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "remove",
    account,
    submitting: false,
    error: null,
  };
  renderActiveDialog();
}
