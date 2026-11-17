//! Sessions over the headless mock: provisioning (retry to an 80 GB A100, not entitled,
//! session limit, cancel), stopping any runtime on any account, forwards, the cost guard and
//! quitting with runtimes still billing.

use std::time::Duration;

use colab_playground::{
    route::Route,
    state::{EndReason, Overlay, ProvisionPhase},
    ui::{
        overlays::{FORWARD_SUBMIT, NEW_SESSION_START, RESERVED_NOTE},
        pages::sessions::{NEW_SESSION_SELECTOR, forward_selector, stop_selector},
    },
};
use colab_playground_core::{
    CancelToken, ErrorKind,
    backend::Backend,
    guard::{Concern, Decision, Limit},
    mock::{MockFailures, MockScenario},
    provision::ProvisionEvent,
    sessions::Accelerator,
};
use gpui::TestAppContext;

use crate::support::{Options, TestApp};

const STOP_CONFIRM: &str = "stop-confirm";

fn on_sessions(app: &mut TestApp<'_>) {
    app.click(Route::Sessions.nav_selector());
    assert_eq!(app.route(), Route::Sessions);
}

fn runtime_names(app: &mut TestApp<'_>) -> Vec<String> {
    app.read(|state, _| {
        state
            .runtimes()
            .ready()
            .map(|view| {
                view.runtimes
                    .iter()
                    .map(colab_playground::state::runtime_label)
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn phase(app: &mut TestApp<'_>) -> Option<ProvisionPhase> {
    app.read(|state, _| state.new_session().map(|s| s.phase.clone()))
}

fn events(app: &mut TestApp<'_>) -> Vec<ProvisionEvent> {
    app.read(|state, _| {
        state
            .new_session()
            .map(|s| s.progress.events.clone())
            .unwrap_or_default()
    })
}

/// Opens the dialog on `scenario`, applies `edit` to the form and starts.
fn provision(
    app: &mut TestApp<'_>,
    edit: impl FnOnce(&mut colab_playground_core::provision::ProvisionSpec),
) {
    on_sessions(app);
    app.click(NEW_SESSION_SELECTOR);
    assert!(matches!(
        app.read(|state, _| state.overlay().cloned()),
        Some(Overlay::NewSession)
    ));
    let spec = app.read(|state, _| state.new_session().map(|s| s.spec.clone()));
    let spec = spec.expect("the form is open");
    assert!(!spec.name.is_empty(), "a generated name is filled in");
    assert_eq!(
        spec.max_attempts,
        app.read(|state, _| state.defaults().max_attempts),
        "pre-filled from Defaults"
    );
    app.update(|state, cx| state.edit_new_session(edit, cx));
    app.click(NEW_SESSION_START);
}

#[gpui::test]
fn a_40_gb_a100_is_given_back_and_the_retry_gets_80_gb(cx: &mut TestAppContext) {
    let mut app = TestApp::with(cx, Options::scenario(MockScenario::single()));
    provision(&mut app, |spec| {
        spec.accelerator = Accelerator::A100;
        spec.min_vram_mib = Some(70 * 1024);
        spec.max_attempts = 3;
    });
    let Some(ProvisionPhase::Ready(outcome)) = phase(&mut app) else {
        panic!("expected a ready runtime, got {:?}", phase(&mut app));
    };
    assert_eq!(outcome.hardware.vram_mib, Some(81_920));
    assert_eq!(outcome.attempts, 2);
    let events = events(&mut app);
    assert!(
        events.iter().any(|e| matches!(
            e,
            ProvisionEvent::Rejected {
                vram_mib: Some(40_960),
                ..
            }
        )),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProvisionEvent::Retrying { .. }))
    );
    assert!(app.shown(colab_playground::ui::progress::PROGRESS_SELECTOR));
    assert_eq!(runtime_names(&mut app), std::slice::from_ref(&outcome.name));
}

#[gpui::test]
fn an_accelerator_the_account_cannot_use_says_so(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            not_entitled: vec![Accelerator::H100],
            ..MockFailures::default()
        },
        ..Options::scenario(MockScenario::single())
    };
    let mut app = TestApp::with(cx, options);
    provision(&mut app, |spec| {
        spec.accelerator = Accelerator::H100;
        spec.min_vram_mib = None;
    });
    let Some(ProvisionPhase::Failed(error)) = phase(&mut app) else {
        panic!("expected a failure, got {:?}", phase(&mut app));
    };
    assert_eq!(error.kind, ErrorKind::NotEntitled);
    assert!(app.shown("error-provision"), "the failure is explained");
    assert!(
        !events(&mut app)
            .iter()
            .any(|e| matches!(e, ProvisionEvent::Retrying { .. })),
        "not retried: retrying cannot help"
    );
    app.click("new-session-change");
    assert_eq!(
        phase(&mut app),
        Some(ProvisionPhase::Editing),
        "back to the form"
    );
}

#[gpui::test]
fn the_session_limit_offers_the_sessions_page(cx: &mut TestAppContext) {
    // The demo's active account already has two sessions the app started (the default cap).
    let mut app = TestApp::new(cx);
    provision(&mut app, |_| {});
    let Some(ProvisionPhase::Failed(error)) = phase(&mut app) else {
        panic!("expected a failure, got {:?}", phase(&mut app));
    };
    assert_eq!(error.kind, ErrorKind::SessionLimitReached);
    assert!(app.shown("new-session-open-sessions"));
    app.click("new-session-open-sessions");
    assert!(app.read(|state, _| state.overlay().is_none()));
    assert_eq!(app.route(), Route::Sessions);
}

#[gpui::test]
fn cancelling_while_a_runtime_exists_leaves_nothing_billing(cx: &mut TestAppContext) {
    let mut app = TestApp::with(cx, Options::scenario(MockScenario::single()));
    on_sessions(&mut app);
    app.click(NEW_SESSION_SELECTOR);
    app.update(|state, cx| state.edit_new_session(|spec| spec.accelerator = Accelerator::A100, cx));
    // Wait 1 is in `create`, before the VM exists; wait 2 is the hardware probe, with a VM
    // allocated: cancel there.
    app.cancel_switch.arm(2);
    app.click(NEW_SESSION_START);
    assert_eq!(phase(&mut app), Some(ProvisionPhase::Cancelled));
    let events = events(&mut app);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProvisionEvent::Allocating { .. })),
        "{events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ProvisionEvent::Releasing { .. })),
        "the allocated VM was released: {events:?}"
    );
    assert!(app.shown("provision-cancelled"));
    let left = app.mock.runtimes(&CancelToken::new()).expect("listing");
    assert!(left.runtimes.is_empty(), "nothing billed is left: {left:?}");
    assert!(runtime_names(&mut app).is_empty());
}

#[gpui::test]
fn any_runtime_on_any_account_can_be_stopped(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    on_sessions(&mut app);
    let names = runtime_names(&mut app);
    // A managed session, a runtime opened in the browser (no name: shown by its hardware),
    // and a session on the other account.
    for label in ["a100-7f3a", "L4", "cpu-0b5e"] {
        assert!(names.contains(&label.to_owned()), "{label} in {names:?}");
        app.click(&stop_selector(label));
        let Some(Overlay::Stop(prompt)) = app.read(|state, _| state.overlay().cloned()) else {
            panic!("expected the stop confirmation for {label}");
        };
        assert_eq!(prompt.label, label);
        assert!(app.shown(STOP_CONFIRM));
        app.click(STOP_CONFIRM);
        assert!(app.read(|state, _| state.overlay().is_none()), "{label}");
        assert!(
            !runtime_names(&mut app).contains(&label.to_owned()),
            "{label} is gone"
        );
        let ended = app.read(|state, _| state.ended().first().cloned());
        let ended = ended.expect("listed as ended");
        assert_eq!(
            (ended.label.as_str(), &ended.reason),
            (label, &EndReason::User)
        );
    }
    let left = app.mock.runtimes(&CancelToken::new()).expect("listing");
    assert_eq!(
        left.runtimes.len(),
        1,
        "only the T4 session is left: {left:?}"
    );
}

#[gpui::test]
fn a_busy_forward_says_so_then_comes_up_and_closes(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            ssh_busy_attempts: 1,
            ..MockFailures::default()
        },
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    on_sessions(&mut app);
    app.click(&forward_selector("a100-7f3a"));
    assert!(matches!(
        app.read(|state, _| state.overlay().cloned()),
        Some(Overlay::Forward(_))
    ));

    app.fill(|inputs| inputs.forward_remote.clone(), "8080");
    app.click(FORWARD_SUBMIT);
    assert!(app.shown(RESERVED_NOTE), "8080 is refused with the reason");
    assert!(
        app.read(|state, _| state.tunnels().next().is_none()),
        "nothing tried"
    );
    app.fill(|inputs| inputs.forward_remote.clone(), "8000");

    app.click(FORWARD_SUBMIT);
    let Some(Overlay::Forward(form)) = app.read(|state, _| state.overlay().cloned()) else {
        panic!("the dialog stays open with the error");
    };
    assert_eq!(form.error.map(|e| e.kind), Some(ErrorKind::SshBusy));
    assert!(app.shown("error-forward"));

    app.click(FORWARD_SUBMIT);
    assert!(
        app.read(|state, _| state.overlay().is_none()),
        "up: the dialog closes"
    );
    let up = app.read(|state, _| {
        state
            .tunnels()
            .map(|t| (t.spec.local_port, t.state.clone(), t.healthy))
            .collect::<Vec<_>>()
    });
    assert_eq!(
        up,
        [(
            8000,
            colab_playground_core::tunnel::TunnelState::Up,
            Some(true)
        )]
    );
    assert!(app.shown("tunnel-close 8000"));

    app.click("tunnel-close 8000");
    assert!(app.read(|state, _| state.tunnels().next().is_none()));
    let closed = app.text(colab_playground::i18n::keys::FORWARD_CLOSED);
    assert!(app.toasts().contains(&closed), "{:?}", app.toasts());
    assert!(
        runtime_names(&mut app).contains(&"a100-7f3a".to_owned()),
        "closing a forward does not stop the runtime"
    );
}

#[gpui::test]
fn the_guard_warns_then_stops_as_time_passes(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    on_sessions(&mut app);
    let a100 = app
        .read(|state, _| {
            state.runtimes().ready().and_then(|view| {
                view.runtimes
                    .iter()
                    .find(|r| r.id.name.as_deref() == Some("a100-7f3a"))
                    .map(|r| r.id.clone())
            })
        })
        .expect("the demo's A100 session");
    let limit = app.read(|state, _| state.defaults().max_runtime);
    assert_eq!(
        limit,
        Some(Duration::from_secs(2 * 3600)),
        "core's default limit"
    );

    // 100 of 120 minutes: past 80 %.
    app.advance(Duration::from_secs(100 * 60));
    let warnings = app.read(|state, _| state.guard_warnings(&a100).to_vec());
    assert!(
        warnings.iter().any(|c| matches!(
            c,
            Concern::Limit {
                limit: Limit::Runtime,
                ..
            }
        )),
        "{warnings:?}"
    );
    assert!(
        app.shown("guard-warning a100-7f3a"),
        "a persistent indicator"
    );
    let warned = app.cx.update(|_, cx| {
        colab_playground::i18n::tr_args(
            cx,
            colab_playground::i18n::keys::GUARD_WARN_TITLE,
            &[("name", "a100-7f3a")],
        )
    });
    let toasts = app.toasts();
    assert_eq!(
        toasts.iter().filter(|t| **t == warned).count(),
        1,
        "{toasts:?}"
    );
    app.advance(Duration::from_secs(60));
    assert_eq!(
        app.toasts().iter().filter(|t| **t == warned).count(),
        1,
        "not toasted again while the warning is the same"
    );

    app.advance(Duration::from_secs(25 * 60));
    assert!(
        !runtime_names(&mut app).contains(&"a100-7f3a".to_owned()),
        "stopped at the limit"
    );
    let ended = app.read(|state, _| {
        state
            .ended()
            .iter()
            .find(|e| e.label == "a100-7f3a")
            .cloned()
    });
    let ended = ended.expect("the reason stays visible");
    assert!(matches!(
        ended.reason,
        EndReason::Guard(Concern::Limit {
            limit: Limit::Runtime,
            ..
        })
    ));
    assert!(app.shown(colab_playground::ui::pages::sessions::ENDED_SELECTOR));
    let _ = Decision::Ok;
}

#[gpui::test]
fn closing_with_nothing_billing_just_closes(cx: &mut TestAppContext) {
    let app = TestApp::with(cx, Options::scenario(MockScenario::single()));
    assert!(app.cx.simulate_close(), "nothing runs, so nothing to ask");
}

#[gpui::test]
fn closing_while_billing_asks_and_cancel_keeps_the_window(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    assert!(!app.cx.simulate_close(), "the close is held");
    app.settle();
    let Some(Overlay::Quit(prompt)) = app.read(|state, _| state.overlay().cloned()) else {
        panic!("the quit prompt is open");
    };
    assert_eq!(prompt.billing.watched.len(), 3, "{:?}", prompt.billing);
    assert_eq!(
        prompt.billing.unwatched.len(),
        1,
        "the runtime opened in the browser has no automatic stop"
    );
    app.click("overlay-cancel");
    assert!(app.read(|state, _| state.overlay().is_none()));
    assert!(!app.read(|state, _| state.quit_approved()));
}

#[gpui::test]
fn stop_all_and_quit_stops_every_runtime_first(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    let mock = app.mock.clone();
    assert!(!app.cx.simulate_close());
    app.settle();
    // The window closes once every stop returned, so drive the state without the window.
    app.state
        .update(&mut **app.cx, |state, cx| state.quit_stopping_all(cx));
    app.cx.run_until_parked();
    let left = mock.runtimes(&CancelToken::new()).expect("listing");
    assert!(left.runtimes.is_empty(), "{left:?}");
    assert!(
        app.state
            .read_with(&*app.cx, |state, _| state.quit_approved())
    );
}

#[gpui::test]
fn leave_running_and_quit_keeps_them_billing(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    let mock = app.mock.clone();
    assert!(!app.cx.simulate_close());
    app.settle();
    app.state
        .update(&mut **app.cx, |state, cx| state.quit_leaving_running(cx));
    app.cx.run_until_parked();
    assert!(
        app.state
            .read_with(&*app.cx, |state, _| state.quit_approved())
    );
    let left = mock.runtimes(&CancelToken::new()).expect("listing");
    assert_eq!(left.runtimes.len(), 4, "nothing was stopped");
}
