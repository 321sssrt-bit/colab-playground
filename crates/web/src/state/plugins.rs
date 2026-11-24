use std::{
    collections::{HashSet, VecDeque},
    path::{Component, Path},
    sync::mpsc,
};

use colab_playground_core::{
    accounts::nonce,
    backend::RunTarget,
    plugins::{
        InputKind, InputValue, Manifest, PluginInfo, PluginOrigin, PluginPreview, discard_preview,
        resolve_endpoints, resolve_inputs, validate_git_url,
    },
    provision::ProvisionEvent,
    vm::RunStatus,
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

#[derive(Clone)]
pub struct RunEndpoint {
    pub endpoint: ResolvedEndpoint,
    pub forward_id: Option<TunnelId>,
    pub error: Option<Error>,
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
        error: Option<Error>,
    },
}

#[derive(Clone, Serialize)]
pub struct RunMetadata {
    plugin: String,
    account: AccountId,
    session: String,
    provisions: bool,
}

#[derive(Serialize)]
pub struct RunSummary {
    pub id: u64,
    #[serde(flatten)]
    metadata: RunMetadata,
    finished: bool,
}

pub struct PluginRun {
    metadata: RunMetadata,
    journal: Mutex<Journal>,
    changes: watch::Sender<()>,
}

#[derive(Default)]
struct Journal {
    first: usize,
    bytes: usize,
    entries: VecDeque<(RunEvent, usize)>,
    checkpoints: BTreeMap<&'static str, (usize, RunEvent)>,
    finished: bool,
}

impl PluginRun {
    fn new(metadata: RunMetadata) -> Self {
        Self {
            metadata,
            journal: Mutex::default(),
            changes: watch::channel(()).0,
        }
    }

    fn push(&self, event: RunEvent, size: usize) {
        let mut journal = lock(&self.journal);
        journal.finished = matches!(event, RunEvent::Finished { .. });
        if let RunEvent::Progress {
            kind: kind @ ("provision" | "launched" | "status"),
            ..
        } = &event
        {
            let index = journal.first + journal.entries.len();
            journal.checkpoints.insert(kind, (index, event.clone()));
        }
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

    fn is_finished(&self) -> bool {
        lock(&self.journal).finished
    }

    pub fn metadata(&self) -> &RunMetadata {
        &self.metadata
    }

    pub fn subscribe(self: &Arc<Self>) -> RunEvents {
        RunEvents {
            run: self.clone(),
            changes: self.changes.subscribe(),
            next: 0,
            recovery: VecDeque::new(),
        }
    }
}

pub struct RunEvents {
    run: Arc<PluginRun>,
    changes: watch::Receiver<()>,
    next: usize,
    recovery: VecDeque<RunEvent>,
}

impl RunEvents {
    pub async fn next(&mut self) -> Option<RunEvent> {
        if let Some(event) = self.recovery.pop_front() {
            return Some(event);
        }
        loop {
            self.changes.borrow_and_update();
            {
                let journal = lock(&self.run.journal);
                if self.next < journal.first {
                    let mut checkpoints: Vec<_> = journal
                        .checkpoints
                        .values()
                        .filter(|(index, _)| (self.next..journal.first).contains(index))
                        .collect();
                    checkpoints.sort_by_key(|(index, _)| *index);
                    self.recovery
                        .extend(checkpoints.into_iter().map(|(_, event)| event.clone()));
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
        self.run_backend(move |backend, cancel| {
            let preview = match origin {
                PluginOrigin::Folder { path } => {
                    let path = Path::new(path.trim());
                    if path.as_os_str().is_empty()
                        || path.components().any(|part| part == Component::ParentDir)
                    {
                        return Err(Error::invalid("path", "expected a plugin directory"));
                    }
                    backend.inspect_plugin_folder(path)?
                }
                PluginOrigin::Git { url } => {
                    let url = url.trim();
                    validate_git_url(url).map_err(safe_git_error)?;
                    backend
                        .inspect_plugin_git(url, cancel)
                        .map_err(safe_git_error)?
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
                replaces_version: backend
                    .plugins()
                    .into_iter()
                    .find(|p| p.manifest.id == staged.0.manifest.id)
                    .map(|p| p.manifest.version),
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
            id.clone(),
            Access::Independent,
            move |backend, cancel| {
                let mut previews = lock(&state.0.plugins.previews);
                let index = preview_index(&previews, &id)?;
                let (_, staged) = &previews[index];
                state.check_plugin_idle(&staged.0.manifest.id)?;
                cancel.commit()?;
                let (_, staged) = previews.remove(index).expect("preview index");
                let installed = backend.install_plugin(&staged.0);
                previews.retain(|(_, other)| other.0.manifest.id != staged.0.manifest.id);
                installed
            },
        )
    }

    pub async fn discard_plugin_preview(&self, id: String) -> Result<()> {
        let state = self.clone();
        self.run_backend(move |_, _| {
            let mut previews = lock(&state.0.plugins.previews);
            let index = preview_index(&previews, &id)?;
            previews.remove(index);
            Ok(())
        })
        .await
    }

    pub fn enable_plugin(&self, id: String, enabled: bool) -> Result<Submission<()>> {
        let state = self.clone();
        self.start_operation(
            "set_plugin_enabled",
            id.clone(),
            Access::Independent,
            move |backend, cancel| {
                let _catalog = lock(&state.0.plugins.previews);
                state.check_plugin_idle(&id)?;
                cancel.commit()?;
                backend.set_plugin_enabled(&id, enabled)
            },
        )
    }

    pub fn remove_plugin(&self, id: String) -> Result<Submission<()>> {
        let state = self.clone();
        self.start_operation(
            "remove_plugin",
            id.clone(),
            Access::Independent,
            move |backend, cancel| {
                let mut previews = lock(&state.0.plugins.previews);
                state.check_plugin_idle(&id)?;
                cancel.commit()?;
                backend.remove_plugin(&id)?;
                previews.retain(|(_, staged)| staged.0.manifest.id != id);
                Ok(())
            },
        )
    }

    fn check_plugin_idle(&self, id: &str) -> Result<()> {
        // Core selects the manifest when the worker enters it. Keep the accepted form and
        // its secret schema valid until that run finishes, without blocking other plugins.
        if self.snapshot().operations.iter().any(|operation| {
            matches!(&operation.operation, Operation::PluginRun { plugin, .. } if plugin == id)
        }) {
            return Err(Error::new(ErrorKind::Busy));
        }
        Ok(())
    }

    pub(super) fn discard_plugin_previews(&self) {
        lock(&self.0.plugins.previews).clear();
    }

    pub fn plugin_runs(&self) -> Vec<RunSummary> {
        lock(&self.0.plugins.runs)
            .iter()
            .rev()
            .map(|(&id, run)| RunSummary {
                id,
                metadata: run.metadata.clone(),
                finished: run.is_finished(),
            })
            .collect()
    }

    pub fn plugin_run(&self, id: u64) -> Option<Arc<PluginRun>> {
        lock(&self.0.plugins.runs).get(&id).cloned()
    }

    pub fn cancel_plugin_run(&self, id: u64) -> bool {
        self.plugin_run(id).is_some() && self.cancel(id)
    }

    pub async fn start_plugin_run(
        &self,
        account: AccountContext,
        spec: PluginRunSpec,
        existing: Option<RuntimeRef>,
    ) -> Result<u64> {
        let state = self.clone();
        self.run_backend(move |backend, _| {
            let _catalog = lock(&state.0.plugins.previews);
            let plugin = backend
                .plugins()
                .into_iter()
                .find(|plugin| plugin.manifest.id == spec.plugin)
                .ok_or_else(|| {
                    Error::new(ErrorKind::PluginNotFound).with("plugin", &spec.plugin)
                })?;
            if !plugin.enabled {
                return Err(
                    Error::invalid("plugin", "the plugin is disabled").with("plugin", &spec.plugin)
                );
            }
            let redactor = Arc::new(Redactor::new(&plugin.manifest, &spec));
            let inputs = resolve_inputs(&plugin.manifest, &spec.inputs)
                .map_err(|error| redactor.error(error))?;
            resolve_endpoints(&plugin.manifest, &inputs.values)
                .map_err(|error| redactor.error(error))?;
            state.launch_plugin_run(account, spec, existing, redactor)
        })
        .await
    }

    fn launch_plugin_run(
        &self,
        account: AccountContext,
        spec: PluginRunSpec,
        existing: Option<RuntimeRef>,
        redactor: Arc<Redactor>,
    ) -> Result<u64> {
        let run = Arc::new(PluginRun::new(RunMetadata {
            plugin: spec.plugin.clone(),
            account: required_account(&account)?,
            session: match &spec.target {
                RunTarget::Existing { name } => name.clone(),
                RunTarget::Provision(provision) => provision.name.clone(),
            },
            provisions: matches!(spec.target, RunTarget::Provision(_)),
        }));
        let worker = run.clone();
        let progress_redactor = redactor.clone();
        let outcome_redactor = redactor.clone();
        let state = self.clone();
        let submission = {
            let mut runs = lock(&self.0.plugins.runs);
            let submission = self.start_plugin_job(
                account,
                spec,
                existing,
                move |backend, spec, cancel| {
                    let (send, receive) = mpsc::channel();
                    std::thread::scope(|scope| {
                        scope.spawn(|| {
                            for event in receive {
                                worker.progress(event, &progress_redactor);
                            }
                        });
                        backend.run_plugin(spec, send, cancel)
                    })
                },
                move |backend, cancel, mut outcome| {
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
                                error: forward.err().map(|error| outcome_redactor.error(error)),
                            }
                        })
                        .collect();
                    outcome_redactor.status(&mut outcome.status);
                    let outcome = serde_json::json!({
                        "session": outcome.session,
                        "account": outcome.account,
                        "run_id": outcome.run_id,
                        "status": outcome.status,
                    });
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
                    error: Some(redactor.error(error)),
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

fn preview_index(previews: &VecDeque<(String, StagedPreview)>, id: &str) -> Result<usize> {
    previews
        .iter()
        .position(|(key, _)| key == id)
        .ok_or_else(|| Error::new(ErrorKind::PluginNotFound))
}

fn safe_git_error(mut error: Error) -> Error {
    error.params.remove("url");
    error.params.remove("value");
    error.detail.clear();
    error
}

struct Redactor {
    secrets: Vec<String>,
    mask: String,
}

impl Redactor {
    fn new(manifest: &Manifest, spec: &PluginRunSpec) -> Self {
        let mut secrets: Vec<_> = manifest
            .inputs
            .iter()
            .filter(|input| input.kind == InputKind::Secret)
            .filter_map(|input| match spec.inputs.get(&input.id) {
                Some(InputValue::Text(value)) if !value.trim().is_empty() => Some(value.clone()),
                _ => None,
            })
            .collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        // The marker must itself be safe, and keep the two sides of a match from forming a secret.
        let mask = if secrets.iter().all(|secret| !secret.contains('*')) {
            "***".into()
        } else {
            let used: HashSet<_> = secrets.iter().flat_map(|secret| secret.chars()).collect();
            (0x2588..=0x10ffff)
                .filter_map(char::from_u32)
                .find(|marker| !used.contains(marker))
                .expect("the request cannot contain every marker")
                .to_string()
        };
        Self { secrets, mask }
    }

    fn text(&self, mut input: &str) -> String {
        if self.secrets.is_empty() {
            return input.to_owned();
        }
        let mut output = String::with_capacity(input.len());
        while let Some(first) = input.chars().next() {
            if let Some(secret) = self
                .secrets
                .iter()
                .find(|secret| input.starts_with(secret.as_str()))
            {
                output.push_str(&self.mask);
                input = &input[secret.len()..];
            } else {
                output.push(first);
                input = &input[first.len_utf8()..];
            }
        }
        output
    }

    fn error(&self, mut error: Error) -> Error {
        error.detail.clear();
        for value in error.params.values_mut() {
            *value = self.text(value);
        }
        error
    }

    fn status(&self, status: &mut RunStatus) {
        if self.secrets.is_empty() {
            return;
        }
        for value in [&mut status.stage, &mut status.message]
            .into_iter()
            .flatten()
        {
            *value = self.text(value);
        }
        self.object(&mut status.outputs);
    }

    fn object(&self, items: &mut serde_json::Map<String, Value>) {
        *items = std::mem::take(items)
            .into_iter()
            .map(|(key, mut value)| {
                self.value(&mut value);
                (self.text(&key), value)
            })
            .collect();
    }

    fn value(&self, value: &mut Value) {
        match value {
            Value::String(text) => *text = self.text(text),
            Value::Array(items) => items.iter_mut().for_each(|item| self.value(item)),
            Value::Object(items) => self.object(items),
            _ => {}
        }
    }
}

impl PluginRun {
    fn progress(&self, mut event: PluginRunEvent, redactor: &Redactor) {
        let kind = match &mut event {
            PluginRunEvent::Provision(provision) => {
                match provision {
                    ProvisionEvent::AllocationFailed { error, .. }
                    | ProvisionEvent::WatchdogFailed { error }
                    | ProvisionEvent::Failed { error } => *error = redactor.error(error.clone()),
                    _ => {}
                }
                "provision"
            }
            PluginRunEvent::Launched { .. } => "launched",
            PluginRunEvent::Status(status) => {
                redactor.status(status);
                "status"
            }
            PluginRunEvent::Log { lines } => {
                if !redactor.secrets.is_empty() {
                    *lines = redactor
                        .text(&lines.join("\n"))
                        .split('\n')
                        .map(str::to_owned)
                        .collect();
                }
                "log"
            }
            PluginRunEvent::LogSkipped { path } => {
                *path = redactor.text(path);
                "log_skipped"
            }
        };
        let data = match event {
            PluginRunEvent::Provision(provision) => serde_json::to_value(provision),
            event => serde_json::to_value(event),
        };
        let Ok(data) = data else {
            return;
        };
        let size = data.to_string().len();
        self.push(RunEvent::Progress { kind, data }, size);
    }
}

#[cfg(test)]
mod tests {
    use colab_playground_core::{plugins::bundled, vm::RunState};

    use super::*;

    #[test]
    fn redaction_preserves_protocol_fields_and_text_around_matches() {
        let manifest = Manifest::parse(bundled()[0].0).unwrap();
        let mut spec = colab_playground_core::backend::run_template(
            &PluginInfo {
                manifest: manifest.clone(),
                source: colab_playground_core::plugins::PluginSource::Bundled,
                enabled: true,
            },
            &Default::default(),
            &[],
        );
        spec.inputs
            .insert("api_key".into(), InputValue::Text(" ".into()));
        let redactor = Redactor::new(&manifest, &spec);
        assert_eq!(redactor.text("hello world"), "hello world");

        spec.inputs
            .insert("api_key".into(), InputValue::Text("*".into()));
        let redactor = Redactor::new(&manifest, &spec);
        assert_eq!(redactor.text("before*after"), "before█after");

        spec.inputs
            .insert("api_key".into(), InputValue::Text("r".into()));
        let redactor = Redactor::new(&manifest, &spec);
        let mut status = RunStatus {
            state: RunState::Running,
            message: Some("credential=r".into()),
            progress: Some(0.25),
            ..Default::default()
        };
        redactor.status(&mut status);
        assert_eq!(status.state, RunState::Running);
        assert_eq!(status.progress, Some(0.25));
        assert_eq!(status.message.as_deref(), Some("c***edential=***"));
    }

    #[tokio::test]
    async fn replay_recovers_latest_status_after_log_history_rolls_over() {
        let run = Arc::new(PluginRun::new(RunMetadata {
            plugin: "llama-cpp".into(),
            account: AccountId::generate(),
            session: "sample".into(),
            provisions: false,
        }));
        for kind in ["launched", "status"] {
            run.push(
                RunEvent::Progress {
                    kind,
                    data: Value::Null,
                },
                1,
            );
        }
        for _ in 0..EVENT_LIMIT {
            run.push(
                RunEvent::Progress {
                    kind: "log",
                    data: Value::Null,
                },
                1,
            );
        }
        let mut replay = run.subscribe();
        for expected in ["history_skipped", "launched", "status", "log"] {
            assert!(
                matches!(replay.next().await, Some(RunEvent::Progress { kind, .. }) if kind == expected)
            );
        }
    }
}
