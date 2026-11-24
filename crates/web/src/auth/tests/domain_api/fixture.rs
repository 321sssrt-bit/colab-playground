use std::{path::PathBuf, time::SystemTime};

use colab_playground_core::{
    CancelToken, Defaults, Result,
    accounts::{Account, AccountId, AccountsView},
    backend::*,
    hf::HfModel,
    host::{Line, ProbeReport},
    plugins::{InputValue, PluginInfo, PluginOrigin, PluginPreview, validate_git_url},
    provision::{ProvisionEvent, ProvisionOutcome, ProvisionSpec},
    quant::GgufListing,
    sessions::{HardwareRate, WatchdogInfo},
    tunnel::{TunnelEvent, TunnelId, TunnelInfo, TunnelSpec},
};

use serde_json::json;

use super::{MockBackend, Path};

pub(super) struct Fixtures {
    pub mock: MockBackend,
    pub checkout: PathBuf,
    pub stop_failure: Option<&'static str>,
}

macro_rules! delegate {
    ($(fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        $(fn $name(&self, $($arg: $ty),*) $(-> $ret)? {
            self.mock.$name($($arg),*)
        })*
    };
}

impl Backend for Fixtures {
    delegate! {
        fn kind() -> BackendKind;
        fn defaults() -> Defaults;
        fn set_defaults(defaults: Defaults);
        fn now() -> SystemTime;
        fn probe(cancel: &CancelToken) -> Result<ProbeReport>;
        fn install_cli(method: InstallMethod, log: Events<Line>, cancel: &CancelToken) -> Result<()>;
        fn accounts(cancel: &CancelToken) -> Result<AccountsView>;
        fn adopt_active_account(cancel: &CancelToken) -> Result<Account>;
        fn begin_add_account(cancel: &CancelToken) -> Result<Box<dyn LoginFlow>>;
        fn switch_impact(to: &AccountId) -> Result<SwitchImpact>;
        fn switch_account(to: &AccountId, cancel: &CancelToken) -> Result<AccountsView>;
        fn remove_account(id: &AccountId, cancel: &CancelToken) -> Result<()>;
        fn refresh_usage(accounts: &[AccountId], cancel: &CancelToken) -> Result<Vec<AccountUsageView>>;
        fn usage() -> Vec<AccountUsageView>;
        fn usage_poll_due() -> bool;
        fn measured_rates() -> Vec<HardwareRate>;
        fn runtimes(cancel: &CancelToken) -> Result<RuntimesView>;
        fn new_session_name(prefix: Option<&str>) -> String;
        fn provision(spec: ProvisionSpec, events: Events<ProvisionEvent>, cancel: &CancelToken) -> Result<ProvisionOutcome>;
        fn extend_session(target: &RuntimeRef, by: std::time::Duration, cancel: &CancelToken) -> Result<Extension>;
        fn set_auto_stop(target: &RuntimeRef, runtime: std::time::Duration, cancel: &CancelToken) -> Result<WatchdogInfo>;
        fn cancel_auto_stop(target: &RuntimeRef, cancel: &CancelToken) -> Result<()>;
        fn guard_poll(cancel: &CancelToken) -> Result<GuardReport>;
        fn open_tunnel(spec: TunnelSpec, events: Events<TunnelEvent>) -> Result<TunnelId>;
        fn close_tunnel(id: TunnelId) -> Result<()>;
        fn tunnels() -> Vec<TunnelInfo>;
        fn plugins() -> Vec<PluginInfo>;
        fn plugin_run_template(plugin: &str) -> Result<PluginRunSpec>;
        fn inspect_plugin_folder(path: &Path) -> Result<PluginPreview>;
        fn install_plugin(preview: &PluginPreview) -> Result<PluginInfo>;
        fn discard_plugin_preview(preview: &PluginPreview);
        fn set_plugin_enabled(id: &str, enabled: bool) -> Result<()>;
        fn remove_plugin(id: &str) -> Result<()>;
        fn set_secret(name: &str, value: &str, cancel: &CancelToken) -> Result<()>;
        fn has_secret(name: &str, cancel: &CancelToken) -> Result<bool>;
        fn delete_secret(name: &str, cancel: &CancelToken) -> Result<()>;
        fn hf_search(query: &str, limit: u32, cancel: &CancelToken) -> Result<Vec<HfModel>>;
        fn hf_files(repo: &str, cancel: &CancelToken) -> Result<GgufListing>;
    }

    fn stop_session(
        &self,
        target: &RuntimeRef,
        options: StopOptions,
        cancel: &CancelToken,
    ) -> Result<()> {
        if self
            .stop_failure
            .is_some_and(|name| target.name.as_deref() == Some(name))
        {
            return Err(colab_playground_core::Error::new(
                colab_playground_core::ErrorKind::Http,
            ));
        }
        self.mock.stop_session(target, options, cancel)
    }

    fn inspect_plugin_git(&self, url: &str, cancel: &CancelToken) -> Result<PluginPreview> {
        cancel.check()?;
        validate_git_url(url)?;
        let mut preview = self.mock.inspect_plugin_folder(&self.checkout)?;
        preview.origin = PluginOrigin::Git { url: url.into() };
        Ok(preview)
    }

    fn run_plugin(
        &self,
        spec: PluginRunSpec,
        events: Events<PluginRunEvent>,
        cancel: &CancelToken,
    ) -> Result<PluginRunOutcome> {
        let Some(InputValue::Text(secret)) = spec.inputs.get("credential").cloned() else {
            panic!("the submitted secret must reach the backend");
        };
        let mut outcome = self.mock.run_plugin(spec, events.clone(), cancel)?;
        let _ = events.send(PluginRunEvent::LogSkipped {
            path: format!("/vm/{secret}/run.log"),
        });
        let _ = events.send(PluginRunEvent::Log {
            lines: vec![format!("credential={secret}")],
        });
        outcome.status.message = Some(format!("credential={secret}"));
        outcome
            .status
            .outputs
            .insert("nested".into(), json!({ format!("key-{secret}"): secret }));
        let _ = events.send(PluginRunEvent::Status(outcome.status.clone()));
        Ok(outcome)
    }
}
