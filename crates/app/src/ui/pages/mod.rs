//! One function per page. A page that needs local state (text fields, scroll positions) keeps it
//! in `AppState` or in an entity the root view owns (see `ui::Inputs`).

pub mod accounts;
pub mod defaults;
pub mod overview;
pub mod placeholder;
pub mod settings;

use ely_gpui_component::{
    layout::Page,
    theme::{ActiveTheme, ContainerSize},
};
use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div};

use crate::{
    i18n::tr,
    route::Route,
    state::AppState,
    ui::{Inputs, pages::placeholder::Placeholder, tagged},
};

/// The page for the current route.
pub fn render(
    state: &AppState,
    handle: &Entity<AppState>,
    inputs: &Inputs,
    cx: &App,
) -> AnyElement {
    let route = state.route();
    let page = match route {
        Route::Overview => overview::render(state, handle, cx),
        Route::Sessions => placeholder::render(Placeholder::Sessions, cx),
        Route::Plugins => placeholder::render(Placeholder::Plugins, cx),
        Route::Accounts => accounts::render(state, handle, cx),
        Route::Settings => settings::render(state, handle, inputs, cx),
    };
    frame(route, page, cx)
}

/// The page under its title, centred at a readable width. In test builds the frame carries the
/// selector `page <slug> <title>`, so tests can check which page shows in which language.
fn frame(route: Route, page: Page, cx: &App) -> AnyElement {
    let title = tr(cx, route.title_key());
    let theme = cx.theme();
    tagged(
        format!("page {} {title}", route.slug()),
        div()
            .w_full()
            .max_w(theme.container_width(ContainerSize::Lg))
            .mx_auto()
            .child(page),
    )
    .w_full()
    .into_any_element()
}

/// A page titled with the route's name.
pub fn page(route: Route, subtitle_key: &str, cx: &App) -> Page {
    Page::new(tr(cx, route.title_key())).subtitle(tr(cx, subtitle_key))
}
