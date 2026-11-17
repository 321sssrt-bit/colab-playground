//! Headless UI tests: the real views under gpui's `TestAppContext`, mock backend only.
//!
//! One test binary on purpose: each extra `tests/*.rs` file links gpui and Ely again. Add new
//! UI test modules here and build them on `support::TestApp`.

mod support;

mod accounts;
mod defaults;
mod fonts;
mod harness;
mod navigation;
mod overview;
mod plugins;
mod sessions;
mod settings_page;
mod titlebar;
mod updates;
mod usage;
