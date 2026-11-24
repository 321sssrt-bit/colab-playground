use colab_playground_core::{accounts::Account, backend::SwitchImpact};

use super::*;

#[derive(Serialize, Deserialize)]
pub struct AccountSwitchPreview {
    pub account_context: AccountContext,
    pub impact: SwitchImpact,
}

impl WebState {
    pub fn accounts_snapshot(&self) -> Arc<Snapshot> {
        self.mark_usage_age();
        self.snapshot()
    }

    pub async fn refresh_accounts(&self) -> Result<Arc<Snapshot>> {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            let accounts = backend.accounts(cancel);
            state.record_accounts(accounts.clone());
            accounts?;
            state.refresh_account_usage(backend, &[], cancel);
            Ok(state.snapshot())
        })
        .await
    }

    pub fn adopt_account(&self, expected: AccountContext) -> Result<Submission<Account>> {
        let state = self.clone();
        self.start_job(
            Operation::Domain {
                name: "adopt_account",
                key: String::new(),
            },
            Access::AccountWrite(expected),
            false,
            move |_, backend, cancel| {
                let result = backend.adopt_active_account(cancel);
                state.record_accounts(backend.accounts(&CancelToken::new()));
                state.record_usage(backend.usage());
                result
            },
        )
    }

    pub fn remove_account(
        &self,
        expected: AccountContext,
        id: AccountId,
    ) -> Result<Submission<()>> {
        let state = self.clone();
        self.start_job(
            Operation::Domain {
                name: "remove_account",
                key: id.to_string(),
            },
            Access::AccountWrite(expected),
            false,
            move |_, backend, cancel| {
                let snapshot = state.snapshot();
                if snapshot.account.active.as_ref() == Some(&id) {
                    return Err(Error::new(ErrorKind::InvalidInput).with("remove_active", "true"));
                }
                if !snapshot
                    .accounts
                    .as_ref()
                    .is_some_and(|view| view.accounts.iter().any(|account| account.id == id))
                {
                    return Err(Error::new(ErrorKind::AccountNotFound).with("account", id));
                }
                let result = backend.remove_account(&id, cancel);
                state.record_accounts(backend.accounts(&CancelToken::new()));
                state.record_usage(backend.usage());
                result
            },
        )
    }

    pub async fn preview_switch(&self, to: AccountId) -> Result<AccountSwitchPreview> {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let _poll = state.lock_poll_slot();
            let accounts = backend.accounts(cancel);
            state.record_accounts(accounts.clone());
            accounts?;
            Ok(AccountSwitchPreview {
                account_context: state.snapshot().account.clone(),
                impact: backend.switch_impact(&to)?,
            })
        })
        .await
    }

    pub fn confirm_switch(
        &self,
        preview: AccountSwitchPreview,
    ) -> Result<Submission<AccountsView>> {
        self.start_switch(
            preview.account_context,
            preview.impact.to.clone(),
            Some(preview.impact),
        )
    }

    pub fn switch_account(
        &self,
        account: AccountContext,
        to: AccountId,
    ) -> Result<Submission<AccountsView>> {
        self.start_switch(account, to, None)
    }

    fn start_switch(
        &self,
        account: AccountContext,
        to: AccountId,
        confirmed: Option<SwitchImpact>,
    ) -> Result<Submission<AccountsView>> {
        let state = self.clone();
        self.start_job(
            Operation::SwitchAccount { to: to.clone() },
            Access::AccountWrite(account),
            false,
            move |_, backend, cancel| {
                if let Some(confirmed) = confirmed {
                    let current = backend.switch_impact(&to)?;
                    if !same_impact(&confirmed, &current) {
                        return Err(
                            Error::new(ErrorKind::Busy).with("switch_impact_changed", "true")
                        );
                    }
                    cancel.check()?;
                }
                let result = backend.switch_account(&to, cancel);
                state.sync_forwards();
                state.record_accounts(result.clone());
                result
            },
        )
    }
}

fn same_impact(reviewed: &SwitchImpact, current: &SwitchImpact) -> bool {
    fn same_items<T, K: Ord>(reviewed: &[T], current: &[T], key: impl Fn(&T) -> K) -> bool {
        let mut reviewed: Vec<_> = reviewed.iter().map(&key).collect();
        let mut current: Vec<_> = current.iter().map(key).collect();
        reviewed.sort_unstable();
        current.sort_unstable();
        reviewed == current
    }

    // Health and measured spend can change while the user reads the preview.
    reviewed.from == current.from
        && same_items(
            &reviewed.tunnels_closing,
            &current.tunnels_closing,
            |tunnel| tunnel.id,
        )
        && same_items(
            &reviewed.sessions_left_running,
            &current.sessions_left_running,
            |session| (session.name.clone(), session.endpoint.clone()),
        )
        && match (
            &reviewed.unmanaged_left_running,
            &current.unmanaged_left_running,
        ) {
            (Some(reviewed), Some(current)) => {
                same_items(reviewed, current, |runtime| runtime.endpoint.clone())
            }
            (None, None) => true,
            _ => false,
        }
}
