# Building and running Colab Playground

How to build the app, choose its backend, try it with demo data, and find what it stores.
What the app does is in the [README](../README.md); why it is built this way is in
[DESIGN.md](DESIGN.md).

## Requirements

- Rust: the version in `rust-version` under `[workspace.package]` in
  [`Cargo.toml`](../Cargo.toml), or newer.
- Linux build: `libxkbcommon-x11-dev` and `libfontconfig-dev` (Ubuntu package names). Windows and
  macOS need nothing beyond the Rust toolchain.
- Real mode only: on Windows, WSL with a Linux distribution; inside it (or locally on macOS and
  Linux) `bash`, `ssh` for port forwarding, a keyring the CLI can use, and either the Colab CLI
  (`colab`, package `google-colab-cli`) or `uv` / `python3` to install it. Installing plugins from
  a Git URL uses the `git` of the computer running the app (Git for Windows on Windows).

## Build and run

```sh
cargo run -p colab-playground              # debug build: demo data (mock backend)
cargo run -p colab-playground -- --real    # debug build against the real Colab CLI
cargo run -p colab-playground --release    # release build: real Colab CLI by default
```

- Debug builds default to the **mock** backend, release builds to the **real** one.
- `--mock` or `--real` overrides the default; without a flag, `COLAB_PLAYGROUND_BACKEND=mock` or
  `=real` does. A flag wins over the variable. Both flags at once, or any other value of the
  variable, is an error (exit code 2).
- An unknown argument, a flag without its value, or a demo flag without `--mock` is an error too
  (exit code 2, with the usage line on standard error), so a mistyped flag never starts the other
  backend. Mock mode shows a **Demo data** badge, and Settings → About → Backend names the backend
  in use.

## Demo data

The mock backend is a deterministic simulation: it never runs WSL or the CLI, never touches a
Google account, and bills nothing. Its sign-in opens a placeholder Google URL; any code is accepted.

```sh
cargo run -p colab-playground -- --mock-scenario signed-out --mock-fail cli-missing
```

- `--mock-scenario demo` (default): two accounts; on the active one an A100 session, a T4 session
  and a runtime "opened in the browser"; one runtime on the second account.
  `single`: one account, nothing running. `signed-out`: first run, no account.
- `--mock-fail a,b,…` injects failures: `cli-missing`, `install-fails`, `keyring`, `usage-fails`,
  `login-invalid-code`, `login-unverified`, `not-entitled` (A100 and H100), `ssh-busy` (the first
  forward gets HTTP 429), `plugin-fails` (at the download stage), `watchdog-restart-fails` (setting
  an auto-stop again after cancelling it cannot put the stop back on the runtime).
- Both accept `--flag value` or `--flag=value` and apply only when the mock is selected (add
  `--mock` to a release build). A simulated A100 has 40 GB first and 80 GB on the next attempt:
  set a minimum GPU memory of 70 GB to watch the retry. Git plugin installs are not simulated.

Demo mode still reads and writes the normal settings file; set `COLAB_PLAYGROUND_CONFIG_DIR` to
another folder to keep experiments apart.

## Where things are stored

- **Settings:** `settings.json` in `<OS config dir>/colab-playground`: `%APPDATA%\colab-playground`
  on Windows, `~/Library/Application Support/colab-playground` on macOS,
  `${XDG_CONFIG_HOME:-~/.config}/colab-playground` on Linux. `COLAB_PLAYGROUND_CONFIG_DIR` replaces
  that folder (empty means unset). An unreadable file is moved aside as `settings.json.corrupt`.
  Settings → About shows the file and opens its folder.
- **Real-mode data** (not moved by that variable): `accounts.json` (no secrets), `ledger.json`
  (sessions the app started) and user plugins in `<OS data dir>/colab-playground` (the same folder
  as the settings on Windows and macOS, `${XDG_DATA_HOME:-~/.local/share}/colab-playground` on
  Linux). Per-account CLI state files are under `~/.local/share/colab-playground/accounts/` where
  the CLI runs (inside WSL on Windows; `$XDG_DATA_HOME` is honoured).
- **Sign-ins and the Hugging Face token:** the keyring where the CLI runs (inside WSL on Windows).
- **CLI location:** Settings → "Colab CLI location" picks the WSL distribution and, if detection
  fails, the path of `colab` (its Python interpreter is optional and otherwise found from it).
- **Logs** go to standard error; `RUST_LOG` replaces the default filter
  `warn,colab_playground=info`. Release builds on Windows open no console window.

- **SSH key:** port forwarding leaves `~/.ssh/config` alone and creates `~/.ssh/id_ed25519` only
  when there is neither an ed25519 nor an ECDSA key.

## Working with several accounts

Extending, forwarding and deploying need the runtime's account to be active; stopping works on
any saved account.
