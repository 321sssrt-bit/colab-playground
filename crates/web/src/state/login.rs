use colab_playground_core::{accounts::Account, backend::LoginFlow};
use tokio::time::{Instant, sleep_until};

use super::*;

pub(super) struct PendingLogin {
    id: u64,
    expires: Instant,
    pub(super) flow: Box<dyn LoginFlow>,
}

pub struct LoginPrompt {
    pub id: u64,
    pub auth_url: String,
}

impl WebState {
    pub fn begin_login(&self, account: AccountContext) -> Result<Submission<LoginPrompt>> {
        let state = self.clone();
        self.start_job(
            Operation::Login,
            Access::AccountWrite(account),
            false,
            move |backend, cancel| {
                let flow = backend.begin_add_account(cancel)?;
                let auth_url = flow.auth_url().to_owned();
                let mut control = state.lock();
                let id = control.next_id;
                let expires = Instant::now() + state.0.login_inactivity;
                control.login = Some(PendingLogin { id, expires, flow });
                drop(control);
                tokio::spawn(async move {
                    sleep_until(expires).await;
                    let _ = state.finish_login(id, Finish::Cancel);
                });
                Ok(LoginPrompt { id, auth_url })
            },
        )
    }

    pub fn submit_login(&self, id: u64, code: String) -> Result<Submission<Option<Account>>> {
        self.finish_login(id, Finish::Submit(code))
    }

    pub fn cancel_login(&self, id: u64) -> Result<Submission<Option<Account>>> {
        self.finish_login(id, Finish::Cancel)
    }

    fn finish_login(&self, id: u64, finish: Finish) -> Result<Submission<Option<Account>>> {
        let mut control = self.lock();
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
        let job = self.reserve(&mut control, Some(Operation::Login), Slot::Exclusive, false);
        let id = job.id;
        // Once the pending flow has been taken, complete it or explicitly roll it back.
        let job = spawn_blocking(move || {
            let result = match finish {
                Finish::Submit(code) if !job.cancel.is_cancelled() => {
                    pending.flow.submit_code(&code, &job.cancel).map(Some)
                }
                _ => pending.flow.cancel().map(|()| None),
            };
            let backend = &job.state.0.backend;
            job.state
                .record_accounts(backend.accounts(&CancelToken::new()));
            result
        });
        Ok(Submission::Started { id, job })
    }
}

enum Finish {
    Submit(String),
    Cancel,
}
