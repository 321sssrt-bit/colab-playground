/**
 * Dynamic plugin deploy form generated from a plugin's manifest:
 * - Renders all 6 input kinds (`text`, `number` with min/max bounds, `bool`,
 *   `select`, `secret`, and `hf-model` with search + server-computed GGUF fit).
 * - Enforces the secret security invariant: `secret` inputs remain uncontrolled
 *   DOM `<input type="password">` nodes read only at submit time and cleared
 *   immediately before dispatching the request, never entering React state,
 *   stores, snapshots, storage, or logs.
 * - Switches between provisioning a new session (reusing `ProvisionFields`,
 *   concurrent session limit guard, and `stop_on_failure` switch) and running
 *   on an existing active managed runtime, monitoring target loss and active
 *   account switches.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { AlertIcon, InfoIcon } from "../../components/Icons.tsx";
import { apiClient, ApiError } from "../../lib/api.ts";
import {
  CORE_DEFAULTS,
  MAX_VRAM_GIB,
  MIB_PER_GIB,
  MIN_VRAM_GIB,
} from "../../lib/constants.ts";
import { resolveActiveAccount } from "../../lib/format.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { RouteId } from "../../lib/router.ts";
import type {
  AccountContext,
  AccountId,
  Locale,
  Runtime,
  RuntimeRef,
  Snapshot,
} from "../../lib/types.ts";
import type { ProvisionSpec } from "../sessions/api.ts";
import {
  formatEmail,
  formatErrorMessage,
  runtimeKey,
  type FormattedError,
} from "../sessions/format.ts";
import { AlertTriangleIcon, SmallAlertIcon } from "../sessions/Icons.tsx";
import {
  acceleratorIsGpu,
  buildProvisionSpecFromDraft,
  findMeasuredRate,
  MAX_SESSION_NAME_LEN,
  ProvisionFields,
  specToProvisionDraft,
  type ProvisionDraft,
  type ProvisionFieldErrorId,
} from "../sessions/ProvisionFields.tsx";
import { refreshRearmDuration } from "../sessions/store.ts";
import {
  fetchPluginRunTemplate,
  formatPluginApiError,
  getHfTokenStatus,
  isValidHfRepoId,
  resolveLocalizedText,
  startPluginRun,
} from "./api.ts";
import { HfModelField, type HfGgufFitParams } from "./HfModelField.tsx";
import type {
  KvType,
  PluginInfo,
  PluginInputSpec,
  PluginInputValue,
  PluginRunSummary,
  PluginRunTemplateSpec,
  StartPluginRunRequest,
} from "./types.ts";

const MAX_TEXT_LEN = 8192;
const MAX_CTX_U32 = 0xffffffff;
const INTEGER_RE = /^\d+$/;
const INPUT_CTX = "ctx";
const INPUT_QUANT = "quant";
const INPUT_KV = "kv";
const QUANT_AUTO = "auto";

interface SelectedExistingTarget {
  readonly name: string;
  readonly account: AccountId;
  readonly runtime: RuntimeRef;
}

type TargetLost =
  | { readonly kind: "ended"; readonly name: string }
  | { readonly kind: "other_account"; readonly name: string };

export interface PluginDeployFormProps {
  readonly plugin: PluginInfo;
  readonly snapshot: Snapshot | null;
  readonly maxConcurrentSessions: number;
  readonly hfTokenSaved: boolean | null;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly navigate: (route: RouteId) => void;
  readonly onBack: () => void;
  readonly onOpenHfTokenDialog: () => void;
  readonly onHfTokenStatusLoaded: (saved: boolean) => void;
  readonly onRunStarted: (runId: number, summary: PluginRunSummary) => void;
}

function ArrowLeftIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

export function RocketIcon() {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

function parseKvType(value: string | undefined): KvType | null {
  if (value === "f16" || value === "q8_0" || value === "q4_0") {
    return value;
  }
  return null;
}

function parseVramMibForPreview(
  draft: ProvisionDraft,
  baseSpec: ProvisionSpec | null,
): number | null {
  if (!acceleratorIsGpu(draft.accelerator) || !draft.min_vram_enabled) {
    return null;
  }
  const trimmed = draft.min_vram_gib.trim();
  if (baseSpec?.min_vram_mib && baseSpec.min_vram_mib > 0) {
    const initialDraft = specToProvisionDraft(baseSpec);
    if (initialDraft.min_vram_enabled && trimmed === initialDraft.min_vram_gib.trim()) {
      return baseSpec.min_vram_mib;
    }
  }
  if (INTEGER_RE.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isSafeInteger(parsed) && parsed >= MIN_VRAM_GIB && parsed <= MAX_VRAM_GIB) {
      return parsed * MIB_PER_GIB;
    }
  }
  return null;
}

function validateNonSecretInput(
  spec: PluginInputSpec,
  rawText: string,
  boolVal: boolean,
  locale: Locale,
  t: TranslateFn,
): { readonly ok: true; readonly value: PluginInputValue | undefined } | { readonly ok: false; readonly message: string } {
  const fieldLabel = resolveLocalizedText(spec.label, locale, spec.id);
  if (spec.type === "bool") {
    return { ok: true, value: boolVal };
  }

  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    if (spec.required) {
      return { ok: false, message: t("web.plugins.field_required", { field: fieldLabel }) };
    }
    return { ok: true, value: undefined };
  }

  if (spec.type === "number") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { ok: false, message: t("web.plugins.number_invalid", { field: fieldLabel }) };
    }
    const min = spec.min ?? null;
    const max = spec.max ?? null;
    if (min !== null && max !== null && (parsed < min || parsed > max)) {
      return {
        ok: false,
        message: t("web.plugins.number_range", {
          field: fieldLabel,
          min: String(min),
          max: String(max),
        }),
      };
    }
    if (min !== null && parsed < min) {
      return {
        ok: false,
        message: t("web.plugins.number_min", { field: fieldLabel, min: String(min) }),
      };
    }
    if (max !== null && parsed > max) {
      return {
        ok: false,
        message: t("web.plugins.number_max", { field: fieldLabel, max: String(max) }),
      };
    }
    return { ok: true, value: parsed };
  }

  if (spec.type === "select") {
    if (spec.options && spec.options.length > 0 && !spec.options.includes(trimmed)) {
      return { ok: false, message: t("app.err.invalid_input") };
    }
    return { ok: true, value: trimmed };
  }

  if (spec.type === "hf-model") {
    if (!isValidHfRepoId(trimmed)) {
      return { ok: false, message: t("web.plugins.hf_repo_required") };
    }
    return { ok: true, value: trimmed };
  }

  if (rawText.length > MAX_TEXT_LEN || rawText.includes("\0")) {
    return { ok: false, message: t("app.err.invalid_input") };
  }
  return { ok: true, value: trimmed };
}

function isSelectUnsetAllowed(spec: PluginInputSpec): boolean {
  return spec.type === "select" && !spec.required && (spec.default === undefined || spec.default === null);
}

function buildInitialFieldState(
  plugin: PluginInfo,
  template: PluginRunTemplateSpec,
): { readonly texts: Record<string, string>; readonly bools: Record<string, boolean> } {
  const texts: Record<string, string> = {};
  const bools: Record<string, boolean> = {};
  for (const input of plugin.manifest.inputs) {
    if (input.type === "secret") {
      continue;
    }
    const value = Object.hasOwn(template.inputs, input.id)
      ? template.inputs[input.id]
      : (input.default ?? undefined);
    if (input.type === "bool") {
      bools[input.id] = value === true;
    } else if (input.type === "select") {
      texts[input.id] = typeof value === "string" && value.length > 0 ? value : "";
    } else if (input.type === "number") {
      texts[input.id] =
        typeof value === "number" && Number.isFinite(value)
          ? String(value)
          : typeof value === "string"
            ? value
            : "";
    } else {
      texts[input.id] = typeof value === "string" ? value : "";
    }
  }
  return { texts, bools };
}

function countNamedRuntimesOnActiveAccount(snapshot: Snapshot | null): string[] {
  const runtimes = snapshot?.runtimes?.runtimes ?? [];
  const names: string[] = [];
  for (const rt of runtimes) {
    if (rt.on_active_account && rt.id.name) {
      names.push(rt.id.name);
    }
  }
  return names;
}

export function PluginDeployForm({
  plugin,
  snapshot,
  maxConcurrentSessions,
  hfTokenSaved,
  locale,
  t,
  navigate,
  onBack,
  onOpenHfTokenDialog,
  onHfTokenStatusLoaded,
  onRunStarted,
}: PluginDeployFormProps) {
  const idPrefix = useId();
  const targetSelectId = `${idPrefix}-target`;
  const sessionNameId = `${idPrefix}-session-name`;
  const stopOnFailureId = `${idPrefix}-stop-on-failure`;
  const provisionErrorId = `${idPrefix}-provision-error`;

  const formRef = useRef<HTMLFormElement | null>(null);
  const secretInputRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const mountedRef = useRef(true);
  const submitAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  const maxConcurrentRef = useRef(maxConcurrentSessions);
  maxConcurrentRef.current = maxConcurrentSessions;
  const onHfTokenStatusLoadedRef = useRef(onHfTokenStatusLoaded);
  onHfTokenStatusLoadedRef.current = onHfTokenStatusLoaded;

  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [resolvedMaxConcurrent, setResolvedMaxConcurrent] = useState(maxConcurrentSessions);
  const [localTokenChecked, setLocalTokenChecked] = useState(hfTokenSaved !== null);
  const [tokenCheckFailed, setTokenCheckFailed] = useState(false);

  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [boolValues, setBoolValues] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [baseProvisionSpec, setBaseProvisionSpec] = useState<ProvisionSpec | null>(null);
  const [provisionDraft, setProvisionDraft] = useState<ProvisionDraft | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [retryDelaySecs, setRetryDelaySecs] = useState<number>(CORE_DEFAULTS.retry_delay);
  const [provisionInvalidFields, setProvisionInvalidFields] = useState<
    ReadonlySet<ProvisionFieldErrorId>
  >(() => new Set());
  const [stopOnFailure, setStopOnFailure] = useState(true);

  const [selectedExisting, setSelectedExisting] = useState<SelectedExistingTarget | null>(null);
  const [targetLost, setTargetLost] = useState<TargetLost | null>(null);
  const [originAccountContext, setOriginAccountContext] = useState<AccountContext | null>(
    () => snapshot?.account ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<FormattedError | null>(null);

  const clearSecretInputs = useCallback(() => {
    for (const inputEl of secretInputRefs.current.values()) {
      inputEl.value = "";
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitAbortRef.current?.abort();
      submitAbortRef.current = null;
      clearSecretInputs();
    };
  }, [clearSecretInputs]);

  useEffect(() => {
    if (hfTokenSaved !== null) {
      setLocalTokenChecked(true);
      setTokenCheckFailed(false);
    }
  }, [hfTokenSaved]);

  useEffect(() => {
    setResolvedMaxConcurrent(maxConcurrentSessions);
  }, [maxConcurrentSessions]);

  useEffect(() => {
    if (originAccountContext === null && snapshot?.account) {
      setOriginAccountContext(snapshot.account);
    }
  }, [originAccountContext, snapshot?.account]);

  const wantsHfToken = plugin.manifest.needs.includes("hf_token");

  // Load the plugin template, concurrent session limit, and optional HF token presence once per open/retry.
  useEffect(() => {
    const seq = ++loadSeqRef.current;
    const controller = new AbortController();
    const gen = apiClient.getSessionGeneration();

    setLoadPhase("loading");
    setLoadError(null);
    setSubmitError(null);
    setFieldErrors({});
    setProvisionInvalidFields(new Set());
    clearSecretInputs();

    const activePlugin = pluginRef.current;
    const templatePromise = fetchPluginRunTemplate(activePlugin.manifest.id, controller.signal);
    const settingsPromise = refreshRearmDuration(controller.signal)
      .then((res) => res.maxConcurrentSessions)
      .catch(() => maxConcurrentRef.current);

    if (wantsHfToken) {
      void getHfTokenStatus(controller.signal)
        .then((res) => {
          if (
            controller.signal.aborted ||
            !mountedRef.current ||
            seq !== loadSeqRef.current ||
            apiClient.getSessionGeneration() !== gen
          ) {
            return;
          }
          setLocalTokenChecked(true);
          setTokenCheckFailed(false);
          onHfTokenStatusLoadedRef.current(res.saved);
        })
        .catch((err: unknown) => {
          if (
            controller.signal.aborted ||
            !mountedRef.current ||
            seq !== loadSeqRef.current ||
            (err instanceof ApiError && err.isAbort)
          ) {
            return;
          }
          setLocalTokenChecked(true);
          setTokenCheckFailed(true);
        });
    }

    void Promise.all([templatePromise, settingsPromise]).then(
      ([template, cap]) => {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          seq !== loadSeqRef.current ||
          apiClient.getSessionGeneration() !== gen
        ) {
          return;
        }
        const initial = buildInitialFieldState(activePlugin, template);
        setTextValues(initial.texts);
        setBoolValues(initial.bools);
        setStopOnFailure(template.stop_on_failure);
        setResolvedMaxConcurrent(Math.max(1, cap));
        setSelectedExisting(null);
        setTargetLost(null);

        if (template.target.kind === "provision") {
          const { kind: _kind, ...provSpec } = template.target;
          setBaseProvisionSpec(provSpec);
          setProvisionDraft(specToProvisionDraft(provSpec));
          setSessionName(provSpec.name);
          setRetryDelaySecs(provSpec.retry_delay);
        } else {
          const fallbackSpec: ProvisionSpec = {
            name: `${activePlugin.manifest.id}-run`,
            accelerator: CORE_DEFAULTS.accelerator,
            high_mem: CORE_DEFAULTS.high_mem,
            min_vram_mib: CORE_DEFAULTS.min_vram_mib,
            max_attempts: CORE_DEFAULTS.max_attempts,
            retry_delay: CORE_DEFAULTS.retry_delay,
            on_exhausted: CORE_DEFAULTS.on_exhausted,
            guard: {
              max_runtime: CORE_DEFAULTS.max_runtime,
              max_spend_cu: CORE_DEFAULTS.max_spend_cu,
              min_balance_cu: CORE_DEFAULTS.min_balance_cu,
              idle_timeout: CORE_DEFAULTS.idle_timeout,
            },
          };
          setBaseProvisionSpec(fallbackSpec);
          setProvisionDraft(specToProvisionDraft(fallbackSpec));
          setSessionName(fallbackSpec.name);
          setRetryDelaySecs(fallbackSpec.retry_delay);
        }

        setLoadPhase("ready");
      },
      (err: unknown) => {
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          seq !== loadSeqRef.current ||
          (err instanceof ApiError && err.isAbort)
        ) {
          return;
        }
        setLoadError(formatPluginApiError(err, tRef.current));
        setLoadPhase("error");
      },
    );

    return () => {
      controller.abort();
    };
  }, [plugin.manifest.id, reloadSeq, wantsHfToken, clearSecretInputs]);

  // Monitor the picked existing runtime against live snapshots: unpick cleanly if stopped or account switched.
  useEffect(() => {
    if (!selectedExisting || !snapshot) {
      return;
    }
    const activeAccount = snapshot.accounts?.active ?? snapshot.account.active ?? null;
    if (!activeAccount || selectedExisting.account !== activeAccount) {
      setTargetLost({ kind: "other_account", name: selectedExisting.name });
      setSelectedExisting(null);
      return;
    }
    if (
      !snapshot.runtimes ||
      snapshot.runtimes_error !== null ||
      snapshot.runtimes.errors.some((err) => err.account === activeAccount)
    ) {
      return;
    }
    const matched = snapshot.runtimes.runtimes.find(
      (rt) =>
        rt.on_active_account &&
        rt.managed &&
        rt.id.account === selectedExisting.account &&
        rt.id.endpoint === selectedExisting.runtime.endpoint &&
        rt.id.name === selectedExisting.name,
    );
    if (!matched) {
      setTargetLost({ kind: "ended", name: selectedExisting.name });
      setSelectedExisting(null);
    }
  }, [selectedExisting, snapshot]);

  const activeManagedRuntimes = useMemo<readonly Runtime[]>(() => {
    const list = snapshot?.runtimes?.runtimes ?? [];
    return list.filter((rt) => rt.on_active_account && rt.managed && rt.id.name !== null);
  }, [snapshot?.runtimes?.runtimes]);

  const selectedLiveRuntime = useMemo<Runtime | null>(() => {
    if (!selectedExisting) {
      return null;
    }
    return (
      activeManagedRuntimes.find(
        (rt) =>
          rt.id.account === selectedExisting.account &&
          rt.id.endpoint === selectedExisting.runtime.endpoint &&
          rt.id.name === selectedExisting.name,
      ) ?? null
    );
  }, [activeManagedRuntimes, selectedExisting]);

  const hasCtxInput = useMemo(
    () => plugin.manifest.inputs.some((item) => item.id === INPUT_CTX),
    [plugin.manifest.inputs],
  );
  const hasQuantInput = useMemo(
    () => plugin.manifest.inputs.some((item) => item.id === INPUT_QUANT),
    [plugin.manifest.inputs],
  );
  const hasKvInput = useMemo(
    () => plugin.manifest.inputs.some((item) => item.id === INPUT_KV),
    [plugin.manifest.inputs],
  );

  const fitParams = useMemo<HfGgufFitParams>(() => {
    let ctx = 0;
    if (hasCtxInput) {
      const parsed = Number((textValues[INPUT_CTX] ?? "").trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        ctx = Math.min(MAX_CTX_U32, Math.floor(parsed));
      }
    }

    const rawQuant = hasQuantInput ? (textValues[INPUT_QUANT] ?? "").trim() : "";
    const quant = rawQuant.length > 0 && rawQuant !== QUANT_AUTO ? rawQuant : null;
    const kv = hasKvInput ? parseKvType((textValues[INPUT_KV] ?? "").trim()) : null;

    if (selectedExisting !== null) {
      const vramMib =
        selectedLiveRuntime?.tracked?.vram_mib !== null &&
        selectedLiveRuntime?.tracked?.vram_mib !== undefined &&
        selectedLiveRuntime.tracked.vram_mib > 0
          ? selectedLiveRuntime.tracked.vram_mib
          : null;
      const accelerator =
        selectedLiveRuntime?.accelerator ?? selectedLiveRuntime?.tracked?.accelerator ?? null;
      return { accelerator, vramMib, ctx, quant, kv };
    }

    if (!provisionDraft) {
      return { accelerator: null, vramMib: null, ctx, quant, kv };
    }
    return {
      accelerator: provisionDraft.accelerator,
      vramMib: parseVramMibForPreview(provisionDraft, baseProvisionSpec),
      ctx,
      quant,
      kv,
    };
  }, [
    hasCtxInput,
    hasQuantInput,
    hasKvInput,
    textValues,
    selectedExisting,
    selectedLiveRuntime,
    provisionDraft,
    baseProvisionSpec,
  ]);

  const measuredRate = useMemo(
    () =>
      provisionDraft
        ? findMeasuredRate(
            snapshot?.runtimes?.runtimes,
            provisionDraft.accelerator,
            provisionDraft.high_mem,
          )
        : null,
    [snapshot?.runtimes?.runtimes, provisionDraft],
  );

  const currentAccountContext = snapshot?.account ?? null;
  const activeAccount = resolveActiveAccount(snapshot, t);
  const noActiveAccount = currentAccountContext === null || currentAccountContext.active === null;
  const activeAccountSwitched =
    originAccountContext !== null &&
    currentAccountContext !== null &&
    originAccountContext.active !== null &&
    currentAccountContext.active !== null &&
    originAccountContext.active !== currentAccountContext.active;

  const countedSessions = useMemo(() => countNamedRuntimesOnActiveAccount(snapshot), [snapshot]);
  const sessionLimitCap = Math.max(1, resolvedMaxConcurrent);
  const limited =
    selectedExisting === null && !noActiveAccount && countedSessions.length >= sessionLimitCap;

  const shuttingDown = snapshot?.shutting_down === true;
  const hasRunningPluginRun = Boolean(
    snapshot?.operations.some(({ operation }) => operation.kind === "plugin_run"),
  );
  const deployDisabled =
    submitting ||
    shuttingDown ||
    !plugin.enabled ||
    hasRunningPluginRun ||
    limited ||
    noActiveAccount;

  const clearFieldError = (id: string) => {
    setFieldErrors((prev) => {
      if (!Object.hasOwn(prev, id)) {
        return prev;
      }
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (submitError !== null) {
      setSubmitError(null);
    }
  };

  const validateSingleFieldOnBlur = (spec: PluginInputSpec) => {
    if (spec.type === "secret") {
      return;
    }
    const rawText = textValues[spec.id] ?? "";
    if (rawText.trim().length === 0) {
      return;
    }
    const checked = validateNonSecretInput(spec, rawText, boolValues[spec.id] === true, locale, t);
    if (!checked.ok) {
      setFieldErrors((prev) => ({ ...prev, [spec.id]: checked.message }));
    }
  };

  const handleTargetChange = (nextKey: string) => {
    setTargetLost(null);
    setSubmitError(null);
    setProvisionInvalidFields(new Set());
    if (!nextKey) {
      setSelectedExisting(null);
      return;
    }
    const matched = activeManagedRuntimes.find((rt) => runtimeKey(rt.id) === nextKey);
    if (!matched || !matched.id.name) {
      setSelectedExisting(null);
      return;
    }
    setSelectedExisting({
      name: matched.id.name,
      account: matched.id.account,
      runtime: matched.id,
    });
  };

  const focusFirstInvalid = () => {
    window.requestAnimationFrame(() => {
      const first = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      first?.focus();
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loadPhase !== "ready" || !provisionDraft || deployDisabled || !currentAccountContext) {
      return;
    }

    const nextFieldErrors: Record<string, string> = {};
    const builtInputs: Record<string, PluginInputValue> = {};

    for (const input of plugin.manifest.inputs) {
      if (input.type === "secret") {
        // Read plaintext directly from the DOM node only at submit time; never store in state.
        const raw = secretInputRefs.current.get(input.id)?.value ?? "";
        if (raw.trim().length === 0) {
          if (input.required) {
            const fieldLabel = resolveLocalizedText(input.label, locale, input.id);
            nextFieldErrors[input.id] = t("web.plugins.field_required", { field: fieldLabel });
          }
        } else if (raw.length > MAX_TEXT_LEN || raw.includes("\0")) {
          nextFieldErrors[input.id] = t("app.err.invalid_input");
        } else {
          // Preserve exact secret bytes (including leading/trailing whitespace) to match backend contract.
          builtInputs[input.id] = raw;
        }
        continue;
      }

      const checked = validateNonSecretInput(
        input,
        textValues[input.id] ?? "",
        boolValues[input.id] === true,
        locale,
        t,
      );
      if (!checked.ok) {
        nextFieldErrors[input.id] = checked.message;
      } else if (checked.value !== undefined) {
        builtInputs[input.id] = checked.value;
      }
    }

    let requestTarget: StartPluginRunRequest["spec"]["target"];
    let requestExisting: RuntimeRef | null = null;
    let resolvedSessionName = "";
    let nextProvisionInvalid: ReadonlySet<ProvisionFieldErrorId> = new Set();

    if (selectedExisting !== null) {
      if (selectedExisting.account !== currentAccountContext.active) {
        setTargetLost({ kind: "other_account", name: selectedExisting.name });
        setSelectedExisting(null);
        return;
      }
      const liveMatch = activeManagedRuntimes.find(
        (rt) =>
          rt.id.account === selectedExisting.account &&
          rt.id.endpoint === selectedExisting.runtime.endpoint &&
          rt.id.name === selectedExisting.name,
      );
      if (!liveMatch) {
        setTargetLost({ kind: "ended", name: selectedExisting.name });
        setSelectedExisting(null);
        return;
      }
      requestTarget = { kind: "existing", name: selectedExisting.name };
      requestExisting = liveMatch.id;
      resolvedSessionName = selectedExisting.name;
    } else {
      const effectiveName = sessionName.trim() || baseProvisionSpec?.name || "";
      const builtProvision = buildProvisionSpecFromDraft(
        effectiveName,
        provisionDraft,
        retryDelaySecs,
        baseProvisionSpec,
      );
      if (!builtProvision.ok) {
        nextProvisionInvalid = builtProvision.invalidFields;
        requestTarget = { kind: "existing", name: "" };
      } else {
        requestTarget = { kind: "provision", ...builtProvision.spec };
        resolvedSessionName = builtProvision.spec.name;
      }
    }

    if (Object.keys(nextFieldErrors).length > 0 || nextProvisionInvalid.size > 0) {
      setFieldErrors(nextFieldErrors);
      setProvisionInvalidFields(nextProvisionInvalid);
      focusFirstInvalid();
      return;
    }

    const requestPayload: StartPluginRunRequest = {
      account_context: currentAccountContext,
      spec: {
        plugin: plugin.manifest.id,
        inputs: builtInputs,
        target: requestTarget,
        stop_on_failure: stopOnFailure,
      },
      existing: requestExisting,
    };

    // Clear every masked secret input immediately before awaiting network I/O so plaintext never lingers in DOM.
    clearSecretInputs();

    submitAbortRef.current?.abort();
    const controller = new AbortController();
    submitAbortRef.current = controller;
    const gen = apiClient.getSessionGeneration();

    setSubmitting(true);
    setFieldErrors({});
    setProvisionInvalidFields(new Set());
    setSubmitError(null);

    try {
      const accepted = await startPluginRun(requestPayload, controller.signal);
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        apiClient.getSessionGeneration() !== gen
      ) {
        return;
      }
      const summary: PluginRunSummary = {
        id: accepted.id,
        plugin: plugin.manifest.id,
        account: currentAccountContext.active ?? "",
        session: resolvedSessionName,
        provisions: requestExisting === null,
        finished: false,
      };
      onRunStarted(accepted.id, summary);
    } catch (err) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        apiClient.getSessionGeneration() !== gen ||
        (err instanceof ApiError && (err.isAbort || err.isUnauthorized))
      ) {
        return;
      }
      setSubmitting(false);
      setSubmitError(formatErrorMessage(err, t));
    } finally {
      if (submitAbortRef.current === controller) {
        submitAbortRef.current = null;
      }
    }
  };

  const pluginName = resolveLocalizedText(plugin.manifest.name, locale, plugin.manifest.id);
  const pluginDescription = resolveLocalizedText(plugin.manifest.description, locale, "");

  return (
    <>
      <header className="page-header page-header-row">
        <div className="page-header-heading">
          <h1 className="page-title">{pluginName}</h1>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="btn btn-ghost"
            data-plugin-form-back="true"
            disabled={submitting}
            onClick={onBack}
          >
            <ArrowLeftIcon />
            <span>{t("app.b2.action_back")}</span>
          </button>
        </div>
      </header>

      <div className="page-sections" data-plugin-deploy-form={plugin.manifest.id}>
        {pluginDescription && <p className="plugin-form-intro">{pluginDescription}</p>}

        {loadPhase === "loading" && (
          <section className="card">
            <div className="busy-line" role="status" aria-live="polite" data-plugin-form-loading="true">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.plugins.run_loading")}</span>
            </div>
          </section>
        )}

        {loadPhase === "error" && (
          <div className="alert alert-danger" role="alert">
            <span className="alert-icon icon-danger">
              <AlertIcon />
            </span>
            <div className="alert-text">
              <p className="alert-body">{loadError ?? t("app.err.other")}</p>
              <div className="alert-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setReloadSeq((seq) => seq + 1)}
                >
                  {t("app.action.retry")}
                </button>
              </div>
            </div>
          </div>
        )}

        {loadPhase === "ready" && provisionDraft !== null && (
          <form
            ref={formRef}
            className="page-sections"
            method="post"
            noValidate
            onSubmit={(event) => void handleSubmit(event)}
          >
            {plugin.manifest.inputs.length > 0 && (
              <section className="card card-compact" data-plugin-inputs-card="true">
                <div className="card-header">
                  <div className="card-heading">
                    <h2 className="card-title">{t("app.b2.run_inputs")}</h2>
                  </div>
                </div>

                <div className="plugin-fields">
                  {plugin.manifest.inputs.map((input) => {
                    const fieldError = fieldErrors[input.id] ?? null;

                    if (input.type === "hf-model") {
                      return (
                        <HfModelField
                          key={input.id}
                          input={input}
                          value={textValues[input.id] ?? ""}
                          error={fieldError}
                          disabled={submitting}
                          fitParams={fitParams}
                          locale={locale}
                          t={t}
                          onChange={(nextValue) => {
                            setTextValues((prev) => ({ ...prev, [input.id]: nextValue }));
                            clearFieldError(input.id);
                          }}
                          onBlur={() => validateSingleFieldOnBlur(input)}
                        />
                      );
                    }

                    const fieldId = `${idPrefix}-input-${input.id}`;
                    const helpId = `${fieldId}-help`;
                    const secretNoteId = `${fieldId}-secret-note`;
                    const errorId = `${fieldId}-error`;
                    const labelText = resolveLocalizedText(input.label, locale, input.id);
                    const helpText = resolveLocalizedText(input.help, locale, "");

                    const describedByParts: string[] = [];
                    if (helpText) {
                      describedByParts.push(helpId);
                    }
                    if (input.type === "secret") {
                      describedByParts.push(secretNoteId);
                    }
                    if (fieldError) {
                      describedByParts.push(errorId);
                    }
                    const describedBy =
                      describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

                    if (input.type === "bool") {
                      return (
                        <div
                          className="field-group"
                          key={input.id}
                          data-plugin-input={input.id}
                          data-plugin-input-kind="bool"
                        >
                          <label className="switch-label" htmlFor={fieldId}>
                            <input
                              id={fieldId}
                              name={input.id}
                              type="checkbox"
                              role="switch"
                              className="switch-input"
                              checked={boolValues[input.id] === true}
                              disabled={submitting}
                              aria-describedby={describedBy}
                              onChange={(event) => {
                                setBoolValues((prev) => ({
                                  ...prev,
                                  [input.id]: event.target.checked,
                                }));
                                clearFieldError(input.id);
                              }}
                            />
                            <span>{labelText}</span>
                          </label>
                          {helpText && (
                            <p className="caption" id={helpId}>
                              {helpText}
                            </p>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div
                        className="field-group"
                        key={input.id}
                        data-plugin-input={input.id}
                        data-plugin-input-kind={input.type}
                      >
                        <label className="field-label" htmlFor={fieldId}>
                          {labelText}
                          {input.required && <span aria-hidden="true"> *</span>}
                        </label>

                        {input.type === "select" ? (
                          <select
                            id={fieldId}
                            name={input.id}
                            className="select select-inline"
                            value={textValues[input.id] ?? ""}
                            required={input.required}
                            disabled={submitting}
                            aria-invalid={fieldError ? "true" : undefined}
                            aria-describedby={describedBy}
                            onChange={(event) => {
                              setTextValues((prev) => ({
                                ...prev,
                                [input.id]: event.target.value,
                              }));
                              clearFieldError(input.id);
                            }}
                          >
                            {(isSelectUnsetAllowed(input) || (textValues[input.id] ?? "") === "") && (
                              <option value="" disabled={input.required}>
                                {t("select.placeholder")}
                              </option>
                            )}
                            {(input.options ?? []).map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : input.type === "number" ? (
                          <input
                            id={fieldId}
                            name={input.id}
                            type="number"
                            inputMode="decimal"
                            className="input"
                            min={input.min ?? undefined}
                            max={input.max ?? undefined}
                            step="any"
                            value={textValues[input.id] ?? ""}
                            required={input.required}
                            disabled={submitting}
                            aria-invalid={fieldError ? "true" : undefined}
                            aria-describedby={describedBy}
                            onChange={(event) => {
                              setTextValues((prev) => ({
                                ...prev,
                                [input.id]: event.target.value,
                              }));
                              clearFieldError(input.id);
                            }}
                            onBlur={() => validateSingleFieldOnBlur(input)}
                          />
                        ) : input.type === "secret" ? (
                          <input
                            ref={(el) => {
                              if (el) {
                                secretInputRefs.current.set(input.id, el);
                              } else {
                                secretInputRefs.current.delete(input.id);
                              }
                            }}
                            id={fieldId}
                            name={input.id}
                            type="password"
                            className="input mono"
                            autoComplete="new-password"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            required={input.required}
                            disabled={submitting}
                            aria-invalid={fieldError ? "true" : undefined}
                            aria-describedby={describedBy}
                            onInput={() => clearFieldError(input.id)}
                          />
                        ) : (
                          <input
                            id={fieldId}
                            name={input.id}
                            type="text"
                            className="input"
                            value={textValues[input.id] ?? ""}
                            required={input.required}
                            disabled={submitting}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            aria-invalid={fieldError ? "true" : undefined}
                            aria-describedby={describedBy}
                            onChange={(event) => {
                              setTextValues((prev) => ({
                                ...prev,
                                [input.id]: event.target.value,
                              }));
                              clearFieldError(input.id);
                            }}
                            onBlur={() => validateSingleFieldOnBlur(input)}
                          />
                        )}

                        {helpText && (
                          <p className="caption" id={helpId}>
                            {helpText}
                          </p>
                        )}

                        {input.type === "secret" && (
                          <p className="caption" id={secretNoteId}>
                            {t("app.b2.run_secret_note")}
                          </p>
                        )}

                        {fieldError && (
                          <div id={errorId} className="inline-msg inline-msg-danger" role="alert">
                            <SmallAlertIcon className="icon-xs icon-danger" />
                            <span className="inline-msg-text">{fieldError}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {wantsHfToken && localTokenChecked && (
              hfTokenSaved === true ? (
                <div
                  className="inline-msg inline-msg-info"
                  role="status"
                  data-plugin-hf-token="saved"
                >
                  <InfoIcon />
                  <span className="inline-msg-text">{t("app.b2.run_hf_token_sent")}</span>
                </div>
              ) : (
                <div
                  className="alert alert-info"
                  role="status"
                  data-plugin-hf-token={tokenCheckFailed ? "unknown" : "missing"}
                >
                  <span className="alert-icon icon-info">
                    <InfoIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-body">{t("app.b2.run_hf_token_none")}</p>
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={shuttingDown || submitting}
                        data-plugin-open-hf-token="true"
                        onClick={onOpenHfTokenDialog}
                      >
                        {t("web.plugins.manage_token")}
                      </button>
                    </div>
                  </div>
                </div>
              )
            )}

            <section className="card card-compact" data-plugin-target-card="true">
              <div className="card-header">
                <div className="card-heading">
                  <h2 className="card-title">{t("app.b2.run_target")}</h2>
                  <p className="card-desc">{t("app.b2.run_target_hint")}</p>
                </div>
              </div>

              <div className="field-group">
                <label className="visually-hidden" htmlFor={targetSelectId}>
                  {t("app.b2.run_target")}
                </label>
                <select
                  id={targetSelectId}
                  name="run_target"
                  className="select select-inline"
                  value={selectedExisting ? runtimeKey(selectedExisting.runtime) : ""}
                  disabled={submitting}
                  data-plugin-run-target="true"
                  onChange={(event) => handleTargetChange(event.target.value)}
                >
                  <option value="">{t("app.b2.run_target_new")}</option>
                  {activeManagedRuntimes.map((rt) => (
                    <option key={runtimeKey(rt.id)} value={runtimeKey(rt.id)}>
                      {rt.id.name}
                    </option>
                  ))}
                </select>
              </div>

              {targetLost && (
                <div
                  className="inline-msg inline-msg-warning"
                  role="alert"
                  data-plugin-target-lost={targetLost.kind}
                >
                  <AlertTriangleIcon className="icon-xs icon-warning" />
                  <span className="inline-msg-text">
                    {t(
                      targetLost.kind === "ended"
                        ? "app.b2.run_target_ended"
                        : "app.b2.run_target_other_account",
                      { name: targetLost.name },
                    )}
                  </span>
                </div>
              )}

              {noActiveAccount && (
                <div className="alert alert-warning" role="alert" data-plugin-no-account="true">
                  <span className="alert-icon icon-warning">
                    <AlertTriangleIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-body">{t("app.err.no_active_account")}</p>
                  </div>
                </div>
              )}

              {!noActiveAccount && activeAccountSwitched && targetLost?.kind !== "other_account" && (
                <div
                  className="inline-msg inline-msg-info"
                  role="status"
                  data-plugin-account-switched="true"
                >
                  <InfoIcon />
                  <span className="inline-msg-text">
                    {t("app.summary.active", { email: formatEmail(activeAccount.email, t) })}
                  </span>
                </div>
              )}

              {limited && (
                <div className="alert alert-warning" role="alert" data-plugin-run-limit="true">
                  <span className="alert-icon icon-warning">
                    <AlertTriangleIcon />
                  </span>
                  <div className="alert-text">
                    <p className="alert-title">
                      {t("app.b3.new_limit_body", {
                        limit: sessionLimitCap,
                        email: formatEmail(activeAccount.email, t),
                      })}
                    </p>
                    {countedSessions.length > 0 && (
                      <p className="alert-body">
                        {t("app.b3.new_limit_counted", {
                          names: countedSessions.join(t("app.fmt.list_separator")),
                        })}
                      </p>
                    )}
                    <p className="alert-body">{t("app.b3.run_limit_hint")}</p>
                    <div className="alert-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-plugin-limit-settings="true"
                        onClick={() => navigate("settings")}
                      >
                        {t("app.b3.new_open_settings")}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {selectedExisting === null ? (
                <>
                  {provisionInvalidFields.size > 0 && (
                    <div
                      id={provisionErrorId}
                      className="inline-msg inline-msg-danger"
                      role="alert"
                      data-plugin-provision-error="true"
                    >
                      <SmallAlertIcon className="icon-xs icon-danger" />
                      <span className="inline-msg-text">{t("app.err.invalid_input")}</span>
                    </div>
                  )}

                  <div className="field-group">
                    <label className="field-label" htmlFor={sessionNameId}>
                      {t("app.b2.new_name")}
                    </label>
                    <input
                      id={sessionNameId}
                      name="session_name"
                      type="text"
                      className="input"
                      maxLength={MAX_SESSION_NAME_LEN}
                      placeholder={t("app.b2.new_name_placeholder")}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={sessionName}
                      disabled={submitting}
                      aria-invalid={provisionInvalidFields.has("name") ? "true" : undefined}
                      aria-describedby={
                        provisionInvalidFields.has("name") ? provisionErrorId : undefined
                      }
                      data-plugin-session-name="true"
                      onChange={(event) => {
                        setSessionName(event.target.value);
                        if (provisionInvalidFields.has("name")) {
                          setProvisionInvalidFields((prev) => {
                            const next = new Set(prev);
                            next.delete("name");
                            return next;
                          });
                        }
                        if (submitError !== null) {
                          setSubmitError(null);
                        }
                      }}
                    />
                  </div>

                  <ProvisionFields
                    draft={provisionDraft}
                    invalidFields={provisionInvalidFields}
                    disabled={submitting}
                    measuredRate={measuredRate}
                    errorSummaryId={provisionInvalidFields.size > 0 ? provisionErrorId : undefined}
                    locale={locale}
                    t={t}
                    onChange={(nextDraft) => {
                      setProvisionDraft(nextDraft);
                      if (provisionInvalidFields.size > 0) {
                        setProvisionInvalidFields(new Set());
                      }
                      if (submitError !== null) {
                        setSubmitError(null);
                      }
                    }}
                  />

                  <div className="field-group">
                    <label className="switch-label" htmlFor={stopOnFailureId}>
                      <input
                        id={stopOnFailureId}
                        name="stop_on_failure"
                        type="checkbox"
                        role="switch"
                        className="switch-input"
                        data-plugin-stop-on-failure="true"
                        checked={stopOnFailure}
                        disabled={submitting}
                        onChange={(event) => setStopOnFailure(event.target.checked)}
                      />
                      <span>{t("app.b2.run_stop_on_failure")}</span>
                    </label>
                    <p className="caption">
                      {t(
                        stopOnFailure
                          ? "app.b2.run_stop_on_failure_on"
                          : "app.b2.run_stop_on_failure_off",
                      )}
                    </p>
                  </div>
                </>
              ) : (
                <p className="caption" data-plugin-existing-note="true">
                  {t("app.b2.run_existing_note")}
                </p>
              )}
            </section>

            {submitError && (
              <div className="alert alert-danger" role="alert" data-plugin-form-error="true">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-title">{submitError.message}</p>
                  {submitError.hint && <p className="alert-body">{submitError.hint}</p>}
                </div>
              </div>
            )}

            <div className="plugin-submit-row">
              <button
                type="submit"
                className="btn btn-primary"
                data-plugin-run-start="true"
                disabled={deployDisabled}
                aria-busy={submitting || undefined}
              >
                {submitting ? <span className="spinner" aria-hidden="true" /> : <RocketIcon />}
                <span>{t("app.b2.run_start")}</span>
              </button>
              <span className="caption">{t("app.b2.run_start_note")}</span>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
