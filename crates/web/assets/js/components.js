import { icon } from "./icons.js";
import { LANGUAGE_PREFS, languageLabel, t } from "./i18n.js";
import { APPEARANCE_PREFS } from "./theme.js";

export function el(tag, attrs = null, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === "className") {
        node.className = value;
      } else if (key === "dataset") {
        for (const [dk, dv] of Object.entries(value)) {
          if (dv !== undefined && dv !== null) {
            node.dataset[dk] = String(dv);
          }
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in node && (key === "checked" || key === "disabled" || key === "hidden" || key === "value" || key === "selected" || key === "required" || key === "autofocus")) {
        node[key] = value;
      } else if (value === true) {
        node.setAttribute(key, "");
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    if (typeof child === "string" || typeof child === "number") {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function announce(message, urgency = "polite") {
  const target = document.getElementById(urgency === "assertive" ? "live-assertive" : "live-polite");
  if (!target) return;
  target.textContent = "";
  window.setTimeout(() => {
    target.textContent = message;
  }, 20);
}

export function badge(text, tone = "neutral", extraClass = "") {
  const toneClass = tone && tone !== "neutral" ? `badge-${tone}` : "";
  return el("span", { className: ["badge", toneClass, extraClass].filter(Boolean).join(" ") }, text);
}

export function alertBox({ tone = "info", title = null, body = null, actions = null, live = false } = {}) {
  const iconMap = {
    warning: "alertTriangle",
    danger: "alertCircle",
    success: "checkCircle",
    info: "info",
  };
  const iconToneMap = {
    warning: "icon-warning",
    danger: "icon-danger",
    success: "icon-success",
    info: "icon-accent",
  };
  const textChildren = [];
  if (title) {
    textChildren.push(el("div", { className: "alert-title" }, title));
  }
  if (body) {
    textChildren.push(el("div", { className: "alert-body" }, body));
  }
  const attrs = {
    className: `alert alert-${tone}`,
    role: live ? (tone === "danger" ? "alert" : "status") : null,
  };
  return el(
    "div",
    attrs,
    el(
      "div",
      { className: "alert-content" },
      icon(iconMap[tone] || "info", iconToneMap[tone] || "icon-accent"),
      el("div", { className: "alert-text" }, textChildren)
    ),
    actions ? el("div", { className: "card-actions" }, actions) : null
  );
}

export function languageSelect({ id, value, onChange, ariaLabel, compact = false }) {
  const select = el(
    "select",
    {
      id,
      className: compact ? "select select-sm select-inline" : "select select-inline",
      "aria-label": ariaLabel || null,
      onChange: (event) => onChange(event.target.value),
    },
    LANGUAGE_PREFS.map((pref) =>
      el("option", { value: pref, selected: pref === value }, languageLabel(pref))
    )
  );
  select.value = value;
  return select;
}

const APPEARANCE_KEYS = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

const APPEARANCE_ICONS = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

export function appearanceSegmented({ name, value, onChange, legendText }) {
  return el(
    "fieldset",
    { className: "settings-fieldset" },
    el("legend", { className: "visually-hidden" }, legendText || t("app.settings.appearance.title")),
    el(
      "div",
      { className: "segmented" },
      APPEARANCE_PREFS.map((pref) => {
        const inputId = `${name}-${pref}`;
        return el(
          "span",
          { className: "segmented-item" },
          el("input", {
            type: "radio",
            id: inputId,
            name,
            value: pref,
            className: "segmented-input",
            checked: pref === value,
            onChange: () => onChange(pref),
          }),
          el(
            "label",
            { for: inputId, className: "segmented-label" },
            icon(APPEARANCE_ICONS[pref]),
            el("span", null, t(APPEARANCE_KEYS[pref]))
          )
        );
      })
    )
  );
}

export function openConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel = t("dialog.cancel"),
  danger = false,
}) {
  const dialog = document.getElementById("confirm-dialog");
  if (!dialog) {
    return Promise.resolve(false);
  }
  clear(dialog);
  const titleId = "confirm-dialog-title";
  dialog.setAttribute("aria-labelledby", titleId);
  dialog.append(
    el("h1", { id: titleId, className: "card-title" }, title),
    body ? el("p", { className: "card-desc" }, body) : null,
    el(
      "form",
      { method: "dialog", className: "modal-actions" },
      el(
        "button",
        {
          type: "submit",
          value: "cancel",
          className: "btn btn-ghost",
          autofocus: danger,
        },
        cancelLabel
      ),
      el(
        "button",
        {
          type: "submit",
          value: "confirm",
          className: danger ? "btn btn-danger" : "btn btn-primary",
          autofocus: !danger,
        },
        confirmLabel
      )
    )
  );

  return new Promise((resolve) => {
    const onClose = () => {
      const confirmed = dialog.returnValue === "confirm";
      dialog.returnValue = "";
      dialog.removeEventListener("close", onClose);
      resolve(confirmed);
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}
