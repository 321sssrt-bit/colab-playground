use std::collections::BTreeSet;

use super::{CATALOGS, Language, fill_lenient, keys, resolve, template};
use crate::settings::LanguagePref;

fn arguments(message: &str) -> BTreeSet<&str> {
    message
        .split('{')
        .skip(1)
        .filter_map(|rest| rest.split_once('}').map(|(name, _)| name))
        .collect()
}

#[test]
fn every_catalog_holds_exactly_the_declared_keys_once() {
    let declared: BTreeSet<&str> = keys::ALL.iter().copied().collect();
    assert_eq!(declared.len(), keys::ALL.len(), "a key is declared twice");
    for key in &declared {
        assert!(
            key.starts_with("app."),
            "{key} could shadow one of Ely's keys"
        );
    }
    for (tag, messages) in CATALOGS {
        let found: BTreeSet<&str> = messages.iter().map(|(key, _)| *key).collect();
        assert_eq!(found.len(), messages.len(), "{tag} repeats a key");
        let missing: Vec<_> = declared.difference(&found).collect();
        let extra: Vec<_> = found.difference(&declared).collect();
        assert!(missing.is_empty(), "{tag} misses {missing:?}");
        assert!(extra.is_empty(), "{tag} has undeclared {extra:?}");
    }
}

#[test]
fn every_key_resolves_in_every_language_with_the_same_arguments() {
    for language in Language::ALL {
        for key in keys::ALL {
            let english = template(Language::EnUs, key);
            let message = template(language, key);
            assert!(
                !message.trim().is_empty(),
                "{key} is empty in {}",
                language.tag()
            );
            assert_eq!(
                arguments(message),
                arguments(english),
                "{key} in {} takes other arguments than in en-US",
                language.tag()
            );
        }
    }
}

#[test]
fn interpolation_leaves_missing_placeholders_and_replacement_text_alone() {
    assert_eq!(
        fill_lenient("{known} {unknown} {known} {", &[("known", "{value}")]),
        "{value} {unknown} {value} {"
    );
}

#[test]
fn os_locales_resolve_to_the_shipped_languages() {
    let cases = [
        ("zh-CN", Language::ZhCn),
        ("zh_CN.UTF-8", Language::ZhCn),
        ("zh", Language::ZhCn),
        ("zh-SG", Language::ZhCn),
        ("zh-Hans-CN", Language::ZhCn),
        ("zh-Hans-HK", Language::ZhCn),
        ("zh-TW", Language::ZhTw),
        ("zh_TW.Big5", Language::ZhTw),
        ("zh-HK", Language::ZhTw),
        ("zh_HK.UTF-8", Language::ZhTw),
        ("zh-MO", Language::ZhTw),
        ("zh-Hant", Language::ZhTw),
        ("zh-Hant-TW", Language::ZhTw),
        ("ZH-hant-cn", Language::ZhTw),
        ("ja-JP", Language::JaJp),
        ("ja_JP.UTF-8", Language::JaJp),
        ("ja_JP.eucJP", Language::JaJp),
        ("JA-jp", Language::JaJp),
        ("ja", Language::JaJp),
        ("ko-KR", Language::KoKr),
        ("ko_KR.UTF-8", Language::KoKr),
        ("ko_KR.euckr", Language::KoKr),
        ("KO-kr", Language::KoKr),
        ("ko-Kore-KR", Language::KoKr),
        ("ko", Language::KoKr),
        ("en-US", Language::EnUs),
        ("en-GB", Language::EnUs),
        ("jv-ID", Language::EnUs),
        ("kok-IN", Language::EnUs),
        ("C", Language::EnUs),
        ("POSIX", Language::EnUs),
        ("", Language::EnUs),
    ];
    for (locale, expected) in cases {
        assert_eq!(Language::from_os_locale(locale), expected, "{locale:?}");
    }
}

#[test]
fn a_preference_resolves_with_the_os_locale_only_for_system() {
    assert_eq!(resolve(LanguagePref::System, Some("zh-HK")), Language::ZhTw);
    assert_eq!(resolve(LanguagePref::System, None), Language::EnUs);
    assert_eq!(resolve(LanguagePref::EnUs, Some("zh-CN")), Language::EnUs);
    assert_eq!(resolve(LanguagePref::ZhCn, Some("en-US")), Language::ZhCn);
    assert_eq!(resolve(LanguagePref::ZhTw, None), Language::ZhTw);
    assert_eq!(resolve(LanguagePref::System, Some("ja-JP")), Language::JaJp);
    assert_eq!(resolve(LanguagePref::System, Some("ko-KR")), Language::KoKr);
    assert_eq!(resolve(LanguagePref::JaJp, Some("ko-KR")), Language::JaJp);
    assert_eq!(resolve(LanguagePref::KoKr, Some("ja-JP")), Language::KoKr);
}
