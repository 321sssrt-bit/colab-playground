//! TODO(batch 2): Sessions and Plugins show Ely's empty state until their feature work lands
//! (DESIGN.md section 5).

use ely_gpui_component::{feedback::EmptyState, layout::Page, primitives::IconName};
use gpui::{App, ParentElement};

use crate::{
    i18n::{keys, tr},
    route::Route,
};

/// A page that has no content yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Placeholder {
    /// The sessions table.
    Sessions,
    /// The plugin list.
    Plugins,
}

impl Placeholder {
    /// The route it stands in for.
    pub fn route(self) -> Route {
        match self {
            Placeholder::Sessions => Route::Sessions,
            Placeholder::Plugins => Route::Plugins,
        }
    }

    /// Subtitle, empty-state icon, empty-state title and body.
    fn content(self) -> (&'static str, IconName, &'static str, &'static str) {
        match self {
            Placeholder::Sessions => (
                keys::SESSIONS_SUBTITLE,
                IconName::Server,
                keys::SESSIONS_EMPTY_TITLE,
                keys::SESSIONS_EMPTY_BODY,
            ),
            Placeholder::Plugins => (
                keys::PLUGINS_SUBTITLE,
                IconName::Puzzle,
                keys::PLUGINS_EMPTY_TITLE,
                keys::PLUGINS_EMPTY_BODY,
            ),
        }
    }
}

/// The empty-state page.
pub fn render(placeholder: Placeholder, cx: &App) -> Page {
    let route = placeholder.route();
    let (subtitle, icon, title, body) = placeholder.content();
    super::page(route, subtitle, cx).child(
        EmptyState::new(format!("{}-empty", route.slug()), icon, tr(cx, title)).body(tr(cx, body)),
    )
}
