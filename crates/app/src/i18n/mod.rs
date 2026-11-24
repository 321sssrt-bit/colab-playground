//! The app's message catalog on top of Ely's `I18n` global.
//!
//! Ely's `I18n` holds the app's catalogs and the shown locale. Ely's own components read
//! `ely_gpui_component::i18n::text`, which looks in the app's catalog first and then in Ely's
//! built-in table for the same locale tag, so registering `en-US`, `zh-CN`, `zh-TW`, `ja-JP` and
//! `ko-KR` here, each a tag Ely has a table for, keeps every Ely string translated too. App keys
//! all start with `app.` so they never shadow one of Ely's (`theme.system`, `select.placeholder`,
//! ...). A missing key panics in Ely, so code names keys only through the constants in [`keys`],
//! and the tests check that every key resolves in every locale.

use ely_gpui_component::i18n::I18n;
use gpui::{App, SharedString};

pub use colab_playground_shared::i18n::{
    CATALOGS, Language, Messages, fill_lenient, keys, resolve,
};

pub fn catalog(language: Language) -> I18n {
    CATALOGS
        .iter()
        .fold(I18n::new(language.tag()), |i18n, (tag, messages)| {
            i18n.catalog(tag, messages)
        })
}

/// Installs the catalog as the app's `I18n` global. Call after Ely's `init`.
pub fn install(language: Language, cx: &mut App) {
    log::info!("i18n: showing {}", language.tag());
    cx.set_global(catalog(language));
}

/// Shows `language` in every window (Ely's strings included).
pub fn set_language(language: Language, cx: &mut App) {
    I18n::set_locale(language.tag(), cx);
}

pub fn current(cx: &App) -> Language {
    let tag = cx.global::<I18n>().locale().tag;
    Language::ALL
        .into_iter()
        .find(|language| language.tag() == tag)
        .unwrap_or_else(|| panic!("i18n: the app has no catalog for {tag}"))
}

pub fn tr(cx: &App, key: &str) -> SharedString {
    cx.global::<I18n>().text(key, &[])
}

pub fn tr_args(cx: &App, key: &str, args: &[(&str, &str)]) -> SharedString {
    cx.global::<I18n>().text(key, args)
}

/// A message about `count` things: `one` for exactly one, otherwise `many`, which also gets
/// `{count}`. Both get `args`.
pub fn tr_count(
    cx: &App,
    count: usize,
    one: &str,
    many: &str,
    args: &[(&str, &str)],
) -> SharedString {
    if count == 1 {
        tr_args(cx, one, args)
    } else {
        let count = count.to_string();
        let mut args = args.to_vec();
        args.push(("count", &count));
        tr_args(cx, many, &args)
    }
}

/// The raw message for `key` in the shown language, `{name}` placeholders unfilled.
pub fn template(cx: &App, key: &str) -> &'static str {
    colab_playground_shared::i18n::template(current(cx), key)
}

/// The message for `key` with `{name}` filled from `args`; a placeholder with no argument is
/// left as written instead of panicking (for values that are only sometimes known, such as
/// an error's parameters).
pub fn tr_lenient(cx: &App, key: &str, args: &[(&str, &str)]) -> SharedString {
    fill_lenient(template(cx, key), args).into()
}

#[cfg(test)]
mod tests;
