pub(crate) mod admission;
use crate::redact::OutputText;
pub use admission::{AdmissionCause, AdmissionFacts, AdmissionRecovery};
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
    CandidateUnavailable,
    PrereqMissing,
    PnpmProcessGroupUnsupported,
    PnpmProbeTimedOut,
    MetroPortOccupied,
    MetroBindIpv6Only,
    ManifestNotWarm,
    WatchmanVolumeStalled,
    RunAlreadyExists,
    RunRecordUnavailable,
    RunRecordInvalid,
    RunRecordUpdateFailed,
    SimulatorCreateFailed,
    SimulatorBootFailed,
    SimulatorInventoryUnavailable,
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
    HostUnderPressure,
    DeviceClaimContended,
    DeviceUnavailable,
    DeviceNotBooted,
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
    DevTargetMissing,
    PressNotRegistered,
    BlockStartMissing,
    DevRedbox,
    JevUnreachable,
    JevAuthFailed,
    JevRequestInvalid,
    PrUnavailable,
    GithubAuthUnavailable,
    PrWorktreeFailed,
    PublishFailed,
    InstalledAppUnsupported,
    InstalledAppMissing,
    InstalledAppNotStandalone,
}

impl FailureCode {
    // Refusals exit 4 rather than claiming an app failure.
    pub fn is_refusal(&self) -> bool {
        matches!(
            self,
            FailureCode::SimulatorInventoryUnavailable
                | FailureCode::CandidateUnavailable
                | FailureCode::DepsNotPrewarmed
                | FailureCode::ManifestNotWarm
                | FailureCode::MetroBindIpv6Only
                | FailureCode::WatchmanVolumeStalled
                | FailureCode::PnpmProcessGroupUnsupported
                | FailureCode::PnpmProbeTimedOut
                | FailureCode::DeviceClaimContended
                | FailureCode::DeviceUnavailable
                | FailureCode::DeviceNotBooted
                | FailureCode::LaneNotWarm
                | FailureCode::BuildContended
                | FailureCode::HostUnderPressure
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
                | FailureCode::DevTargetMissing
                | FailureCode::CoreRefused
                | FailureCode::BlockStartMissing
                | FailureCode::DevRedbox
                | FailureCode::JevUnreachable
                | FailureCode::JevAuthFailed
                | FailureCode::JevRequestInvalid
                | FailureCode::GithubAuthUnavailable
                | FailureCode::InstalledAppUnsupported
                | FailureCode::InstalledAppMissing
                | FailureCode::InstalledAppNotStandalone
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
    // Where a kept process log is, never its lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<LogPointer>,
    pub next_action: OutputText,
    // Failed or refused walk steps: the line and, for a target-class failure, its miss reason and screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<u64>,
    // A step's miss reason, or the cause of a device refusal (`usb-unauthorized`, `device-locked`, ...).
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
    // What ran out when a native build step was stopped for time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<Box<LimitFacts>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogPointer {
    pub file: OutputText,
    // The file's size when the failure was built; absent when it could not be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitEnd {
    NoProgress,
    Window,
    CommandLimit,
}

// Fixed words and numbers only: never output, paths or values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LimitFacts {
    pub phase: String,
    pub setting: String,
    pub limit_s: u64,
    pub window_s: u64,
    // Absent for prebuild, which has no progress rule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_s: Option<u64>,
    pub elapsed_s: u64,
    pub ended_by: LimitEnd,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_age_s: Option<u64>,
    // Absent when no setting can help: the window was already the 7200 s maximum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_limit_s: Option<u64>,
    // The limit was raised from this machine's earlier builds.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub learned: bool,
}

impl LimitFacts {
    // What to do once the run's own cleanup has succeeded; never names a value that is not there.
    pub fn remedy(&self) -> String {
        match (self.ended_by, self.next_limit_s) {
            (LimitEnd::Window, Some(next)) => {
                format!("set deadlines.build_seconds to {next}, then run again")
            }
            (LimitEnd::Window, None) if self.phase == "expo_run_android" => "the window was already 7200 s and a higher deadlines.build_seconds cannot extend it: readiness was not confirmed within two hours on this machine; after cleanup, read the last lines of the build log for the step it stood on (when the log is withheld, run `pnpm exec expo run:android` in the project yourself), fix that, then run again".into(),
            (LimitEnd::Window, None) => "the build window was already 7200 s, so no setting helps: build the app with the project's own tools and hand QaReN the built app".into(),
            _ => "run again".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FailureRecovery {
    Build(Recovery),
    Press(PressRecovery),
    Admission(AdmissionRecovery),
}

impl FailureRecovery {
    pub fn with_own_cleanup(self, run_id: &str) -> Self {
        match self {
            Self::Build(recovery) => Self::Build(recovery.with_own_cleanup(run_id)),
            Self::Press(recovery) => Self::Press(recovery),
            Self::Admission(recovery) => Self::Admission(recovery),
        }
    }
}

fn deserialize_evidence<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<OutputText>, D::Error> {
    Vec::<String>::deserialize(deserializer).map(|notes| {
        notes
            .iter()
            .filter_map(|note| crate::core::AdmissionSummary::from_note(note))
            .map(|summary| OutputText::from_admission(&summary))
            .collect()
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryReason {
    BudgetExhausted,
    BuildBudgetExhausted,
    BuildProcessFailed,
    BuildTimeLimit,
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
    PreviousPlanPress,
    ActionOutcomeUncertain,
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
    InspectLastObservedScreen,
    Rerun,
    CheckActionEffect,
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

// After a step ended ACTION_OUTCOME_UNCERTAIN: fixed texts only, so nothing from the app or the plan reaches them.
pub(crate) const UNCERTAIN_REVIEW: &str = "review any available evidence without repeating the action, starting with this run's report.";
pub(crate) const UNCERTAIN_STOP: &str = "If you cannot establish whether the action took effect, leave the outcome unresolved and stop.";
pub(crate) const UNCERTAIN_RETAIN: &str = "leave the process, device and lease untouched. Report the recorded runner cleanup reason to the run or device owner.";
// A settled runner ladder's rungs that are not selected: descriptions, never instructions.
const RUNNER_NOT_SELECTED: [&str; 5] = [
    "not selected: a cleanup retry after the recorded driver exits",
    "not selected: an immediate cleanup of this run's runner",
    "not selected: a shutdown of this run's simulator",
    "not selected: a native rebuild, which cannot clear a surviving runner process",
    "not selected: cleanup and a fresh qaren prepare; a new qaren check or qaren pr starts the plan from its first step and can repeat an action that already took effect",
];

// The fixed words for the reason of a step that ended ACTION_OUTCOME_UNCERTAIN; None for any other subreason.
pub(crate) fn uncertain_words(subreason: &str) -> Option<&'static str> {
    Some(match subreason {
        "keyboard-visible" => "The device runner refused the tap because of the on-screen keyboard",
        "alert-blocked" => "An app alert was open over the gesture point and the device runner did not perform the drag",
        "dispatch-unconfirmed" => "QaReN could not confirm the outcome of the action",
        "context-unverified" => "QaReN could no longer validate the dispatch context after the action was authorized",
        "deadline-expired" => "The time allowed for the action ran out after it was authorized",
        "scroll-unverified" => "A scroll towards the target was not confirmed and the capture after it could not be used",
        "press-retry-screen-changed" => "The screen changed without proving the planned transition",
        "press-retry-target-changed" => "The original target changed without proving the planned transition",
        "press-retry-no-effect" => "No effect was observed within the window",
        "press-retry-evidence-unavailable" => "The observation window did not provide enough evidence",
        "unknown" => "QaReN recorded no classified reason for the uncertain outcome",
        _ => return None,
    })
}

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
            PreviousPlanPress => return Self::previous_plan_press(),
            ActionOutcomeUncertain => return Self::action_uncertain(None),
            BuildTimeLimit => return Self::build_time_limit("run again"),
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

fn repair_storage_step(run_id: &str) -> String {
    format!("Check that this run's record storage is writable, restore it if needed, then rerun qaren cleanup {run_id} --json once; do not remove its lease manually.")
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
        let storage = reason == RecoveryReason::StorageFailed;
        let instructions = [
            if storage {
                repair_storage_step(run_id)
            } else {
                format!("After the recorded driver exits, run qaren cleanup {run_id} --json once; if it remains live, continue to runner recovery.")
            },
            format!("Run qaren cleanup {run_id} --json; it can stop this run's proven runner driver and matching simulator hosts. If cleanup refuses, follow its next_action."),
            format!("Request shutdown of only this run's simulator, then run qaren cleanup {run_id} --json; obtain user approval first if the simulator is lent.{}", if shutdown { "" } else { " This step is unavailable: there is no supported standalone shutdown command." }),
            "Do not rebuild native code to clear a surviving runner process.".into(),
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
            if storage {
                RepairRecordStorage
            } else {
                RetryCleanupAfterExit
            },
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
            RecoveryAction::RepairRecordStorage => repair_storage_step(run_id),
            RecoveryAction::RetainAndReport => "Leave the process, device and lease untouched; report the missing ownership proof and request the owning run or device owner to resolve it.".into(),
            _ => self.next_rung.and_then(|rung| self.ladder.iter().find(|step| step.rung == rung))
                .map(|step| step.instruction.clone()).unwrap_or_default(),
        }
    }

    // A build stopped for time broke nothing: after its own cleanup, running again is safe.
    pub fn build_time_limit(remedy: &str) -> Self {
        let first = format!("after `qaren cleanup <own-run-id> --json` has succeeded: {remedy}");
        let mut rerun = RecoveryRung::step(1, true, false, &first);
        rerun.action = Some(RecoveryAction::Rerun);
        Self {
            key: None,
            reason: RecoveryReason::BuildTimeLimit,
            next_rung: Some(1),
            action: RecoveryAction::Rerun,
            automatic: false,
            destroys_state: false,
            requires_user_ok: false,
            own_cleanup_required: false,
            own_run_id: None,
            ladder: vec![
                rerun,
                RecoveryRung::step(2, false, false, CANNOT_HELP),
                RecoveryRung::step(3, false, false, CANNOT_HELP),
                RecoveryRung::step(4, false, false, CANNOT_HELP),
                RecoveryRung::step(
                    5,
                    true,
                    true,
                    "run qaren cleanup <own-run-id> --json, then prepare again",
                ),
            ],
        }
    }

    // A screen observed after the plan's own press: inspect it first; no reset is indicated.
    fn previous_plan_press() -> Self {
        Self {
            key: None,
            reason: RecoveryReason::PreviousPlanPress,
            next_rung: None,
            action: RecoveryAction::InspectLastObservedScreen,
            automatic: false,
            destroys_state: false,
            requires_user_ok: false,
            own_cleanup_required: false,
            own_run_id: None,
            ladder: vec![
                RecoveryRung::step(1, false, false, "inspect the last observed screen before retrying"),
                RecoveryRung::step(2, false, false, "no restart of the app, Metro or the runner is indicated by this observation"),
                RecoveryRung::step(3, false, false, "no device restart is indicated by this observation"),
                RecoveryRung::step(4, false, false, "no native rebuild is indicated by this observation"),
                RecoveryRung::step(5, false, false, "no cleanup or fresh prepare is indicated by this observation"),
            ],
        }
    }

    // An uncertain step selects no rung; the review is the action. `owed_by` names the run when it still owes its own cleanup.
    pub fn action_uncertain(owed_by: Option<&str>) -> Self {
        let last = if owed_by.is_some() {
            "this failure reason alone does not select cleanup and a fresh qaren prepare; the cleanup this run owes is a separate obligation, named in next_action"
        } else {
            "this failure reason alone does not select cleanup and a fresh qaren prepare; this run's teardown was clean"
        };
        Self {
            key: None,
            reason: RecoveryReason::ActionOutcomeUncertain,
            next_rung: None,
            action: RecoveryAction::CheckActionEffect,
            automatic: false,
            destroys_state: false,
            requires_user_ok: false,
            own_cleanup_required: owed_by.is_some(),
            own_run_id: owed_by.map(str::to_string),
            ladder: vec![
                RecoveryRung::step(1, false, false, "a retry is not selected: a new qaren check or qaren pr starts the plan from its first step and can repeat an action that already took effect"),
                RecoveryRung::step(2, false, false, "this failure reason alone does not select a restart of the app, Metro or the runner"),
                RecoveryRung::step(3, false, false, "this failure reason alone does not select a device restart"),
                RecoveryRung::step(4, false, false, "this failure reason alone does not select a native rebuild"),
                RecoveryRung::step(5, false, false, last),
            ],
        }
    }

    // A runner recovery settled for an uncertain step: its reason and selection stay; the selected rung (if any)
    // is the only instruction and carries the object's flags; every other rung only says it is not selected.
    pub fn uncertain_runner(reason: RecoveryReason, selected: Option<RecoveryRung>, run_id: &str) -> Self {
        let ladder = (1..=5u8)
            .map(|rung| match &selected {
                Some(step) if step.rung == rung => step.clone(),
                _ => RecoveryRung::step(rung, false, false, RUNNER_NOT_SELECTED[usize::from(rung) - 1]),
            })
            .collect();
        Self {
            key: Some("ios_runner_cleanup".into()),
            reason,
            next_rung: selected.as_ref().map(|step| step.rung),
            action: selected
                .as_ref()
                .and_then(|step| step.action)
                .unwrap_or(RecoveryAction::RetainAndReport),
            automatic: false,
            destroys_state: selected.as_ref().is_some_and(|step| step.destroys_state),
            requires_user_ok: selected.as_ref().is_some_and(|step| step.requires_user_ok),
            own_cleanup_required: true,
            own_run_id: selected.as_ref().map(|_| run_id.to_string()),
            ladder,
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
            log: None,
            next_action: OutputText::from_output(&next_action.into()),
            step: None,
            subreason: None,
            screen: None,
            suggestion: None,
            repeat: None,
            recovery: None,
            limit: None,
        }
    }

    // A cut for time: its facts and the re-run recovery travel together.
    pub fn with_limit(mut self, facts: LimitFacts) -> Self {
        self.recovery = Some(Box::new(FailureRecovery::Build(
            Recovery::build_time_limit(&facts.remedy()),
        )));
        self.limit = Some(Box::new(facts));
        self
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

    pub fn with_admission_recovery(
        mut self,
        cause: AdmissionCause,
        facts: Option<AdmissionFacts>,
    ) -> Self {
        self.next_action = OutputText::from_output(cause.action().1);
        self.recovery = Some(Box::new(FailureRecovery::Admission(
            AdmissionRecovery::new(cause, facts),
        )));
        self
    }

    pub fn core_refusal_next_action(code: &str) -> &'static str {
        match code {
            "DEV_MENU_HIDE_UNVERIFIED_READ_FAILED" | "DEV_MENU_HIDE_UNVERIFIED_EVALUATE_TIMEOUT" =>
                "re-run once without --fresh-install or --restart-device; if build work is active, wait for it to finish first",
            "DEV_MENU_HIDE_UNVERIFIED_NOT_HIDDEN" | "DEV_MENU_HIDE_UNVERIFIED_EVALUATE_FAILED" =>
                "re-run once without --fresh-install; if it persists, report the value-free refusal",
            // A development error overlay: the cause decides whether a restart may help.
            "DEV_REDBOX_REPEATED"
            | "DEV_REDBOX_DISMISS_FAILED"
            | "DEV_REDBOX_NO_SAFE_DISMISS"
            | "DEV_REDBOX_CLEARANCE_UNPROVEN" => "restart_app_from_plan_start",
            "DEV_REDBOX_ACTION_UNCERTAIN" => "inspect_app_error_before_rerun",
            // Replacement could not complete; manual removal requires the user's device coordination.
            "RUNNER_INSTALL_BLOCKED" =>
                "QaReN could not replace its own runner apps on the device (adb's reason is in the detail); only if nothing else is using the device, remove them with `adb -s <serial> uninstall dev.lykhoyda.rndevagent.androidrunner` and the same for `dev.lykhoyda.rndevagent.androidrunner.test`, then re-run",
            "INSTALLED_APP_OPEN_TIMEOUT" =>
                "re-run once: a first start on a simulator builds or downloads QaReN's runner, and a later start is faster; if it repeats, report the code with the run id",
            "INSTALLED_APP_PROCESS_UNPROVEN" =>
                "start the app by hand on the simulator and check that it stays open, then re-run: installed-app mode needs the launched app to keep running",
            "INSTALLED_APP_BIND_FAILED" | "INSTALLED_APP_READ_FAILED" =>
                "re-run once; if it repeats, report the code with the run id: QaReN's runner could not read the installed app",
            "NATIVE_SNAPSHOT_INCOMPLETE" =>
                "QaReN could not prove it read the whole screen. Report the run id with the available snapshot detail.",
            _ => "resolve the refusal, then re-run",
        }
    }

    // A core refusal that is a device cause carries it as a machine-readable subreason.
    pub fn core_refusal_subreason(code: &str) -> Option<String> {
        (code == "RUNNER_INSTALL_BLOCKED").then(|| "runner-install-blocked".to_string())
    }

    // The candidate could not be read; nothing is known to have changed, so no recovery ladder applies.
    pub fn candidate_unavailable(phase: &str) -> Self {
        Failure::new(
            phase,
            FailureCode::CandidateUnavailable,
            "the candidate could not be read (git reports not a repository, or the path is missing); nothing is known to have changed",
            "check that the candidate's volume or path is available again, then re-run; QaReN does not recreate or move the candidate",
        )
    }

    pub fn cancelled(phase: &str, reason: &str) -> Self {
        Failure::new(
            phase,
            FailureCode::RunCancelled,
            format!("the run was cancelled: {reason}"),
            "re-run when ready; teardown released what it could prove, and the cleanup map names anything retained",
        )
    }

    // Built under the creating run's redaction scope, so declared values in the path are masked.
    pub fn with_log(mut self, file: &std::path::Path) -> Self {
        self.log = Some(LogPointer {
            file: OutputText::from_output(&file.display().to_string()),
            bytes: std::fs::metadata(file).ok().map(|meta| meta.len()),
        });
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

#[cfg(test)]
mod log_pointer_tests {
    use super::*;

    #[test]
    fn a_log_pointer_carries_the_file_and_its_size_when_readable() {
        let dir = std::env::temp_dir().join(format!("qaren-log-pointer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("metro.log");
        std::fs::write(&log, "bundling\nready\n").unwrap();
        let failure = Failure::new("build", FailureCode::BuildFailed, "metro exited", "inspect")
            .with_log(&log);
        let pointer = failure.log.as_ref().unwrap();
        assert_eq!(pointer.file, log.display().to_string());
        assert_eq!(pointer.bytes, Some(std::fs::metadata(&log).unwrap().len()));
        assert!(failure.evidence.is_empty());

        let missing = dir.join("absent.log");
        let failure = Failure::new("build", FailureCode::BuildFailed, "metro exited", "inspect")
            .with_log(&missing);
        let json = serde_json::to_value(&failure).unwrap();
        assert!(json["log"].get("bytes").is_none(), "{json}");
        assert_eq!(json["log"]["file"], missing.display().to_string());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

// AI-703: a runner recovery's selected rung carries the selected action, instruction and flags (red on the base for StorageFailed).
#[cfg(test)]
mod runner_rung_tests {
    use super::*;

    #[test]
    fn the_selected_runner_rung_matches_the_selected_action_and_instruction() {
        use RecoveryReason::*;
        let every = [
            BudgetExhausted, BuildBudgetExhausted, BuildProcessFailed, BuildTimeLimit, OwnershipUnresolved,
            PersistenceFailed, IdentityUnavailable, ForeignAdmissionUnresolved, CandidateDrifted, RunCancelled,
            GracefulPending, IdentityMismatch, IdentityUnknown, CommandIneligible, LeaseUnproven, OwnerUnproven,
            CoreUnproven, InventoryUnknown, DriverSurvived, GroupRemaining, HostRemaining, HostCleanupFailed,
            DriverExited, StorageFailed, PreviousPlanPress,
        ];
        // The 25 reasons at the pin (the build adds ActionOutcomeUncertain, which never reaches ios_runner).
        for reason in every {
            // The arguments the runner projection passes: needs_user_ok is always false there (cleanup.rs project_runner_recovery).
            for (destroys, borrowed) in [(false, false), (true, false), (false, true), (true, true)] {
                let recovery = Recovery::ios_runner(reason, "check-1", destroys, false, borrowed);
                match recovery.next_rung {
                    Some(rung) => {
                        let step = recovery.ladder.iter().find(|s| s.rung == rung).unwrap();
                        assert!(step.applicable, "{reason:?}");
                        assert_eq!(step.action, Some(recovery.action), "{reason:?}");
                        assert_eq!(step.instruction, recovery.runner_next_action("check-1"), "{reason:?}");
                        assert_eq!(step.destroys_state, recovery.destroys_state, "{reason:?}");
                        assert_eq!(step.requires_user_ok, recovery.requires_user_ok, "{reason:?}");
                    }
                    None => assert!(recovery.ladder.iter().all(|s| !s.applicable), "{reason:?}"),
                }
                // Rung 4 no longer points the reader to the final recovery rung.
                for step in &recovery.ladder {
                    assert!(!step.instruction.contains("continue to the final recovery rung"), "{reason:?}");
                }
            }
        }
    }
}
