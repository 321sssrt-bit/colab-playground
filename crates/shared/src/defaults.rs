use std::time::Duration;

use colab_playground_core::{Defaults, provision::MAX_ATTEMPTS_CAP};

/// The shortest duration a defaults field accepts (zero would disable or spin).
pub const MIN_DURATION: Duration = Duration::from_secs(1);

pub fn sanitize(mut defaults: Defaults) -> Defaults {
    let positive = |d: Duration| d.max(MIN_DURATION);
    defaults.max_runtime = defaults.max_runtime.map(positive);
    defaults.idle_timeout = defaults.idle_timeout.map(positive);
    defaults.retry_delay = positive(defaults.retry_delay);
    defaults.usage_poll_active = positive(defaults.usage_poll_active);
    defaults.usage_poll_idle = positive(defaults.usage_poll_idle);
    defaults.max_attempts = defaults.max_attempts.clamp(1, MAX_ATTEMPTS_CAP);
    defaults.max_concurrent_sessions = defaults.max_concurrent_sessions.max(1);
    defaults.max_spend_cu = defaults.max_spend_cu.map(|cu| cu.max(0.0));
    defaults.min_balance_cu = defaults.min_balance_cu.map(|cu| cu.max(0.0));
    defaults
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use colab_playground_core::{Defaults, provision::MAX_ATTEMPTS_CAP};

    use super::{MIN_DURATION, sanitize};

    #[test]
    fn defaults_stay_sane() {
        let wild = Defaults {
            max_runtime: Some(Duration::ZERO),
            retry_delay: Duration::ZERO,
            max_attempts: 99,
            max_concurrent_sessions: 0,
            max_spend_cu: Some(-3.0),
            ..Defaults::default()
        };
        let sane = sanitize(wild);
        assert_eq!(sane.max_runtime, Some(MIN_DURATION));
        assert_eq!(sane.retry_delay, MIN_DURATION);
        assert_eq!(sane.max_attempts, MAX_ATTEMPTS_CAP);
        assert_eq!(sane.max_concurrent_sessions, 1);
        assert_eq!(sane.max_spend_cu, Some(0.0));
        assert_eq!(sanitize(Defaults::default()), Defaults::default());
    }
}
