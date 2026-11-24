use std::{
    collections::VecDeque,
    path::{Component, Path},
    sync::mpsc,
};

use colab_playground_core::{
    accounts::nonce,
    backend::RunTarget,
    plugins::{
        InputKind, InputValue, Manifest, PluginInfo, PluginOrigin, PluginPreview, discard_preview,
        validate_git_url,
    },
};
use serde_json::Value;

use super::*;

const PREVIEW_LIMIT: usize = 16;
const FINISHED_RUN_LIMIT: usize = 8;
const EVENT_LIMIT: usize = 256;
const EVENT_BYTES: usize = 256 * 1024;

#[derive(Default)]
pub(super) struct Plugins {
    previews: Mutex<VecDeque<(String, StagedPreview)>>,
    runs: Mutex<BTreeMap<u64, Arc<PluginRun>>>,
}

struct StagedPreview(PluginPreview);

pub struct Preview {
    pub id: String,
    pub manifest: Manifest,
    pub script_bytes: u64,
    pub replaces_version: Option<String>,
}

impl Drop for StagedPreview {
    fn drop(&mut self) {
        discard_preview(&self.0);
    }
}

#[derive(Clone, Serialize)]
pub struct RunEndpoint {
    pub endpoint: ResolvedEndpoint,
    pub forward_id: Option<TunnelId>,
    pub error: Option<ErrorKind>,
}

#[derive(Clone)]
pub enum RunEvent {
    Progress {
        kind: &'static str,
        data: Value,
    },
    Finished {
        outcome: Value,
        endpoints: Vec<RunEndpoint>,
        error: Option<ErrorKind>,
    },
}

pub struct PluginRun {
    journal: Mutex<Journal>,
    changes: watch::Sender<()>,
}

#[derive(Default)]
struct Journal {
    first: usize,
    bytes: usize,
    entries: VecDeque<(RunEvent, usize)>,
    finished: bool,
}

impl PluginRun {
    fn new() -> Self {
        Self {
            journal: Mutex::default(),
            changes: watch::channel(()).0,
        }
    }

    fn push(&self, event: RunEvent, size: usize) {
        let mut journal = lock(&self.journal);
        journal.finished = matches!(event, RunEvent::Finished { .. });
        journal.entries.push_back((event, size));
        journal.bytes += size;
        while journal.entries.len() > EVENT_LIMIT
            || (journal.entries.len() > 1 && journal.bytes > EVENT_BYTES)
        {
            let (_, size) = journal.entries.pop_front().expect("journal entry");
            journal.first += 1;
            journal.bytes -= size;
        }
        self.changes.send_replace(());
    }

    pub fn is_finished(&self) -> bool {
        lock(&self.journal).finished
    }

    pub fn subscribe(self: &Arc<Self>) -> RunEvents {
        RunEvents {
            run: self.clone(),
            changes: self.changes.subscribe(),
            next: 0,
        }
    }
}

pub struct RunEvents {
    run: Arc<PluginRun>,
    changes: watch::Receiver<()>,
    next: usize,
}

impl RunEvents {
    pub async fn next(&mut self) -> Option<RunEvent> {
        loop {
            self.changes.borrow_and_update();
            {
                let journal = lock(&self.run.journal);
                if self.next < journal.first {
                    self.next = journal.first;
                    return Some(RunEvent::Progress {
                        kind: "history_skipped",
                        data: Value::Null,
                    });
                }
                if let Some((event, _)) = journal.entries.get(self.next - journal.first) {
                    self.next += 1;
                    return Some(event.clone());
                }
                if journal.finished {
                    return None;
                }
            }
            self.changes.changed().await.ok()?;
        }
    }
}

impl WebState {
    pub async fn preview_plugin(&self, origin: PluginOrigin) -> Result<Preview> {
        let state = self.clone();
        self.backend_job(Slot::Shared, move |backend, cancel| {
            let preview = match origin {
                PluginOrigin::Folder { path } => {
                    let path = Path::new(&path);
                    if path.as_os_str().is_empty()
                        || path.components().any(|part| part == Component::ParentDir)
                    {
                        return Err(Error::invalid("path", "expected a plugin directory"));
                    }
                    backend.inspect_plugin_folder(path)?
                }
                PluginOrigin::Git { url } => {
                    validate_git_url(&url).map_err(without_detail)?;
                    backend
                        .inspect_plugin_git(&url, cancel)
                        .map_err(without_detail)?
                }
            };
            let staged = StagedPreview(preview);
            cancel.check()?;
            let id = nonce();
            let mut previews = lock(&state.0.plugins.previews);
            if previews.len() == PREVIEW_LIMIT {
                previews.pop_front();
            }
            let preview = Preview {
                id: id.clone(),
                manifest: staged.0.manifest.clone(),
                script_bytes: staged.0.script_bytes,
                replaces_version: staged.0.replaces_version.clone(),
            };
            previews.push_back((id, staged));
            Ok(preview)
        })
        .await
    }

    pub fn install_plugin(&self, id: String) -> Result<Submission<PluginInfo>> {
        let state = self.clone();
        self.start_operation(
            "install_plugin",
            String::new(),
            Access::HostWrite,
            move |backend, cancel| {
                let staged = state.take_plugin_preview(&id)?;
                cancel.commit()?;
                let installed = backend.install_plugin(&staged.0);
                state.invalidate_previews(&staged.0.manifest.id);
                installed
            },
        )
    }

    pub async fn discard_plugin_preview(&self, id: String) -> Result<()> {
        let state = self.clone();
        self.run_backend(move |_, _| {
            state.take_plugin_preview(&id)?;
            Ok(())
        })
        .await
    }

    fn take_plugin_preview(&self, id: &str) -> Result<StagedPreview> {
        let mut previews = lock(&self.0.plugins.previews);
        let index = previews
            .iter()
            .position(|(key, _)| key == id)
            .ok_or_else(|| Error::new(ErrorKind::PluginNotFound))?;
        Ok(previews.remove(index).expect("preview index").1)
    }

    pub fn remove_plugin(&self, id: String) -> Result<Submission<()>> {
        let state = self.clone();
        self.start_operation(
            "remove_plugin",
            id.clone(),
            Access::HostWrite,
            move |backend, cancel| {
                cancel.commit()?;
                backend.remove_plugin(&id)?;
                state.invalidate_previews(&id);
                Ok(())
            },
        )
    }

    fn invalidate_previews(&self, plugin: &str) {
        lock(&self.0.plugins.previews).retain(|(_, staged)| staged.0.manifest.id != plugin);
    }

    pub(super) fn discard_plugin_previews(&self) {
        lock(&self.0.plugins.previews).clear();
    }

    pub fn plugin_runs(&self) -> Vec<(u64, bool)> {
        lock(&self.0.plugins.runs)
            .iter()
            .rev()
            .map(|(&id, run)| (id, run.is_finished()))
            .collect()
    }

    pub fn plugin_run(&self, id: u64) -> Option<Arc<PluginRun>> {
        lock(&self.0.plugins.runs).get(&id).cloned()
    }

    pub fn cancel_plugin_run(&self, id: u64) -> bool {
        self.plugin_run(id).is_some() && self.cancel(id)
    }

    pub fn start_plugin_run(
        &self,
        account: AccountContext,
        spec: PluginRunSpec,
        existing: Option<RuntimeRef>,
    ) -> Result<u64> {
        let run = Arc::new(PluginRun::new());
        let worker = run.clone();
        let state = self.clone();
        let submission = {
            let mut runs = lock(&self.0.plugins.runs);
            let submission = self.start_plugin_job(
                account,
                spec,
                existing,
                move |backend, spec, cancel| {
                    let secrets = run_secrets(backend, &spec)?;
                    let (send, receive) = mpsc::channel();
                    let outcome = std::thread::scope(|scope| {
                        scope.spawn(|| {
                            for event in receive {
                                worker.progress(event, &secrets);
                            }
                        });
                        backend.run_plugin(spec, send, cancel)
                    })?;
                    Ok((outcome, secrets))
                },
                move |backend, cancel, (outcome, secrets)| {
                    let endpoints = outcome
                        .endpoints
                        .iter()
                        .map(|endpoint| {
                            let spec = forwards::plugin_tunnel_spec(
                                &outcome,
                                endpoint,
                                Default::default(),
                            );
                            let forward =
                                state.open_tunnel(spec, Some(endpoint.clone()), backend, cancel);
                            RunEndpoint {
                                endpoint: endpoint.clone(),
                                forward_id: forward.as_ref().ok().map(|info| info.id),
                                error: forward.err().map(|error| error.kind),
                            }
                        })
                        .collect();
                    let mut outcome = serde_json::json!({
                        "session": outcome.session,
                        "account": outcome.account,
                        "run_id": outcome.run_id,
                        "status": outcome.status,
                    });
                    redact_status(&mut outcome["status"], &secrets);
                    for key in ["session", "account", "run_id"] {
                        redact_values(&mut outcome[key], &secrets, false);
                    }
                    Ok(RunEvent::Finished {
                        outcome,
                        endpoints,
                        error: None,
                    })
                },
            )?;
            if let Submission::Started { id, .. } = &submission {
                runs.insert(*id, run.clone());
            }
            submission
        };
        let (id, job) = match submission {
            Submission::Started { id, job } => (id, job),
            Submission::AlreadyRunning { id } => return Ok(id),
        };
        let state = self.clone();
        tokio::spawn(async move {
            let finished = job
                .await
                .unwrap_or_else(|_| Err(Error::new(ErrorKind::Other)));
            run.push(
                finished.unwrap_or_else(|error| RunEvent::Finished {
                    outcome: Value::Null,
                    endpoints: Vec::new(),
                    error: Some(error.kind),
                }),
                0,
            );
            let mut runs = lock(&state.0.plugins.runs);
            let expired: Vec<_> = runs
                .iter()
                .rev()
                .filter_map(|(&id, run)| run.is_finished().then_some(id))
                .skip(FINISHED_RUN_LIMIT)
                .collect();
            for id in expired {
                runs.remove(&id);
            }
        });
        Ok(id)
    }

    pub(super) fn start_plugin_job<T: Send + 'static, R: Send + 'static>(
        &self,
        account: AccountContext,
        spec: PluginRunSpec,
        existing: Option<RuntimeRef>,
        run: impl FnOnce(&dyn Backend, PluginRunSpec, &CancelToken) -> Result<T> + Send + 'static,
        ready: impl FnOnce(&dyn Backend, &CancelToken, T) -> Result<R> + Send + 'static,
    ) -> Result<Submission<R>> {
        let active = required_account(&account)?;
        let (session, allocating) = match (&spec.target, &existing) {
            (RunTarget::Existing { name }, Some(target))
                if target.account == active && target.name.as_ref() == Some(name) =>
            {
                (name.clone(), false)
            }
            (RunTarget::Provision(provision), None) => {
                provision.validate()?;
                (provision.name.clone(), true)
            }
            _ => {
                return Err(Error::invalid(
                    "target",
                    "runtime precondition does not match",
                ));
            }
        };
        let stop_on_failure = spec.stop_on_failure;
        self.start_job(
            Operation::PluginRun {
                plugin: spec.plugin.clone(),
                session: session.clone(),
            },
            Access::Account(account),
            allocating,
            move |_, backend, cancel| {
                let run = || run(backend, spec, cancel);
                let outcome = if let Some(target) = existing {
                    let view = list_account(backend, cancel, &target.account)?;
                    if !view.runtimes.iter().any(|runtime| runtime.id == target) {
                        return Err(Error::new(ErrorKind::SessionGone));
                    }
                    let outcome = run()?;
                    cancel.commit()?;
                    outcome
                } else {
                    run_allocation(backend, cancel, &active, &session, stop_on_failure, run)?
                };
                // Account changes must remain excluded until auto-Forwards belong to the run.
                ready(backend, cancel, outcome)
            },
        )
    }
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|error| error.into_inner())
}

fn without_detail(error: Error) -> Error {
    Error::new(error.kind)
}

fn run_secrets(backend: &dyn Backend, spec: &PluginRunSpec) -> Result<Vec<String>> {
    let plugin = backend
        .plugins()
        .into_iter()
        .find(|plugin| plugin.manifest.id == spec.plugin)
        .ok_or_else(|| Error::new(ErrorKind::PluginNotFound))?;
    let mut secrets: Vec<_> = plugin
        .manifest
        .inputs
        .iter()
        .filter(|input| input.kind == InputKind::Secret)
        .filter_map(|input| match spec.inputs.get(&input.id) {
            Some(InputValue::Text(value)) if !value.is_empty() => Some(value.clone()),
            _ => None,
        })
        .collect();
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    Ok(secrets)
}

impl PluginRun {
    fn progress(&self, event: PluginRunEvent, secrets: &[String]) {
        let kind = match &event {
            PluginRunEvent::Provision(_) => "provision",
            PluginRunEvent::Launched { .. } => "launched",
            PluginRunEvent::Status(_) => "status",
            PluginRunEvent::Log { .. } => "log",
            PluginRunEvent::LogSkipped { .. } => "log_skipped",
        };
        let data = match event {
            PluginRunEvent::Provision(provision) => serde_json::to_value(provision),
            event => serde_json::to_value(event),
        };
        let Ok(mut data) = data else {
            return;
        };
        let event = data["event"].take();
        redact_status(&mut data, secrets);
        data["event"] = event;
        let size = data.to_string().len();
        self.push(RunEvent::Progress { kind, data }, size);
    }
}

fn redact_status(data: &mut Value, secrets: &[String]) {
    if secrets.is_empty() {
        return;
    }
    let outputs = data.get_mut("outputs").map(Value::take);
    redact_values(data, secrets, false);
    if let Some(mut outputs) = outputs {
        redact_values(&mut outputs, secrets, true);
        data["outputs"] = outputs;
    }
}

fn redact_values(data: &mut Value, secrets: &[String], redact_keys: bool) {
    match data {
        Value::String(value) => *value = redact_text(value, secrets),
        Value::Array(items) => {
            for item in items {
                redact_values(item, secrets, redact_keys);
            }
        }
        Value::Object(items) if redact_keys => {
            *items = std::mem::take(items)
                .into_iter()
                .map(|(key, mut value)| {
                    redact_values(&mut value, secrets, true);
                    (redact_text(&key, secrets), value)
                })
                .collect();
        }
        Value::Object(items) => {
            for item in items.values_mut() {
                redact_values(item, secrets, false);
            }
        }
        _ => {}
    }
}

fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut text = text.to_owned();
    for secret in secrets {
        text = text.replace(secret, "***");
    }
    if secrets.iter().any(|secret| text.contains(secret)) {
        text.clear();
    }
    text
}
