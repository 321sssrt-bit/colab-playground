use tokio::time::{Instant, timeout_at};

use super::*;

const FORWARD_CLEANUP_RESERVE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Billing {
    pub managed: usize,
    pub managed_without_watchdog: usize,
    pub unmanaged: usize,
    pub unknown: bool,
}

#[derive(Debug)]
pub struct ShutdownReport {
    pub billing: Billing,
    pub completed: bool,
    pub forwards_closed: usize,
}

impl WebState {
    pub fn begin_shutdown(&self) {
        let mut control = self.lock();
        control.shutting_down = true;
        for running in control.running.values() {
            running.cancel.cancel();
        }
        self.publish_operations(&control);
    }

    pub async fn shutdown(&self, grace: Duration) -> ShutdownReport {
        self.begin_shutdown();
        let deadline = Instant::now() + grace;
        let drain_deadline = deadline - FORWARD_CLEANUP_RESERVE.min(grace / 4);
        let drained = timeout_at(drain_deadline, async {
            while !self.lock().running.is_empty() {
                self.0.drained.notified().await;
            }
        })
        .await
        .is_ok();

        let state = self.clone();
        let pending = self.lock().login.take();
        let cleanup = spawn_blocking(move || {
            state.discard_plugin_previews();
            let backend = &*state.0.backend;
            let mut closed = 0;
            let mut failed = false;
            for tunnel in backend.tunnels() {
                if backend.close_tunnel(tunnel.id).is_ok() {
                    closed += 1;
                } else {
                    failed = true;
                }
            }
            if let Some(pending) = pending {
                failed |= pending.flow.cancel().is_err();
            }
            (closed, failed)
        });
        let (forwards_closed, mut failed) = match timeout_at(deadline, cleanup).await {
            Ok(Ok(result)) => result,
            _ => (0, true),
        };

        if drained {
            let state = self.clone();
            let listing = spawn_blocking(move || state.0.backend.runtimes(&CancelToken::new()));
            if let Ok(Ok(result)) = timeout_at(deadline, listing).await {
                self.record_runtimes(result);
            } else {
                failed = true;
                self.record_runtimes(Err(Error::new(ErrorKind::Timeout)));
            }
        }

        let completed = drained && !failed;
        let snapshot = self.snapshot();
        let mut billing = Billing {
            unknown: !completed
                || snapshot.runtimes_error.is_some()
                || self.lock().uncertain_cleanup,
            ..Billing::default()
        };
        if let Some(view) = &snapshot.runtimes {
            billing.unknown |= !view.errors.is_empty();
            for runtime in &view.runtimes {
                if runtime.managed {
                    billing.managed += 1;
                    if !runtime
                        .tracked
                        .as_ref()
                        .and_then(|entry| entry.watchdog.as_ref())
                        .is_some_and(|watchdog| watchdog.enforced_deadline().is_some())
                    {
                        billing.managed_without_watchdog += 1;
                    }
                } else {
                    billing.unmanaged += 1;
                }
            }
        } else {
            billing.unknown = true;
        }
        ShutdownReport {
            billing,
            completed,
            forwards_closed,
        }
    }
}
