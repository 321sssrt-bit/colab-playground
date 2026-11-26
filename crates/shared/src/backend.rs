use std::fmt;

use colab_playground_core::{
    mock::{MockFailures, MockLoginFailure, MockScenario},
    sessions::Accelerator,
};

/// Environment variable that picks the backend when no flag is given: `mock` or `real`.
pub const BACKEND_ENV: &str = "COLAB_PLAYGROUND_BACKEND";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendKind {
    /// Deterministic simulation; never touches WSL, the `colab` CLI or a Google account.
    Mock,
    /// The real `colab` CLI through the core crate's `Host`.
    Real,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendError {
    ConflictingFlags,
    InvalidEnv(String),
    UnknownScenario(String),
    UnknownFailure(String),
    UnknownArgument(String),
    MissingValue(&'static str),
    /// A simulation flag without the simulation (it would otherwise start the real backend).
    MockFlagWithoutMock(&'static str),
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BackendError::ConflictingFlags => write!(f, "pass at most one of --mock and --real"),
            BackendError::InvalidEnv(value) => {
                write!(
                    f,
                    "{BACKEND_ENV}={value:?} is not one of \"mock\" or \"real\""
                )
            }
            BackendError::UnknownScenario(value) => write!(
                f,
                "--mock-scenario {value:?} is not one of {}",
                names(SCENARIOS, ", ")
            ),
            BackendError::UnknownFailure(value) => write!(
                f,
                "--mock-fail {value:?} is not one of {}",
                names(FAILURES, ", ")
            ),
            BackendError::UnknownArgument(arg) => write!(f, "unknown argument {arg:?}"),
            BackendError::MissingValue(flag) => write!(f, "{flag} needs a value"),
            BackendError::MockFlagWithoutMock(flag) => {
                write!(f, "{flag} only applies to the simulation; add --mock")
            }
        }
    }
}

impl std::error::Error for BackendError {}

impl BackendKind {
    /// Debug builds default to mock, release builds to real (a hard safety rule in
    /// `docs/DESIGN.md`).
    pub fn build_default() -> Self {
        if cfg!(debug_assertions) {
            BackendKind::Mock
        } else {
            BackendKind::Real
        }
    }

    /// A `--mock`/`--real` flag wins over `env` (the value of [`BACKEND_ENV`]), which wins over
    /// [`Self::build_default`]. Other arguments are ignored. Pure, so tests never touch the
    /// process environment.
    pub fn resolve<S: AsRef<str>>(args: &[S], env: Option<&str>) -> Result<Self, BackendError> {
        let mock = args.iter().any(|arg| arg.as_ref() == "--mock");
        let real = args.iter().any(|arg| arg.as_ref() == "--real");
        match (mock, real) {
            (true, true) => return Err(BackendError::ConflictingFlags),
            (true, false) => return Ok(BackendKind::Mock),
            (false, true) => return Ok(BackendKind::Real),
            (false, false) => {}
        }
        match env.map(str::trim) {
            None | Some("") => Ok(Self::build_default()),
            Some(value) if value.eq_ignore_ascii_case("mock") => Ok(BackendKind::Mock),
            Some(value) if value.eq_ignore_ascii_case("real") => Ok(BackendKind::Real),
            Some(value) => Err(BackendError::InvalidEnv(value.to_owned())),
        }
    }
}

/// The mock's starting world and injected failures, from `--mock-scenario` and `--mock-fail`.
#[derive(Clone, Debug, PartialEq)]
pub struct MockFlags {
    pub scenario: MockScenario,
    pub failures: MockFailures,
}

type StartWorld = fn() -> MockScenario;
type Inject = fn(&mut MockFailures);

const SCENARIOS: &[(&str, StartWorld)] = &[
    ("demo", MockScenario::demo),
    ("single", MockScenario::single),
    ("signed-out", MockScenario::signed_out),
];

const FAILURES: &[(&str, Inject)] = &[
    ("cli-missing", |f| f.cli_missing = true),
    ("install-fails", |f| f.install_fails = true),
    ("install-off-path", |f| f.install_off_path = true),
    ("keyring", |f| f.keyring_unavailable = true),
    ("usage-fails", |f| f.usage_fetch_fails = true),
    ("login-invalid-code", |f| {
        f.login = Some(MockLoginFailure::InvalidCode)
    }),
    ("login-unverified", |f| {
        f.login = Some(MockLoginFailure::VerificationFailed)
    }),
    ("not-entitled", |f| {
        f.not_entitled = vec![Accelerator::A100, Accelerator::H100]
    }),
    ("no-answer", |f| {
        f.allocation_hangs = vec![Accelerator::A100]
    }),
    ("ssh-busy", |f| f.ssh_busy_attempts = 1),
    ("plugin-fails", |f| {
        f.plugin_fail_stage = Some("download".into())
    }),
    ("watchdog-restart-fails", |f| {
        f.watchdog_restart_fails = true
    }),
    ("update-available", |f| f.update_available = true),
    ("update-check-fails", |f| f.update_check_fails = true),
    ("update-unsupported", |f| f.update_unsupported = true),
    ("update-download-fails", |f| f.update_download_fails = true),
    ("update-unverified", |f| f.update_unverified = true),
    ("update-install-fails", |f| f.update_install_fails = true),
    ("runtimes-fail", |f| f.runtimes_listing_fails = true),
];

fn names<T>(table: &[(&str, T)], separator: &str) -> String {
    let names: Vec<&str> = table.iter().map(|(name, _)| *name).collect();
    names.join(separator)
}

impl MockFlags {
    /// Reads `--mock-scenario NAME` (default `demo`) and `--mock-fail a,b`, as `--flag value`
    /// or `--flag=value`.
    pub fn parse<S: AsRef<str>>(args: &[S]) -> Result<Self, BackendError> {
        let mut flags = MockFlags {
            scenario: MockScenario::demo(),
            failures: MockFailures::default(),
        };
        if let Some(name) = flag_value(args, "--mock-scenario") {
            let Some((_, scenario)) = SCENARIOS.iter().find(|(known, _)| *known == name) else {
                return Err(BackendError::UnknownScenario(name));
            };
            flags.scenario = scenario();
        }
        if let Some(list) = flag_value(args, "--mock-fail") {
            for name in list
                .split(',')
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                let Some((_, inject)) = FAILURES.iter().find(|(known, _)| *known == name) else {
                    return Err(BackendError::UnknownFailure(name.to_owned()));
                };
                inject(&mut flags.failures);
            }
        }
        Ok(flags)
    }
}

/// How to call the program, printed with any argument error.
pub fn usage() -> String {
    format!(
        "usage: colab-playground [--real | --mock [--mock-scenario {}] [--mock-fail NAME[,NAME...]]]\n  --mock-fail names: {}",
        names(SCENARIOS, "|"),
        names(FAILURES, ", ")
    )
}

const VALUE_FLAGS: [&str; 2] = ["--mock-scenario", "--mock-fail"];

#[derive(Clone, Debug, PartialEq)]
pub enum BackendSelection {
    Mock(MockFlags),
    Real,
}

/// Rejects unknown arguments and missing values before any backend is chosen.
pub fn check_args<S: AsRef<str>>(
    args: &[S],
    extra_value_flags: &[&'static str],
    is_extra_switch: impl Fn(&str) -> bool,
) -> Result<(), BackendError> {
    backend_args(args, extra_value_flags, is_extra_switch).map(|_| ())
}

/// Validates the command line and resolves the backend without constructing it.
/// Extra options belong to the caller. Value flags accept both `--flag value` and
/// `--flag=value`; the switch predicate sees the entire argument.
pub fn source_from_args<S: AsRef<str>>(
    args: &[S],
    env: Option<&str>,
    extra_value_flags: &[&'static str],
    is_extra_switch: impl Fn(&str) -> bool,
) -> Result<BackendSelection, BackendError> {
    let args = backend_args(args, extra_value_flags, is_extra_switch)?;
    match BackendKind::resolve(&args, env)? {
        BackendKind::Mock => Ok(BackendSelection::Mock(MockFlags::parse(&args)?)),
        BackendKind::Real => {
            for flag in VALUE_FLAGS {
                if flag_value(&args, flag).is_some() {
                    return Err(BackendError::MockFlagWithoutMock(flag));
                }
            }
            Ok(BackendSelection::Real)
        }
    }
}

fn backend_args<'a, S: AsRef<str>>(
    args: &'a [S],
    extra_value_flags: &[&'static str],
    is_extra_switch: impl Fn(&str) -> bool,
) -> Result<Vec<&'a str>, BackendError> {
    let mut backend = Vec::new();
    let mut iter = args.iter().map(AsRef::as_ref);
    while let Some(arg) = iter.next() {
        if matches!(arg, "--mock" | "--real") {
            backend.push(arg);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (arg, None),
        };
        let shared = VALUE_FLAGS.iter().copied().find(|flag| *flag == name);
        let extra = extra_value_flags.iter().copied().find(|flag| *flag == name);
        if let Some(flag) = shared.or(extra) {
            let value = match inline {
                Some(value) => Some(value),
                None => iter.next().filter(|value| !value.starts_with("--")),
            };
            let value = value
                .filter(|value| !value.trim().is_empty())
                .ok_or(BackendError::MissingValue(flag))?;
            if shared.is_some() {
                backend.push(arg);
                if inline.is_none() {
                    backend.push(value);
                }
            }
        } else if !is_extra_switch(arg) {
            return Err(BackendError::UnknownArgument(arg.to_owned()));
        }
    }
    Ok(backend)
}

fn flag_value<S: AsRef<str>>(args: &[S], flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    let mut iter = args.iter().map(AsRef::as_ref);
    while let Some(arg) = iter.next() {
        if arg == flag {
            return iter.next().map(str::to_owned);
        }
        if let Some(value) = arg.strip_prefix(&prefix) {
            return Some(value.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use colab_playground_core::mock::MockScenario;

    use super::{BackendError, BackendKind, BackendSelection, MockFlags};

    #[test]
    fn flags_win_over_env_and_env_over_the_build_default() {
        let none: [&str; 0] = [];
        assert_eq!(
            BackendKind::resolve(&none, None),
            Ok(BackendKind::build_default())
        );
        assert_eq!(
            BackendKind::resolve(&none, Some("")),
            Ok(BackendKind::build_default())
        );
        assert_eq!(
            BackendKind::resolve(&none, Some("real")),
            Ok(BackendKind::Real)
        );
        assert_eq!(
            BackendKind::resolve(&none, Some(" MOCK ")),
            Ok(BackendKind::Mock)
        );
        assert_eq!(
            BackendKind::resolve(&["--mock"], Some("real")),
            Ok(BackendKind::Mock)
        );
        assert_eq!(
            BackendKind::resolve(&["--real"], Some("mock")),
            Ok(BackendKind::Real)
        );
        assert_eq!(
            BackendKind::resolve(&["--mock-scenario", "single", "--mock"], None),
            Ok(BackendKind::Mock)
        );
    }

    #[test]
    fn unknown_arguments_and_missing_values_are_errors() {
        use super::{check_args, source_from_args};
        let check_args = |args: &[&str]| check_args(args, &[], |_| false);
        let source_from_args =
            |args: &[&str], env: Option<&str>| source_from_args(args, env, &[], |_| false);
        assert_eq!(
            check_args(&["--mok"]),
            Err(BackendError::UnknownArgument("--mok".into())),
            "a typo of --mock is not ignored"
        );
        assert_eq!(
            check_args(&["--mock", "stray"]),
            Err(BackendError::UnknownArgument("stray".into()))
        );
        assert_eq!(
            check_args(&["--mock", "--mock-scenario"]),
            Err(BackendError::MissingValue("--mock-scenario"))
        );
        assert_eq!(
            check_args(&["--mock-scenario", "--mock"]),
            Err(BackendError::MissingValue("--mock-scenario")),
            "a flag is not a value"
        );
        assert_eq!(
            check_args(&["--mock", "--mock-fail="]),
            Err(BackendError::MissingValue("--mock-fail"))
        );
        assert!(
            check_args(&["--mock", "--mock-scenario", "single", "--mock-fail=keyring"]).is_ok()
        );
        assert!(check_args(&[]).is_ok());
        assert!(check_args(&["--real"]).is_ok());
        let flags = MockFlags::parse(&["--mock", "--mock-fail", "watchdog-restart-fails"]).unwrap();
        assert!(flags.failures.watchdog_restart_fails);
        let flags =
            MockFlags::parse(&["--mock", "--mock-fail=cli-missing,install-off-path"]).unwrap();
        assert!(flags.failures.cli_missing && flags.failures.install_off_path);
        assert!(super::usage().contains("install-off-path"));
        let flags =
            MockFlags::parse(&["--mock", "--mock-fail=update-available,update-check-fails"])
                .unwrap();
        assert!(flags.failures.update_available && flags.failures.update_check_fails);
        let flags = MockFlags::parse(&[
            "--mock",
            "--mock-fail=update-unsupported,update-download-fails,update-unverified,update-install-fails",
        ])
        .unwrap();
        let f = &flags.failures;
        assert!(
            f.update_unsupported
                && f.update_download_fails
                && f.update_unverified
                && f.update_install_fails
        );
        assert!(super::usage().contains("update-available"));
        assert!(super::usage().contains("watchdog-restart-fails"));

        // Simulation flags without the simulation would start the real backend.
        assert!(matches!(
            source_from_args(&["--mock-scenario", "single"], Some("real")),
            Err(BackendError::MockFlagWithoutMock("--mock-scenario"))
        ));
        assert!(matches!(
            source_from_args(&["--mok"], None),
            Err(BackendError::UnknownArgument(_))
        ));
        assert!(matches!(
            source_from_args(&["--mock", "--mock-scenario", "nope"], None),
            Err(BackendError::UnknownScenario(_))
        ));
        assert!(matches!(
            source_from_args(&["--real"], None),
            Ok(BackendSelection::Real)
        ));
        assert!(matches!(
            source_from_args(&["--mock-scenario", "single"], Some("mock")),
            Ok(BackendSelection::Mock(_))
        ));
    }

    #[test]
    fn conflicting_flags_and_unknown_env_values_fail() {
        assert_eq!(
            BackendKind::resolve(&["--mock", "--real"], None),
            Err(BackendError::ConflictingFlags)
        );
        assert_eq!(
            BackendKind::resolve(&[] as &[&str], Some("fake")),
            Err(BackendError::InvalidEnv("fake".into()))
        );
    }

    #[test]
    fn build_mode_picks_the_default() {
        let expected = if cfg!(debug_assertions) {
            BackendSelection::Mock(MockFlags::parse(&[] as &[&str]).unwrap())
        } else {
            BackendSelection::Real
        };
        assert_eq!(
            super::source_from_args(&[] as &[&str], None, &[], |_| false),
            Ok(expected)
        );
    }

    #[test]
    fn mock_scenarios_and_failures_parse() {
        let none: [&str; 0] = [];
        assert_eq!(
            MockFlags::parse(&none).map(|flags| flags.scenario),
            Ok(MockScenario::demo())
        );
        let flags = MockFlags::parse(&[
            "--mock",
            "--mock-scenario=signed-out",
            "--mock-fail",
            "cli-missing, keyring",
        ])
        .expect("valid flags");
        assert_eq!(flags.scenario, MockScenario::signed_out());
        assert!(flags.failures.cli_missing && flags.failures.keyring_unavailable);
        assert!(!flags.failures.install_fails);
        assert_eq!(
            MockFlags::parse(&["--mock-scenario", "busy"]).map(|flags| flags.scenario),
            Err(BackendError::UnknownScenario("busy".into()))
        );
        assert_eq!(
            MockFlags::parse(&["--mock-fail=nope"]).map(|flags| flags.scenario),
            Err(BackendError::UnknownFailure("nope".into()))
        );
    }

    #[test]
    fn only_allowlisted_extra_options_are_skipped() {
        let parse = |args: &[&str]| {
            super::source_from_args(args, None, &["--host", "--port"], |arg| arg == "--no-open")
        };
        let expected = MockFlags::parse(&["--mock-scenario", "single"]).unwrap();
        assert_eq!(
            parse(&[
                "--host",
                "127.0.0.1",
                "--port=8080",
                "--no-open",
                "--mock",
                "--mock-scenario",
                "single"
            ]),
            Ok(BackendSelection::Mock(expected))
        );
        assert_eq!(
            parse(&["--real", "--host=--mock"]),
            Ok(BackendSelection::Real)
        );
        assert_eq!(
            parse(&["--host", "--mock"]),
            Err(BackendError::MissingValue("--host"))
        );
        assert_eq!(
            parse(&["--port="]),
            Err(BackendError::MissingValue("--port"))
        );
        assert_eq!(
            parse(&["--mock", "--no-open=yes"]),
            Err(BackendError::UnknownArgument("--no-open=yes".into()))
        );
        assert_eq!(
            parse(&["--hosst=127.0.0.1"]),
            Err(BackendError::UnknownArgument("--hosst=127.0.0.1".into()))
        );
        assert_eq!(
            parse(&["--host=127.0.0.1", "--mock", "--real"]),
            Err(BackendError::ConflictingFlags)
        );
    }
}
