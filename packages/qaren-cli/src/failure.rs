use crate::redact::OutputText;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailureCode {
    ScenarioUnreadable,
    ScenarioInvalid,
    ScenarioSchemaUnsupported,
    CandidatePathInvalid,
    CandidateGitUnavailable,
    CandidateRevisionMismatch,
    CandidateDrifted,
    PrereqMissing,
    PnpmProcessGroupUnsupported,
    PnpmProbeTimedOut,
    MetroPortOccupied,
    RunAlreadyExists,
    RunRecordUnavailable,
    RunRecordInvalid,
    RunRecordUpdateFailed,
    SimulatorCreateFailed,
    SimulatorBootFailed,
    FarmUnreachable,
    FarmSlotLeased,
    FarmStartFailed,
    TunnelFailed,
    AdbServerFailed,
    AdbConnectFailed,
    DepsInstallFailed,
    DepsNotPrewarmed,
    NativeInputUnreadable,
    BuildContended,
    DeviceClaimContended,
    DeviceUnavailable,
    LaneNotWarm,
    DevClientSchemeRequired,
    IosBuildCapabilityUnavailable,
    ArtifactInstallFailed,
    BuildFailed,
    ReadyDeadlineExceeded,
    AppExitedAtLaunch,
    OwnershipUnproven,
    AppRemovalNotConfirmed,
    CleanupIncomplete,
    Interrupted,
    HandoffNotPending,
    HandoffEvidenceMissing,
    HandoffEvidenceAmbiguous,
    HandoffEvidenceMismatch,
    DeviceBusy,
    RunCancelled,
    FreshInstallAdmissionUnknown,
    AppPresenceUnknown,
    AppResetFailed,
    PlanUnparseable,
    PlanInputMissing,
    NodeUnsupported,
    DiskBudgetExceeded,
    PlatformUnsupported,
    CoreSpawnFailed,
    CoreResultMissing,
    WalkDeadlineExceeded,
    PlanStepFailed,
    MetroOriginMismatch,
    CoreRefused,
    BlockStartMissing,
    JevUnreachable,
    JevAuthFailed,
    JevRequestInvalid,
    PrUnavailable,
    GithubAuthUnavailable,
    PrWorktreeFailed,
    PublishFailed,
}

impl FailureCode {
    // Refusals exit 4 rather than claiming an app failure.
    pub fn is_refusal(&self) -> bool {
        matches!(
            self,
            FailureCode::DepsNotPrewarmed
                | FailureCode::PnpmProcessGroupUnsupported
                | FailureCode::PnpmProbeTimedOut
                | FailureCode::DeviceClaimContended
                | FailureCode::DeviceUnavailable
                | FailureCode::LaneNotWarm
                | FailureCode::BuildContended
                | FailureCode::OwnershipUnproven
                | FailureCode::HandoffNotPending
                | FailureCode::HandoffEvidenceMissing
                | FailureCode::HandoffEvidenceAmbiguous
                | FailureCode::HandoffEvidenceMismatch
                | FailureCode::DeviceBusy
                | FailureCode::RunCancelled
                | FailureCode::DevClientSchemeRequired
                | FailureCode::IosBuildCapabilityUnavailable
                | FailureCode::FreshInstallAdmissionUnknown
                | FailureCode::AppPresenceUnknown
                | FailureCode::PlanInputMissing
                | FailureCode::PlanUnparseable
                | FailureCode::NodeUnsupported
                | FailureCode::DiskBudgetExceeded
                | FailureCode::PlatformUnsupported
                | FailureCode::MetroOriginMismatch
                | FailureCode::CoreRefused
                | FailureCode::BlockStartMissing
                | FailureCode::JevUnreachable
                | FailureCode::JevAuthFailed
                | FailureCode::JevRequestInvalid
                | FailureCode::GithubAuthUnavailable
        )
    }
}

// The last observed screen of a target-class step failure, as the core projected it under its privacy rules.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenNow {
    pub age_ms: u64,
    pub after_dispatch: bool,
    pub front: String,
    pub coverage: String,
    pub controls: Vec<ScreenControl>,
    pub counts: ControlCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenControl {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<OutputText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<OutputText>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
    pub enabled: bool,
    pub hittable: bool,
    pub offscreen: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ControlCounts {
    pub controls: u64,
    pub enabled: u64,
    pub hidden: u64,
}

// An earlier run that failed the same way on the same app, recorded revision and plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repeat {
    pub previous_run_id: String,
    pub count: u64,
    pub same_recorded_revision: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Failure {
    pub phase: String,
    pub code: FailureCode,
    pub detail: OutputText,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<OutputText>,
    pub next_action: OutputText,
    // Failed or refused walk steps: the line and, for a target-class failure, its miss reason and screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subreason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen: Option<ScreenNow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<OutputText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<Repeat>,
    // Boxed so every Result<_, Failure> keeps its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<Box<Recovery>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    BudgetExhausted,
    BuildBudgetExhausted,
    BuildProcessFailed,
    OwnershipUnresolved,
    PersistenceFailed,
    IdentityUnavailable,
    CandidateDrifted,
    RunCancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    WaitForHolder,
    CleanupSelf,
    RestoreStorage,
    RestoreProcessObservation,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryRung {
    pub rung: u8,
    pub applicable: bool,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
    pub instruction: String,
}

// The ordered ladder, least destructive first: retry, restart app/Metro/runner, restart device, rebuild, own cleanup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovery {
    pub reason: RecoveryReason,
    pub next_rung: Option<u8>,
    pub action: RecoveryAction,
    pub automatic: bool,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
    #[serde(default)]
    pub own_cleanup_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_run_id: Option<String>,
    pub ladder: Vec<RecoveryRung>,
}

const CANNOT_HELP: &str = "cannot help";

impl Recovery {
    pub fn new(reason: RecoveryReason) -> Self {
        use RecoveryReason::*;
        let cleanup = "run qaren cleanup <own-run-id> --json, then prepare again";
        let (retry, rebuild, last): (&str, Option<&str>, &str) = match reason {
            BudgetExhausted => (
                "wait for the holding run, or re-run once later",
                None,
                "only if the holder is proven dead: run its qaren cleanup from its own home (its resources only), then prepare again",
            ),
            BuildBudgetExhausted | BuildProcessFailed => (
                "do not repeat a build that exhausted its budget or failed to compile",
                Some("rebuild only after correcting the reported build prerequisite"),
                cleanup,
            ),
            OwnershipUnresolved | PersistenceFailed => (
                "re-observe only within the remaining budget",
                None,
                "restore writable run storage and process observation, then run qaren cleanup <own-run-id> --json and prepare again; keep unproven resources",
            ),
            IdentityUnavailable => (
                "restore process identity observation, then re-run",
                None,
                cleanup,
            ),
            CandidateDrifted => (
                "do not rebuild an unstable candidate",
                Some("rebuild only after a stable candidate is selected"),
                "run qaren cleanup <own-run-id> --json, then prepare again on a stable checkout",
            ),
            RunCancelled => ("re-run when ready; nothing resumes automatically", None, cleanup),
        };
        let first_applicable = matches!(reason, BudgetExhausted | IdentityUnavailable);
        let ladder = vec![
            RecoveryRung::step(1, first_applicable, false, retry),
            RecoveryRung::step(2, false, false, CANNOT_HELP),
            RecoveryRung::step(3, false, false, CANNOT_HELP),
            RecoveryRung::step(4, rebuild.is_some(), true, rebuild.unwrap_or(CANNOT_HELP)),
            RecoveryRung::step(5, reason != RunCancelled, true, last),
        ];
        let (next_rung, action) = match reason {
            BudgetExhausted => (Some(1), RecoveryAction::WaitForHolder),
            IdentityUnavailable => (Some(1), RecoveryAction::RestoreProcessObservation),
            OwnershipUnresolved | PersistenceFailed => (Some(5), RecoveryAction::RestoreStorage),
            BuildBudgetExhausted | BuildProcessFailed | CandidateDrifted => {
                (Some(5), RecoveryAction::CleanupSelf)
            }
            RunCancelled => (None, RecoveryAction::None),
        };
        let destructive = next_rung == Some(5);
        Recovery {
            reason,
            next_rung,
            action,
            automatic: false,
            destroys_state: destructive,
            requires_user_ok: destructive,
            own_cleanup_required: false,
            own_run_id: None,
            ladder,
        }
    }

    // A run that still owns resources must clean them up itself; a cancelled run's next step becomes that cleanup.
    pub fn with_own_cleanup(mut self, run_id: &str) -> Self {
        self.own_cleanup_required = true;
        self.own_run_id = Some(run_id.to_string());
        if self.reason == RecoveryReason::RunCancelled {
            self.next_rung = Some(5);
            self.action = RecoveryAction::CleanupSelf;
            self.destroys_state = true;
            self.requires_user_ok = true;
            if let Some(last) = self.ladder.last_mut() {
                *last = RecoveryRung::step(5, true, true, &last.instruction);
            }
        }
        self
    }
}

impl RecoveryRung {
    fn step(rung: u8, applicable: bool, destroys_state: bool, instruction: &str) -> Self {
        RecoveryRung {
            rung,
            applicable,
            destroys_state: applicable && destroys_state,
            requires_user_ok: applicable && destroys_state,
            instruction: instruction.to_string(),
        }
    }
}

impl Failure {
    pub fn new(
        phase: &str,
        code: FailureCode,
        detail: impl Into<String>,
        next_action: impl Into<String>,
    ) -> Self {
        Failure {
            phase: phase.to_string(),
            code,
            detail: OutputText::from_output(&detail.into()),
            evidence: Vec::new(),
            next_action: OutputText::from_output(&next_action.into()),
            step: None,
            subreason: None,
            screen: None,
            suggestion: None,
            repeat: None,
            recovery: None,
        }
    }

    pub fn with_recovery(mut self, reason: RecoveryReason) -> Self {
        self.recovery = Some(Box::new(Recovery::new(reason)));
        self
    }

    pub fn cancelled(phase: &str, reason: &str) -> Self {
        Failure::new(
            phase,
            FailureCode::RunCancelled,
            format!("the run was cancelled: {reason}"),
            "re-run when ready; teardown released what it could prove, and the cleanup map names anything retained",
        )
    }

    pub fn with_evidence(mut self, evidence: Vec<String>) -> Self {
        self.evidence = evidence
            .into_iter()
            .map(|line| OutputText::from_output(&line))
            .collect();
        self
    }
}
