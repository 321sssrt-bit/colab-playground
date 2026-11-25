/**
 * Plugins management page: installed plugin list (built-in and user plugins),
 * enable/disable switches, empty state, and native `<dialog>` install preview
 * and removal confirmation flows.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { AlertIcon, PluginsIcon } from "../components/Icons.tsx";
import { ApiError } from "../lib/api.ts";
import { webStore } from "../lib/store.ts";
import type { PendingOperation } from "../lib/types.ts";
import {
  formatPluginApiError,
  listPlugins,
  resolveLocalizedText,
  setPluginEnabled,
} from "./plugins/api.ts";
import { InstallPluginDialog } from "./plugins/InstallPluginDialog.tsx";
import { RemovePluginDialog, type RemovePluginTarget } from "./plugins/RemovePluginDialog.tsx";
import type { PluginInfo } from "./plugins/types.ts";
import type { PageProps } from "./types.ts";

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

export function PluginsPage({ snapshot, locale, t, pushToast }: PageProps) {
  const switchIdPrefix = useId();
  const loadAbortRef = useRef<AbortController | null>(null);
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const [plugins, setPlugins] = useState<readonly PluginInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [togglingIds, setTogglingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [installOpen, setInstallOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemovePluginTarget | null>(null);

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
    return () => {
      mountedRef.current = false;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, [fetchPlugins]);

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

  const shuttingDown = snapshot?.shutting_down === true;
  const operations = snapshot?.operations ?? [];

  return (
    <>
      <header className="page-header page-header-row">
        <div className="page-header-heading">
          <h1 className="page-title">{t("app.nav.plugins")}</h1>
          <p className="page-subtitle">{t("app.plugins.subtitle")}</p>
        </div>
        <div className="page-header-actions">
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
    </>
  );
}
