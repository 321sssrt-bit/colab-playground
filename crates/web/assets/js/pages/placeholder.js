import { badge, clear, el } from "../components.js";
import { t } from "../i18n.js";

export function createPlaceholderPage({ titleKey, subtitleKey }) {
  let root = null;

  function render() {
    if (!root) return;
    clear(root);
    root.append(
      el(
        "header",
        { className: "page-header" },
        el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t(titleKey)),
        el("p", { className: "page-subtitle" }, t(subtitleKey))
      ),
      el(
        "section",
        { className: "card placeholder-card" },
        badge(t("web.shell.page_upcoming_title"), "info"),
        el("p", { className: "card-desc" }, t("web.shell.page_upcoming_body"))
      )
    );
  }

  return {
    mount(container) {
      root = container;
      render();
    },
    update(reason) {
      if (reason === "locale") {
        render();
      }
    },
    unmount() {
      root = null;
    },
  };
}
