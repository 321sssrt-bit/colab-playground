//! Quitting with runtimes still billing: stop them all, leave them running (saying which
//! have an automatic stop and which do not), or cancel.

use ely_gpui_component::{
    buttons::{Button, ButtonVariant},
    data_display::{Badge, Tone},
    feedback::InlineMessage,
    overlays::Dialog,
    primitives::Severity,
    theme::{ActiveTheme, TextSize},
    typography::{Caption, Paragraph},
};
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, SharedString, Styled, div};

use super::{busy_line, cancel_button_when, close};
use crate::{
    errors,
    i18n::{keys, tr, tr_args},
    state::{AppState, QuitPrompt},
    ui::tagged,
};

/// Selector of "Stop all and quit".
pub const QUIT_STOP_ALL: &str = "quit-stop-all";
/// Selector of "Leave running and quit".
pub const QUIT_LEAVE: &str = "quit-leave";

fn count(cx: &App, one: &str, many: &str, n: usize) -> SharedString {
    if n == 1 {
        tr(cx, one)
    } else {
        tr_args(cx, many, &[("count", &n.to_string())])
    }
}

pub(super) fn render(
    prompt: &QuitPrompt,
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> AnyElement {
    // Live, not the snapshot taken when the prompt opened: the list may still be loading.
    let live = state.billing();
    let billing = &live;
    let listed = matches!(state.runtimes(), crate::state::Load::Ready(_));
    let stopping = state.is_stopping_all();
    let mut lines: Vec<(Severity, SharedString)> = Vec::new();
    if !billing.watched.is_empty() {
        lines.push((
            Severity::Info,
            count(
                cx,
                keys::QUIT_WATCHED_ONE,
                keys::QUIT_WATCHED_MANY,
                billing.watched.len(),
            ),
        ));
    }
    if !billing.unwatched.is_empty() {
        lines.push((
            Severity::Warning,
            count(
                cx,
                keys::QUIT_UNWATCHED_ONE,
                keys::QUIT_UNWATCHED_MANY,
                billing.unwatched.len(),
            ),
        ));
    }
    if billing.provisioning {
        lines.push((Severity::Warning, tr(cx, keys::QUIT_PROVISIONING)));
    }
    if billing.running_plugin {
        lines.push((Severity::Warning, tr(cx, keys::QUIT_RUNNING_PLUGIN)));
    }
    if billing.unknown {
        lines.push((Severity::Warning, tr(cx, keys::QUIT_UNKNOWN)));
    }
    let mut dialog = Dialog::new("quit", tr(cx, keys::QUIT_TITLE), close(handle))
        .child(
            div().flex().flex_col().gap_2().children(
                lines
                    .into_iter()
                    .map(|(severity, text)| InlineMessage::new(severity, text)),
            ),
        )
        .child(runtime_list(billing, state, cx))
        .children((!listed).then(|| Caption::new(tr(cx, keys::SESSIONS_LOADING))))
        .child(Paragraph::new(tr(cx, keys::QUIT_LEAVE_EXPLAINED)))
        .child(tagged(
            "quit-wipe",
            InlineMessage::new(Severity::Warning, tr(cx, keys::QUIT_STOP_WIPED)),
        ));
    for (label, error) in &prompt.failures {
        let message = errors::explain(error, false, cx).message;
        dialog = dialog.child(tagged(
            "quit-failure",
            InlineMessage::new(
                Severity::Danger,
                tr_args(
                    cx,
                    keys::QUIT_STOP_FAILED,
                    &[("name", label), ("why", &message)],
                ),
            ),
        ));
    }
    if stopping {
        dialog = dialog.child(busy_line("quit-stopping", tr(cx, keys::QUIT_STOPPING)));
    }
    let (cancel, leave, stop) = (
        tr(cx, keys::ACTION_CANCEL),
        tr(cx, keys::QUIT_LEAVE),
        tr(cx, keys::QUIT_STOP_ALL),
    );
    let (leave_handle, stop_handle) = (handle.clone(), handle.clone());
    dialog
        .action({
            let handle = handle.clone();
            move |_| cancel_button_when(cancel, handle, !stopping)
        })
        .action(move |_| {
            tagged(
                QUIT_LEAVE,
                Button::new(QUIT_LEAVE, leave)
                    .disabled(stopping)
                    .on_click(move |_, _, cx| {
                        leave_handle.update(cx, |state, cx| state.quit_leaving_running(cx))
                    }),
            )
        })
        .action(move |_| {
            tagged(
                QUIT_STOP_ALL,
                Button::new(QUIT_STOP_ALL, stop)
                    .variant(ButtonVariant::Danger)
                    .loading(stopping)
                    .disabled(stopping || !listed)
                    .on_click(move |_, _, cx| {
                        stop_handle.update(cx, |state, cx| state.quit_stopping_all(cx))
                    }),
            )
        })
        .into_any_element()
}

/// Every runtime "Stop all" would stop, by name and account, marking the ones this app did
/// not start.
fn runtime_list(billing: &crate::state::Billing, state: &AppState, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let rows = billing
        .watched
        .iter()
        .chain(&billing.unwatched)
        .filter_map(|target| state.runtime(target))
        .map(|runtime| {
            let label = crate::state::runtime_label(runtime);
            let email = runtime
                .account_email
                .clone()
                .unwrap_or_else(|| tr(cx, keys::ACCOUNTS_NO_EMAIL).to_string());
            let mut row = div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .text_size(theme.text_size(TextSize::Sm))
                .child(format!(
                    "• {}",
                    tr_args(cx, keys::ENDED_LINE, &[("name", &label), ("email", &email)])
                ));
            if !runtime.managed {
                row = row.child(tagged(
                    format!("quit-unmanaged {label}"),
                    Badge::new(tr(cx, keys::RUNTIME_UNMANAGED)).tone(Tone::Warning),
                ));
            }
            tagged(format!("quit-runtime {label}"), row)
        });
    div()
        .flex()
        .flex_col()
        .gap_1()
        .children(rows)
        .into_any_element()
}
