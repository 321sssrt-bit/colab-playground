//! Where commands run.
//!
//! [`Host`] is the single seam through which this crate spawns processes. It
//! runs POSIX scripts either on the local machine ([`Host::Local`], unix only)
//! or inside WSL ([`Host::Wsl`], Windows only), plus direct program launches on
//! the local machine ([`Host::run_program`], used for `git`).
//!
//! # Script transport
//!
//! A script is never interpolated into a command line. Every invocation is
//!
//! ```text
//! bash -lc 'eval "$(printf %s "$0" | { base64 -d 2>/dev/null || base64 -D; })"' <b64 bootstrap> <b64 script> <job> <n-env> <b64 KEY=VALUE>... <b64 arg>...
//! ```
//!
//! The fixed bootstrap decodes the script, exports the environment, restores
//! the positional arguments and evaluates the script. Only the short fixed
//! `-lc` string and base64 text (`[A-Za-z0-9+/=]`) cross the Windows → WSL
//! command line, so quoting cannot corrupt anything. Large payloads (Python
//! helpers, plugin scripts) travel on stdin. Under WSL the environment is
//! passed positionally (the Windows process environment does not reach WSL);
//! locally it is set on the process so the login shell sees an overridden
//! `HOME` before reading profile files.
//!
//! # Process trees
//!
//! Scripts run as a background job with job control enabled, so they get their
//! own process group; the bootstrap reports its id on stderr. Killing a
//! [`HostChild`] (explicitly, on cancellation, or on drop) sends `SIGTERM` and
//! then `SIGKILL` to the whole group *on the host*, which also works for
//! processes inside WSL where killing `wsl.exe` alone would not.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};

use crate::clock::CancelToken;
use crate::error::{Error, ErrorKind, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Host {
    /// The local machine (POSIX shell). Script execution is unsupported on Windows.
    Local,
    /// A WSL distribution (Windows only). `None` means the default distribution.
    Wsl {
        /// Distribution name passed to `wsl.exe -d`.
        distro: Option<String>,
    },
}

/// The operating system of the computer the app runs on, where an update decides what to
/// replace and how (the app on the other side of `Host::Wsl` is still a Windows program).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    MacOs,
}

impl Platform {
    pub fn current() -> Option<Platform> {
        if cfg!(windows) {
            Some(Platform::Windows)
        } else if cfg!(target_os = "macos") {
            Some(Platform::MacOs)
        } else if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else {
            None
        }
    }
}

/// The target triple of the release download built for this system and processor, if the
/// release workflow builds one.
pub fn release_target() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64", target_env = "msvc")) {
        Some("x86_64-pc-windows-msvc")
    } else if cfg!(all(
        target_os = "linux",
        target_arch = "x86_64",
        target_env = "gnu"
    )) {
        Some("x86_64-unknown-linux-gnu")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("aarch64-apple-darwin")
    } else {
        None
    }
}

/// The running program's file. On unix, its real path, so a link to it is never mistaken for
/// the file; on Windows as reported, since resolving would add the `\\?\` prefix to every path
/// shown.
pub fn current_program() -> std::io::Result<std::path::PathBuf> {
    let exe = std::env::current_exe()?;
    if cfg!(unix) {
        Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
    } else {
        Ok(exe)
    }
}

/// Makes the file at `path` executable (`rwxr-xr-x`). Only unix has the bit; elsewhere this
/// does nothing.
#[cfg(unix)]
pub fn make_executable(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

/// Makes the file at `path` executable (`rwxr-xr-x`). Only unix has the bit; elsewhere this
/// does nothing.
#[cfg(not(unix))]
pub fn make_executable(_: &std::path::Path) -> std::io::Result<()> {
    Ok(())
}

/// The `bash -lc` string shared by every invocation; see the module docs.
/// (`base64 -D` is the spelling of older macOS releases.)
pub const BOOTSTRAP: &str = r#"eval "$(printf %s "$0" | { base64 -d 2>/dev/null || base64 -D; })""#;

/// Decoder run by [`BOOTSTRAP`]. Positional layout after `$0`:
/// `$1` script (b64), `$2` job flag, `$3` env count, then env pairs and args (b64).
const BOOT_BODY: &str = r#"__cpg_d() { printf '%s' "$1" | { base64 -d 2>/dev/null || base64 -D; } && printf x; }
__cpg_s=$(__cpg_d "$1") || exit 125
__cpg_s=${__cpg_s%x}
__cpg_j=$2
__cpg_n=$3
shift 3
while [ "$__cpg_n" -gt 0 ]; do
  __cpg_v=$(__cpg_d "$1") || exit 125
  export "${__cpg_v%x}"
  shift
  __cpg_n=$((__cpg_n - 1))
done
__cpg_a=()
for __cpg_x in "$@"; do
  __cpg_v=$(__cpg_d "$__cpg_x") || exit 125
  __cpg_a+=("${__cpg_v%x}")
done
set -- "${__cpg_a[@]}"
unset __cpg_a __cpg_x __cpg_v __cpg_n
unset -f __cpg_d
if [ "$__cpg_j" = 1 ]; then
  set -m
  ( eval "$__cpg_s" ) &
  __cpg_p=$!
  printf '\036CPG-PGID %s\n' "$__cpg_p" >&2
  wait "$__cpg_p"
  exit $?
fi
eval "$__cpg_s"
"#;

/// Kills a process group on the host: `$1` is the group id.
const KILL_SCRIPT: &str = r#"kill -TERM -- "-$1" 2>/dev/null || exit 0
i=0
while kill -0 -- "-$1" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
kill -KILL -- "-$1" 2>/dev/null
exit 0
"#;

/// Prefix of the stderr line carrying the job's process group id.
const PGID_MARKER: &str = "\u{1e}CPG-PGID ";

/// Conservative Windows command-line budget (the hard limit is 32 767 UTF-16 units).
pub const MAX_WSL_COMMAND_LINE: usize = 30_000;

/// Windows `CREATE_NO_WINDOW` process creation flag.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StdinMode {
    /// `/dev/null` (the default). An unexpected prompt reads EOF instead of hanging.
    #[default]
    Null,
    /// These bytes, then EOF.
    Bytes(Vec<u8>),
    /// Kept open for [`HostChild::write_stdin`].
    Pipe,
}

/// A POSIX script plus everything it receives. Values are never interpolated
/// into the script text; read them from `"$1"`… or the environment.
#[derive(Debug, Clone, Default)]
pub struct ScriptRequest {
    /// Script source (bash).
    pub script: String,
    /// Positional arguments (`$1`…).
    pub args: Vec<String>,
    /// Extra environment variables. Keys must match `^[A-Za-z_][A-Za-z0-9_]*$`.
    pub env: Vec<(String, String)>,
    pub stdin: StdinMode,
    /// Kill the script after this long ([`Host::run`] returns `Timeout`).
    pub timeout: Option<Duration>,
}

impl ScriptRequest {
    pub fn new(script: impl Into<String>) -> Self {
        ScriptRequest {
            script: script.into(),
            ..Default::default()
        }
    }
    pub fn arg(mut self, a: impl Into<String>) -> Self {
        self.args.push(a.into());
        self
    }
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
    pub fn env(mut self, k: impl Into<String>, v: impl Into<String>) -> Self {
        self.env.push((k.into(), v.into()));
        self
    }
    pub fn stdin_bytes(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = StdinMode::Bytes(data.into());
        self
    }
    pub fn stdin_pipe(mut self) -> Self {
        self.stdin = StdinMode::Pipe;
        self
    }
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stream {
    Stdout,
    Stderr,
}

/// One line of output (without the trailing newline, lossily UTF-8 decoded).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Line {
    pub stream: Stream,
    /// Text without `\n` / `\r\n`.
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineAction {
    Continue,
    /// Kill the process tree now (e.g. an unexpected interactive prompt).
    Kill,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScriptOutput {
    /// Exit code, `None` if terminated by a signal.
    pub code: Option<i32>,
    /// All stdout lines joined with `\n`.
    pub stdout: String,
    /// All stderr lines joined with `\n` (the internal job marker removed).
    pub stderr: String,
    /// True when a line callback requested a kill.
    pub killed: bool,
}

impl ScriptOutput {
    /// Exit code 0 and not killed.
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.killed
    }
}

/// A fully specified process launch, computed without spawning anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    /// Environment variables set on the spawned process itself.
    pub env: Vec<(String, String)>,
    /// Whether to pass `CREATE_NO_WINDOW` (Windows).
    pub no_window: bool,
}

pub fn is_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// Quotes `s` for a POSIX shell (single quotes). Used only where a tool insists
/// on a shell string, such as OpenSSH's `ProxyCommand`.
pub fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@+,".contains(c))
    {
        return s.to_owned();
    }
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Encodes the `bash` argument vector (everything after `bash`).
///
/// With `positional_env` the environment travels as base64 arguments decoded by
/// the bootstrap (needed for WSL); otherwise the caller sets it on the process.
pub(crate) fn encode_bash_args(
    req: &ScriptRequest,
    job: bool,
    positional_env: bool,
) -> Result<Vec<String>> {
    for (k, _) in &req.env {
        if !is_env_key(k) {
            return Err(Error::invalid(
                "env",
                format!("invalid environment variable name {k:?}"),
            ));
        }
    }
    let mut args = vec![
        "-lc".to_owned(),
        BOOTSTRAP.to_owned(),
        B64.encode(BOOT_BODY),
        B64.encode(&req.script),
        if job { "1" } else { "0" }.to_owned(),
    ];
    if positional_env {
        args.push(req.env.len().to_string());
        for (k, v) in &req.env {
            args.push(B64.encode(format!("{k}={v}")));
        }
    } else {
        args.push("0".to_owned());
    }
    args.extend(req.args.iter().map(|a| B64.encode(a)));
    Ok(args)
}

/// Approximate length of a Windows command line for `program` + `args`.
fn command_line_len(program: &str, args: &[String]) -> usize {
    program.len()
        + args
            .iter()
            .map(|a| a.len() + 3 + a.matches('"').count())
            .sum::<usize>()
}

impl Host {
    pub fn detect() -> Host {
        if cfg!(windows) {
            Host::Wsl { distro: None }
        } else {
            Host::Local
        }
    }

    /// Whether a Forward can opt in to all-interface binding on this host.
    pub fn supports_all_interfaces_forward(&self) -> bool {
        if cfg!(windows) || matches!(self, Self::Wsl { .. }) {
            return false;
        }
        #[cfg(target_os = "linux")]
        // A Linux binary can run directly inside WSL without using the Windows launcher.
        if std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_ascii_lowercase().contains("microsoft"))
        {
            return false;
        }
        true
    }

    /// Computes how a script would be launched, without spawning anything.
    ///
    /// `job` runs the script in its own process group (always used by
    /// [`Host::run`] and [`Host::spawn`]).
    pub fn invocation(&self, req: &ScriptRequest, job: bool) -> Result<Invocation> {
        match self {
            Host::Local => {
                if cfg!(windows) {
                    // `bash` on Windows usually resolves to System32\bash.exe, the
                    // WSL launcher. Never run it implicitly.
                    return Err(Error::new(ErrorKind::Unsupported).detail(
                        "POSIX scripts cannot run on a Windows Host::Local; use Host::Wsl",
                    ));
                }
                Ok(Invocation {
                    program: "bash".to_owned(),
                    args: encode_bash_args(req, job, false)?,
                    env: req.env.clone(),
                    no_window: false,
                })
            }
            Host::Wsl { distro } => {
                let mut args = Vec::new();
                if let Some(d) = distro {
                    if d.is_empty()
                        || d.starts_with('-')
                        || d.chars().any(|c| c.is_whitespace() || c == '"')
                    {
                        return Err(Error::invalid(
                            "distro",
                            format!("invalid WSL distribution name {d:?}"),
                        ));
                    }
                    args.push("-d".to_owned());
                    args.push(d.clone());
                }
                args.push("-e".to_owned());
                args.push("bash".to_owned());
                args.extend(encode_bash_args(req, job, true)?);
                let len = command_line_len("wsl.exe", &args);
                if len > MAX_WSL_COMMAND_LINE {
                    return Err(Error::new(ErrorKind::CommandTooLong)
                        .with("length", len)
                        .detail("send large payloads on stdin"));
                }
                Ok(Invocation {
                    program: "wsl.exe".to_owned(),
                    args,
                    env: vec![("WSL_UTF8".to_owned(), "1".to_owned())],
                    no_window: true,
                })
            }
        }
    }

    /// Runs a script to completion, streaming lines to `on_line`.
    ///
    /// Cancellation and `req.timeout` kill the whole process tree and return
    /// `Cancelled` / `Timeout`. A [`LineAction::Kill`] from the callback kills
    /// the tree and returns the output so far with `killed = true`.
    pub fn run(
        &self,
        req: ScriptRequest,
        cancel: &CancelToken,
        on_line: &mut dyn FnMut(&Line) -> LineAction,
    ) -> Result<ScriptOutput> {
        let timeout = req.timeout;
        let mut child = self.spawn(req)?;
        collect(&mut child, timeout, cancel, on_line)
    }

    pub fn run_quiet(&self, req: ScriptRequest, cancel: &CancelToken) -> Result<ScriptOutput> {
        self.run(req, cancel, &mut |_| LineAction::Continue)
    }

    /// The returned handle kills the process tree when dropped.
    pub fn spawn(&self, req: ScriptRequest) -> Result<HostChild> {
        if matches!(self, Host::Wsl { .. }) && !cfg!(windows) {
            return Err(
                Error::new(ErrorKind::Unsupported).detail("WSL is only available on Windows")
            );
        }
        let inv = self.invocation(&req, true)?;
        let (stdin_cfg, initial) = match req.stdin {
            StdinMode::Null => (Stdio::null(), None),
            StdinMode::Bytes(b) => (Stdio::piped(), Some(b)),
            StdinMode::Pipe => (Stdio::piped(), None),
        };
        let mut child = spawn_invocation(&inv, stdin_cfg).map_err(|e| match (self, e.kind()) {
            (Host::Wsl { .. }, std::io::ErrorKind::NotFound) => {
                Error::new(ErrorKind::WslUnavailable).detail(e.to_string())
            }
            (_, std::io::ErrorKind::NotFound) => {
                Error::new(ErrorKind::NotInstalled).with("program", &inv.program)
            }
            _ => Error::from(e),
        })?;
        let mut stdin = child.stdin.take();
        if let Some(bytes) = initial
            && let Some(mut pipe) = stdin.take()
        {
            thread::spawn(move || {
                let _ = pipe.write_all(&bytes);
            });
        }
        let wsl = matches!(self, Host::Wsl { .. });
        Ok(HostChild::start(self.clone(), child, stdin, wsl))
    }

    /// Runs `program` directly (no shell) on the local machine. Only valid for
    /// [`Host::Local`] (on any OS); used for `git clone` of plugins.
    pub fn run_program(
        &self,
        program: &str,
        args: &[String],
        env: &[(String, String)],
        cancel: &CancelToken,
        timeout: Option<Duration>,
    ) -> Result<ScriptOutput> {
        if *self != Host::Local {
            return Err(Error::new(ErrorKind::Unsupported)
                .detail("run_program runs on the local machine only"));
        }
        let inv = Invocation {
            program: program.to_owned(),
            args: args.to_vec(),
            env: env.to_vec(),
            no_window: cfg!(windows),
        };
        let child = spawn_invocation(&inv, Stdio::null()).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => {
                Error::new(ErrorKind::NotInstalled).with("program", program)
            }
            _ => Error::from(e),
        })?;
        let mut child = HostChild::start(Host::Local, child, None, false);
        child.direct = true;
        collect(&mut child, timeout, cancel, &mut |_| LineAction::Continue)
    }

    /// Starts `program` on the local machine and leaves it running on its own: nothing is
    /// piped, nothing waits for it and nothing kills it, so it outlives this process. Only
    /// valid for [`Host::Local`]; used to start the app again after an update.
    pub fn launch_detached(
        &self,
        program: &std::path::Path,
        args: &[String],
        env: &[(&str, &str)],
    ) -> Result<()> {
        if *self != Host::Local {
            return Err(Error::new(ErrorKind::Unsupported)
                .detail("launch_detached runs on the local machine only"));
        }
        let mut cmd = Command::new(program);
        cmd.args(args)
            .envs(env.iter().copied())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            // Its own process group and no console: closing a terminal this process was
            // started from must not take the new one with it.
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        // Dropping a `Child` neither waits for nor kills the process.
        cmd.spawn()
            .map(drop)
            .map_err(|e| Error::from(e).with("program", program.display()))
    }

    /// Reports what is available on this host. Spawns real processes; never
    /// call it from tests.
    pub fn probe(&self) -> ProbeReport {
        let mut report = ProbeReport::default();
        let cancel = CancelToken::new();
        if let Host::Wsl { .. } = self {
            if !cfg!(windows) {
                report.errors.push("wsl requires Windows".into());
                return report;
            }
            let inv = Invocation {
                program: "wsl.exe".into(),
                args: vec!["-l".into(), "-q".into()],
                env: vec![("WSL_UTF8".into(), "1".into())],
                no_window: true,
            };
            match spawn_invocation(&inv, Stdio::null()) {
                Ok(child) => {
                    let mut child = HostChild::start(Host::Local, child, None, true);
                    child.direct = true;
                    match collect(
                        &mut child,
                        Some(Duration::from_secs(30)),
                        &cancel,
                        &mut |_| LineAction::Continue,
                    ) {
                        Ok(out) => {
                            report.wsl_installed = true;
                            // Without a usable WSL (no distribution, or only the inbox
                            // stub that offers `--install`) `wsl -l` fails and prints
                            // a message or its usage on stdout, which is not a distro list.
                            if out.success() {
                                report.wsl_distros = parse_wsl_distros(&out.stdout);
                            } else {
                                report.errors.push(format!(
                                    "wsl -l failed: {}",
                                    tail(&format!("{}\n{}", out.stdout, out.stderr), 400)
                                ));
                            }
                        }
                        Err(e) => report.errors.push(e.to_string()),
                    }
                }
                Err(e) => {
                    report.errors.push(format!("wsl.exe: {e}"));
                    return report;
                }
            }
            if report.wsl_distros.is_empty() {
                return report;
            }
        }
        let req =
            ScriptRequest::new(with_shebang_python(PROBE_SCRIPT)).timeout(Duration::from_secs(60));
        match self.run_quiet(req, &cancel) {
            Ok(out) => report.apply_probe_output(&out.stdout),
            Err(e) => report.errors.push(e.to_string()),
        }
        report
    }
}

fn parse_wsl_distros(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Shell function for the scripts below: prints the Python interpreter that runs the entry script
/// `$1`, read from its shebang, following shell wrapper `exec` targets (bounded depth, cycle-safe)
/// and the `uv` / pip `#!/bin/sh` sibling-`python` launcher. Never returns a shell interpreter;
/// prints nothing when no Python interpreter can be resolved.
const SHEBANG_PYTHON: &str = r##"shebang_python() (
  set -f
  IFS=$(printf ' \t\n')
  cr=$(printf '\r')
  tab=$(printf '\t')
  nl='
'
  seen="$nl"
  total=0

  _cpg_is_python() {
    case "$1" in
      *.sh) return 1 ;;
      python|python[0-9]*) return 0 ;;
      *) return 1 ;;
    esac
  }

  _cpg_is_shell() {
    case "$1" in
      sh|bash|bash[0-9]*|dash|zsh|ash|ksh|ksh[0-9]*|mksh|pdksh|yash) return 0 ;;
      *) return 1 ;;
    esac
  }

  _cpg_is_env_assign() {
    case "$1" in
      *=*)
        local k=${1%%=*}
        case "$k" in
          ""|[0-9]*|*[!A-Za-z0-9_]*) return 1 ;;
          *) return 0 ;;
        esac
        ;;
      *) return 1 ;;
    esac
  }

  _cpg_next_tok() {
    local ws ch
    tok=""
    tok_quoted=0
    ws=${rest%%[! $tab]*}
    rest=${rest#"$ws"}
    case "$rest" in
      ""|'#'*|';'*|'|'*) return 1 ;;
      '&>'*) ;;
      '&'*) return 1 ;;
    esac
    case "$rest" in
      '&>>'*) tok='&>>'; rest=${rest#???}; return 0 ;;
      '&>'*) tok='&>'; rest=${rest#??}; return 0 ;;
    esac
    while [ -n "$rest" ]; do
      ch=${rest%"${rest#?}"}
      case "$ch" in
        ' '|"$tab"|';'|'|'|'&') break ;;
        '<'|'>')
          case "$tok_quoted:$tok" in
            0:|0:[0-9]|0:[0-9][0-9])
              tok="${tok}${ch}"
              rest=${rest#?}
              case "$rest" in
                '>'*|'<'*|'|'*)
                  tok="${tok}${rest%"${rest#?}"}"
                  rest=${rest#?}
                  ;;
                '&'*)
                  tok="${tok}&"
                  rest=${rest#?}
                  while [ -n "$rest" ]; do
                    ch=${rest%"${rest#?}"}
                    case "$ch" in
                      ' '|"$tab"|';'|'|'|'&'|'<'|'>') break ;;
                      *) tok="${tok}${ch}"; rest=${rest#?} ;;
                    esac
                  done
                  ;;
              esac
              break
              ;;
            *) break ;;
          esac
          ;;
        "'")
          tok_quoted=1
          rest=${rest#?}
          case "$rest" in
            *\'*)
              tok="${tok}${rest%%\'*}"
              rest=${rest#*\'}
              ;;
            *) return 1 ;;
          esac
          ;;
        '"')
          tok_quoted=1
          rest=${rest#?}
          while [ -n "$rest" ]; do
            ch=${rest%"${rest#?}"}
            case "$ch" in
              '"') rest=${rest#?}; break ;;
              '\')
                rest=${rest#?}
                [ -n "$rest" ] || break
                ch=${rest%"${rest#?}"}
                case "$ch" in
                  '"'|'\') tok="${tok}${ch}" ;;
                  *) tok="${tok}\\${ch}" ;;
                esac
                rest=${rest#?}
                ;;
              *)
                tok="${tok}${ch}"
                rest=${rest#?}
                ;;
            esac
          done
          ;;
        '\')
          rest=${rest#?}
          [ -n "$rest" ] || break
          ch=${rest%"${rest#?}"}
          tok="${tok}${ch}"
          rest=${rest#?}
          ;;
        *)
          tok="${tok}${ch}"
          rest=${rest#?}
          ;;
      esac
    done
    return 0
  }

  _cpg_scan_heredoc() {
    local s=$1 ch prev=" " ws delim strip
    while [ -n "$s" ]; do
      ch=${s%"${s#?}"}
      case "$ch" in
        "'")
          s=${s#?}
          case "$s" in
            *\'*) s=${s#*\'} ;;
            *) return 0 ;;
          esac
          prev="'"
          ;;
        '"')
          s=${s#?}
          while [ -n "$s" ]; do
            ch=${s%"${s#?}"}
            case "$ch" in
              '"') s=${s#?}; break ;;
              '\') s=${s#?}; [ -n "$s" ] && s=${s#?} ;;
              *) s=${s#?} ;;
            esac
          done
          prev='"'
          ;;
        '\')
          s=${s#?}
          [ -n "$s" ] && s=${s#?}
          prev="x"
          ;;
        '#')
          case "$prev" in
            ' '|"$tab"|';'|'&'|'|'|'('|')') return 0 ;;
          esac
          s=${s#?}
          prev="#"
          ;;
        '<')
          case "$s" in
            '<<<'*)
              s=${s#???}
              prev="<"
              ;;
            '<<'*)
              s=${s#??}
              strip=0
              case "$s" in
                '-'*) strip=1; s=${s#?} ;;
              esac
              ws=${s%%[! $tab]*}
              s=${s#"$ws"}
              delim=""
              while [ -n "$s" ]; do
                ch=${s%"${s#?}"}
                case "$ch" in
                  ' '|"$tab"|';'|'&'|'|'|'<'|'>'|'('|')') break ;;
                  "'")
                    s=${s#?}
                    case "$s" in
                      *\'*) delim="${delim}${s%%\'*}"; s=${s#*\'} ;;
                      *) return 0 ;;
                    esac
                    ;;
                  '"')
                    s=${s#?}
                    while [ -n "$s" ]; do
                      ch=${s%"${s#?}"}
                      case "$ch" in
                        '"') s=${s#?}; break ;;
                        '\') s=${s#?}; [ -n "$s" ] && { delim="${delim}${s%"${s#?}"}"; s=${s#?}; } ;;
                        *) delim="${delim}${ch}"; s=${s#?} ;;
                      esac
                    done
                    ;;
                  '\')
                    s=${s#?}
                    [ -n "$s" ] && { delim="${delim}${s%"${s#?}"}"; s=${s#?}; }
                    ;;
                  *)
                    delim="${delim}${ch}"
                    s=${s#?}
                    ;;
                esac
              done
              if [ -n "$delim" ]; then
                hd_delim=$delim
                hd_strip=$strip
                return 0
              fi
              prev="<"
              ;;
            *)
              s=${s#?}
              prev="<"
              ;;
          esac
          ;;
        *)
          s=${s#?}
          prev=$ch
          ;;
      esac
    done
  }

  _cpg_resolve() {
    local cur=$1 depth=$2
    local l1 sb interp base line ws rest tok tok_quoted polyglot dir fallback_py="" lines=0
    local hd_delim="" hd_strip=0
    [ "$depth" -lt 8 ] || return 1
    [ "$total" -lt 32 ] || return 1
    total=$((total + 1))

    cur=$(readlink -f -- "$cur" 2>/dev/null || printf %s "$cur")
    [ -f "$cur" ] || return 1
    case "$seen" in
      *"$nl$cur$nl"*) return 1 ;;
    esac
    seen="${seen}${cur}${nl}"

    l1=""
    IFS= read -r l1 < "$cur" 2>/dev/null || [ -n "$l1" ] || return 1
    l1=${l1%$cr}
    case "$l1" in
      '#!'*) ;;
      *) return 1 ;;
    esac

    sb=${l1#??}
    set -- $sb
    interp=${1-}
    [ -n "$interp" ] || return 1
    case "$interp" in
      env|*/env)
        shift
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --) shift; break ;;
            -u|--unset|-C|--chdir) shift; [ "$#" -gt 0 ] && shift ;;
            -*) shift ;;
            *=*) shift ;;
            *) break ;;
          esac
        done
        interp=${1-}
        [ -n "$interp" ] || return 1
        case "$interp" in
          */*) ;;
          *) interp=$(command -v -- "$interp" 2>/dev/null) ;;
        esac
        ;;
    esac
    [ -n "$interp" ] || return 1

    base=${interp##*/}
    if _cpg_is_python "$base"; then
      printf %s "$interp"
      return 0
    fi
    _cpg_is_shell "$base" || return 1

    while IFS= read -r line || [ -n "$line" ]; do
      lines=$((lines + 1))
      [ "$lines" -eq 1 ] && continue
      [ "$lines" -gt 200 ] && break
      line=${line%$cr}
      if [ -n "$hd_delim" ]; then
        if [ "$hd_strip" = 1 ]; then
          ws=${line%%[!$tab]*}
          [ "${line#"$ws"}" = "$hd_delim" ] && hd_delim=""
        else
          [ "$line" = "$hd_delim" ] && hd_delim=""
        fi
        continue
      fi
      ws=${line%%[! $tab]*}
      rest=${line#"$ws"}
      case "$rest" in
        ""|'#'*) continue ;;
      esac
      case "$rest" in
        *'<<'*) _cpg_scan_heredoc "$rest" ;;
      esac
      case "$rest" in
        *exec*) ;;
        *) continue ;;
      esac

      polyglot=0
      case "$rest" in
        "'''exec'"*) polyglot=1 ;;
      esac

      while _cpg_next_tok; do
        if [ "$tok" = "exec" ]; then
          break
        fi
        if _cpg_is_env_assign "$tok"; then
          continue
        fi
        tok=""
        break
      done
      [ "$tok" = "exec" ] || continue

      while _cpg_next_tok; do
        if [ "$tok_quoted" = 0 ]; then
          case "$tok" in
            --) _cpg_next_tok || tok=""; break ;;
            -a) _cpg_next_tok || { tok=""; break; } ;;
            -*) ;;
            *'<'*|*'>'*)
              case "$tok" in
                *'<'|*'>'|*'>|') _cpg_next_tok || { tok=""; break; } ;;
              esac
              ;;
            *) break ;;
          esac
        else
          break
        fi
      done
      [ -n "$tok" ] || continue

      case "$tok" in
        env|*/env)
          while _cpg_next_tok; do
            case "$tok" in
              --) _cpg_next_tok || tok=""; break ;;
              -u|--unset|-C|--chdir) _cpg_next_tok || { tok=""; break; } ;;
              -*) [ "$tok_quoted" = 0 ] || break ;;
              *=*) _cpg_is_env_assign "$tok" || break ;;
              *) break ;;
            esac
          done
          ;;
      esac
      [ -n "$tok" ] || continue

      if [ -n "${HOME-}" ]; then
        if [ "$tok_quoted" = 0 ]; then
          case "$tok" in '~/'*) tok="$HOME/${tok#\~/}" ;; esac
        fi
        case "$tok" in
          '$HOME/'*) tok="$HOME/${tok#\$HOME/}" ;;
          '${HOME}/'*) tok="$HOME/${tok#\$\{HOME\}/}" ;;
        esac
      fi

      case "$tok" in
        *'$'*|*'`'*)
          case "$polyglot:$line" in
            1:*|*:*/python*)
              dir=$(dirname -- "$cur")
              if [ -x "$dir/python" ]; then
                printf %s "$dir/python"
                return 0
              fi
              ;;
          esac
          continue
          ;;
      esac

      case "$tok" in
        */*) ;;
        *)
          if [ "$lines" -eq 2 ] && [ "$base" = "sh" ] && _cpg_is_python "$tok"; then
            dir=$(dirname -- "$cur")
            if [ -x "$dir/python" ]; then
              printf %s "$dir/python"
              return 0
            fi
          fi
          tok=$(command -v -- "$tok" 2>/dev/null) || continue
          case "$tok" in */*) ;; *) continue ;; esac
          ;;
      esac

      if _cpg_is_python "${tok##*/}"; then
        if [ -x "$tok" ]; then
          printf %s "$tok"
          return 0
        fi
        [ -z "$fallback_py" ] && fallback_py=$tok
        continue
      fi

      if _cpg_resolve "$tok" $((depth + 1)); then
        return 0
      fi
    done < "$cur"

    if [ -n "$fallback_py" ]; then
      printf %s "$fallback_py"
      return 0
    fi
    return 1
  }

  _cpg_resolve "$1" 0 || true
)
"##;

fn with_shebang_python(script: &str) -> String {
    format!("{SHEBANG_PYTHON}{script}")
}

/// Probe script: prints `CPG key=value` lines.
///
/// `uv` installs `colab` (and its own installer puts `uv`) in `~/.local/bin`, but only the
/// user's own shell profile adds it to `PATH`. On macOS that profile is zsh's, which `bash -l`
/// never reads, so the directory is appended here; anything earlier on `PATH` still wins.
const PROBE_SCRIPT: &str = r#"PATH="$PATH:$HOME/.local/bin"
for t in bash ssh ssh-keygen git uv python3 colab; do
  p=$(command -v "$t" 2>/dev/null) && printf 'CPG %s=%s\n' "$t" "$p"
done
if c=$(command -v colab 2>/dev/null); then
  v=$("$c" version 2>/dev/null | head -n 1)
  printf 'CPG colab_version=%s\n' "${v#Version: }"
  r=$(readlink -f "$c" 2>/dev/null || printf %s "$c")
  py=$(shebang_python "$r")
  [ -n "$py" ] && printf 'CPG helper_python=%s\n' "$py"
  [ -n "$py" ] && "$py" -c 'import keyring' >/dev/null 2>&1 && printf 'CPG keyring=ok\n'
fi
[ -f "$HOME/.ssh/id_ed25519.pub" ] || [ -f "$HOME/.ssh/id_ecdsa.pub" ] && printf 'CPG ssh_key=present\n'
printf 'CPG home=%s\n' "$HOME"
"#;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeReport {
    /// `wsl.exe` answered (Windows only).
    pub wsl_installed: bool,
    /// Installed WSL distributions (default first, as `wsl -l -q` lists them).
    pub wsl_distros: Vec<String>,
    /// Paths of tools found on the host `PATH` (login shell).
    pub bash: Option<String>,
    pub ssh: Option<String>,
    pub ssh_keygen: Option<String>,
    /// `git` path (on the host; plugin clones use the local `git`).
    pub git: Option<String>,
    pub uv: Option<String>,
    pub python3: Option<String>,
    pub colab: Option<String>,
    pub colab_version: Option<String>,
    /// Interpreter of the `colab` entry script (runs the account helper).
    pub helper_python: Option<String>,
    /// The helper interpreter can `import keyring`.
    pub keyring_ok: bool,
    /// `~/.ssh/id_ed25519.pub` or `id_ecdsa.pub` exists.
    pub ssh_key_present: bool,
    pub home: Option<String>,
    /// Problems encountered while probing (log text).
    pub errors: Vec<String>,
}

impl ProbeReport {
    /// Parses `CPG key=value` lines produced by the probe script.
    pub fn apply_probe_output(&mut self, stdout: &str) {
        for line in stdout.lines() {
            let Some(rest) = line.strip_prefix("CPG ") else {
                continue;
            };
            let Some((k, v)) = rest.split_once('=') else {
                continue;
            };
            let v = v.trim().to_owned();
            let val = if v.is_empty() { None } else { Some(v) };
            match k {
                "bash" => self.bash = val,
                "ssh" => self.ssh = val,
                "ssh-keygen" => self.ssh_keygen = val,
                "git" => self.git = val,
                "uv" => self.uv = val,
                "python3" => self.python3 = val,
                "colab" => self.colab = val,
                "colab_version" => self.colab_version = val,
                "helper_python" => self.helper_python = val,
                "keyring" => self.keyring_ok = val.as_deref() == Some("ok"),
                "ssh_key" => self.ssh_key_present = val.as_deref() == Some("present"),
                "home" => self.home = val,
                _ => {}
            }
        }
    }

    /// The toolchain, when both paths were found.
    pub fn toolchain(&self) -> Option<Toolchain> {
        Some(Toolchain {
            colab: self.colab.clone()?,
            helper_python: self.helper_python.clone()?,
        })
    }
}

/// Paths (as seen by the host shell) of the `colab` executable and the Python
/// interpreter that runs it (and therefore has its `keyring` and `google-auth`).
///
/// An empty `helper_python` (see [`Toolchain::from_colab_path`]) means "derive
/// it from the shebang of `colab`"; the real backend does so on first use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Toolchain {
    /// Absolute path of `colab`.
    pub colab: String,
    /// Absolute path of the CLI's Python interpreter (empty: derive it).
    pub helper_python: String,
}

/// Validates a `colab` path on the host and derives its interpreter. Prints
/// `CPG key=value` lines; `reason=` explains a failure.
const RESOLVE_SCRIPT: &str = r#"c=$1
[ -e "$c" ] || { echo "CPG reason=not_found"; exit 0; }
r=$(readlink -f -- "$c" 2>/dev/null || printf %s "$c")
[ -f "$r" ] || { echo "CPG reason=not_a_file"; exit 0; }
[ -x "$r" ] || { echo "CPG reason=not_executable"; exit 0; }
py=$(shebang_python "$r")
case "$py" in *python*) ;; *) echo "CPG reason=no_python_shebang"; exit 0 ;; esac
[ -x "$py" ] || { printf 'CPG interpreter=%s
CPG reason=interpreter_missing
' "$py"; exit 0; }
printf 'CPG helper_python=%s
' "$py"
"#;

impl Toolchain {
    /// A toolchain from an overridden `colab` path only; the interpreter is
    /// derived from its shebang on first use ([`Toolchain::resolve`]).
    pub fn from_colab_path(colab: impl Into<String>) -> Toolchain {
        Toolchain {
            colab: colab.into(),
            helper_python: String::new(),
        }
    }

    pub fn needs_resolution(&self) -> bool {
        self.helper_python.is_empty()
    }

    /// Checks `colab` on the host (absolute, exists, executable, a Python
    /// entry script) and fills in `helper_python` from its shebang (also the
    /// `uv` / pip `#!/bin/sh` launcher form). Runs no Python. Spawns a host
    /// script: real mode only. Failures are `InvalidInput` with
    /// `field = "colab_path"`, `value`, and `reason`: `not_absolute`,
    /// `not_found`, `not_a_file`, `not_executable`, `no_python_shebang`, or
    /// `interpreter_missing` (with `interpreter`).
    pub fn resolve(
        &self,
        host: &Host,
        env: &[(String, String)],
        cancel: &CancelToken,
    ) -> Result<Toolchain> {
        if !self.needs_resolution() {
            return Ok(self.clone());
        }
        if !self.colab.starts_with('/') {
            return Err(colab_path_error(&self.colab, "not_absolute", None));
        }
        let mut req = ScriptRequest::new(with_shebang_python(RESOLVE_SCRIPT))
            .arg(&self.colab)
            .timeout(Duration::from_secs(60));
        req.env = env.to_vec();
        let out = host.run_quiet(req, cancel)?;
        parse_resolution(&self.colab, &out.stdout)
    }
}

fn colab_path_error(path: &str, reason: &str, interpreter: Option<&str>) -> Error {
    let what = match reason {
        "not_absolute" => "give the absolute path of the colab executable on the host",
        "not_found" => "no file at this path on the host; check the path (inside WSL on Windows)",
        "not_a_file" => "the path is not a regular file",
        "not_executable" => {
            "the file is not executable (chmod +x, or point at the installed entry script)"
        }
        "no_python_shebang" => {
            "not a Python entry script; point at the colab installed by uv or pip"
        }
        "interpreter_missing" => {
            "the interpreter named in its shebang does not exist; reinstall the CLI"
        }
        _ => "invalid colab path",
    };
    let mut e = Error::invalid("colab_path", what)
        .with("value", path)
        .with("reason", reason);
    if let Some(i) = interpreter {
        e = e.with("interpreter", i);
    }
    e
}

pub fn parse_resolution(colab: &str, stdout: &str) -> Result<Toolchain> {
    let mut helper = None;
    let mut reason = None;
    let mut interpreter = None;
    for line in stdout.lines() {
        let Some((k, v)) = line.strip_prefix("CPG ").and_then(|r| r.split_once('=')) else {
            continue;
        };
        match k {
            "helper_python" => helper = Some(v.trim().to_owned()),
            "reason" => reason = Some(v.trim().to_owned()),
            "interpreter" => interpreter = Some(v.trim().to_owned()),
            _ => {}
        }
    }
    match (helper, reason) {
        (Some(h), None) if !h.is_empty() => Ok(Toolchain {
            colab: colab.to_owned(),
            helper_python: h,
        }),
        (_, Some(r)) => Err(colab_path_error(colab, &r, interpreter.as_deref())),
        _ => Err(Error::new(ErrorKind::Parse).detail(tail(stdout, 300))),
    }
}

fn spawn_invocation(inv: &Invocation, stdin: Stdio) -> std::io::Result<Child> {
    let mut cmd = Command::new(&inv.program);
    cmd.args(&inv.args)
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &inv.env {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        if inv.no_window {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
    }
    cmd.spawn()
}

/// A running script. Dropping it kills the whole process tree.
pub struct HostChild {
    host: Host,
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<Line>,
    pgid: Arc<Mutex<Option<u32>>>,
    exit: Option<Option<i32>>,
    direct: bool,
}

impl std::fmt::Debug for HostChild {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostChild")
            .field("host", &self.host)
            .field("pid", &self.child.id())
            .finish()
    }
}

impl HostChild {
    /// `wsl` marks output that passes through `wsl.exe`, which may be UTF-16LE.
    fn start(host: Host, mut child: Child, stdin: Option<ChildStdin>, wsl: bool) -> HostChild {
        let (tx, rx) = mpsc::channel();
        let pgid = Arc::new(Mutex::new(None));
        if let Some(out) = child.stdout.take() {
            spawn_reader(out, Stream::Stdout, wsl, tx.clone(), pgid.clone());
        }
        if let Some(err) = child.stderr.take() {
            spawn_reader(err, Stream::Stderr, wsl, tx, pgid.clone());
        }
        HostChild {
            host,
            child,
            stdin,
            lines: rx,
            pgid,
            exit: None,
            direct: false,
        }
    }

    /// Waits up to `timeout` for the next output line. `Err(Disconnected)`
    /// means both streams are closed.
    pub fn recv_line(&self, timeout: Duration) -> std::result::Result<Line, RecvTimeoutError> {
        self.lines.recv_timeout(timeout)
    }

    /// Writes to stdin (only with [`StdinMode::Pipe`]).
    pub fn write_stdin(&mut self, data: &[u8]) -> Result<()> {
        match self.stdin.as_mut() {
            Some(pipe) => {
                pipe.write_all(data)?;
                pipe.flush()?;
                Ok(())
            }
            None => Err(Error::new(ErrorKind::Io).detail("stdin is not a pipe")),
        }
    }

    /// Closes stdin (EOF for the script).
    pub fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// Returns the exit code if the process has exited (`Some(None)` = signal).
    pub fn try_wait(&mut self) -> Option<Option<i32>> {
        if self.exit.is_none()
            && let Ok(Some(status)) = self.child.try_wait()
        {
            self.exit = Some(status.code());
        }
        self.exit
    }

    pub fn wait(&mut self) -> Option<i32> {
        if let Some(code) = self.exit {
            return code;
        }
        let code = self.child.wait().ok().and_then(|s| s.code());
        self.exit = Some(code);
        code
    }

    /// The job's process group id, waiting up to `limit` for the wrapper to report it. The job
    /// runs in a group of its own, so a kill that came before the report would miss it.
    fn await_pgid(&mut self, limit: Duration) -> Option<u32> {
        let deadline = Instant::now() + limit;
        loop {
            if let Some(id) = *self.pgid.lock().unwrap_or_else(|e| e.into_inner()) {
                return Some(id);
            }
            if Instant::now() >= deadline || self.try_wait().is_some() {
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// Kills the process tree (idempotent).
    pub fn kill(&mut self) {
        if self.try_wait().is_some() {
            return;
        }
        let pgid = if self.direct {
            None
        } else {
            self.await_pgid(Duration::from_secs(5))
        };
        if let Some(pgid) = pgid {
            let req = ScriptRequest::new(KILL_SCRIPT).arg(pgid.to_string());
            if let Ok(inv) = self.host.invocation(&req, false)
                && let Ok(mut killer) = spawn_invocation(&inv, Stdio::null())
            {
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline {
                    if let Ok(Some(_)) = killer.try_wait() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = killer.kill();
                let _ = killer.wait();
            }
        }
        let _ = self.child.kill();
        let code = self.child.wait().ok().and_then(|s| s.code());
        self.exit = Some(code);
    }
}

impl Drop for HostChild {
    fn drop(&mut self) {
        self.stdin = None;
        self.kill();
    }
}

/// `wsl.exe` writes its own messages (usage, errors, `-l`) in UTF-16LE whenever it
/// ignores `WSL_UTF8`: the inbox stub on Windows without WSL and older WSL builds do.
/// Linux programs behind it write UTF-8, which never contains NUL, so a NUL in a
/// high-byte position of the first bytes marks a UTF-16LE stream.
struct LineDecoder {
    utf16: Option<bool>,
    pending: Vec<u8>,
}

impl LineDecoder {
    fn new(detect_utf16: bool) -> Self {
        LineDecoder {
            utf16: if detect_utf16 { None } else { Some(false) },
            pending: Vec::new(),
        }
    }

    fn push(&mut self, bytes: &[u8], out: &mut Vec<String>) {
        self.pending.extend_from_slice(bytes);
        if self.utf16.is_none() {
            self.utf16 = detect_utf16(&self.pending);
        }
        match self.utf16 {
            Some(false) => {
                while let Some(pos) = self.pending.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = self.pending.drain(..=pos).collect();
                    out.push(decode_line(&line[..line.len() - 1], false));
                }
            }
            Some(true) => {
                while let Some(unit) = self
                    .pending
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .position(|u| *u == [b'\n', 0])
                {
                    let line: Vec<u8> = self.pending.drain(..unit * 2 + 2).collect();
                    out.push(decode_line(&line[..line.len() - 2], true));
                }
            }
            None => {}
        }
    }

    fn finish(self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        Some(decode_line(&self.pending, self.utf16.unwrap_or(false)))
    }
}

/// `None` until the first line break. wsl.exe's UTF-16LE messages contain ASCII (or end
/// in `0D 00 0A 00`), so a NUL in a high-byte position shows up by then.
fn detect_utf16(p: &[u8]) -> Option<bool> {
    if p.starts_with(&[0xff, 0xfe]) || p.iter().skip(1).step_by(2).any(|&b| b == 0) {
        return Some(true);
    }
    p.contains(&b'\n').then_some(false)
}

fn decode_line(bytes: &[u8], utf16: bool) -> String {
    let mut text = if utf16 {
        let units: Vec<u16> = bytes
            .chunks(2)
            .map(|u| u16::from_le_bytes([u[0], u.get(1).copied().unwrap_or(0)]))
            .collect();
        let units = units.strip_prefix(&[0xfeff]).unwrap_or(&units);
        String::from_utf16_lossy(units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    if text.ends_with('\r') {
        text.pop();
    }
    text
}

/// `$1`: how long to wait for the session bus socket, in tenths of a second.
const KEEPALIVE_SCRIPT: &str = r#"case ${DBUS_SESSION_BUS_ADDRESS-} in
unix:path=*)
  sock=${DBUS_SESSION_BUS_ADDRESS#unix:path=}
  sock=${sock%%[,;]*}
  i=0
  while [ ! -S "$sock" ] && [ "$i" -lt "$1" ]; do sleep 0.1; i=$((i + 1)); done
  ;;
esac
printf '%s\n' __CPG_KEEPALIVE_READY__
cat >/dev/null"#;

/// Also printed when the wait for the bus runs out: a missing bus must not block the app.
const KEEPALIVE_READY: &str = "__CPG_KEEPALIVE_READY__";

const KEEPALIVE_BUS_WAIT_TENTHS: u32 = 100;

/// The bus wait plus starting WSL itself.
const KEEPALIVE_READY_TIMEOUT: Duration = Duration::from_secs(20);

/// Keeps a WSL distribution running while it is held.
///
/// WSL stops a distribution shortly after its last command ends, and the user's
/// keyring daemon stops with it. The next command starts a new daemon whose
/// keyring is locked again, so background polls would ask for the keyring
/// password again and again. One idle process, open between commands,
/// keeps the distribution (and the unlocked keyring) up. It reads stdin until
/// EOF: dropping the keepalive closes that pipe, and so does the app exiting
/// for any reason, so it never outlives the app.
///
/// A freshly started distribution also brings its D-Bus session bus up a moment
/// after the first command runs, and the keyring is reached through that bus: a
/// command started before it finds no keyring at all. So each start of the idle
/// process first waits for the bus, and [`HostKeepalive::ensure`] returns only
/// then.
///
/// A no-op on [`Host::Local`], which nothing stops between commands.
#[derive(Debug)]
pub struct HostKeepalive {
    host: Host,
    child: Mutex<Option<HostChild>>,
}

impl HostKeepalive {
    /// Spawns nothing until [`HostKeepalive::ensure`].
    pub fn new(host: Host) -> HostKeepalive {
        HostKeepalive {
            host,
            child: Mutex::new(None),
        }
    }

    /// Restarts the process if it ended (after `wsl --shutdown`, for example). After
    /// a start it returns only once the session bus is up, and callers that arrive
    /// meanwhile wait for the same start.
    pub fn ensure(&self) {
        if !matches!(self.host, Host::Wsl { .. }) {
            return;
        }
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = slot.as_mut()
            && child.try_wait().is_none()
        {
            return;
        }
        *slot = self
            .host
            .spawn(keepalive_request(KEEPALIVE_BUS_WAIT_TENTHS))
            .ok();
        if let Some(child) = slot.as_ref() {
            wait_until_ready(child, KEEPALIVE_READY_TIMEOUT);
        }
    }

    pub fn is_running(&self) -> bool {
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_mut()
            .is_some_and(|child| child.try_wait().is_none())
    }
}

impl Drop for HostKeepalive {
    fn drop(&mut self) {
        let slot = self.child.get_mut().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = slot.take() {
            // EOF ends it. Wait off the caller's thread, and only kill the process
            // group (through another `wsl.exe`) if it is still there after that.
            child.close_stdin();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                while child.try_wait().is_none() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(50));
                }
            });
        }
    }
}

fn keepalive_request(bus_wait_tenths: u32) -> ScriptRequest {
    ScriptRequest::new(KEEPALIVE_SCRIPT)
        .arg(bus_wait_tenths.to_string())
        .stdin_pipe()
}

fn wait_until_ready(child: &HostChild, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        match child.recv_line(left) {
            Ok(line) if line.stream == Stream::Stdout && line.text == KEEPALIVE_READY => {
                return true;
            }
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut r: R,
    stream: Stream,
    wsl: bool,
    tx: Sender<Line>,
    pgid: Arc<Mutex<Option<u32>>>,
) {
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut decoder = LineDecoder::new(wsl);
        let mut lines = Vec::new();
        let emit = |text: String| -> bool {
            if stream == Stream::Stderr
                && let Some(id) = text.strip_prefix(PGID_MARKER)
            {
                if let Ok(id) = id.trim().parse::<u32>() {
                    *pgid.lock().unwrap_or_else(|e| e.into_inner()) = Some(id);
                }
                return true;
            }
            tx.send(Line { stream, text }).is_ok()
        };
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    decoder.push(&buf[..n], &mut lines);
                    for text in lines.drain(..) {
                        if !emit(text) {
                            return;
                        }
                    }
                }
            }
        }
        if let Some(text) = decoder.finish() {
            emit(text);
        }
    });
}

fn collect(
    child: &mut HostChild,
    timeout: Option<Duration>,
    cancel: &CancelToken,
    on_line: &mut dyn FnMut(&Line) -> LineAction,
) -> Result<ScriptOutput> {
    let start = Instant::now();
    let mut out = ScriptOutput::default();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut drain_deadline: Option<Instant> = None;
    loop {
        match child.recv_line(Duration::from_millis(50)) {
            Ok(line) => {
                let action = if out.killed {
                    LineAction::Continue
                } else {
                    on_line(&line)
                };
                match line.stream {
                    Stream::Stdout => stdout.push(line.text),
                    Stream::Stderr => stderr.push(line.text),
                }
                if action == LineAction::Kill {
                    out.killed = true;
                    child.kill();
                    drain_deadline = Some(Instant::now() + Duration::from_secs(2));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if let Some(d) = drain_deadline {
            if Instant::now() > d {
                break;
            }
            continue;
        }
        if cancel.is_cancelled() {
            child.kill();
            return Err(Error::cancelled());
        }
        if let Some(t) = timeout
            && start.elapsed() > t
        {
            child.kill();
            return Err(Error::new(ErrorKind::Timeout).detail(tail(&stderr.join("\n"), 400)));
        }
    }
    out.code = if out.killed {
        child.try_wait().flatten()
    } else {
        child.wait()
    };
    out.stdout = stdout.join("\n");
    out.stderr = stderr.join("\n");
    Ok(out)
}

/// Last `max` bytes of `s` (on a char boundary), for error details.
pub fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.trim().to_owned();
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].trim().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(s: &str) -> String {
        String::from_utf8(B64.decode(s).unwrap()).unwrap()
    }

    #[test]
    fn wsl_invocation_is_base64_only_after_the_bootstrap() {
        let host = Host::Wsl {
            distro: Some("Ubuntu-24.04".into()),
        };
        let req = ScriptRequest::new("printf '%s' \"$1\"")
            .arg("héllo \"world\" $(rm -rf /)")
            .env("COLAB_X", "a b\nc");
        let inv = host.invocation(&req, true).unwrap();
        assert_eq!(inv.program, "wsl.exe");
        assert!(inv.no_window);
        assert_eq!(inv.env, vec![("WSL_UTF8".to_owned(), "1".to_owned())]);
        assert_eq!(
            &inv.args[..6],
            &["-d", "Ubuntu-24.04", "-e", "bash", "-lc", BOOTSTRAP]
        );
        let rest = &inv.args[6..];
        let b64ish = |s: &str| {
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || "+/=".contains(c))
        };
        assert!(rest.iter().all(|a| b64ish(a)), "{rest:?}");
        assert_eq!(decode(&rest[0]), BOOT_BODY);
        assert_eq!(decode(&rest[1]), req.script);
        assert_eq!(rest[2], "1");
        assert_eq!(rest[3], "1");
        assert_eq!(decode(&rest[4]), "COLAB_X=a b\nc");
        assert_eq!(decode(&rest[5]), "héllo \"world\" $(rm -rf /)");
    }

    #[test]
    fn default_distro_omits_dash_d() {
        let inv = Host::Wsl { distro: None }
            .invocation(&ScriptRequest::new("true"), false)
            .unwrap();
        assert_eq!(&inv.args[..3], &["-e", "bash", "-lc"]);
        assert_eq!(inv.args[6], "0");
    }

    #[test]
    fn bad_distro_and_env_key_are_rejected() {
        let host = Host::Wsl {
            distro: Some("-x".into()),
        };
        assert!(
            host.invocation(&ScriptRequest::new("true"), true)
                .unwrap_err()
                .is(ErrorKind::InvalidInput)
        );
        let host = Host::Wsl { distro: None };
        let req = ScriptRequest::new("true").env("BAD-KEY", "x");
        assert!(
            host.invocation(&req, true)
                .unwrap_err()
                .is(ErrorKind::InvalidInput)
        );
    }

    #[test]
    fn oversized_wsl_command_line_is_refused() {
        let req = ScriptRequest::new("true").arg("x".repeat(40_000));
        let err = Host::Wsl { distro: None }
            .invocation(&req, true)
            .unwrap_err();
        assert!(err.is(ErrorKind::CommandTooLong));
    }

    #[cfg(unix)]
    #[test]
    fn local_invocation_sets_env_on_process() {
        let req = ScriptRequest::new("true").env("HOME", "/tmp/x").arg("a");
        let inv = Host::Local.invocation(&req, true).unwrap();
        assert_eq!(inv.program, "bash");
        assert_eq!(inv.env, vec![("HOME".to_owned(), "/tmp/x".to_owned())]);
        assert_eq!(inv.args[5], "0");
        assert_eq!(decode(&inv.args[6]), "a");
    }

    #[cfg(windows)]
    #[test]
    fn local_scripts_are_unsupported_on_windows() {
        let err = Host::Local
            .invocation(&ScriptRequest::new("true"), true)
            .unwrap_err();
        assert!(err.is(ErrorKind::Unsupported));
    }

    #[test]
    fn env_keys_and_quoting() {
        assert!(is_env_key("PLUGIN_INPUT_REPO"));
        assert!(is_env_key("_x1"));
        assert!(!is_env_key("1x"));
        assert!(!is_env_key("a-b"));
        assert!(!is_env_key(""));
        assert_eq!(shell_quote("/usr/bin/colab"), "/usr/bin/colab");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn probe_output_parsing() {
        let mut r = ProbeReport::default();
        r.apply_probe_output(
            "motd noise\nCPG colab=/home/u/.local/bin/colab\nCPG helper_python=/home/u/.local/share/uv/tools/google-colab-cli/bin/python\nCPG keyring=ok\nCPG colab_version=0.4.1\n",
        );
        assert_eq!(r.colab_version.as_deref(), Some("0.4.1"));
        assert!(r.keyring_ok);
        let tc = r.toolchain().unwrap();
        assert!(tc.helper_python.ends_with("/bin/python"));
    }

    #[test]
    fn colab_path_override_resolution() {
        let t = Toolchain::from_colab_path("/opt/colab");
        assert!(t.needs_resolution());
        let ok =
            parse_resolution("/opt/colab", "noise\nCPG helper_python=/venv/bin/python\n").unwrap();
        assert_eq!(ok.helper_python, "/venv/bin/python");
        assert!(!ok.needs_resolution());
        let e = parse_resolution(
            "/opt/colab",
            "CPG interpreter=/gone/python\nCPG reason=interpreter_missing\n",
        )
        .unwrap_err();
        assert!(e.is(ErrorKind::InvalidInput));
        assert_eq!(e.param("field"), Some("colab_path"));
        assert_eq!(e.param("reason"), Some("interpreter_missing"));
        assert_eq!(e.param("interpreter"), Some("/gone/python"));
        assert_eq!(
            parse_resolution("/x", "CPG reason=not_found")
                .unwrap_err()
                .param("reason"),
            Some("not_found")
        );
        assert!(
            parse_resolution("/x", "garbage")
                .unwrap_err()
                .is(ErrorKind::Parse)
        );
        // Relative paths are refused before anything runs.
        let e = Toolchain::from_colab_path("colab")
            .resolve(&Host::Wsl { distro: None }, &[], &CancelToken::new())
            .unwrap_err();
        assert_eq!(e.param("reason"), Some("not_absolute"));
        // An already complete toolchain resolves to itself without spawning.
        let full = Toolchain {
            colab: "/c".into(),
            helper_python: "/p".into(),
        };
        assert_eq!(
            full.resolve(&Host::Wsl { distro: None }, &[], &CancelToken::new())
                .unwrap(),
            full
        );
    }

    fn utf16le(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    fn decode_all(detect_utf16: bool, bytes: &[u8], chunk: usize) -> Vec<String> {
        let mut decoder = LineDecoder::new(detect_utf16);
        let mut lines = Vec::new();
        for part in bytes.chunks(chunk) {
            decoder.push(part, &mut lines);
        }
        lines.extend(decoder.finish());
        lines
    }

    #[test]
    fn wsl_utf16_output_is_decoded() {
        let text = "版权所有(c) Microsoft Corporation。保留所有权利。\r\n用法: wsl.exe [Argument]\r\n\r\n    --install <Options>";
        let want = [
            "版权所有(c) Microsoft Corporation。保留所有权利。",
            "用法: wsl.exe [Argument]",
            "",
            "    --install <Options>",
        ];
        for chunk in [1, 2, 3, 7, 4096] {
            assert_eq!(
                decode_all(true, &utf16le(text), chunk),
                want,
                "chunk {chunk}"
            );
        }
        let mut with_bom = vec![0xff, 0xfe];
        with_bom.extend(utf16le("Ubuntu\r\n"));
        assert_eq!(decode_all(true, &with_bom, 4096), ["Ubuntu"]);
    }

    #[test]
    fn wsl_utf8_lines_are_split_as_soon_as_they_end() {
        let mut decoder = LineDecoder::new(true);
        let mut lines = Vec::new();
        decoder.push(b"\x1eCPG-PGID 1234\nerr", &mut lines);
        assert_eq!(lines, ["\x1eCPG-PGID 1234"]);
        assert_eq!(decoder.finish().as_deref(), Some("err"));
    }

    #[test]
    fn utf8_output_is_unchanged() {
        let text = "中文 ✓ héllo\r\nsecond\nlast";
        let want = ["中文 ✓ héllo", "second", "last"];
        for detect in [true, false] {
            for chunk in [1, 5, 4096] {
                assert_eq!(decode_all(detect, text.as_bytes(), chunk), want);
            }
        }
        // Local output is never treated as UTF-16, whatever it contains.
        assert!(decode_all(false, &utf16le("ab\n"), 4096)[0].contains('\0'));
    }

    #[test]
    fn wsl_distro_list_parsing() {
        assert_eq!(
            parse_wsl_distros("\u{feff}Ubuntu-24.04\n  Debian \n\n"),
            ["Ubuntu-24.04", "Debian"]
        );
    }

    #[test]
    fn tail_respects_char_boundaries() {
        assert_eq!(tail("abc", 10), "abc");
        assert_eq!(tail("ééé", 3), "é");
    }

    /// Runs the exact WSL encoding (positional env) through a local bash.
    #[cfg(unix)]
    #[test]
    fn bootstrap_round_trips_args_env_stdin_and_exit_code() {
        let req = ScriptRequest::new(
            "printf 'a1=[%s] a2=[%s] n=%s\\n' \"$1\" \"$2\" \"$#\"; printf 'env=[%s]\\n' \"$CPG_T\"; cat; exit 7",
        )
        .arg("héllo 'q' \"d\" $(x) `y`")
        .arg("line1\nline2\n")
        .env("CPG_T", "v=1 ñ\n")
        .stdin_bytes("from stdin ✓\n");
        let args = encode_bash_args(&req, true, true).unwrap();
        let inv = Invocation {
            program: "bash".into(),
            args,
            env: vec![],
            no_window: false,
        };
        let child = spawn_invocation(&inv, Stdio::piped()).unwrap();
        let mut child = HostChild::start(Host::Local, child, None, false);
        let mut pipe = child.child.stdin.take().unwrap();
        pipe.write_all("from stdin ✓\n".as_bytes()).unwrap();
        drop(pipe);
        let out = collect(
            &mut child,
            Some(Duration::from_secs(20)),
            &CancelToken::new(),
            &mut |_| LineAction::Continue,
        )
        .unwrap();
        assert_eq!(out.code, Some(7));
        assert!(
            out.stdout.contains("a1=[héllo 'q' \"d\" $(x) `y`]"),
            "{}",
            out.stdout
        );
        assert!(
            out.stdout.contains("a2=[line1\nline2\n] n=2"),
            "{}",
            out.stdout
        );
        assert!(out.stdout.contains("env=[v=1 ñ\n]"), "{}", out.stdout);
        assert!(out.stdout.contains("from stdin ✓"));
        assert!(!out.stderr.contains("CPG-PGID"));
    }

    #[test]
    fn keepalive_runs_only_under_wsl_and_holds_stdin() {
        let local = HostKeepalive::new(Host::Local);
        local.ensure();
        assert!(!local.is_running());
        // Spawns nothing: tests never start `wsl.exe` (DESIGN.md, hard safety rules).
        let wsl = HostKeepalive::new(Host::Wsl { distro: None });
        assert!(!wsl.is_running());
        let req = keepalive_request(KEEPALIVE_BUS_WAIT_TENTHS);
        assert_eq!(req.stdin, StdinMode::Pipe);
        assert_eq!(req.args, vec![KEEPALIVE_BUS_WAIT_TENTHS.to_string()]);
        assert!(req.timeout.is_none());
        let inv = Host::Wsl {
            distro: Some("Ubuntu".into()),
        }
        .invocation(&req, true)
        .unwrap();
        assert_eq!(inv.program, "wsl.exe");
        assert!(inv.no_window);
    }

    /// The keepalive script through the real bootstrap: ready at once without a
    /// bus address, then up until stdin closes.
    #[cfg(unix)]
    #[test]
    fn keepalive_script_ends_at_stdin_eof() {
        let req = keepalive_request(100).env("DBUS_SESSION_BUS_ADDRESS", "");
        let mut child = Host::Local.spawn(req).unwrap();
        assert!(wait_until_ready(&child, Duration::from_secs(5)));
        std::thread::sleep(Duration::from_millis(300));
        assert!(child.try_wait().is_none(), "ended before stdin closed");
        child.close_stdin();
        let deadline = Instant::now() + Duration::from_secs(10);
        while child.try_wait().is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(child.try_wait(), Some(Some(0)));
    }

    #[cfg(unix)]
    #[test]
    fn keepalive_is_ready_once_the_session_bus_socket_exists() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("bus");
        let addr = format!("unix:path={},guid=0123", sock.display());
        let req = keepalive_request(100).env("DBUS_SESSION_BUS_ADDRESS", addr);
        let child = Host::Local.spawn(req).unwrap();
        assert!(
            !wait_until_ready(&child, Duration::from_millis(600)),
            "ready before the bus socket existed"
        );
        let _bus = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        assert!(wait_until_ready(&child, Duration::from_secs(5)));
    }

    #[cfg(unix)]
    #[test]
    fn keepalive_stops_waiting_for_a_bus_that_never_comes() {
        let dir = tempfile::tempdir().unwrap();
        let addr = format!("unix:path={}", dir.path().join("never").display());
        let req = keepalive_request(3).env("DBUS_SESSION_BUS_ADDRESS", addr);
        let mut child = Host::Local.spawn(req).unwrap();
        assert!(wait_until_ready(&child, Duration::from_secs(5)));
        assert!(
            child.try_wait().is_none(),
            "the keepalive ended after the wait"
        );
    }

    #[cfg(unix)]
    #[test]
    fn kill_takes_down_the_process_group() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("survived");
        let req = ScriptRequest::new("(sleep 3; touch \"$1\") & echo started; wait")
            .arg(marker.to_string_lossy().to_string())
            .stdin_pipe();
        let mut child = Host::Local.spawn(req).unwrap();
        let line = child.recv_line(Duration::from_secs(10)).unwrap();
        assert_eq!(line.text, "started");
        // Give the reader a moment to record the group id.
        std::thread::sleep(Duration::from_millis(200));
        child.kill();
        std::thread::sleep(Duration::from_secs(4));
        assert!(!marker.exists(), "background grandchild survived the kill");
    }

    #[cfg(unix)]
    #[test]
    fn a_kill_right_after_the_spawn_waits_for_the_group_id() {
        let mut child = Host::Local
            .spawn(ScriptRequest::new("sleep 30").stdin_pipe())
            .unwrap();
        assert!(child.await_pgid(Duration::from_secs(5)).is_some());
        child.kill();
        assert!(child.try_wait().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn line_callback_can_kill_and_cancel_works() {
        let req = ScriptRequest::new("echo prompt >&2; sleep 30");
        let out = Host::Local
            .run(req, &CancelToken::new(), &mut |l| {
                if l.text == "prompt" {
                    LineAction::Kill
                } else {
                    LineAction::Continue
                }
            })
            .unwrap();
        assert!(out.killed);
        let cancel = CancelToken::new();
        let c2 = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            c2.cancel();
        });
        let err = Host::Local
            .run_quiet(ScriptRequest::new("sleep 30"), &cancel)
            .unwrap_err();
        assert!(err.is(ErrorKind::Cancelled));
        let err = Host::Local
            .run_quiet(
                ScriptRequest::new("sleep 30").timeout(Duration::from_millis(300)),
                &CancelToken::new(),
            )
            .unwrap_err();
        assert!(err.is(ErrorKind::Timeout));
    }

    #[cfg(unix)]
    fn write_exec(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
        make_executable(path).unwrap();
    }

    #[cfg(unix)]
    fn run_shebang_python(
        script_path: &std::path::Path,
        path_prefix: Option<&std::path::Path>,
    ) -> String {
        let body = match path_prefix {
            Some(_) => format!(
                "PATH=\"$2:$PATH\"\n{}",
                with_shebang_python("shebang_python \"$1\"")
            ),
            None => with_shebang_python("shebang_python \"$1\""),
        };
        let mut req = ScriptRequest::new(body)
            .arg(script_path.to_string_lossy().to_string())
            .timeout(Duration::from_secs(20));
        if let Some(prefix) = path_prefix {
            req = req.arg(prefix.to_string_lossy().to_string());
        }
        Host::Local
            .run_quiet(req, &CancelToken::new())
            .unwrap()
            .stdout
    }

    #[cfg(unix)]
    #[test]
    fn shebang_python_follows_multiline_bash_wrappers_and_probe_checks_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        // Symlink to the host's compiled `python3` binary (not a `#!/bin/sh` script) because
        // macOS rejects nested shebangs when `PROBE_SCRIPT` executes `"$c" version`.
        let real_python = Host::Local
            .run_quiet(
                ScriptRequest::new(
                    "python3 -c 'import os, sys; print(os.path.realpath(sys.executable))'",
                )
                .timeout(Duration::from_secs(20)),
                &CancelToken::new(),
            )
            .unwrap()
            .stdout;
        assert!(
            !real_python.is_empty(),
            "python3 is required for unix tests"
        );
        let venv_python = root.join("venv/bin/python3");
        std::fs::create_dir_all(venv_python.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&real_python, &venv_python).unwrap();

        let venv_colab = root.join("venv/bin/colab");
        write_exec(
            &venv_colab,
            &format!(
                "#!{}\nprint('Version: 0.8.0-fake')\n",
                venv_python.display()
            ),
        );

        let py_lib = root.join("py_lib");
        std::fs::create_dir_all(&py_lib).unwrap();
        std::fs::write(py_lib.join("keyring.py"), "").unwrap();

        // Multi-line `#!/usr/bin/env bash` wrapper with umask, export, comments, and FD redirect.
        let wrapper_bin = root.join("bin");
        let env_bash_wrapper = wrapper_bin.join("colab");
        write_exec(
            &env_bash_wrapper,
            &format!(
                "#!/usr/bin/env bash\n\
                 set -euo pipefail\n\
                 umask 077\n\
                 # exec /wrong/comment\n\
                 export COLAB_NOTE=\"exec /wrong/export\"\n\
                 exec 2>&1\n\
                 exec {} \"$@\"\n",
                venv_colab.display()
            ),
        );

        let expected = venv_python.to_string_lossy().to_string();
        assert_eq!(run_shebang_python(&env_bash_wrapper, None), expected);

        let resolved = Toolchain::from_colab_path(env_bash_wrapper.to_string_lossy().to_string())
            .resolve(&Host::Local, &[], &CancelToken::new())
            .unwrap();
        assert_eq!(resolved.helper_python, expected);

        // Run PROBE_SCRIPT with isolated PATH, HOME, and stub keyring so no host `colab` or
        // system keyring is touched.
        let fake_home = root.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        let probe_req = ScriptRequest::new(format!(
            "PATH=\"$1:$PATH\"\n{}",
            with_shebang_python(PROBE_SCRIPT)
        ))
        .arg(wrapper_bin.to_string_lossy().to_string())
        .env("HOME", fake_home.to_string_lossy().to_string())
        .env("PYTHONPATH", py_lib.to_string_lossy().to_string())
        .timeout(Duration::from_secs(20));
        let out = Host::Local
            .run_quiet(probe_req, &CancelToken::new())
            .unwrap();
        let mut report = ProbeReport::default();
        report.apply_probe_output(&out.stdout);
        assert_eq!(report.helper_python.as_deref(), Some(expected.as_str()));
        assert!(report.keyring_ok);
        assert_eq!(report.colab_version.as_deref(), Some("0.8.0-fake"));

        // Quoted paths with spaces, exec flags, env prefix, redirections, heredocs, multi-hop
        // chain, and direct python exec.
        let spaced_colab = root.join("dir with spaces/venv/bin/colab");
        write_exec(&spaced_colab, &format!("#!{}\n", venv_python.display()));

        let double_quoted = root.join("wrap_dq");
        write_exec(
            &double_quoted,
            &format!(
                "#!/bin/bash\nexport FOO=1\nexec \"{}\" \"$@\"",
                spaced_colab.display()
            ),
        );
        assert_eq!(run_shebang_python(&double_quoted, None), expected);

        let single_quoted = root.join("wrap_sq");
        write_exec(
            &single_quoted,
            &format!(
                "#!/bin/bash\nexec -a colab -- '{}' \"$@\"\n",
                spaced_colab.display()
            ),
        );
        assert_eq!(run_shebang_python(&single_quoted, None), expected);

        let via_env = root.join("wrap_env");
        write_exec(
            &via_env,
            &format!(
                "#!/usr/bin/env bash\nFOO=\"a b\" exec /usr/bin/env BAR=\"c d\" \"{}\" \"$@\"\n",
                spaced_colab.display()
            ),
        );
        assert_eq!(run_shebang_python(&via_env, None), expected);

        let attached_redir = root.join("wrap_attached_redir");
        let log_file = root.join("colab.log");
        write_exec(
            &attached_redir,
            &format!(
                "#!/usr/bin/env bash\nexec {}>{} \"$@\"\n",
                venv_colab.display(),
                log_file.display()
            ),
        );
        assert_eq!(run_shebang_python(&attached_redir, None), expected);

        let prefixed_redir = root.join("wrap_prefixed_redir");
        write_exec(
            &prefixed_redir,
            &format!(
                "#!/usr/bin/env bash\nexec 2>>{} &>/dev/null {} \"$@\"\n",
                log_file.display(),
                venv_colab.display()
            ),
        );
        assert_eq!(run_shebang_python(&prefixed_redir, None), expected);

        let after_heredoc = root.join("wrap_after_heredoc");
        write_exec(
            &after_heredoc,
            &format!(
                "#!/usr/bin/env bash\n\
                 cat <<-\"END\" >/dev/null\n\
                 exec /wrong/python3\n\
                 \tEND\n\
                 read -r _ <<< \"ignored\"\n\
                 exec {} \"$@\"\n",
                venv_colab.display()
            ),
        );
        assert_eq!(run_shebang_python(&after_heredoc, None), expected);

        // `#!/bin/sh` wrapper forwarding to an explicit target path follows that target even if a
        // sibling `python` exists in the wrapper's own directory.
        let sh_with_sibling_dir = root.join("sh_sibling");
        write_exec(&sh_with_sibling_dir.join("python"), "#!/bin/sh\nexit 0\n");
        let sh_forward = sh_with_sibling_dir.join("colab");
        write_exec(
            &sh_forward,
            &format!("#!/bin/sh\nexec {} \"$@\"\n", venv_colab.display()),
        );
        assert_eq!(run_shebang_python(&sh_forward, None), expected);

        let hop1 = root.join("hop1");
        write_exec(
            &hop1,
            &format!("#!/bin/sh\nexec {} \"$@\"\n", double_quoted.display()),
        );
        assert_eq!(run_shebang_python(&hop1, None), expected);

        let direct_py_exec = root.join("wrap_direct_py");
        write_exec(
            &direct_py_exec,
            &format!(
                "#!/usr/bin/env bash\numask 077\nexec {} -m colab_cli \"$@\"\n",
                venv_python.display()
            ),
        );
        assert_eq!(run_shebang_python(&direct_py_exec, None), expected);
    }

    #[cfg(unix)]
    #[test]
    fn shebang_python_preserves_direct_python_and_uv_pip_launchers() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        let py_dir = root.join("pybin");
        let fake_py3 = py_dir.join("python3");
        write_exec(&fake_py3, "#!/bin/sh\nexit 0\n");

        let direct_abs = root.join("direct_abs");
        write_exec(&direct_abs, &format!("#!{}\n", fake_py3.display()));
        assert_eq!(
            run_shebang_python(&direct_abs, None),
            fake_py3.to_string_lossy()
        );

        let direct_env = root.join("direct_env");
        write_exec(&direct_env, "#!/usr/bin/env python3\n");
        assert_eq!(
            run_shebang_python(&direct_env, Some(&py_dir)),
            fake_py3.to_string_lossy()
        );

        let direct_env_s = root.join("direct_env_s");
        write_exec(&direct_env_s, "#!/usr/bin/env -S python3 -u\n");
        assert_eq!(
            run_shebang_python(&direct_env_s, Some(&py_dir)),
            fake_py3.to_string_lossy()
        );

        // Relocatable uv/pip `#!/bin/sh` launcher with sibling `python`.
        let uv_dir = root.join("uv_venv/bin");
        let uv_py = uv_dir.join("python");
        write_exec(&uv_py, "#!/bin/sh\nexit 0\n");
        let uv_colab = uv_dir.join("colab");
        write_exec(
            &uv_colab,
            "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")/python\" \"$0\" \"$@\"\n' '''\n",
        );
        assert_eq!(run_shebang_python(&uv_colab, None), uv_py.to_string_lossy());

        // `#!/usr/bin/env sh` launcher with sibling `python`.
        let env_sh_colab = uv_dir.join("colab_env_sh");
        write_exec(
            &env_sh_colab,
            "#!/usr/bin/env sh\nexec \"$(dirname -- \"$0\")/python\" \"$0\" \"$@\"\n",
        );
        assert_eq!(
            run_shebang_python(&env_sh_colab, None),
            uv_py.to_string_lossy()
        );

        // Literal-path pip/uv launcher pointing to a path with spaces.
        let spaced_py = root.join("my venv/bin/python3");
        write_exec(&spaced_py, "#!/bin/sh\nexit 0\n");
        let pip_literal = root.join("pip_literal");
        write_exec(
            &pip_literal,
            &format!(
                "#!/bin/sh\n'''exec' '{}' \"$0\" \"$@\"\n' '''\n",
                spaced_py.display()
            ),
        );
        assert_eq!(
            run_shebang_python(&pip_literal, None),
            spaced_py.to_string_lossy()
        );

        // Bash wrapper forwarding to a uv/pip `#!/bin/sh` launcher.
        let bash_to_uv = root.join("bash_to_uv");
        write_exec(
            &bash_to_uv,
            &format!("#!/usr/bin/env bash\nexec {} \"$@\"\n", uv_colab.display()),
        );
        assert_eq!(
            run_shebang_python(&bash_to_uv, None),
            uv_py.to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn shebang_python_rejects_non_python_shell_wrappers_and_cycles() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();

        // Wrapper with no exec must return empty (never bash/sh).
        let no_exec_dir = root.join("no_exec_bin");
        let no_exec = no_exec_dir.join("colab");
        write_exec(&no_exec, "#!/usr/bin/env bash\necho 'Version: 0.0.0'\n");
        assert_eq!(run_shebang_python(&no_exec, None), "");

        let err = Toolchain::from_colab_path(no_exec.to_string_lossy().to_string())
            .resolve(&Host::Local, &[], &CancelToken::new())
            .unwrap_err();
        assert_eq!(err.param("reason"), Some("no_python_shebang"));

        // PROBE_SCRIPT must report helper_python = None and keyring_ok = false.
        let fake_home = root.join("home");
        std::fs::create_dir_all(&fake_home).unwrap();
        let probe_req = ScriptRequest::new(format!(
            "PATH=\"$1:$PATH\"\n{}",
            with_shebang_python(PROBE_SCRIPT)
        ))
        .arg(no_exec_dir.to_string_lossy().to_string())
        .env("HOME", fake_home.to_string_lossy().to_string())
        .timeout(Duration::from_secs(20));
        let out = Host::Local
            .run_quiet(probe_req, &CancelToken::new())
            .unwrap();
        let mut report = ProbeReport::default();
        report.apply_probe_output(&out.stdout);
        assert_eq!(report.helper_python, None);
        assert!(!report.keyring_ok);

        // Shell wrappers exec'ing a non-Python script must return empty, even if sibling python exists.
        let mixed_dir = root.join("mixed");
        write_exec(&mixed_dir.join("python"), "#!/bin/sh\nexit 0\n");
        let non_py_target = root.join("tool");
        write_exec(&non_py_target, "#!/usr/bin/env node\n");
        let exec_non_py = mixed_dir.join("colab");
        write_exec(
            &exec_non_py,
            &format!("#!/bin/bash\nexec {} \"$@\"\n", non_py_target.display()),
        );
        assert_eq!(run_shebang_python(&exec_non_py, None), "");

        let sh_non_py_with_sibling = mixed_dir.join("colab_sh");
        write_exec(
            &sh_non_py_with_sibling,
            &format!("#!/bin/sh\nexec {} \"$@\"\n", non_py_target.display()),
        );
        assert_eq!(run_shebang_python(&sh_non_py_with_sibling, None), "");

        // `#!/bin/sh` self-loop in a directory with sibling `python` must still detect the cycle.
        let sh_self_loop = mixed_dir.join("colab_sh_loop");
        write_exec(
            &sh_self_loop,
            &format!("#!/bin/sh\nexec {} \"$@\"\n", sh_self_loop.display()),
        );
        assert_eq!(run_shebang_python(&sh_self_loop, None), "");

        // Here-document body containing `exec /.../python3` must be ignored.
        let heredoc_only = root.join("heredoc_only");
        write_exec(
            &heredoc_only,
            &format!(
                "#!/usr/bin/env bash\n\
                 : <<'NOTE'\n\
                 exec {}\n\
                 NOTE\n\
                 exec {} \"$@\"\n",
                mixed_dir.join("python").display(),
                non_py_target.display()
            ),
        );
        assert_eq!(run_shebang_python(&heredoc_only, None), "");

        // Dynamic uv/pip launcher without sibling `python` returns empty.
        let orphan_uv = root.join("orphan_uv/colab");
        write_exec(
            &orphan_uv,
            "#!/bin/sh\n'''exec' \"$(dirname -- \"$0\")/python\" \"$0\" \"$@\"\n' '''\n",
        );
        assert_eq!(run_shebang_python(&orphan_uv, None), "");

        // Self-loop wrapper must terminate and return empty.
        let self_loop = root.join("self_loop");
        write_exec(
            &self_loop,
            &format!("#!/usr/bin/env bash\nexec {} \"$@\"\n", self_loop.display()),
        );
        assert_eq!(run_shebang_python(&self_loop, None), "");
        let err = Toolchain::from_colab_path(self_loop.to_string_lossy().to_string())
            .resolve(&Host::Local, &[], &CancelToken::new())
            .unwrap_err();
        assert_eq!(err.param("reason"), Some("no_python_shebang"));

        // Two-hop cycle must terminate and return empty.
        let cyc_a = root.join("cyc_a");
        let cyc_b = root.join("cyc_b");
        write_exec(
            &cyc_a,
            &format!("#!/bin/bash\nexec {} \"$@\"\n", cyc_b.display()),
        );
        write_exec(
            &cyc_b,
            &format!("#!/bin/bash\nexec {} \"$@\"\n", cyc_a.display()),
        );
        assert_eq!(run_shebang_python(&cyc_a, None), "");

        // Chain exceeding hop depth limit (8) stops and returns empty.
        let deep_py = root.join("deep/python3");
        write_exec(&deep_py, "#!/bin/sh\nexit 0\n");
        let deep_target = root.join("deep/colab");
        write_exec(&deep_target, &format!("#!{}\n", deep_py.display()));
        let mut next = deep_target;
        for i in (0..10).rev() {
            let link = root.join(format!("deep/w{i}"));
            write_exec(
                &link,
                &format!("#!/bin/bash\nexec {} \"$@\"\n", next.display()),
            );
            next = link;
        }
        assert_eq!(run_shebang_python(&next, None), "");

        // Wrapper pointing to a Python script with a missing interpreter reports `interpreter_missing`.
        let missing_py = root.join("gone/python3");
        let broken_entry = root.join("broken_entry");
        write_exec(&broken_entry, &format!("#!{}\n", missing_py.display()));
        let wrap_broken = root.join("wrap_broken");
        write_exec(
            &wrap_broken,
            &format!(
                "#!/usr/bin/env bash\nexec {} \"$@\"\n",
                broken_entry.display()
            ),
        );
        let err = Toolchain::from_colab_path(wrap_broken.to_string_lossy().to_string())
            .resolve(&Host::Local, &[], &CancelToken::new())
            .unwrap_err();
        assert_eq!(err.param("reason"), Some("interpreter_missing"));
        assert_eq!(
            err.param("interpreter"),
            Some(missing_py.to_string_lossy().as_ref())
        );
    }
}
