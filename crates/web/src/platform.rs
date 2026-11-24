use std::{
    fs::File,
    io::{self, IsTerminal, Write},
    net::SocketAddr,
    path::Path,
};

use colab_playground_core::Host;
use colab_playground_web::state::ForwardPolicy;

pub fn forward_policy(listener: SocketAddr) -> ForwardPolicy {
    ForwardPolicy::new(listener.ip(), &Host::detect())
}

pub fn key_terminal() -> io::Result<io::StderrLock<'static>> {
    let terminal = io::stderr().lock();
    if !terminal.is_terminal() {
        return Err(io::Error::other(
            "Run from an interactive terminal to receive the Web access key.",
        ));
    }
    Ok(terminal)
}

pub fn write_hash(path: &Path, hash: &[u8]) -> io::Result<()> {
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().expect("key directory"))?;
    owner_only(tmp.as_file())?;
    tmp.write_all(hash)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    Ok(())
}

#[cfg(unix)]
fn owner_only(file: &File) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn owner_only(_: &File) -> io::Result<()> {
    Ok(())
}

pub fn open_browser(url: &str) {
    let (program, args) = browser_command(url);
    if !program.is_empty() {
        let _ = Host::Local.launch_detached(Path::new(program), &args, &[]);
    }
}

fn browser_command(url: &str) -> (&'static str, Vec<String>) {
    if cfg!(target_os = "macos") {
        ("open", vec![url.into()])
    } else if cfg!(windows) {
        (
            "rundll32.exe",
            vec!["url.dll,FileProtocolHandler".into(), url.into()],
        )
    } else if std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    {
        ("xdg-open", vec![url.into()])
    } else {
        ("", Vec::new())
    }
}

#[cfg(unix)]
pub struct ShutdownSignals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl ShutdownSignals {
    pub fn install() -> io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
        })
    }

    pub async fn recv(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
            _ = self.hangup.recv() => {}
        }
    }
}

#[cfg(windows)]
pub struct ShutdownSignals(tokio::signal::windows::CtrlC);

#[cfg(windows)]
impl ShutdownSignals {
    pub fn install() -> io::Result<Self> {
        tokio::signal::windows::ctrl_c().map(Self)
    }

    pub async fn recv(&mut self) {
        self.0.recv().await;
    }
}

pub fn force_exit(code: u8) -> ! {
    std::process::exit(i32::from(code))
}

pub fn headless_secret_service() -> bool {
    cfg!(target_os = "linux")
        && ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .all(|name| std::env::var_os(name).is_none_or(|value| value.is_empty()))
}

pub fn uses_wsl() -> bool {
    matches!(Host::detect(), Host::Wsl { .. })
}
