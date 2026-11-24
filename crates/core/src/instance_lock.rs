use std::{
    fs::{self, File, OpenOptions, TryLockError},
    path::Path,
};

use crate::{Error, ErrorKind, Result};

/// Keep this guard alive while the process uses the directory. Closing the file
/// releases the OS lock, including when the process is terminated.
#[derive(Debug)]
#[must_use = "dropping the guard releases the directory lock"]
pub struct InstanceLock {
    _file: File,
}

impl InstanceLock {
    /// Creates `dir` if needed and attempts to lock it without waiting.
    pub fn acquire(dir: &Path) -> Result<Self> {
        let io_error = |error| Error::from(error).with("path", dir.display());
        fs::create_dir_all(dir).map_err(io_error)?;

        // Keep the file in place so competing processes always lock the same file.
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join("instance.lock"))
            .map_err(io_error)?;
        match file.try_lock() {
            Ok(()) => Ok(Self { _file: file }),
            Err(TryLockError::WouldBlock) => {
                Err(Error::new(ErrorKind::DataDirInUse).with("path", dir.display()))
            }
            Err(TryLockError::Error(error)) => Err(io_error(error)),
        }
    }
}
