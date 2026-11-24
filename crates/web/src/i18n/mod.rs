//! The base control labels come from the pinned Ely catalog (c01a140) so Web builds need no GUI dependency.

mod en;
mod ja;
mod ko;
mod zh_cn;
mod zh_tw;

use std::collections::BTreeMap;

use colab_playground_shared::i18n::{self, CATALOGS};

pub(crate) const HEADLESS_KEYRING: &str = "web.keyring.headless";
pub(crate) const UNMANAGED_UNKNOWN: &str = "web.runtimes.unmanaged_unknown";
pub(crate) const INVALID_REQUEST: &str = "web.error.invalid_request";
pub(crate) const LOCALE_NOT_FOUND: &str = "web.error.locale_not_found";
pub(crate) const INSTALL_NOT_RUNNING: &str = "web.error.install_not_running";

pub(crate) const FORWARD_BIND_WINDOWS: &str = "web.forward.bind_windows_or_wsl";
pub(crate) const FORWARD_BIND_LOOPBACK: &str = "web.forward.bind_loopback_listener";
pub(crate) const FORWARD_SERVER_LOCAL: &str = "web.forward.server_local";
pub(crate) const FORWARD_DOWNSTREAM_AUTH: &str = "web.forward.downstream_auth";

const WEB_CATALOGS: [(&str, i18n::Messages); 5] = [
    ("en-US", en::MESSAGES),
    ("zh-CN", zh_cn::MESSAGES),
    ("zh-TW", zh_tw::MESSAGES),
    ("ja-JP", ja::MESSAGES),
    ("ko-KR", ko::MESSAGES),
];

pub(crate) type Messages = BTreeMap<&'static str, &'static str>;

pub(crate) fn dictionary(locale: &str) -> Option<Messages> {
    let shared = CATALOGS.iter().find(|(tag, _)| *tag == locale)?.1;
    let web = WEB_CATALOGS.iter().find(|(tag, _)| *tag == locale)?.1;
    Some(shared.iter().chain(web).copied().collect())
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn all_catalogs_have_the_same_keys_and_no_collisions() {
        assert_eq!(
            CATALOGS.map(|(tag, _)| tag),
            WEB_CATALOGS.map(|(tag, _)| tag)
        );
        let keys = |table: i18n::Messages| -> BTreeSet<&'static str> {
            table.iter().map(|(key, _)| *key).collect()
        };
        let shared_keys = keys(CATALOGS[0].1);
        let web_keys = keys(WEB_CATALOGS[0].1);
        assert!(shared_keys.is_disjoint(&web_keys));
        for ((tag, shared), (_, web)) in CATALOGS.into_iter().zip(WEB_CATALOGS) {
            assert_eq!(keys(shared), shared_keys, "{tag}");
            assert_eq!(keys(web), web_keys, "{tag}");
            assert_eq!(shared.len(), shared_keys.len(), "{tag}");
            assert_eq!(web.len(), web_keys.len(), "{tag}");
            let merged = dictionary(tag).unwrap();
            assert_eq!(merged.len(), shared_keys.len() + web_keys.len(), "{tag}");
            assert!(
                merged.values().all(|value| !value.trim().is_empty()),
                "{tag}"
            );
        }
    }
}
