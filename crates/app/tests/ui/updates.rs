//! The update check over the headless mock, which answers from its switches and never makes
//! an HTTP request (`MockBackend::update_checks` counts what it was asked).

use std::time::{Duration, UNIX_EPOCH};

use colab_playground::{
    i18n::keys,
    route::Route,
    state::{POLL_CHECK, UpdateCheck},
    ui::{
        pages::{
            UPDATE_NOTICE_SELECTOR,
            settings::{UPDATE_CHECK_SELECTOR, UPDATE_OPEN_SELECTOR},
        },
        sidebar::UPDATE_MARK_SELECTOR,
    },
};
use colab_playground_core::{
    backend::Backend,
    mock::MockFailures,
    update::{self, Version},
};
use gpui::TestAppContext;

use crate::support::{ConfigDir, Options, TestApp};

/// The version the mock announces: the next patch of this build.
fn next_version() -> String {
    let current = Version::parse(update::CURRENT_VERSION).expect("a semantic version");
    format!("{}.{}.{}", current.major, current.minor, current.patch + 1)
}

/// Moves the backend clock on by `by`, then lets the poller wake once (stepping the UI clock
/// through a whole day of five-second wakes would only repeat the same check).
fn later(app: &mut TestApp<'_>, by: Duration) {
    app.clock.advance(by);
    app.advance(POLL_CHECK);
}

fn available() -> MockFailures {
    MockFailures {
        update_available: true,
        ..MockFailures::default()
    }
}

#[gpui::test]
fn a_found_release_is_announced_once_and_stays_marked(cx: &mut TestAppContext) {
    let options = Options {
        failures: available(),
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    assert_eq!(
        app.mock.update_checks(),
        0,
        "nothing before the first poller wake"
    );
    app.advance(POLL_CHECK);
    assert_eq!(
        app.mock.update_checks(),
        1,
        "checked shortly after start-up"
    );
    let version = next_version();
    assert!(app.shown(UPDATE_NOTICE_SELECTOR), "announced");
    assert!(app.shown(UPDATE_MARK_SELECTOR), "marked in the sidebar");
    let saved = app.saved_settings().expect("saved");
    assert_eq!(saved.update_latest.as_deref(), Some(version.as_str()));
    assert!(saved.update_checked_at.is_some());

    app.click("update-notice-open");
    assert_eq!(
        app.opened_url(),
        update::this_app_release_page(&version),
        "the release page, nothing downloaded"
    );
    app.click("update-notice-dismiss");
    assert!(
        !app.shown(UPDATE_NOTICE_SELECTOR),
        "dismissed for this version"
    );
    assert!(
        app.shown(UPDATE_MARK_SELECTOR),
        "still marked until updated"
    );
    assert_eq!(
        app.saved_settings().and_then(|s| s.update_dismissed),
        Some(version)
    );
}

#[gpui::test]
fn after_a_restart_the_dismissed_release_is_not_announced_again(cx: &mut TestAppContext) {
    let version = next_version();
    // What the earlier run saved: checked "now" on the mock's clock, release found, dismissed.
    let now = Backend::now(&colab_playground_core::mock::MockBackend::new(
        colab_playground_core::mock::MockConfig::headless(
            colab_playground_core::mock::MockScenario::demo(),
        )
        .0,
    ));
    let checked = now.duration_since(UNIX_EPOCH).unwrap().as_secs();
    let saved = format!(
        r#"{{ "update_checked_at": {checked}, "update_latest": "{version}", "update_dismissed": "{version}" }}"#
    );
    let options = Options {
        failures: available(),
        config: ConfigDir::TempWith(saved),
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    app.advance(POLL_CHECK);
    assert_eq!(
        app.mock.update_checks(),
        0,
        "already checked within the day"
    );
    assert!(
        app.shown(UPDATE_MARK_SELECTOR),
        "the release is still marked"
    );
    assert!(
        !app.shown(UPDATE_NOTICE_SELECTOR),
        "but not announced again"
    );

    later(&mut app, colab_playground::state::UPDATE_INTERVAL);
    assert_eq!(app.mock.update_checks(), 1, "the next day it checks");
    assert!(
        !app.shown(UPDATE_NOTICE_SELECTOR),
        "the same version stays dismissed"
    );
}

#[gpui::test]
fn with_automatic_checks_off_nothing_is_asked(cx: &mut TestAppContext) {
    let options = Options {
        failures: available(),
        config: ConfigDir::TempWith(r#"{ "check_updates": false }"#.into()),
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    app.advance(POLL_CHECK);
    later(&mut app, Duration::from_secs(25 * 3600));
    assert_eq!(app.mock.update_checks(), 0);
    assert!(!app.shown(UPDATE_NOTICE_SELECTOR));
}

#[gpui::test]
fn a_manual_check_shows_each_state(cx: &mut TestAppContext) {
    let options = Options {
        config: ConfigDir::TempWith(r#"{ "check_updates": false }"#.into()),
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    app.click(Route::Settings.nav_selector());
    assert!(app.shown("update-status idle"));

    app.update(|state, cx| {
        state.check_updates_now(cx);
        assert_eq!(state.update_check(), &UpdateCheck::Checking);
    });
    assert!(app.shown("update-status up-to-date"));

    app.set_failures(MockFailures {
        update_check_fails: true,
        ..MockFailures::default()
    });
    app.click(UPDATE_CHECK_SELECTOR);
    assert!(app.shown("update-status failed"));
    let failed = app.text(keys::UPDATE_FAILED_TITLE);
    assert!(
        app.toasts().contains(&failed),
        "a manual failure is reported"
    );

    app.set_failures(available());
    app.click(UPDATE_CHECK_SELECTOR);
    assert!(app.shown("update-status available"));
    assert!(app.shown(UPDATE_OPEN_SELECTOR));
    assert_eq!(app.mock.update_checks(), 3, "every check went to the mock");
}

#[gpui::test]
fn an_automatic_failure_stays_quiet(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            update_check_fails: true,
            ..MockFailures::default()
        },
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    app.advance(POLL_CHECK);
    assert_eq!(app.mock.update_checks(), 1);
    let failed = app.text(keys::UPDATE_FAILED_TITLE);
    assert!(
        !app.toasts().contains(&failed),
        "no toast for an automatic check"
    );
    app.click(Route::Settings.nav_selector());
    assert!(app.shown("update-status failed"), "shown in About");
}

#[gpui::test]
fn it_checks_once_a_day(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    app.advance(POLL_CHECK);
    assert_eq!(app.mock.update_checks(), 1);
    later(&mut app, Duration::from_secs(3600));
    assert_eq!(app.mock.update_checks(), 1, "not again within the day");
    later(&mut app, Duration::from_secs(23 * 3600));
    assert_eq!(app.mock.update_checks(), 2, "again after a day");
}
