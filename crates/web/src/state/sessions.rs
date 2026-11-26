use std::{sync::mpsc, time::SystemTime};

use colab_playground_core::{
    accounts::AccountsView,
    backend::{AccountError, AccountUsageView, GuardDecision, GuardReport, Runtime},
    clock::serde_secs,
    guard::{Concern, Decision, Limit},
    sessions::WatchdogInfo,
};

use super::*;

const FINISHED_PROVISION_LIMIT: usize = 32;
const ENDED_KEPT: usize = 20;
const STOP_ALL: &str = "stop_all_runtimes";

pub(super) type Provisions = Mutex<BTreeMap<u64, watch::Sender<Vec<ProvisionUpdate>>>>;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GuardEvent {
    pub id: u64,
    #[serde(with = "serde_secs")]
    pub at: SystemTime,
    pub session: RuntimeRef,
    pub label: String,
    pub email: Option<String>,
    #[serde(flatten)]
    pub kind: GuardEventKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GuardEventKind {
    Warn { concerns: Vec<Concern> },
    StopFailed { concern: Concern, error: Error },
    Stopped { concern: Concern },
    Vanished,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EndedRuntime {
    pub runtime: RuntimeRef,
    pub label: String,
    pub email: Option<String>,
    pub reason: EndReason,
    #[serde(default, with = "serde_secs::option")]
    pub at: Option<SystemTime>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EndReason {
    User,
    Guard { concern: Concern },
    Vanished,
}

#[derive(Debug, Clone, Default)]
pub(super) struct GuardLedger {
    next_event_id: u64,
    warnings: Vec<(RuntimeRef, Vec<Concern>)>,
    stop_failures: Vec<(RuntimeRef, Concern, Error)>,
    events: Vec<GuardEvent>,
    ended: Vec<EndedRuntime>,
    has_report: bool,
    ok_sessions: Vec<RuntimeRef>,
}

impl GuardLedger {
    pub(super) fn clear_live(&mut self) -> bool {
        let changed = self.has_report
            || !self.warnings.is_empty()
            || !self.stop_failures.is_empty()
            || !self.ok_sessions.is_empty();
        self.warnings.clear();
        self.stop_failures.clear();
        self.has_report = false;
        self.ok_sessions.clear();
        changed
    }

    pub(super) fn retain_live(&mut self, live: &[Runtime]) -> bool {
        let before = (
            self.warnings.len(),
            self.stop_failures.len(),
            self.ok_sessions.len(),
        );
        self.warnings
            .retain(|(target, _)| live.iter().any(|rt| same_runtime(&rt.id, target)));
        self.stop_failures
            .retain(|(target, _, _)| live.iter().any(|rt| same_runtime(&rt.id, target)));
        self.ok_sessions
            .retain(|target| live.iter().any(|rt| same_runtime(&rt.id, target)));
        before
            != (
                self.warnings.len(),
                self.stop_failures.len(),
                self.ok_sessions.len(),
            )
    }

    pub(super) fn clear_warning(&mut self, target: &RuntimeRef) -> bool {
        let before = self.warnings.len();
        self.warnings
            .retain(|(existing, _)| !same_runtime(existing, target));
        self.warnings.len() != before
    }

    pub(super) fn record_user_stop(
        &mut self,
        target: RuntimeRef,
        label: String,
        email: Option<String>,
        at: SystemTime,
    ) {
        self.warnings
            .retain(|(existing, _)| !same_runtime(existing, &target));
        self.stop_failures
            .retain(|(existing, _, _)| !same_runtime(existing, &target));
        self.ok_sessions
            .retain(|existing| !same_runtime(existing, &target));
        self.record_ended(target, label, email, EndReason::User, Some(at));
    }

    pub(super) fn apply_guard(
        &mut self,
        report: GuardReport,
        runtimes: Option<&RuntimesView>,
        accounts: Option<&AccountsView>,
        now: SystemTime,
    ) -> (bool, bool) {
        let prev_has_report = self.has_report;
        let prev_warnings = self.warnings.clone();
        let prev_stop_failures = self.stop_failures.clone();
        let prev_events = self.events.clone();
        let prev_ended = self.ended.clone();
        let prev_ok = self.ok_sessions.clone();

        self.has_report = true;
        self.ok_sessions.clear();
        let mut mutated_runtimes = false;

        for decision in report.decisions {
            let target = decision.session;
            let (label, email) = lookup_runtime_meta(&target, runtimes, accounts);
            match decision.decision {
                Decision::Ok => {
                    self.warnings
                        .retain(|(existing, _)| !same_runtime(existing, &target));
                    if !self
                        .stop_failures
                        .iter()
                        .any(|(existing, _, _)| same_runtime(existing, &target))
                    {
                        self.ok_sessions.push(target);
                    }
                }
                Decision::Warn(concerns) => {
                    let previous = self
                        .warnings
                        .iter()
                        .find(|(existing, _)| same_runtime(existing, &target))
                        .map(|(_, c)| c.clone());
                    // Track re-triggers against the live warning state (matching desktop
                    // `apply_guard`), not the unconsumed queue, so a warning cleared by Ok or
                    // Extend and later re-triggered queues a fresh event id even if the earlier
                    // notification was not yet acknowledged.
                    let limits_changed = previous
                        .as_ref()
                        .is_none_or(|before| !same_concern_kinds(before, &concerns));
                    if limits_changed {
                        self.push_event(
                            now,
                            target.clone(),
                            label,
                            email,
                            GuardEventKind::Warn {
                                concerns: concerns.clone(),
                            },
                        );
                    }
                    if let Some((_, existing)) = self
                        .warnings
                        .iter_mut()
                        .find(|(existing, _)| same_runtime(existing, &target))
                    {
                        *existing = concerns;
                    } else {
                        self.warnings.push((target, concerns));
                    }
                }
                Decision::Stop(concern) => {
                    if decision.stopped {
                        self.warnings
                            .retain(|(existing, _)| !same_runtime(existing, &target));
                        self.stop_failures
                            .retain(|(existing, _, _)| !same_runtime(existing, &target));
                        self.record_ended(
                            target.clone(),
                            label.clone(),
                            email.clone(),
                            EndReason::Guard {
                                concern: concern.clone(),
                            },
                            Some(now),
                        );
                        if !self.events.iter().any(|event| {
                            same_runtime(&event.session, &target)
                                && matches!(event.kind, GuardEventKind::Stopped { .. })
                        }) {
                            self.push_event(
                                now,
                                target,
                                label,
                                email,
                                GuardEventKind::Stopped { concern },
                            );
                        }
                        mutated_runtimes = true;
                    } else {
                        let error = decision.error.unwrap_or_else(|| {
                            Error::new(ErrorKind::Other)
                                .detail("the cost guard decided to stop it but no stop was made")
                        });
                        let prev_failure = self
                            .stop_failures
                            .iter()
                            .find(|(existing, _, _)| same_runtime(existing, &target))
                            .map(|(_, c, e)| (c.clone(), e.clone()));
                        let failure_changed = prev_failure.as_ref().is_none_or(
                            |(existing_concern, existing_error)| {
                                existing_concern != &concern || existing_error != &error
                            },
                        );
                        if let Some((_, existing_concern, existing_error)) = self
                            .stop_failures
                            .iter_mut()
                            .find(|(existing, _, _)| same_runtime(existing, &target))
                        {
                            *existing_concern = concern.clone();
                            *existing_error = error.clone();
                        } else {
                            self.stop_failures.push((
                                target.clone(),
                                concern.clone(),
                                error.clone(),
                            ));
                        }
                        if failure_changed {
                            self.push_event(
                                now,
                                target,
                                label,
                                email,
                                GuardEventKind::StopFailed { concern, error },
                            );
                        }
                    }
                }
            }
        }

        for target in report.vanished {
            if self.already_ended_with_cause(&target) {
                continue;
            }
            let (label, email) = lookup_runtime_meta(&target, runtimes, accounts);
            self.warnings
                .retain(|(existing, _)| !same_runtime(existing, &target));
            self.stop_failures
                .retain(|(existing, _, _)| !same_runtime(existing, &target));
            self.record_ended(
                target.clone(),
                label.clone(),
                email.clone(),
                EndReason::Vanished,
                Some(now),
            );
            if !self.events.iter().any(|event| {
                same_runtime(&event.session, &target)
                    && matches!(event.kind, GuardEventKind::Vanished)
            }) {
                self.push_event(now, target, label, email, GuardEventKind::Vanished);
            }
            mutated_runtimes = true;
        }

        let ledger_changed = prev_has_report != self.has_report
            || prev_warnings != self.warnings
            || prev_stop_failures != self.stop_failures
            || prev_events != self.events
            || prev_ended != self.ended
            || prev_ok != self.ok_sessions;
        (mutated_runtimes, ledger_changed)
    }

    pub(super) fn ack(&mut self, up_to_id: Option<u64>, ids: Option<&[u64]>) -> usize {
        let before = self.events.len();
        match (ids, up_to_id) {
            (Some(ids), _) => self.events.retain(|event| !ids.contains(&event.id)),
            (None, Some(max_id)) => self.events.retain(|event| event.id > max_id),
            (None, None) => self.events.clear(),
        }
        before - self.events.len()
    }

    pub(super) fn build_report(&self, usage: &[AccountUsageView]) -> Option<GuardReport> {
        if !self.has_report && self.events.is_empty() {
            return None;
        }
        let mut decisions = Vec::new();
        let mut vanished = Vec::new();

        // Live card state comes strictly from active stop failures, active warnings, and Ok
        // decisions, so clearing a warning (via Ok, Extend, or Cancel auto-stop) is reflected
        // immediately while unconsumed historical events stay intact in `guard_events`.
        for (target, concern, error) in &self.stop_failures {
            decisions.push(GuardDecision {
                session: target.clone(),
                decision: Decision::Stop(concern.clone()),
                stopped: false,
                error: Some(error.clone()),
            });
        }
        for (target, concerns) in &self.warnings {
            if !decisions.iter().any(|d| same_runtime(&d.session, target)) {
                decisions.push(GuardDecision {
                    session: target.clone(),
                    decision: Decision::Warn(concerns.clone()),
                    stopped: false,
                    error: None,
                });
            }
        }
        for target in &self.ok_sessions {
            if !decisions.iter().any(|d| same_runtime(&d.session, target)) {
                decisions.push(GuardDecision {
                    session: target.clone(),
                    decision: Decision::Ok,
                    stopped: false,
                    error: None,
                });
            }
        }

        // Unconsumed terminal guard decisions stay in `guard` until acknowledged so follow-up
        // polls never drop a guard stop or let it be misclassified as vanished.
        for event in &self.events {
            match &event.kind {
                GuardEventKind::Stopped { concern } => {
                    if !decisions
                        .iter()
                        .any(|d| same_runtime(&d.session, &event.session) && d.stopped)
                    {
                        decisions.push(GuardDecision {
                            session: event.session.clone(),
                            decision: Decision::Stop(concern.clone()),
                            stopped: true,
                            error: None,
                        });
                    }
                }
                GuardEventKind::Vanished => {
                    if !vanished
                        .iter()
                        .any(|existing| same_runtime(existing, &event.session))
                    {
                        vanished.push(event.session.clone());
                    }
                }
                GuardEventKind::Warn { .. } | GuardEventKind::StopFailed { .. } => {}
            }
        }

        Some(GuardReport {
            decisions,
            vanished,
            usage: usage.to_vec(),
        })
    }

    fn already_ended_with_cause(&self, target: &RuntimeRef) -> bool {
        self.ended.iter().any(|ended| {
            same_runtime(&ended.runtime, target) && !matches!(ended.reason, EndReason::Vanished)
        })
    }

    fn push_event(
        &mut self,
        at: SystemTime,
        session: RuntimeRef,
        label: String,
        email: Option<String>,
        kind: GuardEventKind,
    ) {
        self.next_event_id += 1;
        self.events.push(GuardEvent {
            id: self.next_event_id,
            at,
            session,
            label,
            email,
            kind,
        });
    }

    fn record_ended(
        &mut self,
        runtime: RuntimeRef,
        label: String,
        email: Option<String>,
        reason: EndReason,
        at: Option<SystemTime>,
    ) {
        if matches!(reason, EndReason::Vanished) && self.already_ended_with_cause(&runtime) {
            return;
        }
        self.ended
            .retain(|existing| !same_runtime(&existing.runtime, &runtime));
        self.ended.insert(
            0,
            EndedRuntime {
                runtime,
                label,
                email,
                reason,
                at,
            },
        );
        self.ended.truncate(ENDED_KEPT);
    }
}

impl Snapshot {
    pub(super) fn sync_guard_projection(&mut self) -> bool {
        let next_guard = self.guard_state.build_report(&self.usage);
        let mut changed = false;
        if self.guard != next_guard {
            self.guard = next_guard;
            changed = true;
        }
        if self.guard_events != self.guard_state.events {
            self.guard_events.clone_from(&self.guard_state.events);
            changed = true;
        }
        if self.ended != self.guard_state.ended {
            self.ended.clone_from(&self.guard_state.ended);
            changed = true;
        }
        changed
    }
}

fn same_runtime(a: &RuntimeRef, b: &RuntimeRef) -> bool {
    if a.account != b.account {
        return false;
    }
    if !a.endpoint.is_empty() && !b.endpoint.is_empty() {
        a.endpoint == b.endpoint
    } else if a.name.is_some() && b.name.is_some() {
        a.name == b.name
    } else {
        a == b
    }
}

fn matches_request_target(listed: &RuntimeRef, requested: &RuntimeRef) -> bool {
    listed.account == requested.account
        && listed.endpoint == requested.endpoint
        && (!requested.endpoint.is_empty() || listed.name == requested.name)
        && requested
            .name
            .as_ref()
            .is_none_or(|name| listed.name.as_ref() == Some(name))
}

fn lookup_runtime_meta(
    target: &RuntimeRef,
    runtimes: Option<&RuntimesView>,
    accounts: Option<&AccountsView>,
) -> (String, Option<String>) {
    if let Some(runtime) =
        runtimes.and_then(|view| view.runtimes.iter().find(|rt| same_runtime(&rt.id, target)))
    {
        let label = runtime
            .id
            .name
            .clone()
            .unwrap_or_else(|| runtime.hardware.clone());
        return (label, runtime.account_email.clone());
    }
    let label = target
        .name
        .clone()
        .unwrap_or_else(|| target.endpoint.clone());
    let email = accounts.and_then(|view| {
        view.accounts
            .iter()
            .find(|account| account.id == target.account)
            .and_then(|account| account.email.clone())
    });
    (label, email)
}

fn concern_key(concern: &Concern) -> (bool, Limit) {
    match concern {
        Concern::Limit { limit, .. } => (true, *limit),
        Concern::UsageUnknown { limit } => (false, *limit),
    }
}

fn same_concern_kinds(a: &[Concern], b: &[Concern]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(left, right)| concern_key(left) == concern_key(right))
}

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
            state.refresh_all(backend, cancel, true)?;
            Ok((state.snapshot(), backend.now()))
        })
        .await
    }

    pub fn ack_guard_events(&self, up_to_id: Option<u64>, ids: Option<&[u64]>) -> usize {
        let mut acknowledged = 0;
        self.update(|snapshot| {
            acknowledged = snapshot.guard_state.ack(up_to_id, ids);
            acknowledged > 0 && snapshot.sync_guard_projection()
        });
        acknowledged
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
        let key = format!("{}/{}", target.account, target.endpoint);
        let state = self.clone();
        self.start_operation(
            "stop_runtime",
            key,
            Access::Runtime,
            move |backend, cancel| {
                let _poll = state.lock_poll_slot();
                let cached = state.find_cached_runtime(&target);
                let resolved = match cached {
                    Some(runtime) => runtime.id,
                    None if target.endpoint.is_empty() => {
                        list_account(backend, cancel, &target.account)?
                            .runtimes
                            .into_iter()
                            .find(|runtime| same_runtime(&runtime.id, &target))
                            .map(|runtime| runtime.id)
                            .ok_or_else(|| Error::new(ErrorKind::SessionGone))?
                    }
                    None => target,
                };
                cancel.commit()?;
                backend.stop_session(&resolved, Default::default(), cancel)?;
                let now = backend.now();
                state.record_user_stopped(&resolved, now);
                // Run the guard round before listing runtimes so `runtimes()` cannot consume
                // vanished ledger entries for other sessions ahead of `guard_poll()`.
                let _ = state.sync_usage_and_guard(backend, true, cancel);
                state.record_runtimes(backend.runtimes(cancel));
                state.sync_forwards();
                Ok(())
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
        let key = format!("{}/{}", target.account, target.endpoint);
        let state = self.clone();
        self.start_operation(
            "auto_stop",
            key,
            Access::Account(account),
            move |backend, cancel| {
                let _poll = state.lock_poll_slot();
                let runtime = match state.find_exact_cached_runtime(&target) {
                    Some(runtime) => runtime,
                    None => list_account(backend, cancel, &target.account)?
                        .runtimes
                        .into_iter()
                        .find(|runtime| matches_request_target(&runtime.id, &target))
                        .ok_or_else(|| Error::new(ErrorKind::SessionGone))?,
                };
                if !runtime.managed || runtime.id.name.is_none() {
                    return Err(Error::invalid(
                        "target",
                        "auto-stop requires a named managed runtime",
                    ));
                }
                let resolved = runtime.id;
                cancel.commit()?;
                let (runtime, watchdog) = match action {
                    AutoStop::Set(duration) => (
                        Some(duration),
                        Some(backend.set_auto_stop(&resolved, duration, cancel)?),
                    ),
                    AutoStop::Extend(by) => {
                        let extended = backend.extend_session(&resolved, by, cancel)?;
                        (Some(extended.runtime), Some(extended.watchdog))
                    }
                    AutoStop::Cancel => {
                        backend.cancel_auto_stop(&resolved, cancel)?;
                        (None, None)
                    }
                };
                state.clear_runtime_warning(&resolved);
                state.record_runtimes(backend.runtimes(cancel));
                state.sync_forwards();
                Ok(AutoStopStatus { runtime, watchdog })
            },
        )
    }

    fn find_cached_runtime(&self, target: &RuntimeRef) -> Option<Runtime> {
        let snapshot = self.0.snapshots.borrow();
        snapshot
            .runtimes
            .as_ref()?
            .runtimes
            .iter()
            .find(|runtime| same_runtime(&runtime.id, target))
            .cloned()
    }

    fn find_exact_cached_runtime(&self, target: &RuntimeRef) -> Option<Runtime> {
        let snapshot = self.0.snapshots.borrow();
        snapshot
            .runtimes
            .as_ref()?
            .runtimes
            .iter()
            .find(|runtime| matches_request_target(&runtime.id, target))
            .cloned()
    }

    fn clear_runtime_warning(&self, target: &RuntimeRef) {
        self.update(|snapshot| {
            let removed = snapshot.guard_state.clear_warning(target);
            removed && snapshot.sync_guard_projection()
        });
    }

    fn record_user_stopped(&self, target: &RuntimeRef, now: SystemTime) {
        self.update(|snapshot| {
            let (label, email) = lookup_runtime_meta(
                target,
                snapshot.runtimes.as_ref(),
                snapshot.accounts.as_ref(),
            );
            snapshot
                .guard_state
                .record_user_stop(target.clone(), label, email, now);
            if let Some(view) = &mut snapshot.runtimes {
                view.runtimes
                    .retain(|runtime| !same_runtime(&runtime.id, target));
            }
            snapshot.sync_guard_projection();
            true
        });
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
        let backend = self.backend();
        let backend = &*backend;
        let before = backend
            .runtimes(cancel)
            .inspect_err(|error| self.record_runtimes(Err(error.clone())))?;
        let mut errors = std::collections::HashMap::new();
        let mut stopped = Vec::new();
        for runtime in before.runtimes {
            match backend.stop_session(&runtime.id, Default::default(), cancel) {
                Ok(()) => stopped.push(runtime),
                Err(error) if error.is(ErrorKind::SessionGone) => {}
                Err(error) => {
                    errors.insert((runtime.id.account, runtime.id.endpoint), error);
                }
            }
        }
        let now = backend.now();
        if !stopped.is_empty() {
            self.update(|snapshot| {
                for runtime in &stopped {
                    let label = runtime
                        .id
                        .name
                        .clone()
                        .unwrap_or_else(|| runtime.hardware.clone());
                    snapshot.guard_state.record_user_stop(
                        runtime.id.clone(),
                        label,
                        runtime.account_email.clone(),
                        now,
                    );
                }
                snapshot.sync_guard_projection();
                true
            });
        }
        self.sync_forwards();
        let after = backend.runtimes(cancel);
        self.record_runtimes(after.clone());
        let after = after?;
        if after.errors.is_empty() && after.runtimes.is_empty() {
            self.lock().uncertain_cleanup = false;
        }
        self.refresh_usage_after_stop(backend, cancel);
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
