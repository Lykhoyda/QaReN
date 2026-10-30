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
    // Boxed so every Result<_, Failure> keeps its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<Box<FailureRecovery>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FailureRecovery {
    Build(Recovery),
    Press(PressRecovery),
}

impl FailureRecovery {
    pub fn with_own_cleanup(self, run_id: &str) -> Self {
        match self {
            Self::Build(recovery) => Self::Build(recovery.with_own_cleanup(run_id)),
            Self::Press(recovery) => Self::Press(recovery),
        }
    }
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
            recovery: None,
        }
    }

    pub fn with_recovery(mut self, reason: RecoveryReason) -> Self {
        self.recovery = Some(Box::new(FailureRecovery::Build(Recovery::new(reason))));
        self
    }

    pub fn build_recovery(&self) -> Option<&Recovery> {
        match self.recovery.as_deref() {
            Some(FailureRecovery::Build(recovery)) => Some(recovery),
            _ => None,
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
    RetryCaptureWithinBudget,
    ReadOnlyRecapture,
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
    ReadbackRemaining,
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
    pub fn with_press_recovery(mut self, code: &str, captures: u8) -> Self {
        use PressRecoveryAction::*;
        use PressRecoveryReason::*;
        use PressRecoveryStatus::*;
        let capture = code == "NATIVE_CAPTURE_UNAVAILABLE";
        let selection = code == "PRESS_NOT_REGISTERED";
        let read_remains = capture && captures == 1;
        let action = if selection {
            AskAppTeamDisableHorizontalListScrollingOrExposeSelection
        } else if read_remains {
            RetryCaptureWithinBudget
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
            RetryCaptureWithinBudget => "retry_capture_within_budget",
            _ => "rerun_when_ready",
        });
        self.recovery = Some(Box::new(FailureRecovery::Press(PressRecovery {
            next_rung: if read_remains {
                Some(1)
            } else if capture {
                Some(2)
            } else {
                None
            },
            action,
            destroys_state: capture && !read_remains,
            requires_user_ok: capture && !read_remains,
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
                action: if read_remains && index == 0 {
                    ReadOnlyRecapture
                } else {
                    action
                },
                status: if capture && (index > 0 || read_remains) {
                    Available
                } else {
                    Skipped
                },
                reason: if index == 0 {
                    if read_remains {
                        ReadbackRemaining
                    } else if selection || capture {
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
        })));
        self
    }
}
