//! Provisioning progress in words: attempt n of N, what hardware came back, why it was
//! rejected, the wait before retrying, the watchdog, ready or failed. Used by the New session
//! dialog, the Sessions page while the dialog is hidden, and plugin runs that provision.

use colab_playground_core::provision::ProvisionEvent;
use ely_gpui_component::{
    motion::Spinner,
    primitives::{Icon, IconName},
    theme::{ActiveTheme, IconSize, TextSize},
};
use gpui::{AnyElement, App, IntoElement, ParentElement, SharedString, Styled, div};

use crate::{
    errors, format,
    i18n::{keys, tr, tr_args},
    state::ProvisionProgress,
    ui::tagged,
};

/// Selector around the progress list.
pub const PROGRESS_SELECTOR: &str = "provision-progress";

/// The headline: attempt n of N (or "Starting…").
pub fn headline(progress: &ProvisionProgress, cx: &App) -> SharedString {
    match progress.attempt() {
        Some((attempt, of)) => tr_args(
            cx,
            keys::PROV_ATTEMPT,
            &[("n", &attempt.to_string()), ("of", &of.to_string())],
        ),
        None => tr(cx, keys::PROV_STARTING),
    }
}

/// One event as a sentence; `None` for events folded into others.
pub fn sentence(event: &ProvisionEvent, cx: &App) -> Option<(SharedString, Tone)> {
    let hardware = |gpu: &Option<String>, vram: &Option<u32>| {
        format::hardware(cx, gpu.as_deref(), *vram).unwrap_or_else(|| tr(cx, keys::PROV_NO_GPU))
    };
    Some(match event {
        ProvisionEvent::Allocating {
            attempt,
            max_attempts,
        } => (
            tr_args(
                cx,
                keys::PROV_ALLOCATING,
                &[
                    ("n", &attempt.to_string()),
                    ("of", &max_attempts.to_string()),
                ],
            ),
            Tone::Busy,
        ),
        ProvisionEvent::AllocationFailed { error, .. } => (
            tr_args(
                cx,
                keys::PROV_ALLOCATION_FAILED,
                &[("why", &errors::explain(error, false, cx).message)],
            ),
            Tone::Warn,
        ),
        ProvisionEvent::Probed { gpu, vram_mib, .. } => (
            tr_args(
                cx,
                keys::PROV_PROBED,
                &[("hardware", &hardware(gpu, vram_mib))],
            ),
            Tone::Info,
        ),
        ProvisionEvent::Rejected {
            vram_mib,
            min_vram_mib,
            ..
        } => (
            tr_args(
                cx,
                keys::PROV_REJECTED,
                &[
                    (
                        "got",
                        &vram_mib
                            .map_or_else(|| tr(cx, keys::SUMMARY_UNKNOWN), |m| format::vram(cx, m)),
                    ),
                    ("min", &format::vram(cx, *min_vram_mib)),
                ],
            ),
            Tone::Warn,
        ),
        ProvisionEvent::Releasing { .. } => (tr(cx, keys::PROV_RELEASING), Tone::Info),
        ProvisionEvent::OrphanDetected { released: true, .. } => {
            (tr(cx, keys::PROV_ORPHAN_RELEASED), Tone::Info)
        }
        ProvisionEvent::OrphanDetected {
            released: false, ..
        } => (tr(cx, keys::PROV_ORPHAN_LEFT), Tone::Bad),
        ProvisionEvent::Retrying { delay_secs, .. } => (
            tr_args(
                cx,
                keys::PROV_RETRYING,
                &[("time", &format::short_wait(cx, *delay_secs))],
            ),
            Tone::Busy,
        ),
        ProvisionEvent::WatchdogStarted { deadline: Some(_) } => {
            (tr(cx, keys::PROV_WATCHDOG), Tone::Good)
        }
        ProvisionEvent::WatchdogStarted { deadline: None } => {
            (tr(cx, keys::PROV_WATCHDOG_NO_DEADLINE), Tone::Good)
        }
        ProvisionEvent::WatchdogFailed { .. } => (tr(cx, keys::PROV_WATCHDOG_FAILED), Tone::Bad),
        ProvisionEvent::Ready {
            gpu,
            vram_mib,
            below_spec,
            ..
        } => (
            tr_args(
                cx,
                if *below_spec {
                    keys::PROV_READY_BELOW
                } else {
                    keys::PROV_READY
                },
                &[("hardware", &hardware(gpu, vram_mib))],
            ),
            if *below_spec { Tone::Warn } else { Tone::Good },
        ),
        // The dialog or run view explains a failure in an alert with its next step.
        ProvisionEvent::Failed { .. } => return None,
    })
}

/// How a line looks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    /// Under way (spinner while it is the last line).
    Busy,
    /// Plain information.
    Info,
    /// Went well.
    Good,
    /// Needs attention but continues.
    Warn,
    /// Went wrong.
    Bad,
}

/// The progress list; `live` shows a spinner on the last line while provisioning runs.
pub fn render(progress: &ProvisionProgress, live: bool, cx: &App) -> AnyElement {
    let theme = cx.theme();
    let colors = &theme.colors;
    let lines: Vec<(SharedString, Tone)> = progress
        .events
        .iter()
        .filter_map(|event| sentence(event, cx))
        .collect();
    let count = lines.len();
    let rows = lines.into_iter().enumerate().map(|(index, (text, tone))| {
        let last = index + 1 == count;
        let marker = if last && live && tone == Tone::Busy {
            Spinner::new(("provision-line", index))
                .size(IconSize::Sm)
                .into_any_element()
        } else {
            let (icon, color) = match tone {
                Tone::Busy | Tone::Info => (IconName::Dot, colors.fg_muted),
                Tone::Good => (IconName::CircleCheck, colors.success),
                Tone::Warn => (IconName::TriangleAlert, colors.warning),
                Tone::Bad => (IconName::CircleX, colors.danger),
            };
            Icon::new(icon)
                .size(IconSize::Sm)
                .color(color)
                .into_any_element()
        };
        div()
            .flex()
            .items_start()
            .gap_2()
            .text_size(theme.text_size(TextSize::Sm))
            .child(div().flex_none().pt_0p5().child(marker))
            .child(div().flex_1().min_w_0().child(text))
    });
    tagged(
        PROGRESS_SELECTOR,
        div().flex().flex_col().gap_1p5().children(rows),
    )
    .into_any_element()
}
