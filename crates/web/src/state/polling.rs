use std::{collections::BTreeSet, time::SystemTime};

use colab_playground_core::{guard::USAGE_STALE_AFTER, usage::UsageSnapshot};

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
        // An importable keyring module does not tell us whether the keyring is unlocked.
        let accounts = backend.accounts(cancel);
        let ready = accounts.is_ok();
        self.record_accounts(accounts);
        if !ready {
            return;
        }

        self.refresh_account_usage(backend, &[], cancel);
        self.record_runtimes(backend.runtimes(cancel));
    }

    pub(super) fn refresh_account_usage(
        &self,
        backend: &dyn Backend,
        accounts: &[AccountId],
        cancel: &CancelToken,
    ) {
        let usage = backend
            .refresh_usage(accounts, cancel)
            .unwrap_or_else(|error| {
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
            });
        self.record_usage(usage);
    }

    pub(super) fn record_usage(&self, mut usage: Vec<AccountUsageView>) {
        let now = self.0.backend.now();
        self.update(|snapshot| {
            let _ = expire_usage(&mut usage, now);
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
            changed |= snapshot.usage != usage;
            snapshot.usage = usage;
            changed
        });
    }

    pub(super) fn mark_usage_age(&self) {
        let now = self.0.backend.now();
        self.update(|snapshot| {
            let mut changed = expire_usage(&mut snapshot.usage, now);
            if let Some(accounts) = &mut snapshot.accounts {
                for account in &mut accounts.accounts {
                    changed |= account
                        .usage
                        .as_mut()
                        .is_some_and(|sample| expire_sample(sample, now));
                }
            }
            changed
        });
    }

    pub(super) fn clear_overview(&self) {
        self.update(|snapshot| {
            let mut changed = snapshot.account.active.take().is_some();
            if changed {
                snapshot.account.revision += 1;
            }
            changed |= snapshot.accounts.take().is_some();
            changed |= snapshot.accounts_error.take().is_some();
            changed |= snapshot.runtimes.take().is_some();
            changed |= snapshot.runtimes_error.take().is_some();
            changed |= snapshot.guard.take().is_some();
            changed |= snapshot.guard_error.take().is_some();
            changed |= !snapshot.usage.is_empty();
            snapshot.usage.clear();
            changed
        });
    }

    pub(super) fn record_runtimes(&self, result: Result<RuntimesView>) {
        self.update(|snapshot| {
            let (view, error) = match result {
                Ok(view) => (Some(view), None),
                Err(error) => (snapshot.runtimes.clone(), Some(error.kind)),
            };
            let changed = snapshot.runtimes != view || snapshot.runtimes_error != error;
            snapshot.runtimes = view;
            snapshot.runtimes_error = error;
            changed
        });
    }
}

fn poll_backend(job: &Job, refresh: bool) {
    let state = &job.state;
    let backend = &*state.0.backend;
    let cancel = &job.cancel;
    let due = backend.usage_poll_due();
    let snapshot = state.snapshot();

    if refresh || due || snapshot.accounts.is_none() || snapshot.accounts_error.is_some() {
        state.record_accounts(backend.accounts(cancel));
    }
    if (refresh || due)
        && state
            .snapshot()
            .accounts
            .as_ref()
            .is_some_and(|view| !view.accounts.is_empty())
    {
        let guard = backend.guard_poll(cancel);
        let covered: BTreeSet<_> = guard
            .as_ref()
            .into_iter()
            .flat_map(|report| {
                report
                    .decisions
                    .iter()
                    .map(|decision| decision.session.account.clone())
                    .chain(
                        report
                            .vanished
                            .iter()
                            .map(|runtime| runtime.account.clone()),
                    )
            })
            .collect();
        let uncovered: Vec<_> = backend
            .usage()
            .into_iter()
            .map(|usage| usage.account)
            .filter(|account| !covered.contains(account))
            .collect();
        if !uncovered.is_empty() && (refresh || backend.usage_poll_due()) {
            state.refresh_account_usage(backend, &uncovered, cancel);
        } else {
            state.record_usage(backend.usage());
        }
        state.update(|snapshot| {
            match guard {
                Ok(report) => {
                    snapshot.guard = Some(report);
                    snapshot.guard_error = None;
                }
                Err(error) => snapshot.guard_error = Some(error.kind),
            }
            true
        });
    } else {
        state.mark_usage_age();
    }

    if refresh || due || snapshot.runtimes.is_none() {
        state.record_runtimes(backend.runtimes(cancel));
    }
    state.sync_forwards();
}

fn expire_usage(usage: &mut [AccountUsageView], now: SystemTime) -> bool {
    let mut changed = false;
    for view in usage {
        changed |= view
            .snapshot
            .as_mut()
            .is_some_and(|sample| expire_sample(sample, now));
    }
    changed
}

pub(super) fn expire_sample(sample: &mut UsageSnapshot, now: SystemTime) -> bool {
    let expired = !sample.is_fresh(now, USAGE_STALE_AFTER) && !sample.stale;
    sample.stale |= expired;
    expired
}

pub(super) fn stale_sample(mut sample: UsageSnapshot) -> UsageSnapshot {
    sample.stale = true;
    sample
}
