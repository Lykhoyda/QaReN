use crate::exec::CmdOutput;
use crate::failure::{Failure, FailureCode};

pub(crate) const CLIENT_TIMEOUT_MS: u64 = 10_000;
pub(crate) const MAX_ATTEMPTS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeProbe {
    Ready,
    Stalled,
    TimedOut,
    Rejected,
    Unavailable,
    SyncRejected,
    SyncUnavailable,
}

impl VolumeProbe {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Stalled => "stalled",
            Self::TimedOut => "timed_out",
            Self::Rejected | Self::SyncRejected => "rejected",
            Self::Unavailable | Self::SyncUnavailable => "unavailable",
        }
    }

    pub(crate) fn reason(self) -> &'static str {
        match self {
            Self::Ready => "watchman observed a sync cookie within 4 s for the candidate watch root",
            Self::Stalled => "watchman accepted the candidate root but did not observe a sync cookie within 4 s: the file watcher is stalled or still crawling the root",
            Self::TimedOut => "watchman watch-project did not answer within 5 s for the candidate volume",
            Self::Rejected => "watchman rejected watch-project for the candidate directory; raw output withheld",
            Self::Unavailable => "watchman volume admission is unknown; the service is unavailable or its response is invalid",
            Self::SyncRejected => "watchman rejected the sync for the candidate watch root; raw output withheld",
            Self::SyncUnavailable => "watchman sync is unknown; the service did not answer the sync within its limit or its response is invalid",
        }
    }

    pub(crate) fn stalled_fix() -> String {
        format!("the sync cookie was not observed: {}; if fseventsd is busy, wait for other watchers or large copies to finish, or coordinate a watchman reset with other sessions, then re-run once", crate::failure::WATCHMAN_VOLUME_FIX)
    }
}

pub(crate) struct Warmup {
    pub deadline_ms: u64,
    pub attempts: usize,
    started_ms: u64,
    answers_ms: Vec<u64>,
    timeouts: usize,
    consecutive: usize,
    ios: bool,
    pub request_probe_timed_out: bool,
    pub request_probe_limit_ms: u64,
    pub watchman_volume_probe: Option<VolumeProbe>,
    pub slow_volume: bool,
    pub expo_online: bool,
    // The app embeds the fingerprint runtimeVersion policy and the dev server never served the pin: the pin state.
    pub fingerprint_pin: Option<&'static str>,
}

impl Warmup {
    pub fn new(now: u64, seconds: u64, preparation_deadline: u64, ios: bool) -> Self {
        Self {
            deadline_ms: preparation_deadline.min(now.saturating_add(seconds.saturating_mul(1000))),
            attempts: 0,
            started_ms: now,
            answers_ms: Vec::new(),
            timeouts: 0,
            consecutive: 0,
            ios,
            request_probe_timed_out: false,
            request_probe_limit_ms: 0,
            watchman_volume_probe: None,
            slow_volume: false,
            expo_online: false,
            fingerprint_pin: None,
        }
    }

    pub fn observe(&mut self, output: &CmdOutput) {
        self.attempts += 1;
        self.timeouts += usize::from(output.timed_out);
        if output.ok() {
            self.answers_ms.push(output.duration_ms);
        }
        let margin = if self.ios {
            CLIENT_TIMEOUT_MS / 2
        } else {
            CLIENT_TIMEOUT_MS
        };
        self.consecutive = if output.ok() && output.duration_ms < margin {
            self.consecutive + 1
        } else {
            0
        };
    }

    pub fn ready(&self, now: u64) -> bool {
        now < self.deadline_ms && self.consecutive >= if self.ios { 2 } else { 1 }
    }

    pub fn can_probe(&self, now: u64) -> bool {
        self.attempts < MAX_ATTEMPTS && self.deadline_ms.saturating_sub(now) >= 1000
    }

    pub fn elapsed_ms(&self, now: u64) -> u64 {
        now.saturating_sub(self.started_ms)
    }

    pub fn summary(&self) -> String {
        let mut answers = self.answers_ms.clone();
        answers.sort_unstable();
        let median = match answers.len() {
            0 => "none".to_string(),
            n if n % 2 == 0 => ((answers[n / 2 - 1] + answers[n / 2]) / 2).to_string(),
            n => answers[n / 2].to_string(),
        };
        format!(
            "attempts={}; timeouts={}; successful_answers={}; median_answer_ms={median}; min_answer_ms={}; max_answer_ms={}; client_timeout_ms={CLIENT_TIMEOUT_MS}; request_probe_timed_out={}; request_probe_limit_ms={}; watchman_volume_probe={}",
            self.attempts, self.timeouts, answers.len(),
            answers.first().map_or("none".into(), u64::to_string),
            answers.last().map_or("none".into(), u64::to_string),
            self.request_probe_timed_out, self.request_probe_limit_ms, self.watchman_volume_probe.map_or("not_run", VolumeProbe::as_str),
        )
    }

    fn median_answer_ms(&self) -> Option<u64> {
        let mut answers = self.answers_ms.clone();
        answers.sort_unstable();
        match answers.len() {
            0 => None,
            n if n % 2 == 0 => Some((answers[n / 2 - 1] + answers[n / 2]) / 2),
            n => Some(answers[n / 2]),
        }
    }

    pub fn refusal(&self) -> Failure {
        let mut next = if self.watchman_volume_probe == Some(VolumeProbe::Stalled) {
            VolumeProbe::stalled_fix()
        } else if matches!(
            self.watchman_volume_probe,
            Some(VolumeProbe::TimedOut | VolumeProbe::Rejected | VolumeProbe::SyncRejected)
        ) {
            crate::failure::WATCHMAN_VOLUME_FIX.to_string()
        } else if self.request_probe_timed_out && self.request_probe_limit_ms == 15_000 {
            "Metro answered /status but not its request handler within 15 s: the dev server is still starting or its file watcher is stalled; check the candidate volume and qaren doctor, reset watchman after coordinating other sessions, re-run once".to_string()
        } else {
            "run qaren doctor and check the candidate volume and watchman health, then re-run once"
                .to_string()
        };
        if self.expo_online
            && self.answers_ms.len() >= 3
            && self
                .median_answer_ms()
                .is_some_and(|ms| (25_000..=35_000).contains(&ms))
        {
            next.push_str("; a median answer near 30 s at low host load can mean Metro's manifest handler is waiting on an external service");
        }
        if self.expo_online {
            next.push_str("; unset EXPO_OFFLINE to restore EXPO_OFFLINE=1, then re-run once");
        }
        if self.slow_volume {
            next.push_str("; ");
            next.push_str(crate::volume::SLOW_VOLUME_FIX);
        }
        let mut reason = match self.watchman_volume_probe {
            Some(probe @ (VolumeProbe::Stalled | VolumeProbe::TimedOut | VolumeProbe::Rejected | VolumeProbe::SyncRejected)) => probe.reason().to_string(),
            _ => format!("dev client manifest did not warm within its stage budget or {MAX_ATTEMPTS}-attempt cap"),
        };
        if let Some(pin) = self.fingerprint_pin {
            reason = format!("the app's embedded runtimeVersion policy is fingerprint, so every dev-client manifest request may recompute the project fingerprint; the measured answers below are judged against the 5 s warm criterion and the client's 10 s limit, and host load only multiplies that cost. {reason}");
            next = format!("QaReN could not pin the build's runtime version in its dev server (runtime_version.pin={pin}); pin a fixed runtimeVersion for development builds, or start your own dev server from a scratch copy with the resolved string; {next}");
        }
        Failure::new(
            "build",
            if self.watchman_volume_probe == Some(VolumeProbe::Stalled) {
                FailureCode::WatchmanVolumeStalled
            } else {
                FailureCode::ManifestNotWarm
            },
            format!("{reason}: {}; median successful answer is compared with the dev client's 10 s limit", self.summary()),
            next,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_runs_do_not_recommend_an_account_lookup_workaround() {
        let mut warm = Warmup::new(0, 420, 2_400_000, true);
        for duration_ms in [27_000, 30_000, 42_000] {
            warm.observe(&CmdOutput {
                duration_ms,
                ..CmdOutput::success("")
            });
        }
        assert!(!warm.refusal().next_action.contains("external service"));
        assert!(!warm.refusal().next_action.contains("EXPO_OFFLINE"));
        warm.expo_online = true;
        assert!(warm.refusal().next_action.contains("external service"));
        assert!(warm.refusal().next_action.contains("unset EXPO_OFFLINE"));
    }

    #[test]
    fn an_unpinned_fingerprint_policy_is_named_before_every_existing_hint() {
        let mut warm = Warmup::new(0, 420, 2_400_000, true);
        warm.expo_online = true;
        warm.slow_volume = true;
        for duration_ms in [5_000, 9_000, 7_000] {
            warm.observe(&CmdOutput {
                duration_ms,
                ..CmdOutput::success("")
            });
        }
        let plain = warm.refusal();
        assert!(!plain.detail.to_string().contains("fingerprint"));
        warm.fingerprint_pin = Some("written");
        let named = warm.refusal();
        let reason = named.detail.to_string();
        assert!(reason.starts_with("the app's embedded runtimeVersion policy is fingerprint"));
        assert!(reason.contains("median_answer_ms=7000"));
        assert!(named
            .next_action
            .starts_with("QaReN could not pin the build's runtime version in its dev server (runtime_version.pin=written)"));
        assert!(named.next_action.ends_with(plain.next_action.as_str()));
        assert_eq!(named.code, FailureCode::ManifestNotWarm);
        // No successful answer: the summary says so and no median is claimed.
        let mut silent = Warmup::new(0, 420, 2_400_000, true);
        silent.observe(&CmdOutput {
            timed_out: true,
            ..Default::default()
        });
        silent.fingerprint_pin = Some("unsupported");
        assert!(silent
            .refusal()
            .detail
            .to_string()
            .contains("median_answer_ms=none"));
    }

    #[test]
    fn a_shortened_request_probe_does_not_claim_a_fifteen_second_observation() {
        let mut warm = Warmup::new(0, 420, 10_000, true);
        warm.request_probe_timed_out = true;
        warm.request_probe_limit_ms = 10_000;
        assert!(!warm.refusal().next_action.contains("within 15 s"));
        assert!(!warm.can_probe(9_001));
        assert_eq!(warm.elapsed_ms(5000), 5000);
    }

    #[test]
    fn attempt_cap_bounds_zero_time_probes_and_preserves_the_platform_margin() {
        let mut warm = Warmup::new(0, 420, 2_400_000, true);
        for _ in 0..MAX_ATTEMPTS {
            warm.observe(&CmdOutput {
                timed_out: true,
                ..Default::default()
            });
        }
        assert!(!warm.can_probe(0));
        assert!(!warm.ready(0));
        let mut warm = Warmup::new(1000, 420, 50_000, false);
        warm.observe(&CmdOutput {
            duration_ms: 9999,
            ..CmdOutput::success("")
        });
        assert!(warm.ready(2000));
        assert!(!warm.ready(50_000));
        assert_eq!(warm.deadline_ms, 50_000);
    }
}
