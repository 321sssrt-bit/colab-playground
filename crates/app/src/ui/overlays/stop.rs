//! Stop and end billing, confirmed once, stating that the runtime's data is wiped.

use ely_gpui_component::{
    buttons::{Button, ButtonVariant},
    feedback::InlineMessage,
    overlays::Dialog,
    primitives::{IconName, Severity},
    typography::Paragraph,
};
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement};

use super::{cancel_button, close};
use crate::{
    i18n::{keys, tr, tr_args},
    state::{AppState, StopPrompt},
    ui::{error_view, tagged},
};

/// Selector of the confirming button.
pub const STOP_CONFIRM: &str = "stop-confirm";

pub(super) fn render(
    prompt: &StopPrompt,
    state: &AppState,
    handle: &Entity<AppState>,
    cx: &App,
) -> AnyElement {
    let email = prompt
        .email
        .clone()
        .unwrap_or_else(|| tr(cx, keys::ACCOUNTS_NO_EMAIL).to_string());
    let stopping = state.is_stopping(&prompt.target);
    let (cancel, confirm) = (tr(cx, keys::ACTION_CANCEL), tr(cx, keys::STOP_ACTION));
    let mut dialog = Dialog::new("stop-runtime", tr(cx, keys::STOP_TITLE), close(handle))
        .child(Paragraph::new(tr_args(
            cx,
            keys::STOP_BODY,
            &[("name", &prompt.label), ("email", &email)],
        )))
        .child(InlineMessage::new(
            Severity::Warning,
            tr(cx, keys::STOP_WIPED),
        ));
    if let Some(error) = &prompt.error {
        dialog = dialog.child(error_view::alert("stop", None, error, None, handle, cx));
    }
    let go = handle.clone();
    dialog
        .action({
            let handle = handle.clone();
            move |_| cancel_button(cancel, handle)
        })
        .action(move |_| {
            tagged(
                STOP_CONFIRM,
                Button::new(STOP_CONFIRM, confirm)
                    .variant(ButtonVariant::Danger)
                    .icon(IconName::Square)
                    .loading(stopping)
                    .disabled(stopping)
                    .on_click(move |_, _, cx| go.update(cx, |state, cx| state.confirm_stop(cx))),
            )
        })
        .into_any_element()
}
