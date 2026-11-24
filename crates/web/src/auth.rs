use std::{
    collections::HashMap,
    io::{self, Write as _},
    path::{Path, PathBuf},
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use colab_playground_core::InstanceLock;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio::{
    sync::{Mutex, watch},
    time::Instant,
};

use crate::platform;

pub const SESSION_LIFETIME: Duration = Duration::from_secs(15 * 60);
const KEY_DIR: &str = "web-auth";
const HASH_FILE: &str = "access-key.sha256";
type Hash = [u8; 32];

fn digest(secret: &str) -> Hash {
    Sha256::digest(secret.as_bytes()).into()
}

fn secret() -> io::Result<String> {
    let mut random = [0; 32];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

fn decode_hash(bytes: Vec<u8>) -> io::Result<Hash> {
    bytes.try_into().map_err(|_| {
        io::Error::other("Invalid Web access key hash. Run rotate-token to replace it.")
    })
}

pub struct KeyStore {
    file: PathBuf,
}

impl KeyStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join(KEY_DIR).join(HASH_FILE),
        }
    }

    fn dir(&self) -> &Path {
        self.file.parent().expect("key directory")
    }

    pub fn initialize(&self) -> Result<(), Box<dyn std::error::Error>> {
        match std::fs::read(&self.file).and_then(decode_hash) {
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let _write_lock = InstanceLock::acquire(self.dir())?;
                match std::fs::read(&self.file).and_then(decode_hash) {
                    Ok(_) => Ok(()),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        self.replace_in_terminal()
                    }
                    Err(error) => Err(error.into()),
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn rotate(&self) -> Result<(), Box<dyn std::error::Error>> {
        let _write_lock = InstanceLock::acquire(self.dir())?;
        self.replace_in_terminal()
    }

    fn replace_in_terminal(&self) -> Result<(), Box<dyn std::error::Error>> {
        let mut terminal = platform::key_terminal()?;
        let key = self.replace()?;
        writeln!(terminal, "Web access key (shown once): {key}")?;
        terminal.flush()?;
        Ok(())
    }

    fn replace(&self) -> io::Result<String> {
        let key = secret()?;
        platform::write_hash(&self.file, &digest(&key))?;
        Ok(key)
    }

    async fn hash(&self) -> io::Result<Hash> {
        tokio::fs::read(&self.file).await.and_then(decode_hash)
    }

    pub fn watch(&self) -> (Option<RecommendedWatcher>, watch::Receiver<()>) {
        let (sender, receiver) = watch::channel(());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if !matches!(event, Ok(event) if matches!(event.kind, EventKind::Access(_))) {
                sender.send_replace(());
            }
        })
        .and_then(|mut watcher| {
            // Rotation replaces the file, so the watch has to survive a change of inode.
            watcher.watch(self.dir(), RecursiveMode::NonRecursive)?;
            Ok(watcher)
        });
        (watcher.ok(), receiver)
    }
}

#[derive(Clone, Copy)]
pub struct Session {
    generation: Hash,
    pub expires: Instant,
}

#[derive(Default)]
struct Sessions {
    generation: Option<Hash>,
    expires: HashMap<Hash, Instant>,
}

pub struct Auth {
    keys: KeyStore,
    sessions: Mutex<Sessions>,
}

impl Auth {
    pub fn new(keys: KeyStore) -> Self {
        Self {
            keys,
            sessions: Mutex::default(),
        }
    }

    async fn refresh(&self, sessions: &mut Sessions) -> io::Result<Hash> {
        let hash = self.keys.hash().await?;
        if sessions.generation != Some(hash) {
            sessions.generation = Some(hash);
            sessions.expires.clear();
        }
        Ok(hash)
    }

    pub async fn login(&self, key: &str) -> io::Result<Option<String>> {
        let mut sessions = self.sessions.lock().await;
        let hash = self.refresh(&mut sessions).await?;
        if !bool::from(hash.ct_eq(&digest(key))) {
            return Ok(None);
        }
        let now = Instant::now();
        sessions.expires.retain(|_, expiry| *expiry > now);
        let token = secret()?;
        sessions
            .expires
            .insert(digest(&token), now + SESSION_LIFETIME);
        Ok(Some(token))
    }

    pub async fn authenticate(&self, token: &str) -> Option<Session> {
        let mut sessions = self.sessions.lock().await;
        let generation = self.refresh(&mut sessions).await.ok()?;
        let expires = *sessions.expires.get(&digest(token))?;
        (expires > Instant::now()).then_some(Session {
            generation,
            expires,
        })
    }

    pub async fn is_live(&self, session: Session) -> bool {
        session.expires > Instant::now() && self.keys.hash().await.ok() == Some(session.generation)
    }
}

#[cfg(test)]
mod tests;
