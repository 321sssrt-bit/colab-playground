//! The window's root view: the app's title strip over Ely's app shell (sidebar and page), the
//! toasts, and Ely's resize border for client-drawn windows.

use ely_gpui_component::{
    feedback::ToastViewport,
    forms::TextInput,
    layout::{AppShell, ScrollArea},
    primitives::FocusScope,
    shell::ResizeBorder,
    theme::{ActiveTheme, Mode, TextSize},
};
use gpui::{
    AppContext, Context, Entity, FocusHandle, IntoElement, ParentElement, Render, Styled,
    Subscription, Window, div, prelude::FluentBuilder as _,
};

use crate::{
    i18n::keys,
    platform::{self, Chrome},
    state::AppState,
    ui::{Inputs, dialogs, pages, sidebar, tagged, titlebar},
};

/// Selector of the scrolling page area.
pub const PAGE_SELECTOR: &str = "page-area";

/// The main window's content.
pub struct RootView {
    focus: FocusHandle,
    state: Entity<AppState>,
    inputs: Inputs,
    _subscriptions: Vec<Subscription>,
}

impl RootView {
    /// The root over `state`; follows the window's light or dark appearance into the state.
    pub fn new(state: Entity<AppState>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let (colab_path, colab_python) = {
            let settings = state.read(cx).settings();
            (
                settings.colab_path.clone().unwrap_or_default(),
                settings.colab_python.clone().unwrap_or_default(),
            )
        };
        let field =
            |text: String, label: &'static str, window: &mut Window, cx: &mut Context<Self>| {
                cx.new(|cx| {
                    let mut input = TextInput::new(window, cx)
                        .label_key(label)
                        .placeholder_key(keys::HOST_PATH_PLACEHOLDER);
                    input.set_text(text, cx);
                    input
                })
            };
        let inputs = Inputs {
            code: cx.new(|cx| {
                TextInput::new(window, cx)
                    .label_key(keys::ADD_CODE_LABEL)
                    .placeholder_key(keys::ADD_CODE_PLACEHOLDER)
            }),
            colab_path: field(colab_path, keys::HOST_COLAB_PATH, window, cx),
            colab_python: field(colab_python, keys::HOST_PYTHON_PATH, window, cx),
        };
        let subscriptions = vec![
            cx.observe(&state, |_, _, cx| cx.notify()),
            cx.observe_window_appearance(window, |this, window, cx| {
                let mode = Mode::from(window.appearance());
                this.state
                    .update(cx, |state, cx| state.system_appearance_changed(mode, cx));
            }),
        ];
        let mode = Mode::from(window.appearance());
        state.update(cx, |state, cx| state.system_appearance_changed(mode, cx));
        Self {
            focus,
            state,
            inputs,
            _subscriptions: subscriptions,
        }
    }

    /// The text fields this view owns.
    pub fn inputs(&self) -> &Inputs {
        &self.inputs
    }

    /// The state this view draws.
    pub fn state(&self) -> &Entity<AppState> {
        &self.state
    }

    /// The root focus handle.
    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }
}

impl Render for RootView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let chrome = platform::chrome(window.window_decorations());
        let title_bar = titlebar::render(chrome, window, cx);
        let handle = self.state.clone();
        let state = self.state.read(cx);
        let theme = cx.theme();
        let mut root = FocusScope::new(&self.focus)
            .root()
            .size_full()
            .flex()
            .flex_col()
            // Client-drawn on Linux, Ely's resize border grounds a rounded pane instead.
            .when(chrome != Chrome::LinuxClient, |root| {
                root.bg(theme.colors.bg)
            })
            .text_color(theme.colors.fg)
            .font_family(theme.font_family.clone())
            .text_size(theme.text_size(TextSize::Base));
        // Han characters come from the platform's CJK faces; see `platform`.
        root.text_style().font_fallbacks = state.font_fallbacks().cloned();
        let root = root
            .child(title_bar)
            .child(
                div().flex_1().min_h_0().w_full().child(
                    AppShell::new()
                        .sidebar(sidebar::render(state, &handle, cx))
                        .child(
                            tagged(
                                PAGE_SELECTOR,
                                ScrollArea::new(PAGE_SELECTOR)
                                    .vertical()
                                    .size_full()
                                    .child(pages::render(state, &handle, &self.inputs, cx)),
                            )
                            .flex_1()
                            .min_h_0()
                            .w_full(),
                        ),
                ),
            )
            .children(dialogs::render(state, &handle, &self.inputs, cx))
            .child(ToastViewport::new("toasts", state.toaster()));
        ResizeBorder::new().child(root)
    }
}
