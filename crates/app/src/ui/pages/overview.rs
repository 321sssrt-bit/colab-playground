//! Overview: the first-run checklist until everything is set up, then the compute-unit
//! summary. Batch 2 adds the quick-deploy cards below.

use std::rc::Rc;

use colab_playground_core::{backend::InstallMethod, host::Stream};
use ely_gpui_component::{
    buttons::{Button, ButtonVariant, IconButton},
    data_display::{Badge, Tone},
    feedback::{Alert, InlineMessage},
    forms::{Choice, Select},
    layout::{Card, CardHeader, Page, ScrollArea},
    motion::Spinner,
    primitives::{Icon, IconName, Severity},
    terminal::AnsiText,
    theme::{ActiveTheme, ControlSize, IconSize, TextSize},
    typography::Caption,
};
use gpui::{
    AnyElement, App, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    SharedString, Styled, div, prelude::FluentBuilder as _,
};

use crate::{
    format,
    i18n::{keys, tr, tr_args},
    platform,
    route::Route,
    state::{
        AppState, EnvironmentStep, InstallPhase, Op, SignInStatus, Step, StepState,
        install_methods, usage_is_stale, usage_stale_note,
    },
    ui::{error_view, tagged},
};

/// Selector of the checklist card.
pub const CHECKLIST_SELECTOR: &str = "overview-checklist";
/// Selector of the summary card shown once set up.
pub const SUMMARY_SELECTOR: &str = "overview-summary";
/// Selector around the Install button.
pub const INSTALL_SELECTOR: &str = "install-start";
/// Selector around the Cancel button of a running install.
pub const INSTALL_CANCEL_SELECTOR: &str = "install-cancel";
/// Selector of the install log.
pub const INSTALL_LOG_SELECTOR: &str = "install-log";
/// Selector around the sign-in button of the checklist.
pub const SIGN_IN_SELECTOR: &str = "checklist-sign-in";
/// Selector around "Check again".
pub const CHECK_AGAIN_SELECTOR: &str = "checklist-check-again";
/// Where batch 2 puts the quick-deploy cards.
pub const QUICK_DEPLOY_SELECTOR: &str = "overview-quick-deploy";

/// The selector of a checklist step, with its state: `step <name> <state>`.
pub fn step_selector(step: EnvironmentStep, state: &StepState) -> String {
    let name = match step {
        EnvironmentStep::Wsl => "wsl",
        EnvironmentStep::ShellTools => "shell",
        EnvironmentStep::Cli => "cli",
        EnvironmentStep::SignIn => "signin",
    };
    let state = match state {
        StepState::Checking => "checking",
        StepState::Done => "done",
        StepState::Todo => "todo",
        StepState::Waiting => "waiting",
        StepState::Failed(_) => "failed",
    };
    format!("step {name} {state}")
}

/// The Overview page.
pub fn render(state: &AppState, handle: &Entity<AppState>, cx: &App) -> Page {
    let mut page = super::page(Route::Overview, keys::OVERVIEW_SUBTITLE, cx);
    if let Some(error) = state.backend_error() {
        return page.child(error_view::alert(
            "backend",
            Some(tr(cx, keys::BACKEND_START_FAILED)),
            error,
            None,
            handle,
            cx,
        ));
    }
    let checklist = state.checklist();
    page = if checklist.complete() {
        page.child(summary(state, handle, cx))
    } else {
        page.child(
            tagged(
                CHECKLIST_SELECTOR,
                Card::new()
                    .header(
                        CardHeader::new(tr(cx, keys::CHECKLIST_TITLE))
                            .description(tr(cx, keys::CHECKLIST_DESCRIPTION)),
                    )
                    .child(
                        div().flex().flex_col().children(
                            checklist
                                .steps
                                .iter()
                                .enumerate()
                                .map(|(ix, step)| step_row(ix, step, state, handle, cx)),
                        ),
                    ),
            )
            .w_full(),
        )
    };
    page.children(unmanaged_warning(state, handle, cx))
        // TODO(batch 2): the quick-deploy cards for bundled plugins go in this slot.
        .child(tagged(QUICK_DEPLOY_SELECTOR, div()))
}

fn step_row(
    ix: usize,
    step: &Step,
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme();
    let colors = &theme.colors;
    let mark: AnyElement = match &step.state {
        StepState::Checking => Spinner::new(("step-spinner", ix))
            .size(IconSize::Sm)
            .into_any_element(),
        StepState::Done => Icon::new(IconName::CircleCheck)
            .size(IconSize::Sm)
            .color(colors.success)
            .into_any_element(),
        StepState::Failed(_) => Icon::new(IconName::CircleAlert)
            .size(IconSize::Sm)
            .color(colors.danger)
            .into_any_element(),
        StepState::Todo => Icon::new(IconName::Circle)
            .size(IconSize::Sm)
            .color(colors.accent)
            .into_any_element(),
        StepState::Waiting => Icon::new(IconName::Circle)
            .size(IconSize::Sm)
            .color(colors.fg_subtle)
            .into_any_element(),
    };
    let title = tr(
        cx,
        match step.step {
            EnvironmentStep::Wsl => keys::STEP_WSL_TITLE,
            EnvironmentStep::ShellTools => keys::STEP_SHELL_TITLE,
            EnvironmentStep::Cli => keys::STEP_CLI_TITLE,
            EnvironmentStep::SignIn => keys::STEP_SIGNIN_TITLE,
        },
    );
    let (body, extra) = step_body(step, state, handle, cx);
    tagged(
        step_selector(step.step, &step.state),
        div()
            .flex()
            .items_start()
            .gap_3()
            .py_3()
            .when(ix > 0, |row| row.border_t_1().border_color(colors.border))
            .child(div().flex_none().pt_0p5().child(mark))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(match step.state {
                                StepState::Waiting => colors.fg_muted,
                                _ => colors.fg,
                            })
                            .child(title),
                    )
                    .children(body.map(|body| {
                        div()
                            .text_size(theme.text_size(TextSize::Sm))
                            .text_color(colors.fg_muted)
                            .child(body)
                    }))
                    .children(extra),
            ),
    )
    .into_any_element()
}

/// The line under a step's title and anything it needs below (buttons, the install).
fn step_body(
    step: &Step,
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> (Option<SharedString>, Vec<AnyElement>) {
    let report = state.probe().ready();
    match (&step.state, step.step) {
        (StepState::Checking, _) => (Some(tr(cx, keys::STEP_CHECKING)), vec![]),
        (StepState::Waiting, _) => (Some(tr(cx, keys::STEP_WAITING)), vec![]),
        (StepState::Failed(error), _) => {
            let retry = check_again(handle);
            (
                None,
                vec![error_view::alert(
                    "step",
                    None,
                    error,
                    Some(retry),
                    handle,
                    cx,
                )],
            )
        }
        (StepState::Done, EnvironmentStep::Wsl) => {
            let distro = state
                .settings()
                .wsl_distro
                .clone()
                .or_else(|| report.and_then(|r| r.wsl_distros.first().cloned()))
                .unwrap_or_default();
            (
                Some(tr_args(cx, keys::STEP_WSL_DONE, &[("distro", &distro)])),
                vec![],
            )
        }
        (StepState::Done, EnvironmentStep::ShellTools) => {
            let key = if report.is_some_and(|r| r.ssh.is_some()) {
                keys::STEP_SHELL_DONE
            } else {
                keys::STEP_SHELL_NO_SSH
            };
            (Some(tr(cx, key)), vec![])
        }
        (StepState::Done, EnvironmentStep::Cli) => {
            let body = match report.and_then(|r| r.colab_version.clone()) {
                Some(version) => tr_args(cx, keys::STEP_CLI_DONE, &[("version", &version)]),
                None => tr(cx, keys::STEP_CLI_DONE_UNKNOWN),
            };
            (Some(body), vec![])
        }
        (StepState::Done, EnvironmentStep::SignIn) => {
            let email = state
                .active_email()
                .unwrap_or_else(|| tr(cx, keys::ACCOUNTS_NO_EMAIL).to_string());
            (
                Some(tr_args(cx, keys::STEP_SIGNIN_DONE, &[("email", &email)])),
                vec![],
            )
        }
        (StepState::Todo, EnvironmentStep::Wsl) => {
            let buttons = div()
                .flex()
                .flex_wrap()
                .gap_2()
                .child(
                    Button::new("install-wsl", tr(cx, keys::ACTION_INSTALL_WSL))
                        .icon(IconName::ExternalLink)
                        .size(ControlSize::Sm)
                        .on_click(|_, _, cx| cx.open_url(platform::WSL_INSTALL_URL)),
                )
                .child(check_again_button(handle, cx));
            (
                Some(tr(cx, keys::STEP_WSL_TODO)),
                vec![buttons.into_any_element()],
            )
        }
        (StepState::Todo, EnvironmentStep::ShellTools) => (
            Some(tr(cx, keys::STEP_SHELL_TODO)),
            vec![
                div()
                    .flex()
                    .child(check_again_button(handle, cx))
                    .into_any_element(),
            ],
        ),
        (StepState::Todo, EnvironmentStep::Cli) => install(state, handle, cx),
        (StepState::Todo, EnvironmentStep::SignIn) => sign_in(state, handle, cx),
    }
}

fn check_again(handle: &Entity<AppState>) -> error_view::Retry {
    let handle = handle.clone();
    Rc::new(move |_, cx| handle.update(cx, |state, cx| state.check_environment(cx)))
}

fn check_again_button(handle: &Entity<AppState>, cx: &App) -> impl IntoElement {
    let handle = handle.clone();
    tagged(
        CHECK_AGAIN_SELECTOR,
        Button::new("check-again", tr(cx, keys::ACTION_CHECK_AGAIN))
            .icon(IconName::RefreshCw)
            .size(ControlSize::Sm)
            .variant(ButtonVariant::Ghost)
            .on_click(move |_, _, cx| handle.update(cx, |state, cx| state.check_environment(cx))),
    )
}

/// The CLI step: choose a method, install, follow the log, cancel, see why it failed.
fn install(
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> (Option<SharedString>, Vec<AnyElement>) {
    let theme = cx.theme();
    let install = state.install();
    let running = state.is_busy(Op::Install);
    let mut extra: Vec<AnyElement> = Vec::new();
    let body = match &install.phase {
        InstallPhase::Running if running => None,
        InstallPhase::Done => Some(tr(cx, keys::INSTALL_DONE)),
        InstallPhase::Cancelled => Some(tr(cx, keys::INSTALL_CANCELLED)),
        _ => Some(tr(cx, keys::STEP_CLI_TODO)),
    };
    if running {
        let cancelling = state.is_cancelling(Op::Install);
        let cancel = handle.clone();
        extra.push(
            div()
                .flex()
                .items_center()
                .gap_2()
                .child(Spinner::new("install-spinner").size(IconSize::Sm))
                .child(
                    div()
                        .flex_1()
                        .text_size(theme.text_size(TextSize::Sm))
                        .child(tr(cx, keys::INSTALL_RUNNING)),
                )
                .child(tagged(
                    INSTALL_CANCEL_SELECTOR,
                    Button::new(
                        "install-cancel",
                        tr(
                            cx,
                            if cancelling {
                                keys::INSTALL_CANCELLING
                            } else {
                                keys::ACTION_CANCEL
                            },
                        ),
                    )
                    .size(ControlSize::Sm)
                    .disabled(cancelling)
                    .on_click(move |_, _, cx| {
                        cancel.update(cx, |state, cx| state.cancel_install(cx))
                    }),
                ))
                .into_any_element(),
        );
    } else {
        if let InstallPhase::Failed(error) = &install.phase {
            let retry = {
                let handle = handle.clone();
                Rc::new(move |_: &mut gpui::Window, cx: &mut App| {
                    handle.update(cx, |state, cx| state.start_install(cx))
                }) as error_view::Retry
            };
            extra.push(error_view::alert(
                "install",
                Some(tr(cx, keys::INSTALL_FAILED)),
                error,
                Some(retry),
                handle,
                cx,
            ));
        }
        let methods = install_methods(state.probe().ready());
        let chosen = state.chosen_install_method();
        let start = handle.clone();
        let mut controls = div().flex().flex_wrap().items_center().gap_2();
        if methods.len() > 1 {
            let pick = handle.clone();
            let choices = methods.iter().map(|method| {
                Choice::new(
                    format::install_method_value(*method),
                    tr(cx, format::install_method_key(*method)),
                )
            });
            controls = controls
                .child(Caption::new(tr(cx, keys::INSTALL_METHOD_LABEL)))
                .child(
                    tagged(
                        "install-method",
                        Select::new("install-method-select", choices)
                            .label(tr(cx, keys::INSTALL_METHOD_LABEL))
                            .selected(format::install_method_value(chosen))
                            .size(ControlSize::Sm)
                            .on_change(move |value, _, cx| {
                                if let Some(method) = methods_from_value(value) {
                                    pick.update(cx, |state, cx| {
                                        state.set_install_method(method, cx)
                                    });
                                }
                            }),
                    )
                    .w(theme.menu_width()),
                );
        } else {
            controls = controls.child(Caption::new(tr(cx, format::install_method_key(chosen))));
        }
        controls = controls.child(tagged(
            INSTALL_SELECTOR,
            Button::new("install-start", tr(cx, keys::INSTALL_START))
                .icon(IconName::Download)
                .primary()
                .size(ControlSize::Sm)
                .on_click(move |_, _, cx| start.update(cx, |state, cx| state.start_install(cx))),
        ));
        extra.push(controls.into_any_element());
    }
    if !install.lines.is_empty() {
        extra.push(install_log(state, cx));
    }
    (body, extra)
}

fn methods_from_value(value: &str) -> Option<InstallMethod> {
    [
        InstallMethod::Uv,
        InstallMethod::InstallUvThenCli,
        InstallMethod::PipUser,
    ]
    .into_iter()
    .find(|method| format::install_method_value(*method) == value)
}

/// The install's output: monospace, colours kept, following the newest line.
fn install_log(state: &AppState, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let colors = &theme.colors;
    let install = state.install();
    let lines = install.lines.iter().enumerate().map(|(ix, line)| {
        div()
            .id(("install-line", ix))
            .when(line.stream == Stream::Stderr, |row| {
                row.text_color(colors.danger)
            })
            .child(AnsiText::new(line.text.clone()))
    });
    tagged(
        INSTALL_LOG_SELECTOR,
        div()
            .h(theme.list_max_height())
            .w_full()
            .rounded(theme.radius(ely_gpui_component::theme::Radius::Md))
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface)
            .p_2()
            .font_family(theme.mono_family.clone())
            .text_size(theme.text_size(TextSize::Xs))
            .child(
                ScrollArea::new("install-log-scroll")
                    .vertical()
                    .size_full()
                    .track_scroll(&install.scroll)
                    .children(lines),
            ),
    )
    .into_any_element()
}

/// The sign-in step: save the CLI's account, or add one.
fn sign_in(
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> (Option<SharedString>, Vec<AnyElement>) {
    let handle = handle.clone();
    match state.sign_in_status() {
        SignInStatus::Unadopted { .. } => (
            Some(tr(cx, keys::STEP_SIGNIN_UNADOPTED)),
            vec![
                tagged(
                    SIGN_IN_SELECTOR,
                    Button::new("checklist-adopt", tr(cx, keys::ACCOUNTS_ADOPT))
                        .primary()
                        .size(ControlSize::Sm)
                        .disabled(state.is_busy(Op::Adopt))
                        .on_click(move |_, _, cx| {
                            handle.update(cx, |state, cx| state.adopt_account(cx))
                        }),
                )
                .self_start()
                .into_any_element(),
            ],
        ),
        _ => (
            Some(tr(cx, keys::STEP_SIGNIN_TODO)),
            vec![
                tagged(
                    SIGN_IN_SELECTOR,
                    Button::new("checklist-sign-in", tr(cx, keys::ACTION_SIGN_IN))
                        .icon(IconName::LogIn)
                        .primary()
                        .size(ControlSize::Sm)
                        .on_click(move |_, _, cx| {
                            handle.update(cx, |state, cx| state.open_add_account(cx))
                        }),
                )
                .self_start()
                .into_any_element(),
            ],
        ),
    }
}

/// Balance, burn rate, time left and running runtimes, once everything is set up.
fn summary(state: &AppState, handle: &Entity<AppState>, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let usage = state.active_usage();
    let snapshot = usage.and_then(|usage| usage.snapshot);
    let unknown = || tr(cx, keys::SUMMARY_UNKNOWN);
    let balance = snapshot.map_or_else(unknown, |s| format::cu(cx, s.balance_cu));
    let rate = snapshot.map_or_else(unknown, |s| format::cu_rate(cx, s.rate_cu_per_hour));
    let left = match snapshot {
        None => unknown(),
        Some(snapshot) => match usage.and_then(|usage| usage.eta).or(snapshot.eta()) {
            None => tr(cx, keys::SUMMARY_NOT_BURNING),
            Some(eta) if eta.is_zero() => tr(cx, keys::SUMMARY_EMPTY),
            Some(eta) => format::approx(cx, &format::duration(cx, eta)),
        },
    };
    let totals = state.usage_summary();
    let runtimes = if totals.known == 0 {
        unknown()
    } else {
        SharedString::from(totals.runtimes.to_string())
    };
    let stale_note = snapshot
        .filter(|s| usage_is_stale(s, state.usage_now()))
        .map(|s| usage_stale_note(&s));
    let stale = stale_note.is_some();
    let refresh = handle.clone();
    let email = state
        .active_email()
        .unwrap_or_else(|| tr(cx, keys::ACCOUNTS_NO_EMAIL).to_string());
    let mut header = CardHeader::new(tr(cx, keys::SUMMARY_TITLE)).description(tr_args(
        cx,
        keys::SUMMARY_ACTIVE,
        &[("email", &email)],
    ));
    header = header.action(
        div()
            .flex()
            .items_center()
            .gap_2()
            .children(stale.then(|| Badge::new(tr(cx, keys::USAGE_OUTDATED)).tone(Tone::Warning)))
            .child(tagged(
                "summary-refresh",
                IconButton::new("summary-refresh", IconName::RefreshCw)
                    .tooltip(tr(cx, keys::USAGE_REFRESH))
                    .variant(ButtonVariant::Ghost)
                    .disabled(state.is_busy(Op::Usage))
                    .on_click(move |_, _, cx| {
                        refresh.update(cx, |state, cx| state.refresh_usage(true, cx))
                    }),
            )),
    );
    let tile = |id: &str, label: &str, value: SharedString| {
        tagged(
            format!("summary {id} {value}"),
            div()
                .flex_1()
                .min_w(theme.label_width())
                .flex()
                .flex_col()
                .gap_1()
                .child(Caption::new(tr(cx, label)))
                .child(
                    div()
                        .text_size(theme.text_size(TextSize::Xl))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(value),
                ),
        )
    };
    let failure = state.usage_error().map(|error| {
        InlineMessage::new(
            Severity::Warning,
            crate::errors::explain(error, false, cx).message,
        )
    });
    tagged(
        SUMMARY_SELECTOR,
        Card::new()
            .header(header)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap_6()
                    .child(tile("balance", keys::SUMMARY_BALANCE, balance))
                    .child(tile("rate", keys::SUMMARY_RATE, rate))
                    .child(tile("left", keys::SUMMARY_TIME_LEFT, left))
                    .child(
                        tile("runtimes", keys::SUMMARY_RUNTIMES, runtimes)
                            .child(Caption::new(tr(cx, keys::SUMMARY_RUNTIMES_ALL))),
                    ),
            )
            .children(stale_note.map(|note| InlineMessage::new(Severity::Warning, tr(cx, note))))
            .children(failure),
    )
    .w_full()
}

/// Warns about runtimes the app did not start that are billing.
pub fn unmanaged_warning(
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> Option<AnyElement> {
    let unmanaged = state.unmanaged();
    if unmanaged.is_empty() {
        return None;
    }
    let lines: Vec<String> = unmanaged
        .iter()
        .map(|(email, count)| {
            let email = email
                .clone()
                .unwrap_or_else(|| tr(cx, keys::ACCOUNTS_NO_EMAIL).to_string());
            if *count == 1 {
                tr_args(cx, keys::UNMANAGED_ONE, &[("email", &email)]).to_string()
            } else {
                tr_args(
                    cx,
                    keys::UNMANAGED_MANY,
                    &[("email", &email), ("count", &count.to_string())],
                )
                .to_string()
            }
        })
        .collect();
    let handle = handle.clone();
    Some(
        tagged(
            "unmanaged-warning",
            Alert::new(
                "unmanaged",
                Severity::Warning,
                tr(cx, keys::UNMANAGED_TITLE),
            )
            .body(lines.join("\n"))
            .action(
                Button::new("unmanaged-view", tr(cx, keys::ACTION_VIEW_SESSIONS))
                    .size(ControlSize::Sm)
                    .on_click(move |_, _, cx| {
                        handle.update(cx, |state, cx| state.navigate(Route::Sessions, cx))
                    }),
            ),
        )
        .w_full()
        .into_any_element(),
    )
}
