//! Settings: language and appearance (live and persisted), the policy defaults for new
//! runtimes, where the CLI lives, and build information.

use ely_gpui_component::{
    buttons::{Button, ButtonVariant, CopyButton},
    data_display::{Badge, Tone},
    forms::{Choice, Select},
    layout::Page,
    primitives::{IconName, Tooltip},
    settings::{SettingsRow, SettingsSection, ThemeSelector},
    theme::{ActiveTheme, ContainerSize, ControlSize, TextSize},
    typography::{Caption, MiddleEllipsis},
};
use gpui::{
    App, Entity, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
    Styled, div,
};

use crate::{
    i18n::{keys, tr, tr_args},
    route::Route,
    settings::LanguagePref,
    state::{AppState, appearance_pref, ely_appearance},
    ui::{Inputs, tagged},
};

/// Selector around the language select.
pub const LANGUAGE_SELECTOR: &str = "settings-language";
/// Selector around the appearance segmented control. Its segments carry Ely's own selectors
/// `segment theme.light`, `segment theme.dark` and `segment theme.system`.
pub const APPEARANCE_SELECTOR: &str = "settings-appearance";
/// Selector around the settings file row's control (path, copy, open folder).
pub const FILE_SELECTOR: &str = "settings-file";
/// Selector of the settings file path.
pub const FILE_PATH_SELECTOR: &str = "settings-file-path";
/// Selector around the "Open folder" button.
pub const OPEN_FOLDER_SELECTOR: &str = "settings-file-open";

/// The label of a language choice in the shown language.
pub fn language_label(pref: LanguagePref, state: &AppState, cx: &App) -> gpui::SharedString {
    match pref {
        LanguagePref::System => {
            let system = tr(cx, state.system_language().name_key());
            tr_args(cx, keys::SETTINGS_LANGUAGE_SYSTEM, &[("language", &system)])
        }
        LanguagePref::EnUs => tr(cx, keys::LANG_EN_US),
        LanguagePref::ZhCn => tr(cx, keys::LANG_ZH_CN),
        LanguagePref::ZhTw => tr(cx, keys::LANG_ZH_TW),
    }
}

/// The settings page.
pub fn render(state: &AppState, handle: &Entity<AppState>, inputs: &Inputs, cx: &App) -> Page {
    super::page(Route::Settings, keys::SETTINGS_SUBTITLE, cx)
        .child(general(state, handle, cx))
        .child(super::defaults::defaults_section(state, handle, cx))
        .child(super::defaults::host_section(state, handle, inputs, cx))
        .child(about(state, handle, cx))
}

fn general(state: &AppState, handle: &Entity<AppState>, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let choices =
        LanguagePref::ALL.map(|pref| Choice::new(pref.value(), language_label(pref, state, cx)));
    let on_language = handle.clone();
    let language = Select::new("settings-language-select", choices)
        .label(tr(cx, keys::SETTINGS_LANGUAGE_TITLE))
        .selected(state.settings().language.value())
        .on_change(move |value, _, cx| match LanguagePref::from_value(value) {
            Some(pref) => on_language.update(cx, |state, cx| state.set_language(pref, cx)),
            None => log::error!("settings: the language select offered unknown {value:?}"),
        });
    let on_appearance = handle.clone();
    let appearance = ThemeSelector::new(
        "settings-appearance-selector",
        ely_appearance(state.settings().appearance),
        move |appearance, _, cx| {
            on_appearance.update(cx, |state, cx| {
                state.set_appearance(appearance_pref(appearance), cx)
            })
        },
    );
    SettingsSection::new(tr(cx, keys::SETTINGS_GENERAL_TITLE))
        .description(tr(cx, keys::SETTINGS_GENERAL_DESCRIPTION))
        .row(
            SettingsRow::new(tr(cx, keys::SETTINGS_LANGUAGE_TITLE))
                .description(tr(cx, keys::SETTINGS_LANGUAGE_DESCRIPTION))
                .control(tagged(LANGUAGE_SELECTOR, language).w(theme.menu_width())),
        )
        .row(
            SettingsRow::new(tr(cx, keys::SETTINGS_APPEARANCE_TITLE))
                .description(tr(cx, keys::SETTINGS_APPEARANCE_DESCRIPTION))
                .control(tagged(APPEARANCE_SELECTOR, appearance)),
        )
}

fn about(state: &AppState, handle: &Entity<AppState>, cx: &App) -> impl IntoElement {
    let backend = if crate::backend::shows_demo_badge(state.flavor()) {
        Badge::new(tr(cx, keys::BACKEND_MOCK)).tone(Tone::Warning)
    } else {
        Badge::new(tr(cx, keys::BACKEND_REAL)).tone(Tone::Info)
    };
    let file = match state.store().file() {
        Some(path) => settings_file(path.display().to_string(), handle, cx).into_any_element(),
        None => Caption::new(tr(cx, keys::SETTINGS_FILE_UNSAVED)).into_any_element(),
    };
    SettingsSection::new(tr(cx, keys::SETTINGS_ABOUT_TITLE))
        .description(tr(cx, keys::SETTINGS_ABOUT_DESCRIPTION))
        .row(
            SettingsRow::new(tr(cx, keys::SETTINGS_VERSION_TITLE))
                .control(div().child(env!("CARGO_PKG_VERSION"))),
        )
        .row(
            SettingsRow::new(tr(cx, keys::SETTINGS_BACKEND_TITLE))
                .description(tr(cx, keys::SETTINGS_BACKEND_DESCRIPTION))
                .control(backend),
        )
        .row(SettingsRow::new(tr(cx, keys::SETTINGS_FILE_TITLE)).control(file))
}

/// The settings file's path cut in the middle to the room there is (whole on hover), with
/// copy and "Open folder". It drops under the row's title when the row is narrow.
fn settings_file(path: String, handle: &Entity<AppState>, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let open = handle.clone();
    tagged(
        FILE_SELECTOR,
        div()
            .flex()
            .items_center()
            .gap_1()
            .max_w(theme.container_width(ContainerSize::Sm))
            .child(
                div()
                    .id(FILE_PATH_SELECTOR)
                    .debug_selector(|| FILE_PATH_SELECTOR.into())
                    .min_w_0()
                    .font_family(theme.mono_family.clone())
                    .text_size(theme.text_size(TextSize::Sm))
                    .tooltip(Tooltip::text(path.clone()))
                    .child(MiddleEllipsis::new(path.clone())),
            )
            .child(
                div()
                    .flex_none()
                    .child(CopyButton::new("settings-file-copy", path)),
            )
            .child(
                tagged(
                    OPEN_FOLDER_SELECTOR,
                    Button::new("settings-file-open", tr(cx, keys::SETTINGS_FILE_OPEN))
                        .icon(IconName::FolderOpen)
                        .variant(ButtonVariant::Ghost)
                        .size(ControlSize::Sm)
                        .on_click(move |_, _, cx| {
                            open.update(cx, |state, cx| state.open_config_folder(cx))
                        }),
                )
                .flex_none(),
            ),
    )
}
