# Building and running Colab Playground

How to build the app, choose its backend, try it with demo data, and find what it stores.
What the app does is in the [README](../README.md); the principles and rules behind it are in
[DESIGN.md](DESIGN.md).

## Install a release

Download the file for your computer from the
[latest release](https://github.com/scarletkc/colab-playground/releases/latest); there is no
installer. Later versions install from inside the app (see [Updates](#updates)); settings and data
stay where they are (see [Where things are stored](#where-things-are-stored)).

- **Windows x64:** `colab-playground-x86_64-pc-windows-msvc.exe` is the whole app; run it. It is
  not code-signed, so SmartScreen may say "Windows protected your PC": click **More info**, then
  **Run anyway**.
- **Linux x64:** unpack `colab-playground-x86_64-unknown-linux-gnu.tar.gz` (`tar -xzf <file>`) and
  run `colab-playground` in the folder it creates. It needs glibc 2.35 or newer (for example
  Ubuntu 22.04 or Debian 12 and later) and libraries a desktop installation already has: libxcb,
  libxkbcommon and libxkbcommon-x11.
- **macOS 11 or later on Apple silicon:** unzip `colab-playground-aarch64-apple-darwin.zip` and
  move `Colab Playground.app` to Applications (opened where it was unzipped, it cannot update
  itself). It is not notarised by Apple, so macOS refuses the first launch: try to open it once,
  then open System Settings → Privacy & Security and, under Security, click **Open Anyway**
  (offered for about an hour after the attempt) and enter your login password. After that it opens
  normally.
- `SHA256SUMS` in the same release lists the SHA-256 of each file; compare it with the output of
  `sha256sum <file>` (Linux), `shasum -a 256 <file>` (macOS) or `Get-FileHash <file>` (PowerShell).
  `SHA256SUMS.sig` is the project's signature of that list, which the app checks before it
  installs an update ([what it covers](RELEASING.md#the-update-signature)).

A download is a release build: it uses the real Colab CLI (see [Build and run](#build-and-run)), so
the real-mode requirements below apply.

## Updates

The app checks GitHub for a newer release, and installs it when you ask.

- **Automatic check:** shortly after start-up, then at most once a day while the app runs. The time
  of the last check that got an answer is kept in the settings file, so restarting does not check
  again within the day. A check that fails is tried again after an hour, or at the next start.
  Turn it off in Settings → About → "Check for updates automatically".
- **By hand:** Settings → About → "Check for updates".
- **When a newer version exists:** a notice appears once for that version, and the Settings entry
  stays marked until you have updated. "Download and restart", on the notice and in Settings →
  About, first says what a restart affects: open port forwards close, runtimes keep running and
  billing, and an auto-stop set on a runtime keeps working. It then downloads the version, checks
  it, puts it in place of the running one and restarts; the steps are shown as they happen, and
  Cancel works until the new version is being put in place. It waits while a runtime is being
  started, a deployment runs, an account is being added or the CLI is being installed. "What's
  new" opens the release page.
- **The check before installing:** the download must match `SHA256SUMS` in the release, and
  `SHA256SUMS` must carry the project's signature for that release (see
  [The update signature](RELEASING.md#the-update-signature)). If anything fails, this version stays
  as it is and keeps working (in the rare case that it cannot be put back where it was, the app
  says where it is now). A download that fails the check is not installed, and the app does not
  offer that version's download page either.
- **When the app cannot update itself** it says why and offers "Open download page" instead, where
  you download the new version as in [Install a release](#install-a-release) and replace the old
  file or app. That happens when the app cannot write to its folder (for example
  `C:\Program Files`), when macOS runs it from where it was unzipped (move it to Applications), for
  a build that is not a release download (such as `cargo run`), and when its files are not laid out
  as the download leaves them.
- **What is sent:** the check is one request for this repository's latest release. Installing
  downloads `SHA256SUMS`, `SHA256SUMS.sig` and the file for your computer from that release. Each
  request carries the app's version and nothing about you or your computer.
- On Windows the replaced program is deleted the next time the app starts.
- A check that fails is reported in Settings → About (and in a message when you started it by hand).
- Demo data never contacts GitHub: it simulates the download, the check and the installation, and
  replaces nothing.

## Feedback

- **Any time:** Settings → About → "Give feedback" opens a new issue on GitHub in your browser,
  with the app's version and operating system filled in.
- **When the app asks:** after a few runtimes or deployments, the app asks whether you enjoy it,
  with "Star on GitHub" (the project page) and "Give feedback". It asks only right after you stop
  a runtime while nothing else runs or starts, at most twice, and never again once you choose
  either link.
- **What is sent:** opening the issue form passes the app's version and operating system to GitHub
  in its link. Nothing is posted until you submit the form, and the app itself sends nothing.

## Requirements

- Rust: the version in `rust-version` under `[workspace.package]` in
  [`Cargo.toml`](../Cargo.toml), or newer.
- Linux desktop build: `libxkbcommon-x11-dev` and `libfontconfig-dev` (Ubuntu package names).
  The [Web Server](#headless-web-server) builds with Cargo on Linux without desktop libraries.
  Windows and macOS need nothing beyond the Rust toolchain.
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
  `login-invalid-code`, `login-unverified`, `not-entitled` (A100 and H100), `no-answer` (Colab
  never answers a request for an A100: after a minute the progress says how long it has waited,
  after about ten minutes it fails, and cancelling it shows the cleanup of the runtime the request
  got anyway), `ssh-busy` (the first
  forward gets HTTP 429), `plugin-fails` (at the download stage), `watchdog-restart-fails` (setting
  an auto-stop again after cancelling it cannot put the stop back on the runtime), `runtimes-fail`
  (runtimes cannot be listed), `update-available` and `update-check-fails` (the update check),
  `update-unsupported` (this copy cannot update itself), `update-download-fails`,
  `update-unverified` (the download fails its check) and `update-install-fails` (installing an
  update; add `update-available`).
- Both accept `--flag value` or `--flag=value` and apply only when the mock is selected (add
  `--mock` to a release build). A simulated A100 has 40 GB first and 80 GB on the next attempt:
  set a minimum GPU memory of 70 GB to watch the retry. Git plugin installs are not simulated.

Demo mode still reads and writes the normal settings file; set `COLAB_PLAYGROUND_CONFIG_DIR` to
another folder to keep experiments apart.

## Headless Web Server

Start with demo data from a checkout. Run the command in an interactive terminal on the server.

```sh
cargo run -p colab-playground-web --locked -- --mock --no-open
```

Sign in at `http://127.0.0.1:3000` with the Web access key printed on first launch. Save the key
somewhere private. Later starts reuse the key. Use the same backend as the running server when
rotating it from a second interactive terminal:

```sh
cargo run -p colab-playground-web --locked -- rotate-token --mock
```

Rotation prints the replacement once and revokes the previous key, signed-in browser sessions,
and open event streams. Use `rotate-token --real` to rotate the real-mode key. A server with
an existing key can restart without an interactive terminal.

| Option | Effect |
| --- | --- |
| `--host IP` | Listen on this IP address. The default is `127.0.0.1`. |
| `--port PORT` | Listen on this port. The default is `3000`. Use `0` to pick a free port and read it from the startup message. |
| `--no-open` | Skip opening a browser on the server. |
| `--trusted-host [http[s]://]HOST[:PORT]` | Accept the specified browser-facing host and origin. Repeat for each origin. Without a scheme, it uses HTTP and defaults to the listen port. With a scheme, it defaults to that scheme's standard port. |
| `--mock`, `--real` | Select demo data or the real CLI. The [build mode and environment defaults](#build-and-run) are shared with the desktop app. |
| `--mock-scenario`, `--mock-fail` | Use the same [demo scenarios and failure options](#demo-data). |
| `--help`, `-h` | Print the command help. |

Only one desktop app or Web Server can use the same data directory at a time, even on different
ports. Stop the other instance before starting in real mode. For separate demo servers, give each
one a different `COLAB_PLAYGROUND_CONFIG_DIR`. Closing a browser leaves the server, guards and
forwards running. Stop the server with Ctrl+C. To end runtime billing, use **Stop all and verify**
from the browser before stopping the server.

### Remote access and forwarded ports

Keep the Web Server on loopback for SSH access. From the browser's machine, run:

```sh
ssh -N -L 3000:127.0.0.1:3000 user@server
```

Then visit `http://127.0.0.1:3000` in your browser. With a TLS reverse proxy, keep the HTTP
listener private, pass `--trusted-host https://console.example.com` for the public URL, and
preserve the browser's `Host` and `Origin` headers. Direct plain HTTP on a network sends
credentials in clear text.

`ForwardBind` controls where each individual Forward listens. **Loopback** is the default for
manual and plugin forwards and is reachable on the server. Use a separate SSH local forward
for a browser on another machine. **All interfaces** binds the forwarded port to `0.0.0.0`
and is available when the Web Server listens on a non-loopback IP on Linux or macOS.
Windows/WSL supports loopback forwards. The Web access key and the console's TLS proxy protect
the console only. Anyone who can reach a forwarded port can connect directly to its service.
Limit network access with the server firewall and use the downstream service's authentication.

### Keyring preflight on headless Linux

Real mode needs a D-Bus user session and an unlocked Secret Service keyring. Run these checks
as the same user and in the same session that will launch the Web Server:

```sh
busctl --user call org.freedesktop.secrets /org/freedesktop/secrets \
  org.freedesktop.Secret.Service ReadAlias s default

# Replace COLLECTION_PATH with the object path returned above.
busctl --user get-property org.freedesktop.secrets COLLECTION_PATH \
  org.freedesktop.Secret.Collection Locked
```

The first command should return a collection path beginning with
`/org/freedesktop/secrets/collection/`. The second should return `b false`. If the bus or service
is unavailable, start the user session and Secret Service provider. If the result is `/` or
`b true`, create or unlock the default keyring with that provider. Start the Web Server from the
session that can reach the unlocked keyring and check **Overview → OS keyring** before signing in.
Keep credentials in the OS keyring.

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
  On Windows the app keeps the WSL distribution running while it is open, so a password-protected
  keyring asks to be unlocked once after WSL starts rather than at every background refresh.
- **CLI location:** Settings → "Colab CLI location" picks the WSL distribution and, if detection
  fails, the path of `colab` (its Python interpreter is optional and otherwise found from it).
- **Logs** go to standard error; `RUST_LOG` replaces the default filter
  `warn,colab_playground=info`. Release builds on Windows open no console window.

- **SSH key:** port forwarding leaves `~/.ssh/config` alone and creates `~/.ssh/id_ed25519` only
  when there is neither an ed25519 nor an ECDSA key.

## Working with several accounts

Extending, forwarding and deploying need the runtime's account to be active; stopping works on
any saved account.
