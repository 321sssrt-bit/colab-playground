//! Counts and "nothing is running" never come from what the app does not know: the Sessions
//! empty state needs a complete listing, and the Overview runtime count (from usage) is unknown
//! without any reading and marked when it leaves accounts out.

use colab_playground::{
    i18n::keys,
    route::Route,
    ui::pages::{
        accounts::ADD_SELECTOR,
        overview::{RUNTIMES_INCOMPLETE_SELECTOR, RUNTIMES_UNCOUNTED_SELECTOR},
        sessions::{EMPTY_PARTIAL_SELECTOR, EMPTY_SELECTOR},
    },
};
use colab_playground_core::mock::{MockAccount, MockFailures, MockScenario};
use gpui::TestAppContext;

use crate::support::{Options, TestApp};

const LISTING_FAILED: &str = "error-sessions";

fn two_accounts_nothing_running() -> MockScenario {
    MockScenario {
        accounts: vec![
            MockAccount {
                email: "ada@example.com".into(),
                balance_cu: 100.0,
            },
            MockAccount {
                email: "lin@example.com".into(),
                balance_cu: 50.0,
            },
        ],
        runtimes: vec![],
    }
}

fn on_sessions(app: &mut TestApp<'_>) {
    app.click(Route::Sessions.nav_selector());
    assert_eq!(app.route(), Route::Sessions);
}

#[gpui::test]
fn a_complete_empty_listing_says_nothing_is_running(cx: &mut TestAppContext) {
    let mut app = TestApp::with(cx, Options::scenario(MockScenario::single()));
    on_sessions(&mut app);
    assert!(app.shown(EMPTY_SELECTOR));
    assert!(!app.shown(EMPTY_PARTIAL_SELECTOR));
}

#[gpui::test]
fn a_failed_listing_never_says_nothing_is_running(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            runtimes_listing_fails: true,
            ..MockFailures::default()
        },
        ..Options::scenario(MockScenario::single())
    };
    let mut app = TestApp::with(cx, options);
    on_sessions(&mut app);
    assert!(app.shown(LISTING_FAILED), "it says the listing failed");
    assert!(!app.shown(EMPTY_SELECTOR));
    assert!(!app.shown(EMPTY_PARTIAL_SELECTOR));
}

#[gpui::test]
fn a_partial_listing_says_only_the_listed_accounts_are_empty(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            unlisted_accounts: vec!["lin@example.com".into()],
            ..MockFailures::default()
        },
        ..Options::scenario(two_accounts_nothing_running())
    };
    let mut app = TestApp::with(cx, options);
    on_sessions(&mut app);
    assert!(
        app.shown("error-sessions-account-lin@example.com"),
        "the account that could not be listed is named"
    );
    assert!(app.shown(EMPTY_PARTIAL_SELECTOR));
    assert!(!app.shown(EMPTY_SELECTOR), "not \"Nothing is running\"");
}

#[gpui::test]
fn a_listing_in_flight_never_says_nothing_is_running(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            runtimes_listing_fails: true,
            ..MockFailures::default()
        },
        ..Options::scenario(MockScenario::single())
    };
    let mut app = TestApp::with(cx, options);
    on_sessions(&mut app);
    app.set_failures(MockFailures::default());
    // A failed list goes back to loading while it is fetched again.
    app.update_and_draw(|state, cx| state.load_runtimes(cx));
    assert!(app.read(|state, _| state.runtimes().is_loading()));
    assert!(!app.shown(EMPTY_SELECTOR));
    assert!(!app.shown(LISTING_FAILED));
    app.settle();
    assert!(app.shown(EMPTY_SELECTOR), "the listing came back empty");
}

#[gpui::test]
fn the_runtime_count_counts_every_account(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    assert_eq!(app.read(|state, _| state.usage_summary().known), 2);
    assert!(app.shown("summary runtimes 4"));
    assert!(!app.shown(RUNTIMES_INCOMPLETE_SELECTOR));
    assert!(!app.shown(RUNTIMES_UNCOUNTED_SELECTOR));
}

#[gpui::test]
fn without_any_usage_the_runtime_count_is_unknown(cx: &mut TestAppContext) {
    let options = Options {
        failures: MockFailures {
            usage_fetch_fails: true,
            ..MockFailures::default()
        },
        ..Options::default()
    };
    let mut app = TestApp::with(cx, options);
    assert_eq!(app.read(|state, _| state.usage_summary().known), 0);
    let unknown = app.text(keys::SUMMARY_UNKNOWN);
    assert!(app.shown(&format!("summary runtimes {unknown}")));
    assert!(!app.shown("summary runtimes 0"), "never zero");
    assert!(!app.shown(RUNTIMES_INCOMPLETE_SELECTOR));
}

#[gpui::test]
fn an_account_without_usage_is_left_out_of_the_runtime_count_and_named(cx: &mut TestAppContext) {
    let mut app = TestApp::new(cx);
    // A new account whose usage never loads: the others keep their last readings.
    app.set_failures(MockFailures {
        usage_fetch_fails: true,
        ..MockFailures::default()
    });
    app.click(Route::Accounts.nav_selector());
    app.click(ADD_SELECTOR);
    app.click("add-continue");
    app.fill(|inputs| inputs.code.clone(), "4/0AbCdEf");
    app.click("add-submit");
    let (uncounted, added) =
        app.read(|state, _| (state.uncounted_accounts(), state.active_email()));
    assert_eq!(
        uncounted,
        vec![added],
        "the account just added (now active)"
    );
    app.click(Route::Overview.nav_selector());
    assert!(
        app.shown("summary runtimes 4"),
        "the accounts with readings still add up"
    );
    assert!(app.shown(RUNTIMES_INCOMPLETE_SELECTOR), "marked incomplete");
    assert!(
        app.shown(RUNTIMES_UNCOUNTED_SELECTOR),
        "and says what is left out"
    );
}
