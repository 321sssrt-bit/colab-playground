---
status: proposed
---

# 0004: Web authentication isolation, single-instance locking, and server lifecycle

## Context and Decision

Turning a single-window desktop app into a persistent CLI-launched headless Web Server introduces security and concurrency boundaries that the desktop process previously obtained implicitly from "one local window, one process". We establish four non-negotiable server rules:

1. **No cookie authentication — Bearer credentials + `fetch` SSE**:
   Browsers scope cookies by hostname without port isolation (RFC 6265 §8.5). A console cookie on `host:3000` would be sent to untrusted Colab services forwarded on `host:8000` regardless of `HttpOnly` or `SameSite=Strict`. Instead, the Browser Client signs in with the **Web access key** to receive a short-lived in-memory Bearer session credential and attaches `Authorization: Bearer` to every API request and SSE stream (consumed via `fetch`, not native `EventSource`).
2. **Hash-only key storage and strict HTTP origin fences**:
   To uphold `docs/DESIGN.md`'s invariant ("the app never writes a secret to its files or logs"), disk stores only a SHA-256 hash of the Web access key in a `0600` file (verified in constant time). The raw key is printed only once on initial generation or `rotate-token` to the interactive terminal and never written to logs. Every route validates allowed `Host` (loopback + `--trusted-host`) and exact `Origin` (scheme, host, and port); mutating routes accept JSON only; responses set `Referrer-Policy: no-referrer`. Non-loopback plain HTTP prints a prominent warning recommending `ssh -L` or a TLS reverse proxy, and `--dangerous-bypass-auth` is omitted in v1.
3. **Single-instance data lock and host-level operation coordination**:
   `colab-playground-web` acquires an exclusive file lock in the app data directory at startup (ideally placed in `crates/core` for both desktop and web) so two processes cannot overwrite `ledger.json` or race on the machine's single CLI credential slot. Inside the server, one `Backend` instance runs blocking calls on `spawn_blocking`, deduplicates in-flight mutations globally by `Op + key` (preventing duplicate billed VMs across tabs), serializes account changes against active-account long operations, bounds `LoginFlow` with an inactivity timeout that calls `cancel()` to release the credential-slot write lock, and keeps `guard_poll` running during provisions/runs/forwards while pausing during login/switch.
4. **CLI-owned process lifecycle and graceful shutdown**:
   Closing Browser Clients only drops SSE subscribers; Guards, Forwards, and active plugin runs keep executing. Stopping the CLI process (`Ctrl+C`, `SIGTERM`, or `SIGHUP`, isolated in a platform module) cancels in-flight provisions and plugin runs with a bounded cleanup wait (upholding "cancel never leaves a billed VM behind"), closes open Forwards, and prints a last-known billing summary (a second `Ctrl+C` forces exit). The web UI retains "Stop all and verify" for cloud runtimes, without exposing remote server process shutdown by default.

## Consequences

- Headless Linux deployments still rely on the upstream OS keyring invariant (D-Bus session + unlocked Secret Service, never plaintext `keyrings.alt`); the web environment checklist surfaces clear diagnostics when the keyring is unavailable or locked.
- Switching from cookies to in-memory Bearer credentials means refreshing or reopening a tab re-authenticates or uses an explicit browser-tab session boundary, trading slight convenience for complete immunity against cross-port credential theft from Colab-hosted web UIs.
