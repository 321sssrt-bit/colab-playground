use std::{collections::BTreeSet, time::SystemTime};

use colab_playground_core::{
    backend::{AccountUsageView, GuardReport},
    guard::USAGE_STALE_AFTER,
    sessions::HardwareRate,
    usage::UsageSnapshot,
};
use tokio::time::{MissedTickBehavior, interval};

use super::*;

const POLL_CHECK: Duration = Duration::from_secs(5);

impl WebState {
    pub(super) async fn poll(self) {
        let mut timer = interval(POLL_CHECK);
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut shutdown = self.subscribe();
        loop {
            let refresh = tokio::select! {
                _ = shutdown.wait_for(|snapshot| snapshot.shutting_down) => return,
                _ = self.0.refresh.notified() => true,
                _ = timer.tick() => false,
            };
            let state = self.clone();
            let _ = spawn_blocking(move || {
                let _poll = state.lock_poll_slot();
                let job = {
                    let mut control = state.lock();
                    if !control.available(Slot::Poll) {
                        return;
                    }
                    state.reserve(&mut control, None, Slot::Poll, false)
                };
                poll_backend(&job, refresh);
            })
            .await;
        }
    }

    pub(super) fn refresh_overview(&self, backend: &dyn Backend, cancel: &CancelToken) {
        let _ = self.refresh_all(backend, cancel, false);
    }

    pub(super) fn refresh_all(
        &self,
        backend: &dyn Backend,
        cancel: &CancelToken,
        require_runtimes: bool,
    ) -> Result<()> {
        // An importable keyring module does not tell us whether the keyring is unlocked.
        let accounts = backend.accounts(cancel);
        match accounts {
            Ok(view) => {
                let has_accounts = !view.accounts.is_empty();
                self.record_accounts(Ok(view));
                if !has_accounts {
                    self.record_empty_when_signed_out(backend.measured_rates());
                    self.sync_forwards();
                    return Ok(());
                }
            }
            Err(error) => {
                let kind = error.kind;
                self.record_accounts(Err(error.clone()));
                if is_environment_blocked(kind) {
                    self.record_runtimes(Err(Error::new(kind)));
                }
                return Err(error);
            }
        }

        // Run the guard round before listing runtimes so `runtimes()` cannot consume vanished
        // ledger entries ahead of `guard_poll()`.
        let _ = self.sync_usage_and_guard(backend, true, cancel);
        let runtimes = backend.runtimes(cancel);
        self.record_runtimes(runtimes.clone());
        self.sync_forwards();
        if require_runtimes {
            runtimes?;
        }
        Ok(())
    }

    pub(super) fn has_managed_runtimes(&self) -> bool {
        let snapshot = self.0.snapshots.borrow();
        if snapshot.pending_managed_check {
            return snapshot
                .accounts
                .as_ref()
                .is_some_and(|view| !view.accounts.is_empty());
        }
        match (&snapshot.runtimes, snapshot.runtimes_error) {
            (Some(view), None) => view.runtimes.iter().any(|runtime| runtime.managed),
            _ => snapshot
                .accounts
                .as_ref()
                .is_some_and(|view| !view.accounts.is_empty()),
        }
    }

    /// Runs one usage + optional guard round matching desktop `AppState::fetch_usage`.
    /// Returns `true` when the guard stopped or noticed a vanished runtime.
    pub(super) fn sync_usage_and_guard(
        &self,
        backend: &dyn Backend,
        manual: bool,
        cancel: &CancelToken,
    ) -> bool {
        if self.has_managed_runtimes() {
            match backend.guard_poll(cancel) {
                Ok(report) => {
                    let covered: BTreeSet<AccountId> = report
                        .decisions
                        .iter()
                        .map(|decision| decision.session.account.clone())
                        .chain(
                            report
                                .vanished
                                .iter()
                                .map(|runtime| runtime.account.clone()),
                        )
                        .collect();
                    let uncovered: Vec<AccountId> = report
                        .usage
                        .iter()
                        .map(|usage| usage.account.clone())
                        .filter(|account| !covered.contains(account))
                        .collect();
                    let views = if !uncovered.is_empty() && (manual || backend.usage_poll_due()) {
                        match backend.refresh_usage(&uncovered, cancel) {
                            Ok(views) => views,
                            Err(error) if error.is(ErrorKind::Busy) && !manual => {
                                report.usage.clone()
                            }
                            Err(error) => failed_usage_views(backend, &uncovered, error),
                        }
                    } else {
                        report.usage.clone()
                    };
                    self.apply_guard_and_usage(
                        Some(Ok(report)),
                        views,
                        backend.measured_rates(),
                        backend.now(),
                    )
                }
                Err(error) if error.is(ErrorKind::Busy) => {
                    // Transient contention must not surface a false guard-broken warning.
                    self.refresh_usage_only(backend, manual, None, cancel);
                    false
                }
                Err(error) => {
                    self.refresh_usage_only(backend, manual, Some(error.kind), cancel);
                    false
                }
            }
        } else {
            self.refresh_usage_only(backend, manual, None, cancel);
            false
        }
    }

    pub(super) fn refresh_usage_after_stop(&self, backend: &dyn Backend, cancel: &CancelToken) {
        if self.sync_usage_and_guard(backend, true, cancel) {
            self.record_runtimes(backend.runtimes(cancel));
            self.sync_forwards();
        }
    }

    fn refresh_usage_only(
        &self,
        backend: &dyn Backend,
        manual: bool,
        guard_error: Option<ErrorKind>,
        cancel: &CancelToken,
    ) {
        match backend.refresh_usage(&[], cancel) {
            Ok(views) => {
                let _ = self.apply_guard_and_usage(
                    guard_error.map(Err),
                    views,
                    backend.measured_rates(),
                    backend.now(),
                );
            }
            Err(error) if error.is(ErrorKind::Busy) && !manual => {
                if let Some(kind) = guard_error {
                    let _ = self.apply_guard_and_usage(
                        Some(Err(kind)),
                        backend.usage(),
                        backend.measured_rates(),
                        backend.now(),
                    );
                }
            }
            Err(error) => {
                let views = failed_usage_views(backend, &[], error);
                let _ = self.apply_guard_and_usage(
                    guard_error.map(Err),
                    views,
                    backend.measured_rates(),
                    backend.now(),
                );
            }
        }
    }

    fn apply_guard_and_usage(
        &self,
        guard_result: Option<std::result::Result<GuardReport, ErrorKind>>,
        usage: Vec<AccountUsageView>,
        measured_rates: Vec<HardwareRate>,
        now: SystemTime,
    ) -> bool {
        let mut guard_changed = false;
        self.update(|snapshot| {
            let mut changed = merge_usage_into_snapshot(snapshot, usage, now);
            if snapshot.measured_rates != measured_rates {
                snapshot.measured_rates = measured_rates;
                changed = true;
            }
            match guard_result {
                Some(Ok(report)) => {
                    let (mutated_runtimes, ledger_changed) = snapshot.guard_state.apply_guard(
                        report,
                        snapshot.runtimes.as_ref(),
                        snapshot.accounts.as_ref(),
                        now,
                    );
                    guard_changed = mutated_runtimes;
                    changed |= ledger_changed;
                    changed |= snapshot.guard_error.take().is_some();
                }
                Some(Err(error_kind)) if snapshot.guard_error != Some(error_kind) => {
                    snapshot.guard_error = Some(error_kind);
                    changed = true;
                }
                Some(Err(_)) | None => {}
            }
            changed |= snapshot.sync_guard_projection();
            changed
        });
        guard_changed
    }

    #[cfg(test)]
    pub(super) fn record_usage(&self, usage: Vec<AccountUsageView>) {
        let now = self.0.backend.now();
        let rates = self.0.backend.measured_rates();
        self.update(|snapshot| {
            let mut changed = merge_usage_into_snapshot(snapshot, usage, now);
            if snapshot.measured_rates != rates {
                snapshot.measured_rates = rates;
                changed = true;
            }
            changed |= snapshot.sync_guard_projection();
            changed
        });
    }

    /// Publishes an updated `server_now` when any cached usage sample crosses `USAGE_STALE_AFTER`,
    /// without mutating `sample.stale` (which stays reserved for failed/unverified fetches).
    pub(super) fn check_usage_age(&self) {
        let now = self.0.backend.now();
        self.0.snapshots.send_if_modified(|snapshot| {
            let prev = snapshot.usage_now;
            let age_crossed = snapshot
                .usage
                .iter()
                .filter_map(|view| view.snapshot.as_ref())
                .any(|sample| is_aged_or_stale(sample, now) != is_aged_or_stale(sample, prev));
            if !age_crossed {
                return false;
            }
            let snapshot = Arc::make_mut(snapshot);
            snapshot.usage_now = now;
            snapshot.server_now = now;
            snapshot.version += 1;
            true
        });
    }

    pub(super) fn record_empty_when_signed_out(&self, measured_rates: Vec<HardwareRate>) {
        self.update(|snapshot| {
            let empty = RuntimesView::default();
            let mut changed = snapshot.runtimes.as_ref() != Some(&empty)
                || snapshot.runtimes_error.take().is_some()
                || !snapshot.usage.is_empty()
                || snapshot.measured_rates != measured_rates;
            snapshot.runtimes = Some(empty);
            snapshot.usage.clear();
            snapshot.measured_rates = measured_rates;
            changed |= snapshot.guard_state.retain_live(&[]);
            changed |= snapshot.sync_guard_projection();
            changed
        });
    }

    pub(super) fn clear_overview(&self, measured_rates: Vec<HardwareRate>) {
        self.update(|snapshot| {
            let mut changed = snapshot.account.active.take().is_some();
            if changed {
                snapshot.account.revision += 1;
            }
            changed |= snapshot.accounts.take().is_some();
            changed |= snapshot.accounts_error.take().is_some();
            changed |= snapshot.runtimes.take().is_some();
            changed |= snapshot.runtimes_error.take().is_some();
            changed |= snapshot.guard_error.take().is_some();
            // Keep unconsumed guard events and ended history until explicitly acknowledged.
            changed |= snapshot.guard_state.clear_live();
            changed |= !snapshot.usage.is_empty();
            snapshot.usage.clear();
            if snapshot.measured_rates != measured_rates {
                snapshot.measured_rates = measured_rates;
                changed = true;
            }
            changed |= snapshot.sync_guard_projection();
            changed
        });
    }

    pub(super) fn record_runtimes(&self, result: Result<RuntimesView>) {
        self.update(|snapshot| {
            let (view, error) = match result {
                Ok(view) => {
                    snapshot.cli_installed = Some(true);
                    snapshot.pending_managed_check = false;
                    let _ = snapshot.guard_state.retain_live(&view.runtimes);
                    (Some(view), None)
                }
                Err(error) => {
                    if error.is(ErrorKind::NotInstalled) {
                        snapshot.cli_installed = Some(false);
                    }
                    (snapshot.runtimes.clone(), Some(error.kind))
                }
            };
            let mut changed = snapshot.runtimes != view || snapshot.runtimes_error != error;
            snapshot.runtimes = view;
            snapshot.runtimes_error = error;
            changed |= snapshot.sync_guard_projection();
            changed
        });
    }
}

fn is_environment_blocked(kind: ErrorKind) -> bool {
    matches!(
        kind,
        ErrorKind::NotInstalled | ErrorKind::KeyringUnavailable | ErrorKind::WslUnavailable
    )
}

fn poll_backend(job: &Job, refresh: bool) {
    let state = &job.state;
    let backend = &*state.0.backend;
    let cancel = &job.cancel;
    let snapshot = state.0.snapshots.borrow().clone();

    if snapshot.cli_installed == Some(false) {
        return;
    }
    if !refresh && snapshot.accounts_error.is_some_and(is_environment_blocked) {
        return;
    }

    let cold_start = snapshot.accounts.is_none() && snapshot.accounts_error.is_none();
    if refresh || cold_start {
        match backend.accounts(cancel) {
            Ok(view) => {
                let has_accounts = !view.accounts.is_empty();
                state.record_accounts(Ok(view));
                if !has_accounts {
                    state.record_empty_when_signed_out(backend.measured_rates());
                    state.sync_forwards();
                    return;
                }
            }
            Err(error) => {
                let kind = error.kind;
                state.record_accounts(Err(error));
                if is_environment_blocked(kind) {
                    state.record_runtimes(Err(Error::new(kind)));
                }
                return;
            }
        }
    }

    let snapshot = state.0.snapshots.borrow().clone();
    if snapshot.accounts_error.is_some() {
        return;
    }
    let has_accounts = snapshot
        .accounts
        .as_ref()
        .is_some_and(|view| !view.accounts.is_empty());
    if !has_accounts {
        return;
    }

    let due = backend.usage_poll_due();
    if !refresh && !cold_start && !due && snapshot.runtimes.is_some() {
        state.check_usage_age();
        return;
    }

    // Only on the initial cold start (before any runtime listing exists) list first so a
    // zero-session startup skips `guard_poll()`. Later polls and refreshes run the guard
    // round before listing so `runtimes()` cannot consume vanished sessions ahead of it.
    let initial_probe = cold_start && snapshot.runtimes.is_none();
    if initial_probe {
        state.record_runtimes(backend.runtimes(cancel));
    }

    let guard_changed = state.sync_usage_and_guard(backend, refresh, cancel);

    if !initial_probe || guard_changed {
        state.record_runtimes(backend.runtimes(cancel));
    }
    state.sync_forwards();
}

fn failed_usage_views(
    backend: &dyn Backend,
    accounts: &[AccountId],
    error: Error,
) -> Vec<AccountUsageView> {
    let mut usage = backend.usage();
    for view in &mut usage {
        if accounts.is_empty() || accounts.contains(&view.account) {
            if let Some(snapshot) = &mut view.snapshot {
                snapshot.stale = true;
            }
            view.last_error = Some(error.clone());
        }
    }
    usage
}

fn merge_usage_into_snapshot(
    snapshot: &mut Snapshot,
    mut usage: Vec<AccountUsageView>,
    now: SystemTime,
) -> bool {
    let mut changed = false;
    if let Some(accounts) = &mut snapshot.accounts {
        for account in &mut accounts.accounts {
            if let Some(view) = usage.iter_mut().find(|view| view.account == account.id) {
                // After a restart, the account store can hold the only known sample.
                if view.snapshot.is_none()
                    && let Some(sample) = account.usage
                {
                    let sample = stale_sample(sample);
                    view.eta = sample.eta();
                    view.snapshot = Some(sample);
                }
                changed |= account.usage != view.snapshot;
                account.usage = view.snapshot;
            }
        }
    }
    if snapshot.usage != usage {
        snapshot.usage = usage;
        changed = true;
    }
    let prev = snapshot.usage_now;
    let age_crossed = snapshot
        .usage
        .iter()
        .filter_map(|view| view.snapshot.as_ref())
        .any(|sample| is_aged_or_stale(sample, now) != is_aged_or_stale(sample, prev));
    snapshot.usage_now = now;
    changed | age_crossed
}

fn is_aged_or_stale(sample: &UsageSnapshot, now: SystemTime) -> bool {
    !sample.is_fresh(now, USAGE_STALE_AFTER)
}

pub(super) fn stale_sample(mut sample: UsageSnapshot) -> UsageSnapshot {
    sample.stale = true;
    sample
}
