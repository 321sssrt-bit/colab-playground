use std::{
    net::IpAddr,
    sync::mpsc::{Receiver, TryRecvError, channel},
};

use colab_playground_core::{
    Host,
    plugins::ResolvedEndpoint,
    tunnel::{ForwardBind, TunnelEvent, TunnelId, TunnelSpec, TunnelState},
};
use tokio::sync::broadcast;

use super::*;

const FORWARD_TICK: Duration = Duration::from_millis(250);
const EVENT_CAPACITY: usize = 128;

#[derive(Clone, Copy)]
pub struct ForwardPolicy {
    loopback: bool,
    supported_host: bool,
}

impl Default for ForwardPolicy {
    fn default() -> Self {
        Self {
            loopback: true,
            supported_host: Host::detect().supports_all_interfaces_forward(),
        }
    }
}

impl ForwardPolicy {
    pub fn new(listener: IpAddr, host: &Host) -> Self {
        Self {
            loopback: listener.to_canonical().is_loopback(),
            supported_host: host.supports_all_interfaces_forward(),
        }
    }

    pub fn all_interfaces_restriction(self) -> Option<&'static str> {
        if !self.supported_host {
            Some("windows_or_wsl")
        } else if self.loopback {
            Some("loopback_listener")
        } else {
            None
        }
    }

    pub fn all_interfaces_allowed(self) -> bool {
        self.all_interfaces_restriction().is_none()
    }

    fn check(self, bind: ForwardBind) -> Result<()> {
        if bind == ForwardBind::Loopback {
            return Ok(());
        }
        if let Some(reason) = self.all_interfaces_restriction() {
            return Err(Error::new(ErrorKind::Unsupported).with("forward_bind_restriction", reason));
        }
        Ok(())
    }
}

pub(super) struct ForwardUpdates {
    receivers: BTreeMap<TunnelId, Receiver<TunnelEvent>>,
    events: broadcast::Sender<TunnelEvent>,
}

impl Default for ForwardUpdates {
    fn default() -> Self {
        Self {
            receivers: BTreeMap::new(),
            events: broadcast::channel(EVENT_CAPACITY).0,
        }
    }
}

impl Snapshot {
    pub fn forward_endpoint(&self, id: TunnelId) -> Option<&ResolvedEndpoint> {
        self.forward_endpoints.get(&id)
    }
}

impl WebState {
    /// Subscribe to transitions that can occur between two versioned snapshots.
    pub fn subscribe_forwards(&self) -> broadcast::Receiver<TunnelEvent> {
        self.forward_updates().events.subscribe()
    }

    pub fn open_forward(
        &self,
        account: AccountContext,
        spec: TunnelSpec,
    ) -> Result<Submission<TunnelInfo>> {
        self.open_forward_with_endpoint(account, spec, None)
    }

    fn open_forward_with_endpoint(
        &self,
        account: AccountContext,
        spec: TunnelSpec,
        endpoint: Option<ResolvedEndpoint>,
    ) -> Result<Submission<TunnelInfo>> {
        self.0.forward_policy.check(spec.bind)?;
        spec.validate()?;
        if account.active.as_ref() != Some(&spec.account) {
            return Err(Error::new(ErrorKind::AccountNotActive));
        }
        let key = format!("{}/{}/{}", spec.account, spec.session, spec.remote_port);
        let state = self.clone();
        self.start_operation(
            "open_forward",
            key,
            Access::Account(account),
            move |backend, cancel| state.open_tunnel(spec, endpoint, backend, cancel),
        )
    }

    pub(super) fn open_tunnel(
        &self,
        spec: TunnelSpec,
        endpoint: Option<ResolvedEndpoint>,
        backend: &dyn Backend,
        cancel: &CancelToken,
    ) -> Result<TunnelInfo> {
        cancel.check()?;
        let (events, received) = channel();
        let id = backend.open_tunnel(spec, events)?;
        if cancel.is_cancelled() {
            let _ = backend.close_tunnel(id);
            return Err(Error::cancelled());
        }
        let snapshot = {
            let mut updates = self.forward_updates();
            updates.receivers.insert(id, received);
            self.sync_forward_updates(&mut updates, Some((id, endpoint)));
            self.snapshot()
        };
        let info = snapshot
            .tunnels
            .iter()
            .find(|tunnel| tunnel.id == id)
            .ok_or_else(|| Error::new(ErrorKind::SessionGone))?;
        if let TunnelState::Failed { error } = &info.state {
            backend.close_tunnel(id)?;
            self.sync_forwards();
            return Err(error.clone());
        }
        Ok(info.clone())
    }

    /// Call after a successful Plugin run, with the account context used to start it.
    pub fn open_plugin_forward(
        &self,
        account: AccountContext,
        outcome: &PluginRunOutcome,
        endpoint: &ResolvedEndpoint,
        bind: Option<ForwardBind>,
    ) -> Result<Submission<TunnelInfo>> {
        self.open_forward_with_endpoint(
            account,
            plugin_tunnel_spec(outcome, endpoint, bind.unwrap_or_default()),
            Some(endpoint.clone()),
        )
    }

    /// Close only the Forward. Its Runtime continues billing.
    pub fn close_forward(&self, id: TunnelId) -> Result<Submission<()>> {
        let state = self.clone();
        self.start_operation(
            "close_forward",
            id.0.to_string(),
            Access::Independent,
            move |backend, _| {
                backend.close_tunnel(id)?;
                state.sync_forwards();
                Ok(())
            },
        )
    }

    pub(super) async fn poll_forwards(self) {
        let mut timer = tokio::time::interval(FORWARD_TICK);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut shutdown = self.subscribe();
        loop {
            tokio::select! {
                _ = shutdown.wait_for(|snapshot| snapshot.shutting_down) => return,
                _ = timer.tick() => {}
            }
            if !self.snapshot().tunnels.is_empty() {
                let state = self.clone();
                let _ = spawn_blocking(move || state.sync_forwards()).await;
            }
        }
    }

    fn forward_updates(&self) -> MutexGuard<'_, ForwardUpdates> {
        self.0
            .forwards
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn sync_forwards(&self) {
        self.sync_forward_updates(&mut self.forward_updates(), None);
    }

    fn sync_forward_updates(
        &self,
        updates: &mut ForwardUpdates,
        opened: Option<(TunnelId, Option<ResolvedEndpoint>)>,
    ) {
        let mut events = Vec::new();
        if let Some((id, _)) = &opened {
            events.push(TunnelEvent::State {
                id: *id,
                state: TunnelState::Starting,
            });
        }
        updates.receivers.retain(|_, received| {
            loop {
                match received.try_recv() {
                    // Registering a Forward emits Starting. Removal emits Stopped for every backend.
                    Ok(TunnelEvent::State {
                        state: TunnelState::Starting | TunnelState::Stopped,
                        ..
                    }) => {}
                    Ok(event) => {
                        let failed = matches!(
                            &event,
                            TunnelEvent::State {
                                state: TunnelState::Failed { .. },
                                ..
                            }
                        );
                        events.push(event);
                        if failed {
                            return false;
                        }
                    }
                    Err(TryRecvError::Empty) => return true,
                    Err(TryRecvError::Disconnected) => return false,
                }
            }
        });
        let tunnels = self.backend().tunnels();
        updates
            .receivers
            .retain(|id, _| tunnels.iter().any(|tunnel| tunnel.id == *id));
        self.update(|snapshot| {
            if let Some((id, Some(endpoint))) = opened {
                snapshot.forward_endpoints.insert(id, endpoint);
            }
            snapshot
                .forward_endpoints
                .retain(|id, _| tunnels.iter().any(|tunnel| tunnel.id == *id));
            for removed in snapshot
                .tunnels
                .iter()
                .filter(|old| !tunnels.iter().any(|tunnel| tunnel.id == old.id))
            {
                events.push(TunnelEvent::State {
                    id: removed.id,
                    state: TunnelState::Stopped,
                });
            }
            let changed = snapshot.tunnels != tunnels;
            snapshot.tunnels = tunnels;
            changed
        });
        for event in events {
            let _ = updates.events.send(event);
        }
    }
}

pub(super) fn plugin_tunnel_spec(
    outcome: &PluginRunOutcome,
    endpoint: &ResolvedEndpoint,
    bind: ForwardBind,
) -> TunnelSpec {
    TunnelSpec {
        account: outcome.account.clone(),
        session: outcome.session.clone(),
        bind,
        local_port: endpoint.remote_port,
        remote_port: endpoint.remote_port,
        health_path: endpoint.health.clone(),
    }
}

#[cfg(test)]
mod tests {
    use colab_playground_core::mock::{MockBackend, MockConfig, MockScenario};
    use tokio::time::timeout;

    use super::*;

    #[tokio::test]
    async fn forward_relay_keeps_reconnect_and_health_transitions_in_order() {
        let (config, _) = MockConfig::headless(MockScenario::demo());
        let state = WebState::start(Arc::new(MockBackend::new(config)))
            .await
            .unwrap();
        let deadline = Duration::from_secs(5);
        let mut snapshots = state.subscribe();
        let snapshot = timeout(
            deadline,
            snapshots.wait_for(|snapshot| snapshot.runtimes.is_some()),
        )
        .await
        .unwrap()
        .unwrap()
        .clone();
        let account = snapshot.account.clone();
        let session = snapshot
            .runtimes
            .as_ref()
            .unwrap()
            .runtimes
            .iter()
            .find_map(|runtime| {
                (&runtime.id.account == account.active.as_ref().unwrap())
                    .then_some(runtime.id.name.as_ref())
                    .flatten()
            })
            .unwrap();
        let spec = TunnelSpec {
            account: account.active.clone().unwrap(),
            session: session.clone(),
            bind: Default::default(),
            local_port: 18000,
            remote_port: 8000,
            health_path: Some("/health".into()),
        };
        let Submission::Started { job, .. } = state.open_forward(account, spec).unwrap() else {
            panic!("expected a forward job");
        };
        let id = job.await.unwrap().unwrap().id;

        let mut first = state.subscribe_forwards();
        let mut second = state.subscribe_forwards();
        let (events, received) = channel();
        // Demo data connects immediately. Exercise the relay with real worker event shapes.
        state.forward_updates().receivers.insert(id, received);
        let transitions = [
            TunnelEvent::State {
                id,
                state: TunnelState::Reconnecting {
                    attempt: 1,
                    delay_secs: 1,
                },
            },
            TunnelEvent::State {
                id,
                state: TunnelState::Up,
            },
            TunnelEvent::Health { id, healthy: false },
            TunnelEvent::Health { id, healthy: true },
        ];
        for event in &transitions {
            events.send(event.clone()).unwrap();
        }
        for expected in transitions {
            assert_eq!(
                timeout(deadline, first.recv()).await.unwrap().unwrap(),
                expected
            );
            assert_eq!(
                timeout(deadline, second.recv()).await.unwrap().unwrap(),
                expected
            );
        }
        assert!(state.shutdown(deadline).await.completed);
    }
}
