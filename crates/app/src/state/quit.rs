//! Quitting while runtimes still bill. The window's close check (Ely's `guard_close`, which
//! covers the drawn and the system close) asks [`AppState::may_close`]; when something is
//! billing, or the app cannot tell, it opens the quit prompt instead of closing.
//!
//! "Leave running" is only described as watched by a watchdog for runtimes that have one;
//! runtimes opened elsewhere, or whose watchdog failed or was cancelled, have no automatic
//! stop and the prompt says so. "Stop all" closes only after every stop returned.

use colab_playground_core::{Error, backend::RuntimeRef};
use gpui::Context;

use super::{AppState, Load, Op, Overlay};

/// What is still running or starting when the window is closed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Billing {
    /// Runtimes whose watchdog will stop them (deadline set, not cancelled).
    pub watched: Vec<RuntimeRef>,
    /// Runtimes with no automatic stop.
    pub unwatched: Vec<RuntimeRef>,
    /// A runtime is being provisioned.
    pub provisioning: bool,
    /// A plugin run is under way.
    pub running_plugin: bool,
    /// The runtime list could not be loaded, so there may be more.
    pub unknown: bool,
}

impl Billing {
    /// Whether anything may be billing.
    pub fn any(&self) -> bool {
        !self.watched.is_empty()
            || !self.unwatched.is_empty()
            || self.provisioning
            || self.running_plugin
            || self.unknown
    }
}

/// The quit prompt.
#[derive(Clone, Debug, PartialEq)]
pub struct QuitPrompt {
    /// What bills.
    pub billing: Billing,
    /// Stops that failed during "Stop all".
    pub failures: Vec<(String, Error)>,
}

/// The close decision.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuitState {
    /// Ask before closing.
    #[default]
    Ask,
    /// The user decided; the window may close.
    Approved,
}

impl AppState {
    /// What would keep billing if the app closed now.
    pub fn billing(&self) -> Billing {
        let mut billing = Billing {
            provisioning: self.ops.is_running(Op::Provision),
            running_plugin: self.ops.is_running(Op::PluginRun),
            ..Billing::default()
        };
        match &self.sessions.runtimes {
            Load::Ready(view) => {
                for runtime in &view.runtimes {
                    let watched = runtime
                        .tracked
                        .as_ref()
                        .and_then(|t| t.watchdog.as_ref())
                        .is_some_and(|w| w.deadline.is_some() && !w.cancelled);
                    if watched {
                        billing.watched.push(runtime.id.clone());
                    } else {
                        billing.unwatched.push(runtime.id.clone());
                    }
                }
                billing.unknown = !view.errors.is_empty();
            }
            Load::Failed(_) => billing.unknown = self.has_saved_accounts(),
            Load::Idle | Load::Loading => {
                billing.unknown = self.has_saved_accounts() && self.cli_installed();
            }
        }
        billing
    }

    /// Whether the window may close now; opens the quit prompt otherwise.
    pub fn may_close(&mut self, cx: &mut Context<Self>) -> bool {
        if self.quit == QuitState::Approved {
            return true;
        }
        let billing = self.billing();
        if !billing.any() {
            return true;
        }
        self.close_dialog(cx);
        self.overlay = Some(Overlay::Quit(QuitPrompt {
            billing,
            failures: Vec::new(),
        }));
        cx.notify();
        false
    }

    /// Whether the user approved closing (the root view then closes the window).
    pub fn quit_approved(&self) -> bool {
        self.quit == QuitState::Approved
    }

    /// Leaves everything running and closes.
    pub fn quit_leaving_running(&mut self, cx: &mut Context<Self>) {
        self.overlay = None;
        self.quit = QuitState::Approved;
        cx.notify();
    }

    /// Cancels provisioning and plugin runs (they release what they allocated), stops every
    /// runtime, then closes; a failed stop keeps the prompt open and says which.
    pub fn quit_stopping_all(&mut self, cx: &mut Context<Self>) {
        self.ops.cancel(Op::Provision);
        self.ops.cancel(Op::PluginRun);
        self.run_backend(
            Op::StopAll,
            cx,
            move |backend, cancel| {
                // List afresh: the cached list may be stale, still loading or incomplete.
                let view = backend.runtimes(cancel)?;
                let mut failures: Vec<(Failed, Error)> = view
                    .errors
                    .into_iter()
                    .map(|failure| (Failed::Account(failure.account), failure.error))
                    .collect();
                for runtime in view.runtimes {
                    let label = super::runtime_label(&runtime);
                    if let Err(error) =
                        backend.stop_session(&runtime.id, Default::default(), cancel)
                    {
                        failures.push((Failed::Runtime(label), error));
                    }
                }
                Ok(failures)
            },
            |state, result, cx| {
                let failures: Vec<(String, Error)> = match result {
                    Ok(failures) => failures
                        .into_iter()
                        .map(|(what, error)| {
                            let label = match what {
                                Failed::Runtime(label) => label,
                                Failed::Account(account) => state
                                    .email_of(&account)
                                    .unwrap_or_else(|| account.to_string()),
                            };
                            (label, error)
                        })
                        .collect(),
                    Err(error) => vec![(String::new(), error)],
                };
                let asking = matches!(state.overlay, Some(Overlay::Quit(_)));
                if failures.is_empty() && asking {
                    state.wait_then_close(cx);
                } else if let Some(Overlay::Quit(prompt)) = &mut state.overlay {
                    prompt.failures = failures;
                }
                state.load_runtimes(cx);
                cx.notify();
            },
        );
        cx.notify();
    }

    /// Closes once cancelled provisioning and runs have returned (they stop what they made).
    fn wait_then_close(&mut self, cx: &mut Context<Self>) {
        if self.ops.is_running(Op::Provision) || self.ops.is_running(Op::PluginRun) {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(100))
                        .await;
                    let busy = this
                        .update(cx, |state, _| {
                            state.ops.is_running(Op::Provision)
                                || state.ops.is_running(Op::PluginRun)
                        })
                        .unwrap_or(false);
                    if !busy {
                        break;
                    }
                }
                this.update(cx, |state, cx| {
                    state.overlay = None;
                    state.quit = QuitState::Approved;
                    cx.notify();
                })
                .ok();
            })
            .detach();
            return;
        }
        self.overlay = None;
        self.quit = QuitState::Approved;
    }

    /// Whether "Stop all" is under way.
    pub fn is_stopping_all(&self) -> bool {
        self.ops.is_running(Op::StopAll)
    }
}

/// What "Stop all" could not stop or check.
enum Failed {
    /// A runtime, by its label.
    Runtime(String),
    /// An account whose runtimes could not be listed.
    Account(colab_playground_core::accounts::AccountId),
}
