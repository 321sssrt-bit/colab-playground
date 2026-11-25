/**
 * Overview route: four-step environment readiness checklist with streaming
 * Colab CLI installer when setup is incomplete, transitioning to the active
 * account compute-unit summary and unmanaged runtime warning once ready.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../lib/api.ts";
import { useUsageClockSecs } from "../lib/format.ts";
import { webStore } from "../lib/store.ts";
import {
  adoptActiveAccount,
  formatApiError,
  isAccountChangeBlocked,
  refreshAccountsUsage,
  type FormattedApiError,
} from "./accounts/model.ts";
import {
  deriveChecklist,
  fetchOverview,
  findRunningInstallOp,
  type OverviewResponse,
} from "./overview/api.ts";
import { ChecklistCard } from "./overview/ChecklistCard.tsx";
import { SummaryCard } from "./overview/SummaryCard.tsx";
import type { PageProps } from "./types.ts";

export function OverviewPage({ snapshot, locale, t, navigate, pushToast }: PageProps) {
  const nowSecs = useUsageClockSecs();

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [probing, setProbing] = useState(true);
  const [probeError, setProbeError] = useState<FormattedApiError | null>(null);
  const [refreshingUsage, setRefreshingUsage] = useState(false);
  const [usageRefreshError, setUsageRefreshError] = useState<FormattedApiError | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<FormattedApiError | null>(null);

  const probeSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const activeProbeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeProbeControllerRef.current?.abort();
      activeProbeControllerRef.current = null;
    };
  }, []);

  const loadOverview = useCallback(
    async (signal?: AbortSignal) => {
      activeProbeControllerRef.current?.abort();
      const controller = new AbortController();
      activeProbeControllerRef.current = controller;

      const onExternalAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener("abort", onExternalAbort, { once: true });
        }
      }

      const seq = ++probeSeqRef.current;
      setProbing(true);
      setProbeError(null);
      try {
        const data = await fetchOverview(controller.signal);
        if (!mountedRef.current || seq !== probeSeqRef.current) {
          return;
        }
        setOverview(data);
        setProbeError(null);
      } catch (error) {
        if (!mountedRef.current || seq !== probeSeqRef.current) {
          return;
        }
        if (error instanceof ApiError && error.isAbort) {
          return;
        }
        setProbeError(formatApiError(error, t));
      } finally {
        signal?.removeEventListener("abort", onExternalAbort);
        if (activeProbeControllerRef.current === controller) {
          activeProbeControllerRef.current = null;
        }
        if (mountedRef.current && seq === probeSeqRef.current) {
          setProbing(false);
        }
      }
    },
    [t],
  );

  // Re-probe when account revision, saved account membership, or account error changes
  // so Overview converges after sign-in, account switching, or keyring recovery.
  const accountSyncKey =
    snapshot === null
      ? "none"
      : [
          snapshot.account.revision,
          snapshot.account.active ?? "",
          snapshot.accounts?.accounts.length ?? -1,
          snapshot.accounts?.unadopted ? "1" : "0",
          snapshot.accounts_error ?? "",
        ].join(":");

  const prevAccountSyncKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevAccountSyncKeyRef.current === accountSyncKey) {
      return;
    }
    prevAccountSyncKeyRef.current = accountSyncKey;
    const controller = new AbortController();
    void loadOverview(controller.signal);
    return () => {
      controller.abort();
    };
  }, [accountSyncKey, loadOverview]);

  const handleCheckAgain = useCallback(async () => {
    await loadOverview();
    if (!mountedRef.current) {
      return;
    }
    try {
      await webStore.refreshSnapshot();
    } catch {
      // SSE reconnect banner surfaces transport failures.
    }
  }, [loadOverview]);

  const handleInstallSucceeded = useCallback(async () => {
    await handleCheckAgain();
  }, [handleCheckAgain]);

  const handleRefreshUsage = useCallback(async () => {
    if (refreshingUsage) {
      return;
    }
    setRefreshingUsage(true);
    setUsageRefreshError(null);
    try {
      await refreshAccountsUsage();
      if (!mountedRef.current) {
        return;
      }
      try {
        await webStore.refreshSnapshot();
      } catch {
        // SSE stream will converge the updated snapshot.
      }
      await loadOverview();
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setUsageRefreshError(formatApiError(error, t));
    } finally {
      if (mountedRef.current) {
        setRefreshingUsage(false);
      }
    }
  }, [loadOverview, refreshingUsage, t]);

  const handleAdoptAccount = useCallback(async () => {
    if (adopting) {
      return;
    }
    const accountContext = snapshot?.account ?? {
      revision: 0,
      active: overview?.accounts?.active ?? null,
    };
    setAdopting(true);
    setAdoptError(null);
    try {
      const adopted = await adoptActiveAccount(accountContext);
      if (!mountedRef.current) {
        return;
      }
      const email = adopted.email ?? t("app.accounts.no_email");
      pushToast({ tone: "success", body: t("app.adopt.done", { email }) });
      await handleCheckAgain();
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setAdoptError(formatApiError(error, t));
    } finally {
      if (mountedRef.current) {
        setAdopting(false);
      }
    }
  }, [adopting, handleCheckAgain, overview, pushToast, snapshot, t]);

  const checklist = useMemo(
    () => deriveChecklist(overview, probeError, probing),
    [overview, probeError, probing],
  );
  const runningInstallOp = useMemo(() => findRunningInstallOp(snapshot), [snapshot]);
  const accountChangeBlocked = isAccountChangeBlocked(snapshot);
  const shuttingDown = snapshot?.shutting_down === true;

  const initialLoading = overview === null && probeError === null && probing;

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
        ) : checklist.complete && overview !== null ? (
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
