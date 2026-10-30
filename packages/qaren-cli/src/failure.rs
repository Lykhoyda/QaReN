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
    // Plan step failures only: the failed line and, for a target-class failure, its miss reason and screen.
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
        }
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
