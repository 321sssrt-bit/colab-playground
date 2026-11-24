---
status: proposed
---

# 0003: Typed `ForwardBind` mode instead of subpath reverse proxy or free-form bind IPs

## Context and Decision

In the desktop app, `crates/core/src/tunnel.rs` binds `ssh -L` strictly to `127.0.0.1:<local_port>` because the browser runs on the same machine. On a headless server, the Browser Client and external OpenAI API clients run on another device. Rather than building an HTTP subpath reverse proxy (which breaks root-relative frontend assets such as `/assets` or `/v1` in `llama-server` and Gradio and complicates external API clients) or allowing arbitrary free-form IP strings in `TunnelSpec` (which breaks `crates/core/src/http.rs` readiness and health checks hardcoded to `127.0.0.1`), we extend `TunnelSpec` with a typed enum:

```rust
pub enum ForwardBind {
    #[default]
    Loopback,       // 127.0.0.1
    AllInterfaces,  // 0.0.0.0
}
```

with `#[serde(default)]` so existing desktop behavior and serialized specs remain unchanged.

## Three-Address Model

Every Forward explicitly separates three addresses:

1. **SSH listen address**: `127.0.0.1` for `Loopback`, `0.0.0.0` for `AllInterfaces` (OpenSSH `-L` honors an explicit bind address without editing `~/.ssh/config` or requiring `GatewayPorts`).
2. **Host readiness and health-probe address**: always `127.0.0.1`, which succeeds cleanly for both `Loopback` and `AllInterfaces` without misreporting healthy forwards as timed out.
3. **Client-facing URL**: constructed by `crates/web` from the request's host + local port when `AllInterfaces` is active (covering open links, copy buttons, and OpenAI API examples for both manual forwards and plugin endpoints), or explicitly labeled as server-local-only when `Loopback` is active for a remote browser.

## Consequences

- Both manual forwards and plugin auto-forwards default to `Loopback`. Widening to `AllInterfaces` is opt-in per tunnel only when the Web Server itself is bound to a non-loopback address, accompanied by a clear warning that the forwarded port relies entirely on the downstream Colab service's own authentication.
- `AllInterfaces` is disabled on Windows/WSL because `colab ssh` runs inside WSL and cannot bind Windows LAN interfaces directly.
- `crates/core/tests/fake/ssh.py` must be updated to parse explicit bind addresses (including bracketed IPv6) rather than splitting on `:` and hardcoding `127.0.0.1`, with unit/integration tests covering `Loopback`, `AllInterfaces`, port conflicts, and health checks.
