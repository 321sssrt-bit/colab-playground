//! Views. The root view draws the title strip, the shell and the account dialogs; pages are
//! functions of the app state (plus the few text fields the root view owns).

pub mod dialogs;
pub mod error_view;
pub mod pages;
pub mod root;
pub mod sidebar;
pub mod titlebar;

use ely_gpui_component::forms::TextInput;
use gpui::{Div, Entity, InteractiveElement, IntoElement, ParentElement, div};

/// Wraps `element` in a plain `div` that carries `selector` for
/// `VisualTestContext::debug_bounds` in test builds (gpui records selectors only with its
/// `test-support` feature in debug builds; elsewhere this is a bare `div`). Use it around Ely
/// components that do not expose a selector of their own (`NavItem`, `Button`, `Select`, ...)
/// so headless tests can find and click them.
pub fn tagged(selector: impl Into<String>, element: impl IntoElement) -> Div {
    let selector = selector.into();
    div().debug_selector(move || selector).child(element)
}

/// Text fields the root view owns (a `TextInput` needs a window to be made).
#[derive(Clone)]
pub struct Inputs {
    /// The pasted authorisation code.
    pub code: Entity<TextInput>,
    /// Settings: path of `colab`.
    pub colab_path: Entity<TextInput>,
    /// Settings: path of its Python interpreter.
    pub colab_python: Entity<TextInput>,
}
