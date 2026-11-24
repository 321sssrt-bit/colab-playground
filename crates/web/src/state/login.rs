use colab_playground_core::{accounts::Account, backend::LoginFlow};
use tokio::time::{Instant, sleep_until};

use super::*;

pub(super) struct PendingLogin {
    pub(super) id: u64,
    expires: Instant,
    pub(super) flow: Box<dyn LoginFlow>,
}

#[derive(Serialize)]
pub struct LoginPrompt {
    pub id: u64,
    pub auth_url: String,
}

impl WebState {
    pub fn begin_login(&self, account: AccountContext) -> Result<Submission<LoginPrompt>> {
        let state = self.clone();
        self.start_job(
            Operation::Login { login_id: None },
            Access::AccountWrite(account),
            false,
            move |id, backend, cancel| {
                let result = backend.begin_add_account(cancel);
                state.sync_forwards();
                let flow = result.inspect_err(|_| {
                    state.record_accounts(backend.accounts(&CancelToken::new()));
                })?;
                let auth_url = flow.auth_url().to_owned();
                let mut control = state.lock();
                if control.shutting_down || cancel.commit().is_err() {
                    drop(control);
                    let result = flow.cancel();
                    state.record_accounts(backend.accounts(&CancelToken::new()));
                    result?;
                    return Err(Error::cancelled());
                }
                let expires = Instant::now() + state.0.login_inactivity;
                control.login = Some(PendingLogin { id, expires, flow });
                drop(control);
                tokio::spawn(async move {
                    sleep_until(expires).await;
                    let _ = state.finish_login(&mut state.lock(), id, Finish::Cancel);
                });
                Ok(LoginPrompt { id, auth_url })
            },
        )
    }

    pub fn submit_login(&self, id: u64, code: String) -> Result<Submission<Option<Account>>> {
        self.finish_login(&mut self.lock(), id, Finish::Submit(code))
    }

    /// Returns a rollback job for a pending prompt, or acknowledges an in-flight cancel.
    pub fn cancel_login(&self, id: u64) -> Result<Option<Submission<Option<Account>>>> {
        let mut control = self.lock();
        if control.shutting_down {
            return Err(Error::cancelled());
        }
        if control.login.as_ref().is_some_and(|login| login.id == id) {
            return self
                .finish_login(&mut control, id, Finish::Cancel)
                .map(Some);
        }
        let cancelled = control.running.iter().any(|(&job_id, running)| {
            matches!(
                running.operation,
                Some(Operation::Login { login_id }) if login_id.unwrap_or(job_id) == id
            ) && running.cancel.cancel()
        });
        if cancelled {
            self.publish_operations(&control);
            return Ok(None);
        }
        Err(Error::new(ErrorKind::LoginCancelled))
    }

    fn finish_login(
        &self,
        control: &mut Control,
        id: u64,
        finish: Finish,
    ) -> Result<Submission<Option<Account>>> {
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
        let id = job.id;
        // Once the pending flow has been taken, complete it or explicitly roll it back.
        let job = spawn_blocking(move || {
            let result = match finish {
                Finish::Submit(code) if !job.cancel.is_cancelled() => {
                    pending.flow.submit_code(&code, &job.cancel).map(Some)
                }
                _ => pending.flow.cancel().map(|()| None),
            };
            let saved = matches!(&result, Ok(Some(_)));
            if saved {
                let _ = job.cancel.commit();
            }
            let backend = &job.state.0.backend;
            job.state
                .record_accounts(backend.accounts(&CancelToken::new()));
            if saved {
                job.state.record_usage(backend.usage());
            }
            result
        });
        Ok(Submission::Started { id, job })
    }
}

enum Finish {
    Submit(String),
    Cancel,
}
