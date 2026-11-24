use super::RecoveryRung;
use serde::{Deserialize, Serialize};

pub(crate) const BOUNDARIES: &[&str] = &[
    "attach",
    "bundle_ready",
    "foreign_driver",
    "open",
    "prove",
    "relaunch",
    "retry_wait",
];
pub(crate) const INNER: &[&str] = &[
    "target_selection_platform_not_found",
    "target_selection_platform_conflict",
    "target_selection_device_not_found",
    "target_selection_device_ambiguous",
    "target_selection_bundle_not_found",
    "target_list_attempt_timeout",
    "target_readiness_timeout",
    "target_list_empty",
    "target_other_device",
    "bundle_readiness_timeout",
    "cdp_probe_timeout",
    "cdp_handshake_timeout",
    "cdp_target_closed",
    "cdp_request_timeout",
    "non_dev_bundle",
    "no_dev_target_unknown",
    "dev_runtime_unproven",
    "react_readiness_timeout",
    "untyped",
    "none",
];
pub(crate) const BUNDLE_BUILT: &[&str] = &["completed", "failed", "none", "unknown"];
pub(crate) const RELAUNCH_BLOCKED: &[&str] = &["driver_busy", "device_unreadable"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionFacts {
    pub attempt: u64,
    pub last_started: String,
    pub last_completed: String,
    pub inner: String,
    pub relaunches: u64,
    pub relaunch_failed: bool,
    // Android: why the one restart was not attempted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaunch_blocked: Option<String>,
    pub liveness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_request: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_built: Option<String>,
    pub elapsed_ms: u64,
    pub remaining_ms: u64,
    pub budget_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attach_budget_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub walk_budget_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub targets_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_true: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_false: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_undefined: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_unknown: Option<u64>,
    // Absent means unknown: no device pin, or the latest target-list read failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreign_pages: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_name_devices: Option<u64>,
}

impl AdmissionFacts {
    pub fn valid(&self) -> bool {
        let counts = [
            self.targets_total,
            self.dev_true,
            self.dev_false,
            self.dev_undefined,
            self.dev_unknown,
        ];
        BOUNDARIES.contains(&self.last_started.as_str())
            && (self.last_completed == "none" || BOUNDARIES.contains(&self.last_completed.as_str()))
            && INNER.contains(&self.inner.as_str())
            && ["not_probed", "alive", "dead", "probe_failed"].contains(&self.liveness.as_str())
            && self
                .relaunch_blocked
                .as_ref()
                .is_none_or(|value| RELAUNCH_BLOCKED.contains(&value.as_str()))
            && self.bundle_request.as_ref().is_none_or(|value| {
                ["received", "not_received", "unknown", "probe_failed"].contains(&value.as_str())
            })
            && self
                .bundle_built
                .as_ref()
                .is_none_or(|value| BUNDLE_BUILT.contains(&value.as_str()))
            && [
                Some(self.attempt),
                Some(self.relaunches),
                Some(self.elapsed_ms),
                Some(self.remaining_ms),
                Some(self.budget_ms),
                self.attach_budget_ms,
                self.walk_budget_ms,
                self.foreign_pages,
                self.same_name_devices,
            ]
            .into_iter()
            .chain(counts)
            .flatten()
            .all(|n| n <= 9_007_199_254_740_991)
            && (counts.iter().all(Option::is_none)
                || (counts.iter().all(Option::is_some)
                    && self.targets_total == Some(counts[1..].iter().flatten().sum())))
    }

    pub fn all_false(&self) -> bool {
        self.inner == "non_dev_bundle"
            && self.targets_total.is_some_and(|n| n > 0)
            && self.dev_false == self.targets_total
            && self.dev_true == Some(0)
            && self.dev_undefined == Some(0)
            && self.dev_unknown == Some(0)
    }

    pub fn deserialize_optional<'de, D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Self>, D::Error> {
        let facts = Option::<Self>::deserialize(deserializer)
            .map_err(|_| serde::de::Error::custom("invalid admission facts"))?;
        if facts.as_ref().is_some_and(|facts| !facts.valid()) {
            return Err(serde::de::Error::custom("invalid admission facts"));
        }
        Ok(facts)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionCause {
    NonDevBundle,
    NoDevTargetUnknown,
    DevRuntimeUnproven,
    ReactReadinessTimeout,
    AdmissionBudget,
    RunCancelled,
    AppProcessDead,
    AttachBudgetAfterConnect,
    BundleNotRequested,
    BundleNotBuilt,
    NoAttachableTarget,
    AttachUnexplained,
    AppRestartBlockedByDriver,
    AppRestartBlockedUnreadable,
    AppRestartFailed,
    AppProcessDeadAfterRestart,
    BundleNotRequestedAfterRestart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionAction {
    UseDevelopmentBundle,
    InspectDevelopmentTarget,
    InspectBundleReadiness,
    InspectAdmissionBudget,
    StopAfterCancellation,
    InspectAppCrash,
    RetryAttachOnce,
    RetryLaunchOnce,
    InspectMetroBundle,
    InspectAppScreen,
    InspectAdmissionEvidence,
    WaitForOtherDriver,
    CheckDeviceConnection,
    CheckMetroReachable,
}

impl AdmissionCause {
    pub fn from_inner(inner: &str) -> Option<Self> {
        match inner {
            "non_dev_bundle" => Some(Self::NonDevBundle),
            "no_dev_target_unknown" => Some(Self::NoDevTargetUnknown),
            "dev_runtime_unproven" => Some(Self::DevRuntimeUnproven),
            "react_readiness_timeout" => Some(Self::ReactReadinessTimeout),
            _ => None,
        }
    }

    // Android refusals carry the app's process and Metro's counts, so every end state gets a cause.
    pub fn from_facts(facts: &AdmissionFacts, android: bool) -> Option<Self> {
        if !android || facts.inner == "non_dev_bundle" {
            return Self::from_inner(&facts.inner);
        }
        match facts.relaunch_blocked.as_deref() {
            Some("driver_busy") => return Some(Self::AppRestartBlockedByDriver),
            Some(_) => return Some(Self::AppRestartBlockedUnreadable),
            None => {}
        }
        if facts.relaunch_failed {
            return Some(Self::AppRestartFailed);
        }
        let restarted = facts.relaunches > 0;
        if facts.liveness == "dead" {
            return Some(if restarted {
                Self::AppProcessDeadAfterRestart
            } else {
                Self::AppProcessDead
            });
        }
        if let Some(cause) = Self::from_inner(&facts.inner) {
            return Some(cause);
        }
        if matches!(
            facts.last_started.as_str(),
            "foreign_driver" | "open" | "prove"
        ) {
            return Some(Self::AttachBudgetAfterConnect);
        }
        if !matches!(
            facts.inner.as_str(),
            "target_readiness_timeout" | "target_list_empty" | "target_other_device"
        ) {
            return Some(Self::AttachUnexplained);
        }
        Some(
            match (
                facts.bundle_request.as_deref(),
                facts.bundle_built.as_deref(),
            ) {
                (Some("not_received"), _) if restarted => Self::BundleNotRequestedAfterRestart,
                (Some("not_received"), _) => Self::BundleNotRequested,
                (Some("received"), Some("none" | "failed")) => Self::BundleNotBuilt,
                _ => Self::NoAttachableTarget,
            },
        )
    }

    pub fn action(self) -> (AdmissionAction, &'static str, &'static str) {
        use AdmissionAction::*;
        match self {
            Self::NonDevBundle => (UseDevelopmentBundle, "use_development_bundle", "The app's JS bundle was built without development mode; a dev-client build with __DEV__ true is required; check the launch URL and the build variant."),
            Self::NoDevTargetUnknown => (InspectDevelopmentTarget, "inspect_development_target", "Check the launch URL, target readiness and build variant; development mode could not be established."),
            // Same next action: the page was advertised but never ran a bundle that proved development mode.
            Self::DevRuntimeUnproven => (InspectDevelopmentTarget, "inspect_development_target", "The app's page never proved development mode; bundleRequest and bundleBuilt are port-wide Metro context (any device on the port), not proof of this app's bundle; check Metro's output and the build variant, then retry once."),
            Self::ReactReadinessTimeout => (InspectBundleReadiness, "inspect_bundle_readiness", "Inspect the recorded readiness stage and budgets; check that the selected development bundle starts React before retrying once."),
            Self::AdmissionBudget => (InspectAdmissionBudget, "inspect_admission_budget", "Inspect the last recorded admission stage, effective budgets and runtime identity before starting a changed run."),
            Self::RunCancelled => (StopAfterCancellation, "stop_after_cancellation", "Preserve cancellation and complete owned cleanup; do not resume the plan automatically."),
            Self::AppProcessDead => (InspectAppCrash, "inspect_app_crash", "The app's process was not running when the attach was refused. Read the device's crash log for the app, then re-run once."),
            Self::AttachBudgetAfterConnect => (RetryAttachOnce, "retry_attach_once", "The debugger was attached and React was ready; a deadline ended in a later step. Re-run once; if it repeats and the walk budget was not spent, raise `deadlines.attach_seconds`."),
            Self::BundleNotRequested => (RetryLaunchOnce, "retry_launch_once", "At the count check, Metro had recorded no bundle request on this port since the launch, and no wait had returned a debugger target. If the device shows the dev client's own launcher, re-run once; if it repeats, check that the device reaches Metro."),
            Self::BundleNotBuilt => (InspectMetroBundle, "inspect_metro_bundle", "A bundle request and no completed build had been recorded on this Metro port since the launch, and no wait had returned a debugger target. Read `logs/metro.log` in the run folder; fix a failed build, or re-run once."),
            Self::NoAttachableTarget => (InspectAppScreen, "inspect_app_screen", "The attach ended without a usable debugger connection to the app. Look at the device for an error screen or a system dialog, then re-run once."),
            Self::AttachUnexplained => (InspectAdmissionEvidence, "inspect_admission_evidence", "The attach was refused for the recorded class. Read the admission facts and `logs/core.log`, then re-run once."),
            Self::AppRestartBlockedByDriver => (WaitForOtherDriver, "wait_for_other_driver", "QaReN did not restart the app: the device's process table matched another automation driver (UIAutomator, Maestro, agent-device or an instrumentation), and a force-stop could break its flow. Check whether an automation driver is active on the device; if so, re-run once it finishes. If none is active and the match persists, report it with the run ID."),
            Self::AppRestartBlockedUnreadable => (CheckDeviceConnection, "check_device_connection", "QaReN did not restart the app: the device did not answer the reads QaReN needs before a force-stop (its process table, or the app's process). Check that the device is connected and answers adb, then re-run once."),
            Self::AppRestartFailed => (CheckDeviceConnection, "check_device_connection", "QaReN's one restart of the app (a force-stop, then the same start command) did not complete, so the app may be stopped on the device. Check that the device is connected and answers adb, then re-run once."),
            Self::AppProcessDeadAfterRestart => (InspectAppCrash, "inspect_app_crash", "QaReN stopped the app and issued one recovery start command; the app's process was not running when the attach was refused. Read the device's crash log for the app; if it shows no crash, check that the start opens the app on the device, then re-run once."),
            Self::BundleNotRequestedAfterRestart => (CheckMetroReachable, "check_metro_reachable", "QaReN stopped the app and issued one recovery start command; at the count check after it, Metro had still recorded no bundle request on this port, and no wait had returned a debugger target. Check that the device reaches Metro on the run's port and that the dev client leaves its own launcher, then re-run once."),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdmissionRecovery {
    pub cause: AdmissionCause,
    pub action: AdmissionAction,
    pub instruction: String,
    pub next_rung: Option<u8>,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
    pub automatic: bool,
    pub ladder: Vec<RecoveryRung>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "AdmissionFacts::deserialize_optional"
    )]
    pub admission: Option<AdmissionFacts>,
}

impl AdmissionRecovery {
    pub fn new(cause: AdmissionCause, admission: Option<AdmissionFacts>) -> Self {
        let non_dev = cause == AdmissionCause::NonDevBundle;
        let cancelled = cause == AdmissionCause::RunCancelled;
        let (action, _, instruction) = cause.action();
        let first = if non_dev {
            "An unchanged retry cannot repair bundle mode; correct the build variant before starting a changed run; a build requires separate authorization."
        } else if cancelled {
            "A retry cannot help a cancelled run; do not resume automatically."
        } else {
            "Inspect the terminal admission evidence; only an explicitly initiated changed run gets a new budget."
        };
        let restart = if non_dev {
            "Only restart the owned app and Metro after proving stale Metro served the wrong bundle; obtain approval for volatile state loss."
        } else {
            "Only restart the owned stale app, Metro or runner after evidence proves a stale launch or resource; obtain approval for volatile state loss."
        };
        Self {
            cause,
            action,
            instruction: instruction.to_string(),
            next_rung: if non_dev || cancelled { None } else { Some(1) },
            destroys_state: false,
            requires_user_ok: false,
            automatic: false,
            admission,
            ladder: vec![
                RecoveryRung::step(1, !non_dev && !cancelled, false, first),
                RecoveryRung::step(2, !cancelled, true, restart),
                RecoveryRung::step(
                    3,
                    !non_dev && !cancelled,
                    true,
                    if non_dev {
                        "A device restart cannot repair bundle mode."
                    } else {
                        "Restart the selected device only for a proven device fault, with approval for state loss."
                    },
                ),
                RecoveryRung::step(
                    4,
                    !non_dev && !cancelled,
                    true,
                    if non_dev {
                        "Rebuilding unchanged native inputs cannot repair bundle mode."
                    } else {
                        "Rebuild only for a proven native mismatch, with approval for state loss; a JS startup fault survives unchanged resets."
                    },
                ),
                RecoveryRung::step(
                    5,
                    !non_dev,
                    true,
                    if non_dev {
                        "Cleanup and fresh prepare cannot repair unchanged bundle mode."
                    } else if cancelled {
                        "Only if cleanup is unresolved: complete this run's owned cleanup with ownership proof and approval for state loss."
                    } else {
                        "As a last resource reset, clean only this run's proven resources, then fresh prepare with approval for state loss; this cannot guarantee repairing an unknown app or build cause."
                    },
                ),
            ],
        }
    }
}
