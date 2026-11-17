//! Quitting while runtimes still bill. The window's close check (Ely's `guard_close`, which
//! covers the drawn and the system close) asks [`AppState::may_close`]; when something is
//! billing, or the app cannot tell, it opens the quit prompt instead of closing.
//!
//! "Leave running" is only described as watched by a watchdog for runtimes that have one;
//! runtimes opened elsewhere, or whose watchdog failed or was cancelled, have no automatic
//! stop and the prompt says so, listing every runtime by name and account.

use colab_playground_core::{Error, ErrorKind, backend::RuntimeRef};
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
                        .is_some_and(|w| w.deadline.is_some() && !w.cancelled)
                        && !self.sessions.rearmed.contains(&runtime.id);
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
        if !matches!(self.sessions.runtimes, Load::Ready(_)) {
            // The prompt names every runtime; list them now if they are not known yet.
            self.load_runtimes(cx);
        }
        self.close_dialog(cx);
        self.overlay = Some(Overlay::Quit(QuitPrompt {
            billing,
            failures: Vec::new(),
        }));
        cx.notify();
        false
    }

    /// Whether the user approved quitting.
    pub fn quit_approved(&self) -> bool {
        self.quit == QuitState::Approved
    }

    /// Leaves everything running and quits.
    pub fn quit_leaving_running(&mut self, cx: &mut Context<Self>) {
        self.approve_quit(cx);
    }

    /// The app quits (one window: quitting closes it). Quitting rather than removing the
    /// window keeps the platform from delivering events to a window that is already gone.
    fn approve_quit(&mut self, cx: &mut Context<Self>) {
        self.overlay = None;
        self.quit = QuitState::Approved;
        cx.notify();
        cx.quit();
    }

    /// Stops everything, then quits. In order: cancel provisioning and plugin runs and wait
    /// until they have returned (they release what they allocated); then list afresh and stop
    /// every runtime (one already gone counts as stopped); then list once more and quit only
    /// if nothing is left. Anything left, or any account that could not be listed, keeps the
    /// prompt open and says which.
    pub fn quit_stopping_all(&mut self, cx: &mut Context<Self>) {
        if self.stop_all_pending {
            return;
        }
        self.stop_all_pending = true;
        self.ops.cancel(Op::Provision);
        self.ops.cancel(Op::PluginRun);
        if let Some(Overlay::Quit(prompt)) = &mut self.overlay {
            prompt.failures.clear();
        }
        self.continue_stop_all(cx);
        cx.notify();
    }

    /// Runs the stopping part of "Stop all" once no cancelled provision or plugin run is still
    /// unwinding. Called again when each of them returns.
    pub(crate) fn continue_stop_all(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.overlay, Some(Overlay::Quit(_))) {
            // The prompt was dismissed while cancelled work unwound: stop nothing.
            self.stop_all_pending = false;
            return;
        }
        if self.stop_all_pending
            && !self.ops.is_running(Op::StopAll)
            && !self.ops.is_running(Op::Provision)
            && !self.ops.is_running(Op::PluginRun)
        {
            self.stop_everything(cx);
        }
    }

    fn stop_everything(&mut self, cx: &mut Context<Self>) {
        self.run_backend(
            Op::StopAll,
            cx,
            move |backend, cancel| {
                let view = backend.runtimes(cancel)?;
                let mut failures: Vec<(Failed, Error)> = Vec::new();
                for runtime in &view.runtimes {
                    match backend.stop_session(&runtime.id, Default::default(), cancel) {
                        Ok(()) => {}
                        // Gone already (stopped by its watchdog, a cancelled run, elsewhere).
                        Err(error) if error.is(ErrorKind::SessionGone) => {}
                        Err(error) => {
                            failures.push((Failed::Runtime(super::runtime_label(runtime)), error))
                        }
                    }
                }
                let after = backend.runtimes(cancel)?;
                // The final listing decides: a stop that "failed" on a runtime that is gone now
                // (already stopped by its watchdog, a cancelled run or elsewhere) is not a failure.
                let still: Vec<String> = after.runtimes.iter().map(super::runtime_label).collect();
                failures.retain(
                    |(what, _)| matches!(what, Failed::Runtime(label) if still.contains(label)),
                );
                for failure in after.errors {
                    failures.push((Failed::Account(failure.account), failure.error));
                }
                for runtime in after.runtimes {
                    let label = super::runtime_label(&runtime);
                    if !failures
                        .iter()
                        .any(|(what, _)| matches!(what, Failed::Runtime(l) if *l == label))
                    {
                        failures.push((
                            Failed::Runtime(label),
                            Error::new(ErrorKind::Other).detail("still listed after stopping"),
                        ));
                    }
                }
                Ok(failures)
            },
            |state, result, cx| {
                state.stop_all_pending = false;
                let failures: Vec<(String, Error)> = match result {
                    Ok(failures) => failures
                        .into_iter()
                        .map(|(what, error)| {
                            let label = match what {
                                Failed::Runtime(label) => label,
                                Failed::Account(account) => state
                                    .email_of(&account)
                                    .unwrap_or_else(|| format!("{account:?}")),
                            };
                            (label, error)
                        })
                        .collect(),
                    Err(error) => vec![(String::new(), error)],
                };
                let asking = matches!(state.overlay, Some(Overlay::Quit(_)));
                if failures.is_empty() && asking {
                    state.approve_quit(cx);
                    return;
                }
                if let Some(Overlay::Quit(prompt)) = &mut state.overlay {
                    prompt.failures = failures;
                }
                state.load_runtimes(cx);
                cx.notify();
            },
        );
    }

    /// Whether "Stop all" is under way (waiting for cancelled work, or stopping).
    pub fn is_stopping_all(&self) -> bool {
        self.stop_all_pending || self.ops.is_running(Op::StopAll)
    }
}

/// What "Stop all" could not stop or check.
enum Failed {
    /// A runtime, by its label.
    Runtime(String),
    /// An account whose runtimes could not be listed.
    Account(colab_playground_core::accounts::AccountId),
}
