//! The app's message catalog on top of Ely's `I18n` global.
//!
//! Ely's `I18n` holds the app's catalogs and the shown locale. Ely's own components read
//! `ely_gpui_component::i18n::text`, which looks in the app's catalog first and then in Ely's
//! built-in table for the same locale tag, so registering `en-US`, `zh-CN` and `zh-TW` here keeps
//! every Ely string translated too. App keys all start with `app.` so they never shadow one of
//! Ely's (`theme.system`, `select.placeholder`, ...). A missing key panics in Ely, so code names
//! keys only through the constants in [`keys`], and the tests check that every key resolves in
//! every locale.

mod en_us;
mod zh_cn;
mod zh_tw;

use ely_gpui_component::i18n::I18n;
use gpui::{App, SharedString};

use crate::settings::LanguagePref;

macro_rules! catalog_keys {
    ($($name:ident => $key:literal,)*) => {
        /// Every key of the app's catalog. Name keys through these constants, never literals.
        pub mod keys {
            $(
                #[doc = concat!("`", $key, "`")]
                pub const $name: &str = $key;
            )*
            /// Every key, in declaration order.
            pub const ALL: &[&str] = &[$($key,)*];
        }
    };
}

catalog_keys! {
    APP_NAME => "app.name",
    NAV_OVERVIEW => "app.nav.overview",
    NAV_SESSIONS => "app.nav.sessions",
    NAV_PLUGINS => "app.nav.plugins",
    NAV_ACCOUNTS => "app.nav.accounts",
    NAV_SETTINGS => "app.nav.settings",
    SHELL_ACCOUNT_SIGNED_OUT => "app.shell.account.signed_out",
    SHELL_ACCOUNT_HINT => "app.shell.account.hint",
    SHELL_USAGE => "app.shell.usage",
    SHELL_USAGE_HINT => "app.shell.usage.hint",
    SHELL_BACKEND_MOCK => "app.shell.backend.mock",
    SHELL_BACKEND_MOCK_HINT => "app.shell.backend.mock.hint",
    OVERVIEW_SUBTITLE => "app.overview.subtitle",
    SESSIONS_SUBTITLE => "app.sessions.subtitle",
    SESSIONS_EMPTY_TITLE => "app.sessions.empty.title",
    SESSIONS_EMPTY_BODY => "app.sessions.empty.body",
    PLUGINS_SUBTITLE => "app.plugins.subtitle",
    PLUGINS_EMPTY_TITLE => "app.plugins.empty.title",
    PLUGINS_EMPTY_BODY => "app.plugins.empty.body",
    ACCOUNTS_SUBTITLE => "app.accounts.subtitle",
    ACCOUNTS_EMPTY_TITLE => "app.accounts.empty.title",
    ACCOUNTS_EMPTY_BODY => "app.accounts.empty.body",
    SETTINGS_SUBTITLE => "app.settings.subtitle",
    SETTINGS_GENERAL_TITLE => "app.settings.general.title",
    SETTINGS_GENERAL_DESCRIPTION => "app.settings.general.description",
    SETTINGS_LANGUAGE_TITLE => "app.settings.language.title",
    SETTINGS_LANGUAGE_DESCRIPTION => "app.settings.language.description",
    SETTINGS_LANGUAGE_SYSTEM => "app.settings.language.system",
    LANG_EN_US => "app.language.en_us",
    LANG_ZH_CN => "app.language.zh_cn",
    LANG_ZH_TW => "app.language.zh_tw",
    SETTINGS_APPEARANCE_TITLE => "app.settings.appearance.title",
    SETTINGS_APPEARANCE_DESCRIPTION => "app.settings.appearance.description",
    SETTINGS_ABOUT_TITLE => "app.settings.about.title",
    SETTINGS_ABOUT_DESCRIPTION => "app.settings.about.description",
    SETTINGS_VERSION_TITLE => "app.settings.version.title",
    SETTINGS_BACKEND_TITLE => "app.settings.backend.title",
    SETTINGS_BACKEND_DESCRIPTION => "app.settings.backend.description",
    BACKEND_MOCK => "app.backend.mock",
    BACKEND_REAL => "app.backend.real",
    SETTINGS_FILE_TITLE => "app.settings.file.title",
    SETTINGS_FILE_UNSAVED => "app.settings.file.unsaved",
    SETTINGS_FILE_OPEN => "app.settings.file.open",
    TOAST_OPEN_FOLDER_FAILED_TITLE => "app.toast.open_folder_failed.title",
    TOAST_SAVE_FAILED_TITLE => "app.toast.save_failed.title",
    TOAST_SETTINGS_RESET_TITLE => "app.toast.settings_reset.title",
    TOAST_SETTINGS_RESET_BODY => "app.toast.settings_reset.body",
    TOAST_SETTINGS_RESET_BODY_LOST => "app.toast.settings_reset.body_lost",
    TOAST_DEFAULTS_RESET_TITLE => "app.toast.defaults_reset.title",
    TOAST_DEFAULTS_RESET_BODY => "app.toast.defaults_reset.body",
    // Actions
    ACTION_CANCEL => "app.action.cancel",
    ACTION_CLOSE => "app.action.close",
    ACTION_RETRY => "app.action.retry",
    ACTION_REFRESH => "app.action.refresh",
    ACTION_CHECK_AGAIN => "app.action.check_again",
    ACTION_DISMISS => "app.action.dismiss",
    ACTION_INSTALL_CLI => "app.action.install_cli",
    ACTION_SIGN_IN => "app.action.sign_in",
    ACTION_SIGN_IN_AGAIN => "app.action.sign_in_again",
    ACTION_ADD_ACCOUNT => "app.action.add_account",
    ACTION_SWITCH_ACCOUNT => "app.action.switch_account",
    ACTION_INSTALL_WSL => "app.action.install_wsl",
    ACTION_VIEW_SESSIONS => "app.action.view_sessions",
    // Formats
    FMT_CU => "app.fmt.cu",
    FMT_CU_RATE => "app.fmt.cu_rate",
    FMT_DAYS_HOURS => "app.fmt.days_hours",
    FMT_HOURS_MINUTES => "app.fmt.hours_minutes",
    FMT_MINUTES => "app.fmt.minutes",
    FMT_UNDER_MINUTE => "app.fmt.under_minute",
    FMT_JUST_NOW => "app.fmt.just_now",
    FMT_MINUTES_AGO => "app.fmt.minutes_ago",
    FMT_HOURS_AGO => "app.fmt.hours_ago",
    FMT_DAYS_AGO => "app.fmt.days_ago",
    FMT_APPROX => "app.fmt.approx",
    FMT_LIST_SEPARATOR => "app.fmt.list_separator",
    // Usage
    USAGE_BADGE => "app.usage.badge",
    USAGE_OUTDATED => "app.usage.outdated",
    USAGE_TIP_LEFT => "app.usage.tip.left",
    USAGE_TIP_IDLE => "app.usage.tip.idle",
    USAGE_TIP_EMPTY => "app.usage.tip.empty",
    USAGE_TIP_UPDATED => "app.usage.tip.updated",
    USAGE_TIP_STALE => "app.usage.tip.stale",
    USAGE_TIP_OLD => "app.usage.tip.old",
    USAGE_TIP_UNKNOWN => "app.usage.tip.unknown",
    USAGE_REFRESH => "app.usage.refresh",
    // Overview
    CHECKLIST_TITLE => "app.checklist.title",
    CHECKLIST_DESCRIPTION => "app.checklist.description",
    STEP_CHECKING => "app.step.checking",
    STEP_WAITING => "app.step.waiting",
    STEP_WSL_TITLE => "app.step.wsl.title",
    STEP_WSL_DONE => "app.step.wsl.done",
    STEP_WSL_TODO => "app.step.wsl.todo",
    STEP_SHELL_TITLE => "app.step.shell.title",
    STEP_SHELL_DONE => "app.step.shell.done",
    STEP_SHELL_NO_SSH => "app.step.shell.no_ssh",
    STEP_SHELL_TODO => "app.step.shell.todo",
    STEP_CLI_TITLE => "app.step.cli.title",
    STEP_CLI_DONE => "app.step.cli.done",
    STEP_CLI_DONE_UNKNOWN => "app.step.cli.done_unknown",
    STEP_CLI_TODO => "app.step.cli.todo",
    STEP_SIGNIN_TITLE => "app.step.signin.title",
    STEP_SIGNIN_DONE => "app.step.signin.done",
    STEP_SIGNIN_TODO => "app.step.signin.todo",
    STEP_SIGNIN_UNADOPTED => "app.step.signin.unadopted",
    INSTALL_METHOD_LABEL => "app.install.method_label",
    INSTALL_UV => "app.install.uv",
    INSTALL_UV_FIRST => "app.install.uv_first",
    INSTALL_PIP => "app.install.pip",
    INSTALL_START => "app.install.start",
    INSTALL_RUNNING => "app.install.running",
    INSTALL_CANCELLING => "app.install.cancelling",
    INSTALL_DONE => "app.install.done",
    INSTALL_FAILED => "app.install.failed",
    INSTALL_CANCELLED => "app.install.cancelled",
    SUMMARY_TITLE => "app.summary.title",
    SUMMARY_ACTIVE => "app.summary.active",
    SUMMARY_BALANCE => "app.summary.balance",
    SUMMARY_RATE => "app.summary.rate",
    SUMMARY_TIME_LEFT => "app.summary.time_left",
    SUMMARY_RUNTIMES => "app.summary.runtimes",
    SUMMARY_RUNTIMES_ALL => "app.summary.runtimes_all",
    SUMMARY_UNKNOWN => "app.summary.unknown",
    SUMMARY_NOT_BURNING => "app.summary.not_burning",
    SUMMARY_EMPTY => "app.summary.empty",
    UNMANAGED_TITLE => "app.unmanaged.title",
    UNMANAGED_ONE => "app.unmanaged.one",
    UNMANAGED_MANY => "app.unmanaged.many",
    BACKEND_START_FAILED => "app.backend.start_failed",
    // Accounts
    ACCOUNTS_ACTIVE => "app.accounts.active",
    ACCOUNTS_SWITCH => "app.accounts.switch",
    ACCOUNTS_REMOVE => "app.accounts.remove",
    ACCOUNTS_REMOVE_ACTIVE => "app.accounts.remove_active",
    ACCOUNTS_REMOVE_RUNNING => "app.accounts.remove_running",
    ACCOUNTS_NO_EMAIL => "app.accounts.no_email",
    ACCOUNTS_BALANCE => "app.accounts.balance",
    ACCOUNTS_RATE => "app.accounts.rate",
    ACCOUNTS_TIME_LEFT => "app.accounts.time_left",
    ACCOUNTS_UPDATED => "app.accounts.updated",
    ACCOUNTS_TOTAL_TITLE => "app.accounts.total.title",
    ACCOUNTS_TOTAL_MISSING_ONE => "app.accounts.total.missing_one",
    ACCOUNTS_TOTAL_MISSING_MANY => "app.accounts.total.missing_many",
    ACCOUNTS_USAGE_FAILED => "app.accounts.usage_failed",
    ACCOUNTS_UNADOPTED_TITLE => "app.accounts.unadopted.title",
    ACCOUNTS_UNADOPTED_TITLE_NO_EMAIL => "app.accounts.unadopted.title_no_email",
    ACCOUNTS_UNADOPTED_BODY => "app.accounts.unadopted.body",
    ACCOUNTS_ADOPT => "app.accounts.adopt",
    ACCOUNTS_RECOVERED_TITLE => "app.accounts.recovered.title",
    ACCOUNTS_RECOVERED_BODY => "app.accounts.recovered.body",
    ACCOUNTS_KEYRING_TITLE => "app.accounts.keyring.title",
    ACCOUNTS_KEYRING_BODY => "app.accounts.keyring.body",
    ACCOUNTS_NEEDS_CLI => "app.accounts.needs_cli",
    ACCOUNTS_LOADING => "app.accounts.loading",
    SWITCHER_GROUP => "app.switcher.group",
    SWITCHER_ADD => "app.switcher.add",
    SWITCHER_MANAGE => "app.switcher.manage",
    // Dialogs
    ADD_TITLE => "app.add.title",
    ADD_INTRO => "app.add.intro",
    ADD_IMPACT => "app.add.impact",
    ADD_CONTINUE => "app.add.continue",
    ADD_STARTING => "app.add.starting",
    ADD_OPENED => "app.add.opened",
    ADD_OPEN_AGAIN => "app.add.open_again",
    ADD_CODE_LABEL => "app.add.code_label",
    ADD_CODE_PLACEHOLDER => "app.add.code_placeholder",
    ADD_SUBMIT => "app.add.submit",
    ADD_SUBMITTING => "app.add.submitting",
    ADD_START_AGAIN => "app.add.start_again",
    ADD_DONE => "app.add.done",
    ADD_ROLLED_BACK => "app.add.rolled_back",
    SWITCH_TITLE => "app.switch.title",
    SWITCH_LOADING => "app.switch.loading",
    SWITCH_NOTHING => "app.switch.nothing",
    SWITCH_TUNNELS => "app.switch.tunnels",
    SWITCH_TUNNEL => "app.switch.tunnel",
    SWITCH_SESSIONS => "app.switch.sessions",
    SWITCH_SESSION => "app.switch.session",
    SWITCH_SESSION_DEADLINE => "app.switch.session_deadline",
    SWITCH_CONFIRM => "app.switch.confirm",
    SWITCH_DONE => "app.switch.done",
    REMOVE_TITLE => "app.remove.title",
    REMOVE_BODY => "app.remove.body",
    REMOVE_CONFIRM => "app.remove.confirm",
    REMOVE_DONE => "app.remove.done",
    ADOPT_DONE => "app.adopt.done",
    // Settings: defaults and host
    DEFAULTS_TITLE => "app.defaults.title",
    DEFAULTS_DESCRIPTION => "app.defaults.description",
    DEF_LIMIT => "app.def.limit",
    DEF_NO_LIMIT => "app.def.no_limit",
    DEF_MAX_RUNTIME => "app.def.max_runtime",
    DEF_MAX_RUNTIME_HINT => "app.def.max_runtime_hint",
    DEF_MAX_SPEND => "app.def.max_spend",
    DEF_MAX_SPEND_HINT => "app.def.max_spend_hint",
    DEF_MIN_BALANCE => "app.def.min_balance",
    DEF_MIN_BALANCE_HINT => "app.def.min_balance_hint",
    DEF_IDLE => "app.def.idle",
    DEF_IDLE_HINT => "app.def.idle_hint",
    DEF_CONCURRENT => "app.def.concurrent",
    DEF_CONCURRENT_HINT => "app.def.concurrent_hint",
    DEF_ATTEMPTS => "app.def.attempts",
    DEF_ATTEMPTS_HINT => "app.def.attempts_hint",
    DEF_RETRY_DELAY => "app.def.retry_delay",
    DEF_ON_EXHAUSTED => "app.def.on_exhausted",
    DEF_EXHAUSTED_STOP => "app.def.exhausted_stop",
    DEF_EXHAUSTED_KEEP => "app.def.exhausted_keep",
    DEF_POLL_ACTIVE => "app.def.poll_active",
    DEF_POLL_IDLE => "app.def.poll_idle",
    DEF_POLL_HINT => "app.def.poll_hint",
    DEF_ACCELERATOR => "app.def.accelerator",
    DEF_HIGH_MEM => "app.def.high_mem",
    DEF_MIN_VRAM => "app.def.min_vram",
    DEF_MIN_VRAM_HINT => "app.def.min_vram_hint",
    DEF_WINDDOWN => "app.def.winddown",
    DEF_WINDDOWN_HINT => "app.def.winddown_hint",
    DEF_RESET => "app.def.reset",
    UNIT_GB => "app.unit.gb",
    UNIT_CU => "app.unit.cu",
    ACC_NONE => "app.acc.none",
    ACC_T4 => "app.acc.t4",
    ACC_L4 => "app.acc.l4",
    ACC_G4 => "app.acc.g4",
    ACC_A100 => "app.acc.a100",
    ACC_H100 => "app.acc.h100",
    ACC_V5E1 => "app.acc.v5e1",
    ACC_V6E1 => "app.acc.v6e1",
    HOST_TITLE => "app.host.title",
    HOST_DESCRIPTION => "app.host.description",
    HOST_WSL => "app.host.wsl",
    HOST_WSL_DEFAULT => "app.host.wsl_default",
    HOST_COLAB_PATH => "app.host.colab_path",
    HOST_PYTHON_PATH => "app.host.python_path",
    HOST_PATH_PLACEHOLDER => "app.host.path_placeholder",
    HOST_APPLY => "app.host.apply",
    HOST_BOTH_NEEDED => "app.host.both_needed",
    HOST_MOCK_NOTE => "app.host.mock_note",
    HOST_BUSY => "app.host.busy",
    // Errors (one per core ErrorKind) and next steps
    ERR_UNKNOWN => "app.err.unknown",
    ERR_DETAILS => "app.err.details",
    ERR_NOT_INSTALLED => "app.err.not_installed",
    ERR_AUTH_REQUIRED => "app.err.auth_required",
    ERR_NOT_ENTITLED => "app.err.not_entitled",
    ERR_CAPACITY_REFUSED => "app.err.capacity_refused",
    ERR_SSH_BUSY => "app.err.ssh_busy",
    ERR_SESSION_GONE => "app.err.session_gone",
    ERR_CONNECTION_LOST => "app.err.connection_lost",
    ERR_EXEC_TIMEOUT => "app.err.exec_timeout",
    ERR_PORT_IN_USE => "app.err.port_in_use",
    ERR_PORT_RESERVED => "app.err.port_reserved",
    ERR_INVALID_INPUT => "app.err.invalid_input",
    ERR_NO_ACTIVE_ACCOUNT => "app.err.no_active_account",
    ERR_ACTIVE_NOT_ADOPTED => "app.err.active_not_adopted",
    ERR_ACCOUNT_NOT_ACTIVE => "app.err.account_not_active",
    ERR_ACCOUNT_NOT_FOUND => "app.err.account_not_found",
    ERR_KEYRING_UNAVAILABLE => "app.err.keyring_unavailable",
    ERR_ADD_IN_PROGRESS => "app.err.add_in_progress",
    ERR_LEGACY_TOKEN => "app.err.legacy_token",
    ERR_LOGIN_CANCELLED => "app.err.login_cancelled",
    ERR_LOGIN_INVALID_CODE => "app.err.login_invalid_code",
    ERR_LOGIN_UNVERIFIED => "app.err.login_unverified",
    ERR_CANCELLED => "app.err.cancelled",
    ERR_UNSUPPORTED => "app.err.unsupported",
    ERR_WSL_UNAVAILABLE => "app.err.wsl_unavailable",
    ERR_COMMAND_TOO_LONG => "app.err.command_too_long",
    ERR_SESSION_LIMIT => "app.err.session_limit",
    ERR_BUSY => "app.err.busy",
    ERR_PROVISION_EXHAUSTED => "app.err.provision_exhausted",
    ERR_ORPHAN_SUSPECTED => "app.err.orphan_suspected",
    ERR_MANIFEST_INVALID => "app.err.manifest_invalid",
    ERR_PLUGIN_EXISTS => "app.err.plugin_exists",
    ERR_PLUGIN_NOT_FOUND => "app.err.plugin_not_found",
    ERR_PLUGIN_RUN_FAILED => "app.err.plugin_run_failed",
    ERR_HEALTH_CHECK_FAILED => "app.err.health_check_failed",
    ERR_GIT_FAILED => "app.err.git_failed",
    ERR_INSTALL_FAILED => "app.err.install_failed",
    ERR_HTTP => "app.err.http",
    ERR_HTTP_UNAVAILABLE => "app.err.http_unavailable",
    ERR_PARSE => "app.err.parse",
    ERR_IO => "app.err.io",
    ERR_TIMEOUT => "app.err.timeout",
    ERR_UNSUPPORTED_CLI => "app.err.unsupported_cli",
    ERR_OTHER => "app.err.other",
    NS_TRY_AGAIN => "app.ns.try_again",
    NS_RETRY_LATER => "app.ns.retry_later",
    NS_SWITCH_ACCOUNT => "app.ns.switch_account",
    NS_ADD_ACCOUNT => "app.ns.add_account",
    NS_SIGN_IN_AGAIN => "app.ns.sign_in_again",
    NS_UNLOCK_KEYRING => "app.ns.unlock_keyring",
    NS_OTHER_ACCELERATOR => "app.ns.other_accelerator",
    NS_STOP_A_SESSION => "app.ns.stop_a_session",
    NS_OTHER_PORT => "app.ns.other_port",
    NS_CLOSE_CONNECTION => "app.ns.close_connection",
    NS_INSTALL_CLI => "app.ns.install_cli",
    NS_INSTALL_WSL => "app.ns.install_wsl",
    NS_UPDATE_APP => "app.ns.update_app",
    NS_CHECK_INPUT => "app.ns.check_input",
    NS_CHECK_NETWORK => "app.ns.check_network",
    NS_REFRESH => "app.ns.refresh",
    NS_REVIEW_RUNTIMES => "app.ns.review_runtimes",
    NS_VIEW_LOG => "app.ns.view_log",
    NS_REPORT_PROBLEM => "app.ns.report_problem",
}

/// A message table: `(key, message)` pairs; `{name}` marks an argument.
pub type Messages = &'static [(&'static str, &'static str)];

/// The app's catalogs, `en-US` first (Ely checks every later catalog against the first).
pub const CATALOGS: [(&str, Messages); 3] = [
    ("en-US", en_us::MESSAGES),
    ("zh-CN", zh_cn::MESSAGES),
    ("zh-TW", zh_tw::MESSAGES),
];

/// A display language the app ships.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Language {
    /// English (United States).
    EnUs,
    /// Simplified Chinese.
    ZhCn,
    /// Traditional Chinese, Taiwan wording.
    ZhTw,
}

impl Language {
    /// Every language, in catalog order.
    pub const ALL: [Language; 3] = [Language::EnUs, Language::ZhCn, Language::ZhTw];

    /// The BCP 47 tag Ely's `I18n` knows it by.
    pub fn tag(self) -> &'static str {
        match self {
            Language::EnUs => "en-US",
            Language::ZhCn => "zh-CN",
            Language::ZhTw => "zh-TW",
        }
    }

    /// The key of its name in its own language.
    pub fn name_key(self) -> &'static str {
        match self {
            Language::EnUs => keys::LANG_EN_US,
            Language::ZhCn => keys::LANG_ZH_CN,
            Language::ZhTw => keys::LANG_ZH_TW,
        }
    }

    /// The language for an OS locale such as `zh-Hant-TW`, `zh_HK.UTF-8` or `en-GB`:
    /// Traditional for a `Hant` script or a TW/HK/MO region, Simplified for any other Chinese,
    /// English otherwise. An explicit script wins over the region (`zh-Hans-HK` is Simplified).
    pub fn from_os_locale(locale: &str) -> Language {
        let tag = locale
            .split(['.', '@'])
            .next()
            .unwrap_or_default()
            .replace('_', "-");
        let mut parts = tag.split('-').filter(|part| !part.is_empty());
        let is_chinese = parts
            .next()
            .is_some_and(|language| language.eq_ignore_ascii_case("zh"));
        if !is_chinese {
            return Language::EnUs;
        }
        let (mut script, mut region) = (None, None);
        for part in parts {
            if part.len() == 4 && part.chars().all(|c| c.is_ascii_alphabetic()) {
                script.get_or_insert(part.to_ascii_lowercase());
            } else if part.len() == 2
                || (part.len() == 3 && part.chars().all(|c| c.is_ascii_digit()))
            {
                region.get_or_insert(part.to_ascii_uppercase());
            }
        }
        match script.as_deref() {
            Some("hant") => Language::ZhTw,
            Some("hans") => Language::ZhCn,
            _ => match region.as_deref() {
                Some("TW" | "HK" | "MO") => Language::ZhTw,
                _ => Language::ZhCn,
            },
        }
    }
}

/// The language a preference shows, given the OS locale (`None` when it is unknown).
pub fn resolve(pref: LanguagePref, os_locale: Option<&str>) -> Language {
    match pref {
        LanguagePref::System => os_locale.map_or(Language::EnUs, Language::from_os_locale),
        LanguagePref::EnUs => Language::EnUs,
        LanguagePref::ZhCn => Language::ZhCn,
        LanguagePref::ZhTw => Language::ZhTw,
    }
}

/// Ely's `I18n` holding the app's three catalogs, showing `language`.
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

/// The shown language.
pub fn current(cx: &App) -> Language {
    let tag = cx.global::<I18n>().locale().tag;
    Language::ALL
        .into_iter()
        .find(|language| language.tag() == tag)
        .unwrap_or_else(|| panic!("i18n: the app has no catalog for {tag}"))
}

/// The message for `key` in the shown language.
pub fn tr(cx: &App, key: &str) -> SharedString {
    cx.global::<I18n>().text(key, &[])
}

/// The message for `key`, each `{name}` filled from `args`.
pub fn tr_args(cx: &App, key: &str, args: &[(&str, &str)]) -> SharedString {
    cx.global::<I18n>().text(key, args)
}

/// The raw message for `key` in the shown language, `{name}` placeholders unfilled.
pub fn template(cx: &App, key: &str) -> &'static str {
    let tag = current(cx).tag();
    CATALOGS
        .iter()
        .find(|(each, _)| *each == tag)
        .and_then(|(_, messages)| messages.iter().find(|(k, _)| *k == key))
        .map(|(_, message)| *message)
        .unwrap_or_else(|| panic!("i18n: no message {key:?} in {tag}"))
}

/// The message for `key` with `{name}` filled from `args`; a placeholder with no argument is
/// left as written instead of panicking (for values that are only sometimes known, such as
/// an error's parameters).
pub fn tr_lenient(cx: &App, key: &str, args: &[(&str, &str)]) -> SharedString {
    fill_lenient(template(cx, key), args).into()
}

/// `message` with each `{name}` that has an argument replaced.
pub fn fill_lenient(message: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        match args.iter().find(|(arg, _)| *arg == name) {
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&rest[open..open + close + 2]),
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests;
