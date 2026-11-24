use std::{
    io::{self, BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
};

use colab_playground_core::{ErrorKind, InstanceLock};

const LOCK_DIR_ENV: &str = "CPG_TEST_INSTANCE_LOCK_DIR";
const READY: &str = "instance lock acquired";

fn hold_instance_lock(dir: &Path) {
    let _lock = InstanceLock::acquire(dir).unwrap();
    println!("{READY}");
    io::stdout().flush().unwrap();
    io::copy(&mut io::stdin(), &mut io::sink()).unwrap();
}

#[test]
fn processes_contend_until_the_holder_exits() {
    if let Some(dir) = std::env::var_os(LOCK_DIR_ENV) {
        hold_instance_lock(Path::new(&dir));
        return;
    }

    let temp = tempfile::tempdir().unwrap();
    let data_dir = temp.path().join("data");
    let other_dir = temp.path().join("other");
    for force_exit in [false, true] {
        let mut holder = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "processes_contend_until_the_holder_exits",
                "--nocapture",
            ])
            .env(LOCK_DIR_ENV, &data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(holder.stdout.take().unwrap());
        assert!(
            (&mut output)
                .lines()
                .map_while(Result::ok)
                .any(|line| line == READY),
            "child exited before acquiring the lock"
        );
        println!("{READY} in child process");

        let conflict = InstanceLock::acquire(&data_dir).unwrap_err();
        assert_eq!(conflict.kind, ErrorKind::DataDirInUse);
        assert_eq!(conflict.param("path"), data_dir.to_str());
        println!("second process refused with {}", conflict.kind);

        let _other = InstanceLock::acquire(&other_dir).unwrap();
        println!("independent directory locked while the child holds its lock");

        if force_exit {
            holder.kill().unwrap();
        }
        // wait() closes the child's stdin, allowing it to return normally.
        assert_eq!(holder.wait().unwrap().success(), !force_exit);
        let _lock = InstanceLock::acquire(&data_dir).unwrap();
        println!("second process acquired the lock after child exit (forced={force_exit})");
    }
}

#[test]
fn an_unusable_directory_reports_io_failure() {
    let temp = tempfile::tempdir().unwrap();
    let file = tempfile::NamedTempFile::new_in(temp.path()).unwrap();
    let error = InstanceLock::acquire(file.path()).unwrap_err();
    assert_eq!(error.kind, ErrorKind::Io);
    assert_eq!(error.param("path"), file.path().to_str());
}
