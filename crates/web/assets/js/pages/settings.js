import {
  alertBox,
  announce,
  appearanceSegmented,
  badge,
  clear,
  el,
  languageSelect,
} from "../components.js";
import {
  ACCELERATORS,
  acceleratorLabel,
  composeDuration,
  formatApiError,
  splitDuration,
} from "../format.js";
import { getLanguagePreference, setLanguagePreference, t } from "../i18n.js";
import { icon } from "../icons.js";
import { loadSettings, loadUpdates, patchSettings, state } from "../store.js";
import { getAppearancePreference, setAppearancePreference } from "../theme.js";

const MAX_ATTEMPTS_CAP = 8;
const MAX_CONCURRENT_FIELD = 20;
const MAX_CU_FIELD = 100000;
const MAX_VRAM_GIB = 1024;
const MIB_PER_GIB = 1024;
const START_MAX_RUNTIME_SECS = 7200;
const START_IDLE_SECS = 1800;
const START_SPEND_CU = 10;
const START_MIN_BALANCE_CU = 5;
const START_MIN_VRAM_MIB = 40 * MIB_PER_GIB;

function cloneDefaults(defaults) {
  return JSON.parse(JSON.stringify(defaults));
}

export function createSettingsPage() {
  let root = null;
  let headerEl = null;
  let noticesEl = null;
  let generalEl = null;
  let defaultsEl = null;
  let aboutEl = null;

  // Isolated form state: background SSE snapshot pushes never overwrite draft edits.
  let draft = null;
  let dirty = false;
  let saving = false;
  let saveError = null;
  let saveStatus = null;
  let copiedFeedback = false;

  function renderHeader() {
    if (!headerEl) return;
    clear(headerEl);
    headerEl.append(
      el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t("app.nav.settings")),
      el("p", { className: "page-subtitle" }, t("app.settings.subtitle"))
    );
  }

  function renderNotices() {
    if (!noticesEl) return;
    clear(noticesEl);
    const settings = state.settings;
    if (!settings) return;
    if (settings.load_status === "corrupt") {
      const body = settings.corrupt_backup
        ? t("app.toast.settings_reset.body", { file: settings.corrupt_backup })
        : t("app.toast.settings_reset.body_lost");
      noticesEl.appendChild(
        alertBox({
          tone: "warning",
          title: t("app.toast.settings_reset.title"),
          body,
        })
      );
    }
    if (Array.isArray(settings.reset_defaults) && settings.reset_defaults.length > 0) {
      noticesEl.appendChild(
        alertBox({
          tone: "warning",
          title: t("app.toast.defaults_reset.title"),
          body: t("app.toast.defaults_reset.body", {
            fields: settings.reset_defaults.join(t("app.fmt.list_separator")),
          }),
        })
      );
    }
  }

  function settingsRow(title, desc, control) {
    return el(
      "div",
      { className: "settings-row" },
      el(
        "div",
        { className: "settings-row-info" },
        el("div", { className: "settings-row-title" }, title),
        desc ? el("div", { className: "settings-row-desc" }, desc) : null
      ),
      el("div", { className: "settings-row-control" }, control)
    );
  }

  function renderGeneralSection() {
    if (!generalEl) return;
    clear(generalEl);

    const currentLang = state.settings?.language || getLanguagePreference();
    const currentAppearance = state.settings?.appearance || getAppearancePreference();

    const langControl = languageSelect({
      id: "settings-language",
      value: currentLang,
      ariaLabel: t("app.settings.language.title"),
      onChange: async (next) => {
        await setLanguagePreference(next, { persist: true });
        try {
          await patchSettings({ language: next });
        } catch {
          // Local browser preference still applies cleanly.
        }
      },
    });

    const appearanceControl = appearanceSegmented({
      name: "settings-appearance",
      value: currentAppearance,
      onChange: async (next) => {
        setAppearancePreference(next, { persist: true });
        try {
          await patchSettings({ appearance: next });
        } catch {
          // Local browser preference still applies cleanly.
        }
      },
    });

    generalEl.appendChild(
      el(
        "section",
        { className: "card" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.settings.general.title")),
          el("p", { className: "card-desc" }, t("app.settings.general.description"))
        ),
        el(
          "div",
          { className: "settings-list" },
          settingsRow(
            t("app.settings.language.title"),
            t("app.settings.language.description"),
            langControl
          ),
          settingsRow(
            t("app.settings.appearance.title"),
            t("app.settings.appearance.description"),
            appearanceControl
          )
        )
      )
    );
  }

  function markDirty() {
    dirty = true;
    saveError = null;
    saveStatus = null;
    updateDefaultsFooter();
  }

  function updateDefaultsFooter() {
    if (!defaultsEl) return;
    const statusEl = defaultsEl.querySelector('[data-defaults-status="true"]');
    if (statusEl) {
      clear(statusEl);
      if (saveError) {
        statusEl.appendChild(badge(saveError, "danger"));
      } else if (dirty) {
        statusEl.appendChild(badge(t("web.settings.unsaved"), "warning"));
      } else if (saveStatus) {
        statusEl.appendChild(badge(saveStatus, "success"));
      }
    }
    const discardBtn = defaultsEl.querySelector('[data-defaults-discard="true"]');
    if (discardBtn) {
      discardBtn.disabled = saving || !dirty;
    }
    const saveBtn = defaultsEl.querySelector('[data-defaults-save="true"]');
    if (saveBtn) {
      saveBtn.disabled = saving;
    }
  }

  function buildDurationControl(idPrefix, totalSecs, includeSeconds, onChange) {
    let parts = splitDuration(totalSecs, includeSeconds);
    const emit = () => {
      onChange(composeDuration(parts.hours, parts.minutes, includeSeconds ? parts.seconds : 0));
    };

    const partInput = (suffix, value, max, unitKey, field) => {
      const inputId = `${idPrefix}-${suffix}`;
      return el(
        "span",
        { className: "unit-field" },
        el("input", {
          id: inputId,
          type: "number",
          min: "0",
          max: String(max),
          step: "1",
          className: "input input-sm input-num",
          "aria-label": t(unitKey),
          value: String(value),
          onInput: (event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            parts = { ...parts, [field]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 };
            emit();
          },
        }),
        el("label", { for: inputId, className: "unit-suffix" }, t(unitKey))
      );
    };

    return el(
      "div",
      { className: "duration-group" },
      partInput("hours", parts.hours, 999, "app.b3.unit_hours", "hours"),
      partInput("minutes", parts.minutes, 59, "app.b3.unit_minutes", "minutes"),
      includeSeconds ? partInput("seconds", parts.seconds, 59, "app.b3.unit_seconds", "seconds") : null
    );
  }

  function buildOptionalControl({ id, enabled, onToggle, renderValue }) {
    const slot = el("div", { className: "unit-group" });
    const syncSlot = (isOn) => {
      clear(slot);
      if (isOn) {
        slot.appendChild(renderValue());
      } else {
        slot.appendChild(el("span", { className: "field-hint" }, t("app.def.no_limit")));
      }
    };
    syncSlot(enabled);

    const toggleId = `def-toggle-${id}`;
    const checkbox = el("input", {
      id: toggleId,
      type: "checkbox",
      className: "checkbox",
      checked: enabled,
      onChange: (event) => {
        const nextOn = event.target.checked;
        onToggle(nextOn);
        syncSlot(nextOn);
      },
    });

    return el(
      "div",
      { className: "optional-control" },
      el("label", { for: toggleId, className: "checkbox-label" }, checkbox, t("app.def.limit")),
      slot
    );
  }

  function renderDefaultsSection() {
    if (!defaultsEl) return;
    clear(defaultsEl);

    if (!draft && state.settings?.defaults) {
      draft = cloneDefaults(state.settings.defaults);
    }

    if (!draft) {
      defaultsEl.appendChild(
        el(
          "section",
          { className: "card" },
          el("h2", { className: "card-title" }, t("app.defaults.title")),
          el("p", { className: "card-desc" }, t("web.settings.loading"))
        )
      );
      return;
    }

    const maxRuntimeControl = buildOptionalControl({
      id: "max-runtime",
      enabled: draft.max_runtime !== null && draft.max_runtime !== undefined,
      onToggle: (on) => {
        draft.max_runtime = on ? START_MAX_RUNTIME_SECS : null;
        markDirty();
      },
      renderValue: () =>
        buildDurationControl("def-max-runtime", draft.max_runtime ?? START_MAX_RUNTIME_SECS, false, (secs) => {
          draft.max_runtime = secs;
          markDirty();
        }),
    });

    const maxSpendControl = buildOptionalControl({
      id: "max-spend",
      enabled: draft.max_spend_cu !== null && draft.max_spend_cu !== undefined,
      onToggle: (on) => {
        draft.max_spend_cu = on ? START_SPEND_CU : null;
        markDirty();
      },
      renderValue: () =>
        el(
          "span",
          { className: "unit-field" },
          el("input", {
            id: "def-max-spend",
            type: "number",
            min: "0",
            max: String(MAX_CU_FIELD),
            step: "0.5",
            className: "input input-sm input-num",
            "aria-label": t("app.def.max_spend"),
            value: String(draft.max_spend_cu ?? START_SPEND_CU),
            onInput: (event) => {
              const val = Number.parseFloat(event.target.value);
              draft.max_spend_cu = Number.isFinite(val) ? Math.max(0, val) : 0;
              markDirty();
            },
          }),
          el("span", { className: "unit-suffix" }, t("app.unit.cu"))
        ),
    });

    const minBalanceControl = buildOptionalControl({
      id: "min-balance",
      enabled: draft.min_balance_cu !== null && draft.min_balance_cu !== undefined,
      onToggle: (on) => {
        draft.min_balance_cu = on ? START_MIN_BALANCE_CU : null;
        markDirty();
      },
      renderValue: () =>
        el(
          "span",
          { className: "unit-field" },
          el("input", {
            id: "def-min-balance",
            type: "number",
            min: "0",
            max: String(MAX_CU_FIELD),
            step: "0.5",
            className: "input input-sm input-num",
            "aria-label": t("app.def.min_balance"),
            value: String(draft.min_balance_cu ?? START_MIN_BALANCE_CU),
            onInput: (event) => {
              const val = Number.parseFloat(event.target.value);
              draft.min_balance_cu = Number.isFinite(val) ? Math.max(0, val) : 0;
              markDirty();
            },
          }),
          el("span", { className: "unit-suffix" }, t("app.unit.cu"))
        ),
    });

    const idleControl = buildOptionalControl({
      id: "idle-timeout",
      enabled: draft.idle_timeout !== null && draft.idle_timeout !== undefined,
      onToggle: (on) => {
        draft.idle_timeout = on ? START_IDLE_SECS : null;
        markDirty();
      },
      renderValue: () =>
        buildDurationControl("def-idle", draft.idle_timeout ?? START_IDLE_SECS, false, (secs) => {
          draft.idle_timeout = secs;
          markDirty();
        }),
    });

    const concurrentControl = el("input", {
      id: "def-concurrent",
      type: "number",
      min: "1",
      max: String(MAX_CONCURRENT_FIELD),
      step: "1",
      className: "input input-sm input-num",
      "aria-label": t("app.def.concurrent"),
      value: String(draft.max_concurrent_sessions ?? 2),
      onInput: (event) => {
        const val = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(val)) {
          draft.max_concurrent_sessions = Math.max(1, val);
          markDirty();
        }
      },
    });

    const attemptsControl = el("input", {
      id: "def-attempts",
      type: "number",
      min: "1",
      max: String(MAX_ATTEMPTS_CAP),
      step: "1",
      className: "input input-sm input-num",
      "aria-label": t("app.def.attempts"),
      value: String(draft.max_attempts ?? 3),
      onInput: (event) => {
        const val = Number.parseInt(event.target.value, 10);
        if (Number.isFinite(val)) {
          draft.max_attempts = Math.max(1, Math.min(MAX_ATTEMPTS_CAP, val));
          markDirty();
        }
      },
    });

    const retryDelayControl = buildDurationControl("def-retry-delay", draft.retry_delay ?? 20, true, (secs) => {
      draft.retry_delay = secs;
      markDirty();
    });

    const exhaustedSelect = el(
      "select",
      {
        id: "def-on-exhausted",
        className: "select select-sm select-inline",
        "aria-label": t("app.def.on_exhausted"),
        onChange: (event) => {
          draft.on_exhausted = event.target.value;
          markDirty();
        },
      },
      el("option", { value: "stop_and_fail", selected: draft.on_exhausted === "stop_and_fail" }, t("app.def.exhausted_stop")),
      el("option", { value: "keep_last", selected: draft.on_exhausted === "keep_last" }, t("app.def.exhausted_keep"))
    );
    exhaustedSelect.value = draft.on_exhausted || "stop_and_fail";

    const acceleratorSelect = el(
      "select",
      {
        id: "def-accelerator",
        className: "select select-sm select-inline",
        "aria-label": t("app.def.accelerator"),
        onChange: (event) => {
          draft.accelerator = event.target.value;
          markDirty();
        },
      },
      ACCELERATORS.map((code) =>
        el("option", { value: code, selected: draft.accelerator === code }, acceleratorLabel(code))
      )
    );
    acceleratorSelect.value = draft.accelerator || "A100";

    const highMemControl = el(
      "label",
      { for: "def-high-mem", className: "checkbox-label" },
      el("input", {
        id: "def-high-mem",
        type: "checkbox",
        className: "checkbox",
        checked: Boolean(draft.high_mem),
        onChange: (event) => {
          draft.high_mem = event.target.checked;
          markDirty();
        },
      }),
      t("app.def.high_mem")
    );

    const minVramControl = buildOptionalControl({
      id: "min-vram",
      enabled: draft.min_vram_mib !== null && draft.min_vram_mib !== undefined,
      onToggle: (on) => {
        draft.min_vram_mib = on ? START_MIN_VRAM_MIB : null;
        markDirty();
      },
      renderValue: () => {
        const gib = Math.max(1, Math.round((draft.min_vram_mib ?? START_MIN_VRAM_MIB) / MIB_PER_GIB));
        return el(
          "span",
          { className: "unit-field" },
          el("input", {
            id: "def-min-vram",
            type: "number",
            min: "1",
            max: String(MAX_VRAM_GIB),
            step: "1",
            className: "input input-sm input-num",
            "aria-label": t("app.def.min_vram"),
            value: String(gib),
            onInput: (event) => {
              const val = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(val)) {
                draft.min_vram_mib = Math.max(1, val) * MIB_PER_GIB;
                markDirty();
              }
            },
          }),
          el("span", { className: "unit-suffix" }, t("app.unit.gb"))
        );
      },
    });

    const winddownControl = buildDurationControl("def-winddown", draft.winddown_grace ?? 300, true, (secs) => {
      draft.winddown_grace = secs;
      markDirty();
    });

    const pollActiveControl = buildDurationControl("def-poll-active", draft.usage_poll_active ?? 30, true, (secs) => {
      draft.usage_poll_active = secs;
      markDirty();
    });

    const pollIdleControl = buildDurationControl("def-poll-idle", draft.usage_poll_idle ?? 300, true, (secs) => {
      draft.usage_poll_idle = secs;
      markDirty();
    });

    const formTitleId = "defaults-form-heading";
    const form = el(
      "form",
      {
        className: "card",
        "aria-labelledby": formTitleId,
        onSubmit: async (event) => {
          event.preventDefault();
          if (saving || !draft) return;
          saving = true;
          saveError = null;
          saveStatus = null;
          updateDefaultsFooter();
          try {
            const updated = await patchSettings({ defaults: draft });
            draft = cloneDefaults(updated.defaults);
            dirty = false;
            saveStatus = t("web.settings.saved");
            announce(saveStatus);
            renderDefaultsSection();
          } catch (err) {
            if (err && err.status === 401) return;
            const formatted = formatApiError(err?.payload);
            saveError = formatted.message || t("app.toast.save_failed.title");
            announce(saveError, "assertive");
          } finally {
            saving = false;
            updateDefaultsFooter();
          }
        },
      },
      el(
        "div",
        { className: "card-heading" },
        el("h2", { id: formTitleId, className: "card-title" }, t("app.defaults.title")),
        el("p", { className: "card-desc" }, t("app.defaults.description"))
      ),
      el(
        "div",
        { className: "settings-list" },
        settingsRow(t("app.def.max_runtime"), t("app.def.max_runtime_hint"), maxRuntimeControl),
        settingsRow(t("app.def.max_spend"), t("app.def.max_spend_hint"), maxSpendControl),
        settingsRow(t("app.def.min_balance"), t("app.def.min_balance_hint"), minBalanceControl),
        settingsRow(t("app.def.idle"), t("app.def.idle_hint"), idleControl),
        settingsRow(t("app.def.concurrent"), t("app.def.concurrent_hint"), concurrentControl),
        settingsRow(
          t("app.def.attempts"),
          t("app.def.attempts_hint", { cap: MAX_ATTEMPTS_CAP }),
          attemptsControl
        ),
        settingsRow(t("app.def.retry_delay"), null, retryDelayControl),
        settingsRow(t("app.def.on_exhausted"), null, exhaustedSelect),
        settingsRow(t("app.def.accelerator"), null, acceleratorSelect),
        settingsRow(t("app.def.high_mem"), null, highMemControl),
        settingsRow(t("app.def.min_vram"), t("app.def.min_vram_hint"), minVramControl),
        settingsRow(t("app.def.winddown"), t("app.def.winddown_hint"), winddownControl),
        settingsRow(t("app.def.poll_active"), t("app.def.poll_hint"), pollActiveControl),
        settingsRow(t("app.def.poll_idle"), null, pollIdleControl)
      ),
      el(
        "div",
        { className: "form-footer" },
        el("div", { dataset: { defaultsStatus: "true" }, role: "status" }),
        el(
          "div",
          { className: "form-footer-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-sm btn-ghost",
              dataset: { defaultsDiscard: "true" },
              disabled: !dirty,
              onClick: () => {
                if (state.settings?.defaults) {
                  draft = cloneDefaults(state.settings.defaults);
                  dirty = false;
                  saveError = null;
                  saveStatus = null;
                  renderDefaultsSection();
                }
              },
            },
            t("web.settings.discard")
          ),
          el(
            "button",
            {
              type: "submit",
              className: "btn btn-sm btn-primary",
              dataset: { defaultsSave: "true" },
              disabled: saving,
            },
            t("app.b2.action_save")
          )
        )
      )
    );

    defaultsEl.appendChild(form);
    updateDefaultsFooter();
  }

  function renderAboutSection() {
    if (!aboutEl) return;
    clear(aboutEl);

    const updates = state.updates;
    const backendKind = state.snapshot?.backend || null;
    const isMock = backendKind === "mock";
    const configDir = state.settings?.config_dir || null;

    let updateDesc = t("app.b7.update_not_checked");
    if (state.updatesLoading) {
      updateDesc = t("app.b7.update_checking");
    } else if (state.updatesError) {
      const formatted = formatApiError(state.updatesError);
      updateDesc = t("app.b7.update_failed", { why: formatted.message });
    } else if (updates) {
      updateDesc = updates.update_available
        ? t("web.settings.update_available_generic")
        : t("app.b7.update_up_to_date");
    }

    const updateControls = [
      el(
        "button",
        {
          type: "button",
          className: "btn btn-sm",
          disabled: state.updatesLoading,
          onClick: () => {
            void loadUpdates();
          },
        },
        t(state.updatesError ? "app.b7.update_try_again" : "app.b7.update_check")
      ),
    ];
    if (updates?.releases_url) {
      updateControls.push(
        el(
          "a",
          {
            href: updates.releases_url,
            target: "_blank",
            rel: "noopener noreferrer",
            className: updates.update_available ? "btn btn-sm btn-primary" : "btn btn-sm btn-ghost",
          },
          icon("externalLink"),
          t("app.b7.update_open_page")
        )
      );
    }

    let configControl;
    if (configDir) {
      configControl = el(
        "div",
        { className: "config-path-box" },
        el("code", { className: "config-path-code", title: configDir }, configDir),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(configDir);
                copiedFeedback = true;
                announce(t("web.shell.copied"));
                renderAboutSection();
                window.setTimeout(() => {
                  copiedFeedback = false;
                  renderAboutSection();
                }, 2000);
              } catch {
                announce(t("web.shell.copy_failed"), "assertive");
              }
            },
          },
          icon(copiedFeedback ? "check" : "copy"),
          t(copiedFeedback ? "web.shell.copied" : "web.settings.copy_config_dir")
        )
      );
    } else {
      configControl = el("span", { className: "field-hint" }, t("app.settings.file.unsaved"));
    }

    aboutEl.appendChild(
      el(
        "section",
        { className: "card" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.settings.about.title")),
          el("p", { className: "card-desc" }, t("app.settings.about.description"))
        ),
        el(
          "div",
          { className: "settings-list" },
          settingsRow(
            t("app.settings.version.title"),
            null,
            el("span", { className: "mono" }, updates?.current_version || "—")
          ),
          settingsRow(
            t("app.b7.update_title"),
            updateDesc,
            el("div", { className: "card-actions" }, updateControls)
          ),
          settingsRow(
            t("app.settings.backend.title"),
            t("app.settings.backend.description"),
            backendKind
              ? badge(t(isMock ? "app.backend.mock" : "app.backend.real"), isMock ? "warning" : "info")
              : badge(t("app.summary.unknown"), "neutral")
          ),
          settingsRow(t("web.settings.config_dir"), null, configControl)
        )
      )
    );
  }

  return {
    mount(container) {
      root = container;
      clear(root);
      headerEl = el("header", { className: "page-header" });
      noticesEl = el("div", { className: "section-stack" });
      generalEl = el("div");
      defaultsEl = el("div");
      aboutEl = el("div");
      root.append(headerEl, noticesEl, generalEl, defaultsEl, aboutEl);

      renderHeader();
      renderNotices();
      renderGeneralSection();
      renderDefaultsSection();
      renderAboutSection();

      if (!state.settings && !state.settingsLoading) {
        void loadSettings({ applyPrefs: false });
      }
      if (!state.updates && !state.updatesLoading) {
        void loadUpdates();
      }
    },
    update(reason) {
      if (!root) return;
      if (reason === "locale") {
        renderHeader();
        renderNotices();
        renderGeneralSection();
        // Preserve in-progress user draft when switching UI language.
        renderDefaultsSection();
        renderAboutSection();
        return;
      }
      if (reason === "theme") {
        renderGeneralSection();
        return;
      }
      if (reason === "settings") {
        renderNotices();
        renderGeneralSection();
        renderAboutSection();
        // Never clobber an edited defaults form while the user is typing.
        if (!dirty && state.settings?.defaults) {
          draft = cloneDefaults(state.settings.defaults);
          renderDefaultsSection();
        }
        return;
      }
      if (reason === "updates" || reason === "snapshot") {
        // Deliberately touch only the About section so SSE snapshots never disturb the Defaults form.
        renderAboutSection();
      }
    },
    unmount() {
      root = null;
      headerEl = null;
      noticesEl = null;
      generalEl = null;
      defaultsEl = null;
      aboutEl = null;
      draft = null;
      dirty = false;
      saveError = null;
      saveStatus = null;
      copiedFeedback = false;
    },
  };
}
