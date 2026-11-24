//! The desktop rendering of a core error and its next step.

use colab_playground_core::Error;
use colab_playground_shared::errors::message;
use gpui::{App, SharedString};

use crate::i18n::{keys, tr, tr_lenient};

pub use colab_playground_shared::errors::{ErrorAction, kind_key, next_step};

#[derive(Clone, Debug, PartialEq)]
pub struct Explained {
    pub message: SharedString,
    /// What to do, when there is no button for it (or to go with the button).
    pub hint: Option<SharedString>,
    pub action: Option<ErrorAction>,
    /// Technical detail for a "details" line (untranslated, never secret).
    pub detail: Option<SharedString>,
}

pub fn explain(error: &Error, can_retry: bool, cx: &App) -> Explained {
    let error = message(error, can_retry);
    Explained {
        message: tr_lenient(cx, error.key, &error.args),
        hint: error.hint_key.map(|key| tr(cx, key)),
        action: error.action,
        detail: error
            .detail
            .map(|detail| tr_lenient(cx, keys::ERR_DETAILS, &[("detail", detail)])),
    }
}
