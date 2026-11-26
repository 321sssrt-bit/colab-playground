//! Policy defaults and where the CLI lives.
//!
//! Every policy value lives in core's `Defaults`; the app only stores it in settings.json and
//! pushes it to the backend. The only rules here are input sanity: durations stay above zero
//! and attempts stay within core's hard cap.

use colab_playground_core::Defaults;
use gpui::{AppContext, Context};

use super::{AppState, InstallPhase, Op, SettingsFocus};
use crate::{backend, route::Route};

pub use colab_playground_shared::defaults::{MIN_DURATION, sanitize};

impl AppState {
    pub fn defaults(&self) -> &Defaults {
        &self.settings.defaults
    }

    /// Changes the defaults: saved to settings.json and pushed to the backend. Pushes run one
    /// after another, so the backend always ends with the latest values.
    pub fn update_defaults(&mut self, edit: impl FnOnce(&mut Defaults), cx: &mut Context<Self>) {
        let mut defaults = self.settings.defaults.clone();
        edit(&mut defaults);
        let defaults = sanitize(defaults);
        if defaults == self.settings.defaults {
            cx.notify();
            return;
        }
        self.settings.defaults = defaults.clone();
        self.persist_settings(cx);
        self.push_defaults(defaults, cx);
        cx.notify();
    }

    pub fn reset_defaults(&mut self, cx: &mut Context<Self>) {
        self.update_defaults(|defaults| *defaults = Defaults::default(), cx);
    }

    fn push_defaults(&mut self, defaults: Defaults, cx: &mut Context<Self>) {
        let Ok(backend) = self.backend.clone() else {
            return;
        };
        let previous = self.defaults_push.take();
        self.defaults_push = Some(cx.spawn(async move |_, cx| {
            if let Some(previous) = previous {
                previous.await;
            }
            cx.background_spawn(async move { backend.set_defaults(defaults) })
                .await;
        }));
    }

    /// Changes the WSL distribution; the backend is rebuilt when idle.
    pub fn set_wsl_distro(&mut self, distro: Option<String>, cx: &mut Context<Self>) {
        if self.settings.wsl_distro == distro {
            return;
        }
        self.settings.wsl_distro = distro;
        self.persist_settings(cx);
        self.rebuild_backend(cx);
    }

    /// Sets where `colab` and its interpreter are; rebuilds the backend. The interpreter may be
    /// left out: core then derives it from `colab`'s shebang.
    pub fn set_toolchain(
        &mut self,
        colab: Option<String>,
        python: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.settings.colab_path == colab && self.settings.colab_python == python {
            return;
        }
        self.settings.colab_path = colab;
        self.settings.colab_python = python;
        self.persist_settings(cx);
        self.rebuild_backend(cx);
    }

    /// Applies the paths as typed: blank means not set, and an interpreter without `colab`
    /// is refused with a warning.
    pub fn apply_host_paths(&mut self, colab: &str, python: &str, cx: &mut Context<Self>) {
        let typed = |text: &str| Some(text.trim().to_owned()).filter(|text| !text.is_empty());
        let (colab, python) = (typed(colab), typed(python));
        if colab.is_none() && python.is_some() {
            self.warn_host_paths(cx);
            return;
        }
        self.set_toolchain(colab, python, cx);
    }

    fn warn_host_paths(&mut self, cx: &mut Context<Self>) {
        let toast = ely_gpui_component::feedback::Toast::new(crate::i18n::tr(
            cx,
            crate::i18n::keys::HOST_INTERPRETER_ALONE,
        ))
        .severity(ely_gpui_component::primitives::Severity::Warning);
        self.toast(toast, cx);
    }

    /// Opens Settings with where the CLI lives at the top.
    pub fn open_host_setting(&mut self, cx: &mut Context<Self>) {
        self.navigate(Route::Settings, cx);
        self.settings_focus = Some(SettingsFocus::Host);
        cx.notify();
    }

    /// Whether host changes can be applied now (nothing else is running).
    pub fn can_change_host(&self) -> bool {
        !self.ops.any()
    }

    /// Rebuilds a real backend for the new host settings, then checks the environment again.
    /// The simulation ignores host settings.
    fn rebuild_backend(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.source, backend::BackendSource::Real) {
            log::info!("settings: the simulation ignores the WSL distribution and CLI paths");
            cx.notify();
            return;
        }
        if self.ops.is_running(Op::Rebuild) {
            return;
        }
        let (source, host, defaults) = (
            self.source.clone(),
            self.settings.host_setup(),
            self.settings.defaults.clone(),
        );
        self.ops.cancel_all();
        if self.ops.start(Op::Rebuild).is_none() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let built = cx
                .background_spawn(async move { backend::build(&source, &host, &defaults) })
                .await;
            this.update(cx, |state, cx| {
                state.ops.finish(Op::Rebuild);
                state.backend = built;
                state.probe = super::Load::Idle;
                state.accounts = super::Load::Idle;
                // How the last install ended, and its log, belong to the host it ran on.
                state.install.phase = InstallPhase::Idle;
                state.install.lines = Default::default();
                state.check_environment(cx);
            })
            .ok();
        })
        .detach();
        cx.notify();
    }
}
