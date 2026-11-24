use colab_playground_core::{accounts::Account, backend::SwitchImpact};

use super::*;

#[derive(Serialize)]
pub struct AccountSwitchPreview {
    #[serde(flatten)]
    approval: AccountSwitchApproval,
    impact: SwitchImpact,
}

#[derive(Serialize, Deserialize)]
pub struct AccountSwitchApproval {
    account_context: AccountContext,
    confirmation: SwitchConfirmation,
}

impl AccountSwitchApproval {
    pub fn target(&self) -> &AccountId {
        &self.confirmation.to
    }
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
struct SwitchConfirmation {
    from: Option<AccountId>,
    to: AccountId,
    forwards: Vec<TunnelId>,
    managed: Vec<(String, Option<String>)>,
    unmanaged: Option<Vec<String>>,
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
            let impact = backend.switch_impact(&to)?;
            Ok(AccountSwitchPreview {
                approval: AccountSwitchApproval {
                    account_context: state.snapshot().account.clone(),
                    confirmation: SwitchConfirmation::from(&impact),
                },
                impact,
            })
        })
        .await
    }

    pub fn confirm_switch(
        &self,
        approval: AccountSwitchApproval,
    ) -> Result<Submission<AccountsView>> {
        self.start_switch(
            approval.account_context,
            approval.confirmation.to.clone(),
            Some(approval.confirmation),
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
        confirmed: Option<SwitchConfirmation>,
    ) -> Result<Submission<AccountsView>> {
        let state = self.clone();
        self.start_job(
            Operation::SwitchAccount { to: to.clone() },
            Access::AccountWrite(account),
            false,
            move |_, backend, cancel| {
                if let Some(confirmed) = confirmed {
                    let current = backend.switch_impact(&to)?;
                    if confirmed != SwitchConfirmation::from(&current) {
                        return Err(
                            Error::new(ErrorKind::Busy).with("switch_impact_changed", "true")
                        );
                    }
                    cancel.check()?;
                }
                let result = backend.switch_account(&to, cancel);
                state.sync_forwards();
                let view = match result {
                    Ok(view) => view,
                    Err(error) => {
                        state.record_accounts(backend.accounts(&CancelToken::new()));
                        return Err(error);
                    }
                };
                state.record_accounts(Ok(view));
                Ok(state
                    .snapshot()
                    .accounts
                    .clone()
                    .expect("account switch recorded"))
            },
        )
    }
}

impl From<&SwitchImpact> for SwitchConfirmation {
    fn from(impact: &SwitchImpact) -> Self {
        // Health and measured spend can change while the user reads the preview.
        let mut forwards: Vec<_> = impact
            .tunnels_closing
            .iter()
            .map(|tunnel| tunnel.id)
            .collect();
        forwards.sort_unstable();
        let mut managed: Vec<_> = impact
            .sessions_left_running
            .iter()
            .map(|session| (session.name.clone(), session.endpoint.clone()))
            .collect();
        managed.sort_unstable();
        let unmanaged = impact.unmanaged_left_running.as_ref().map(|runtimes| {
            let mut endpoints: Vec<_> = runtimes
                .iter()
                .map(|runtime| runtime.endpoint.clone())
                .collect();
            endpoints.sort_unstable();
            endpoints
        });
        Self {
            from: impact.from.clone(),
            to: impact.to.clone(),
            forwards,
            managed,
            unmanaged,
        }
    }
}
