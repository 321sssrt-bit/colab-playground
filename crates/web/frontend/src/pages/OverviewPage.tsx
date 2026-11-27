/**
 * Overview route: upstream three-step environment readiness checklist with
 * persistent streaming/replaying Colab CLI installer when setup is incomplete,
 * transitioning to the active account compute-unit summary and bundled-plugin
 * quick-deploy cards once ready, while surfacing unmanaged billing runtime
 * warnings in both states.
 */

import { useCallback, useEffect, useMemo } from "react";

import { ApiError } from "../lib/api.ts";
import {
  appDataStore,
  isAccountChangeBlocked,
  resolveEffectiveOverview,
  useAppDataStore,
} from "../lib/appCache.ts";
import { useUsageClockSecs } from "../lib/format.ts";
import { webStore } from "../lib/store.ts";
import type { ErrorKind } from "../lib/types.ts";
import { formatApiError } from "./accounts/model.ts";
import {
  buildOverviewUnmanagedWarning,
  deriveChecklist,
  findRunningInstallOp,
} from "./overview/api.ts";
import { ChecklistCard } from "./overview/ChecklistCard.tsx";
import { cliInstallStore, useCliInstallStore } from "./overview/installStore.ts";
import { QuickDeploySection } from "./overview/QuickDeploySection.tsx";
import { SummaryCard } from "./overview/SummaryCard.tsx";
import { UnmanagedWarningAlert } from "./overview/UnmanagedWarningAlert.tsx";
import "./overview/overview.css";
import { pluginCacheStore, usePluginCacheStore } from "./plugins/pluginCache.ts";
import { openPluginDeployForm } from "./plugins/runStore.ts";
import type { PageProps } from "./types.ts";

export function OverviewPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const nowSecs = useUsageClockSecs();
  const appData = useAppDataStore();
  const installState = useCliInstallStore();
  const pluginCache = usePluginCacheStore();

  // Ensure the host probe runs once per session and automatically re-probes if a cross-tab
  // backend rebuild clears the cached overview while Overview stays mounted.
  useEffect(() => {
    cliInstallStore.syncWithServer();
  }, []);

  useEffect(() => {
    if (appData.overview === null && appData.overviewError === null && !appData.overviewLoading) {
      void appDataStore.ensureOverview().catch(() => {});
    }
  }, [appData.overview, appData.overviewError, appData.overviewLoading]);

  useEffect(() => {
    if (
      appData.overview === null &&
      appData.overviewError !== null &&
      !appData.usesWslResolved
    ) {
      void appDataStore.refreshSessionDefaults().catch(() => {});
    }
  }, [appData.overview, appData.overviewError, appData.usesWslResolved]);

  useEffect(() => {
    cliInstallStore.hydrateFromOverview(appData.overview?.cli_install);
  }, [appData.overview?.cli_install]);

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
  const probeErrorKind: ErrorKind | null =
    appData.overviewError instanceof ApiError ? (appData.overviewError.kind as ErrorKind) : null;
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
  const installActive =
    installState.phase === "running" ||
    installState.phase === "checking" ||
    runningInstallOp !== null;
  const checklist = useMemo(
    () =>
      deriveChecklist(overview, probeError, {
        probeErrorKind,
        installing: installActive,
      }),
    [installActive, overview, probeError, probeErrorKind, probing],
  );
  const ready = checklist.complete && overview !== null;
  const accountChangeBlocked = isAccountChangeBlocked(snapshot, appData);
  const shuttingDown = snapshot?.shutting_down === true;

  useEffect(() => {
    if (!ready) {
      return;
    }
    void pluginCacheStore.ensurePlugins().catch(() => {});
  }, [ready]);

  const effectiveAccounts = overview?.accounts ?? snapshot?.accounts ?? null;
  const unmanagedWarning = useMemo(
    () =>
      buildOverviewUnmanagedWarning(
        effectiveAccounts,
        snapshot,
        overview?.unmanaged_runtimes ?? null,
        nowSecs,
        t,
      ),
    [effectiveAccounts, nowSecs, overview?.unmanaged_runtimes, snapshot, t],
  );

  const awaitingHostKind =
    overview === null &&
    probeError !== null &&
    probeErrorKind !== "wsl_unavailable" &&
    !appData.usesWslResolved;
  const initialLoading =
    (overview === null && probeError === null && probing && !installActive) || awaitingHostKind;

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">{t("app.nav.overview")}</h1>
        <p className="page-subtitle">{t("app.overview.subtitle")}</p>
      </header>

      <div className="page-sections">
        {!ready && unmanagedWarning !== null && (
          <UnmanagedWarningAlert warning={unmanagedWarning} t={t} navigate={navigate} />
        )}

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
              onRefreshUsage={handleRefreshUsage}
            />
            {unmanagedWarning !== null && (
              <UnmanagedWarningAlert warning={unmanagedWarning} t={t} navigate={navigate} />
            )}
            <QuickDeploySection
              plugins={pluginCache.plugins ?? []}
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
            probeErrorKind={probeErrorKind}
            usesWsl={appData.usesWsl}
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
          />
        )}
      </div>
    </>
  );
}
