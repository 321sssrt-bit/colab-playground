---
status: accepted
---

# 0005: React + TypeScript + Vite embedded frontend replacing zero-build vanilla JS

## Context and Decision

ADR-0002 chose plain HTML, CSS, and zero-build vanilla ES Module JavaScript so building `colab-playground-web` would avoid introducing Node.js or a frontend bundler. Delivering 1:1 desktop parity across five interactive pages, modals, live SSE state convergence, Hugging Face GGUF fit previews, and streaming logs without a component framework or type checker produced ~14,139 lines of untyped DOM-construction code and a 934-line custom Rust JS lexer test.

We supersede ADR-0002 and replace the vanilla JS layer with a **React + TypeScript + Vite** application (managed with **pnpm**) whose production bundle is embedded directly into the single `colab-playground-web` Rust binary at compile time. Deployed hosts still run one standalone Rust executable with zero Node.js runtime dependency.

## Considered Options

- **Keep the zero-build vanilla JS frontend**: zero rewrite cost, but every future UI change lands in untyped 2,000+ line DOM files guarded by a fragile hand-rolled Rust lexer.
- **Rust WASM frontend (Leptos / Dioxus)**: keeps browser code in Rust, but introduces `wasm32-unknown-unknown` and bundler tooling, slower compile loops, larger artifacts, and extra CSP/streaming verification risk without improving UI iteration speed.
- **Server-rendered HTML (Askama / Maud)**: conflicts with ADR-0004's no-cookie, in-memory Bearer authentication model (standard navigation and HTML forms cannot attach `Authorization: Bearer`) and still needs client scripting for SSE snapshots, GGUF previews, and log streams.

## Consequences

- **Pure-Rust backend and security boundaries stay unchanged**: `crates/shared`, `crates/core`, and `crates/web`'s HTTP/SSE APIs, Bearer authentication, Host/Origin validation, `Content-Security-Policy: default-src 'self'`, and single-instance locking remain untouched (ADR-0001, ADR-0003, ADR-0004). Local hot-reload development stays strictly behind Vite's dev proxy without adding any development bypass to the Rust server.
- **Source-only repository and explicit two-stage build**: Compiled frontend bundles are never committed. Cargo embeds pre-built frontend artifacts only and never invokes `pnpm` during `cargo build`; missing artifacts fail fast with the required build command. CI builds and checks the frontend once in a dedicated upstream job and passes the bundle to the Rust and headless-container test jobs.
- **Zero dual-track retirement**: All legacy vanilla JS files, legacy entry HTML, and the custom Rust JS lexer test are removed cleanly when the new frontend foundation lands rather than maintained alongside React. Existing theme CSS tokens, layouts, and artwork are reused directly without introducing Tailwind or third-party UI kits.
- **Right-sized verification**: Frontend invariants are enforced via TypeScript type checking, AST-based static checks, Vite production builds, Rust HTTP/CSP/5-locale catalog tests, and browser screenshot verification on Demo data, without adding Vitest or Playwright.
