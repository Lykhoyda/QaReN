use crate::redact::OutputText;
use serde::{Deserialize, Serialize};

pub(crate) const WATCHMAN_VOLUME_FIX: &str = "watchman cannot watch this volume; on macOS, FSEvents (fseventsd) state or removable-volume permissions may be blocking it: allow watchman under System Settings > Privacy & Security > Files and Folders > Removable Volumes, or coordinate an fseventsd reset, or reconnect the volume; then re-run qaren doctor once";

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
    ManifestNotWarm,
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
                | FailureCode::ManifestNotWarm
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
    #[serde(
        default,
        deserialize_with = "deserialize_evidence",
        skip_serializing_if = "Vec::is_empty"
    )]
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

fn deserialize_evidence<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<OutputText>, D::Error> {
    Vec::<String>::deserialize(deserializer).map(|notes| {
        notes
            .into_iter()
            .map(
                |note| match crate::core::AdmissionSummary::from_note(&note) {
                    Some(summary) => OutputText::from_admission(&summary),
                    None => OutputText::from_output(&note),
                },
            )
            .collect()
    })
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
    ForeignAdmissionUnresolved,
    CandidateDrifted,
    RunCancelled,
    GracefulPending,
    IdentityMismatch,
    IdentityUnknown,
    CommandIneligible,
    LeaseUnproven,
    OwnerUnproven,
    CoreUnproven,
    InventoryUnknown,
    DriverSurvived,
    GroupRemaining,
    HostRemaining,
    HostCleanupFailed,
    DriverExited,
    StorageFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    WaitForHolder,
    #[serde(rename = "wait-owner")]
    WaitForOwner,
    CleanupSelf,
    RestoreStorage,
    RestoreProcessObservation,
    None,
    RetryCleanupAfterExit,
    CleanupOwnedRunner,
    RequestExactSimulatorShutdown,
    NativeRebuildNotApplicable,
    CleanupThenFreshPrepare,
    RetainAndReport,
    RepairRecordStorage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryRung {
    pub rung: u8,
    pub applicable: bool,
    pub destroys_state: bool,
    pub requires_user_ok: bool,
    pub instruction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<RecoveryAction>,
}

// Foreign admission uses L0-L5; other recovery reasons retain their 1-based rungs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recovery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
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

impl From<RecoveryReason> for Recovery {
    fn from(reason: RecoveryReason) -> Self {
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
            ForeignAdmissionUnresolved => return Self::foreign_admission(),
            _ => return Self::ios_runner(reason, "<run-id>", false, false, false),
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
            ForeignAdmissionUnresolved => unreachable!("foreign admission has a dedicated ladder"),
            OwnershipUnresolved | PersistenceFailed => (Some(5), RecoveryAction::RestoreStorage),
            BuildBudgetExhausted | BuildProcessFailed | CandidateDrifted => {
                (Some(5), RecoveryAction::CleanupSelf)
            }
            RunCancelled => (None, RecoveryAction::None),
            _ => unreachable!("runner recovery returned above"),
        };
        let destructive = next_rung == Some(5);
        Recovery {
            key: None,
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
}

impl Recovery {
    pub fn new(recovery: impl Into<Self>) -> Self {
        recovery.into()
    }

    pub fn ios_runner(
        reason: RecoveryReason,
        run_id: &str,
        destroys_state: bool,
        needs_user_ok: bool,
        borrowed: bool,
    ) -> Self {
        use RecoveryAction::*;
        let shutdown = reason == RecoveryReason::HostCleanupFailed;
        let instructions = [
            format!("After the recorded driver exits, run qaren cleanup {run_id} --json once; if it remains live, continue to runner recovery."),
            format!("Run qaren cleanup {run_id} --json; it can stop this run's proven runner driver and matching simulator hosts. If cleanup refuses, follow its next_action."),
            format!("Request shutdown of only this run's simulator, then run qaren cleanup {run_id} --json; obtain user approval first if the simulator is lent.{}", if shutdown { "" } else { " This step is unavailable: there is no supported standalone shutdown command." }),
            "Do not rebuild native code to clear a surviving runner process; continue to the final recovery rung.".into(),
            format!("After owned resources are proven absent, run qaren cleanup {run_id} --json, then a fresh qaren prepare for the scenario; if cleanup still refuses, stop and report retained resources."),
        ];
        let (next_rung, action) = match reason {
            RecoveryReason::HostCleanupFailed => (Some(3), RequestExactSimulatorShutdown),
            RecoveryReason::GracefulPending => (Some(2), CleanupOwnedRunner),
            RecoveryReason::DriverExited => (Some(1), RetryCleanupAfterExit),
            RecoveryReason::StorageFailed => (Some(1), RepairRecordStorage),
            _ => (Option::None, RetainAndReport),
        };
        let actions = [
            RetryCleanupAfterExit,
            CleanupOwnedRunner,
            RequestExactSimulatorShutdown,
            NativeRebuildNotApplicable,
            CleanupThenFreshPrepare,
        ];
        let ladder = instructions
            .into_iter()
            .enumerate()
            .map(|(i, instruction)| {
                let rung = i as u8 + 1;
                let applicable = next_rung == Some(rung);
                RecoveryRung {
                    rung,
                    applicable,
                    instruction,
                    action: Some(actions[i]),
                    destroys_state: matches!(rung, 3 | 5)
                        || (destroys_state && matches!(rung, 1 | 2)),
                    requires_user_ok: rung == 5
                        || (rung == 3 && borrowed)
                        || (needs_user_ok && matches!(rung, 1 | 2)),
                }
            })
            .collect();
        Self {
            key: Some("ios_runner_cleanup".into()),
            reason,
            next_rung,
            action,
            automatic: false,
            destroys_state: shutdown || (next_rung.is_some() && destroys_state),
            requires_user_ok: (shutdown && borrowed) || (next_rung.is_some() && needs_user_ok),
            own_cleanup_required: true,
            own_run_id: Option::None,
            ladder,
        }
    }

    pub fn runner_next_action(&self, run_id: &str) -> String {
        match self.action {
            RecoveryAction::RepairRecordStorage => format!("Restore write access to this run's record storage, then rerun qaren cleanup {run_id} --json once; do not remove its lease manually."),
            RecoveryAction::RetainAndReport => "Leave the process, device and lease untouched; report the missing ownership proof and request the owning run or device owner to resolve it.".into(),
            _ => self.next_rung.and_then(|rung| self.ladder.iter().find(|step| step.rung == rung))
                .map(|step| step.instruction.clone()).unwrap_or_default(),
        }
    }

    fn foreign_admission() -> Self {
        Self {
            key: None,
            reason: RecoveryReason::ForeignAdmissionUnresolved,
            next_rung: Some(0),
            action: RecoveryAction::WaitForOwner,
            automatic: false,
            destroys_state: false,
            requires_user_ok: false,
            own_cleanup_required: false,
            own_run_id: None,
            ladder: vec![
                RecoveryRung::step(0, true, false, "bounded re-probe exhausted or ineligible; wait for the foreign process owner to finish, then re-run; do not signal or adopt it"),
                RecoveryRung::step(1, false, false, "restarting this run's app, Metro or runner cannot prove a foreign process clear"),
                RecoveryRung::step(2, false, false, "restarting the selected device cannot resolve foreign process identity"),
                RecoveryRung::step(3, false, false, "rebuilding native code cannot resolve foreign process identity"),
                RecoveryRung::step(4, false, false, "own cleanup cannot clear foreign state"),
                RecoveryRung::step(5, true, true, "only after foreign state is independently clear: qaren cleanup <own-run-id> --json; require every owned leg resolved, then qaren prepare <scenario> --device <device> --json and clean that recovery run before retrying; a fresh install needs separate authorization and user approval for app-data loss"),
            ],
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
            action: None,
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

    pub fn with_recovery(mut self, reason: impl Into<Recovery>) -> Self {
        self.recovery = Some(Box::new(FailureRecovery::Build(Recovery::new(reason))));
        self
    }

    pub fn build_recovery(&self) -> Option<&Recovery> {
        match self.recovery.as_deref() {
            Some(FailureRecovery::Build(recovery)) => Some(recovery),
            _ => None,
        }
    }

    pub fn core_refusal_next_action(code: &str) -> &'static str {
        match code {
            "DEV_MENU_HIDE_UNVERIFIED_READ_FAILED" | "DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT" =>
                "re-run once without --fresh-install or --restart-device; if build work is active, wait for it to finish first",
            "DEV_MENU_HIDE_UNVERIFIED_NOT_HIDDEN" | "DEV_MENU_HIDE_UNVERIFIED_EVALUATE_FAILED" =>
                "re-run once without --fresh-install; if it persists, report the value-free refusal",
            _ => "resolve the refusal, then re-run",
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
    RerunThenAskAppTeamExposeSelectionInRowList,
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
            RerunThenAskAppTeamExposeSelectionInRowList
        } else if capture {
            ReprepareAfterCaptureRecovery
        } else {
            RerunWhenReady
        };
        self.next_action = OutputText::from_output(match action {
            RerunThenAskAppTeamExposeSelectionInRowList => {
                "rerun_then_ask_app_team_expose_selection_in_row_list"
            }
            ReprepareAfterCaptureRecovery => "reprepare_after_capture_recovery",
            _ => "rerun_when_ready",
        });
        self.recovery = Some(Box::new(FailureRecovery::Press(PressRecovery {
            next_rung: if capture { Some(2) } else { None },
            action,
            destroys_state: capture,
            requires_user_ok: capture,
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
                    if selection || capture {
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
