use std::collections::BTreeSet;

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
            let _ = backend.refresh_usage(&uncovered, cancel);
        }
        let usage = backend.usage();
        state.update(|snapshot| {
            match guard {
                Ok(report) => {
                    snapshot.guard = Some(report);
                    snapshot.guard_error = None;
                }
                Err(error) => snapshot.guard_error = Some(error.kind),
            }
            snapshot.usage = usage;
            true
        });
    }

    if refresh || due || snapshot.runtimes.is_none() {
        state.record_runtimes(backend.runtimes(cancel));
    }
    let tunnels = backend.tunnels();
    state.update(|snapshot| {
        let changed = snapshot.tunnels != tunnels;
        snapshot.tunnels = tunnels;
        changed
    });
}
