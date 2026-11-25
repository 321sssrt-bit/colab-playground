import { alertBox, announce, badge, busyLine, clear, el, inlineMessage } from "./components.js";
import {
  ACCELERATORS,
  acceleratorIsGpu,
  acceleratorLabel,
  acceleratorNamePrefix,
  acceleratorSupportsHighMem,
  composeDuration,
  formatApiError,
  formatDurationSecs,
  formatEmail,
  formatHardware,
  formatRuntimeCardLabel,
  formatRuntimeLabel,
  formatShortWait,
  formatVram,
  isLoopbackHostname,
  splitDuration,
} from "./format.js";
import { onLocaleChange, t } from "./i18n.js";
import { icon } from "./icons.js";
import {
  cancelSessionProvision,
  changeAutoStop,
  closeForward,
  fetchSessionTemplate,
  getAccountContext,
  getActiveEmail,
  getForwardsForRuntime,
  getMaxConcurrentSessions,
  getRearmDurationSecs,
  getSessionLimitReached,
  isProvisionRunning,
  isStopAllRunning,
  notifyProvisionView,
  openForward,
  resetProvisionState,
  setNotice,
  startSessionProvision,
  state,
  stopAllRuntimes,
  stopRuntime,
  subscribe,
} from "./store.js";

const DIALOG_ID = "session-dialog";
const TITLE_ID = "session-dialog-title";

const RESERVED_VM_PORT = 8080;
const FORWARD_START_PORT = 8000;
const MAX_ATTEMPTS_CAP = 8;
const MAX_CU_FIELD = 100000;
const MAX_VRAM_GIB = 1024;
const MIB_PER_GIB = 1024;
const START_MAX_RUNTIME_SECS = 7200;
const START_IDLE_SECS = 1800;
const START_SPEND_CU = 10;
const START_MIN_BALANCE_CU = 5;
const START_MIN_VRAM_MIB = 40 * MIB_PER_GIB;
const SLOW_ANSWER_MS = 60000;

let initialized = false;
let navigateFn = null;
let activeDialog = null;
let dialogGeneration = 0;
let slowAnswerTimer = null;

function getDialogEl() {
  return document.getElementById(DIALOG_ID);
}

export function safeHttpUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
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

function accountContextChanged(captured) {
  if (!captured) return false;
  const current = state.snapshot?.account;
  if (!current) return false;
  return current.revision !== captured.revision || (current.active ?? null) !== (captured.active ?? null);
}

export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy selection copy on non-secure HTTP origins.
    }
  }
  const dialog = getDialogEl();
  const host = dialog?.open ? dialog : document.body;
  if (!host) return false;
  const prevActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const proxy = document.createElement("textarea");
  proxy.className = "clipboard-proxy";
  proxy.setAttribute("readonly", "");
  proxy.setAttribute("aria-hidden", "true");
  proxy.tabIndex = -1;
  proxy.value = text;
  host.appendChild(proxy);
  let copied = false;
  try {
    proxy.focus({ preventScroll: true });
    proxy.select();
    proxy.setSelectionRange(0, text.length);
    copied = Boolean(document.execCommand("copy"));
  } catch {
    copied = false;
  } finally {
    proxy.remove();
    if (prevActive && prevActive.isConnected) {
      prevActive.focus({ preventScroll: true });
    }
  }
  return copied;
}

function randomHex4() {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
}

function makeSuggestedName(accelerator, existingName) {
  const prefix = acceleratorNamePrefix(accelerator);
  const suffix =
    typeof existingName === "string" && /-[0-9a-f]{4}$/i.test(existingName)
      ? existingName.slice(-4).toLowerCase()
      : randomHex4();
  return `${prefix}-${suffix}`;
}

function clearSlowAnswerTimer() {
  if (slowAnswerTimer !== null) {
    window.clearInterval(slowAnswerTimer);
    slowAnswerTimer = null;
  }
}

function isDialogBusy(dialog) {
  if (!dialog) return false;
  if (dialog.kind === "stop" || dialog.kind === "cancel_auto_stop" || dialog.kind === "auto_stop") {
    return Boolean(dialog.submitting);
  }
  if (dialog.kind === "stop_all") {
    return Boolean(dialog.submitting || isStopAllRunning());
  }
  if (dialog.kind === "forward") {
    return Boolean(dialog.submitting);
  }
  if (dialog.kind === "new_session") {
    return dialog.phase === "loading_template" || dialog.submitting;
  }
  return false;
}

function closeDialogNow() {
  dialogGeneration += 1;
  clearSlowAnswerTimer();
  const prev = activeDialog;
  activeDialog = null;
  const dialog = getDialogEl();
  if (dialog) {
    if (dialog.open) {
      dialog.close();
    }
    clear(dialog);
  }
  if (prev?.kind === "new_session") {
    if (state.provision.phase !== "running") {
      resetProvisionState();
    } else {
      notifyProvisionView();
    }
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

export function isNewSessionDialogOpen() {
  return Boolean(activeDialog && activeDialog.kind === "new_session");
}

export function provisionHeadline(events) {
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (ev?.event === "allocating") {
        return t("app.b2.prov_attempt", {
          n: ev.attempt ?? 1,
          of: ev.max_attempts ?? 1,
        });
      }
    }
  }
  return t("app.b2.prov_starting");
}

function provisionSentence(ev, done) {
  if (!ev || typeof ev !== "object") return null;
  const hw = (gpu, vram) => formatHardware(gpu, vram) || t("app.b2.prov_no_gpu");
  switch (ev.event) {
    case "allocating":
      return {
        text: t(done ? "app.b3.prov_allocated" : "app.b2.prov_allocating", {
          n: ev.attempt ?? 1,
          of: ev.max_attempts ?? 1,
        }),
        tone: "busy",
      };
    case "allocated":
    case "failed":
      return null;
    case "allocation_failed":
      return {
        text: t("app.b2.prov_allocation_failed", {
          why: formatApiError(ev.error).message,
        }),
        tone: "warn",
      };
    case "probed":
      return {
        text: t("app.b2.prov_probed", { hardware: hw(ev.gpu, ev.vram_mib) }),
        tone: "info",
      };
    case "rejected":
      return {
        text: t("app.b2.prov_rejected", {
          got: ev.vram_mib ? formatVram(ev.vram_mib) : t("app.summary.unknown"),
          min: formatVram(ev.min_vram_mib),
        }),
        tone: "warn",
      };
    case "releasing":
      return {
        text: t(done ? "app.b3.prov_released" : "app.b2.prov_releasing"),
        tone: "busy",
      };
    case "reconciling":
      return {
        text: t(done ? "app.b11.prov_reconciled" : "app.b11.prov_reconciling"),
        tone: "busy",
      };
    case "orphan_detected":
      return {
        text: t(ev.released ? "app.b2.prov_orphan_released" : "app.b2.prov_orphan_left"),
        tone: ev.released ? "info" : "bad",
      };
    case "retrying":
      return {
        text: t(done ? "app.b3.prov_retried" : "app.b2.prov_retrying", {
          time: formatShortWait(ev.delay_secs),
        }),
        tone: "busy",
      };
    case "watchdog_started":
      return {
        text: t(ev.deadline ? "app.b2.prov_watchdog" : "app.b2.prov_watchdog_no_deadline"),
        tone: "good",
      };
    case "watchdog_failed":
      return {
        text: t("app.b2.prov_watchdog_failed"),
        tone: "bad",
      };
    case "ready":
      return {
        text: t(ev.below_spec ? "app.b2.prov_ready_below" : "app.b2.prov_ready", {
          hardware: hw(ev.gpu, ev.vram_mib),
        }),
        tone: ev.below_spec ? "warn" : "good",
      };
    default:
      return null;
  }
}

export function renderProvisionProgress(provision, live) {
  const events = Array.isArray(provision?.events) ? provision.events : [];
  const shown = events.filter((ev) => provisionSentence(ev, true) !== null);
  // Server omits ProvisionEvent::Ready from progress SSE and reports it on finished.outcome.
  if (
    !live &&
    provision?.phase === "ready" &&
    provision.outcome &&
    !shown.some((ev) => ev?.event === "ready")
  ) {
    shown.push({
      event: "ready",
      gpu: provision.outcome.hardware?.gpu ?? null,
      vram_mib: provision.outcome.hardware?.vram_mib ?? null,
      below_spec: Boolean(provision.outcome.below_spec),
    });
  }
  const rows = shown.map((ev, index) => {
    const isCurrent = live && index + 1 === shown.length;
    const item = provisionSentence(ev, !isCurrent);
    if (!item) return null;
    let marker;
    if (isCurrent && item.tone === "busy") {
      marker = el("span", { className: "spinner", "aria-hidden": "true" });
    } else if (item.tone === "good") {
      marker = icon("checkCircle", "icon-success");
    } else if (item.tone === "warn") {
      marker = icon("alertTriangle", "icon-warning");
    } else if (item.tone === "bad") {
      marker = icon("circleX", "icon-danger");
    } else if (isCurrent) {
      marker = icon("dot", "icon-muted");
    } else {
      marker = icon("checkCircle", "icon-muted");
    }
    return el(
      "div",
      { className: "progress-row" },
      el("span", { className: "progress-marker" }, marker),
      el("span", { className: "progress-text" }, item.text)
    );
  });

  const nodes = [];
  if (rows.length > 0) {
    nodes.push(el("div", { className: "progress-list", dataset: { provisionProgress: "true" } }, rows));
  }

  const last = events.length > 0 ? events[events.length - 1] : null;
  if (live && last?.event === "allocating" && provision?.latestAtMs) {
    const waitedMs = Date.now() - provision.latestAtMs;
    if (waitedMs >= SLOW_ANSWER_MS) {
      nodes.push(
        inlineMessage({
          tone: "info",
          text: t("app.b11.prov_no_answer", {
            time: formatDurationSecs(Math.floor(waitedMs / 1000)),
          }),
        })
      );
    }
  }
  return nodes;
}

function tunnelStateBadge(forward) {
  const st = forward?.state;
  const kind = typeof st === "string" ? st : st?.state;
  switch (kind) {
    case "starting":
      return badge(t("app.b2.tunnel_starting"), "info");
    case "up":
      if (forward.healthy === false) {
        return badge(t("app.b2.tunnel_up_unhealthy"), "warning");
      }
      return badge(t("app.b2.tunnel_up"), "success");
    case "reconnecting":
      return badge(t("app.b2.tunnel_reconnecting", { n: st?.attempt ?? 1 }), "warning");
    case "failed":
      return badge(t("app.b2.tunnel_failed"), "danger");
    case "stopped":
      return badge(t("app.b2.tunnel_stopped"), "neutral");
    default:
      return badge(t("app.b2.tunnel_starting"), "info");
  }
}

export function renderForwardRow(forward, { onAfterClose = null } = {}) {
  const st = forward?.state;
  const kind = typeof st === "string" ? st : st?.state;
  const terminal = kind === "failed" || kind === "stopped";
  const spec = forward?.spec || {};
  const addresses = forward?.addresses || null;
  const openUrl = safeHttpUrl(addresses?.open_url);
  const copyUrl = addresses?.copy_url || addresses?.open_url || null;
  const displayAddr = openUrl || `127.0.0.1:${spec.local_port ?? ""}`;
  const isAllInterfaces = spec.bind === "all_interfaces";

  const copyBtnIconHolder = el("span", { className: "btn-icon-slot" }, icon("copy"));
  const copyBtn = copyUrl
    ? el(
        "button",
        {
          type: "button",
          className: "btn btn-sm btn-ghost btn-icon",
          dataset: { forwardCopy: String(forward.id), focusKey: `fw:${forward.id}:copy` },
          "aria-label": t("copy.button"),
          title: t("copy.button"),
          onClick: async () => {
            const ok = await copyTextToClipboard(copyUrl);
            if (ok) {
              clear(copyBtnIconHolder);
              copyBtnIconHolder.appendChild(icon("check", "icon-success"));
              announce(t("web.shell.copied"));
              window.setTimeout(() => {
                if (!copyBtnIconHolder.isConnected) return;
                clear(copyBtnIconHolder);
                copyBtnIconHolder.appendChild(icon("copy"));
              }, 2000);
            } else {
              announce(t("web.shell.copy_link_failed"), "assertive");
            }
          },
        },
        copyBtnIconHolder
      )
    : null;

  const openLink = openUrl
    ? el(
        "a",
        {
          href: openUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "btn btn-sm btn-ghost btn-icon",
          dataset: { forwardOpen: String(forward.id), focusKey: `fw:${forward.id}:open` },
          "aria-label": t("app.b2.action_open_browser"),
          title: t("app.b2.action_open_browser"),
        },
        icon("externalLink")
      )
    : null;

  let closing = false;
  const closeBtn = el(
    "button",
    {
      type: "button",
      className: "btn btn-sm btn-ghost btn-icon",
      dataset: { forwardClose: String(forward.id), focusKey: `fw:${forward.id}:close` },
      "aria-label": t(terminal ? "app.action.dismiss" : "app.b2.forward_close"),
      title: t(terminal ? "app.action.dismiss" : "app.b2.forward_close"),
      onClick: async () => {
        if (closing) return;
        closing = true;
        closeBtn.disabled = true;
        try {
          await closeForward(forward.id);
          if (onAfterClose) onAfterClose();
        } catch (err) {
          if (err && err.status !== 401) {
            setNotice({ tone: "danger", message: formatApiError(err?.payload).message });
          }
          if (closeBtn.isConnected) {
            closing = false;
            closeBtn.disabled = false;
          }
        }
      },
    },
    icon("x")
  );

  const primaryRow = el(
    "div",
    { className: "forward-row-main" },
    tunnelStateBadge(forward),
    isAllInterfaces ? badge(t("web.forward.bind_badge_all"), "warning") : null,
    el("span", { className: "forward-addr mono" }, `${displayAddr} → ${spec.remote_port ?? ""}`),
    el(
      "span",
      { className: "forward-row-actions" },
      !terminal ? copyBtn : null,
      !terminal ? openLink : null,
      closeBtn
    )
  );

  const notes = [];
  if (addresses?.notice_key) {
    notes.push(inlineMessage({ tone: "info", text: t(addresses.notice_key) }));
  }
  if (addresses?.warning_key) {
    notes.push(inlineMessage({ tone: "warning", text: t(addresses.warning_key) }));
  }
  if (kind === "failed" && st?.error) {
    notes.push(el("span", { className: "caption" }, formatApiError(st.error).message));
  }

  return el(
    "div",
    { className: "forward-item", dataset: { forwardRow: String(forward.id) } },
    primaryRow,
    notes.length > 0 ? el("div", { className: "forward-item-notes" }, notes) : null
  );
}

function buildDurationField(idPrefix, totalSecs, onChange) {
  let parts = splitDuration(totalSecs, false);
  const emit = () => {
    onChange(composeDuration(parts.hours, parts.minutes, 0));
  };
  const part = (suffix, value, max, unitKey, field) => {
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
    part("hours", parts.hours, 999, "app.b3.unit_hours", "hours"),
    part("minutes", parts.minutes, 59, "app.b3.unit_minutes", "minutes")
  );
}

function buildOptionalRow({ id, label, hint, enabled, onToggle, renderValue }) {
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

  const toggleId = `prov-toggle-${id}`;
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
    { className: "prov-row" },
    el(
      "div",
      { className: "prov-row-info" },
      el("div", { className: "field-label" }, label),
      hint ? el("div", { className: "field-hint" }, hint) : null
    ),
    el(
      "div",
      { className: "prov-row-control" },
      el(
        "div",
        { className: "optional-control" },
        el("label", { for: toggleId, className: "checkbox-label" }, checkbox, t("app.def.limit")),
        slot
      )
    )
  );
}

function provRow(label, hint, control) {
  return el(
    "div",
    { className: "prov-row" },
    el(
      "div",
      { className: "prov-row-info" },
      el("div", { className: "field-label" }, label),
      hint ? el("div", { className: "field-hint" }, hint) : null
    ),
    el("div", { className: "prov-row-control" }, control)
  );
}

function renderLimitDialog(dialog, limitInfo) {
  dialog.dataset.dialogKind = "new_session";
  dialog.dataset.dialogPhase = "limit";
  const max = limitInfo?.limit ?? getMaxConcurrentSessions();
  const email = formatEmail(limitInfo?.email ?? getActiveEmail());
  const counted = Array.isArray(limitInfo?.counted)
    ? limitInfo.counted.join(t("app.fmt.list_separator"))
    : "";

  dialog.append(
    el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")),
    el(
      "div",
      { className: "dialog-body", dataset: { newSessionLimit: "true" } },
      inlineMessage({
        tone: "warning",
        text: t("app.b3.new_limit_body", { limit: max, email }),
      }),
      counted ? el("p", { className: "dialog-paragraph" }, t("app.b3.new_limit_counted", { names: counted })) : null,
      el("p", { className: "dialog-caption" }, t("app.b3.new_limit_hint"))
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
          className: "btn",
          onClick: () => {
            closeDialogNow();
            if (navigateFn) navigateFn("sessions");
          },
        },
        t("app.b2.new_show_sessions")
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          autofocus: true,
          onClick: () => {
            closeDialogNow();
            if (navigateFn) navigateFn("settings");
          },
        },
        t("app.b3.new_open_settings")
      )
    )
  );
}

async function submitNewSession(model) {
  if (!model || !model.spec || model.submitting) return;
  const spec = cloneSpec(model.spec);
  const typed = (model.nameDraft || "").trim();
  spec.name = typed || model.suggestedName || makeSuggestedName(spec.accelerator);
  spec.high_mem = Boolean(spec.high_mem) && acceleratorSupportsHighMem(spec.accelerator);
  if (!acceleratorIsGpu(spec.accelerator)) {
    spec.min_vram_mib = null;
  }
  if (spec.guard?.max_runtime !== null && spec.guard?.max_runtime !== undefined && spec.guard.max_runtime <= 0) {
    model.formError = t("web.sessions.auto_stop_duration_required");
    renderActiveDialog();
    return;
  }
  if (spec.guard?.idle_timeout !== null && spec.guard?.idle_timeout !== undefined && spec.guard.idle_timeout <= 0) {
    model.formError = t("web.sessions.auto_stop_duration_required");
    renderActiveDialog();
    return;
  }

  const gen = ++dialogGeneration;
  model.submitting = true;
  model.formError = null;
  model.spec = cloneSpec(spec);
  renderActiveDialog();

  try {
    await startSessionProvision(spec, model.accountContext);
    if (gen !== dialogGeneration || activeDialog !== model) return;
    model.submitting = false;
    if (
      state.provision.phase === "ready" ||
      state.provision.phase === "failed" ||
      state.provision.phase === "cancelled"
    ) {
      model.phase = state.provision.phase;
      model.error = state.provision.error;
    } else {
      model.phase = "running";
    }
    renderActiveDialog();
  } catch (err) {
    if (err && err.status === 401) {
      closeDialogNow();
      return;
    }
    if (gen !== dialogGeneration || activeDialog !== model) return;
    model.submitting = false;
    const payload = err?.payload || { error: {} };
    if (payload?.error?.kind === "session_limit_reached") {
      model.phase = "limit";
      model.limitInfo = getSessionLimitReached();
    } else {
      model.formError = formatApiError(payload).message;
    }
    renderActiveDialog();
  }
}

export function buildProvisionOptionRows({
  idPrefix = "prov",
  spec,
  disabled = false,
  onAcceleratorChange = null,
  onHardwareFitChange = null,
}) {
  const isGpu = acceleratorIsGpu(spec.accelerator);
  const supportsHighMem = acceleratorSupportsHighMem(spec.accelerator);

  const accSelect = el(
    "select",
    {
      id: `${idPrefix}-accelerator`,
      className: "select select-sm select-inline",
      "aria-label": t("app.def.accelerator"),
      disabled,
      onChange: (event) => {
        const nextAcc = event.target.value;
        spec.accelerator = nextAcc;
        if (!acceleratorSupportsHighMem(nextAcc)) {
          spec.high_mem = false;
        }
        if (!acceleratorIsGpu(nextAcc)) {
          spec.min_vram_mib = null;
        }
        if (onAcceleratorChange) {
          onAcceleratorChange(nextAcc);
        }
      },
    },
    ACCELERATORS.map((code) =>
      el("option", { value: code, selected: spec.accelerator === code }, acceleratorLabel(code))
    )
  );
  accSelect.value = spec.accelerator;

  const highMemId = `${idPrefix}-high-mem`;
  const highMemToggle = el(
    "label",
    { for: highMemId, className: "checkbox-label" },
    el("input", {
      id: highMemId,
      type: "checkbox",
      className: "checkbox",
      checked: Boolean(spec.high_mem) && supportsHighMem,
      disabled: disabled || !supportsHighMem,
      onChange: (event) => {
        spec.high_mem = event.target.checked;
      },
    }),
    t("app.def.high_mem")
  );

  const attemptsInput = el("input", {
    id: `${idPrefix}-attempts`,
    type: "number",
    min: "1",
    max: String(MAX_ATTEMPTS_CAP),
    step: "1",
    className: "input input-sm input-num",
    "aria-label": t("app.def.attempts"),
    value: String(Math.max(1, Math.min(MAX_ATTEMPTS_CAP, spec.max_attempts || 1))),
    disabled,
    onInput: (event) => {
      const val = Number.parseInt(event.target.value, 10);
      if (Number.isFinite(val)) {
        spec.max_attempts = Math.max(1, Math.min(MAX_ATTEMPTS_CAP, val));
      }
    },
  });

  const exhaustedSelect = el(
    "select",
    {
      id: `${idPrefix}-on-exhausted`,
      className: "select select-sm select-inline",
      "aria-label": t("app.def.on_exhausted"),
      disabled,
      onChange: (event) => {
        spec.on_exhausted = event.target.value;
      },
    },
    el("option", { value: "stop_and_fail", selected: spec.on_exhausted === "stop_and_fail" }, t("app.def.exhausted_stop")),
    el("option", { value: "keep_last", selected: spec.on_exhausted === "keep_last" }, t("app.def.exhausted_keep"))
  );
  exhaustedSelect.value = spec.on_exhausted || "stop_and_fail";

  const rows = [
    provRow(t("app.def.accelerator"), null, accSelect),
    provRow(t("app.def.high_mem"), null, highMemToggle),
  ];

  if (isGpu) {
    rows.push(
      buildOptionalRow({
        id: `${idPrefix}-min-vram`,
        label: t("app.def.min_vram"),
        hint: t("app.b2.prov_vram_lottery"),
        enabled: spec.min_vram_mib !== null && spec.min_vram_mib !== undefined,
        onToggle: (on) => {
          spec.min_vram_mib = on ? START_MIN_VRAM_MIB : null;
          if (onHardwareFitChange) onHardwareFitChange();
        },
        renderValue: () => {
          const gib = Math.max(1, Math.round((spec.min_vram_mib ?? START_MIN_VRAM_MIB) / MIB_PER_GIB));
          return el(
            "span",
            { className: "unit-field" },
            el("input", {
              id: `${idPrefix}-min-vram-val`,
              type: "number",
              min: "1",
              max: String(MAX_VRAM_GIB),
              step: "1",
              className: "input input-sm input-num",
              "aria-label": t("app.def.min_vram"),
              value: String(gib),
              disabled,
              onInput: (event) => {
                const val = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(val)) {
                  spec.min_vram_mib = Math.max(1, val) * MIB_PER_GIB;
                  if (onHardwareFitChange) onHardwareFitChange();
                }
              },
            }),
            el("span", { className: "unit-suffix" }, t("app.unit.gb"))
          );
        },
      })
    );
  }

  rows.push(
    provRow(t("app.def.attempts"), t("app.b2.prov_attempts_billed"), attemptsInput),
    provRow(t("app.def.on_exhausted"), null, exhaustedSelect),
    buildOptionalRow({
      id: `${idPrefix}-max-runtime`,
      label: t("app.def.max_runtime"),
      hint: t("app.def.max_runtime_hint"),
      enabled: spec.guard?.max_runtime !== null && spec.guard?.max_runtime !== undefined,
      onToggle: (on) => {
        spec.guard.max_runtime = on ? START_MAX_RUNTIME_SECS : null;
      },
      renderValue: () =>
        buildDurationField(`${idPrefix}-max-runtime`, spec.guard.max_runtime ?? START_MAX_RUNTIME_SECS, (secs) => {
          spec.guard.max_runtime = secs;
        }),
    }),
    buildOptionalRow({
      id: `${idPrefix}-max-spend`,
      label: t("app.def.max_spend"),
      hint: null,
      enabled: spec.guard?.max_spend_cu !== null && spec.guard?.max_spend_cu !== undefined,
      onToggle: (on) => {
        spec.guard.max_spend_cu = on ? START_SPEND_CU : null;
      },
      renderValue: () =>
        el(
          "span",
          { className: "unit-field" },
          el("input", {
            id: `${idPrefix}-max-spend-val`,
            type: "number",
            min: "0",
            max: String(MAX_CU_FIELD),
            step: "any",
            className: "input input-sm input-num",
            "aria-label": t("app.def.max_spend"),
            value: String(spec.guard.max_spend_cu ?? START_SPEND_CU),
            disabled,
            onInput: (event) => {
              const val = Number.parseFloat(event.target.value);
              spec.guard.max_spend_cu = Number.isFinite(val) ? Math.max(0, val) : 0;
            },
          }),
          el("span", { className: "unit-suffix" }, t("app.unit.cu"))
        ),
    }),
    buildOptionalRow({
      id: `${idPrefix}-min-balance`,
      label: t("app.def.min_balance"),
      hint: null,
      enabled: spec.guard?.min_balance_cu !== null && spec.guard?.min_balance_cu !== undefined,
      onToggle: (on) => {
        spec.guard.min_balance_cu = on ? START_MIN_BALANCE_CU : null;
      },
      renderValue: () =>
        el(
          "span",
          { className: "unit-field" },
          el("input", {
            id: `${idPrefix}-min-balance-val`,
            type: "number",
            min: "0",
            max: String(MAX_CU_FIELD),
            step: "any",
            className: "input input-sm input-num",
            "aria-label": t("app.def.min_balance"),
            value: String(spec.guard.min_balance_cu ?? START_MIN_BALANCE_CU),
            disabled,
            onInput: (event) => {
              const val = Number.parseFloat(event.target.value);
              spec.guard.min_balance_cu = Number.isFinite(val) ? Math.max(0, val) : 0;
            },
          }),
          el("span", { className: "unit-suffix" }, t("app.unit.cu"))
        ),
    }),
    buildOptionalRow({
      id: `${idPrefix}-idle-timeout`,
      label: t("app.def.idle"),
      hint: null,
      enabled: spec.guard?.idle_timeout !== null && spec.guard?.idle_timeout !== undefined,
      onToggle: (on) => {
        spec.guard.idle_timeout = on ? START_IDLE_SECS : null;
      },
      renderValue: () =>
        buildDurationField(`${idPrefix}-idle`, spec.guard.idle_timeout ?? START_IDLE_SECS, (secs) => {
          spec.guard.idle_timeout = secs;
        }),
    })
  );

  return rows;
}

function renderNewSessionDialog(dialog, model) {
  dialog.dataset.dialogKind = "new_session";
  const prov = state.provision;

  if (model.phase === "running" || prov.phase === "running") {
    model.phase = "running";
    dialog.dataset.dialogPhase = "running";
    const cancelling = Boolean(prov.cancelling);
    dialog.append(
      el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")),
      el(
        "div",
        { className: "dialog-body" },
        el("div", { className: "field-label" }, provisionHeadline(prov.events)),
        ...renderProvisionProgress(prov, true),
        inlineMessage({ tone: "info", text: t("app.b2.new_cancel_note") })
      ),
      el(
        "div",
        { className: "modal-actions" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn-ghost",
            dataset: { newSessionHide: "true" },
            onClick: () => closeDialogNow(),
          },
          t("app.b2.action_hide")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-danger",
            dataset: { newSessionCancelRun: "true" },
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
    return;
  }

  if (model.phase === "ready" || prov.phase === "ready") {
    model.phase = "ready";
    dialog.dataset.dialogPhase = "ready";
    const readyName = prov.outcome?.name || prov.sessionName || model.spec?.name || "";
    const belowSpec = Boolean(prov.outcome?.below_spec);
    const hardware =
      formatHardware(prov.outcome?.hardware?.gpu, prov.outcome?.hardware?.vram_mib) ||
      t("app.b2.prov_no_gpu");
    dialog.append(
      el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")),
      el(
        "div",
        { className: "dialog-body" },
        ...renderProvisionProgress(prov, false),
        belowSpec
          ? alertBox({
              tone: "warning",
              title: t("app.b2.new_ready", { name: readyName }),
              body: t("app.b2.prov_ready_below", { hardware }),
            })
          : inlineMessage({ tone: "success", text: t("app.b2.new_ready", { name: readyName }) })
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
            autofocus: true,
            onClick: () => {
              closeDialogNow();
              if (navigateFn) navigateFn("sessions");
            },
          },
          t("app.b2.new_show_sessions")
        )
      )
    );
    return;
  }

  if (model.phase === "failed" || model.phase === "cancelled" || prov.phase === "failed" || prov.phase === "cancelled") {
    const isCancelled = model.phase === "cancelled" || prov.phase === "cancelled";
    const errPayload = model.error || prov.error;
    if (!isCancelled && errPayload?.error?.kind === "session_limit_reached") {
      renderLimitDialog(dialog, getSessionLimitReached());
      return;
    }
    dialog.dataset.dialogPhase = isCancelled ? "cancelled" : "failed";
    const formatted = formatApiError(errPayload);
    dialog.append(
      el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")),
      el(
        "div",
        { className: "dialog-body" },
        ...renderProvisionProgress(prov, false),
        isCancelled
          ? inlineMessage({ tone: "info", text: t("app.b2.new_cancelled") })
          : alertBox({
              tone: "danger",
              title: t("app.b2.new_failed"),
              body: [formatted.message, formatted.hint].filter(Boolean).join("\n"),
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
          t("app.action.close")
        ),
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            dataset: { newSessionChange: "true" },
            autofocus: true,
            onClick: () => {
              resetProvisionState();
              model.phase = "editing";
              model.error = null;
              model.formError = null;
              if (!model.spec) {
                void loadTemplateForDialog(model);
              } else {
                renderActiveDialog();
              }
            },
          },
          t("app.b2.new_change")
        )
      )
    );
    return;
  }

  if (model.phase === "limit") {
    renderLimitDialog(dialog, model.limitInfo || getSessionLimitReached());
    return;
  }

  if (model.phase === "loading_template" || !model.spec) {
    dialog.dataset.dialogPhase = "loading";
    dialog.append(
      el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")),
      el("div", { className: "dialog-body" }, busyLine(t("web.sessions.template_loading"))),
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

  dialog.dataset.dialogPhase = "editing";
  const spec = model.spec;
  const blocked = model.submitting || isProvisionRunning();

  const nameInput = el("input", {
    id: "new-session-name",
    type: "text",
    className: "input",
    placeholder: t("app.b2.new_name_placeholder"),
    value: model.nameDraft ?? "",
    disabled: blocked,
    autofocus: true,
    onInput: (event) => {
      model.nameDraft = event.target.value;
    },
  });

  const rows = buildProvisionOptionRows({
    idPrefix: "prov",
    spec,
    disabled: blocked,
    onAcceleratorChange: (nextAcc) => {
      const prevSuggested = model.suggestedName;
      const nextSuggested = makeSuggestedName(nextAcc, prevSuggested);
      if (!model.nameDraft || model.nameDraft === prevSuggested) {
        model.nameDraft = nextSuggested;
      }
      model.suggestedName = nextSuggested;
      renderActiveDialog();
    },
  });

  const accountWarningHost = el("div", { className: "dialog-account-warning" });
  model.accountWarningHost = accountWarningHost;
  renderNewSessionAccountWarning(model);

  const form = el(
    "form",
    {
      className: "dialog-form",
      dataset: { newSessionForm: "true" },
      onSubmit: (event) => {
        event.preventDefault();
        void submitNewSession(model);
      },
    },
    el(
      "div",
      { className: "dialog-body" },
      el("p", { className: "dialog-paragraph" }, t("app.b2.new_intro")),
      accountWarningHost,
      model.formError ? alertBox({ tone: "danger", body: model.formError, live: true }) : null,
      el(
        "div",
        { className: "field-group" },
        el("label", { for: "new-session-name", className: "field-label" }, t("app.b2.new_name")),
        nameInput
      ),
      el("div", { className: "prov-list" }, rows)
    ),
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
          type: "submit",
          className: "btn btn-primary",
          dataset: { newSessionStart: "true" },
          disabled: blocked,
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("play"),
        t("app.b2.new_start")
      )
    )
  );

  dialog.append(el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.new_title")), form);
}

function renderStopDialog(dialog, model) {
  dialog.dataset.dialogKind = "stop";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "confirm";
  const label = formatRuntimeCardLabel(model.runtime);
  const email = formatEmail(model.runtime?.account_email);

  const bodyNodes = [
    el("p", { className: "dialog-paragraph" }, t("app.b2.stop_body", { name: label, email })),
    inlineMessage({ tone: "warning", text: t("app.b2.stop_wiped") }),
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
  }

  dialog.append(
    el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.stop_title")),
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
          dataset: { stopConfirm: "true" },
          disabled: model.submitting,
          onClick: async () => {
            if (model.submitting) return;
            const gen = ++dialogGeneration;
            model.submitting = true;
            model.error = null;
            renderActiveDialog();
            try {
              await stopRuntime(model.runtime.id, {
                label,
                email: model.runtime.account_email,
              });
              if (gen !== dialogGeneration) return;
              announce(t("app.b2.stop_done", { name: label }));
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
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("square"),
        t("app.b2.stop_action")
      )
    )
  );
}

function renderCancelAutoStopDialog(dialog, model) {
  dialog.dataset.dialogKind = "cancel_auto_stop";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "confirm";
  const label = formatRuntimeCardLabel(model.runtime);

  const bodyNodes = [
    inlineMessage({
      tone: "warning",
      text: t("app.b3.cancel_auto_stop_body", { name: label }),
    }),
    el("p", { className: "dialog-paragraph" }, t("app.b3.cancel_auto_stop_rearm")),
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
  }

  dialog.append(
    el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b3.cancel_auto_stop_title")),
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
        t("app.b3.cancel_auto_stop_keep")
      ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn-danger",
          dataset: { cancelAutoStopConfirm: "true" },
          disabled: model.submitting,
          onClick: async () => {
            if (model.submitting) return;
            const gen = ++dialogGeneration;
            model.submitting = true;
            model.error = null;
            renderActiveDialog();
            try {
              await changeAutoStop(model.runtime.id, { kind: "cancel" });
              if (gen !== dialogGeneration) return;
              setNotice({ tone: "warning", message: t("app.b2.auto_stop_cancelled") });
              announce(t("app.b2.auto_stop_cancelled"));
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
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
        t("app.b2.runtime_cancel_auto_stop")
      )
    )
  );
}

function renderAutoStopDialog(dialog, model) {
  dialog.dataset.dialogKind = "auto_stop";
  dialog.dataset.dialogPhase = model.mode;
  const isExtend = model.mode === "extend";
  const label = formatRuntimeCardLabel(model.runtime);
  const titleKey = isExtend ? "web.sessions.auto_stop_extend_title" : "web.sessions.auto_stop_set_title";
  const descKey = isExtend ? "web.sessions.auto_stop_extend_desc" : "web.sessions.auto_stop_set_desc";
  const fieldKey = isExtend ? "web.sessions.auto_stop_extend_by" : "web.sessions.auto_stop_after";

  const bodyNodes = [
    el("p", { className: "dialog-paragraph" }, t(descKey, { name: label })),
    el("p", { className: "dialog-caption" }, t("app.def.max_runtime_hint")),
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
  }
  if (model.validationError) {
    bodyNodes.push(inlineMessage({ tone: "danger", text: model.validationError }));
  }
  bodyNodes.push(
    el(
      "div",
      { className: "field-group" },
      el("span", { className: "field-label" }, t(fieldKey)),
      buildDurationField("auto-stop-duration", model.seconds, (secs) => {
        model.seconds = secs;
      })
    )
  );

  const form = el(
    "form",
    {
      className: "dialog-form",
      onSubmit: async (event) => {
        event.preventDefault();
        if (model.submitting) return;
        if (!model.seconds || model.seconds <= 0) {
          model.validationError = t("web.sessions.auto_stop_duration_required");
          renderActiveDialog();
          return;
        }
        const gen = ++dialogGeneration;
        model.submitting = true;
        model.error = null;
        model.validationError = null;
        renderActiveDialog();
        try {
          const result = await changeAutoStop(model.runtime.id, {
            kind: isExtend ? "extend" : "set",
            seconds: model.seconds,
          });
          if (gen !== dialogGeneration) return;
          const durationText = formatDurationSecs(result?.app_limit_seconds ?? model.seconds);
          const toastTitle = t(isExtend ? "app.b2.extend_done" : "app.b3.auto_stop_set", {
            time: durationText,
          });
          const armed = Boolean(result?.watchdog_armed);
          setNotice({
            tone: armed ? "success" : "warning",
            title: toastTitle,
            message: t(armed ? "app.b2.prov_watchdog" : "app.b2.prov_watchdog_failed"),
          });
          announce(toastTitle);
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
          dataset: { autoStopSubmit: "true" },
          disabled: model.submitting,
          autofocus: true,
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : null,
        t("web.sessions.auto_stop_apply")
      )
    )
  );

  dialog.append(el("h1", { id: TITLE_ID, className: "dialog-title" }, t(titleKey)), form);
}

function renderStopAllDialog(dialog, model) {
  dialog.dataset.dialogKind = "stop_all";
  dialog.dataset.dialogPhase = model.report ? "verified" : model.submitting ? "stopping" : "confirm";

  const runtimesView = state.snapshot?.runtimes;
  const runtimes = Array.isArray(runtimesView?.runtimes) ? runtimesView.runtimes : [];
  const listErrors = Array.isArray(runtimesView?.errors) ? runtimesView.errors : [];
  const watched = runtimes.filter((rt) => {
    const wd = rt?.tracked?.watchdog;
    return Boolean(wd && wd.armed && !wd.cancelled && wd.deadline);
  });
  const unwatched = runtimes.filter((rt) => !watched.includes(rt));
  const ops = Array.isArray(state.snapshot?.operations) ? state.snapshot.operations : [];
  const provisioning = ops.some((entry) => entry?.operation?.kind === "provision");
  const runningPlugin = ops.some((entry) => entry?.operation?.kind === "plugin_run");

  const bodyNodes = [];

  if (model.report) {
    if (model.report.verified) {
      bodyNodes.push(
        alertBox({
          tone: "success",
          title: t("web.sessions.stop_all_verified"),
          body: t("web.sessions.stop_all_web_note"),
          live: true,
        })
      );
    } else {
      const remaining = Array.isArray(model.report.remaining) ? model.report.remaining : [];
      const acctErrors = Array.isArray(model.report.account_errors) ? model.report.account_errors : [];
      const accounts = state.snapshot?.accounts?.accounts || [];
      if (remaining.length > 0) {
        bodyNodes.push(
          inlineMessage({ tone: "danger", text: t("web.sessions.stop_all_remaining") }),
          el(
            "ul",
            { className: "impact-items" },
            remaining.map((item) => {
              const name = formatRuntimeLabel(item.target, runtimes);
              const reason = item.error ? formatApiError(item.error).message : null;
              return el(
                "li",
                null,
                reason ? t("app.b2.quit_stop_failed", { name, why: reason }) : name
              );
            })
          )
        );
      }
      for (const failure of acctErrors) {
        const acct = accounts.find((a) => a.id === failure.account);
        const email = formatEmail(acct?.email);
        bodyNodes.push(
          alertBox({
            tone: "danger",
            title: t("app.b2.sessions_account_failed", { email }),
            body: formatApiError(failure.error).message,
            live: true,
          })
        );
      }
    }

    dialog.append(
      el("h1", { id: TITLE_ID, className: "dialog-title" }, t("web.sessions.stop_all_title")),
      el("div", { className: "dialog-body" }, bodyNodes),
      el(
        "div",
        { className: "modal-actions" },
        !model.report.verified
          ? el(
              "button",
              {
                type: "button",
                className: "btn btn-danger",
                onClick: () => {
                  void runStopAll(model);
                },
              },
              t("app.action.retry")
            )
          : null,
        el(
          "button",
          {
            type: "button",
            className: "btn btn-primary",
            autofocus: true,
            onClick: () => closeDialogNow(),
          },
          t("app.action.close")
        )
      )
    );
    return;
  }

  if (watched.length > 0) {
    bodyNodes.push(
      inlineMessage({
        tone: "info",
        text:
          watched.length === 1
            ? t("app.b2.quit_watched_one")
            : t("app.b2.quit_watched_many", { count: watched.length }),
      })
    );
  }
  if (unwatched.length > 0) {
    bodyNodes.push(
      inlineMessage({
        tone: "warning",
        text:
          unwatched.length === 1
            ? t("app.b2.quit_unwatched_one")
            : t("app.b2.quit_unwatched_many", { count: unwatched.length }),
      })
    );
  }
  if (provisioning) {
    bodyNodes.push(inlineMessage({ tone: "warning", text: t("app.b2.quit_provisioning") }));
  }
  if (runningPlugin) {
    bodyNodes.push(inlineMessage({ tone: "warning", text: t("app.b2.quit_running_plugin") }));
  }
  if (state.snapshot?.runtimes_error) {
    bodyNodes.push(inlineMessage({ tone: "warning", text: t("app.b9.quit_unchecked") }));
  } else if (listErrors.length > 0) {
    bodyNodes.push(inlineMessage({ tone: "warning", text: t("app.b2.quit_unknown") }));
  }

  if (runtimes.length > 0) {
    bodyNodes.push(
      el(
        "ul",
        { className: "stop-all-list" },
        runtimes.map((rt) =>
          el(
            "li",
            { className: "stop-all-item" },
            el(
              "span",
              null,
              t("app.b2.ended_line", {
                name: formatRuntimeCardLabel(rt),
                email: formatEmail(rt.account_email),
              })
            ),
            !rt.managed ? badge(t("app.b2.runtime_unmanaged"), "warning") : null
          )
        )
      )
    );
  }

  bodyNodes.push(
    el("p", { className: "dialog-paragraph" }, t("web.sessions.stop_all_web_note")),
    inlineMessage({ tone: "warning", text: t("app.b3.quit_stop_wiped") })
  );

  if (model.error) {
    bodyNodes.push(
      inlineMessage({
        tone: "danger",
        text: t("app.b9.quit_stop_all_failed", { why: formatApiError(model.error).message }),
      })
    );
  }
  if (model.submitting) {
    bodyNodes.push(busyLine(t("app.b2.quit_stopping")));
  }

  dialog.append(
    el("h1", { id: TITLE_ID, className: "dialog-title" }, t("web.sessions.stop_all_title")),
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
          dataset: { stopAllConfirm: "true" },
          disabled: model.submitting,
          onClick: () => {
            void runStopAll(model);
          },
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("square"),
        t("web.sessions.stop_all_action")
      )
    )
  );
}

async function runStopAll(model) {
  if (!model || model.submitting) return;
  const gen = ++dialogGeneration;
  model.submitting = true;
  model.error = null;
  model.report = null;
  renderActiveDialog();
  try {
    const report = await stopAllRuntimes();
    if (gen !== dialogGeneration || activeDialog !== model) return;
    model.submitting = false;
    model.report = report;
    if (report?.verified) {
      setNotice({ tone: "success", message: t("web.sessions.stop_all_verified") });
      announce(t("web.sessions.stop_all_verified"));
    }
    renderActiveDialog();
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
}

function parsePort(text) {
  const trimmed = String(text || "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const num = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(num) || num < 1 || num > 65535) return null;
  return num;
}

export function resolveForwardPolicy() {
  const policy = state.overview?.forward_policy || null;
  if (policy && typeof policy.all_interfaces_allowed === "boolean") {
    return {
      allInterfacesAllowed: policy.all_interfaces_allowed,
      restriction: policy.restriction || null,
    };
  }
  if (state.overview?.host?.kind === "wsl") {
    return { allInterfacesAllowed: false, restriction: "windows_or_wsl" };
  }
  if (isLoopbackHostname(window.location.hostname)) {
    return { allInterfacesAllowed: false, restriction: "loopback_listener" };
  }
  return { allInterfacesAllowed: true, restriction: null };
}

function renderForwardDialog(dialog, model) {
  dialog.dataset.dialogKind = "forward";
  dialog.dataset.dialogPhase = model.submitting ? "submitting" : "editing";

  const errorNodes = [];
  if (model.error) {
    const formatted = formatApiError(model.error);
    if (formatted.kind === "port_reserved") {
      errorNodes.push(
        inlineMessage({
          tone: "danger",
          text: t("app.err.port_reserved", { port: RESERVED_VM_PORT }),
        })
      );
    } else {
      errorNodes.push(
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
                void submitForwardForm(model);
              },
            },
            t("app.action.retry")
          ),
          live: true,
        })
      );
    }
  } else if (model.validationError) {
    errorNodes.push(inlineMessage({ tone: "danger", text: model.validationError }));
  }

  const remoteInput = el("input", {
    id: "forward-remote-port",
    type: "text",
    inputmode: "numeric",
    className: "input mono",
    value: model.remoteDraft,
    disabled: model.submitting,
    autofocus: true,
    onInput: (event) => {
      const digits = event.target.value.replace(/\D+/g, "");
      if (digits !== event.target.value) {
        event.target.value = digits;
      }
      model.remoteDraft = digits;
    },
  });

  const localInput = el("input", {
    id: "forward-local-port",
    type: "text",
    inputmode: "numeric",
    className: "input mono",
    value: model.localDraft,
    disabled: model.submitting,
    onInput: (event) => {
      const digits = event.target.value.replace(/\D+/g, "");
      if (digits !== event.target.value) {
        event.target.value = digits;
      }
      model.localDraft = digits;
    },
  });

  const healthInput = el("input", {
    id: "forward-health-path",
    type: "text",
    className: "input mono",
    placeholder: t("app.b2.forward_health_placeholder"),
    value: model.healthDraft,
    disabled: model.submitting,
    onInput: (event) => {
      model.healthDraft = event.target.value;
    },
  });

  const bindNoticeHost = el("div", { className: "forward-bind-notices" });
  const loopbackRadio = el("input", {
    type: "radio",
    name: "forward-bind",
    value: "loopback",
    checked: model.bind === "loopback",
    disabled: model.submitting,
    onChange: () => {
      model.bind = "loopback";
      syncBindPolicy();
    },
  });
  const allInterfacesRadio = el("input", {
    type: "radio",
    name: "forward-bind",
    value: "all_interfaces",
    checked: model.bind === "all_interfaces",
    disabled: model.submitting,
    onChange: () => {
      model.bind = "all_interfaces";
      syncBindPolicy();
    },
  });
  const allInterfacesLabel = el(
    "label",
    {
      className: "forward-bind-option",
      dataset: { bindOption: "all_interfaces" },
    },
    allInterfacesRadio,
    el("span", null, t("web.forward.bind_all"))
  );

  const syncBindPolicy = () => {
    const { allInterfacesAllowed, restriction } = resolveForwardPolicy();
    const allInterfacesDisabled = !allInterfacesAllowed;
    if (allInterfacesDisabled && model.bind === "all_interfaces") {
      model.bind = "loopback";
    }
    loopbackRadio.checked = model.bind === "loopback";
    loopbackRadio.disabled = model.submitting;
    allInterfacesRadio.checked = model.bind === "all_interfaces";
    allInterfacesRadio.disabled = model.submitting || allInterfacesDisabled;
    allInterfacesLabel.className = allInterfacesDisabled
      ? "forward-bind-option forward-bind-option-disabled"
      : "forward-bind-option";
    const restrictionText =
      restriction === "windows_or_wsl"
        ? t("web.forward.bind_windows_or_wsl")
        : restriction === "loopback_listener"
          ? t("web.forward.bind_loopback_listener")
          : null;
    if (restrictionText) {
      allInterfacesLabel.title = restrictionText;
    } else {
      allInterfacesLabel.removeAttribute("title");
    }

    clear(bindNoticeHost);
    if (restrictionText) {
      bindNoticeHost.appendChild(inlineMessage({ tone: "info", text: restrictionText }));
    }
    if (model.bind === "all_interfaces") {
      bindNoticeHost.appendChild(
        alertBox({
          tone: "warning",
          body: t("web.forward.downstream_auth"),
        })
      );
    } else {
      bindNoticeHost.appendChild(
        inlineMessage({ tone: "info", text: t("web.forward.server_local") })
      );
    }
  };
  model.syncBindPolicy = syncBindPolicy;
  syncBindPolicy();

  const bindFieldset = el(
    "fieldset",
    { className: "forward-bind-fieldset" },
    el("legend", { className: "field-label" }, t("web.forward.bind_label")),
    el(
      "div",
      { className: "forward-bind-options" },
      el(
        "label",
        { className: "forward-bind-option", dataset: { bindOption: "loopback" } },
        loopbackRadio,
        el("span", null, t("web.forward.bind_loopback"))
      ),
      allInterfacesLabel
    ),
    bindNoticeHost
  );

  const existingHost = el("div", { className: "forward-existing-host" });
  model.existingHost = existingHost;
  renderForwardExistingSection(model);

  const form = el(
    "form",
    {
      className: "dialog-form",
      dataset: { forwardForm: "true" },
      onSubmit: (event) => {
        event.preventDefault();
        void submitForwardForm(model);
      },
    },
    el(
      "div",
      { className: "dialog-body" },
      el("p", { className: "dialog-paragraph" }, t("app.b2.forward_intro", { name: model.session })),
      inlineMessage({ tone: "info", text: t("app.b2.forward_billing_note") }),
      ...errorNodes,
      el(
        "div",
        { className: "forward-ports-row" },
        el(
          "div",
          { className: "field-group forward-port-field" },
          el("label", { for: "forward-remote-port", className: "field-label" }, t("app.b2.forward_remote")),
          remoteInput
        ),
        el(
          "div",
          { className: "field-group forward-port-field" },
          el("label", { for: "forward-local-port", className: "field-label" }, t("app.b2.forward_local")),
          localInput
        )
      ),
      bindFieldset,
      el(
        "div",
        { className: "field-group" },
        el("label", { for: "forward-health-path", className: "field-label" }, t("app.b2.forward_health")),
        healthInput,
        el("span", { className: "field-hint" }, t("app.b2.forward_health_hint"))
      ),
      existingHost
    ),
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
          type: "submit",
          className: "btn btn-primary",
          dataset: { forwardSubmit: "true" },
          disabled: model.submitting,
        },
        model.submitting ? el("span", { className: "spinner", "aria-hidden": "true" }) : icon("link"),
        t("app.b2.forward_action")
      )
    )
  );

  dialog.append(el("h1", { id: TITLE_ID, className: "dialog-title" }, t("app.b2.forward_title")), form);
}

function renderForwardExistingSection(model) {
  const host = model?.existingHost;
  if (!host || !host.isConnected) return;
  clear(host);
  const existing = getForwardsForRuntime(model.runtime);
  if (existing.length === 0) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.append(
    el("div", { className: "field-label" }, t("web.forward.existing_title", { name: model.session })),
    el(
      "div",
      { className: "forward-list" },
      existing.map((item) =>
        renderForwardRow(item, {
          onAfterClose: () => renderForwardExistingSection(model),
        })
      )
    )
  );
}

async function submitForwardForm(model) {
  if (!model || model.submitting) return;
  const remotePort = parsePort(model.remoteDraft);
  const localPort = parsePort(model.localDraft);
  if (remotePort === null || localPort === null) {
    model.error = null;
    model.validationError = t("web.forward.ports_invalid");
    renderActiveDialog();
    return;
  }
  if (remotePort === RESERVED_VM_PORT) {
    model.validationError = null;
    model.error = { error: { kind: "port_reserved", args: { port: String(RESERVED_VM_PORT) } } };
    renderActiveDialog();
    return;
  }
  const healthTrimmed = (model.healthDraft || "").trim();
  if (healthTrimmed && (!healthTrimmed.startsWith("/") || /\s/.test(healthTrimmed))) {
    model.error = null;
    model.validationError = t("web.forward.health_invalid");
    renderActiveDialog();
    return;
  }

  const gen = ++dialogGeneration;
  model.submitting = true;
  model.error = null;
  model.validationError = null;
  renderActiveDialog();

  try {
    await openForward(
      {
        account: model.runtime.id.account,
        session: model.session,
        bind: model.bind,
        local_port: localPort,
        remote_port: remotePort,
        health_path: healthTrimmed || null,
      },
      model.accountContext
    );
    if (gen !== dialogGeneration || activeDialog !== model) return;
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
}

function renderActiveDialog() {
  if (!activeDialog) return;
  const dialog = ensureDialogOpen();
  if (!dialog) return;
  clear(dialog);
  if (activeDialog.kind === "new_session") {
    renderNewSessionDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "stop") {
    renderStopDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "cancel_auto_stop") {
    renderCancelAutoStopDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "auto_stop") {
    renderAutoStopDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "stop_all") {
    renderStopAllDialog(dialog, activeDialog);
  } else if (activeDialog.kind === "forward") {
    renderForwardDialog(dialog, activeDialog);
  }

  clearSlowAnswerTimer();
  if (activeDialog.kind === "new_session" && activeDialog.phase === "running") {
    slowAnswerTimer = window.setInterval(() => {
      if (activeDialog?.kind === "new_session" && state.provision.phase === "running") {
        renderActiveDialog();
      } else {
        clearSlowAnswerTimer();
      }
    }, 10000);
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

function renderNewSessionAccountWarning(model) {
  const host = model?.accountWarningHost;
  if (!host) return;
  clear(host);
  if (accountContextChanged(model.accountContext)) {
    host.appendChild(
      alertBox({
        tone: "warning",
        body: t("web.sessions.account_changed"),
        live: true,
      })
    );
  }
}

async function loadTemplateForDialog(model) {
  const gen = ++dialogGeneration;
  model.phase = "loading_template";
  renderActiveDialog();
  try {
    const spec = await fetchSessionTemplate();
    if (gen !== dialogGeneration || activeDialog !== model) return;
    if (!model.accountContext?.active && state.snapshot?.account) {
      model.accountContext = cloneAccountContext(state.snapshot.account);
    }
    model.spec = spec;
    model.suggestedName = spec.name || makeSuggestedName(spec.accelerator);
    model.nameDraft = model.suggestedName;
    model.phase = "editing";
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

export function initSessionDialogs({ navigate } = {}) {
  navigateFn = navigate || navigateFn;
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
      clearSlowAnswerTimer();
      const prev = activeDialog;
      activeDialog = null;
      clear(dialog);
      if (prev?.kind === "new_session") {
        if (state.provision.phase !== "running") {
          resetProvisionState();
        } else {
          notifyProvisionView();
        }
      }
    });
  }

  subscribe((_, reason) => {
    if (reason === "auth" && !state.authenticated) {
      closeDialogNow();
      return;
    }
    if (!activeDialog) return;

    // Isolate active form inputs from background SSE snapshot re-renders.
    if (activeDialog.kind === "new_session") {
      if (activeDialog.phase === "editing" && reason === "snapshot") {
        renderNewSessionAccountWarning(activeDialog);
        return;
      }
      if (reason === "provision" && activeDialog.phase !== "editing") {
        if (state.provision.phase === "running") {
          activeDialog.phase = "running";
        } else if (state.provision.phase === "ready") {
          activeDialog.phase = "ready";
        } else if (state.provision.phase === "cancelled") {
          activeDialog.phase = "cancelled";
        } else if (state.provision.phase === "failed") {
          activeDialog.phase = "failed";
          activeDialog.error = state.provision.error;
        }
        renderActiveDialog();
      }
      return;
    }

    if (activeDialog.kind === "forward") {
      if (reason === "forwards" || reason === "snapshot") {
        renderForwardExistingSection(activeDialog);
      } else if (reason === "overview" && activeDialog.syncBindPolicy) {
        activeDialog.syncBindPolicy();
      }
      return;
    }

    if (activeDialog.kind === "stop_all" && !activeDialog.submitting && !activeDialog.report && reason === "snapshot") {
      renderActiveDialog();
    }
  });

  onLocaleChange(() => {
    if (activeDialog) {
      renderActiveDialog();
    }
  });
}

export function openNewSessionDialog() {
  initSessionDialogs();
  dialogGeneration += 1;
  if (state.provision.phase === "running") {
    activeDialog = {
      kind: "new_session",
      phase: "running",
      spec: state.provision.spec,
      suggestedName: state.provision.sessionName,
      nameDraft: state.provision.sessionName,
      accountContext: cloneAccountContext(getAccountContext()),
      accountWarningHost: null,
      submitting: false,
      formError: null,
      error: null,
      limitInfo: null,
    };
    renderActiveDialog();
    notifyProvisionView();
    return;
  }

  const limit = getSessionLimitReached();
  if (limit) {
    activeDialog = {
      kind: "new_session",
      phase: "limit",
      spec: null,
      suggestedName: "",
      nameDraft: "",
      accountContext: cloneAccountContext(getAccountContext()),
      accountWarningHost: null,
      submitting: false,
      formError: null,
      error: null,
      limitInfo: limit,
    };
    renderActiveDialog();
    return;
  }

  resetProvisionState();
  const model = {
    kind: "new_session",
    phase: "loading_template",
    spec: null,
    suggestedName: "",
    nameDraft: "",
    accountContext: cloneAccountContext(getAccountContext()),
    accountWarningHost: null,
    submitting: false,
    formError: null,
    error: null,
    limitInfo: null,
  };
  activeDialog = model;
  void loadTemplateForDialog(model);
}

export function openStopRuntimeDialog(runtime) {
  if (!runtime?.id) return;
  initSessionDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "stop",
    runtime,
    submitting: false,
    error: null,
  };
  renderActiveDialog();
}

export function openAutoStopDialog(runtime, mode = "extend") {
  if (!runtime?.id) return;
  initSessionDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "auto_stop",
    runtime,
    mode: mode === "set" ? "set" : "extend",
    seconds: getRearmDurationSecs(),
    submitting: false,
    error: null,
    validationError: null,
  };
  renderActiveDialog();
}

export function openCancelAutoStopDialog(runtime) {
  if (!runtime?.id) return;
  initSessionDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "cancel_auto_stop",
    runtime,
    submitting: false,
    error: null,
  };
  renderActiveDialog();
}

export function openStopAllDialog() {
  initSessionDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "stop_all",
    submitting: false,
    error: null,
    report: null,
  };
  renderActiveDialog();
}

export function openForwardDialog(runtime) {
  if (!runtime?.id?.name) return;
  initSessionDialogs();
  dialogGeneration += 1;
  activeDialog = {
    kind: "forward",
    runtime,
    session: runtime.id.name,
    accountContext: cloneAccountContext(getAccountContext()),
    remoteDraft: String(FORWARD_START_PORT),
    localDraft: String(FORWARD_START_PORT),
    healthDraft: "",
    bind: "loopback",
    submitting: false,
    error: null,
    validationError: null,
    existingHost: null,
  };
  renderActiveDialog();
}
