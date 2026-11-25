import { alertBox, announce, badge, busyLine, clear, el, emptyState, inlineMessage } from "../components.js";
import {
  acceleratorIsGpu,
  acceleratorSupportsHighMem,
  formatApiError,
  formatBytes,
  formatEmail,
  formatInt,
  formatVram,
} from "../format.js";
import { localized, t } from "../i18n.js";
import { icon } from "../icons.js";
import { openHfTokenDialog, openInstallPluginDialog, openRemovePluginDialog } from "../plugin-dialogs.js";
import {
  buildProvisionOptionRows,
  copyTextToClipboard,
  openStopRuntimeDialog,
  provisionHeadline,
  renderProvisionProgress,
  resolveForwardPolicy,
  safeHttpUrl,
} from "../session-dialogs.js";
import {
  cancelPluginRun,
  closeForward,
  consumePendingOpenPluginId,
  fetchHfGguf,
  fetchPluginTemplate,
  getAccountContext,
  getForwardForEndpoint,
  getSessionLimitReached,
  isPluginBusy,
  isPluginRunning,
  loadForwards,
  loadHfToken,
  loadOverview,
  loadPluginRuns,
  loadPlugins,
  openForward,
  searchHfModels,
  setNotice,
  setPluginEnabled,
  startPluginRun,
  state,
} from "../store.js";

const HF_FIT_DEBOUNCE_MS = 250;

function pluginDisplayName(info) {
  if (!info?.manifest) return "";
  return localized(info.manifest.name) || info.manifest.id;
}

function inputDisplayLabel(spec) {
  return localized(spec.label) || spec.id;
}

function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

function cloneAccountContext(ctx) {
  return {
    revision: Number.isFinite(ctx?.revision) ? ctx.revision : 0,
    active: ctx?.active ?? null,
  };
}

function activeManagedRuntimes() {
  const list = state.snapshot?.runtimes?.runtimes;
  if (!Array.isArray(list)) return [];
  return list.filter((rt) => rt?.on_active_account && rt?.managed && rt?.id?.name);
}

function findRunRuntime(run) {
  if (!run?.session) return null;
  const list = state.snapshot?.runtimes?.runtimes;
  if (!Array.isArray(list)) return null;
  return (
    list.find(
      (rt) =>
        rt?.id?.name === run.session &&
        (!run.account || rt?.id?.account === run.account)
    ) || null
  );
}

function isRuntimeListCompleteFor(account) {
  const view = state.snapshot?.runtimes;
  if (!view || state.snapshot?.runtimes_error) return false;
  const errors = Array.isArray(view.errors) ? view.errors : [];
  return !errors.some((failure) => !account || failure.account === account);
}

function createCopyButton({ text, ariaLabel, failKey = "web.plugins.endpoint_copy_failed", dataset = null }) {
  const iconSlot = el("span", { className: "btn-icon-slot" }, icon("copy"));
  return el(
    "button",
    {
      type: "button",
      className: "btn btn-sm btn-ghost btn-icon",
      dataset: dataset || undefined,
      "aria-label": ariaLabel || t("copy.button"),
      title: ariaLabel || t("copy.button"),
      onClick: async () => {
        const ok = await copyTextToClipboard(text);
        if (ok) {
          clear(iconSlot);
          iconSlot.appendChild(icon("check", "icon-success"));
          announce(t("web.shell.copied"));
          window.setTimeout(() => {
            if (!iconSlot.isConnected) return;
            clear(iconSlot);
            iconSlot.appendChild(icon("copy"));
          }, 2000);
        } else {
          announce(t(failKey), "assertive");
        }
      },
    },
    iconSlot
  );
}

function buildOpenAiCurl(baseUrl, modelId, hasSecretKey) {
  const safeModel = String(modelId || "MODEL").replace(/[\r\n'"]/g, "");
  const authLine = hasSecretKey ? ' \\\n  -H "Authorization: Bearer $API_KEY"' : "";
  return `curl ${baseUrl}/chat/completions \\\n  -H "Content-Type: application/json"${authLine} \\\n  -d '{"model": "${safeModel}", "messages": [{"role": "user", "content": "Hello"}]}'`;
}

export function createPluginsPage({ navigate }) {
  let root = null;
  let headerEl = null;
  let bodyEl = null;

  // Sub-view state: "list" | "form" | "run"
  let view = "list";
  let formModel = null;
  let formOpenGeneration = 0;
  let inlineInstallDraft = "";
  let hfFitDebounceTimer = null;

  // Endpoint per-id busy/bind preference map in the run view
  const endpointBusy = new Set();
  const endpointBindChoice = new Map();

  // Persistent DOM anchors inside the isolated form view so background SSE updates never clobber user typing.
  let formDom = null;
  let logBoxEl = null;

  function findPlugin(id) {
    return (state.plugins || []).find((p) => p?.manifest?.id === id) || null;
  }

  function clearHfFitDebounce() {
    if (hfFitDebounceTimer !== null) {
      window.clearTimeout(hfFitDebounceTimer);
      hfFitDebounceTimer = null;
    }
  }

  async function openRunForm(pluginId) {
    const info = findPlugin(pluginId);
    if (!info || !info.enabled) return;
    clearHfFitDebounce();
    const gen = ++formOpenGeneration;
    view = "form";
    formDom = null;
    formModel = {
      pluginId,
      loading: true,
      loadError: null,
      submitting: false,
      submitError: null,
      validationError: null,
      accountContext: cloneAccountContext(getAccountContext()),
      values: {},
      provision: null,
      sessionNameDraft: "",
      existing: null,
      existingAccount: null,
      targetLost: null,
      stopOnFailure: true,
      hfQueryDraft: "",
      hfSearchGen: 0,
      hfSearchStatus: "idle", // idle | loading | ready | error
      hfResults: [],
      hfSearchError: null,
      hfFilesGen: 0,
      hfFilesRepo: "",
      hfFilesStatus: "idle", // idle | loading | ready | error
      hfFilesData: null,
      hfFilesError: null,
      hfFilesCtx: 0,
    };
    renderAll();

    try {
      const template = await fetchPluginTemplate(pluginId);
      if (gen !== formOpenGeneration || view !== "form" || !formModel) return;
      const values = {};
      for (const spec of info.manifest.inputs || []) {
        const initial = template?.inputs?.[spec.id];
        if (spec.type === "secret") {
          // Secrets are read strictly from DOM password inputs on submit and never stored in state.
          continue;
        }
        if (spec.type === "bool") {
          values[spec.id] = Boolean(initial ?? spec.default ?? false);
        } else if (spec.type === "select") {
          values[spec.id] = String(initial ?? spec.default ?? spec.options?.[0] ?? "");
        } else if (spec.type === "number") {
          const val = initial ?? spec.default;
          values[spec.id] = val !== undefined && val !== null ? String(val) : "";
        } else {
          values[spec.id] = initial !== undefined && initial !== null ? String(initial) : "";
        }
      }
      const provision =
        template?.target?.kind === "provision"
          ? cloneSpec(template.target)
          : {
              name: `${pluginId}-run`,
              accelerator: "A100",
              high_mem: false,
              min_vram_mib: null,
              max_attempts: 3,
              retry_delay: 15,
              on_exhausted: "stop_and_fail",
              guard: {
                max_runtime: 7200,
                max_spend_cu: null,
                min_balance_cu: null,
                idle_timeout: null,
              },
            };
      formModel.loading = false;
      formModel.values = values;
      formModel.provision = provision;
      formModel.sessionNameDraft = provision.name || "";
      formModel.stopOnFailure = template?.stop_on_failure ?? true;
      formModel.accountContext = cloneAccountContext(getAccountContext());
      renderAll();
    } catch (err) {
      if (err && err.status === 401) return;
      if (gen !== formOpenGeneration || view !== "form" || !formModel) return;
      formModel.loading = false;
      formModel.loadError = err?.payload || { error: {} };
      renderAll();
    }
  }

  function showList() {
    clearHfFitDebounce();
    formOpenGeneration += 1;
    view = "list";
    formModel = null;
    formDom = null;
    renderAll();
  }

  function showRun() {
    if (!state.pluginRun || state.pluginRun.phase === "idle") return;
    clearHfFitDebounce();
    view = "run";
    formDom = null;
    logBoxEl = null;
    renderAll();
  }

  function renderRunBanner() {
    const run = state.pluginRun;
    if (!run || run.phase === "idle") return null;
    const info = findPlugin(run.plugin);
    const name = info ? pluginDisplayName(info) : run.plugin;
    let tone = "info";
    let key = "app.b2.run_banner_running";
    if (run.phase === "ready") {
      tone = "success";
      key = "app.b2.run_banner_ready";
    } else if (run.phase === "failed") {
      tone = "danger";
      key = "app.b2.run_banner_failed";
    } else if (run.phase === "cancelled") {
      tone = "info";
      key = "app.b2.run_banner_cancelled";
    }
    return el(
      "div",
      { className: "plugin-run-banner", dataset: { pluginRunBanner: run.phase } },
      el("div", { className: "plugin-run-banner-msg" }, inlineMessage({ tone, text: t(key, { name }) })),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-sm",
          dataset: { pluginRunShow: "true" },
          onClick: () => showRun(),
        },
        t("app.b2.action_show")
      )
    );
  }

  function renderPluginCard(info) {
    const id = info.manifest.id;
    const name = pluginDisplayName(info);
    const desc = localized(info.manifest.description);
    const bundled = info.source?.kind === "bundled";
    const busy = isPluginBusy(id);
    const switchId = `plugin-enabled-${id}`;

    const switchInput = el("input", {
      id: switchId,
      type: "checkbox",
      role: "switch",
      className: "switch-input",
      checked: Boolean(info.enabled),
      disabled: busy,
      dataset: { pluginToggle: id },
      onChange: async (event) => {
        const nextEnabled = event.target.checked;
        try {
          await setPluginEnabled(id, nextEnabled);
        } catch (err) {
          if (err && err.status !== 401) {
            setNotice({ tone: "danger", message: formatApiError(err?.payload).message });
          }
          renderAll();
        }
      },
    });

    const removeBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-sm btn-ghost",
        dataset: { pluginRemove: id },
        disabled: bundled || busy,
        title: bundled ? t("app.b2.plugin_built_in_remove") : null,
        onClick: () => openRemovePluginDialog(info),
      },
      t("app.b2.action_remove")
    );

    const openBtn = el(
      "button",
      {
        type: "button",
        className: "btn btn-sm btn-primary",
        dataset: { pluginOpen: id },
        disabled: !info.enabled,
        onClick: () => {
          void openRunForm(id);
        },
      },
      icon("rocket"),
      t("app.b2.plugin_open")
    );

    return el(
      "article",
      { className: "card plugin-card", dataset: { pluginCard: id } },
      el(
        "div",
        { className: "plugin-card-title-row" },
        el("h2", { className: "plugin-card-name" }, name),
        el("span", { className: "caption" }, t("app.b2.plugin_version_short", { version: info.manifest.version })),
        bundled ? badge(t("app.b2.plugin_built_in"), "info") : null,
        !info.enabled ? badge(t("app.b2.plugin_off"), "neutral") : null
      ),
      desc ? el("p", { className: "card-desc" }, desc) : null,
      el(
        "div",
        { className: "plugin-card-actions" },
        openBtn,
        el("label", { for: switchId, className: "switch-label" }, switchInput, t("app.b2.plugin_enabled")),
        removeBtn
      )
    );
  }

  function renderInstallCard() {
    const inputId = "plugin-list-source-input";
    const sourceInput = el("input", {
      id: inputId,
      type: "text",
      className: "input",
      placeholder: t("app.b2.plugin_source_placeholder"),
      value: inlineInstallDraft,
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": t("app.b2.plugin_source"),
      onInput: (event) => {
        inlineInstallDraft = event.target.value;
      },
    });

    return el(
      "section",
      { className: "card card-compact", dataset: { pluginInstallCard: "true" } },
      el(
        "div",
        { className: "card-header" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.b2.plugin_install_title")),
          el("p", { className: "card-desc" }, t("app.b2.plugin_install_hint"))
        )
      ),
      el(
        "form",
        {
          className: "plugin-inline-row",
          onSubmit: (event) => {
            event.preventDefault();
            const text = inlineInstallDraft.trim();
            openInstallPluginDialog({
              initialSource: text,
              inspectImmediately: Boolean(text),
              onInstalled: () => {
                inlineInstallDraft = "";
                if (view === "list") {
                  renderBody();
                }
              },
            });
          },
        },
        sourceInput,
        el(
          "button",
          {
            type: "submit",
            className: "btn",
            dataset: { pluginInlineCheck: "true" },
          },
          t("app.b2.plugin_check")
        )
      )
    );
  }

  function renderHfTokenCard() {
    let statusBadge;
    if (state.hfToken.status === "ready") {
      statusBadge = state.hfToken.saved
        ? badge(t("app.b2.hf_token_stored"), "success")
        : badge(t("app.b2.hf_token_none"), "neutral");
    } else if (state.hfToken.status === "error") {
      statusBadge = badge(t("app.b2.hf_token_unknown"), "warning");
    } else {
      statusBadge = badge(t("app.summary.unknown"), "neutral");
    }

    return el(
      "section",
      { className: "card card-compact", dataset: { hfTokenCard: "true" } },
      el(
        "div",
        { className: "card-header" },
        el(
          "div",
          { className: "card-heading" },
          el("h2", { className: "card-title" }, t("app.b2.hf_token_title")),
          el("p", { className: "card-desc" }, t("app.b2.hf_token_hint"))
        ),
        statusBadge
      ),
      el(
        "div",
        { className: "card-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn",
            dataset: { hfTokenManage: "true" },
            onClick: () => openHfTokenDialog(),
          },
          icon("key"),
          t("web.plugins.manage_token")
        )
      )
    );
  }

  // ---- Dynamic Plugin Form (SSE-isolated) ----

  function currentQuantForPreview(info) {
    if (!formModel || !info?.manifest?.inputs?.some((i) => i.id === "quant")) {
      return null;
    }
    const val = formModel.values.quant;
    return typeof val === "string" && val && val !== "auto" ? val : "auto";
  }

  function currentCtxForPreview() {
    if (!formModel) return 0;
    const raw = formModel.values.ctx;
    const parsed = Number.parseFloat(String(raw ?? ""));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
  }

  async function runHfSearch(query) {
    if (!formModel) return;
    const gen = ++formModel.hfSearchGen;
    formModel.hfSearchStatus = "loading";
    formModel.hfSearchError = null;
    renderHfResultsSlot();

    try {
      const models = await searchHfModels(query);
      if (!formModel || gen !== formModel.hfSearchGen) return;
      formModel.hfResults = Array.isArray(models) ? models : [];
      formModel.hfSearchStatus = "ready";
      formModel.hfSearchError = null;
      renderHfResultsSlot();
    } catch (err) {
      if (err && err.status === 401) return;
      if (!formModel || gen !== formModel.hfSearchGen) return;
      formModel.hfSearchStatus = "error";
      formModel.hfSearchError = err?.payload || { error: {} };
      renderHfResultsSlot();
    }
  }

  async function runHfFiles(repo, { force = false } = {}) {
    if (!formModel) return;
    const trimmed = String(repo || "").trim();
    if (!trimmed) {
      formModel.hfFilesStatus = "error";
      formModel.hfFilesError = { error: { message_key: "web.plugins.hf_repo_required" } };
      renderHfFilesSlot();
      return;
    }
    const info = findPlugin(formModel.pluginId);
    const ctx = currentCtxForPreview();
    const quant = currentQuantForPreview(info);
    const accelerator = formModel.provision?.accelerator || "A100";
    const vramMib = formModel.provision?.min_vram_mib ?? null;

    if (
      !force &&
      formModel.hfFilesRepo === trimmed &&
      formModel.hfFilesStatus === "ready" &&
      formModel.hfFilesCtx === ctx
    ) {
      return;
    }

    const gen = ++formModel.hfFilesGen;
    formModel.hfFilesRepo = trimmed;
    formModel.hfFilesCtx = ctx;
    formModel.hfFilesStatus = "loading";
    formModel.hfFilesError = null;
    renderHfFilesSlot();

    try {
      const data = await fetchHfGguf({
        repo: trimmed,
        accelerator,
        fit: {
          vram_mib: vramMib,
          ctx,
        },
        quant,
      });
      if (!formModel || gen !== formModel.hfFilesGen) return;
      formModel.hfFilesData = data;
      formModel.hfFilesStatus = "ready";
      formModel.hfFilesError = null;
      renderHfFilesSlot();
    } catch (err) {
      if (err && err.status === 401) return;
      if (!formModel || gen !== formModel.hfFilesGen) return;
      formModel.hfFilesStatus = "error";
      formModel.hfFilesError = err?.payload || { error: {} };
      renderHfFilesSlot();
    }
  }

  function scheduleHfFilesRefresh() {
    if (!formModel || !formModel.hfFilesRepo) return;
    clearHfFitDebounce();
    hfFitDebounceTimer = window.setTimeout(() => {
      hfFitDebounceTimer = null;
      if (formModel && formModel.hfFilesRepo && view === "form") {
        void runHfFiles(formModel.hfFilesRepo, { force: true });
      }
    }, HF_FIT_DEBOUNCE_MS);
  }

  function renderHfResultsSlot() {
    const host = formDom?.hfResultsHost;
    if (!host || !host.isConnected || !formModel) return;
    clear(host);
    if (formModel.hfSearchStatus === "loading") {
      host.appendChild(el("span", { className: "caption" }, t("app.b2.hf_searching")));
      return;
    }
    if (formModel.hfSearchStatus === "error") {
      host.appendChild(
        inlineMessage({ tone: "warning", text: formatApiError(formModel.hfSearchError).message })
      );
      return;
    }
    if (formModel.hfSearchStatus === "ready") {
      if (formModel.hfResults.length === 0) {
        host.appendChild(el("span", { className: "caption" }, t("app.b2.hf_no_results")));
        return;
      }
      const hfInputId = formDom.hfInputId;
      host.appendChild(
        el(
          "div",
          { className: "hf-results-list", dataset: { hfResults: "true" } },
          formModel.hfResults.map((model) =>
            el(
              "button",
              {
                type: "button",
                className: "hf-result-item",
                dataset: { hfResult: model.id },
                onClick: () => {
                  if (!formModel || !hfInputId) return;
                  formModel.values[hfInputId] = model.id;
                  const inputEl = formDom?.fieldInputs?.get(hfInputId);
                  if (inputEl) {
                    inputEl.value = model.id;
                  }
                  void runHfFiles(model.id, { force: true });
                },
              },
              el("span", { className: "hf-result-id" }, model.id),
              el(
                "span",
                { className: "hf-result-meta" },
                t(model.gated ? "app.b2.hf_result_gated" : "app.b2.hf_result", {
                  downloads: formatInt(model.downloads),
                })
              )
            )
          )
        )
      );
    }
  }

  function renderHfFilesSlot() {
    const host = formDom?.hfFilesHost;
    if (!host || !host.isConnected || !formModel) return;
    clear(host);
    if (formModel.hfFilesStatus === "loading") {
      host.appendChild(el("span", { className: "caption" }, t("app.b2.hf_listing")));
      return;
    }
    if (formModel.hfFilesStatus === "error") {
      host.appendChild(
        inlineMessage({ tone: "warning", text: formatApiError(formModel.hfFilesError).message })
      );
      return;
    }
    if (formModel.hfFilesStatus !== "ready" || !formModel.hfFilesData) {
      return;
    }

    const listing = formModel.hfFilesData.listing;
    const fits = Array.isArray(formModel.hfFilesData.fits) ? formModel.hfFilesData.fits : [];
    const variants = Array.isArray(listing?.variants) ? listing.variants : [];
    const sep = t("app.fmt.list_separator");
    const variantLabels = variants.map((v) => `${v.quant} (${formatBytes(v.size)})`);

    const nodes = [
      el(
        "p",
        { className: "caption" },
        t("app.b2.quant_files", { list: variantLabels.join(sep) })
      ),
    ];

    if (fits.length === 0) {
      nodes.push(el("p", { className: "caption" }, t("app.b2.quant_no_gpu")));
    } else {
      const ctxAssumed = formModel.hfFilesCtx === 0;
      for (const item of fits) {
        const gpu = formatVram(item.vram_mib);
        let lineText;
        if (item.fit) {
          lineText = t(ctxAssumed ? "app.b3.quant_fits_assumed" : "app.b2.quant_fits", {
            gpu,
            quant: item.fit.quant,
            ctx: formatInt(item.fit.ctx),
            estimate: formatVram(item.fit.estimate_mib),
          });
        } else {
          lineText = t("app.b2.quant_nothing_fits", { gpu });
        }
        nodes.push(
          el("div", { className: "quant-fit-line", dataset: { quantFit: String(item.vram_mib) } }, lineText)
        );
      }
    }

    nodes.push(el("p", { className: "caption" }, t("app.b2.quant_estimate_note")));
    host.appendChild(el("div", { className: "quant-preview", dataset: { quantPreview: "true" } }, nodes));
  }

  function syncFormLiveSlots() {
    if (view !== "form" || !formModel || !formDom) return;
    const info = findPlugin(formModel.pluginId);
    if (!info) return;

    // 1. Update HF token notice banner
    if (formDom.hfTokenBannerHost?.isConnected) {
      clear(formDom.hfTokenBannerHost);
      if (Array.isArray(info.manifest.needs) && info.manifest.needs.includes("hf_token")) {
        const hasToken = state.hfToken.status === "ready" && state.hfToken.saved;
        formDom.hfTokenBannerHost.appendChild(
          inlineMessage({
            tone: "info",
            text: t(hasToken ? "app.b2.run_hf_token_sent" : "app.b2.run_hf_token_none"),
          })
        );
      }
    }

    // 2. Drop gone run target if session ended or active account changed (1:1 runs.rs::drop_gone_run_target)
    const managed = activeManagedRuntimes();
    const activeAccount = state.snapshot?.account?.active ?? null;
    if (formModel.existing) {
      const switched =
        formModel.existingAccount && activeAccount && formModel.existingAccount !== activeAccount;
      const stillPresent =
        !switched && managed.some((rt) => rt.id.name === formModel.existing);
      if (!stillPresent && state.snapshot?.runtimes && isRuntimeListCompleteFor(activeAccount)) {
        const lostName = formModel.existing;
        const allRuntimes = state.snapshot.runtimes.runtimes || [];
        const elsewhere = switched || allRuntimes.some((rt) => rt?.id?.name === lostName);
        formModel.existing = null;
        formModel.existingAccount = null;
        formModel.targetLost = { kind: elsewhere ? "other_account" : "ended", name: lostName };
        if (formDom.targetSelect) {
          formDom.targetSelect.value = "";
        }
        renderTargetOptionsSlot();
        renderTargetDetailsSlot();
      }
    } else {
      renderTargetOptionsSlot();
    }

    // 3. Target-lost notice
    if (formDom.targetLostHost?.isConnected) {
      clear(formDom.targetLostHost);
      if (formModel.targetLost) {
        const key =
          formModel.targetLost.kind === "other_account"
            ? "app.b2.run_target_other_account"
            : "app.b2.run_target_ended";
        formDom.targetLostHost.appendChild(
          inlineMessage({ tone: "warning", text: t(key, { name: formModel.targetLost.name }) })
        );
      }
    }

    // 4. Session limit notice
    const limit = !formModel.existing ? getSessionLimitReached() : null;
    if (formDom.limitHost?.isConnected) {
      clear(formDom.limitHost);
      if (limit) {
        formDom.limitHost.appendChild(
          el(
            "div",
            { className: "session-guard-warning", dataset: { runLimit: "true" } },
            inlineMessage({
              tone: "warning",
              text: t("app.b3.new_limit_body", {
                limit: limit.limit,
                email: formatEmail(limit.email),
              }),
            }),
            el("p", { className: "caption" }, t("app.b3.run_limit_hint")),
            el(
              "div",
              null,
              el(
                "button",
                {
                  type: "button",
                  className: "btn btn-sm",
                  onClick: () => navigate("settings"),
                },
                t("app.b3.new_open_settings")
              )
            )
          )
        );
      }
    }

    // 5. Submit button availability
    if (formDom.submitBtn?.isConnected) {
      formDom.submitBtn.disabled = Boolean(formModel.submitting || isPluginRunning() || limit);
    }

    // 6. Account context changed notice
    if (formDom.accountWarningHost?.isConnected) {
      clear(formDom.accountWarningHost);
      const current = state.snapshot?.account;
      const captured = formModel.accountContext;
      if (
        current &&
        captured &&
        (current.revision !== captured.revision || (current.active ?? null) !== (captured.active ?? null))
      ) {
        formDom.accountWarningHost.appendChild(
          alertBox({
            tone: "warning",
            body: t("web.sessions.account_changed"),
            live: true,
          })
        );
      }
    }
  }

  function renderTargetOptionsSlot() {
    const selectEl = formDom?.targetSelect;
    if (!selectEl || !selectEl.isConnected || !formModel) return;
    const managed = activeManagedRuntimes();
    const desired = formModel.existing || "";
    clear(selectEl);
    selectEl.appendChild(
      el("option", { value: "", selected: desired === "" }, t("app.b2.run_target_new"))
    );
    for (const rt of managed) {
      selectEl.appendChild(
        el("option", { value: rt.id.name, selected: desired === rt.id.name }, rt.id.name)
      );
    }
    selectEl.value = desired;
  }

  function renderTargetDetailsSlot() {
    const host = formDom?.targetDetailsHost;
    if (!host || !host.isConnected || !formModel || !formModel.provision) return;
    clear(host);
    if (formModel.existing) {
      host.appendChild(el("p", { className: "caption" }, t("app.b2.run_existing_note")));
      return;
    }

    const spec = formModel.provision;
    const nameInputId = "plugin-run-session-name";
    const nameInput = el("input", {
      id: nameInputId,
      type: "text",
      className: "input",
      placeholder: t("app.b2.new_name_placeholder"),
      value: formModel.sessionNameDraft,
      disabled: formModel.submitting,
      onInput: (event) => {
        formModel.sessionNameDraft = event.target.value;
      },
    });

    const provRowsHost = el("div", { className: "prov-list" });
    const renderProvRows = () => {
      clear(provRowsHost);
      const rows = buildProvisionOptionRows({
        idPrefix: "plugin-prov",
        spec,
        disabled: formModel.submitting,
        onAcceleratorChange: () => {
          renderProvRows();
          scheduleHfFilesRefresh();
        },
        onHardwareFitChange: () => {
          scheduleHfFilesRefresh();
        },
      });
      provRowsHost.append(...rows);
    };
    renderProvRows();

    const stopOnFailureId = "plugin-run-stop-on-failure";
    const stopNoteEl = el(
      "p",
      { className: "caption" },
      t(formModel.stopOnFailure ? "app.b2.run_stop_on_failure_on" : "app.b2.run_stop_on_failure_off")
    );
    const stopSwitch = el("input", {
      id: stopOnFailureId,
      type: "checkbox",
      role: "switch",
      className: "switch-input",
      checked: Boolean(formModel.stopOnFailure),
      disabled: formModel.submitting,
      onChange: (event) => {
        formModel.stopOnFailure = event.target.checked;
        stopNoteEl.textContent = t(
          formModel.stopOnFailure ? "app.b2.run_stop_on_failure_on" : "app.b2.run_stop_on_failure_off"
        );
      },
    });

    host.append(
      el(
        "div",
        { className: "field-group" },
        el("label", { for: nameInputId, className: "field-label" }, t("app.b2.new_name")),
        nameInput
      ),
      provRowsHost,
      el(
        "div",
        { className: "field-group" },
        el(
          "label",
          { for: stopOnFailureId, className: "switch-label" },
          stopSwitch,
          t("app.b2.run_stop_on_failure")
        ),
        stopNoteEl
      )
    );
  }

  function renderFormErrorSlot() {
    const host = formDom?.errorHost;
    if (!host || !host.isConnected || !formModel) return;
    clear(host);
    if (formModel.validationError) {
      host.appendChild(alertBox({ tone: "danger", body: formModel.validationError, live: true }));
      return;
    }
    if (formModel.submitError) {
      const formatted = formatApiError(formModel.submitError);
      host.appendChild(
        alertBox({
          tone: "danger",
          title: formatted.message,
          body: formatted.hint,
          live: true,
        })
      );
    }
  }

  async function handleFormSubmit() {
    if (!formModel || formModel.submitting || isPluginRunning()) return;
    const info = findPlugin(formModel.pluginId);
    if (!info) return;

    const inputsPayload = {};
    const secretElements = [];
    for (const spec of info.manifest.inputs || []) {
      const label = inputDisplayLabel(spec);
      if (spec.type === "bool") {
        inputsPayload[spec.id] = Boolean(formModel.values[spec.id]);
        continue;
      }
      if (spec.type === "select") {
        const val = String(formModel.values[spec.id] ?? spec.options?.[0] ?? "");
        if (!val && spec.required) {
          formModel.validationError = t("web.plugins.field_required", { field: label });
          formModel.submitError = null;
          renderFormErrorSlot();
          return;
        }
        if (val) inputsPayload[spec.id] = val;
        continue;
      }
      if (spec.type === "secret") {
        const domInput = formDom?.secretInputs?.get(spec.id) || null;
        const secretVal = domInput ? domInput.value.trim() : "";
        if (!secretVal) {
          if (spec.required) {
            formModel.validationError = t("web.plugins.field_required", { field: label });
            formModel.submitError = null;
            renderFormErrorSlot();
            return;
          }
          continue;
        }
        inputsPayload[spec.id] = secretVal;
        if (domInput) secretElements.push(domInput);
        continue;
      }

      const rawText = String(formModel.values[spec.id] ?? "").trim();
      if (!rawText) {
        if (spec.required) {
          formModel.validationError = t("web.plugins.field_required", { field: label });
          formModel.submitError = null;
          renderFormErrorSlot();
          return;
        }
        continue;
      }
      if (spec.type === "number") {
        const num = Number(rawText);
        if (!Number.isFinite(num)) {
          formModel.validationError = t("web.plugins.number_invalid", { field: label });
          formModel.submitError = null;
          renderFormErrorSlot();
          return;
        }
        if (spec.min !== null && spec.min !== undefined && spec.max !== null && spec.max !== undefined) {
          if (num < spec.min || num > spec.max) {
            formModel.validationError = t("web.plugins.number_range", {
              field: label,
              min: spec.min,
              max: spec.max,
            });
            formModel.submitError = null;
            renderFormErrorSlot();
            return;
          }
        } else if (spec.min !== null && spec.min !== undefined && num < spec.min) {
          formModel.validationError = t("web.plugins.number_min", { field: label, min: spec.min });
          formModel.submitError = null;
          renderFormErrorSlot();
          return;
        } else if (spec.max !== null && spec.max !== undefined && num > spec.max) {
          formModel.validationError = t("web.plugins.number_max", { field: label, max: spec.max });
          formModel.submitError = null;
          renderFormErrorSlot();
          return;
        }
        inputsPayload[spec.id] = num;
      } else {
        inputsPayload[spec.id] = rawText;
      }
    }

    let target;
    let existingRef = null;
    if (formModel.existing) {
      const matched = activeManagedRuntimes().find((rt) => rt.id.name === formModel.existing);
      if (!matched) {
        formModel.validationError = t("app.b2.run_target_ended", { name: formModel.existing });
        formModel.submitError = null;
        renderFormErrorSlot();
        return;
      }
      target = { kind: "existing", name: formModel.existing };
      existingRef = matched.id;
    } else {
      const prov = cloneSpec(formModel.provision);
      const typedName = (formModel.sessionNameDraft || "").trim();
      if (typedName) {
        prov.name = typedName;
      }
      prov.high_mem = Boolean(prov.high_mem) && acceleratorSupportsHighMem(prov.accelerator);
      if (!acceleratorIsGpu(prov.accelerator)) {
        prov.min_vram_mib = null;
      }
      if (prov.guard?.max_runtime !== null && prov.guard?.max_runtime !== undefined && prov.guard.max_runtime <= 0) {
        formModel.validationError = t("web.sessions.auto_stop_duration_required");
        formModel.submitError = null;
        renderFormErrorSlot();
        return;
      }
      if (prov.guard?.idle_timeout !== null && prov.guard?.idle_timeout !== undefined && prov.guard.idle_timeout <= 0) {
        formModel.validationError = t("web.sessions.auto_stop_duration_required");
        formModel.submitError = null;
        renderFormErrorSlot();
        return;
      }
      target = { kind: "provision", ...prov };
    }

    formModel.submitting = true;
    formModel.validationError = null;
    formModel.submitError = null;
    renderFormErrorSlot();
    syncFormLiveSlots();

    try {
      const runId = await startPluginRun({
        spec: {
          plugin: info.manifest.id,
          inputs: inputsPayload,
          target,
          stop_on_failure: Boolean(formModel.stopOnFailure),
        },
        existing: existingRef,
        accountContext: formModel.accountContext,
      });
      // Clear secret inputs immediately once the run starts (never retained in DOM or memory).
      for (const secretEl of secretElements) {
        secretEl.value = "";
      }
      if (runId !== null && runId !== undefined) {
        showRun();
      } else {
        formModel.submitting = false;
        syncFormLiveSlots();
      }
    } catch (err) {
      if (err && err.status === 401) return;
      if (!formModel) return;
      formModel.submitting = false;
      formModel.submitError = err?.payload || { error: {} };
      renderFormErrorSlot();
      syncFormLiveSlots();
    }
  }

  function renderFormView() {
    if (!bodyEl || !formModel) return;
    const info = findPlugin(formModel.pluginId);
    if (!info) {
      showList();
      return;
    }

    clear(bodyEl);
    if (formModel.loading) {
      bodyEl.appendChild(busyLine(t("web.plugins.run_loading")));
      return;
    }
    if (formModel.loadError) {
      const formatted = formatApiError(formModel.loadError);
      bodyEl.appendChild(
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
                void openRunForm(info.manifest.id);
              },
            },
            t("app.action.retry")
          ),
        })
      );
      return;
    }

    const desc = localized(info.manifest.description);
    const fieldInputs = new Map();
    const secretInputs = new Map();
    let hfInputId = null;
    let hfResultsHost = null;
    let hfFilesHost = null;

    const fieldNodes = (info.manifest.inputs || []).map((spec) => {
      const inputDomId = `plugin-input-${spec.id}`;
      const labelText = spec.required ? `${inputDisplayLabel(spec)} *` : inputDisplayLabel(spec);
      const helpText = localized(spec.help);
      let controlNode;

      if (spec.type === "bool") {
        const sw = el("input", {
          id: inputDomId,
          type: "checkbox",
          role: "switch",
          className: "switch-input",
          checked: Boolean(formModel.values[spec.id]),
          dataset: { pluginField: spec.id, pluginFieldType: "bool" },
          onChange: (event) => {
            formModel.values[spec.id] = event.target.checked;
          },
        });
        controlNode = el("label", { for: inputDomId, className: "switch-label" }, sw, inputDisplayLabel(spec));
      } else if (spec.type === "select") {
        const selected = String(formModel.values[spec.id] ?? spec.options?.[0] ?? "");
        const selectEl = el(
          "select",
          {
            id: inputDomId,
            className: "select select-inline",
            dataset: { pluginField: spec.id, pluginFieldType: "select" },
            onChange: (event) => {
              formModel.values[spec.id] = event.target.value;
              if (spec.id === "quant") {
                scheduleHfFilesRefresh();
              }
            },
          },
          (spec.options || []).map((opt) =>
            el("option", { value: opt, selected: opt === selected }, opt)
          )
        );
        selectEl.value = selected;
        controlNode = selectEl;
      } else if (spec.type === "secret") {
        const inputEl = el("input", {
          id: inputDomId,
          type: "password",
          className: "input",
          autocomplete: "new-password",
          autocorrect: "off",
          autocapitalize: "none",
          spellcheck: "false",
          dataset: { pluginField: spec.id, pluginFieldType: "secret" },
        });
        secretInputs.set(spec.id, inputEl);
        controlNode = inputEl;
      } else if (spec.type === "number") {
        const inputEl = el("input", {
          id: inputDomId,
          type: "number",
          className: "input",
          min: spec.min !== null && spec.min !== undefined ? String(spec.min) : null,
          max: spec.max !== null && spec.max !== undefined ? String(spec.max) : null,
          step: "any",
          value: String(formModel.values[spec.id] ?? ""),
          dataset: { pluginField: spec.id, pluginFieldType: "number" },
          onInput: (event) => {
            formModel.values[spec.id] = event.target.value;
            if (spec.id === "ctx") {
              scheduleHfFilesRefresh();
            }
          },
        });
        fieldInputs.set(spec.id, inputEl);
        controlNode = inputEl;
      } else {
        // text or hf-model
        const inputEl = el("input", {
          id: inputDomId,
          type: "text",
          className: "input",
          value: String(formModel.values[spec.id] ?? ""),
          autocomplete: "off",
          spellcheck: "false",
          dataset: { pluginField: spec.id, pluginFieldType: spec.type },
          onInput: (event) => {
            formModel.values[spec.id] = event.target.value;
          },
        });
        fieldInputs.set(spec.id, inputEl);
        controlNode = inputEl;
      }

      const rowChildren = [
        spec.type === "bool"
          ? el("span", { className: "field-label" }, labelText)
          : el("label", { for: inputDomId, className: "field-label" }, labelText),
        controlNode,
        helpText ? el("span", { className: "field-hint" }, helpText) : null,
      ];

      if (spec.type === "secret") {
        rowChildren.push(el("span", { className: "field-hint" }, t("app.b2.run_secret_note")));
      }

      if (spec.type === "hf-model") {
        hfInputId = spec.id;
        hfResultsHost = el("div", { className: "hf-results-slot" });
        hfFilesHost = el("div", { className: "hf-files-slot" });
        const searchInput = el("input", {
          id: `hf-search-input-${spec.id}`,
          type: "search",
          className: "input",
          placeholder: t("app.b2.hf_search_placeholder"),
          "aria-label": t("app.b2.hf_search"),
          value: formModel.hfQueryDraft,
          autocomplete: "off",
          spellcheck: "false",
          dataset: { hfSearchInput: "true" },
          onInput: (event) => {
            formModel.hfQueryDraft = event.target.value;
          },
          onKeydown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void runHfSearch(formModel.hfQueryDraft);
            }
          },
        });

        rowChildren.push(
          el(
            "div",
            { className: "well", dataset: { hfLookup: spec.id } },
            el(
              "div",
              { className: "hf-search-bar" },
              searchInput,
              el(
                "button",
                {
                  type: "button",
                  className: "btn",
                  dataset: { hfSearchButton: "true" },
                  onClick: () => {
                    void runHfSearch(formModel.hfQueryDraft);
                  },
                },
                icon("search"),
                t("app.b2.hf_search_action")
              ),
              el(
                "button",
                {
                  type: "button",
                  className: "btn btn-ghost",
                  dataset: { hfListFiles: "true" },
                  onClick: () => {
                    void runHfFiles(formModel.values[spec.id], { force: true });
                  },
                },
                t("app.b2.hf_list_files")
              )
            ),
            hfResultsHost,
            hfFilesHost
          )
        );
      }

      return el("div", { className: "field-group", dataset: { inputRow: spec.id } }, rowChildren);
    });

    const hfTokenBannerHost = el("div", { className: "dialog-account-warning" });
    const targetSelect = el("select", {
      id: "plugin-run-target",
      className: "select select-inline",
      dataset: { pluginTargetSelect: "true" },
      onChange: (event) => {
        const val = event.target.value;
        if (!val) {
          formModel.existing = null;
          formModel.existingAccount = null;
        } else {
          const matched = activeManagedRuntimes().find((rt) => rt.id.name === val);
          formModel.existing = val;
          formModel.existingAccount = matched?.id?.account ?? null;
        }
        formModel.targetLost = null;
        renderTargetDetailsSlot();
        syncFormLiveSlots();
      },
    });
    const targetLostHost = el("div", { className: "dialog-account-warning" });
    const limitHost = el("div", { className: "dialog-account-warning" });
    const targetDetailsHost = el("div", { className: "plugin-fields" });
    const accountWarningHost = el("div", { className: "dialog-account-warning" });
    const errorHost = el("div", { className: "dialog-account-warning" });

    const submitBtn = el(
      "button",
      {
        type: "submit",
        className: "btn btn-primary",
        dataset: { pluginRunStart: "true" },
      },
      icon("rocket"),
      t("app.b2.run_start")
    );

    formDom = {
      fieldInputs,
      secretInputs,
      hfInputId,
      hfResultsHost,
      hfFilesHost,
      hfTokenBannerHost,
      targetSelect,
      targetLostHost,
      limitHost,
      targetDetailsHost,
      accountWarningHost,
      errorHost,
      submitBtn,
    };

    const formEl = el(
      "form",
      {
        className: "page-sections",
        dataset: { pluginRunForm: info.manifest.id },
        onSubmit: (event) => {
          event.preventDefault();
          void handleFormSubmit();
        },
      },
      desc ? el("p", { className: "plugin-form-intro" }, desc) : null,
      el(
        "section",
        { className: "card" },
        el(
          "div",
          { className: "card-header" },
          el("h2", { className: "card-title" }, t("app.b2.run_inputs"))
        ),
        el("div", { className: "plugin-fields" }, fieldNodes)
      ),
      hfTokenBannerHost,
      el(
        "section",
        { className: "card" },
        el(
          "div",
          { className: "card-header" },
          el(
            "div",
            { className: "card-heading" },
            el("h2", { className: "card-title" }, t("app.b2.run_target")),
            el("p", { className: "card-desc" }, t("app.b2.run_target_hint"))
          )
        ),
        el(
          "div",
          { className: "field-group" },
          el("label", { for: "plugin-run-target", className: "field-label" }, t("app.b2.run_target")),
          targetSelect
        ),
        targetLostHost,
        limitHost,
        targetDetailsHost
      ),
      accountWarningHost,
      errorHost,
      el(
        "div",
        { className: "plugin-submit-row" },
        submitBtn,
        el("span", { className: "caption" }, t("app.b2.run_start_note"))
      )
    );

    bodyEl.appendChild(formEl);
    renderTargetOptionsSlot();
    renderTargetDetailsSlot();
    renderHfResultsSlot();
    renderHfFilesSlot();
    renderFormErrorSlot();
    syncFormLiveSlots();
  }

  // ---- Plugin Run Progress & Ready Endpoint Cards View ----

  function renderStagesCard(run, info) {
    const manifestStages = Array.isArray(info?.manifest?.stages) ? info.manifest.stages : [];
    if (manifestStages.length === 0) return null;

    const currentId = run.status?.stage || null;
    const currentIndex = currentId
      ? manifestStages.findIndex((stage) => stage.id === currentId)
      : -1;
    const isReady = run.phase === "ready";
    const isFailed =
      run.phase === "failed" ||
      run.phase === "cancelled" ||
      run.status?.state === "failed";

    const rows = manifestStages.map((stage, index) => {
      const label = localized(stage.label) || stage.id;
      const isCurrent = index === currentIndex;
      const done = isReady || (currentIndex >= 0 && index < currentIndex);
      let marker;
      if (done) {
        marker = icon("checkCircle", "icon-success");
      } else if (isCurrent && isFailed) {
        marker = icon("circleX", "icon-danger");
      } else if (isCurrent) {
        marker = el("span", { className: "spinner", "aria-hidden": "true" });
      } else {
        marker = icon("circle", "icon-subtle");
      }

      const detailNodes = [];
      if (isCurrent && !done) {
        if (typeof run.status?.progress === "number" && Number.isFinite(run.status.progress)) {
          const clamped = Math.max(0, Math.min(1, run.status.progress));
          detailNodes.push(
            el("progress", {
              className: "stage-progress",
              max: "1",
              value: String(clamped),
              "aria-label": label,
            })
          );
        }
        if (run.status?.message) {
          detailNodes.push(el("span", { className: "caption" }, String(run.status.message)));
        }
      }

      return el(
        "div",
        { className: "stage-row", dataset: { stage: stage.id } },
        el(
          "div",
          { className: "stage-row-main" },
          marker,
          el("span", { className: isCurrent ? "stage-row-label-active" : null }, label)
        ),
        detailNodes.length > 0 ? el("div", { className: "stage-row-detail" }, detailNodes) : null
      );
    });

    return el(
      "section",
      { className: "card card-compact", dataset: { runStages: "true" } },
      el("div", { className: "card-header" }, el("h2", { className: "card-title" }, t("app.b2.run_stages"))),
      el("div", { className: "stage-list" }, rows)
    );
  }

  function renderBillingAfterEnd(run) {
    if (!run.session) {
      return el("p", { className: "caption", dataset: { runCleanup: "no-session" } }, t("app.b2.run_no_session"));
    }
    const targetRuntime = findRunRuntime(run);
    if (targetRuntime) {
      return el(
        "div",
        { className: "run-outcome-section", dataset: { runCleanup: "still-billing" } },
        inlineMessage({ tone: "warning", text: t("app.b2.run_session_billing") }),
        el(
          "div",
          null,
          el(
            "button",
            {
              type: "button",
              className: "btn btn-danger",
              dataset: { runStopRuntime: "true" },
              onClick: () => openStopRuntimeDialog(targetRuntime),
            },
            icon("square"),
            t("app.b2.stop_action")
          )
        )
      );
    }
    if (state.sessionsLoading || state.sessionsRefreshing) {
      return el("p", { className: "caption", dataset: { runCleanup: "checking" } }, t("app.b2.run_checking"));
    }
    if (isRuntimeListCompleteFor(run.account)) {
      return el(
        "div",
        { dataset: { runCleanup: "stopped" } },
        inlineMessage({ tone: "info", text: t("app.b2.run_session_stopped") })
      );
    }
    return el(
      "div",
      { dataset: { runCleanup: "unknown" } },
      inlineMessage({ tone: "warning", text: t("app.b2.run_session_unknown") })
    );
  }

  function renderOutcomeSection(run) {
    const nodes = [];
    if (run.phase === "running") {
      const cancelling = Boolean(run.cancelling);
      nodes.push(
        el(
          "div",
          { className: "plugin-submit-row" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-danger",
              dataset: { pluginRunCancel: "true" },
              disabled: cancelling,
              onClick: () => {
                void cancelPluginRun();
              },
            },
            cancelling ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
            t(cancelling ? "app.b2.new_cancelling" : "app.action.cancel")
          ),
          el(
            "span",
            { className: "caption" },
            t(run.provisions ? "app.b2.run_cancel_note_new" : "app.b2.run_cancel_note_existing")
          )
        )
      );
    } else if (run.phase === "ready") {
      nodes.push(inlineMessage({ tone: "success", text: t("app.b2.run_ready") }));
    } else if (run.phase === "failed") {
      const formatted = formatApiError(run.error);
      nodes.push(
        alertBox({
          tone: "danger",
          title: t("app.b2.run_failed"),
          body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
          live: true,
        }),
        renderBillingAfterEnd(run)
      );
    } else if (run.phase === "cancelled") {
      nodes.push(
        inlineMessage({ tone: "info", text: t("app.b2.run_cancelled") }),
        renderBillingAfterEnd(run)
      );
    }

    if (run.phase !== "running") {
      nodes.push(
        el(
          "div",
          null,
          el(
            "button",
            {
              type: "button",
              className: "btn",
              dataset: { pluginRunAgain: "true" },
              onClick: () => {
                void openRunForm(run.plugin);
              },
            },
            icon("rotateCcw"),
            t("app.b2.run_again")
          )
        )
      );
    }

    return el("div", { className: "run-outcome-section", dataset: { runPhase: run.phase } }, nodes);
  }

  function endpointHealthBadge(forward) {
    if (!forward) {
      return badge(t("app.b2.endpoint_not_forwarded"), "neutral");
    }
    const st = forward.state;
    const kind = typeof st === "string" ? st : st?.state;
    if (kind === "up") {
      if (forward.healthy === true) return badge(t("app.b2.endpoint_healthy"), "success");
      if (forward.healthy === false) return badge(t("app.b2.endpoint_unhealthy"), "warning");
      return badge(t("app.b2.tunnel_up"), "success");
    }
    if (kind === "reconnecting") {
      return badge(t("app.b2.tunnel_reconnecting_short"), "warning");
    }
    return badge(t("app.b2.tunnel_starting"), "info");
  }

  async function toggleEndpointForward(entry, run, wantOpen, desiredBind) {
    const ep = entry.endpoint;
    if (!ep || endpointBusy.has(ep.id)) return;
    endpointBusy.add(ep.id);
    renderRunBody();
    try {
      const account = run.outcome?.account || run.account;
      const session = run.outcome?.session || run.session;
      const liveForward =
        getForwardForEndpoint(account, session, ep.remote_port) ||
        (entry.forward && !state.forwardsLoaded ? entry.forward : null);

      if (!wantOpen) {
        if (liveForward?.id !== undefined) {
          await closeForward(liveForward.id);
          entry.forward = null;
        }
      } else {
        if (liveForward?.id !== undefined) {
          await closeForward(liveForward.id);
        }
        const bind = desiredBind || endpointBindChoice.get(ep.id) || "loopback";
        const opened = await openForward({
          account,
          session,
          bind,
          local_port: ep.remote_port,
          remote_port: ep.remote_port,
          health_path: ep.health ?? null,
        });
        entry.forward = opened;
        entry.error = null;
      }
    } catch (err) {
      if (err && err.status !== 401) {
        setNotice({ tone: "danger", message: formatApiError(err?.payload).message });
      }
    } finally {
      endpointBusy.delete(ep.id);
      if (view === "run") {
        renderRunBody();
      }
    }
  }

  function renderEndpointCard(entry, run, info) {
    const ep = entry.endpoint;
    if (!ep) return null;
    const label = localized(ep.label) || ep.id;
    const account = run.outcome?.account || run.account;
    const session = run.outcome?.session || run.session;
    const liveForward = getForwardForEndpoint(account, session, ep.remote_port);
    const forward = liveForward || (!state.forwardsLoaded ? entry.forward : null);

    const st = forward?.state;
    const stateKind = typeof st === "string" ? st : st?.state;
    const isUp = Boolean(forward && stateKind === "up");
    const isForwarded = Boolean(forward);
    const localPort = forward?.spec?.local_port ?? ep.remote_port;
    const pathTrimmed = String(ep.path || "/").replace(/\/+$/, "");
    const addresses = forward?.addresses || null;

    const openUrl = safeHttpUrl(addresses?.open_url);
    const copyUrl = addresses?.copy_url || addresses?.open_url || null;
    const openaiBaseUrl = addresses?.openai_base_url || null;
    const serverLocalFallbackUrl = `http://127.0.0.1:${localPort}${pathTrimmed}`;
    const displayUrl = copyUrl || serverLocalFallbackUrl;
    const isAllInterfaces = forward?.spec?.bind === "all_interfaces";
    const busy = endpointBusy.has(ep.id);

    const policy = resolveForwardPolicy();
    const currentBind = forward?.spec?.bind || endpointBindChoice.get(ep.id) || "loopback";

    const headerBadges = [endpointHealthBadge(forward)];
    if (isAllInterfaces) {
      headerBadges.push(badge(t("web.forward.bind_badge_all"), "warning"));
    }

    const openControl =
      isUp && openUrl
        ? el(
            "a",
            {
              href: openUrl,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "btn btn-sm",
              dataset: { endpointOpen: ep.id },
            },
            icon("externalLink"),
            t("app.b2.action_open_browser")
          )
        : el(
            "button",
            {
              type: "button",
              className: "btn btn-sm",
              dataset: { endpointOpen: ep.id },
              disabled: true,
            },
            icon("externalLink"),
            t("app.b2.action_open_browser")
          );

    const forwardSwitchId = `endpoint-forward-${ep.id}`;
    const forwardSwitch = el("input", {
      id: forwardSwitchId,
      type: "checkbox",
      role: "switch",
      className: "switch-input",
      checked: isForwarded,
      disabled: busy,
      dataset: { endpointForwardToggle: ep.id },
      onChange: (event) => {
        void toggleEndpointForward(entry, run, event.target.checked, currentBind);
      },
    });

    const cardChildren = [
      el(
        "div",
        { className: "card-header" },
        el("h2", { className: "card-title" }, label),
        el("div", { className: "card-actions" }, headerBadges)
      ),
      el(
        "div",
        { className: "endpoint-addr-row" },
        el("span", { className: "endpoint-url mono", dataset: { endpointUrl: ep.id } }, displayUrl),
        createCopyButton({
          text: displayUrl,
          ariaLabel: t("copy.button"),
          dataset: { endpointCopy: ep.id },
        }),
        openControl
      ),
    ];

    if (entry.error && !forward) {
      cardChildren.push(
        inlineMessage({ tone: "warning", text: formatApiError(entry.error).message })
      );
    }
    if (!forward) {
      cardChildren.push(
        inlineMessage({ tone: "info", text: t("web.plugins.endpoint_not_forwarded_note") })
      );
    }
    if (addresses?.notice_key) {
      cardChildren.push(inlineMessage({ tone: "info", text: t(addresses.notice_key) }));
    }
    if (addresses?.warning_key) {
      cardChildren.push(inlineMessage({ tone: "warning", text: t(addresses.warning_key) }));
    }

    cardChildren.push(
      el(
        "div",
        { className: "endpoint-controls-row" },
        el(
          "label",
          { for: forwardSwitchId, className: "switch-label" },
          forwardSwitch,
          t("app.b2.endpoint_forward")
        ),
        el("span", { className: "caption" }, t("app.b2.forward_billing_note"))
      )
    );

    if (policy.allInterfacesAllowed) {
      const bindSelectId = `endpoint-bind-${ep.id}`;
      const bindSelect = el(
        "select",
        {
          id: bindSelectId,
          className: "select select-sm select-inline",
          disabled: busy,
          dataset: { endpointBindSelect: ep.id },
          onChange: (event) => {
            const nextBind = event.target.value;
            endpointBindChoice.set(ep.id, nextBind);
            if (isForwarded) {
              void toggleEndpointForward(entry, run, true, nextBind);
            }
          },
        },
        el("option", { value: "loopback", selected: currentBind === "loopback" }, t("web.forward.bind_loopback")),
        el(
          "option",
          { value: "all_interfaces", selected: currentBind === "all_interfaces" },
          t("web.forward.bind_all")
        )
      );
      bindSelect.value = currentBind;
      cardChildren.push(
        el(
          "div",
          { className: "endpoint-bind-row" },
          el("label", { for: bindSelectId, className: "field-label" }, t("web.forward.bind_label")),
          bindSelect
        )
      );
    }

    if (ep.kind === "openai") {
      const modelId = run.outcome?.status?.outputs?.model_id || run.status?.outputs?.model_id || "MODEL";
      const hasSecretKey = (info?.manifest?.inputs || []).some((input) => input.type === "secret");
      const curlBase = openaiBaseUrl || serverLocalFallbackUrl;
      const curlCmd = buildOpenAiCurl(curlBase, modelId, hasSecretKey);

      cardChildren.push(
        el(
          "div",
          { className: "endpoint-curl-block", dataset: { endpointCurl: ep.id } },
          el(
            "div",
            { className: "endpoint-curl-header" },
            el("span", { className: "caption" }, t("app.b2.endpoint_curl")),
            createCopyButton({
              text: curlCmd,
              ariaLabel: t("copy.button"),
              dataset: { endpointCopyCurl: ep.id },
            })
          ),
          el("div", { className: "well" }, el("pre", { className: "endpoint-curl-code" }, curlCmd)),
          addresses?.notice_key === "web.forward.server_local"
            ? el("span", { className: "caption" }, t("web.plugins.endpoint_local_curl"))
            : null,
          hasSecretKey ? el("span", { className: "caption" }, t("app.b2.endpoint_curl_key")) : null
        )
      );
    }

    return el(
      "section",
      { className: "card card-compact", dataset: { endpointCard: ep.id } },
      cardChildren
    );
  }

  function renderOutputsCard(run) {
    const outputs = run.outcome?.status?.outputs || run.status?.outputs;
    if (!outputs || typeof outputs !== "object") return null;
    const entries = Object.entries(outputs);
    if (entries.length === 0) return null;

    return el(
      "section",
      { className: "card card-compact", dataset: { runOutputs: "true" } },
      el("div", { className: "card-header" }, el("h2", { className: "card-title" }, t("app.b2.run_outputs"))),
      el(
        "div",
        { className: "run-outputs-list" },
        entries.map(([key, val]) =>
          el(
            "div",
            { className: "run-output-row" },
            el("span", { className: "run-output-key" }, key),
            el(
              "span",
              { className: "run-output-val mono" },
              typeof val === "string" ? val : JSON.stringify(val)
            )
          )
        )
      )
    );
  }

  function renderLogCard(run, keepScrollTop = null) {
    const lines = Array.isArray(run.logLines) ? run.logLines : [];
    if (lines.length === 0 && !run.historySkipped) {
      logBoxEl = null;
      return null;
    }

    const box = el(
      "div",
      { className: "run-log-box", role: "log", "aria-live": "off", dataset: { runLog: "true" } },
      run.historySkipped
        ? el("div", { className: "run-log-line run-log-line-notice" }, t("web.plugins.history_skipped"))
        : null,
      lines.map((entry) =>
        el(
          "div",
          { className: entry.notice ? "run-log-line run-log-line-notice" : "run-log-line" },
          entry.text
        )
      )
    );
    logBoxEl = box;
    window.requestAnimationFrame(() => {
      if (!box.isConnected) return;
      box.scrollTop = keepScrollTop !== null ? keepScrollTop : box.scrollHeight;
    });

    return el(
      "section",
      { className: "card card-compact" },
      el("div", { className: "card-header" }, el("h2", { className: "card-title" }, t("app.b2.run_log"))),
      box
    );
  }

  function renderRunBody() {
    if (!bodyEl) return;
    const run = state.pluginRun;
    if (!run || run.phase === "idle") {
      showList();
      return;
    }
    const prevScroll = logBoxEl
      ? {
          nearBottom: logBoxEl.scrollHeight - logBoxEl.scrollTop - logBoxEl.clientHeight < 36,
          top: logBoxEl.scrollTop,
        }
      : null;

    clear(bodyEl);
    const info = findPlugin(run.plugin);

    if (run.provisions && Array.isArray(run.provision?.events) && run.provision.events.length > 0) {
      const provisioning = run.phase === "running" && !run.session;
      bodyEl.appendChild(
        el(
          "section",
          { className: "card card-compact", dataset: { runProvisioning: "true" } },
          el(
            "div",
            { className: "card-header" },
            el(
              "div",
              { className: "card-heading" },
              el("h2", { className: "card-title" }, t("app.b2.run_provisioning")),
              el("p", { className: "card-desc" }, provisionHeadline(run.provision.events))
            )
          ),
          ...renderProvisionProgress(
            {
              events: run.provision.events,
              latestAtMs: run.provision.latestAtMs,
              phase: run.phase,
              outcome: null,
            },
            provisioning
          )
        )
      );
    }

    const stagesCard = renderStagesCard(run, info);
    if (stagesCard) {
      bodyEl.appendChild(stagesCard);
    }

    bodyEl.appendChild(renderOutcomeSection(run));

    if (run.phase === "ready" && Array.isArray(run.endpoints)) {
      for (const entry of run.endpoints) {
        const card = renderEndpointCard(entry, run, info);
        if (card) bodyEl.appendChild(card);
      }
    }

    const outputsCard = renderOutputsCard(run);
    if (outputsCard) {
      bodyEl.appendChild(outputsCard);
    }

    const keepScrollTop = prevScroll && !prevScroll.nearBottom ? prevScroll.top : null;
    const logCard = renderLogCard(run, keepScrollTop);
    if (logCard) {
      bodyEl.appendChild(logCard);
    }
  }

  // ---- Header & Dispatcher ----

  function renderHeader() {
    if (!headerEl) return;
    clear(headerEl);

    if (view === "form" && formModel) {
      const info = findPlugin(formModel.pluginId);
      const title = info ? pluginDisplayName(info) : formModel.pluginId;
      headerEl.className = "page-header page-header-row";
      headerEl.append(
        el(
          "div",
          { className: "page-header-heading" },
          el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, title)
        ),
        el(
          "div",
          { className: "page-header-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-ghost",
              dataset: { pluginBack: "true" },
              onClick: () => showList(),
            },
            icon("arrowLeft"),
            t("app.b2.action_back")
          )
        )
      );
      return;
    }

    if (view === "run" && state.pluginRun && state.pluginRun.phase !== "idle") {
      const run = state.pluginRun;
      const info = findPlugin(run.plugin);
      const title = info ? pluginDisplayName(info) : run.plugin;
      const subtitle = run.session
        ? t("app.b2.run_on_session", { name: run.session })
        : t("app.b2.run_subtitle");
      headerEl.className = "page-header page-header-row";
      headerEl.append(
        el(
          "div",
          { className: "page-header-heading" },
          el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, title),
          el("p", { className: "page-subtitle" }, subtitle)
        ),
        el(
          "div",
          { className: "page-header-actions" },
          el(
            "button",
            {
              type: "button",
              className: "btn btn-ghost",
              dataset: { pluginRunBack: "true" },
              onClick: () => showList(),
            },
            icon("arrowLeft"),
            t("app.b2.action_back")
          )
        )
      );
      return;
    }

    headerEl.className = "page-header page-header-row";
    headerEl.append(
      el(
        "div",
        { className: "page-header-heading" },
        el("h1", { id: "page-heading", tabindex: "-1", className: "page-title" }, t("app.nav.plugins")),
        el("p", { className: "page-subtitle" }, t("app.plugins.subtitle"))
      ),
      el(
        "div",
        { className: "page-header-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            dataset: { pluginHeaderToken: "true" },
            onClick: () => openHfTokenDialog(),
          },
          icon("key"),
          t("app.b2.hf_token_title")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn",
            dataset: { pluginHeaderInstall: "true" },
            onClick: () => openInstallPluginDialog(),
          },
          icon("plus"),
          t("app.b2.plugin_install_title")
        )
      )
    );
  }

  function renderListBody() {
    if (!bodyEl) return;
    clear(bodyEl);

    const banner = renderRunBanner();
    if (banner) {
      bodyEl.appendChild(banner);
    }

    if (state.pluginsError) {
      const formatted = formatApiError(state.pluginsError);
      bodyEl.appendChild(
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
                void loadPlugins();
              },
            },
            t("app.action.retry")
          ),
        })
      );
    } else if (!state.pluginsLoaded && state.pluginsLoading) {
      bodyEl.appendChild(busyLine(t("app.b2.plugins_loading")));
    } else if (!Array.isArray(state.plugins) || state.plugins.length === 0) {
      bodyEl.appendChild(
        emptyState({
          iconName: "plugins",
          title: t("web.plugins.empty_title"),
          body: t("web.plugins.empty_body"),
        })
      );
    } else {
      for (const info of state.plugins) {
        bodyEl.appendChild(renderPluginCard(info));
      }
    }

    bodyEl.appendChild(renderInstallCard());
    bodyEl.appendChild(renderHfTokenCard());
  }

  function renderBody() {
    if (view === "form") {
      renderFormView();
    } else if (view === "run") {
      renderRunBody();
    } else {
      renderListBody();
    }
  }

  function renderAll() {
    renderHeader();
    renderBody();
  }

  function maybeConsumePendingOpen() {
    const requested = consumePendingOpenPluginId();
    if (requested && findPlugin(requested)?.enabled) {
      void openRunForm(requested);
      return true;
    }
    return false;
  }

  return {
    mount(container) {
      root = container;
      clear(root);
      headerEl = el("header", { className: "page-header page-header-row" });
      bodyEl = el("div", { className: "page-sections" });
      root.append(headerEl, bodyEl);

      if (!maybeConsumePendingOpen()) {
        if (view === "run" && (!state.pluginRun || state.pluginRun.phase === "idle")) {
          view = "list";
        }
        renderAll();
      }

      if (!state.overview && !state.overviewLoading) {
        void loadOverview({ silent: true });
      }
      void loadPlugins({ silent: state.pluginsLoaded });
      void loadHfToken({ silent: state.hfToken.status === "ready" });
      void loadPluginRuns();
      void loadForwards();
    },

    update(reason) {
      if (!root) return;

      if (view === "form") {
        // Strictly isolate form inputs from background SSE snapshots & unrelated refreshes.
        if (reason === "locale") {
          renderAll();
        } else if (
          reason === "snapshot" ||
          reason === "hf_token" ||
          reason === "plugin_run" ||
          reason === "sessions"
        ) {
          syncFormLiveSlots();
        }
        return;
      }

      if (view === "run") {
        if (
          reason === "locale" ||
          reason === "plugin_run" ||
          reason === "forwards" ||
          reason === "snapshot" ||
          reason === "sessions" ||
          reason === "overview"
        ) {
          renderHeader();
          renderRunBody();
        }
        return;
      }

      // List view: avoid destroying inline install input while focused.
      if (reason === "plugins") {
        if (maybeConsumePendingOpen()) return;
      }
      const active = document.activeElement;
      const typingInListInstall =
        active instanceof HTMLInputElement && active.id === "plugin-list-source-input";
      if (typingInListInstall && reason === "snapshot") {
        return;
      }
      if (
        reason === "locale" ||
        reason === "plugins" ||
        reason === "hf_token" ||
        reason === "plugin_run" ||
        reason === "snapshot"
      ) {
        renderAll();
      }
    },

    unmount() {
      clearHfFitDebounce();
      root = null;
      headerEl = null;
      bodyEl = null;
      formDom = null;
      logBoxEl = null;
    },
  };
}
