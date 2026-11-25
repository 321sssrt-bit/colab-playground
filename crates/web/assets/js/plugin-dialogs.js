import { alertBox, announce, badge, busyLine, clear, el, inlineMessage } from "./components.js";
import { formatApiError, formatBytes } from "./format.js";
import { localized, onLocaleChange, t } from "./i18n.js";
import { icon } from "./icons.js";
import {
  deleteHfToken,
  discardPluginPreview,
  installPlugin,
  loadHfToken,
  previewPlugin,
  removePlugin,
  saveHfToken,
  setNotice,
  state,
  subscribe,
} from "./store.js";

const DIALOG_ID = "plugin-dialog";
const TITLE_ID = "plugin-dialog-title";

let initialized = false;
let activeDialog = null;
let dialogGeneration = 0;

function getDialogEl() {
  return document.getElementById(DIALOG_ID);
}

export function isGitSource(text) {
  const trimmed = String(text || "").trim();
  return trimmed.includes("://") || trimmed.startsWith("git@");
}

function isDialogBusy(dialog) {
  if (!dialog) return false;
  if (dialog.kind === "install") {
    return dialog.phase === "installing";
  }
  if (dialog.kind === "remove") {
    return Boolean(dialog.submitting);
  }
  if (dialog.kind === "hf_token") {
    return Boolean(dialog.submitting);
  }
  return false;
}

function discardActivePreviewIfAny(dialogModel) {
  const previewId = dialogModel?.preview?.preview_id;
  if (previewId && !dialogModel.installConfirmed) {
    dialogModel.preview = null;
    void discardPluginPreview(previewId);
  }
}

function closeDialogNow() {
  dialogGeneration += 1;
  const prev = activeDialog;
  activeDialog = null;
  discardActivePreviewIfAny(prev);
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

function factRow(label, value) {
  return el(
    "div",
    { className: "plugin-fact-row" },
    el("span", { className: "plugin-fact-key" }, label),
    el("span", { className: "plugin-fact-val" }, value)
  );
}

async function runInspectSource(model) {
  const trimmed = (model.sourceDraft || "").trim();
  if (!trimmed) {
    model.validationError = t("web.plugins.source_required");
    renderActiveDialog();
    return;
  }
  const gen = ++dialogGeneration;
  discardActivePreviewIfAny(model);
  model.phase = "checking";
  model.originText = trimmed;
  model.error = null;
  model.validationError = null;
  model.preview = null;
  model.installConfirmed = false;
  renderActiveDialog();

  const origin = isGitSource(trimmed)
    ? { kind: "git", url: trimmed }
    : { kind: "folder", path: trimmed };

  try {
    const preview = await previewPlugin(origin);
    if (gen !== dialogGeneration || activeDialog !== model) {
      if (preview?.preview_id) {
        void discardPluginPreview(preview.preview_id);
      }
      return;
    }
    model.preview = preview;
    model.phase = "preview";
    renderActiveDialog();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || activeDialog !== model) return;
    model.phase = "failed";
    model.error = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

async function confirmInstall(model) {
  const previewId = model?.preview?.preview_id;
  if (!previewId || model.phase === "installing") return;
  const gen = ++dialogGeneration;
  model.phase = "installing";
  model.installConfirmed = true;
  model.error = null;
  renderActiveDialog();

  try {
    const info = await installPlugin(previewId);
    if (gen !== dialogGeneration) return;
    const name = localized(info?.manifest?.name) || info?.manifest?.id || "";
    const msg = t("app.b2.plugin_installed", { name });
    setNotice({ tone: "success", message: msg });
    announce(msg);
    if (typeof model.onInstalled === "function") {
      model.onInstalled(info);
    }
    closeDialogNow();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || activeDialog !== model) return;
    model.preview = null;
    model.phase = "failed";
    model.error = err?.payload || { error: {} };
    renderActiveDialog();
  }
}

function renderInstallDialog(dialog, model) {
  dialog.dataset.dialogKind = "install";
  dialog.dataset.dialogPhase = model.phase;
  const title = el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.plugin_install_title"));

  if (model.phase === "input") {
    const inputId = "plugin-install-source-input";
    const sourceInput = el("input", {
      id: inputId,
      type: "text",
      className: "input",
      placeholder: t("app.b2.plugin_source_placeholder"),
      value: model.sourceDraft || "",
      autocomplete: "off",
      spellcheck: "false",
      autofocus: true,
      onInput: (event) => {
        model.sourceDraft = event.target.value;
        if (model.validationError) {
          model.validationError = null;
        }
      },
    });

    const form = el(
      "form",
      {
        className: "dialog-form",
        dataset: { pluginInstallForm: "true" },
        onSubmit: (event) => {
          event.preventDefault();
          void runInspectSource(model);
        },
      },
      el(
        "div",
        { className: "dialog-body" },
        el("p", { className: "dialog-paragraph" }, t("app.b2.plugin_install_hint")),
        model.validationError ? inlineMessage({ tone: "danger", text: model.validationError }) : null,
        el(
          "div",
          { className: "field-group" },
          el("label", { for: inputId, className: "field-label" }, t("app.b2.plugin_source")),
          sourceInput
        )
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
          t("app.action.cancel")
        ),
        el(
          "button",
          {
            type: "submit",
            className: "btn btn-primary",
            dataset: { pluginInstallCheck: "true" },
          },
          t("app.b2.plugin_check")
        )
      )
    );
    dialog.append(title, form);
    return;
  }

  if (model.phase === "checking" || model.phase === "installing") {
    dialog.append(
      title,
      el("div", { className: "dialog-body" }, busyLine(t("app.b2.plugin_checking"))),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            disabled: model.phase === "installing",
            onClick: () => closeDialogNow(),
          },
          t("app.action.cancel")
        )
      )
    );
    return;
  }

  if (model.phase === "failed") {
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
        })
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
          t("app.action.cancel")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            autofocus: true,
            onClick: () => {
              model.phase = "input";
              model.error = null;
              renderActiveDialog();
            },
          },
          t("web.plugins.back_to_source")
        )
      )
    );
    return;
  }

  // Preview confirmation (1:1 mirror of crates/app/src/ui/overlays/plugin.rs::install)
  const preview = model.preview;
  const manifest = preview?.manifest || {};
  const name = localized(manifest.name) || manifest.id || "";
  const description = localized(manifest.description);
  const sep = t("app.fmt.list_separator");

  const inputsList = (Array.isArray(manifest.inputs) ? manifest.inputs : []).map((input) => {
    const label = localized(input.label) || input.id;
    return input.type === "secret" ? t("app.b2.plugin_input_secret", { name: label }) : label;
  });
  const needsList = (Array.isArray(manifest.needs) ? manifest.needs : []).map((cap) =>
    cap === "hf_token" ? t("app.b2.plugin_needs_hf_token") : String(cap)
  );
  const endpointsList = (Array.isArray(manifest.endpoints) ? manifest.endpoints : []).map(
    (ep) => localized(ep.label) || ep.id
  );

  const facts = [
    el("div", { className: "plugin-card-name" }, name),
    description ? el("p", { className: "caption" }, description) : null,
    factRow(t("app.b2.plugin_version"), manifest.version || ""),
    factRow(t("app.b2.plugin_from"), model.originText || ""),
    factRow(
      t("app.b2.plugin_script"),
      t("app.b2.plugin_script_value", {
        file: manifest.run?.script || "",
        size: formatBytes(preview?.script_bytes ?? 0),
      })
    ),
  ];

  if (inputsList.length > 0) {
    facts.push(factRow(t("app.b2.plugin_asks"), inputsList.join(sep)));
  }
  facts.push(
    factRow(
      t("app.b2.plugin_receives"),
      needsList.length > 0 ? needsList.join(sep) : t("app.b2.plugin_receives_nothing")
    )
  );
  if (endpointsList.length > 0) {
    facts.push(factRow(t("app.b2.plugin_offers"), endpointsList.join(sep)));
  }

  const bodyNodes = [
    el("div", { className: "plugin-facts", dataset: { pluginPreview: manifest.id || "" } }, facts),
    inlineMessage({
      tone: "warning",
      text: t(preview?.warning_key || "app.b2.plugin_runs_on_runtime"),
    }),
  ];
  if (preview?.replaces_version) {
    bodyNodes.push(
      inlineMessage({
        tone: "info",
        text: t("app.b2.plugin_replaces", { version: preview.replaces_version }),
      })
    );
  }

  dialog.append(
    title,
    el("div", { className: "dialog-body" }, bodyNodes),
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
          dataset: { pluginInstallConfirm: "true" },
          autofocus: true,
          onClick: () => {
            void confirmInstall(model);
          },
        },
        t("app.b2.plugin_install_action")
      )
    )
  );
}

function renderRemoveDialog(dialog, model) {
  dialog.dataset.dialogKind = "remove";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "confirm";

  const bodyNodes = [el("p", { className: "dialog-paragraph" }, t("app.b2.plugin_remove_body"))];
  if (model.error) {
    const formatted = formatApiError(model.error);
    bodyNodes.push(
      alertBox({
        tone: "danger",
        title: formatted.message,
        body: formatted.hint,
        live: true,
      })
    );
  }

  dialog.append(
    el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.plugin_remove_title", { name: model.name })),
    el("div", { className: "dialog-body" }, bodyNodes),
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
          dataset: { pluginRemoveConfirm: model.id },
          disabled: model.submitting,
          onClick: async () => {
            if (model.submitting) return;
            const gen = ++dialogGeneration;
            model.submitting = true;
            model.error = null;
            renderActiveDialog();
            try {
              await removePlugin(model.id);
              if (gen !== dialogGeneration) return;
              const msg = t("app.b2.plugin_removed", { name: model.name });
              setNotice({ tone: "success", message: msg });
              announce(msg);
              closeDialogNow();
            } catch (err) {
              if (err && err.status === 401) {
                closeDialogNow();
                return;
              }
              if (gen !== dialogGeneration || activeDialog !== model) return;
              model.submitting = false;
              model.error = err?.payload || { error: {} };
              renderActiveDialog();
            }
          },
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("trash2"),
        t("app.b2.action_remove")
      )
    )
  );
}

function hfTokenStatusBadge() {
  if (state.hfToken.status === "ready") {
    return state.hfToken.saved
      ? badge(t("app.b2.hf_token_stored"), "success")
      : badge(t("app.b2.hf_token_none"), "neutral");
  }
  if (state.hfToken.status === "error") {
    return badge(t("app.b2.hf_token_unknown"), "warning");
  }
  return badge(t("app.summary.unknown"), "neutral");
}

function renderHfTokenDialog(dialog, model) {
  dialog.dataset.dialogKind = "hf_token";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "editing";

  const saved = state.hfToken.status === "ready" && state.hfToken.saved;
  const inputId = "hf-token-dialog-input";

  const tokenInput = el("input", {
    id: inputId,
    type: "password",
    className: "input mono",
    autocomplete: "new-password",
    autocorrect: "off",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: t("app.b2.hf_token_placeholder"),
    disabled: model.submitting,
    autofocus: true,
  });

  const bodyNodes = [
    el(
      "div",
      { className: "plugin-card-title-row" },
      hfTokenStatusBadge()
    ),
    el("p", { className: "dialog-paragraph" }, t("app.b2.hf_token_hint")),
  ];

  if (model.error) {
    const formatted = formatApiError(model.error);
    bodyNodes.push(
      alertBox({
        tone: "danger",
        title: formatted.message,
        body: formatted.hint,
        live: true,
      })
    );
  } else if (model.validationError) {
    bodyNodes.push(inlineMessage({ tone: "danger", text: model.validationError }));
  }

  bodyNodes.push(
    el(
      "div",
      { className: "field-group" },
      el("label", { for: inputId, className: "field-label" }, t("app.b2.hf_token_field")),
      tokenInput
    )
  );

  const form = el(
    "form",
    {
      className: "dialog-form",
      dataset: { hfTokenForm: "true" },
      onSubmit: async (event) => {
        event.preventDefault();
        if (model.submitting) return;
        // Read directly from DOM password input and clear immediately; never persist in state.
        const raw = tokenInput.value.trim();
        if (!raw) {
          model.validationError = t("web.plugins.token_required");
          model.error = null;
          renderActiveDialog();
          return;
        }
        tokenInput.value = "";
        const gen = ++dialogGeneration;
        model.submitting = true;
        model.error = null;
        model.validationError = null;
        renderActiveDialog();
        try {
          await saveHfToken(raw);
          if (gen !== dialogGeneration) return;
          setNotice({ tone: "success", message: t("app.b2.hf_token_saved") });
          announce(t("app.b2.hf_token_saved"));
          closeDialogNow();
        } catch (err) {
          if (err && err.status === 401) {
            closeDialogNow();
            return;
          }
          if (gen !== dialogGeneration || activeDialog !== model) return;
          model.submitting = false;
          model.error = err?.payload || { error: {} };
          renderActiveDialog();
        }
      },
    },
    el("div", { className: "dialog-body" }, bodyNodes),
    el(
      "div",
      { className: "modal-actions" },
      saved
        ? el(
            "button",
            {
              type: "button",
              className: "btn btn-danger",
              dataset: { hfTokenDelete: "true" },
              disabled: model.submitting,
              onClick: async () => {
                if (model.submitting) return;
                const gen = ++dialogGeneration;
                model.submitting = true;
                model.error = null;
                model.validationError = null;
                renderActiveDialog();
                try {
                  await deleteHfToken();
                  if (gen !== dialogGeneration) return;
                  setNotice({ tone: "info", message: t("app.b2.hf_token_deleted") });
                  announce(t("app.b2.hf_token_deleted"));
                  closeDialogNow();
                } catch (err) {
                  if (err && err.status === 401) {
                    closeDialogNow();
                    return;
                  }
                  if (gen !== dialogGeneration || activeDialog !== model) return;
                  model.submitting = false;
                  model.error = err?.payload || { error: {} };
                  renderActiveDialog();
                }
              },
            },
            icon("trash2"),
            t("app.b2.action_delete")
          )
        : null,
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
          type: "submit",
          className: "btn btn-primary",
          dataset: { hfTokenSave: "true" },
          disabled: model.submitting,
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
        t(saved ? "web.plugins.replace_token" : "app.b2.action_save")
      )
    )
  );

  dialog.append(el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.hf_token_title")), form);
}

function renderActiveDialog() {
  if (!activeDialog) return;
  const dialog = ensureDialogOpen();
  if (!dialog) return;
  clear(dialog);
  if (activeDialog.kind === "install") {
    renderInstallDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "remove") {
    renderRemoveDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "hf_token") {
    renderHfTokenDialog(dialog, activeDialog);
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

export function initPluginDialogs() {
  if (initialized) return;
  initialized = true;

  const dialog = getDialogEl();
  if (dialog) {
    dialog.addEventListener("cancel", (event) => {
      if (!activeDialog) return;
      if (isDialogBusy(activeDialog)) {
        event.preventDefault();
        return;
      }
      dialogGeneration += 1;
      const prev = activeDialog;
      activeDialog = null;
      discardActivePreviewIfAny(prev);
      clear(dialog);
    });
  }

  // Isolate active dialog inputs from background SSE snapshot refreshes.
  subscribe((_, reason) => {
    if (reason === "auth" && !state.authenticated) {
      closeDialogNow();
    }
  });

  onLocaleChange(() => {
    if (activeDialog && activeDialog.kind !== "hf_token") {
      renderActiveDialog();
    }
  });
}

export function openInstallPluginDialog({ initialSource = "", inspectImmediately = false, onInstalled = null } = {}) {
  initPluginDialogs();
  dialogGeneration += 1;
  discardActivePreviewIfAny(activeDialog);
  const model = {
    kind: "install",
    phase: "input",
    sourceDraft: initialSource || "",
    originText: "",
    preview: null,
    installConfirmed: false,
    error: null,
    validationError: null,
    onInstalled,
  };
  activeDialog = model;
  if (inspectImmediately && model.sourceDraft.trim()) {
    void runInspectSource(model);
  } else {
    renderActiveDialog();
  }
}

export function openRemovePluginDialog(info) {
  if (!info?.manifest?.id) return;
  initPluginDialogs();
  dialogGeneration += 1;
  discardActivePreviewIfAny(activeDialog);
  activeDialog = {
    kind: "remove",
    id: info.manifest.id,
    name: localized(info.manifest.name) || info.manifest.id,
    submitting: false,
    error: null,
  };
  renderActiveDialog();
}

export function openHfTokenDialog() {
  initPluginDialogs();
  dialogGeneration += 1;
  discardActivePreviewIfAny(activeDialog);
  activeDialog = {
    kind: "hf_token",
    submitting: false,
    error: null,
    validationError: null,
  };
  renderActiveDialog();
  if (state.hfToken.status === "idle") {
    void loadHfToken({ silent: true });
  }
}
