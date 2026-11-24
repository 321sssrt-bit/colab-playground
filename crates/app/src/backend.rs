//! Which backend the UI talks to, and how it is built.
//!
//! `main` resolves the flags into a [`BackendSource`]; `AppState` turns that into an
//! `Arc<dyn Backend>` once the settings (defaults, WSL distro, `colab` path) are loaded. Tests
//! never come through here: the harness hands `AppState` a headless `MockBackend` directly.

use std::{sync::Arc, time::Duration};

use colab_playground_core::{
    Defaults, Host,
    backend::{Backend, BackendKind as Flavor},
    mock::{MockBackend, MockConfig},
    real::{RealBackend, RealConfig},
};
use colab_playground_shared::backend::{self, BackendSelection};

use crate::platform;

pub use colab_playground_shared::{
    backend::{BACKEND_ENV, BackendError, BackendKind, MockFlags, usage},
    settings::HostSetup,
};

/// How long each simulated step of the interactive mock takes (pacing for `--mock` runs).
pub const MOCK_STEP_DELAY: Duration = Duration::from_millis(600);

pub fn check_args<S: AsRef<str>>(args: &[S]) -> Result<(), BackendError> {
    backend::check_args(args, &[], platform::is_launcher_argument)
}

pub fn source_from_args<S: AsRef<str>>(
    args: &[S],
    env: Option<&str>,
) -> Result<BackendSource, BackendError> {
    Ok(
        match backend::source_from_args(args, env, &[], platform::is_launcher_argument)? {
            BackendSelection::Mock(flags) => BackendSource::interactive_mock(flags),
            BackendSelection::Real => BackendSource::Real,
        },
    )
}

#[derive(Clone)]
pub enum BackendSource {
    /// Build a `RealBackend` from the settings (rebuilt when the WSL distro or `colab` path
    /// changes).
    Real,
    /// A ready simulation (the interactive one for `--mock`, a headless one in tests).
    Mock(Arc<dyn Backend>),
}

impl BackendSource {
    /// The interactive simulation for `--mock`: system clock, human-paced steps.
    pub fn interactive_mock(flags: MockFlags) -> Self {
        let mut config = MockConfig::interactive(MOCK_STEP_DELAY);
        config.scenario = flags.scenario;
        config.failures = flags.failures;
        BackendSource::Mock(Arc::new(MockBackend::new(config)))
    }

    pub fn flavor(&self) -> Flavor {
        match self {
            BackendSource::Real => Flavor::Real,
            BackendSource::Mock(_) => Flavor::Mock,
        }
    }
}

/// Builds the backend for `source`. A mock is returned as it is, with `defaults` pushed in.
pub fn build(
    source: &BackendSource,
    host: &HostSetup,
    defaults: &Defaults,
) -> colab_playground_core::Result<Arc<dyn Backend>> {
    match source {
        BackendSource::Mock(mock) => {
            mock.set_defaults(defaults.clone());
            Ok(mock.clone())
        }
        BackendSource::Real => {
            let mut config = RealConfig::for_app(defaults.clone())?;
            if let Host::Wsl { distro } = &mut config.host {
                distro.clone_from(&host.wsl_distro);
            }
            config.toolchain.clone_from(&host.toolchain);
            Ok(Arc::new(RealBackend::new(config)?))
        }
    }
}

/// Whether the shell shows the "Demo data" badge (the product principle in `docs/DESIGN.md`).
pub fn shows_demo_badge(flavor: Flavor) -> bool {
    flavor == Flavor::Mock
}

#[cfg(test)]
mod tests {
    use colab_playground_core::backend::BackendKind as Flavor;

    use super::shows_demo_badge;

    #[test]
    fn only_the_simulation_carries_the_demo_badge() {
        assert!(shows_demo_badge(Flavor::Mock));
        assert!(!shows_demo_badge(Flavor::Real));
    }
}
