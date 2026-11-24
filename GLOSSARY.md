# Colab Playground

Domain vocabulary for Colab Playground, including its headless web edition (`colab-playground-web`). Keep definitions free of implementation details and consistent with `docs/DESIGN.md`.

## Runtimes and sessions

**Runtime**:
A billed Google Colab virtual machine instance (CPU, GPU, or TPU) running on Google's infrastructure.
_Avoid_: container, node, remote server

**Session**:
A Runtime that has a local name in the Colab CLI state file and can be targeted by name.
_Avoid_: job, task

**Managed runtime**:
A Runtime created and tracked in Colab Playground's local ledger, covered by its Watchdog and Guard policies.
_Avoid_: managed session, internal runtime

**Unmanaged runtime**:
A Runtime running on a saved Google account that was not created by Colab Playground (such as one opened in Colab Web or another CLI invocation); listed for visibility and manual stop, never stopped automatically by Guards.
_Avoid_: orphan runtime, rogue session

## Billing and safety

**Watchdog**:
The timer process running on the Runtime itself that enforces Auto-stop and idle shutdown even when Colab Playground is not running.
_Avoid_: daemon, monitor

**Guard**:
The local host-side cost check that evaluates spend caps, balance floors, and runtime limits against usage snapshots and stops Managed runtimes that cross a threshold.
_Avoid_: limiter, policy engine

**Auto-stop**:
The scheduled deadline after which a Managed runtime is automatically released to end billing.
_Avoid_: timeout, expiry

**CLI credential slot**:
The single machine-wide OAuth2 credential stored in the OS keyring for `google-colab-cli`; switching accounts swaps this slot for every `colab` process on the machine.
_Avoid_: account cache, token file

**Demo data**:
The deterministic offline simulation mode (`--mock`) that exercises the interface without touching the Colab CLI, any Google account, or billing.
_Avoid_: fake mode, staging

## Plugins and forwarding

**Plugin**:
A declarative manifest (`plugin.toml`) plus one script that executes exclusively on a paid Runtime, never on the user's machine; surfaced in the UI in user terms such as "Deploy a GGUF model".
_Avoid_: web plugin, local extension, backend module

**Forward**:
A port forwarding channel exposing a port on a Runtime to the machine running the Colab CLI (named `Tunnel` in core code).
_Avoid_: proxy gateway, public port

**Endpoint**:
A service address declared by a Plugin or opened through a Forward, such as an OpenAI-compatible API or web chat.
_Avoid_: route, target

**Forward bind address**:
The listening address of a Forward on the machine running `colab ssh`, distinct from the local health-probe address and the client-facing URL shown to a remote browser.
_Avoid_: tunnel host, proxy address

## Headless web edition

**Web Server**:
The headless CLI process (`colab-playground-web`) that owns the backend, Guards, Forwards, and single-instance lock on the machine running the Colab CLI.
_Avoid_: headless host, platform backend, worker node

**Browser Client**:
A stateless browser tab connected to a Web Server; closing it never stops the Web Server, Guards, or open Forwards.
_Avoid_: frontend instance, session owner

**Web access key**:
The secret used to sign a Browser Client into a Web Server, stored only as a cryptographic hash on disk and strictly distinct from Google OAuth credentials.
_Avoid_: access token, OAuth token
