(() => {
  const key = "cpg_appearance";
  let pref = "system";
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "light" || stored === "dark" || stored === "system") {
      pref = stored;
    }
  } catch {
    // Storage may be blocked in restricted browser contexts.
  }
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) {
    meta.content = pref === "system" ? "light dark" : pref;
  }
  document.documentElement.dataset.theme = pref;
})();
