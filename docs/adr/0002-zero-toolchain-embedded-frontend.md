---
status: superseded by ADR-0005
---

# 0002: Pure-Rust `axum` backend with zero-toolchain embedded native frontend

## Context and Decision

We want the web edition to stay faithful to `colab-playground`'s pure-Rust workflow (no Node.js/npm and no double toolchain) while preserving 1:1 functional parity with the desktop `.exe` (Overview, Sessions, Plugins, Accounts, Settings, cost guards, forwards, 5 locales, light/dark themes, and `--mock` demo mode). We will implement `crates/web` using Rust `axum` serving a thin, zero-build frontend (plain HTML, CSS, and native ES Module JS) embedded directly into the single binary via `include_str!`.

## Relation to `docs/DESIGN.md`

`docs/DESIGN.md` lists a browser/WASM build as a v1 non-goal (citing GPUI canvas rendering, inability to spawn CLI processes in WASM, and doubling the toolchain) and requires Ely GPUI Components for the desktop UI. This fork preserves `crates/app` unchanged and adds a separate headless web presentation shell that avoids WASM and keeps a single `cargo` toolchain; whether to adopt it upstream remains the repository owner's decision.

## Considered Options

- **TypeScript + React + Vite embedded into Rust**: rich component ecosystem, but introduces Node.js/npm into the repo and CI.
- **Rust WASM frontend (Leptos / Dioxus)**: Rust syntax in the browser, but requires `wasm32-unknown-unknown`, `wasm-bindgen`/bundler tooling, larger artifacts, and slower builds — directly conflicting with avoiding a double toolchain.
- **Server-rendered HTML fragments + HTMX**: minimal JS, but awkward for interactive HF GGUF search with live VRAM estimates, dynamic plugin forms, and streaming logs.

## Consequences

- **Strict frontend boundaries**:
  - Zero billing, spend estimation, or guard logic in JS; the Web Server computes and returns all derived values.
  - All user-visible strings come from the shared 5-locale catalog; Rust tests scan `assets/` to forbid hardcoded UI text, hardcoded colors, and inline scripts (mirroring `DESIGN.md` invariants).
  - Prefer native `<dialog>`, `<form>`, and `<select>` elements; set `Content-Security-Policy: default-src 'self'`.
  - SSE state updates publish full versioned snapshots and must never overwrite active form fields while the user is typing; plugin `secret` inputs are consumed directly on submit and never enter broadcast snapshots or logs.
  - Automated web UI tests run in Rust at the HTTP layer (`tower::ServiceExt::oneshot` against `MockBackend`), mirroring `crates/app/tests/ui/` without Node or Playwright.
- **Minimal desktop-to-web adaptations**:
  - "Open settings folder" displays and copies the server configuration path.
  - Self-update becomes a read-only new-version indicator linking to releases (with `CARGO_PKG_REPOSITORY` pointed at the fork while forked), never overwriting the server binary from a browser request.
  - Local plugin install accepts a server directory path alongside Git URLs.
  - External links (`cx.open_url`, especially Google OAuth sign-in) render as user-clickable links so browsers do not block async popups.
  - "Follow system" language and appearance follow the Browser Client rather than the server OS.
