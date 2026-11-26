use colab_playground_core::{
    accounts::{Account, AccountsView},
    backend::LoginFlow,
};
use tokio::{
    sync::watch,
    task::AbortHandle,
    time::{Instant, sleep_until},
};

use super::*;

struct AbortOnDrop(AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(super) struct PendingLogin {
    pub(super) id: u64,
    expires: Instant,
    pub(super) flow: Box<dyn LoginFlow>,
    _timer: AbortOnDrop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveLoginPhase {
    Starting,
    Submitting,
    Cancelling,
}

#[derive(Debug, Clone)]
enum LoginSettled {
    Cancelled,
    Completed(Account),
    Failed(Error),
}

type SettledReceiver = watch::Receiver<Option<LoginSettled>>;

pub(super) struct ActiveLoginJob {
    pub(super) login_id: u64,
    pub(super) job_id: u64,
    phase: ActiveLoginPhase,
    cancel: CancelToken,
    settled: SettledReceiver,
}

struct SettleGuard(Option<watch::Sender<Option<LoginSettled>>>);

impl SettleGuard {
    fn new(tx: watch::Sender<Option<LoginSettled>>) -> Self {
        Self(Some(tx))
    }

    fn send(&mut self, outcome: LoginSettled) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(Some(outcome));
        }
    }

    fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        // Declared before the job guard so exclusive locks are released even on unwind.
        self.send(LoginSettled::Failed(Error::new(ErrorKind::Other)));
    }
}

#[derive(Serialize)]
pub struct LoginPrompt {
    pub id: u64,
    pub auth_url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CancelLoginOutcome {
    RolledBack,
    SubmittingSettled(Box<SubmitCancelSettlement>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SubmitCancelSettlement {
    pub outcome: SubmitCancelOutcome,
    pub account_context: AccountContext,
    pub accounts: AccountsView,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SubmitCancelOutcome {
    Cancelled,
    Completed(Account),
    Failed(Error),
}

impl WebState {
    pub fn begin_login(&self, account: AccountContext) -> Result<Submission<LoginPrompt>> {
        let mut control = self.lock();
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        self.check_account_context(&account)?;
        let operation = Operation::Login { login_id: None };
        if let Some((&id, _)) = control
            .running
            .iter()
            .find(|(_, running)| running.operation.as_ref() == Some(&operation))
        {
            return Ok(Submission::AlreadyRunning { id });
        }
        if !control.available(Slot::Exclusive) {
            return Err(Error::new(ErrorKind::Busy));
        }
        let job = self.reserve(&mut control, Some(operation), Slot::Exclusive, false);
        let id = job.id;
        let (settled_tx, settled_rx) = watch::channel(None);
        control.login_job = Some(ActiveLoginJob {
            login_id: id,
            job_id: id,
            phase: ActiveLoginPhase::Starting,
            cancel: job.cancel.clone(),
            settled: settled_rx,
        });
        drop(control);

        let task = spawn_blocking(move || {
            let mut settle = SettleGuard::new(settled_tx);
            let mut job = job;
            let state = job.state.clone();
            let poll = state.lock_poll_slot();

            let precheck = job
                .cancel
                .check()
                .and_then(|()| state.verify_account(&account, &job.cancel));
            if let Err(error) = precheck {
                drop(poll);
                let cancelled = job.cancel.is_cancelled();
                drop(job);
                settle.send(settled_from_start_error(&error, cancelled));
                return Err(error);
            }

            let result = state.0.backend.begin_add_account(&job.cancel);
            state.sync_forwards();
            let flow = match result {
                Ok(flow) => flow,
                Err(error) => {
                    let accounts_err = record_accounts_after_login(&state);
                    drop(poll);
                    let cancelled = job.cancel.is_cancelled();
                    drop(job);
                    let settled = match accounts_err {
                        Some(err) if is_start_cancel(&error, cancelled) => {
                            LoginSettled::Failed(err)
                        }
                        _ => settled_from_start_error(&error, cancelled),
                    };
                    settle.send(settled);
                    return Err(error);
                }
            };

            let auth_url = flow.auth_url().to_owned();
            let mut control = state.lock();
            if control.shutting_down || job.cancel.commit().is_err() {
                drop(control);
                let cancel_result = flow.cancel();
                let accounts_err = record_accounts_after_login(&state);
                drop(poll);
                drop(job);
                let settled = match (&cancel_result, accounts_err) {
                    (Err(error), _) => LoginSettled::Failed(error.clone()),
                    (Ok(()), Some(error)) => LoginSettled::Failed(error),
                    (Ok(()), None) => LoginSettled::Cancelled,
                };
                settle.send(settled);
                cancel_result?;
                return Err(Error::cancelled());
            }

            let expires = Instant::now() + state.0.login_inactivity;
            let timeout_state = state.clone();
            let timer = tokio::spawn(async move {
                sleep_until(expires).await;
                let _ =
                    timeout_state.start_finish_login(&mut timeout_state.lock(), id, Finish::Cancel);
            })
            .abort_handle();
            control.login = Some(PendingLogin {
                id,
                expires,
                flow,
                _timer: AbortOnDrop(timer),
            });
            job.finish_locked(&mut control);
            drop(control);
            drop(poll);
            settle.disarm();
            Ok(LoginPrompt { id, auth_url })
        });
        Ok(Submission::Started { id, job: task })
    }

    pub fn submit_login(&self, id: u64, code: String) -> Result<Submission<Option<Account>>> {
        let mut control = self.lock();
        self.start_finish_login(&mut control, id, Finish::Submit(code))
            .map(|(submission, _)| submission)
    }

    /// Cancels a starting or pending login when the HTTP client drops `begin_login` mid-flight.
    pub fn abort_login_start(&self, id: u64) {
        let mut control = self.lock();
        if control.shutting_down {
            return;
        }
        if control.login.as_ref().is_some_and(|login| login.id == id) {
            let _ = self.start_finish_login(&mut control, id, Finish::Cancel);
            return;
        }
        if let Some(active) = control
            .login_job
            .as_ref()
            .filter(|active| active.login_id == id && active.phase == ActiveLoginPhase::Starting)
            && active.cancel.cancel()
        {
            self.publish_operations(&control);
        }
    }

    /// Starts or joins cancellation of an active or pending login flow.
    pub fn cancel_login(&self, id: u64) -> Result<Option<Submission<Option<Account>>>> {
        let mut control = self.lock();
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        if control.login.as_ref().is_some_and(|login| login.id == id) {
            return self
                .start_finish_login(&mut control, id, Finish::Cancel)
                .map(|(submission, _)| Some(submission));
        }
        if let Some(active) = control
            .login_job
            .as_ref()
            .filter(|active| active.login_id == id)
        {
            if active.cancel.cancel() {
                self.publish_operations(&control);
            }
            let job_id = active.job_id;
            let mut rx = active.settled.clone();
            drop(control);
            let job = tokio::spawn(async move {
                let settled = wait_settled(&mut rx).await?;
                match settled {
                    LoginSettled::Cancelled => Ok(None),
                    LoginSettled::Completed(account) => Ok(Some(account)),
                    LoginSettled::Failed(error) => Err(error),
                }
            });
            return Ok(Some(Submission::Started { id: job_id, job }));
        }
        Err(Error::new(ErrorKind::LoginCancelled))
    }

    /// Cancels a matching login (or whichever login is active when `id` is `None`) and waits
    /// until its submission or rollback finishes and releases the exclusive slot.
    pub async fn cancel_login_settled(&self, id: Option<u64>) -> Result<CancelLoginOutcome> {
        let (phase, mut rx) = {
            let mut control = self.lock();
            if control.shutting_down {
                return Err(Error::cancelled());
            }
            if let Some(pending_id) = control
                .login
                .as_ref()
                .map(|login| login.id)
                .filter(|&pending_id| id.is_none_or(|target| target == pending_id))
            {
                let (_, rx) = self.start_finish_login(&mut control, pending_id, Finish::Cancel)?;
                (ActiveLoginPhase::Cancelling, rx)
            } else if let Some(active) = control
                .login_job
                .as_ref()
                .filter(|active| id.is_none_or(|target| target == active.login_id))
            {
                if active.cancel.cancel() {
                    self.publish_operations(&control);
                }
                (active.phase, active.settled.clone())
            } else {
                return Err(Error::new(ErrorKind::LoginCancelled));
            }
        };

        let settled = wait_settled(&mut rx).await?;
        match phase {
            ActiveLoginPhase::Starting | ActiveLoginPhase::Cancelling => match settled {
                LoginSettled::Cancelled => Ok(CancelLoginOutcome::RolledBack),
                LoginSettled::Failed(error) => Err(error),
                LoginSettled::Completed(_) => Err(Error::new(ErrorKind::Other)),
            },
            ActiveLoginPhase::Submitting => {
                let snapshot = self.snapshot();
                if let Some(error) = snapshot.accounts_error {
                    return Err(Error::new(error));
                }
                let accounts = snapshot
                    .accounts
                    .clone()
                    .ok_or_else(|| Error::new(ErrorKind::Other))?;
                let outcome = match settled {
                    LoginSettled::Cancelled => SubmitCancelOutcome::Cancelled,
                    LoginSettled::Completed(account) => SubmitCancelOutcome::Completed(account),
                    LoginSettled::Failed(error) => SubmitCancelOutcome::Failed(error),
                };
                Ok(CancelLoginOutcome::SubmittingSettled(Box::new(
                    SubmitCancelSettlement {
                        outcome,
                        account_context: snapshot.account.clone(),
                        accounts,
                    },
                )))
            }
        }
    }

    fn start_finish_login(
        &self,
        control: &mut Control,
        id: u64,
        finish: Finish,
    ) -> Result<(Submission<Option<Account>>, SettledReceiver)> {
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        let pending = control
            .login
            .take_if(|login| {
                login.id == id
                    && (matches!(finish, Finish::Cancel) || Instant::now() < login.expires)
            })
            .ok_or_else(|| Error::new(ErrorKind::LoginCancelled))?;
        let job = self.reserve(
            control,
            Some(Operation::Login { login_id: Some(id) }),
            Slot::Exclusive,
            false,
        );
        let job_id = job.id;
        let phase = match &finish {
            Finish::Submit(_) => ActiveLoginPhase::Submitting,
            Finish::Cancel => ActiveLoginPhase::Cancelling,
        };
        let (settled_tx, settled_rx) = watch::channel(None);
        control.login_job = Some(ActiveLoginJob {
            login_id: id,
            job_id,
            phase,
            cancel: job.cancel.clone(),
            settled: settled_rx.clone(),
        });
        // Once the pending flow has been taken, complete it or explicitly roll it back.
        let task = spawn_blocking(move || {
            let mut settle = SettleGuard::new(settled_tx);
            let job = job;
            let state = job.state.clone();
            let result = match finish {
                Finish::Submit(code) if !job.cancel.is_cancelled() => {
                    pending.flow.submit_code(&code, &job.cancel).map(Some)
                }
                _ => pending.flow.cancel().map(|()| None),
            };
            if matches!(&result, Ok(Some(_))) {
                let _ = job.cancel.commit();
            }
            let accounts_err = record_accounts_after_login(&state);
            let published =
                result.map(|account| account.map(|account| state.published_account(account)));
            let settled = match &published {
                Ok(Some(account)) => LoginSettled::Completed(account.clone()),
                Ok(None) => match accounts_err {
                    Some(err) => LoginSettled::Failed(err),
                    None => LoginSettled::Cancelled,
                },
                Err(error) if error.is(ErrorKind::Cancelled) => match accounts_err {
                    Some(err) => LoginSettled::Failed(err),
                    None => LoginSettled::Cancelled,
                },
                Err(error) => LoginSettled::Failed(error.clone()),
            };
            // Release Slot::Exclusive before waking waiters so immediate follow-up writes succeed.
            drop(job);
            settle.send(settled);
            published
        });
        Ok((
            Submission::Started {
                id: job_id,
                job: task,
            },
            settled_rx,
        ))
    }
}

fn record_accounts_after_login(state: &WebState) -> Option<Error> {
    let accounts = state.0.backend.accounts(&CancelToken::new());
    let err = accounts.as_ref().err().cloned();
    state.record_accounts(accounts);
    err
}

fn is_start_cancel(error: &Error, cancelled: bool) -> bool {
    error.is(ErrorKind::Cancelled) || (cancelled && error.is(ErrorKind::LoginCancelled))
}

fn settled_from_start_error(error: &Error, cancelled: bool) -> LoginSettled {
    if is_start_cancel(error, cancelled) {
        LoginSettled::Cancelled
    } else {
        LoginSettled::Failed(error.clone())
    }
}

async fn wait_settled(rx: &mut watch::Receiver<Option<LoginSettled>>) -> Result<LoginSettled> {
    Ok(rx
        .wait_for(Option::is_some)
        .await
        .map_err(|_| Error::new(ErrorKind::Other))?
        .clone()
        .expect("settled login outcome"))
}

enum Finish {
    Submit(String),
    Cancel,
}
