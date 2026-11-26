use std::sync::{Arc, Mutex, MutexGuard, mpsc};

use colab_playground_core::{
    CancelToken, Error, ErrorKind, Result, backend::InstallMethod, host::Line,
};
use serde::Serialize;
use tokio::{sync::watch, task::spawn_blocking};

use super::{Operation, Slot, WebState};

pub const INSTALL_CLI_OP: &str = "install_cli";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliInstallPhase {
    #[default]
    Idle,
    Running,
    Checking,
    Succeeded,
    NotFound,
    ProbeFailed,
    Cancelled,
    Failed,
}

impl CliInstallPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Checking => "checking",
            Self::Succeeded => "succeeded",
            Self::NotFound => "not_found",
            Self::ProbeFailed => "probe_failed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }

    /// Legacy SSE `finished.status` value (`succeeded | cancelled | failed`) for wire compatibility.
    pub fn wire_status(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Cancelled => "cancelled",
            Self::NotFound
            | Self::Failed
            | Self::ProbeFailed
            | Self::Idle
            | Self::Running
            | Self::Checking => "failed",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CliInstallSummary {
    pub id: Option<u64>,
    pub method: Option<InstallMethod>,
    pub phase: CliInstallPhase,
    pub cancelling: bool,
    pub line_count: usize,
    pub error_kind: Option<ErrorKind>,
}

#[derive(Debug, Clone, Default)]
pub struct CliInstallSnapshot {
    pub id: Option<u64>,
    pub method: Option<InstallMethod>,
    pub phase: CliInstallPhase,
    pub cancelling: bool,
    pub lines: Vec<Line>,
    pub error: Option<Error>,
}

#[derive(Debug, Clone)]
pub struct CliInstallOutcome {
    pub phase: CliInstallPhase,
    pub cli_installed: bool,
    pub error: Option<Error>,
}

#[derive(Debug, Clone)]
pub enum CliInstallEvent {
    Started { id: u64, method: InstallMethod },
    Line(Line),
    Finished(CliInstallOutcome),
}

pub enum CliInstallStart {
    Started { id: u64, events: CliInstallEvents },
    AlreadyRunning { id: u64 },
}

pub struct CliInstallSession {
    id: u64,
    method: InstallMethod,
    journal: Mutex<InstallJournal>,
    changes: watch::Sender<()>,
}

struct InstallJournal {
    lines: Vec<Line>,
    phase: CliInstallPhase,
    cancelling: bool,
    outcome: Option<CliInstallOutcome>,
}

impl CliInstallSession {
    fn new(id: u64, method: InstallMethod) -> Self {
        Self {
            id,
            method,
            journal: Mutex::new(InstallJournal {
                lines: Vec::new(),
                phase: CliInstallPhase::Running,
                cancelling: false,
                outcome: None,
            }),
            changes: watch::channel(()).0,
        }
    }

    fn lock(&self) -> MutexGuard<'_, InstallJournal> {
        self.journal
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn push_line(&self, line: Line) {
        let mut journal = self.lock();
        journal.lines.push(line);
        self.changes.send_replace(());
    }

    fn set_phase(&self, phase: CliInstallPhase) {
        let mut journal = self.lock();
        journal.phase = phase;
        if phase != CliInstallPhase::Running {
            journal.cancelling = false;
        }
    }

    fn set_cancelling(&self) -> bool {
        let mut journal = self.lock();
        if journal.phase != CliInstallPhase::Running || journal.cancelling {
            return false;
        }
        journal.cancelling = true;
        true
    }

    fn store_outcome(&self, outcome: CliInstallOutcome) {
        let mut journal = self.lock();
        journal.phase = outcome.phase;
        journal.cancelling = false;
        journal.outcome = Some(outcome);
    }

    fn notify_subscribers(&self) {
        self.changes.send_replace(());
    }

    fn begin_recheck(&self) -> Option<CliInstallOutcome> {
        let mut journal = self.lock();
        if !matches!(
            journal.phase,
            CliInstallPhase::NotFound | CliInstallPhase::ProbeFailed
        ) {
            return None;
        }
        let previous = journal.outcome.take().unwrap_or(CliInstallOutcome {
            phase: journal.phase,
            cli_installed: false,
            error: None,
        });
        journal.phase = CliInstallPhase::Checking;
        Some(previous)
    }

    fn finish_recheck(&self, outcome: CliInstallOutcome) {
        self.store_outcome(outcome);
        self.notify_subscribers();
    }

    fn summary(&self) -> CliInstallSummary {
        let journal = self.lock();
        CliInstallSummary {
            id: Some(self.id),
            method: Some(self.method),
            phase: journal.phase,
            cancelling: journal.cancelling,
            line_count: journal.lines.len(),
            error_kind: journal
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.error.as_ref().map(|error| error.kind)),
        }
    }

    fn snapshot(&self) -> CliInstallSnapshot {
        let journal = self.lock();
        CliInstallSnapshot {
            id: Some(self.id),
            method: Some(self.method),
            phase: journal.phase,
            cancelling: journal.cancelling,
            lines: journal.lines.clone(),
            error: journal
                .outcome
                .as_ref()
                .and_then(|outcome| outcome.error.clone()),
        }
    }

    fn subscribe(self: &Arc<Self>) -> CliInstallEvents {
        CliInstallEvents {
            session: self.clone(),
            changes: self.changes.subscribe(),
            started_sent: false,
            next_line: 0,
            finished_sent: false,
        }
    }
}

pub struct CliInstallEvents {
    session: Arc<CliInstallSession>,
    changes: watch::Receiver<()>,
    started_sent: bool,
    next_line: usize,
    finished_sent: bool,
}

impl CliInstallEvents {
    pub async fn next(&mut self) -> Option<CliInstallEvent> {
        if !self.started_sent {
            self.started_sent = true;
            return Some(CliInstallEvent::Started {
                id: self.session.id,
                method: self.session.method,
            });
        }
        if self.finished_sent {
            return None;
        }
        loop {
            self.changes.borrow_and_update();
            {
                let journal = self.session.lock();
                if let Some(line) = journal.lines.get(self.next_line).cloned() {
                    self.next_line += 1;
                    return Some(CliInstallEvent::Line(line));
                }
                if let Some(outcome) = journal.outcome.clone() {
                    self.finished_sent = true;
                    return Some(CliInstallEvent::Finished(outcome));
                }
            }
            self.changes.changed().await.ok()?;
        }
    }
}

struct InstallFinishGuard {
    state: WebState,
    session: Arc<CliInstallSession>,
    armed: bool,
}

impl InstallFinishGuard {
    fn new(state: WebState, session: Arc<CliInstallSession>) -> Self {
        Self {
            state,
            session,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for InstallFinishGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.session.store_outcome(CliInstallOutcome {
            phase: CliInstallPhase::Failed,
            cli_installed: false,
            error: Some(Error::new(ErrorKind::Other)),
        });
        self.state.publish_cli_install();
        self.session.notify_subscribers();
    }
}

pub(super) struct CliRecheckGuard {
    state: WebState,
    active: Option<(Arc<CliInstallSession>, CliInstallOutcome)>,
}

impl CliRecheckGuard {
    pub(super) fn finish(mut self, outcome: CliInstallOutcome) {
        if let Some((session, _)) = self.active.take() {
            session.finish_recheck(outcome);
            self.state.publish_cli_install();
        }
    }

    pub(super) fn restore(mut self) {
        if let Some((session, previous)) = self.active.take() {
            session.finish_recheck(previous);
            self.state.publish_cli_install();
        }
    }
}

impl Drop for CliRecheckGuard {
    fn drop(&mut self) {
        if let Some((session, previous)) = self.active.take() {
            session.finish_recheck(previous);
            self.state.publish_cli_install();
        }
    }
}

impl WebState {
    pub fn start_cli_install(&self, method: InstallMethod) -> Result<CliInstallStart> {
        let operation = Operation::Domain {
            name: INSTALL_CLI_OP,
            key: String::new(),
        };
        let (job, session, events) = {
            let mut control = self.lock();
            if control.shutting_down {
                return Err(Error::cancelled());
            }
            if let Some((&id, _)) = control
                .running
                .iter()
                .find(|(_, running)| running.operation.as_ref() == Some(&operation))
            {
                return Ok(CliInstallStart::AlreadyRunning { id });
            }
            if !control.available(Slot::Exclusive) {
                return Err(Error::new(ErrorKind::Busy));
            }
            let job = self.reserve(&mut control, Some(operation), Slot::Exclusive, false);
            let session = Arc::new(CliInstallSession::new(job.id, method));
            let events = session.subscribe();
            *self.cli_install_lock() = Some(session.clone());
            (job, session, events)
        };
        self.publish_cli_install();

        let id = job.id;
        let state = self.clone();
        spawn_blocking(move || {
            let mut finish_guard = InstallFinishGuard::new(state.clone(), session.clone());
            let poll = state.lock_poll_slot();
            let outcome = if job.cancel.is_cancelled() {
                CliInstallOutcome {
                    phase: CliInstallPhase::Cancelled,
                    cli_installed: false,
                    error: Some(Error::cancelled()),
                }
            } else {
                let backend = state.backend();
                let (tx, rx) = mpsc::channel::<Line>();
                let (drained_tx, drained_rx) = mpsc::channel::<()>();
                let log_session = session.clone();
                let log_state = state.clone();
                spawn_blocking(move || {
                    for line in rx {
                        log_session.push_line(line);
                        log_state.publish_cli_install();
                    }
                    let _ = drained_tx.send(());
                });
                let install_result = backend.install_cli(method, tx, &job.cancel);
                // `tx` was moved into `install_cli` and is now dropped; drain every line first.
                let _ = drained_rx.recv();

                match install_result {
                    Ok(()) => {
                        if job.cancel.commit().is_err() {
                            CliInstallOutcome {
                                phase: CliInstallPhase::Cancelled,
                                cli_installed: false,
                                error: Some(Error::cancelled()),
                            }
                        } else {
                            session.set_phase(CliInstallPhase::Checking);
                            state.reset_cli_probe();
                            state.publish_cli_install();
                            let probe_cancel = CancelToken::new();
                            match backend.probe(&probe_cancel) {
                                Ok(report) if report.colab.is_some() => {
                                    state.set_cli_installed(true);
                                    state.refresh_overview(&*backend, &probe_cancel);
                                    CliInstallOutcome {
                                        phase: CliInstallPhase::Succeeded,
                                        cli_installed: true,
                                        error: None,
                                    }
                                }
                                Ok(_) => {
                                    state.set_cli_installed(false);
                                    state.clear_overview(backend.measured_rates());
                                    CliInstallOutcome {
                                        phase: CliInstallPhase::NotFound,
                                        cli_installed: false,
                                        error: None,
                                    }
                                }
                                Err(error) if error.is(ErrorKind::NotInstalled) => {
                                    state.set_cli_installed(false);
                                    state.clear_overview(backend.measured_rates());
                                    CliInstallOutcome {
                                        phase: CliInstallPhase::NotFound,
                                        cli_installed: false,
                                        error: None,
                                    }
                                }
                                Err(error) => {
                                    state.set_cli_installed(false);
                                    state.clear_overview(backend.measured_rates());
                                    CliInstallOutcome {
                                        phase: CliInstallPhase::ProbeFailed,
                                        cli_installed: false,
                                        error: Some(error),
                                    }
                                }
                            }
                        }
                    }
                    Err(error) if error.is(ErrorKind::Cancelled) => CliInstallOutcome {
                        phase: CliInstallPhase::Cancelled,
                        cli_installed: false,
                        error: Some(error),
                    },
                    Err(error) => CliInstallOutcome {
                        phase: CliInstallPhase::Failed,
                        cli_installed: false,
                        error: Some(error),
                    },
                }
            };
            session.store_outcome(outcome);
            state.publish_cli_install();
            finish_guard.disarm();
            // Release poll_slot and Slot::Exclusive before waking SSE subscribers so immediate
            // follow-up requests (such as GET /api/overview) never see a transient 409 Busy.
            drop(poll);
            drop(job);
            session.notify_subscribers();
        });

        Ok(CliInstallStart::Started { id, events })
    }

    pub fn cli_install_snapshot(&self) -> CliInstallSnapshot {
        self.cli_install_lock()
            .as_ref()
            .map(|session| session.snapshot())
            .unwrap_or_default()
    }

    pub fn subscribe_cli_install(&self, id: Option<u64>) -> Option<CliInstallEvents> {
        let session = self.cli_install_lock().clone()?;
        if let Some(expected) = id
            && session.id != expected
        {
            return None;
        }
        Some(session.subscribe())
    }

    pub fn cancel_cli_install(&self, id: u64) -> bool {
        let installing = self.snapshot().operations.iter().any(|pending| {
            pending.id == id
                && matches!(
                    pending.operation,
                    Operation::Domain {
                        name: INSTALL_CLI_OP,
                        ..
                    }
                )
        });
        if !installing {
            return false;
        }
        let cancelled = self.cancel(id);
        if cancelled {
            self.mark_cli_install_cancelling(id);
        }
        cancelled
    }

    pub(super) fn mark_cli_install_cancelling(&self, id: u64) {
        let changed = self
            .cli_install_lock()
            .as_ref()
            .filter(|session| session.id == id)
            .is_some_and(|session| session.set_cancelling());
        if changed {
            self.publish_cli_install();
        }
    }

    pub(super) fn clear_cli_install(&self) {
        let had_session = self.cli_install_lock().take().is_some();
        if had_session {
            self.publish_cli_install();
        }
    }

    pub(super) fn begin_cli_recheck(&self) -> CliRecheckGuard {
        let active = self.cli_install_lock().clone().and_then(|session| {
            let previous = session.begin_recheck()?;
            Some((session, previous))
        });
        if active.is_some() {
            self.publish_cli_install();
        }
        CliRecheckGuard {
            state: self.clone(),
            active,
        }
    }

    pub(super) fn publish_cli_install(&self) {
        let summary = self
            .cli_install_lock()
            .as_ref()
            .map(|session| session.summary())
            .unwrap_or_default();
        self.update(|snapshot| {
            if snapshot.cli_install == summary {
                return false;
            }
            snapshot.cli_install = summary;
            true
        });
    }

    fn cli_install_lock(&self) -> MutexGuard<'_, Option<Arc<CliInstallSession>>> {
        self.0
            .cli_install
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }
}
