//! Running backend calls off the UI thread.
//!
//! Every `Backend` method blocks, so the UI thread never calls one. [`AppState::run_backend`]
//! moves the call onto the background executor with a fresh [`CancelToken`] and applies the
//! result on the foreground. At most one call of each [`Op`] runs at a time: asking again while
//! one runs is ignored (controls show the busy state instead), so results never arrive out of
//! order. Cancelling flips the token; the blocking call notices and returns `Cancelled`, which
//! `done` receives like any other result. Long calls that stream events use
//! [`AppState::run_backend_streaming`]: the work runs on the background executor while the
//! foreground task drains the event channel on every wake and once more at the end.

use std::{
    collections::HashMap,
    sync::{Arc, mpsc},
    time::Duration,
};

use colab_playground_core::{CancelToken, Result, backend::Backend};
use futures::future::{Either, select};
use gpui::{AppContext, Context};

use super::AppState;

/// How often a streaming call's events are drained while it runs.
const STREAM_TICK: Duration = Duration::from_millis(120);

/// The kinds of backend call; one of each runs at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Op {
    /// Probe, then accounts, then usage.
    Environment,
    /// Installing the CLI.
    Install,
    /// Listing accounts.
    Accounts,
    /// Fetching usage.
    Usage,
    /// Starting or finishing a sign-in.
    Login,
    /// Rolling back an abandoned sign-in.
    LoginRollback,
    /// What a switch affects.
    SwitchImpact,
    /// Switching account.
    Switch,
    /// Removing an account.
    Remove,
    /// Saving the CLI's account.
    Adopt,
    /// Rebuilding the backend after a host change.
    Rebuild,
}

/// Calls under way, by kind, with their tokens.
#[derive(Default)]
pub(crate) struct Ops {
    running: HashMap<Op, CancelToken>,
}

impl Ops {
    /// Whether a call of `op` is under way.
    pub(crate) fn is_running(&self, op: Op) -> bool {
        self.running.contains_key(&op)
    }

    /// Whether the call of `op` has been asked to stop and has not finished yet.
    pub(crate) fn is_cancelling(&self, op: Op) -> bool {
        self.running.get(&op).is_some_and(CancelToken::is_cancelled)
    }

    /// Whether any call is under way.
    pub(crate) fn any(&self) -> bool {
        !self.running.is_empty()
    }

    /// Asks the call of `op` to stop.
    pub(crate) fn cancel(&self, op: Op) {
        if let Some(token) = self.running.get(&op) {
            log::info!("ops: cancelling {op:?}");
            token.cancel();
        }
    }

    pub(crate) fn cancel_all(&self) {
        for token in self.running.values() {
            token.cancel();
        }
    }

    pub(super) fn start(&mut self, op: Op) -> Option<CancelToken> {
        if self.running.contains_key(&op) {
            log::info!("ops: {op:?} is already running; ignoring the new request");
            return None;
        }
        let token = CancelToken::new();
        self.running.insert(op, token.clone());
        Some(token)
    }

    pub(super) fn finish(&mut self, op: Op) {
        self.running.remove(&op);
    }
}

impl AppState {
    /// Whether a call of `op` is under way.
    pub fn is_busy(&self, op: Op) -> bool {
        self.ops.is_running(op)
    }

    /// Whether the call of `op` was cancelled and is still winding down.
    pub fn is_cancelling(&self, op: Op) -> bool {
        self.ops.is_cancelling(op)
    }

    /// Runs `work` against the backend on the background executor and hands its result to
    /// `done` on the foreground. Ignored while a call of the same `op` runs. Without a backend
    /// (it failed to start), `done` gets that error at once.
    pub(crate) fn run_backend<R: Send + 'static>(
        &mut self,
        op: Op,
        cx: &mut Context<Self>,
        work: impl FnOnce(&dyn Backend, &CancelToken) -> Result<R> + Send + 'static,
        done: impl FnOnce(&mut AppState, Result<R>, &mut Context<AppState>) + 'static,
    ) {
        let backend = match &self.backend {
            Ok(backend) => backend.clone(),
            Err(error) => {
                let error = error.clone();
                done(self, Err(error), cx);
                return;
            }
        };
        let Some(token) = self.ops.start(op) else {
            return;
        };
        log::debug!("ops: {op:?} started");
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { work(&*backend, &token) })
                .await;
            this.update(cx, |state, cx| {
                state.ops.finish(op);
                log::debug!("ops: {op:?} finished ({})", outcome(&result));
                done(state, result, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }

    /// Like [`Self::run_backend`] for calls that stream events: `on_event` sees each event on
    /// the foreground as it arrives (all of them, before `done`).
    pub(crate) fn run_backend_streaming<E: Send + 'static, R: Send + 'static>(
        &mut self,
        op: Op,
        cx: &mut Context<Self>,
        work: impl FnOnce(&dyn Backend, mpsc::Sender<E>, &CancelToken) -> Result<R> + Send + 'static,
        on_event: impl Fn(&mut AppState, E, &mut Context<AppState>) + 'static,
        done: impl FnOnce(&mut AppState, Result<R>, &mut Context<AppState>) + 'static,
    ) {
        let backend: Arc<dyn Backend> = match &self.backend {
            Ok(backend) => backend.clone(),
            Err(error) => {
                let error = error.clone();
                done(self, Err(error), cx);
                return;
            }
        };
        let Some(token) = self.ops.start(op) else {
            return;
        };
        log::debug!("ops: {op:?} started (streaming)");
        let (events, received) = mpsc::channel::<E>();
        cx.spawn(async move |this, cx| {
            let work = cx.background_spawn(async move { work(&*backend, events, &token) });
            futures::pin_mut!(work);
            let drain = |cx: &mut gpui::AsyncApp| {
                let batch: Vec<E> = received.try_iter().collect();
                if !batch.is_empty() {
                    this.update(cx, |state, cx| {
                        for event in batch {
                            on_event(state, event, cx);
                        }
                        cx.notify();
                    })
                    .ok();
                }
            };
            let result = loop {
                let tick = cx.background_executor().timer(STREAM_TICK);
                match select(work.as_mut(), tick).await {
                    Either::Left((result, _)) => break result,
                    Either::Right(((), _)) => drain(cx),
                }
            };
            drain(cx);
            this.update(cx, |state, cx| {
                state.ops.finish(op);
                log::debug!("ops: {op:?} finished ({})", outcome(&result));
                done(state, result, cx);
                cx.notify();
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}

fn outcome<R>(result: &Result<R>) -> String {
    match result {
        Ok(_) => "ok".to_owned(),
        Err(error) => error.kind.as_str().to_owned(),
    }
}
