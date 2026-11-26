/**
 * Plugins page: installed plugin list (built-in and user plugins), enable/disable
 * switches, active/recent plugin run banners, live plugin run detail view with
 * post-failure billing verification and ready Endpoint cards, plus native `<dialog>`
 * flows for Hugging Face token management, install preview, plugin removal, and
 * stopping a still-billing runtime.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon, CheckCircleIcon, InfoIcon, PluginsIcon } from "../components/Icons.tsx";
import { ApiError } from "../lib/api.ts";
import { appDataStore, useAppDataStore } from "../lib/appCache.ts";
import { useForwardsStore } from "../lib/forwards.ts";
import { webStore } from "../lib/store.ts";
import type { PendingOperation, Runtime } from "../lib/types.ts";
import {
  StopRuntimeDialog,
  stopTargetFromRuntime,
  type StopRuntimeDialogRequest,
} from "./sessions/StopRuntimeDialog.tsx";
import {
  formatPluginApiError,
  resolveLocalizedText,
  setPluginEnabled,
} from "./plugins/api.ts";
import { HfTokenDialog } from "./plugins/HfTokenDialog.tsx";
import { InstallPluginDialog } from "./plugins/InstallPluginDialog.tsx";
import { pluginCacheStore, usePluginCacheStore } from "./plugins/pluginCache.ts";
import { PluginDeployForm, RocketIcon } from "./plugins/PluginDeployForm.tsx";
import { PluginRunView } from "./plugins/PluginRunView.tsx";
import { RemovePluginDialog, type RemovePluginTarget } from "./plugins/RemovePluginDialog.tsx";
import {
  canRunPluginAgain,
  closePluginDeployForm,
  openPluginDeployForm,
  openPluginRun,
  refreshPluginRuns,
  setPluginRunsLocale,
  showPluginList,
  usePluginRunsStore,
  verifyPluginRunBilling,
} from "./plugins/runStore.ts";
import type { PluginInfo, PluginRunPhase, PluginRunSummary } from "./plugins/types.ts";
import type { PageProps } from "./types.ts";

export { closePluginDeployForm, openPluginDeployForm };

function isHfTokenBusyInSnapshot(operations: readonly PendingOperation[]): boolean {
  return operations.some(
    ({ operation }) => operation.kind === "domain" && operation.name === "hf_token",
  );
}

function isPluginBusyInSnapshot(id: string, operations: readonly PendingOperation[]): boolean {
  return operations.some(({ operation }) => {
    if (operation.kind === "plugin_run") {
      return operation.plugin === id;
    }
    if (operation.kind === "domain") {
      return (
        operation.key === id &&
        (operation.name === "set_plugin_enabled" || operation.name === "remove_plugin")
      );
    }
    return false;
  });
}

function bannerMetaForRun(
  run: PluginRunSummary,
  knownPhase: PluginRunPhase | undefined,
  pluginName: string,
  t: PageProps["t"],
): { readonly tone: "info" | "success" | "danger"; readonly text: string } {
  const phase: PluginRunPhase | null =
    knownPhase && knownPhase !== "running"
      ? knownPhase
      : run.phase ?? (!run.finished ? "running" : null);
  if (phase === "running") {
    return { tone: "info", text: t("app.b2.run_banner_running", { name: pluginName }) };
  }
  if (phase === "ready") {
    return { tone: "success", text: t("app.b2.run_banner_ready", { name: pluginName }) };
  }
  if (phase === "failed") {
    return { tone: "danger", text: t("app.b2.run_banner_failed", { name: pluginName }) };
  }
  if (phase === "cancelled") {
    return { tone: "info", text: t("app.b2.run_banner_cancelled", { name: pluginName }) };
  }
  return {
    tone: "info",
    text: `${pluginName} · ${t("app.b2.run_on_session", { name: run.session })}`,
  };
}

export function PluginsPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const switchIdPrefix = useId();
  const mountedRef = useRef(true);
  const stopRequestSeqRef = useRef(0);

  const runsState = usePluginRunsStore();
  const pluginCache = usePluginCacheStore();
  const appData = useAppDataStore();
  const forwardsState = useForwardsStore();

  const plugins = pluginCache.plugins;
  const loading = pluginCache.pluginsLoading;
  const loadError = pluginCache.pluginsError
    ? formatPluginApiError(pluginCache.pluginsError, t)
    : null;

  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemovePluginTarget | null>(null);
  const [stopDialogRequest, setStopDialogRequest] = useState<StopRuntimeDialogRequest | null>(null);

  useEffect(() => {
    setPluginRunsLocale(locale);
  }, [locale]);

  const fetchPlugins = useCallback(async () => {
    await pluginCacheStore.refreshPlugins().catch(() => {});
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Stale-while-revalidate: renders cached plugins immediately without loading flash while
    // picking up enable/disable/remove mutations made in another tab.
    void pluginCacheStore.refreshPlugins().catch(() => {});
    void refreshPluginRuns({ autoAttach: true });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Hydrate forward policy once from the global overview cache for ready plugin endpoints.
  const viewingReadyRun =
    runsState.selectedRunId !== null && runsState.activeRun?.phase === "ready";

  useEffect(() => {
    if (!viewingReadyRun) {
      return;
    }
    if (
      appData.overview === null &&
      !appData.overviewLoading &&
      appData.overviewError === null
    ) {
      void appDataStore.ensureOverview().catch(() => {});
    }
  }, [viewingReadyRun, appData.overview, appData.overviewLoading, appData.overviewError]);

  const handleToggleEnabled = async (plugin: PluginInfo, nextEnabled: boolean) => {
    const id = plugin.manifest.id;
    if (togglingIds.has(id)) {
      return;
    }
    setTogglingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    try {
      await setPluginEnabled(id, nextEnabled);
      // Reflect the committed server toggle immediately in the global cache so a transient list
      // refresh failure cannot revert the switch and trap the user from undoing the change.
      pluginCacheStore.setPluginEnabledLocal(id, nextEnabled);
      await fetchPlugins();
      void webStore.refreshSnapshot().catch(() => {});
    } catch (error) {
      if (!mountedRef.current || (error instanceof ApiError && error.isAbort)) {
        return;
      }
      pushToast({
        tone: "danger",
        body: formatPluginApiError(error, t),
      });
    } finally {
      if (mountedRef.current) {
        setTogglingIds((prev) => {
          if (!prev.has(id)) {
            return prev;
          }
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const handleInstalled = (installed: PluginInfo) => {
    const name = resolveLocalizedText(installed.manifest.name, locale, installed.manifest.id);
    pushToast({
      tone: "success",
      body: t("app.b2.plugin_installed", { name }),
    });
    void fetchPlugins();
    void webStore.refreshSnapshot().catch(() => {});
  };

  const handleRemoved = (removed: RemovePluginTarget) => {
    pushToast({
      tone: "success",
      body: t("app.b2.plugin_removed", { name: removed.name }),
    });
    void fetchPlugins();
    void webStore.refreshSnapshot().catch(() => {});
  };

  const handleRequestStopRuntime = useCallback((runtime: Runtime) => {
    const id = ++stopRequestSeqRef.current;
    setStopDialogRequest({
      id,
      ...stopTargetFromRuntime(runtime),
    });
  }, []);

  const handleRetryForwardPolicy = useCallback(() => {
    void appDataStore.refreshOverview().catch(() => {});
  }, []);

  const handleRunStarted = useCallback((runId: number, summary: PluginRunSummary) => {
    openPluginRun(runId, summary);
    void refreshPluginRuns({ autoAttach: false });
    void webStore.refreshSnapshot().catch(() => {});
  }, []);

  const shuttingDown = snapshot?.shutting_down === true;
  const operations = snapshot?.operations ?? [];

  const handleRunAgain = useCallback(
    (pluginId: string) => {
      const target = pluginCacheStore.getPluginById(pluginId);
      if (!canRunPluginAgain(target, shuttingDown)) {
        return;
      }
      openPluginDeployForm(pluginId);
    },
    [shuttingDown],
  );

  const isViewingRunDetail =
    runsState.selectedRunId !== null &&
    runsState.activeRun !== null &&
    runsState.activeRun.id === runsState.selectedRunId;

  const isViewingDeployForm = !isViewingRunDetail && runsState.selectedFormPluginId !== null;

  const activeRunPlugin = isViewingRunDetail
    ? (plugins?.find((item) => item.manifest.id === runsState.activeRun!.plugin) ?? null)
    : null;

  const deployFormPlugin = isViewingDeployForm
    ? (plugins?.find((item) => item.manifest.id === runsState.selectedFormPluginId) ?? null)
    : null;

  return (
    <>
      {isViewingRunDetail && runsState.activeRun ? (
        <PluginRunView
          run={runsState.activeRun}
          plugin={activeRunPlugin}
          snapshot={snapshot}
          billingCheck={runsState.billingChecksByRunId[runsState.activeRun.id]}
          endpointForwardIdsByKey={runsState.endpointForwardIdsByKey}
          forwardAddressesById={forwardsState.addressesById}
          forwardOverlaysById={forwardsState.overlaysById}
          forwardPolicy={appData.overview?.forward_policy ?? null}
          forwardPolicyLoading={appData.overviewLoading}
          forwardPolicyError={appData.overviewError}
          onRetryForwardPolicy={handleRetryForwardPolicy}
          locale={locale}
          t={t}
          navigate={navigate}
          pushToast={pushToast}
          onBack={showPluginList}
          onRequestStopRuntime={handleRequestStopRuntime}
          onRunAgain={handleRunAgain}
        />
      ) : isViewingDeployForm ? (
        deployFormPlugin ? (
          <PluginDeployForm
            key={`${deployFormPlugin.manifest.id}:${runsState.formOpenSeq}`}
            plugin={deployFormPlugin}
            draft={runsState.deployDraft}
            hfTokenState={pluginCache.hfToken}
            snapshot={snapshot}
            maxConcurrentSessions={appData.maxConcurrentSessions}
            locale={locale}
            t={t}
            navigate={navigate}
            onBack={closePluginDeployForm}
            onOpenHfTokenDialog={() => setTokenDialogOpen(true)}
            onRunStarted={handleRunStarted}
          />
        ) : loading && plugins === null ? (
          <>
            <header className="page-header page-header-row">
              <div className="page-header-heading">
                <h1 className="page-title">{t("app.nav.plugins")}</h1>
              </div>
              <div className="page-header-actions">
                <button type="button" className="btn btn-ghost" onClick={closePluginDeployForm}>
                  {t("app.b2.action_back")}
                </button>
              </div>
            </header>
            <div className="page-sections">
              <section className="card">
                <div className="busy-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>{t("app.b2.plugins_loading")}</span>
                </div>
              </section>
            </div>
          </>
        ) : (
          <>
            <header className="page-header page-header-row">
              <div className="page-header-heading">
                <h1 className="page-title">{t("app.nav.plugins")}</h1>
              </div>
              <div className="page-header-actions">
                <button type="button" className="btn btn-ghost" onClick={closePluginDeployForm}>
                  {t("app.b2.action_back")}
                </button>
              </div>
            </header>
            <div className="page-sections">
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-body">{loadError ?? t("app.err.plugin_not_found")}</p>
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={closePluginDeployForm}
                    >
                      {t("app.b2.action_back")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )
      ) : (
        <>
          <header className="page-header page-header-row">
            <div className="page-header-heading">
              <h1 className="page-title">{t("app.nav.plugins")}</h1>
              <p className="page-subtitle">{t("app.plugins.subtitle")}</p>
            </div>
            <div className="page-header-actions">
              <button
                type="button"
                className="btn"
                disabled={shuttingDown}
                onClick={() => setTokenDialogOpen(true)}
              >
                {t("app.b2.hf_token_title")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={shuttingDown}
                onClick={() => setInstallOpen(true)}
              >
                {t("app.b2.plugin_install_title")}
              </button>
            </div>
          </header>

          <div className="page-sections">
            {runsState.runs.length > 0 && (
              <section className="card card-compact" data-plugin-runs-list="true">
                {runsState.runs.map((runSummary) => {
                  const matchedPlugin =
                    plugins?.find((item) => item.manifest.id === runSummary.plugin) ?? null;
                  const pluginName = matchedPlugin
                    ? resolveLocalizedText(
                        matchedPlugin.manifest.name,
                        locale,
                        matchedPlugin.manifest.id,
                      )
                    : runSummary.plugin;
                  const meta = bannerMetaForRun(
                    runSummary,
                    runsState.knownPhasesById[runSummary.id],
                    pluginName,
                    t,
                  );
                  const msgClass =
                    meta.tone === "success"
                      ? "inline-msg inline-msg-success"
                      : meta.tone === "danger"
                        ? "inline-msg inline-msg-danger"
                        : "inline-msg inline-msg-info";

                  return (
                    <div
                      className="plugin-run-banner"
                      key={runSummary.id}
                      data-plugin-run-banner={String(runSummary.id)}
                    >
                      <div className="plugin-run-banner-msg">
                        <div className={msgClass}>
                          {meta.tone === "success" ? (
                            <CheckCircleIcon />
                          ) : meta.tone === "danger" ? (
                            <AlertIcon />
                          ) : (
                            <InfoIcon />
                          )}
                          <span className="inline-msg-text">{meta.text}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-plugin-run-show={String(runSummary.id)}
                        onClick={() => openPluginRun(runSummary.id, runSummary)}
                      >
                        {t("app.b2.action_show")}
                      </button>
                    </div>
                  );
                })}
              </section>
            )}

            {loading && plugins === null ? (
              <section className="card">
                <div className="busy-line" role="status" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <span>{t("app.b2.plugins_loading")}</span>
                </div>
              </section>
            ) : loadError !== null && plugins === null ? (
              <div className="alert alert-danger" role="alert">
                <span className="alert-icon icon-danger">
                  <AlertIcon />
                </span>
                <div className="alert-text">
                  <p className="alert-body">{loadError}</p>
                  <div className="alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => void fetchPlugins()}
                    >
                      {t("app.action.retry")}
                    </button>
                  </div>
                </div>
              </div>
            ) : plugins !== null && plugins.length === 0 ? (
              <section className="card">
                <div className="empty-state">
                  <div className="empty-state-disc" aria-hidden="true">
                    <PluginsIcon />
                  </div>
                  <div className="empty-state-words">
                    <h2 className="empty-state-title">{t("web.plugins.empty_title")}</h2>
                    <p className="empty-state-body">{t("web.plugins.empty_body")}</p>
                  </div>
                  <div className="empty-state-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={shuttingDown}
                      onClick={() => setInstallOpen(true)}
                    >
                      {t("app.b2.plugin_install_title")}
                    </button>
                  </div>
                </div>
              </section>
            ) : (
              <>
                {loadError !== null && (
                  <div className="alert alert-danger" role="alert">
                    <span className="alert-icon icon-danger">
                      <AlertIcon />
                    </span>
                    <div className="alert-text">
                      <p className="alert-body">{loadError}</p>
                      <div className="alert-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void fetchPlugins()}
                        >
                          {t("app.action.retry")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {plugins?.map((plugin) => {
                  const id = plugin.manifest.id;
                  const name = resolveLocalizedText(plugin.manifest.name, locale, id);
                  const description = resolveLocalizedText(plugin.manifest.description, locale, "");
                  const bundled = plugin.source.kind === "bundled";
                  const busy =
                    shuttingDown || togglingIds.has(id) || isPluginBusyInSnapshot(id, operations);
                  const switchId = `${switchIdPrefix}-enabled-${id}`;
                  const removeNoteId = `${switchIdPrefix}-remove-note-${id}`;

                  return (
                    <article className="card plugin-card" key={id}>
                      <div className="plugin-card-title-row">
                        <h2 className="plugin-card-name">{name}</h2>
                        <span className="caption">
                          {t("app.b2.plugin_version_short", { version: plugin.manifest.version })}
                        </span>
                        {bundled && (
                          <span className="badge badge-info">{t("app.b2.plugin_built_in")}</span>
                        )}
                        {!plugin.enabled && <span className="badge">{t("app.b2.plugin_off")}</span>}
                      </div>

                      {description && <p className="card-desc">{description}</p>}

                      <div className="plugin-card-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!plugin.enabled || busy}
                          data-plugin-deploy={id}
                          onClick={() => openPluginDeployForm(id)}
                        >
                          <RocketIcon />
                          <span>{t("app.b2.deploy_action")}</span>
                        </button>

                        <label className="switch-label" htmlFor={switchId}>
                          <input
                            id={switchId}
                            type="checkbox"
                            role="switch"
                            className="switch-input"
                            checked={plugin.enabled}
                            disabled={busy}
                            onChange={(event) => {
                              void handleToggleEnabled(plugin, event.target.checked);
                            }}
                          />
                          <span>{t("app.b2.plugin_enabled")}</span>
                        </label>

                        {bundled ? (
                          <>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled
                              title={t("app.b2.plugin_built_in_remove")}
                              aria-describedby={removeNoteId}
                            >
                              {t("app.b2.action_remove")}
                            </button>
                            <span className="caption" id={removeNoteId}>
                              {t("app.b2.plugin_built_in_remove")}
                            </span>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={busy}
                            onClick={() => setRemoveTarget({ id, name })}
                          >
                            {t("app.b2.action_remove")}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
          </div>
        </>
      )}

      <HfTokenDialog
        open={tokenDialogOpen}
        t={t}
        disabled={shuttingDown || isHfTokenBusyInSnapshot(operations)}
        onClose={() => setTokenDialogOpen(false)}
      />

      <InstallPluginDialog
        open={installOpen}
        locale={locale}
        t={t}
        onClose={() => setInstallOpen(false)}
        onInstalled={handleInstalled}
      />

      <RemovePluginDialog
        target={removeTarget}
        t={t}
        onClose={() => setRemoveTarget(null)}
        onRemoved={handleRemoved}
      />

      <StopRuntimeDialog
        request={stopDialogRequest}
        t={t}
        pushToast={pushToast}
        onClose={() => setStopDialogRequest(null)}
        onStopped={() => {
          if (runsState.selectedRunId !== null) {
            void verifyPluginRunBilling(runsState.selectedRunId, { force: true });
          }
        }}
      />
    </>
  );
}
