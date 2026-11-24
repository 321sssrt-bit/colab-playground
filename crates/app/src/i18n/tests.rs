use std::collections::BTreeSet;

use super::{Language, catalog, keys};

fn arguments(message: &str) -> BTreeSet<&str> {
    message
        .split('{')
        .skip(1)
        .filter_map(|rest| rest.split_once('}').map(|(name, _)| name))
        .collect()
}

#[test]
fn ely_resolves_every_app_key_in_each_catalog() {
    for language in Language::ALL {
        let i18n = catalog(language);
        assert_eq!(i18n.locale().tag, language.tag());
        for key in keys::ALL {
            let english = colab_playground_shared::i18n::template(Language::EnUs, key);
            let names = arguments(english);
            let args: Vec<(&str, &str)> = names.iter().map(|name| (*name, "x")).collect();
            let text = i18n.text(key, &args);
            assert!(
                !text.trim().is_empty(),
                "{key} is empty in {}",
                language.tag()
            );
        }
    }
}

#[test]
fn app_code_names_keys_only_through_the_constants() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let this_test = src.join("i18n").join("tests.rs");
    let mut offenders = Vec::new();
    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("src is readable") {
            let path = entry.expect("an entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "rs") || path == this_test {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("a source file");
            if text.contains("\"app.") {
                offenders.push(path.display().to_string());
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these files spell catalog keys as literals instead of i18n::keys constants: {offenders:?}"
    );
}
