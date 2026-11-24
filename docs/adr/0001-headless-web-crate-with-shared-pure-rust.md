---
status: proposed
---

# 0001: Separate headless `crates/web` binary with a pure-Rust `crates/shared` layer

## Context and Decision

We are adding a headless, CLI-launched web edition (`colab-playground-web`) to a fork of `colab-playground` so headless Linux servers without X11/Wayland/GPU desktop libraries can run the same app remotely. Rather than adding a `web` subcommand inside `crates/app` (which would force headless builds to pull GPUI/Wayland/X11 dependencies) or copying settings, translations, and argument parsing into `crates/web`, we add two workspace crates:

- `crates/shared`: extracts **pure data and pure rules only** from `crates/app` — the 5-locale `MESSAGES` tables and `keys`, `Language`/`resolve`/`fill_lenient`, `Settings` persistence (`settings.json`), pure error-to-`(key, args, hint, next_step)` mapping, `--mock`/`--real` backend source resolution with a caller-supplied allowlist for extra CLI flags, and pure helpers such as operation dedupe keys (`key_of`) and defaults sanitization.
- `crates/web`: builds an independent headless binary `colab-playground-web` depending only on `colab-playground-core` and `colab-playground-shared`.

Desktop-specific GPUI/Ely wrappers (`tr`, `explain`, `format::*`, `catalog`, `platform`) remain thin adapters in `crates/app` so desktop call sites stay unchanged.

## Considered Options

- **Add `colab-playground web` subcommand inside `crates/app`**: keeps one binary, but drags desktop windowing libraries into headless Linux builds and complicates conditional compilation.
- **Keep `crates/app` completely untouched and duplicate settings/i18n in `crates/web`**: minimizes diff against `crates/app`, but creates two drifting copies of 5-language catalogs and `settings.json` parsing.

## Consequences

- `cargo build -p colab-playground-web` succeeds on headless Linux with zero X11, Wayland, or GPUI dependencies, and serves as the primary headless build check in CI.
- **Accepted dual orchestration**: `crates/app/src/state/*` is tightly coupled to GPUI `Context<Self>` and timers and cannot be shared directly. `crates/web` therefore maintains its own thin async state orchestrator aligned to `app/state` behavior (scheduling, locking, and event broadcast only — no duplicated business math).
- `crates/app/src/i18n/tests.rs` is split so locale key-parity tests live in `crates/shared`, while Ely catalog checks and desktop source key scans remain in `crates/app`. `crates/web` supplies 5-locale translations for basic UI controls previously covered by Ely's built-in catalog.
- Workspace discipline checks (`crates/app/tests/lint.rs` OS-home scans) and CI workflows are extended to cover `crates/shared` and `crates/web`, while `crates/app/clippy.toml` remains scoped to desktop Ely rules.
- Separating the git checkout into its own local workspace isolates source code only; desktop and web builds still target the same OS app data directory and machine-wide CLI credential slot unless overridden via `COLAB_PLAYGROUND_CONFIG_DIR` (see ADR-0004 for single-instance locking).
