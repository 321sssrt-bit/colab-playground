import { login } from "../api.js";
import { alertBox, announce, appearanceSegmented, clear, el, languageSelect } from "../components.js";
import { getLanguagePreference, setLanguagePreference, t } from "../i18n.js";
import { icon } from "../icons.js";
import {
  enterAuthenticatedSession,
  recordLoginAppearanceChoice,
  recordLoginLanguageChoice,
  state,
} from "../store.js";
import { getAppearancePreference, setAppearancePreference } from "../theme.js";

export function createLoginPage() {
  let root = null;
  let errorKey = null;
  let submitting = false;
  let showKey = false;
  let keyDraft = "";

  function render() {
    if (!root) return;
    clear(root);

    const activeError = errorKey || (state.sessionExpired ? "web.login.session_expired" : null);
    const keyInputId = "access-key-input";
    const hintId = "access-key-hint";

    const keyInput = el("input", {
      id: keyInputId,
      name: "access_key",
      type: showKey ? "text" : "password",
      className: "input input-lg mono",
      autocomplete: "current-password",
      autocorrect: "off",
      autocapitalize: "none",
      spellcheck: "false",
      enterkeyhint: "done",
      placeholder: t("web.login.key_placeholder"),
      "aria-describedby": hintId,
      "aria-invalid": activeError ? "true" : null,
      required: true,
      disabled: submitting,
      value: keyDraft,
      onInput: (event) => {
        keyDraft = event.target.value;
        if (errorKey) {
          errorKey = null;
          const existing = root.querySelector('[data-login-error="true"]');
          if (existing) existing.remove();
          event.target.removeAttribute("aria-invalid");
        }
      },
    });

    const toggleBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-lg btn-icon",
        "aria-pressed": String(showKey),
        "aria-label": t(showKey ? "input.hide_password" : "input.show_password"),
        disabled: submitting,
        onClick: () => {
          showKey = !showKey;
          render();
          const input = root.querySelector(`#${keyInputId}`);
          if (input) input.focus();
        },
      },
      icon(showKey ? "eyeOff" : "eye")
    );

    const submitBtn = el(
      "button",
      {
        type: "submit",
        className: "btn btn-lg btn-primary login-submit",
        disabled: submitting,
      },
      submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
      t(submitting ? "web.login.submitting" : "web.login.submit")
    );

    const form = el(
      "form",
      {
        className: "login-form",
        method: "post",
        onSubmit: async (event) => {
          event.preventDefault();
          if (submitting) return;
          const rawKey = keyInput.value.trim();
          if (!rawKey) {
            keyInput.focus();
            return;
          }
          submitting = true;
          errorKey = null;
          render();
          try {
            const res = await login(rawKey);
            if (res.ok) {
              keyDraft = "";
              showKey = false;
              submitting = false;
              await enterAuthenticatedSession();
              return;
            }
            errorKey = res.status === 503 ? "web.login.unavailable" : "web.login.invalid_key";
            announce(t(errorKey), "assertive");
          } catch {
            errorKey = "web.login.network_error";
            announce(t(errorKey), "assertive");
          } finally {
            submitting = false;
            if (!state.authenticated) {
              render();
              const input = root?.querySelector(`#${keyInputId}`);
              if (input) input.focus();
            }
          }
        },
      },
      activeError
        ? el(
            "div",
            { dataset: { loginError: "true" } },
            alertBox({
              tone: state.sessionExpired && !errorKey ? "warning" : "danger",
              body: t(activeError),
              live: true,
            })
          )
        : null,
      el(
        "div",
        { className: "field-group" },
        el("label", { for: keyInputId, className: "field-label" }, t("web.login.key_label")),
        el("p", { id: hintId, className: "field-hint" }, t("web.login.key_hint")),
        el("div", { className: "password-row" }, keyInput, toggleBtn)
      ),
      submitBtn
    );

    const prefsBar = el(
      "div",
      { className: "login-topbar" },
      languageSelect({
        id: "login-language",
        value: getLanguagePreference(),
        ariaLabel: t("app.settings.language.title"),
        compact: true,
        onChange: (next) => {
          recordLoginLanguageChoice(next);
          void setLanguagePreference(next, { persist: true });
        },
      }),
      appearanceSegmented({
        name: "login-appearance",
        value: getAppearancePreference(),
        onChange: (next) => {
          recordLoginAppearanceChoice(next);
          setAppearancePreference(next, { persist: true });
        },
      })
    );

    const card = el(
      "section",
      { className: "card login-card" },
      el(
        "div",
        { className: "brand-mark login-brand" },
        icon("zap", "icon-accent"),
        el("span", { className: "brand-name" }, t("app.name"))
      ),
      el(
        "div",
        { className: "login-header" },
        el("h1", { className: "login-title" }, t("web.login.title")),
        el("p", { className: "card-desc" }, t("web.login.subtitle"))
      ),
      form
    );

    root.appendChild(
      el("main", { className: "login-page" }, el("div", { className: "login-shell" }, prefsBar, card))
    );
  }

  return {
    mount(container) {
      root = container;
      errorKey = null;
      submitting = false;
      render();
      const input = root.querySelector("#access-key-input");
      if (input) input.focus();
    },
    update() {
      render();
    },
    unmount() {
      keyDraft = "";
      showKey = false;
      root = null;
    },
  };
}
