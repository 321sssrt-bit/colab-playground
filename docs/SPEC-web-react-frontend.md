# Specification: React + TypeScript + Vite Web Frontend (`colab-playground-web`)

## Problem Statement

The headless Web Server (`colab-playground-web`) currently embeds a zero-build vanilla JavaScript Browser Client under `crates/web/assets/` (ADR-0002). Implementing 1:1 desktop parity across Overview, Accounts, Sessions, Plugins, and Settings without a component framework or type checker produced 19 untyped JS files (~14,139 lines, with individual dialog and page files exceeding 2,400 lines) plus a 934-line custom Rust JS lexer test (`crates/web/tests/asset_lint.rs`). Iterating on the Browser Client is slow and error-prone even though the pure-Rust Web Server backend (`crates/shared`, `crates/core`, and `crates/web`'s HTTP/SSE APIs) is clean and decoupled.

## Solution

Replace the legacy vanilla JS Browser Client with a strongly typed **React + TypeScript + Vite** application (managed with **pnpm**) under `crates/web/frontend/`, governed by ADR-0005. Keep the pure-Rust `axum` Web Server backend, HTTP/SSE contracts, in-memory Bearer authentication, Host/Origin validation, 5-locale merged dictionary (`/assets/i18n/{locale}.json`), and single-binary deployment completely intact.

To avoid dual-track bloat, the 19 legacy vanilla JS files, legacy `crates/web/assets/index.html`, and `crates/web/tests/asset_lint.rs` are retired immediately in the foundation code ticket. Existing stylesheets (`tokens.css`, `base.css`, `shell.css`, `pages.css`) and `favicon.svg` are migrated directly into `crates/web/frontend/` to preserve desktop visual parity, light/dark themes, and responsive layout without introducing Tailwind or third-party UI kits.

## User Stories

### Build, CI, and Single-Binary Deployment

1. As a headless server operator, I want `colab-playground-web` to remain a single standalone Rust executable with compiled frontend assets embedded at build time, so deployment hosts still need zero Node.js or desktop libraries.
2. As a developer building from source, I want the repository to store only frontend source files (never committed `dist/` bundles or `node_modules/`), and I want `cargo build -p colab-playground-web` to fail fast with clear `pnpm` build instructions if `dist/` is missing rather than silently invoking `pnpm` inside Cargo.
3. As a developer working on the Web UI locally, I want `pnpm dev` with Vite HMR to proxy `/api/*` and `/assets/i18n/*` cleanly to a local `--mock` Web Server without weakening the Rust server's Host or Origin checks.
4. As a maintainer running CI, I want a dedicated `web-frontend` job (Node 24 + pnpm) to check and build `dist/` once and pass it to both the `linux` workspace job and the headless `rust:1.98-slim-bookworm` `web` container job, while preserving docs-only skipping, fail-closed propagation on frontend failures, and unchanged required check names.

### Auth Shell, Localization, Theme, and Navigation Parity

5. As a Browser Client user, I want to sign in with the **Web access key** into an in-memory Bearer session (never cookies or web storage), switch language (5 locales + follow browser) and appearance (Light / Dark / Follow browser) before and after sign-in, and experience zero light-flash when reloading with a saved dark theme.
6. As a user navigating on desktop or mobile, I want hash-based routing (`#/overview`, `#/sessions`, `#/plugins`, `#/accounts`, `#/settings`) that supports direct bookmarks, browser refresh, and back/forward navigation without 404s, plus responsive sidebar/drawer navigation, an account switcher menu, compute-unit usage badge, live connection/shutdown banners, Demo data badge, and strict `Content-Security-Policy: default-src 'self'` compliance.

### Full Five-Page Functional Parity

7. As a user on **Overview**, I want the environment readiness checklist (WSL or shell tools, streaming Colab CLI installer with cancel, OS keyring diagnosis, account sign-in/adoption), active account summary KPIs, Unmanaged runtime warnings, and quick-deploy Plugin cards.
8. As a user on **Accounts**, I want multi-account totals, per-account balance/burn rate/ETA cards, Unmanaged runtime warnings, clickable new-tab Google OAuth sign-in (`target="_blank" rel="noopener noreferrer"`, never `window.open`) with cancel and timeout detection, switch-impact preview and confirmation, and active/busy account removal protection.
9. As a user on **Sessions**, I want Managed runtime and Unmanaged runtime groups across all saved accounts, live uptime and Auto-stop countdowns that never disturb user focus or draft inputs, Guard warnings and "Extend" actions, New Session provisioning dialog with hardware/VRAM retry progress and cancel, Auto-stop extend/set/cancel dialogs, Forward dialog (`Loopback` default, opt-in `AllInterfaces` respecting server `forward_policy`, copy/open/close actions), Stop confirmation, Stop all and verify dialog, and Recently ended history.
10. As a user on **Plugins**, I want the Plugin list with enable/disable toggles, folder/Git URL install preview (showing the paid-Runtime warning) and removal dialogs, Hugging Face token status/save/delete dialog (never echoing secrets), dynamic Plugin run form (`text`, `number`, `bool`, `select`, `secret` consumed directly on submit without entering shared state, `hf-model` with HF search and GGUF quantisation VRAM fit preview, plus fresh vs existing Session targeting), and the live run view (stages, provision progress, secret-redacted streaming logs with truncation/skipped notices, post-failure cleanup verification, and ready Endpoint cards with health badges, Forward toggles, Forward bind address selector, and OpenAI cURL examples).
11. As a user on **Settings**, I want instant language and appearance updates persisted to `settings.json`, an isolated Defaults form whose in-progress edits are never overwritten by background SSE snapshots, corrupt/reset notices, and an About card with read-only version/release link, backend badge, and copyable server config directory path.

### Clean Retirement and Maintainability

12. As a contributor, I want all 19 legacy vanilla JS files, legacy `crates/web/assets/index.html`, and the 934-line `crates/web/tests/asset_lint.rs` removed cleanly with zero dual-track coexistence, while preserving the 5-locale `SHELL_CATALOGS` dictionary (minus retired placeholder keys), all Rust HTTP/SSE end-to-end tests, and up-to-date build documentation.

## Implementation Decisions

### Frontend Stack and Styling (ADR-0005)

- Place the frontend workspace in `crates/web/frontend/` with **React**, **TypeScript** (`strict: true`, `noUnusedLocals`, `noUnusedParameters`), **Vite**, and **pnpm** (`pnpm-lock.yaml` committed; `crates/web/frontend/pnpm-workspace.yaml` explicitly allows `esbuild` build scripts for pnpm 11 compatibility).
- Add `/crates/web/frontend/node_modules/`, `/crates/web/frontend/dist/`, and `/crates/web/frontend/.generated/` to `.gitignore`.
- Migrate existing stylesheets into `crates/web/frontend/src/styles/` preserving exact cascade order (`tokens.css`, `base.css`, `shell.css`, `pages.css`) and migrate `favicon.svg` into `crates/web/frontend/public/favicon.svg`, with zero Tailwind or external UI kits.
- Preserve first-paint theme anti-flash by shipping a small same-origin external `theme-init` script (loaded synchronously in `<head>` before CSS, reading `cpg_appearance` to set `data-theme` and `color-scheme` with storage-error fallback to system). Set Vite `build.assetsInlineLimit: 0` so no asset is inlined as a `data:` URI that violates `Content-Security-Policy: default-src 'self'`.
- Keep all billing math (spend integration, ETA, Guard evaluation, quantisation fitting) and allowed Forward origin/security decisions on the Rust server; share form limit constants in one frontend module (`src/lib/constants.ts`). On Plugin Endpoint cards, preserve existing client presentation semantics that re-apply the manifest's declared Endpoint `path` and `kind` over the server-validated origin so re-opening or re-binding a Forward keeps custom paths and OpenAI cURL examples intact.
- Render modals via React-controlled native `<dialog>` components so background SSE snapshots never overwrite active inputs, modal focus, or draft forms. Preserve `#/<route>` hash navigation because the Web Server serves HTML exclusively at `/`.

### Rust Embedding, HTTP Serving, and Local Dev Proxy

- Add `crates/web/build.rs` to walk `crates/web/frontend/dist/` and generate `OUT_DIR/embedded_assets.rs` defining `INDEX`, `FAVICON`, and `STATIC_ASSETS` (with `Asset.body: &'static [u8]` and content-type mapping). Keys in `STATIC_ASSETS` are relative paths under `/assets/` (e.g., `favicon.svg`, `index-<hash>.js`, `index-<hash>.css`, `theme-init.js`); `INDEX` serves `/` directly; `FAVICON` serves both `/favicon.ico` and `/assets/favicon.svg`; `/assets/i18n/{file}` remains exclusively served by Rust's dynamic merged dictionary route.
- Emit `cargo:rerun-if-changed` for `crates/web/frontend/dist/` and its files. If `crates/web/frontend/dist/index.html` is absent, `build.rs` panics with an actionable message instructing the developer to run `pnpm --dir crates/web/frontend install --frozen-lockfile && pnpm --dir crates/web/frontend build`. `build.rs` never spawns `pnpm` or accesses the network.
- Configure Vite with `base: command === "build" ? "/assets/" : "/"` and `build.assetsDir: ""` so production assets resolve cleanly under `/assets/{*path}` while local `pnpm dev` works at `/`.
- Keep Rust's `Origins::check` middleware completely unchanged. In `vite.config.ts`, configure `server.proxy` for `/api` and `/assets/i18n` targeting the local loopback `--mock` Web Server (preserving full paths, aligning `Host` via `changeOrigin: true`, and rewriting `Origin` to the target backend origin **only** when the incoming request's `Origin` matches the active Vite dev origin — rejecting foreign origins and never fabricating an `Origin` header when absent).
- Document the clean-checkout local development sequence in `docs/USAGE.md`: build `dist/` once (`pnpm --dir crates/web/frontend install --frozen-lockfile && pnpm --dir crates/web/frontend build`), then start `cargo run -p colab-playground-web --locked -- --mock --no-open`, and optionally run `pnpm --dir crates/web/frontend dev` for HMR.
- Keep `crates/web/src/assets.rs` focused on `Asset`, `include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"))`, `lookup`, and `SHELL_CATALOGS` (removing retired `web.shell.page_upcoming_*` keys across all 5 locales).

### Zero Dual-Track Retirement Strategy and Slice Sequence

- **Slice order**: `Foundation code ticket (retire legacy JS + React/Vite/build.rs/CI/docs)` → `Shared Web Shell UI ticket (Bearer login, 5-locale i18n, theme anti-flash, hash router, SSE store, sidebar/topbar/account switcher, Overview & Settings)` → `Page UI tickets (Accounts; Sessions & Forwards; Plugins, GGUF & Endpoints)`.
- The **foundation code ticket** removes the entire legacy `crates/web/assets/` directory (all 19 `.js` files, legacy `index.html`, old CSS copies) and `crates/web/tests/asset_lint.rs`, lands `crates/web/frontend/` scaffold + static checker + `crates/web/build.rs` + `assets.rs`/`http.rs` byte-asset support + `.github/workflows/ci.yml` + `docs/{USAGE,TESTING,RELEASING}.md`, and updates `ui_accounts.rs` / `ui_sessions.rs` / `ui_plugins.rs` to keep every real mock-server HTTP/SSE test intact while removing only obsolete assertions against deleted vanilla JS files.
- During the short window between the foundation ticket and the final UI ticket landing on `main`, unmigrated routes render no legacy JS (zero dual-track coexistence) and their browser behaviors are restored and verified explicitly by each owning UI ticket:
  - **Shell / Overview / Settings ticket**: Login, SSE reconnect, theme anti-flash, hash bookmark/refresh/back, Overview checklist & CLI install, Settings isolated defaults & About copyable config path.
  - **Accounts ticket**: clickable new-tab OAuth link (`target="_blank" rel="noopener noreferrer"`, no `window.open`), switch-impact checklist (tunnels, managed, unmanaged, unknown), and active/busy remove block explanations.
  - **Sessions ticket**: 15s countdown updates preserving input focus and draft state, Guard warnings/extend, New Session provision/cancel, Auto-stop dialogs, Forward bind policy/warnings/copy/open/close, Stop & Stop all and verify.
  - **Plugins ticket**: install preview/remove, HF token save/delete without echo, dynamic inputs (`secret` direct submit, `hf-model` search + GGUF fit), live stage/log/skipped notices, post-failure cleanup verification, and Endpoint cards (preserving custom manifest path/kind across re-bind, health badges, OpenAI cURL).

### CI Pipeline Integration

Update `.github/workflows/ci.yml` while keeping required check names (`Linux (fmt, clippy, test)`, `windows-latest (check, tests)`) unchanged:

- Add `web-frontend` job (`runs-on: ubuntu-latest`, `needs: changes`, `if: ${{ !cancelled() && needs.changes.outputs.code != 'false' }}`) installing Node 24 + pnpm, running `pnpm --dir crates/web/frontend install --frozen-lockfile`, `pnpm --dir crates/web/frontend run check`, and `pnpm --dir crates/web/frontend run build`, then uploading a named artifact containing `crates/web/frontend/dist/` (with `if-no-files-found: error`) and the generated i18n key manifest outside `dist/` (`.generated/i18n-keys.json`).
- Update both `linux` and headless container `web` (`rust:1.98-slim-bookworm`) jobs to declare `needs: [changes, web-frontend]` directly and keep `if: ${{ !cancelled() }}`. Handle all four branch outcomes explicitly:
  1. **Docs-only PR (`needs.changes.outputs.code == 'false'`)**: `web-frontend` is skipped; `linux` and `web` skip artifact download and Rust steps and exit green.
  2. **Code PR or push to `main` (`needs.changes.outputs.code != 'false'`)**: `web-frontend` builds once and uploads the artifact; both `linux` and `web` download it after `actions/checkout` into `crates/web/frontend/dist/` (verifying `dist/index.html` exists) and `.generated/i18n-keys.json`, then run their existing `--locked` Rust checks.
  3. **`changes` file-query failure or `changes` job failure**: treated as code change (`code != 'false'`), so `web-frontend`, `linux`, and `web` all execute instead of silently skipping.
  4. **`web-frontend` failure on a code change**: `linux` and `web` still run (never skipped into a false-green status) and immediately fail via an explicit guard step checking `needs.web-frontend.result == 'success'` when `needs.changes.outputs.code != 'false'`.
- `check` (`windows-latest`, `macos-latest`) only tests `colab-playground-core` and `colab-playground` and does not need the frontend artifact.

## Testing Decisions

A check is made once (`docs/TESTING.md`). We do not introduce Vitest or Playwright; verification stays cleanly divided across three non-overlapping seams:

1. **Frontend static & build seam (`pnpm --dir crates/web/frontend run check && pnpm --dir crates/web/frontend run build`)**:
   - `tsc --noEmit` verifies internal TypeScript consistency across frontend types, store, and components (runtime JSON compatibility with Rust is verified by the Rust HTTP/SSE suite and browser runs).
   - A TypeScript AST-based static script (`crates/web/frontend/scripts/check.mjs`, using the installed `typescript` compiler API) checks `index.html`, `public/theme-init.js`, and `src/` to enforce `docs/DESIGN.md` invariants:
     - zero `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `window.open(`;
     - zero inline `<script>` / `<style>`, inline `on*` event attributes, `style="..."`, or `javascript:` URLs in `index.html`;
     - zero hardcoded user-visible copy literals in JSX text nodes, text attributes (`aria-label`, `title`, `placeholder`, `alt`), or CSS `content` values;
     - zero hardcoded hex/rgb/hsl color literals in CSS property values or JSX style values outside `src/styles/tokens.css` and `public/favicon.svg`;
     - extracts all literal `t("...")` keys referenced in TS/TSX (requiring dynamic key maps to use explicit finite tables or server-provided keys) into `crates/web/frontend/.generated/i18n-keys.json` (kept outside public `dist/`).
   - `vite build` verifies clean production bundling with `assetsInlineLimit: 0`.
2. **Rust contract & end-to-end HTTP/SSE seam (`cargo test -p colab-playground-web --locked`)**:
   - `ui_shell.rs`:
     - verifies 5-locale `SHELL_CATALOGS` key parity, placeholder parity, and zero collision with `crate::i18n::dictionary`;
     - parses the built `/` HTML to extract every referenced `<script src>`, `<link rel="stylesheet" href>`, and `<link rel="icon" href>` URL, requests each plus `/favicon.ico` and every entry in `STATIC_ASSETS`, and asserts HTTP 200, expected `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'self'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and no `Set-Cookie`;
     - validates every key listed in `crates/web/frontend/.generated/i18n-keys.json` exists in the merged 5-locale `/assets/i18n/{locale}.json` dictionary (replacing the old raw JS string-slice loop).
   - `ui_accounts.rs`, `ui_sessions.rs`, `ui_plugins.rs`: retain all real mock-server HTTP/SSE end-to-end tests unchanged.
   - `crates/app/tests/lint.rs`: workspace OS-isolation lint continues covering `app`, `core`, `shared`, and `web`.
3. **Browser & visual verification seam (per UI ticket)**:
   - Run `colab-playground-web --mock --no-open` serving the built bundle and verify in a real browser:
     - zero CSP console errors;
     - cold reload anti-flash check (system light, saved dark);
     - direct `#/<route>` bookmark load, refresh, and browser back/forward;
     - dev proxy check (unauthenticated `/assets/i18n/en-US.json` GET, `/api/login` JSON POST, Bearer `/api/events` JSON POST receiving initial snapshot);
     - desktop and mobile screenshots in both light and dark themes plus interactive checks for focus/draft preservation, modals, and SSE reconnection.

## Out of Scope

- Changing `crates/core`, `crates/shared`, `crates/app` desktop UI, or `crates/web` backend API/SSE/auth/locking contracts (except adapting `assets.rs` / `http.rs` for byte-backed `Asset` and removing retired placeholder i18n keys).
- Introducing Tailwind CSS, third-party UI kits (shadcn, MUI, Ant Design), or frontend test runners (Vitest, Jest, Playwright).
- Redesigning the visual system or adding Roadmap features not present in the desktop app (`docs/ROADMAP.md`).
- Changing `.github/workflows/package.yml` desktop release packaging or `main` ruleset required check names.

## Further Notes

- **Documentation truthfulness**: `docs/USAGE.md`, `docs/TESTING.md`, and `docs/RELEASING.md` are updated in the foundation code ticket that lands `crates/web/frontend/` and `build.rs`, keeping documented commands truthful to checked-in code (`docs/DEVELOPMENT.md#docs-and-comments`). Note that the docs-only PR landing this Spec is skipped by CI's `changes` filter, so the new `web-frontend` → `linux` / `web` CI pipeline is first exercised live by the foundation code PR.
- **ADR lineage**: ADR-0002 is marked `superseded by ADR-0005` rather than deleted; `GLOSSARY.md` needs no edits because domain vocabulary is independent of frontend tooling.
- **Hard safety rules**: All development, verification, and browser checks run strictly against `--mock` Demo data and never invoke real `colab` commands (`docs/DESIGN.md#hard-safety-rules`).
