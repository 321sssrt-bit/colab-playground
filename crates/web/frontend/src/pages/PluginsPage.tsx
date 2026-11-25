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
import { webStore } from "../lib/store.ts";
import type { PendingOperation, Runtime } from "../lib/types.ts";
import {
  StopRuntimeDialog,
  stopTargetFromRuntime,
  type StopRuntimeDialogRequest,
} from "./sessions/StopRuntimeDialog.tsx";
import { refreshOverviewHints, useSessionsLocalState } from "./sessions/store.ts";
import {
  formatPluginApiError,
  listPlugins,
  resolveLocalizedText,
  setPluginEnabled,
} from "./plugins/api.ts";
import { HfTokenDialog } from "./plugins/HfTokenDialog.tsx";
import { InstallPluginDialog } from "./plugins/InstallPluginDialog.tsx";
import { PluginRunView } from "./plugins/PluginRunView.tsx";
import { RemovePluginDialog, type RemovePluginTarget } from "./plugins/RemovePluginDialog.tsx";
import {
  applyPluginForwardEvent,
  openPluginRun,
  refreshPluginForwards,
  refreshPluginRuns,
  showPluginList,
  syncPluginSnapshotVersion,
  usePluginRunsStore,
} from "./plugins/runStore.ts";
import type { PluginInfo, PluginRunPhase, PluginRunSummary } from "./plugins/types.ts";
import type { PageProps } from "./types.ts";

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
  const phase: PluginRunPhase | null = !run.finished ? "running" : (knownPhase ?? null);
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
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const stopRequestSeqRef = useRef(0);
  const toastedReadyRunIdRef = useRef<number | null>(null);

  const runsState = usePluginRunsStore();
  const sessionsLocal = useSessionsLocalState();

  const [plugins, setPlugins] = useState<readonly PluginInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemovePluginTarget | null>(null);
  const [stopDialogRequest, setStopDialogRequest] = useState<StopRuntimeDialogRequest | null>(null);
  const [billingRecheckSeq, setBillingRecheckSeq] = useState(0);

  const fetchPlugins = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const seq = ++loadSeqRef.current;

    setLoading(true);
    setLoadError(null);

    try {
      const items = await listPlugins(controller.signal);
      if (controller.signal.aborted || !mountedRef.current || seq !== loadSeqRef.current) {
        return;
      }
      setPlugins(items);
      setLoadError(null);
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        seq !== loadSeqRef.current ||
        (error instanceof ApiError && error.isAbort)
      ) {
        return;
      }
      setLoadError(formatPluginApiError(error, t));
    } finally {
      if (mountedRef.current && seq === loadSeqRef.current) {
        setLoading(false);
      }
      if (loadAbortRef.current === controller) {
        loadAbortRef.current = null;
      }
    }
  }, [t]);

  useEffect(() => {
    mountedRef.current = true;
    void fetchPlugins();
    void refreshPluginRuns({ autoAttach: true });
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, [fetchPlugins]);

  // Keep live SSE forward state/health transitions synchronized while viewing Plugins.
  useEffect(() => {
    if (snapshot) {
      syncPluginSnapshotVersion(snapshot.version);
    }
  }, [snapshot?.version]);

  useEffect(() => {
    return webStore.subscribeForwards((event) => {
      applyPluginForwardEvent(event);
    });
  }, []);

  const prevPluginRunOpIdsRef = useRef("");

  // Refresh `/api/plugins/runs` whenever a `plugin_run` operation starts or finishes in the live snapshot.
  const pluginRunOpIds = (snapshot?.operations ?? [])
    .filter(({ operation }) => operation.kind === "plugin_run")
    .map((op) => op.id)
    .join(",");

  useEffect(() => {
    const prevIds = prevPluginRunOpIdsRef.current;
    prevPluginRunOpIdsRef.current = pluginRunOpIds;
    if (pluginRunOpIds) {
      const ids = pluginRunOpIds.split(",").map(Number);
      const hasUnknownRun = ids.some((id) => !runsState.runs.some((run) => run.id === id));
      if (hasUnknownRun) {
        void refreshPluginRuns({ autoAttach: true });
      }
    } else if (prevIds) {
      void refreshPluginRuns({ autoAttach: false });
    }
  }, [pluginRunOpIds, runsState.runs]);

  // Hydrate forward policy and server-validated forward addresses for ready plugin endpoints.
  const viewingReadyRun =
    runsState.selectedRunId !== null && runsState.activeRun?.phase === "ready";
  const tunnelIdsKey = (snapshot?.tunnels ?? []).map((item) => item.id).join(",");

  useEffect(() => {
    if (!viewingReadyRun) {
      return;
    }
    if (
      sessionsLocal.forwardPolicy === null &&
      !sessionsLocal.forwardPolicyLoading &&
      sessionsLocal.forwardPolicyError === null
    ) {
      void refreshOverviewHints().catch(() => {});
    }
    const tunnels = snapshot?.tunnels ?? [];
    const missingAddresses = tunnels.some((fw) => !runsState.forwardAddressesById[fw.id]);
    if (missingAddresses) {
      void refreshPluginForwards().catch(() => {});
    }
  }, [
    viewingReadyRun,
    tunnelIdsKey,
    sessionsLocal.forwardPolicy,
    sessionsLocal.forwardPolicyLoading,
    sessionsLocal.forwardPolicyError,
    runsState.forwardAddressesById,
    snapshot?.tunnels,
  ]);

  // Announce live completion once per run when transitioning to `ready`.
  const activeRun = runsState.activeRun;
  useEffect(() => {
    if (
      activeRun &&
      activeRun.phase === "ready" &&
      activeRun.finishedLive &&
      toastedReadyRunIdRef.current !== activeRun.id
    ) {
      toastedReadyRunIdRef.current = activeRun.id;
      const matched = plugins?.find((item) => item.manifest.id === activeRun.plugin) ?? null;
      const name = matched
        ? resolveLocalizedText(matched.manifest.name, locale, matched.manifest.id)
        : activeRun.plugin;
      pushToast({
        tone: "success",
        body: t("app.b2.run_ready_toast", { name }),
      });
    }
  }, [activeRun, plugins, locale, t, pushToast]);

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
      if (!mountedRef.current) {
        return;
      }
      // Reflect the committed server toggle immediately so a transient list refresh failure
      // cannot revert the switch and trap the user from undoing the change.
      setPlugins((prev) =>
        prev === null
          ? null
          : prev.map((item) =>
              item.manifest.id === id ? { ...item, enabled: nextEnabled } : item,
            ),
      );
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
    void refreshOverviewHints().catch(() => {});
  }, []);

  const shuttingDown = snapshot?.shutting_down === true;
  const operations = snapshot?.operations ?? [];

  const isViewingRunDetail =
    runsState.selectedRunId !== null &&
    runsState.activeRun !== null &&
    runsState.activeRun.id === runsState.selectedRunId;

  const activeRunPlugin = isViewingRunDetail
    ? (plugins?.find((item) => item.manifest.id === runsState.activeRun!.plugin) ?? null)
    : null;

  return (
    <>
      {isViewingRunDetail && runsState.activeRun ? (
        <PluginRunView
          run={runsState.activeRun}
          plugin={activeRunPlugin}
          snapshot={snapshot}
          forwardAddressesById={runsState.forwardAddressesById}
          forwardOverlaysById={runsState.forwardOverlaysById}
          forwardPolicy={sessionsLocal.forwardPolicy}
          forwardPolicyLoading={sessionsLocal.forwardPolicyLoading}
          forwardPolicyError={sessionsLocal.forwardPolicyError}
          onRetryForwardPolicy={handleRetryForwardPolicy}
          billingRecheckSeq={billingRecheckSeq}
          locale={locale}
          t={t}
          navigate={navigate}
          pushToast={pushToast}
          onBack={showPluginList}
          onRequestStopRuntime={handleRequestStopRuntime}
        />
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
          setBillingRecheckSeq((prev) => prev + 1);
        }}
      />
    </>
  );
}
