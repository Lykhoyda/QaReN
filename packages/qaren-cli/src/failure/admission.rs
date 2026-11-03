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
    "react_readiness_timeout",
    "untyped",
    "none",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionFacts {
    pub attempt: u64,
    pub last_started: String,
    pub last_completed: String,
    pub inner: String,
    pub relaunches: u64,
    pub relaunch_failed: bool,
    pub liveness: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_request: Option<String>,
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
            && self.bundle_request.as_ref().is_none_or(|value| {
                ["received", "not_received", "unknown", "probe_failed"].contains(&value.as_str())
            })
            && [
                Some(self.attempt),
                Some(self.relaunches),
                Some(self.elapsed_ms),
                Some(self.remaining_ms),
                Some(self.budget_ms),
                self.attach_budget_ms,
                self.walk_budget_ms,
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
    ReactReadinessTimeout,
    AdmissionBudget,
    RunCancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionAction {
    UseDevelopmentBundle,
    InspectDevelopmentTarget,
    InspectBundleReadiness,
    InspectAdmissionBudget,
    StopAfterCancellation,
}

impl AdmissionCause {
    pub fn from_inner(inner: &str) -> Option<Self> {
        match inner {
            "non_dev_bundle" => Some(Self::NonDevBundle),
            "no_dev_target_unknown" => Some(Self::NoDevTargetUnknown),
            "react_readiness_timeout" => Some(Self::ReactReadinessTimeout),
            _ => None,
        }
    }

    pub fn action(self) -> (AdmissionAction, &'static str, &'static str) {
        use AdmissionAction::*;
        match self {
            Self::NonDevBundle => (UseDevelopmentBundle, "use_development_bundle", "The app's JS bundle was built without development mode; a dev-client build with __DEV__ true is required; check the launch URL and the build variant."),
            Self::NoDevTargetUnknown => (InspectDevelopmentTarget, "inspect_development_target", "Check the launch URL, target readiness and build variant; development mode could not be established."),
            Self::ReactReadinessTimeout => (InspectBundleReadiness, "inspect_bundle_readiness", "Inspect the recorded readiness stage and budgets; check that the selected development bundle starts React before retrying once."),
            Self::AdmissionBudget => (InspectAdmissionBudget, "inspect_admission_budget", "Inspect the last recorded admission stage, effective budgets and runtime identity before starting a changed run."),
            Self::RunCancelled => (StopAfterCancellation, "stop_after_cancellation", "Preserve cancellation and complete owned cleanup; do not resume the plan automatically."),
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
