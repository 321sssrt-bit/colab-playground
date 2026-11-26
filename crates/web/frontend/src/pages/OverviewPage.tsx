/**
 * Overview route: four-step environment readiness checklist with streaming
 * Colab CLI installer when setup is incomplete, transitioning to the active
 * account compute-unit summary, unmanaged runtime warning, and enabled-plugin
 * quick-deploy cards once ready.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  appDataStore,
  isAccountChangeBlocked,
  resolveEffectiveOverview,
  useAppDataStore,
} from "../lib/appCache.ts";
import { useUsageClockSecs } from "../lib/format.ts";
import { webStore } from "../lib/store.ts";
import { formatApiError } from "./accounts/model.ts";
import { deriveChecklist, findRunningInstallOp } from "./overview/api.ts";
import { ChecklistCard } from "./overview/ChecklistCard.tsx";
import { QuickDeploySection } from "./overview/QuickDeploySection.tsx";
import { SummaryCard } from "./overview/SummaryCard.tsx";
import { listPlugins } from "./plugins/api.ts";
import { openPluginDeployForm } from "./plugins/runStore.ts";
import type { PluginInfo } from "./plugins/types.ts";
import type { PageProps } from "./types.ts";

export function OverviewPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const nowSecs = useUsageClockSecs();
  const appData = useAppDataStore();

  const [plugins, setPlugins] = useState<readonly PluginInfo[]>([]);

  const pluginsSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const activePluginsControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activePluginsControllerRef.current?.abort();
      activePluginsControllerRef.current = null;
    };
  }, []);

  // Ensure the host probe runs once per session; cached results survive route switches
  // and live SSE snapshots update accounts, usage, and keyring state without re-probing.
  useEffect(() => {
    void appDataStore.ensureOverview().catch(() => {});
  }, []);

  const handleCheckAgain = useCallback(async () => {
    try {
      await appDataStore.refreshOverview();
    } catch {
      // Failure state is captured in `appDataStore.overviewError`.
    }
    try {
      await webStore.refreshSnapshot();
    } catch {
      // SSE reconnect banner surfaces transport failures.
    }
  }, []);

  const handleInstallSucceeded = useCallback(async () => {
    await handleCheckAgain();
  }, [handleCheckAgain]);

  const handleRefreshUsage = useCallback(async () => {
    try {
      await appDataStore.refreshUsage();
    } catch {
      // Failure state is captured in `appDataStore.usageRefreshError`.
    }
  }, []);

  const handleAdoptAccount = useCallback(async () => {
    try {
      await appDataStore.adoptAccount();
    } catch {
      // Failure state is captured in `appDataStore.adoptError`.
    }
  }, []);

  const loadPlugins = useCallback(async (signal: AbortSignal) => {
    activePluginsControllerRef.current?.abort();
    const controller = new AbortController();
    activePluginsControllerRef.current = controller;

    const onExternalAbort = () => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const seq = ++pluginsSeqRef.current;
    try {
      const items = await listPlugins(controller.signal);
      if (!mountedRef.current || seq !== pluginsSeqRef.current) {
        return;
      }
      setPlugins(items);
    } catch {
      // Quick-deploy cards are secondary to the ready summary; hide quietly on failure.
    } finally {
      signal.removeEventListener("abort", onExternalAbort);
      if (activePluginsControllerRef.current === controller) {
        activePluginsControllerRef.current = null;
      }
    }
  }, []);

  const handleQuickDeploy = useCallback(
    (pluginId: string) => {
      openPluginDeployForm(pluginId);
      navigate("plugins");
    },
    [navigate],
  );

  const overview = useMemo(
    () => resolveEffectiveOverview(appData.overview, snapshot),
    [appData.overview, snapshot],
  );
  const probeError = useMemo(
    () => (appData.overviewError !== null ? formatApiError(appData.overviewError, t) : null),
    [appData.overviewError, t],
  );
  const usageRefreshError = useMemo(
    () =>
      appData.usageRefreshError !== null ? formatApiError(appData.usageRefreshError, t) : null,
    [appData.usageRefreshError, t],
  );
  const adoptError = useMemo(
    () => (appData.adoptError !== null ? formatApiError(appData.adoptError, t) : null),
    [appData.adoptError, t],
  );
  const probing = appData.overviewLoading || (overview === null && probeError === null);
  const refreshingUsage = appData.refreshingUsage;
  const adopting = appData.adopting;

  const runningInstallOp = useMemo(() => findRunningInstallOp(snapshot), [snapshot]);
  const checklist = useMemo(
    () => deriveChecklist(overview, probeError, probing, runningInstallOp !== null),
    [overview, probeError, probing, runningInstallOp],
  );
  const ready = checklist.complete && overview !== null;
  const snapshotVersion = snapshot?.version ?? -1;
  const accountChangeBlocked = isAccountChangeBlocked(snapshot, appData);
  const shuttingDown = snapshot?.shutting_down === true;

  // Reload plugins when entering ready state and whenever the monotonic snapshot version
  // advances (including cross-tab plugin catalog changes and SSE reconnect convergence).
  useEffect(() => {
    if (!ready) {
      activePluginsControllerRef.current?.abort();
      activePluginsControllerRef.current = null;
      pluginsSeqRef.current += 1;
      setPlugins([]);
      return;
    }
    const controller = new AbortController();
    void loadPlugins(controller.signal);
    return () => {
      controller.abort();
    };
  }, [loadPlugins, ready, snapshotVersion]);

  const initialLoading =
    overview === null && probeError === null && probing && runningInstallOp === null;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.overview")}</h1>
        <p className="page-subtitle">{t("app.overview.subtitle")}</p>
      </header>

      <div className="page-sections">
        {initialLoading ? (
          <section className="card">
            <div className="busy-line" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <span>{t("web.overview.loading")}</span>
            </div>
          </section>
        ) : ready ? (
          <>
            <SummaryCard
              overview={overview}
              snapshot={snapshot}
              nowSecs={nowSecs}
              locale={locale}
              refreshingUsage={refreshingUsage}
              usageRefreshError={usageRefreshError}
              shuttingDown={shuttingDown}
              t={t}
              navigate={navigate}
              onRefreshUsage={handleRefreshUsage}
            />
            <QuickDeploySection
              plugins={plugins}
              locale={locale}
              shuttingDown={shuttingDown}
              t={t}
              onDeploy={handleQuickDeploy}
            />
          </>
        ) : (
          <ChecklistCard
            overview={overview}
            checklist={checklist}
            probeError={probeError}
            probing={probing}
            runningInstallOp={runningInstallOp}
            adopting={adopting}
            adoptError={adoptError}
            accountChangeBlocked={accountChangeBlocked}
            shuttingDown={shuttingDown}
            t={t}
            navigate={navigate}
            pushToast={pushToast}
            onCheckAgain={handleCheckAgain}
            onAdoptAccount={handleAdoptAccount}
            onInstallSucceeded={handleInstallSucceeded}
          />
        )}
      </div>
    </>
  );
}
