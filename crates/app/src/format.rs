//! Numbers, durations and ages in the shown language.

use std::time::{Duration, SystemTime};

use colab_playground_core::{backend::InstallMethod, sessions::Accelerator};
use ely_gpui_component::i18n::I18n;
use gpui::{App, SharedString};

use crate::i18n::{keys, tr, tr_args};

/// `value` with the shown locale's separators and `decimals` places.
pub fn number(cx: &App, value: f64, decimals: usize) -> String {
    cx.global::<I18n>().locale().number(value, decimals)
}

/// Compute units, such as `87.5 CU`.
pub fn cu(cx: &App, value: f64) -> SharedString {
    tr_args(cx, keys::FMT_CU, &[("value", &number(cx, value, 1))])
}

/// A burn rate, such as `1.2 CU/h`.
pub fn cu_rate(cx: &App, value: f64) -> SharedString {
    tr_args(cx, keys::FMT_CU_RATE, &[("value", &number(cx, value, 2))])
}

/// An estimate, marked `≈`.
pub fn approx(cx: &App, value: &str) -> SharedString {
    tr_args(cx, keys::FMT_APPROX, &[("value", value)])
}

/// A duration in words, rounded to minutes (days and hours past a day).
pub fn duration(cx: &App, duration: Duration) -> SharedString {
    let minutes = duration.as_secs() / 60;
    let (days, hours, mins) = (minutes / 1440, minutes / 60 % 24, minutes % 60);
    if days > 0 {
        tr_args(
            cx,
            keys::FMT_DAYS_HOURS,
            &[("d", &days.to_string()), ("h", &hours.to_string())],
        )
    } else if hours > 0 {
        tr_args(
            cx,
            keys::FMT_HOURS_MINUTES,
            &[("h", &hours.to_string()), ("m", &mins.to_string())],
        )
    } else if mins > 0 {
        tr_args(cx, keys::FMT_MINUTES, &[("m", &mins.to_string())])
    } else {
        tr(cx, keys::FMT_UNDER_MINUTE)
    }
}

/// How long ago `then` was at `now` (both on the backend's clock).
pub fn age(cx: &App, then: SystemTime, now: SystemTime) -> SharedString {
    let minutes = now.duration_since(then).unwrap_or_default().as_secs() / 60;
    match minutes {
        0 => tr(cx, keys::FMT_JUST_NOW),
        1..60 => tr_args(cx, keys::FMT_MINUTES_AGO, &[("n", &minutes.to_string())]),
        60..1440 => tr_args(
            cx,
            keys::FMT_HOURS_AGO,
            &[("n", &(minutes / 60).to_string())],
        ),
        _ => tr_args(
            cx,
            keys::FMT_DAYS_AGO,
            &[("n", &(minutes / 1440).to_string())],
        ),
    }
}

/// Items joined with the language's list separator.
pub fn list(cx: &App, items: &[String]) -> String {
    items.join(&tr(cx, keys::FMT_LIST_SEPARATOR))
}

/// The catalog key of an accelerator's name.
pub fn accelerator_key(accelerator: Accelerator) -> &'static str {
    match accelerator {
        Accelerator::None => keys::ACC_NONE,
        Accelerator::T4 => keys::ACC_T4,
        Accelerator::L4 => keys::ACC_L4,
        Accelerator::G4 => keys::ACC_G4,
        Accelerator::A100 => keys::ACC_A100,
        Accelerator::H100 => keys::ACC_H100,
        Accelerator::TpuV5e1 => keys::ACC_V5E1,
        Accelerator::TpuV6e1 => keys::ACC_V6E1,
    }
}

/// The catalog key of an install method's name.
pub fn install_method_key(method: InstallMethod) -> &'static str {
    match method {
        InstallMethod::Uv => keys::INSTALL_UV,
        InstallMethod::InstallUvThenCli => keys::INSTALL_UV_FIRST,
        InstallMethod::PipUser => keys::INSTALL_PIP,
    }
}

/// A stable value for an install method (select values, selectors).
pub fn install_method_value(method: InstallMethod) -> &'static str {
    match method {
        InstallMethod::Uv => "uv",
        InstallMethod::InstallUvThenCli => "uv-first",
        InstallMethod::PipUser => "pip",
    }
}
