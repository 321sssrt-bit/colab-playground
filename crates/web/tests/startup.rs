use std::{
    io::{BufRead as _, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
};

fn web(dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_colab-playground-web"));
    command
        .env("COLAB_PLAYGROUND_CONFIG_DIR", dir)
        .env_remove("COLAB_PLAYGROUND_BACKEND")
        .stdin(Stdio::null());
    command
}

#[test]
fn invalid_cli_does_not_touch_the_data_directory() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        &["--mock", "--real"][..],
        &["--mock", "--unknown=private-input"],
    ] {
        let output = web(dir.path()).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(!String::from_utf8_lossy(&output.stderr).contains("private-input"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

struct Server(Child);

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn only_one_server_can_use_a_demo_data_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut command = web(dir.path());
    command.args(["--mock", "--no-open", "--port", "0"]);
    let auth = dir.path().join("web-auth");
    let hash = auth.join("access-key.sha256");

    let output = command.output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("interactive terminal"));
    assert!(!stderr.contains("shown once"));
    assert!(!hash.exists());

    std::fs::create_dir_all(&auth).unwrap();
    std::fs::write(&hash, [0_u8; 32]).unwrap();
    let mut server = Server(command.stderr(Stdio::piped()).spawn().unwrap());
    let mut stderr = BufReader::new(server.0.stderr.take().unwrap());
    let mut line = String::new();
    stderr.read_line(&mut line).unwrap();
    assert!(
        line.starts_with("Web Server listening on 127.0.0.1:"),
        "{line}"
    );
    assert!(line.ends_with(" (Demo data)\n"), "{line}");

    let duplicate = command.output().unwrap();
    assert_eq!(duplicate.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("Close it and try again."));

    let rotation = web(dir.path())
        .args(["rotate-token", "--mock"])
        .output()
        .unwrap();
    assert_eq!(rotation.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&rotation.stderr).contains("interactive terminal"));
    assert_eq!(std::fs::read(hash).unwrap(), [0_u8; 32]);
}
