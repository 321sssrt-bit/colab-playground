use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use colab_playground_shared::backend::{self, BackendError, BackendSelection};

use crate::http::TrustedHost;

const PORT: u16 = 3000;
const WEB_VALUES: &[&str] = &["--host", "--port", "--trusted-host"];
const BACKEND_VALUES: &[&str] = &["--mock-scenario", "--mock-fail"];

pub enum Command {
    Help,
    Rotate(BackendSelection),
    Serve(Serve),
}

pub struct Serve {
    pub bind: SocketAddr,
    pub no_open: bool,
    pub trusted_hosts: Vec<TrustedHost>,
    pub backend: BackendSelection,
}

pub fn usage() -> String {
    let backend = backend::usage();
    let backend = backend.trim_start_matches("usage: colab-playground ");
    format!(
        "Usage: colab-playground-web [--host IP] [--port PORT] [--no-open]\n\
         \x20      [--trusted-host [http[s]://]HOST[:PORT]]... {backend}\n\
         \x20      colab-playground-web rotate-token [--mock | --real]\n\
         Listen address defaults to 127.0.0.1:{PORT}.\n\
         A bare --trusted-host uses HTTP and the listen port unless a port is given.\n\
         For a TLS proxy, pass --trusted-host https://HOST[:PORT] and preserve Host.\n\
         First launch and rotate-token require an interactive terminal."
    )
}

pub fn parse(args: &[String], env: Option<&str>) -> Result<Command, &'static str> {
    if matches!(args, [flag] if flag == "--help" || flag == "-h") {
        return Ok(Command::Help);
    }

    let backend = backend::source_from_args(args, env, WEB_VALUES, |arg| {
        matches!(arg, "--no-open" | "rotate-token")
    })
    .map_err(|error| match error {
        BackendError::ConflictingFlags => "Pass at most one of --mock and --real.",
        BackendError::InvalidEnv(_) => "COLAB_PLAYGROUND_BACKEND must be mock or real.",
        BackendError::UnknownScenario(_) => "Unknown --mock-scenario.",
        BackendError::UnknownFailure(_) => "Unknown --mock-fail name.",
        BackendError::UnknownArgument(_) => "Unknown argument.",
        BackendError::MissingValue(_) => "An option is missing its value.",
        BackendError::MockFlagWithoutMock(_) => "Simulation options require the mock backend.",
    })?;

    let mut host = Ipv4Addr::LOCALHOST.into();
    let mut port = PORT;
    let mut no_open = false;
    let mut rotate = false;
    let mut trusted_hosts = Vec::new();
    let mut seen = HashSet::new();
    let mut args = args.iter().map(String::as_str);
    while let Some(arg) = args.next() {
        let (flag, inline) = arg
            .split_once('=')
            .map_or((arg, None), |(flag, value)| (flag, Some(value)));
        if flag != "--trusted-host" && !seen.insert(flag) {
            return Err("Pass each option at most once, except --trusted-host.");
        }
        let mut value = || inline.or_else(|| args.next()).expect("validated argument");
        match flag {
            "--host" => {
                host = value()
                    .parse::<IpAddr>()
                    .map_err(|_| "--host needs an IP address.")?
            }
            "--port" => {
                port = value()
                    .parse()
                    .map_err(|_| "--port needs a port from 0 to 65535.")?
            }
            "--trusted-host" => trusted_hosts.push(TrustedHost::parse(value())?),
            "--no-open" => no_open = true,
            "rotate-token" => rotate = true,
            flag if BACKEND_VALUES.contains(&flag) => {
                value();
            }
            _ => {}
        }
    }

    if rotate {
        if !trusted_hosts.is_empty()
            || seen
                .iter()
                .any(|flag| WEB_VALUES.contains(flag) || BACKEND_VALUES.contains(flag))
            || no_open
        {
            return Err("rotate-token accepts only --mock or --real.");
        }
        return Ok(Command::Rotate(backend));
    }

    Ok(Command::Serve(Serve {
        bind: SocketAddr::new(host, port),
        no_open,
        trusted_hosts,
        backend,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use colab_playground_core::mock::MockScenario;

    fn parse_flags(flags: &[&str], env: Option<&str>) -> Result<Command, &'static str> {
        parse(
            &flags
                .iter()
                .map(|flag| (*flag).to_owned())
                .collect::<Vec<_>>(),
            env,
        )
    }

    #[test]
    fn uses_shared_backend_defaults_and_mock_flags() {
        let Command::Serve(defaults) = parse_flags(&[], None).unwrap() else {
            panic!("expected serve")
        };
        assert_eq!(defaults.bind, "127.0.0.1:3000".parse().unwrap());
        assert_eq!(
            matches!(defaults.backend, BackendSelection::Mock(_)),
            cfg!(debug_assertions)
        );
        assert!(matches!(
            parse_flags(&["rotate-token"], Some("real")),
            Ok(Command::Rotate(BackendSelection::Real))
        ));

        let Command::Serve(options) = parse_flags(
            &[
                "--mock",
                "--mock-scenario=signed-out",
                "--mock-fail",
                "keyring",
                "--host=::1",
                "--port",
                "0",
                "--no-open",
                "--trusted-host",
                "https://console.example",
            ],
            Some("real"),
        )
        .unwrap() else {
            panic!("expected serve")
        };
        let BackendSelection::Mock(flags) = options.backend else {
            panic!("expected mock")
        };
        assert_eq!(flags.scenario, MockScenario::signed_out());
        assert!(flags.failures.keyring_unavailable && options.no_open);
        assert_eq!(options.bind, "[::1]:0".parse().unwrap());
        assert_eq!(options.trusted_hosts.len(), 1);
    }

    #[test]
    fn rejects_unknown_conflicting_and_incomplete_flags() {
        for flags in [
            &["--unknown"][..],
            &["--mock", "--real"],
            &["--mock", "--mock"],
            &["--real", "--mock-fail=ssh-busy"],
            &["--host=--mock"],
            &["--trusted-host", "--no-open"],
            &["--trusted-host=https://console.example/path"],
            &["--trusted-host=user@console.example"],
            &["--port=65536"],
            &["--port=8080", "--port=9000"],
            &["rotate-token", "--no-open"],
        ] {
            assert!(parse_flags(flags, None).is_err(), "{flags:?}");
        }
    }
}
