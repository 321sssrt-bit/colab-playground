use std::{sync::mpsc, time::SystemTime};

use colab_playground_core::{
    backend::{AccountError, Runtime},
    sessions::WatchdogInfo,
};

use super::*;

const FINISHED_PROVISION_LIMIT: usize = 32;
const STOP_ALL: &str = "stop_all_runtimes";

pub(super) type Provisions = Mutex<BTreeMap<u64, watch::Sender<Vec<ProvisionUpdate>>>>;

#[derive(Clone)]
pub enum ProvisionUpdate {
    Progress(ProvisionEvent),
    Finished(Result<ProvisionOutcome>),
}

pub struct ProvisionUpdates {
    journal: watch::Receiver<Vec<ProvisionUpdate>>,
    cursor: usize,
}

impl ProvisionUpdates {
    pub async fn next(&mut self) -> Option<ProvisionUpdate> {
        if self.cursor > 0
            && matches!(
                self.journal.borrow().get(self.cursor - 1),
                Some(ProvisionUpdate::Finished(_))
            )
        {
            return None;
        }
        let journal = self
            .journal
            .wait_for(|log| log.len() > self.cursor)
            .await
            .ok()?;
        let event = journal[self.cursor].clone();
        self.cursor += 1;
        Some(event)
    }
}

#[derive(Clone, Copy)]
pub enum AutoStop {
    Extend(Duration),
    Set(Duration),
    Cancel,
}

pub struct AutoStopStatus {
    pub runtime: Option<Duration>,
    pub watchdog: Option<WatchdogInfo>,
}

pub struct RemainingRuntime {
    pub target: RuntimeRef,
    pub stop_error: Option<Error>,
}

pub struct StopAllReport {
    pub remaining: Vec<RemainingRuntime>,
    pub account_errors: Vec<AccountError>,
}

impl WebState {
    pub async fn list_runtimes(&self) -> Result<(Arc<Snapshot>, SystemTime)> {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            let accounts = backend.accounts(cancel);
            state.record_accounts(accounts.clone());
            accounts?;
            let view = backend.runtimes(cancel);
            state.record_runtimes(view.clone());
            view?;
            Ok((state.snapshot(), backend.now()))
        })
        .await
    }

    pub fn start_provision(&self, account: AccountContext, spec: ProvisionSpec) -> Result<u64> {
        let mut provisions = self.0.provisions.lock().expect("provision journal lock");
        let (send, receive) = mpsc::channel();
        let (id, job) = match self.provision(account, spec, send)? {
            Submission::Started { id, job } => (id, job),
            Submission::AlreadyRunning { id } => return Ok(id),
        };
        let (journal, _) = watch::channel(Vec::new());
        provisions.insert(id, journal.clone());

        let progress = journal.clone();
        let collector = spawn_blocking(move || {
            for event in receive {
                // Core can report Ready before the ledger write and the cancellation commit.
                if !matches!(
                    event,
                    ProvisionEvent::Ready { .. } | ProvisionEvent::Failed { .. }
                ) {
                    progress.send_modify(|log| log.push(ProvisionUpdate::Progress(event)));
                }
            }
        });
        let state = self.clone();
        tokio::spawn(async move {
            let result = job
                .await
                .unwrap_or_else(|_| Err(Error::new(ErrorKind::Other)));
            let _ = collector.await;
            journal.send_modify(|log| log.push(ProvisionUpdate::Finished(result)));
            let mut provisions = state.0.provisions.lock().expect("provision journal lock");
            let expired: Vec<_> = provisions
                .iter()
                .rev()
                .filter_map(|(&id, log)| {
                    matches!(log.borrow().last(), Some(ProvisionUpdate::Finished(_))).then_some(id)
                })
                .skip(FINISHED_PROVISION_LIMIT)
                .collect();
            for id in expired {
                provisions.remove(&id);
            }
        });
        Ok(id)
    }

    pub fn provision_updates(&self, id: u64) -> Option<ProvisionUpdates> {
        let provisions = self.0.provisions.lock().expect("provision journal lock");
        Some(ProvisionUpdates {
            journal: provisions.get(&id)?.subscribe(),
            cursor: 0,
        })
    }

    pub fn cancel_provision(&self, id: u64) -> bool {
        self.0
            .provisions
            .lock()
            .expect("provision journal lock")
            .contains_key(&id)
            && self.cancel(id)
    }

    pub fn stop_runtime(&self, target: RuntimeRef) -> Result<Submission<()>> {
        self.change_runtime(
            "stop_runtime",
            Access::Runtime,
            target,
            |backend, cancel, runtime| {
                cancel.commit()?;
                backend.stop_session(&runtime.id, Default::default(), cancel)
            },
        )
    }

    pub fn change_auto_stop(
        &self,
        account: AccountContext,
        target: RuntimeRef,
        action: AutoStop,
    ) -> Result<Submission<AutoStopStatus>> {
        if required_account(&account)? != target.account {
            return Err(Error::new(ErrorKind::AccountNotActive));
        }
        self.change_runtime(
            "auto_stop",
            Access::Account(account),
            target,
            move |backend, cancel, runtime| {
                if !runtime.managed || runtime.id.name.is_none() {
                    return Err(Error::invalid(
                        "target",
                        "auto-stop requires a named managed runtime",
                    ));
                }
                cancel.commit()?;
                let (runtime, watchdog) = match action {
                    AutoStop::Set(duration) => (
                        Some(duration),
                        Some(backend.set_auto_stop(&runtime.id, duration, cancel)?),
                    ),
                    AutoStop::Extend(by) => {
                        let extended = backend.extend_session(&runtime.id, by, cancel)?;
                        (Some(extended.runtime), Some(extended.watchdog))
                    }
                    AutoStop::Cancel => {
                        backend.cancel_auto_stop(&runtime.id, cancel)?;
                        (None, None)
                    }
                };
                Ok(AutoStopStatus { runtime, watchdog })
            },
        )
    }

    fn change_runtime<T: Send + 'static>(
        &self,
        operation: &'static str,
        access: Access,
        target: RuntimeRef,
        work: impl FnOnce(&dyn Backend, &CancelToken, Runtime) -> Result<T> + Send + 'static,
    ) -> Result<Submission<T>> {
        let key = format!("{}/{}", target.account, target.endpoint);
        let state = self.clone();
        self.start_operation(operation, key, access, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            let runtime = list_account(backend, cancel, &target.account)?
                .runtimes
                .into_iter()
                .find(|runtime| {
                    runtime.id.account == target.account
                        && runtime.id.endpoint == target.endpoint
                        && (!target.endpoint.is_empty() || runtime.id.name == target.name)
                })
                .ok_or_else(|| Error::new(ErrorKind::SessionGone))?;
            let result = work(backend, cancel, runtime);
            state.record_runtimes(backend.runtimes(cancel));
            state.sync_forwards();
            result
        })
    }

    pub fn stop_all_runtimes(&self) -> Result<Submission<StopAllReport>> {
        let operation = Operation::Domain {
            name: STOP_ALL,
            key: String::new(),
        };
        let job = {
            let mut control = self.lock();
            if control.shutting_down {
                return Err(Error::cancelled());
            }
            if let Some((&id, _)) = control
                .running
                .iter()
                .find(|(_, running)| running.operation.as_ref() == Some(&operation))
            {
                return Ok(Submission::AlreadyRunning { id });
            }
            if control.login.is_some()
                || control
                    .running
                    .values()
                    .any(|running| running.access == Slot::Exclusive)
            {
                return Err(Error::new(ErrorKind::Busy));
            }
            for running in control.running.values() {
                if matches!(
                    running.operation,
                    Some(Operation::Provision { .. } | Operation::PluginRun { .. })
                ) {
                    running.cancel.cancel();
                }
            }
            // Reserve before waiting so no new allocation can race the verification listing.
            self.reserve(&mut control, Some(operation), Slot::Exclusive, false)
        };
        let id = job.id;
        let job = tokio::spawn(async move {
            loop {
                let changed = job.state.0.drained.notified();
                job.cancel.check()?;
                if job
                    .state
                    .lock()
                    .running
                    .values()
                    .all(|running| running.access != Slot::Shared)
                {
                    break;
                }
                changed.await;
            }
            spawn_blocking(move || {
                let _poll = job.state.lock_poll_slot();
                job.cancel.commit()?;
                job.state.stop_and_verify(&job.cancel)
            })
            .await
            .map_err(|_| Error::new(ErrorKind::Other))?
        });
        Ok(Submission::Started { id, job })
    }

    fn stop_and_verify(&self, cancel: &CancelToken) -> Result<StopAllReport> {
        let backend = &*self.0.backend;
        let before = backend
            .runtimes(cancel)
            .inspect_err(|error| self.record_runtimes(Err(error.clone())))?;
        let mut errors = std::collections::HashMap::new();
        for runtime in before.runtimes {
            if let Err(error) = backend.stop_session(&runtime.id, Default::default(), cancel)
                && !error.is(ErrorKind::SessionGone)
            {
                errors.insert((runtime.id.account, runtime.id.endpoint), error);
            }
        }
        self.sync_forwards();
        let after = backend.runtimes(cancel);
        self.record_runtimes(after.clone());
        let after = after?;
        if after.errors.is_empty() && after.runtimes.is_empty() {
            self.lock().uncertain_cleanup = false;
        }
        Ok(StopAllReport {
            remaining: after
                .runtimes
                .into_iter()
                .map(|runtime| {
                    let stop_error =
                        errors.remove(&(runtime.id.account.clone(), runtime.id.endpoint.clone()));
                    RemainingRuntime {
                        target: runtime.id,
                        stop_error,
                    }
                })
                .collect(),
            account_errors: after.errors,
        })
    }
}
