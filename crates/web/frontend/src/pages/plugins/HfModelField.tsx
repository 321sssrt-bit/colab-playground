import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { ApiError } from "../../lib/api.ts";
import type { TranslateFn } from "../../lib/i18n.ts";
import type { Locale } from "../../lib/types.ts";
import { formatVram } from "../sessions/format.ts";
import { AlertTriangleIcon, SmallAlertIcon } from "../sessions/Icons.tsx";
import {
  buildGgufFitKey,
  fetchHfGgufEstimate,
  formatInteger,
  formatPluginApiError,
  formatScriptBytes,
  isValidHfRepoId,
  planGgufEstimateFetch,
  resolveLocalizedText,
  searchHfModels,
  type HfGgufFitParams,
} from "./api.ts";
import type {
  GgufEstimateRequest,
  GgufFitOptions,
  GgufPreviewData,
  HfModel,
  PluginDeployHfDraft,
  PluginInputSpec,
} from "./types.ts";

export { buildGgufFitKey, type HfGgufFitParams };

const SEARCH_DEBOUNCE_MS = 300;
const REPO_DEBOUNCE_MS = 350;
const FIT_RECALC_DEBOUNCE_MS = 180;
const IME_PROCESS_KEY_CODE = 229;

interface HfModelFieldProps {
  readonly input: PluginInputSpec;
  readonly value: string;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly fitParams: HfGgufFitParams;
  readonly persistedDraft?: PluginDeployHfDraft;
  readonly onPersistDraft?: (draft: PluginDeployHfDraft) => void;
  readonly locale: Locale;
  readonly t: TranslateFn;
  readonly onChange: (nextValue: string) => void;
  readonly onBlur?: () => void;
}

type SearchState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly models: readonly HfModel[] }
  | { readonly kind: "error"; readonly message: string };

type GgufState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly repo: string }
  | { readonly kind: "ready"; readonly data: GgufPreviewData }
  | { readonly kind: "error"; readonly message: string };

function SearchIcon() {
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
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function HfModelField({
  input,
  value,
  error,
  disabled,
  fitParams,
  persistedDraft,
  onPersistDraft,
  locale,
  t,
  onChange,
  onBlur,
}: HfModelFieldProps) {
  const idPrefix = useId();
  const repoInputId = `${idPrefix}-repo`;
  const helpId = `${idPrefix}-help`;
  const errorId = `${idPrefix}-error`;
  const searchInputId = `${idPrefix}-search`;

  const repoInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const tRef = useRef(t);
  tRef.current = t;
  const onPersistDraftRef = useRef(onPersistDraft);
  onPersistDraftRef.current = onPersistDraft;

  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<number | null>(null);
  const searchSeqRef = useRef(0);
  const skipInitialSearchEffectRef = useRef(
    Boolean(persistedDraft?.searchQuery && persistedDraft.searchModels !== null),
  );

  const repoTimerRef = useRef<number | null>(null);
  const ggufAbortRef = useRef<AbortController | null>(null);
  const ggufTimerRef = useRef<number | null>(null);
  const ggufSeqRef = useRef(0);
  const immediateGgufRef = useRef(false);
  const forceRefreshGgufRef = useRef(false);
  const pendingRefreshRepoRef = useRef<string | null>(null);

  const [searchQuery, setSearchQuery] = useState(() => persistedDraft?.searchQuery ?? "");
  const [searchState, setSearchState] = useState<SearchState>(() =>
    persistedDraft?.searchModels !== null && persistedDraft?.searchModels !== undefined
      ? { kind: "ready", models: persistedDraft.searchModels }
      : { kind: "idle" },
  );
  const [activeRepo, setActiveRepo] = useState<string | null>(() => {
    if (persistedDraft?.activeRepo !== undefined) {
      return persistedDraft.activeRepo;
    }
    const trimmed = value.trim();
    return isValidHfRepoId(trimmed) ? trimmed : null;
  });
  const [ggufState, setGgufState] = useState<GgufState>(() =>
    persistedDraft?.ggufPreview
      ? { kind: "ready", data: persistedDraft.ggufPreview }
      : { kind: "idle" },
  );
  const [repoPromptError, setRepoPromptError] = useState<string | null>(null);
  const [manualCheckSeq, setManualCheckSeq] = useState(0);

  const ggufStateRef = useRef(ggufState);
  ggufStateRef.current = ggufState;

  useEffect(() => {
    onPersistDraftRef.current?.({
      searchQuery,
      searchModels: searchState.kind === "ready" ? searchState.models : null,
      activeRepo,
      ggufPreview: ggufState.kind === "ready" ? ggufState.data : null,
    });
  }, [searchQuery, searchState, activeRepo, ggufState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
      if (repoTimerRef.current !== null) {
        window.clearTimeout(repoTimerRef.current);
      }
      if (ggufTimerRef.current !== null) {
        window.clearTimeout(ggufTimerRef.current);
      }
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      ggufAbortRef.current?.abort();
      ggufAbortRef.current = null;
    };
  }, []);

  const executeSearch = useCallback(async (rawQuery: string) => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    const seq = ++searchSeqRef.current;

    const trimmed = rawQuery.trim();
    if (!trimmed) {
      setSearchState({ kind: "idle" });
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchState({ kind: "loading" });

    try {
      const models = await searchHfModels(trimmed, controller.signal);
      if (controller.signal.aborted || !mountedRef.current || seq !== searchSeqRef.current) {
        return;
      }
      setSearchState({ kind: "ready", models });
    } catch (err) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        seq !== searchSeqRef.current ||
        (err instanceof ApiError && err.isAbort)
      ) {
        return;
      }
      setSearchState({ kind: "error", message: formatPluginApiError(err, tRef.current) });
    } finally {
      if (searchAbortRef.current === controller) {
        searchAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (skipInitialSearchEffectRef.current) {
      skipInitialSearchEffectRef.current = false;
      return;
    }
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      searchSeqRef.current += 1;
      setSearchState({ kind: "idle" });
      return;
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      void executeSearch(trimmed);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [searchQuery, executeSearch]);

  useEffect(() => {
    if (repoTimerRef.current !== null) {
      window.clearTimeout(repoTimerRef.current);
      repoTimerRef.current = null;
    }
    const trimmed = value.trim();
    if (!trimmed || !isValidHfRepoId(trimmed)) {
      if (activeRepo !== null) {
        setActiveRepo(null);
      }
      setGgufState({ kind: "idle" });
      return;
    }
    if (trimmed === activeRepo) {
      return;
    }
    repoTimerRef.current = window.setTimeout(() => {
      repoTimerRef.current = null;
      setActiveRepo(trimmed);
    }, REPO_DEBOUNCE_MS);
    return () => {
      if (repoTimerRef.current !== null) {
        window.clearTimeout(repoTimerRef.current);
        repoTimerRef.current = null;
      }
    };
  }, [value, activeRepo]);

  const { accelerator, vramMib, ctx, quant, kv } = fitParams;
  useEffect(() => {
    if (ggufTimerRef.current !== null) {
      window.clearTimeout(ggufTimerRef.current);
      ggufTimerRef.current = null;
    }
    ggufAbortRef.current?.abort();
    ggufAbortRef.current = null;

    if (!activeRepo) {
      ggufSeqRef.current += 1;
      forceRefreshGgufRef.current = false;
      pendingRefreshRepoRef.current = null;
      setGgufState({ kind: "idle" });
      return;
    }

    const immediate = immediateGgufRef.current;
    immediateGgufRef.current = false;
    const explicitRefresh = forceRefreshGgufRef.current;
    forceRefreshGgufRef.current = false;

    const targetRepo = activeRepo;
    if (explicitRefresh) {
      pendingRefreshRepoRef.current = targetRepo;
    } else if (
      pendingRefreshRepoRef.current !== null &&
      pendingRefreshRepoRef.current !== targetRepo
    ) {
      pendingRefreshRepoRef.current = null;
    }
    const forceRefresh = pendingRefreshRepoRef.current === targetRepo;
    const targetFitKey = buildGgufFitKey(targetRepo, {
      accelerator,
      vramMib,
      ctx,
      quant,
      kv,
    });
    const currentGguf = ggufStateRef.current;
    const plan = planGgufEstimateFetch({
      targetRepo,
      targetFitKey,
      currentKind: currentGguf.kind,
      currentRepo:
        currentGguf.kind === "ready"
          ? currentGguf.data.repo
          : currentGguf.kind === "loading"
            ? currentGguf.repo
            : null,
      currentFitKey: currentGguf.kind === "ready" ? currentGguf.data.fitKey : null,
      forceRefresh,
    });

    if (plan.action === "skip") {
      return;
    }

    const delayMs = immediate ? 0 : FIT_RECALC_DEBOUNCE_MS;

    // Keep the current preview visible during backend-cached parameter recalculations to avoid
    // clearing and flickering; only enter loading for a different repo or explicit refresh.
    if (plan.showLoading) {
      setGgufState({ kind: "loading", repo: targetRepo });
    }

    const runFetch = () => {
      const seq = ++ggufSeqRef.current;
      const controller = new AbortController();
      ggufAbortRef.current = controller;

      const fit: GgufFitOptions = {
        ctx,
        ...(vramMib !== null ? { vram_mib: vramMib } : {}),
        ...(kv !== null ? { kv } : {}),
      };
      const request: GgufEstimateRequest = {
        repo: targetRepo,
        ...(accelerator !== null ? { accelerator } : {}),
        fit,
        ...(quant !== null ? { quant } : {}),
        ...(plan.refresh ? { refresh: true } : {}),
      };

      void fetchHfGgufEstimate(request, controller.signal)
        .then((response) => {
          if (controller.signal.aborted || !mountedRef.current || seq !== ggufSeqRef.current) {
            return;
          }
          if (plan.refresh && pendingRefreshRepoRef.current === targetRepo) {
            pendingRefreshRepoRef.current = null;
          }
          setGgufState({
            kind: "ready",
            data: { repo: targetRepo, requestedCtx: ctx, fitKey: targetFitKey, response },
          });
        })
        .catch((err: unknown) => {
          if (
            controller.signal.aborted ||
            !mountedRef.current ||
            seq !== ggufSeqRef.current ||
            (err instanceof ApiError && err.isAbort)
          ) {
            return;
          }
          if (plan.refresh && pendingRefreshRepoRef.current === targetRepo) {
            pendingRefreshRepoRef.current = null;
          }
          setGgufState({ kind: "error", message: formatPluginApiError(err, tRef.current) });
        })
        .finally(() => {
          if (ggufAbortRef.current === controller) {
            ggufAbortRef.current = null;
          }
        });
    };

    if (delayMs === 0) {
      runFetch();
    } else {
      ggufTimerRef.current = window.setTimeout(() => {
        ggufTimerRef.current = null;
        runFetch();
      }, delayMs);
    }

    return () => {
      if (ggufTimerRef.current !== null) {
        window.clearTimeout(ggufTimerRef.current);
        ggufTimerRef.current = null;
      }
      ggufAbortRef.current?.abort();
      ggufAbortRef.current = null;
    };
  }, [activeRepo, accelerator, vramMib, ctx, quant, kv, manualCheckSeq]);

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    if (event.nativeEvent.isComposing || event.keyCode === IME_PROCESS_KEY_CODE) {
      return;
    }
    void executeSearch(searchQuery);
  };

  const handleSelectModel = (repo: string) => {
    if (repoTimerRef.current !== null) {
      window.clearTimeout(repoTimerRef.current);
      repoTimerRef.current = null;
    }
    setRepoPromptError(null);
    immediateGgufRef.current = true;
    forceRefreshGgufRef.current = false;
    onChange(repo);
    setActiveRepo(repo);
    setManualCheckSeq((seq) => seq + 1);
  };

  const handleCheckFiles = () => {
    const trimmed = value.trim();
    if (!isValidHfRepoId(trimmed)) {
      setRepoPromptError(t("web.plugins.hf_repo_required"));
      repoInputRef.current?.focus();
      return;
    }
    if (repoTimerRef.current !== null) {
      window.clearTimeout(repoTimerRef.current);
      repoTimerRef.current = null;
    }
    setRepoPromptError(null);
    immediateGgufRef.current = true;
    forceRefreshGgufRef.current = true;
    setActiveRepo(trimmed);
    setManualCheckSeq((seq) => seq + 1);
  };

  const labelText = resolveLocalizedText(input.label, locale, input.id);
  const helpText = resolveLocalizedText(input.help, locale, "");
  const describedByParts: string[] = [];
  if (helpText) {
    describedByParts.push(helpId);
  }
  if (error) {
    describedByParts.push(errorId);
  }
  const describedBy = describedByParts.length > 0 ? describedByParts.join(" ") : undefined;

  const previewData = ggufState.kind === "ready" ? ggufState.data : null;

  return (
    <div className="field-group" data-plugin-input={input.id} data-plugin-input-kind="hf-model">
      <label className="field-label" htmlFor={repoInputId}>
        {labelText}
        {input.required && <span aria-hidden="true"> *</span>}
      </label>

      <input
        ref={repoInputRef}
        id={repoInputId}
        name={input.id}
        type="text"
        className="input mono"
        value={value}
        required={input.required}
        disabled={disabled}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        aria-invalid={error !== null || repoPromptError !== null ? "true" : undefined}
        aria-describedby={describedBy}
        data-hf-repo-input="true"
        onChange={(event) => {
          setRepoPromptError(null);
          onChange(event.target.value);
        }}
        onBlur={onBlur}
      />

      {helpText && (
        <p className="caption" id={helpId}>
          {helpText}
        </p>
      )}

      {error && (
        <div id={errorId} className="inline-msg inline-msg-danger" role="alert">
          <SmallAlertIcon className="icon-xs icon-danger" />
          <span className="inline-msg-text">{error}</span>
        </div>
      )}

      <div className="well" data-hf-lookup={input.id}>
        <search className="hf-search-bar">
          <label className="visually-hidden" htmlFor={searchInputId}>
            {t("app.b2.hf_search")}
          </label>
          <input
            id={searchInputId}
            name={`${input.id}_hf_query`}
            type="search"
            className="input"
            value={searchQuery}
            placeholder={t("app.b2.hf_search_placeholder")}
            disabled={disabled}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            data-hf-search-input="true"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          <button
            type="button"
            className="btn"
            disabled={disabled || searchState.kind === "loading"}
            data-hf-search-btn="true"
            onClick={() => void executeSearch(searchQuery)}
          >
            <SearchIcon />
            <span>{t("app.b2.hf_search_action")}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled || ggufState.kind === "loading"}
            data-hf-list-files-btn="true"
            onClick={handleCheckFiles}
          >
            {t("app.b2.hf_list_files")}
          </button>
        </search>

        {repoPromptError && (
          <div className="inline-msg inline-msg-warning" role="alert">
            <AlertTriangleIcon className="icon-xs icon-warning" />
            <span className="inline-msg-text">{repoPromptError}</span>
          </div>
        )}

        {searchState.kind === "loading" && (
          <div className="busy-line" role="status" aria-live="polite" data-hf-searching="true">
            <span className="spinner" aria-hidden="true" />
            <span>{t("app.b2.hf_searching")}</span>
          </div>
        )}

        {searchState.kind === "error" && (
          <div className="inline-msg inline-msg-warning" role="alert">
            <AlertTriangleIcon className="icon-xs icon-warning" />
            <span className="inline-msg-text">{searchState.message}</span>
          </div>
        )}

        {searchState.kind === "ready" && searchState.models.length === 0 && (
          <p className="caption" data-hf-no-results="true">
            {t("app.b2.hf_no_results")}
          </p>
        )}

        {searchState.kind === "ready" && searchState.models.length > 0 && (
          <div className="hf-results-list" data-hf-results="true">
            {searchState.models.map((model) => (
              <button
                key={model.id}
                type="button"
                className="hf-result-item"
                disabled={disabled}
                data-hf-result={model.id}
                onClick={() => handleSelectModel(model.id)}
              >
                <span className="hf-result-id">{model.id}</span>
                <span className="hf-result-meta">
                  {t(model.gated ? "app.b2.hf_result_gated" : "app.b2.hf_result", {
                    downloads: formatInteger(model.downloads, locale),
                  })}
                </span>
              </button>
            ))}
          </div>
        )}

        {ggufState.kind === "loading" && (
          <div className="busy-line" role="status" aria-live="polite" data-hf-listing="true">
            <span className="spinner" aria-hidden="true" />
            <span>{t("app.b2.hf_listing")}</span>
          </div>
        )}

        {ggufState.kind === "error" && (
          <div className="inline-msg inline-msg-warning" role="alert" data-hf-gguf-error="true">
            <AlertTriangleIcon className="icon-xs icon-warning" />
            <span className="inline-msg-text">{ggufState.message}</span>
          </div>
        )}

        {previewData !== null && (
          <div className="quant-preview" data-quant-preview={previewData.repo}>
            {previewData.response.listing.variants.length > 0 ? (
              <p className="caption" data-quant-files="true">
                {t("app.b2.quant_files", {
                  list: previewData.response.listing.variants
                    .map(
                      (variant) =>
                        `${variant.quant} (${formatScriptBytes(variant.size, locale, t)})`,
                    )
                    .join(t("app.fmt.list_separator")),
                })}
              </p>
            ) : (
              <p className="caption">{t("app.b2.hf_no_results")}</p>
            )}

            {previewData.response.fits.length === 0 ? (
              <p className="caption" data-quant-no-gpu="true">
                {t("app.b2.quant_no_gpu")}
              </p>
            ) : (
              previewData.response.fits.map((entry) => {
                const gpu = formatVram(entry.vram_mib, locale, t);
                const line = entry.fit
                  ? t(
                      previewData.requestedCtx === 0
                        ? "app.b3.quant_fits_assumed"
                        : "app.b2.quant_fits",
                      {
                        gpu,
                        quant: entry.fit.quant,
                        ctx: formatInteger(entry.fit.ctx, locale),
                        estimate: formatVram(entry.fit.estimate_mib, locale, t),
                      },
                    )
                  : t("app.b2.quant_nothing_fits", { gpu });
                return (
                  <p
                    className="quant-fit-line"
                    key={entry.vram_mib}
                    data-quant-fit={String(entry.vram_mib)}
                  >
                    {line}
                  </p>
                );
              })
            )}

            <p className="caption">{t("app.b2.quant_estimate_note")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
