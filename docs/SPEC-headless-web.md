# Specification: Headless Web Edition (`colab-playground-web`)

## Problem Statement

Colab Playground currently ships only as a desktop GUI application built with GPUI, which requires a graphical desktop environment and windowing libraries (Wayland/X11 on Linux, desktop windows on macOS/Windows). Users running the Google Colab CLI on headless Linux servers, ARM64 workstations without a desktop, or remote SSH machines cannot build or run the desktop interface locally, and therefore lose access to Colab Playground's multi-account management, hardware-targeted session provisioning, live cost Guards, Forward management, and Plugin runner.

Users in these environments do not want a new multi-user cloud platform or a rewritten tool with divergent behavior; they want the exact same Colab Playground desktop application delivered as a CLI-launched headless Web Server that can be operated remotely from any Browser Client while preserving a pure-Rust backend, single-binary deployment, safety invariants, and upstream-friendly structure.

## Solution

Add a standalone headless Web Server binary (`colab-playground-web`) to the workspace alongside the existing desktop application, backed by the same core library and a shared pure-Rust foundation for settings, 5-locale translations, error mapping, and backend CLI selection.

Users launch the Web Server from the command line (in the ergonomic style of `kimi web` and `dsh web`), sign in from a Browser Client with a Web access key using non-cookie Bearer authentication, and get 1:1 functional parity with the desktop application across Overview, Sessions, Plugins, Accounts, and Settings. Closing a Browser Client never stops the Web Server, its Guards, its open Forwards, or active Plugin runs; stopping the CLI process is the true shutdown, with bounded cleanup of in-flight paid operations. Forwards default strictly to loopback and optionally allow per-tunnel all-interface binding so remote browsers and external OpenAI API clients can reach forwarded Colab services directly without fragile subpath reverse proxying.

## User Stories

### CLI startup, deployment, and Demo data

1. As a headless Linux server user, I want to run `colab-playground-web` as a single standalone Rust binary without Wayland, X11, or Node.js installed on the deployment host (building the React + TypeScript + Vite frontend with `pnpm` first and embedding the compiled bundle during Cargo compilation per ADR-0005).
2. As a developer or evaluator, I want debug builds of the Web Server to default to Demo data and release builds to default to the real Colab CLI (with explicit `--mock`, `--real`, `--mock-scenario`, `--mock-fail`, and `COLAB_PLAYGROUND_BACKEND` support), so that typos or development runs never touch real Google accounts or incur billing.
3. As a CLI user, I want the Web Server to bind to loopback (`127.0.0.1`) by default and require an explicit `--host` flag (such as `--host 0.0.0.0` or `--host <ip>`) to listen on non-loopback interfaces, so that Colab control is never exposed on a network by accident.
4. As a CLI user, I want to configure the listen port (`--port`), suppress automatic browser launch (`--no-open`), and allow reverse-proxy hostnames (`--trusted-host`), so that the Web Server fits smoothly into SSH workflows, LAN/Tailscale setups, and systemd services.
5. As a user running the Web Server on a non-loopback address over plain HTTP, I want a prominent startup warning recommending SSH local forwarding or a TLS-terminating reverse proxy, so that I understand the transport security trade-off.
6. As a user who also runs the desktop application on the same machine, I want an exclusive single-instance lock on the app data directory to block starting a second instance against the same data directory, so that two processes never corrupt the local ledger or create Runtimes on the wrong Google account.

### Authentication and web security

7. As a security-conscious user, I want the Web Server to store only a cryptographic hash of the Web access key on disk (in an owner-only file) and print the raw key only once to the interactive terminal upon first generation or explicit `rotate-token`, so that secrets are never written to files or service logs.
8. As a user rotating credentials via `rotate-token`, I want the previous Web access key and all active Browser Client sessions and live event streams to be invalidated immediately, so that compromised or old sessions cannot keep issuing commands.
9. As a user accessing both the Web Server and forwarded Colab web apps (such as `llama-server` or third-party Gradio Plugins) on the same server host across different ports, I want the Web Server to authenticate API requests and live event streams with explicit Bearer credentials rather than browser cookies, so that untrusted code running on a Colab Runtime can never receive the Web Server's credentials via cross-port cookie sharing.
10. As a user running the Web Server on my machine or network, I want every HTTP route to validate the `Host` header against an explicit allowlist, every state-changing request and event stream to validate the exact `Origin` (scheme, host, and port), and every mutation to accept JSON only, so that DNS rebinding and cross-site request attacks are blocked.
11. As a user running Plugins that take secret inputs or a Hugging Face token, I want secret fields to be consumed directly on submission and never echoed back in shared state snapshots, error messages, or log streams, so that credentials never leak across connected Browser Clients.

### Overview and environment readiness

12. As a first-time user on a headless server, I want the Overview page to display the environment readiness checklist (CLI presence, version, helper interpreter, OS keyring status, and active account) and let me install the Colab CLI with streaming progress, so that I can complete setup without desktop access.
13. As a headless Linux user whose OS keyring is locked or missing a Secret Service daemon, I want the environment checklist to surface a clear diagnosis and actionable unlock/setup guidance without falling back to plaintext credential storage, so that upstream keyring security invariants remain intact.
14. As a returning user, I want the Overview page to summarize compute unit balance, estimated burn rate, estimated time left, active Managed runtimes, warnings for Unmanaged runtimes, and quick-deploy entry points for installed Plugins, so that I can see spending and status at a glance.

### Accounts and CLI credential slot

15. As a user with multiple Google Colab accounts, I want to view every saved account's compute unit balance and burn rate without switching the active CLI credential slot, so that I can check quotas without disrupting active work.
16. As a remote Browser Client user adding a Google account, I want the add-account dialog to display a user-clickable Google sign-in link (rather than triggering a blocked background popup or server-side browser) alongside an input field for pasting the authorization code, so that OAuth sign-in works reliably from any remote browser.
17. As a user who starts adding an account and closes the browser tab without finishing, I want the Web Server to enforce an inactivity timeout that automatically cancels the pending login flow and restores the previous credential, so that the CLI credential slot write lock is never stuck indefinitely.
18. As a user switching the active account, I want to see the full switch impact beforehand (which open Forwards will close, which Managed runtimes continue billing under their Watchdog, and which Unmanaged runtimes remain active without a Watchdog) and confirm once before switching, so that I never silently disrupt running workloads.
19. As a user removing a saved account, I want the Web Server to prevent removing the currently active account and clearly explain why, matching desktop safety rules.

### Runtimes, Sessions, and cost Guards

20. As a user provisioning a new Session, I want to pick accelerator type (CPU, GPU, or TPU), high RAM, minimum GPU VRAM (with automatic give-back and retry when Colab assigns a smaller GPU), and per-session Guard overrides (Auto-stop deadline, idle timeout, spending cap, balance floor), with live progress and a Cancel button that leaves no billed Runtime behind.
21. As a user monitoring active workloads, I want the Sessions page to list every Managed runtime and Unmanaged runtime across all saved accounts, showing hardware, burn rate, estimated spend, Auto-stop countdown, and Guard warnings, so that nothing bills unseen.
22. As a user protecting myself from surprise bills, I want to stop any displayed Runtime (Managed or Unmanaged, on any saved account) directly from where it is shown with one confirmation stating that stopping wipes the Runtime and ends billing.
23. As a user running a longer job, I want to extend a Managed runtime's Auto-stop deadline, set a new Auto-stop, or cancel Auto-stop with clear feedback when the VM Watchdog could not be armed, so that I always know whether protection lives on the Runtime or only in the Web Server.
24. As a user running another CLI workflow on the same machine alongside the Web Server, I want Guards to evaluate and auto-stop only Managed runtimes and never auto-stop Unmanaged runtimes, while still showing Unmanaged runtimes so I can inspect or stop them manually.
25. As a user wanting to shut down all paid compute quickly from the browser, I want a "Stop all and verify" action that cancels in-flight provisions, stops all running Runtimes, and verifies they are gone, without shutting down the Web Server process itself.

### Forwards and remote access

26. As a user forwarding a port from an active Session, I want Forwards to default strictly to `Loopback` (`127.0.0.1`) for both manual forwards and Plugin auto-forwards, so that forwarded services are never exposed on the network unless I opt in.
27. As a remote Browser Client user connected to a non-loopback Web Server on Linux or macOS, I want to opt in per Forward to `AllInterfaces` (`0.0.0.0`) with an explicit warning that the forwarded port relies solely on the downstream service's own authentication, so that I can open `llama-server` web chat or point external OpenAI API clients directly at the server's address and port.
28. As a remote Browser Client user viewing an active Forward or Plugin Endpoint, I want open links, copyable URLs, and OpenAI API examples to use the host I am accessing the Web Server through when `AllInterfaces` is enabled (and clearly state "server-local only" when `Loopback` is active), so that links never falsely point to my laptop's own `localhost`.
29. As a Windows/WSL user running the Web Server, I want `AllInterfaces` forwarding to be disabled with a clear explanation (since SSH runs inside WSL and cannot bind Windows LAN interfaces), so that I am never offered a broken option.

### Plugins and model deployment

30. As a user deploying a Hugging Face GGUF model through the bundled `llama-cpp` Plugin, I want to search Hugging Face repositories, inspect available GGUF files and GPU VRAM quantisation fits, launch the Plugin on a fresh or existing Session, watch live stages and secret-redacted logs, and see ready Endpoint cards with health indicators.
31. As a user extending workflows with custom Plugins, I want to install a Plugin from a Git URL or from a directory path on the Web Server machine, inspect its validated manifest and "runs on your paid Runtime" warning before confirming, enable/disable installed Plugins, and remove user-installed Plugins.
32. As a user managing optional Plugin capabilities, I want to save, check, and delete my Hugging Face token (stored via the core keyring vault and never displayed back), so that private or gated repositories work in Plugins that declare `needs = ["hf_token"]`.

### Settings, localization, themes, and desktop-to-web adaptations

33. As a user with both desktop and web editions installed, I want the Web Server to read and write the same `settings.json` format and Defaults (with per-field lenient recovery and corrupt-file preservation), so that preferences and Guard defaults stay consistent.
34. As a multilingual user, I want the Web UI to support English, 简体中文, 繁體中文, 日本語, and 한국어 as well as Light, Dark, and Follow-system appearance, with "Follow system" following my Browser Client's language and color scheme rather than the server OS.
35. As a remote Browser Client user on the Settings page, I want to view and copy the server's settings directory path (instead of invoking a server file manager) and see a read-only update notification linking to the fork's releases (never triggering remote self-replacement of the server binary).

### Multi-tab concurrency and server lifecycle

36. As a user opening the Web UI from both my laptop and my phone simultaneously, I want all connected Browser Clients to receive live versioned state snapshots over SSE without interrupting active form inputs I am currently typing, and to recover cleanly by fetching a full snapshot after any disconnect.
37. As a user accidentally double-clicking "Deploy" or clicking from two open tabs, I want the Web Server to deduplicate in-flight operations globally and serialize account mutations against active-account long operations, so that duplicate clicks never provision duplicate billed Runtimes or switch accounts mid-Plugin-run.
38. As a user closing my laptop lid or browser tab, I want the Web Server to keep running Guards, open Forwards, and Plugin log collection in the background so that reopening the browser immediately shows current state and logs.
39. As a user stopping the Web Server from the terminal (`Ctrl+C`, `SIGTERM`, or `SIGHUP`), I want the server to cancel any in-flight provision or Plugin run and wait within a bounded window for cleanup, close all open Forwards, and print a clear terminal summary of any Runtimes still known to be billing (with a second `Ctrl+C` forcing immediate exit).

## Implementation Decisions

### Workspace architecture and shared pure-Rust extraction (ADR-0001)

- Keep the existing core library and desktop application crate intact while adding two workspace crates: a pure-Rust shared crate and an independent headless web crate producing the `colab-playground-web` binary.
- Extract strictly pure data and pure logic into the shared crate: the 5-locale message tables and key constants, locale resolution and template interpolation, `Settings` persistence and lenient deserialization, pure error-to-translation-key/argument/next-step mapping, backend mode CLI/environment resolution (`--mock`, `--real`, `--mock-scenario`, `--mock-fail`, `COLAB_PLAYGROUND_BACKEND`) extended with a caller-provided allowlist for extra flags, and pure state helpers (such as operation deduplication keys and defaults sanitization).
- Keep thin GPUI/Ely adapters in the desktop crate so desktop UI call sites remain unchanged.
- Accept that desktop state orchestration is coupled to GPUI contexts and timers; build a thin async state orchestrator inside the headless web crate that aligns behaviorally with the desktop state layer (scheduling, locking, and event broadcast only, with zero duplicated billing or domain calculations).
- Add 5-locale translations in the web crate for basic UI control strings previously supplied by Ely's built-in catalog, and enforce cross-locale key parity across both shared and web catalogs.
- Extend workspace OS-isolation lint rules and CI jobs to cover the shared and web crates, including a dedicated headless Linux build-and-test job for `colab-playground-web` without X11/Wayland packages, while keeping desktop Ely clippy rules scoped to the desktop crate.

### Backend HTTP/SSE server and embedded React + TypeScript + Vite frontend (ADR-0005, superseding ADR-0002)

- Build the headless web crate on Rust `axum` with a React + TypeScript + Vite frontend (`crates/web/frontend/`, managed with `pnpm`) whose compiled static bundle (`dist/`) is embedded directly into the single Rust binary at compile time via `crates/web/build.rs`.
- Keep all business math (spend integration, ETA, Guard evaluation, quantisation fitting, status formatting) on the Rust server; the browser layer renders server-computed state and dispatches user intents.
- Use native `<dialog>` modals and existing theme CSS custom properties matching the desktop visual hierarchy and light/dark palettes; enforce `Content-Security-Policy: default-src 'self'`.
- Publish full versioned state snapshots over SSE (rather than fragile incremental DOM patches) so reconnecting or newly opened Browser Clients converge immediately; isolate active form/modal state from background snapshot updates so typing is never clobbered.
- Consume Plugin `secret` inputs directly on submission and exclude them from client/server shared state snapshots, broadcast events, and logs.
- Adapt desktop-only actions cleanly: copyable server config path, read-only release link update notice (with repository metadata pointing to the fork while forked), server directory path input for local Plugin install, explicit clickable links for external/OAuth URLs, and browser-driven system language/theme detection.

### Forward bind modes and three-address model (ADR-0003)

- Extend the core tunnel specification with a typed `ForwardBind` enum (`Loopback` default, `AllInterfaces` for `0.0.0.0`) using serde default so existing desktop code and serialized state remain backward-compatible.
- Separate the three addresses explicitly:
  1. SSH listen address (`127.0.0.1` for `Loopback`, `0.0.0.0` for `AllInterfaces`);
  2. Host readiness and HTTP health-probe address (always `127.0.0.1`, valid for both modes);
  3. Client-facing URL built by the web layer from the request host + local port when `AllInterfaces` is active (for open links, copy buttons, and OpenAI API examples on both manual forwards and Plugin endpoints), or explicitly marked server-local-only for remote browsers when `Loopback` is active.
- Keep both manual forwards and Plugin auto-forwards defaulting to `Loopback`; allow per-tunnel opt-in to `AllInterfaces` only when the Web Server is listening on a non-loopback host, with a clear downstream-authentication warning; disable `AllInterfaces` on Windows/WSL.
- Update the core fake SSH test helper to parse explicit bind addresses (including bracketed IPv6) rather than splitting naively on `:` and hardcoding `127.0.0.1`.

### Authentication, concurrency coordination, single-instance lock, and lifecycle (ADR-0004)

- Do not use cookie authentication. On login, the Browser Client exchanges the Web access key for a short-lived, server-tracked in-memory Bearer session token and sends `Authorization: Bearer` on all API calls and SSE streams (reading SSE via `fetch` streaming rather than native `EventSource`).
- Persist only a SHA-256 hash of the Web access key in an owner-only (`0600`) file and verify in constant time. Print the raw key only once to the interactive terminal on initial generation or `rotate-token` (which immediately revokes all active Bearer sessions and open SSE streams). Never log keys or query strings; omit `--dangerous-bypass-auth` in v1.
- Enforce an allowlist `Host` check (loopback + `--trusted-host`) on every route, an exact `Origin` check (scheme + host + port) on all mutating routes and SSE connections, JSON-only request bodies on mutations, and `Referrer-Policy: no-referrer` on responses.
- Acquire an exclusive single-instance file lock in the app data directory at startup (shared in the core crate so desktop and web protect each other) and fail fast with a clear message if another instance holds it.
- Coordinate one `Backend` instance per Web Server process: run blocking `Backend` methods on a blocking thread pool, deduplicate in-flight mutations globally by operation and key (returning accepted status while streaming progress via SSE), serialize account mutations against active-account long operations, verify target/account preconditions against current server state before executing, enforce an inactivity timeout on active `LoginFlow` instances that automatically calls `cancel()` to release the credential-slot write lock, and preserve desktop Guard polling rules (keep polling during provisions, Plugin runs, and Forwards; pause during account login/switch).
- Isolate OS signal handling (`Ctrl+C`, `SIGTERM`, and Unix `SIGHUP`) in a platform module. On first signal, cancel in-flight provisions and Plugin runs, wait within a bounded grace period for cleanup, close all open Forwards, and print a last-known billing summary (distinguishing active Managed runtimes, Unmanaged runtimes without Watchdog, and unknown status); exit immediately on a second signal. Do not expose remote process shutdown in the web UI by default, while keeping "Stop all and verify" for cloud Runtimes.

## Testing Decisions

A good test verifies observable external behavior at the highest practical seam without coupling to internal helper structures, never invokes the real `colab` CLI (other than `version`/`help`), never touches real OS keyrings or Google accounts, and stays deterministic in CI.

### Testing seams (highest to lowest)

1. **Web Server HTTP + SSE seam (primary new seam, single highest entry point for the web crate)**:
   - Exercise the full `axum` router in-process (and over loopback where streaming cancellation/disconnect is tested) backed by `MockBackend` and a temporary config/data directory.
   - Verify external HTTP/SSE contracts across all desktop-parity flows: CLI flag validation (`--mock`/`--real`/unknown flag rejection), Web access key generation/hash storage/`rotate-token` revocation, Bearer auth enforcement, `Host` and exact `Origin` rejection, no cookie issuance, Overview checklist & CLI install, Account add/timeout-cancel/switch-impact/remove, Session provision/cancel/extend/stop/stop-all-and-verify, Guard polling warnings and auto-stops, Manual and Plugin auto-Forwards (`Loopback` vs `AllInterfaces` URLs and warnings), Plugin install/form/secret-redaction/run/log-stream, Settings persistence and 5-locale resolution, global cross-tab op deduplication, and graceful shutdown cleanup.
   - Prior art: mirrors the scenario coverage of the existing desktop headless UI test suite (`accounts`, `defaults`, `navigation`, `overview`, `plugins`, `quit`, `sessions`, `settings_page`, `updates`, `usage`), adapted to HTTP/SSE without Node.js or Playwright.
2. **Core backend seam (existing seam, extended)**:
   - Exercise `RealBackend` against the existing fake `colab` / fake `ssh` Unix toolchain and `MockBackend` for `ForwardBind::Loopback` vs `ForwardBind::AllInterfaces`, port conflict detection, readiness and health probing, WSL rejection of `AllInterfaces`, and single-instance data-directory lock contention.
   - Prior art: existing `RealBackend` integration tests and fake CLI/SSH harness in the core crate.
3. **Desktop parity and static invariant seam (existing seam, extended)**:
   - Run the existing desktop UI test suite unchanged to prove extracting the shared crate introduces zero desktop regressions.
   - Split locale-parity tests so every locale key resolves identically across all 5 languages in both shared and web catalogs while retaining desktop Ely catalog and key-usage scans.
   - Extend OS-isolation source lint tests to the shared and web crates, and enforce frontend static invariants (`tsc --noEmit`, no unsafe DOM/inline scripts/hardcoded colors, and 5-locale `t("...")` key verification) alongside Rust HTTP/CSP/catalog tests (ADR-0005).

## Out of Scope

- Turning Colab Playground into a multi-user SaaS platform, team RBAC system, or job scheduler.
- Built-in TLS certificate management or ACME inside the Web Server (users needing HTTPS over untrusted networks place a TLS reverse proxy or SSH tunnel in front).
- Subpath HTTP/WebSocket reverse proxying of forwarded Colab services.
- Bypassing or replacing the upstream OS keyring security model with a custom plaintext or file-based Google OAuth vault on headless Linux.
- Building new upstream Roadmap features not yet in the desktop edition (such as Keep plans, Google Drive / Hugging Face checkpoint persistence, plugin run reattach after server restart, or the Google Colab REST/MCP API backend).
- Introducing Playwright, Vitest, or Rust WASM toolchains into the repository or CI, or requiring Node.js on deployment hosts.
- Remote self-updating/overwriting of the Web Server binary from a Browser Client, or exposing a default remote server-process shutdown button.

## Further Notes

- **Relationship to upstream `scarletkc/colab-playground`**: All changes live on feature branches of the fork and follow upstream's `docs/DESIGN.md` hard safety rules, invariants, and commit/PR conventions (no `Co-Authored-By` agent trailers, never push to `main`). Because ADR-0005 (superseding ADR-0002) introduces a web presentation shell alongside `docs/DESIGN.md`'s v1 browser/WASM non-goal, any eventual upstream merge remains a product decision for the upstream maintainer.
- **Headless Linux keyring prerequisite**: Real-mode operation on headless Linux requires an active D-Bus user session with an unlocked Secret Service backend (not plaintext `keyrings.alt`). Before running real mode on any new target host, verify the Python `keyring` backend state without invoking real `colab` commands.
- **Data directory coexistence**: Even when the fork lives in an isolated local source workspace, both desktop and web builds share the OS app data directory and the machine's single `colab` CLI credential slot unless isolated via `COLAB_PLAYGROUND_CONFIG_DIR`. Do not run the desktop and web binaries concurrently against the same real account.
