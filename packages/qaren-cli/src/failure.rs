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
    PressNotRegistered,
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
                | FailureCode::PressNotRegistered
                | FailureCode::CoreRefused
                | FailureCode::BlockStartMissing
                | FailureCode::JevUnreachable
                | FailureCode::JevAuthFailed
                | FailureCode::JevRequestInvalid
                | FailureCode::GithubAuthUnavailable
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Failure {
    pub phase: String,
    pub code: FailureCode,
    pub detail: OutputText,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<OutputText>,
    pub next_action: OutputText,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<PressRecovery>,
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
            recovery: None,
            next_action: OutputText::from_output(&next_action.into()),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PressRecovery {
    pub next_rung: Option<u8>,
    pub action: PressRecoveryAction,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
    pub ladder: Vec<PressRecoveryRung>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PressRecoveryAction {
    AskAppTeamDisableHorizontalListScrollingOrExposeSelection,
    ReprepareAfterCaptureRecovery,
    RerunWhenReady,
    HeldPress,
    RestartAppMetroRunner,
    RestartDevice,
    RebuildNative,
    CleanupAndFreshPrepare,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PressRecoveryStatus {
    Attempted,
    Skipped,
    Available,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PressRecoveryReason {
    RetrySafeSemanticsUnavailable,
    AppSelectionContractUnchanged,
    CaptureRecoveryOwnResourcesOnly,
    ReadbackExhausted,
    Cancelled,
    NotApplicable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PressRecoveryRung {
    pub rung: u8,
    pub action: PressRecoveryAction,
    pub status: PressRecoveryStatus,
    pub reason: PressRecoveryReason,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
}

impl Failure {
    pub fn with_press_recovery(mut self, code: &str) -> Self {
        use PressRecoveryAction::*;
        use PressRecoveryReason::*;
        use PressRecoveryStatus::*;
        let capture = code == "NATIVE_CAPTURE_UNAVAILABLE";
        let selection = code == "PRESS_NOT_REGISTERED";
        let action = if selection {
            AskAppTeamDisableHorizontalListScrollingOrExposeSelection
        } else if capture {
            ReprepareAfterCaptureRecovery
        } else {
            RerunWhenReady
        };
        self.next_action = OutputText::from_output(match action {
            AskAppTeamDisableHorizontalListScrollingOrExposeSelection => {
                "ask_app_team_disable_horizontal_list_scrolling_or_expose_selection"
            }
            ReprepareAfterCaptureRecovery => "reprepare_after_capture_recovery",
            _ => "rerun_when_ready",
        });
        self.recovery = Some(PressRecovery {
            next_rung: if capture { Some(2) } else { None },
            action,
            destroys_state: false,
            requires_user_ok: false,
            ladder: [
                HeldPress,
                RestartAppMetroRunner,
                RestartDevice,
                RebuildNative,
                CleanupAndFreshPrepare,
            ]
            .into_iter()
            .enumerate()
            .map(|(index, action)| PressRecoveryRung {
                rung: index as u8 + 1,
                action,
                status: if capture && index > 0 {
                    Available
                } else {
                    Skipped
                },
                reason: if index == 0 {
                    if selection {
                        RetrySafeSemanticsUnavailable
                    } else if code == "RUN_CANCELLED" {
                        Cancelled
                    } else {
                        ReadbackExhausted
                    }
                } else if capture {
                    CaptureRecoveryOwnResourcesOnly
                } else if selection {
                    AppSelectionContractUnchanged
                } else {
                    NotApplicable
                },
                destroys_state: index > 0,
                requires_user_ok: index > 0,
            })
            .collect(),
        });
        self
    }
}
