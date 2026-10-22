use crate::candidate::Candidate;
use crate::exec::{CmdSpec, Runner, Spawned};
use crate::failure::{Failure, FailureCode};
use crate::redact::OutputText;
use crate::scenario::{Platform, Scenario};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RUN_SCHEMA: &str = "qaren-run/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Created,
    DepsInstalled,
    ResourcesAllocated,
    Building,
    Ready,
    Walking,
    HandedOff,
    Failed,
    Cleaned,
}

impl Phase {
    pub fn as_str(&self) -> &'static str {
        match self {
            Phase::Created => "created",
            Phase::DepsInstalled => "deps_installed",
            Phase::ResourcesAllocated => "resources_allocated",
            Phase::Building => "building",
            Phase::Ready => "ready",
            Phase::Walking => "walking",
            Phase::HandedOff => "handed_off",
            Phase::Failed => "failed",
            Phase::Cleaned => "cleaned",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PidIdentity {
    pub pid: i32,
    pub started_at: String,
    pub command: OutputText,
}

// Recorded only when the leased simulator had no runner host as the core started: any later one is this run's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunnerHostResource {
    pub udid: String,
    pub bundle_ids: Vec<String>,
}

// The core's xcodebuild runner driver leads its own process group; cleanup signals it only by this identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerDriverResource {
    pub pgid: i32,
    pub identity: PidIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "StoredCoreResource")]
pub struct CoreResource {
    pub pgid: i32,
    pub identity: Option<PidIdentity>,
}

#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
enum StoredCoreResource {
    Explicit {
        pgid: i32,
        identity: Option<PidIdentity>,
    },
    Original {
        pid: i32,
        started_at: String,
        command: OutputText,
    },
}

impl From<StoredCoreResource> for CoreResource {
    fn from(stored: StoredCoreResource) -> Self {
        match stored {
            StoredCoreResource::Explicit { pgid, identity } => Self { pgid, identity },
            StoredCoreResource::Original {
                pid,
                started_at,
                command,
            } => Self {
                // The original qaren-run/1 core spawn also made the child PID its PGID.
                pgid: pid,
                identity: Some(PidIdentity {
                    pid,
                    started_at,
                    command,
                }),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupCleanupResult {
    Removed,
    Absent,
    Refused,
    Unresolved,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoreCleanupEvidence {
    pub run_id: String,
    pub pgid: i32,
    pub at: String,
    pub outcome: GroupCleanupResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshInstallStatus {
    ProvenAbsent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FreshInstallEvidence {
    pub run_id: String,
    pub app_id: String,
    pub device_id: String,
    pub proven_absent_at: String,
    pub status: FreshInstallStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IosSimResource {
    pub udid: String,
    pub name: String,
    pub device_type: String,
    pub runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetroResource {
    pub port: u16,
    pub endpoint: String,
    pub spawned: Spawned,
    pub identity: Option<PidIdentity>,
    pub log: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FarmResource {
    pub ssh_host: String,
    pub farm_path: String,
    pub slot: u8,
    pub holder: String,
    pub avd: String,
    pub remote_serial: String,
    pub adb_port: u16,
}

impl FarmResource {
    // A restarted slot can retain its holder while serving a different emulator.
    pub fn matches_live(&self, slot: &crate::adapters::android::SlotStatus) -> bool {
        crate::adapters::android::lease_holder_token(&slot.lease) == self.holder
            && slot.avd == self.avd
            && slot.serial == self.remote_serial
            && slot.adb_port == self.adb_port
            && slot.state == "device"
    }
}

// Durable install evidence is required for cleanup to claim ownership of the package.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInstallResource {
    pub app_id: String,
    pub serial: String,
    pub server_port: u16,
    pub artifact: crate::buildplan::CachedArtifact,
    pub via: String,
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removal: Option<AppRemoval>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppRemoval {
    pub at: String,
    pub outcome: OutputText,
    pub installed_sha256: String,
    pub uninstall: OutputText,
    pub pm_path_after: OutputText,
    pub package_list_after: OutputText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelResource {
    pub spawned: Spawned,
    pub identity: Option<PidIdentity>,
    pub local_port: u16,
    pub log: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdbServerResource {
    pub spawned: Spawned,
    pub identity: Option<PidIdentity>,
    pub server_port: u16,
    pub log: PathBuf,
}

// Borrowing records no adb-server process ownership; cleanup keeps the host server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BorrowedEmulatorResource {
    pub serial: String,
    pub avd: String,
    pub server_port: u16,
    pub api_level: u32,
    pub abi: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsbDeviceResource {
    pub serial: String,
    pub lock_dir: PathBuf,
    pub holder: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecorderKind {
    IosSimulator,
    AndroidEmulator,
}

// Persisted before the spawn: a None pid means the spawn outcome is unproven.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderResource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub birth: Option<PidIdentity>,
    // Set only after adb pull succeeds; binds recovery to the complete local bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pulled_sha256: Option<String>,
    pub kind: RecorderKind,
    pub device: String,
    pub output: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrWorktreeResource {
    pub repo_root: PathBuf,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildLockResource {
    pub lock_dir: PathBuf,
    pub holder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum BuildProcess {
    SpawnPending,
    Running {
        pgid: i32,
        identity: Option<PidIdentity>,
    },
}

#[derive(Debug, Clone, Copy)]
pub enum BuildCompletionEvidence {
    NotSpawned,
    Group {
        pgid: i32,
        outcome: GroupCleanupResult,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BorrowedIosStop {
    #[default]
    NotArmed,
    Pending,
    Completed,
}

impl BorrowedIosStop {
    pub fn is_not_armed(&self) -> bool {
        *self == Self::NotArmed
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Resources {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    build_process: Option<BuildProcess>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios_simulator: Option<IosSimResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metro: Option<MetroResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm: Option<FarmResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel: Option<TunnelResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_server: Option<AdbServerResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_vendor_key: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_local_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_device: Option<UsbDeviceResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub android_emulator: Option<BorrowedEmulatorResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_lock: Option<BuildLockResource>,
    // The per-home pool creation lock, persisted before the claim like build_lock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_create_lock: Option<BuildLockResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_reverse_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_install: Option<AppInstallResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<crate::lease::Lease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core: Option<CoreResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_cleanup: Option<CoreCleanupEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_install: Option<FreshInstallEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recorder: Option<RecorderResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_host: Option<RunnerHostResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub runner_drivers: Vec<RunnerDriverResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_worktree: Option<PrWorktreeResource>,
    // A borrowed device is never deleted; iOS simulator stop requires an explicit bounded intent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub device_borrowed: bool,
    #[serde(default, skip_serializing_if = "BorrowedIosStop::is_not_armed")]
    borrowed_ios_stop: BorrowedIosStop,
}

impl Resources {
    // The adb path, device serial and server port every device command of this run goes through.
    pub fn adb_endpoint(&self) -> Option<(PathBuf, String, u16)> {
        let port = self
            .adb_server
            .as_ref()
            .map(|s| s.server_port)
            .or_else(|| self.android_emulator.as_ref().map(|e| e.server_port))?;
        Some((self.adb_path.clone()?, self.adb_local_serial.clone()?, port))
    }

    pub fn build_process(&self) -> Option<&BuildProcess> {
        self.build_process.as_ref()
    }

    pub fn can_release_build_ownership(&self) -> bool {
        self.build_process.is_none()
    }

    pub fn begin_build(&mut self) -> Result<(), Failure> {
        if self.build_process.is_some() {
            return Err(Self::invalid_build_transition());
        }
        self.build_process = Some(BuildProcess::SpawnPending);
        Ok(())
    }

    pub fn record_build_spawned(
        &mut self,
        pgid: i32,
        identity: Option<PidIdentity>,
    ) -> Result<(), Failure> {
        if !matches!(self.build_process, Some(BuildProcess::SpawnPending))
            || pgid < 2
            || identity
                .as_ref()
                .is_some_and(|i| i.pid != pgid || i.started_at.trim().is_empty())
        {
            return Err(Self::invalid_build_transition());
        }
        self.build_process = Some(BuildProcess::Running { pgid, identity });
        Ok(())
    }

    pub fn finish_build(&mut self, evidence: BuildCompletionEvidence) -> Result<(), Failure> {
        let proven = match (&self.build_process, evidence) {
            (Some(BuildProcess::SpawnPending), BuildCompletionEvidence::NotSpawned) => true,
            (
                Some(BuildProcess::Running { pgid, .. }),
                BuildCompletionEvidence::Group {
                    pgid: observed,
                    outcome: GroupCleanupResult::Absent | GroupCleanupResult::Removed,
                },
            ) => *pgid >= 2 && *pgid == observed,
            _ => false,
        };
        if !proven {
            return Err(Self::invalid_build_transition());
        }
        self.build_process = None;
        Ok(())
    }

    fn invalid_build_transition() -> Failure {
        Failure::new(
            "build",
            FailureCode::RunRecordInvalid,
            "build process transition lacks matching state or proof",
            "retain build ownership and resolve the recorded process before retrying",
        )
    }

    pub fn borrowed_ios_stop(&self) -> BorrowedIosStop {
        self.borrowed_ios_stop
    }

    pub fn can_release_borrowed_ios_stop(&self) -> bool {
        self.borrowed_ios_stop != BorrowedIosStop::Pending
    }

    pub(crate) fn ios_simulator_canonical(sim: &IosSimResource) -> bool {
        crate::adapters::ios::canonical_udid(&sim.udid).as_deref() == Some(sim.udid.as_str())
            && !sim.name.trim().is_empty()
            && !sim.device_type.trim().is_empty()
            && sim
                .runtime
                .strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-")
                .is_some_and(|s| !s.is_empty())
    }

    pub fn arm_borrowed_ios_stop(&mut self) -> Result<(), Failure> {
        if self.borrowed_ios_stop != BorrowedIosStop::NotArmed
            || !self.device_borrowed
            || self.lease.is_none()
            || !self
                .ios_simulator
                .as_ref()
                .is_some_and(Self::ios_simulator_canonical)
        {
            return Err(Self::invalid_borrowed_ios_stop_transition());
        }
        self.borrowed_ios_stop = BorrowedIosStop::Pending;
        Ok(())
    }

    pub fn complete_borrowed_ios_stop(&mut self, udid: &str) -> Result<(), Failure> {
        if self.borrowed_ios_stop != BorrowedIosStop::Pending
            || !self.device_borrowed
            || !self
                .ios_simulator
                .as_ref()
                .is_some_and(|sim| Self::ios_simulator_canonical(sim) && sim.udid == udid)
        {
            return Err(Self::invalid_borrowed_ios_stop_transition());
        }
        self.borrowed_ios_stop = BorrowedIosStop::Completed;
        Ok(())
    }

    pub fn revert_borrowed_ios_stop(&mut self, prev: BorrowedIosStop) {
        self.borrowed_ios_stop = prev;
    }

    fn invalid_borrowed_ios_stop_transition() -> Failure {
        Failure::new(
            "device",
            FailureCode::RunRecordInvalid,
            "borrowed iOS simulator stop transition lacks matching state or canonical simulator identity",
            "retain the device lease and resolve simulator stop state before retrying",
        )
    }

    pub fn any_owned(&self) -> bool {
        self.build_process.is_some()
            || self.ios_simulator.is_some()
            || self.metro.is_some()
            || self.farm.is_some()
            || self.tunnel.is_some()
            || self.adb_server.is_some()
            || self.adb_vendor_key.is_some()
            || self.usb_device.is_some()
            || self.build_lock.is_some()
            || self.pool_create_lock.is_some()
            || self.lease.is_some()
            || self.core.is_some()
            || !self.runner_drivers.is_empty()
            || self.recorder.is_some()
            || self.pr_worktree.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: String,
    pub phase: String,
    pub note: OutputText,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub schema: String,
    pub run_id: String,
    pub created_at: String,
    pub scenario: Scenario,
    pub scenario_path: PathBuf,
    pub scenario_sha256: String,
    pub candidate: Candidate,
    pub phase: Phase,
    // The install/launch substage in flight, kept after a failure so receipts and status name it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub substage: Option<String>,
    pub prepare: Option<PidIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<crate::buildplan::BuildPlan>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<crate::handoff::HandoffState>,
    #[serde(default)]
    pub resources: Resources,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<HistoryEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TerminalResult>,
}

// Written once, after video finalization and teardown; publication trusts nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResult {
    pub verdict: String,
    pub cancelled: bool,
    pub final_verification: FinalVerification,
    pub ownership_proven: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalVerification {
    pub tested: String,
    #[serde(rename = "match")]
    pub matched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl TerminalResult {
    pub fn publication_refusal(&self) -> Option<Failure> {
        let refuse = |code, detail: &str, next: &str| {
            Some(Failure::new(
                "publish",
                code,
                detail.to_string(),
                next.to_string(),
            ))
        };
        if self.cancelled {
            return refuse(
                FailureCode::RunCancelled,
                "the run was cancelled before its result was final",
                "re-run qaren pr; a cancelled run is never published",
            );
        }
        if !self.final_verification.matched {
            return refuse(
                FailureCode::CandidateDrifted,
                &format!(
                    "the tested candidate {} did not verify unchanged at the end of the run",
                    self.final_verification.tested
                ),
                "re-run qaren pr against an unchanged candidate",
            );
        }
        if !self.ownership_proven {
            return refuse(
                FailureCode::OwnershipUnproven,
                "the run's build, core or Metro processes were not proven gone at teardown",
                "run qaren cleanup for this run, then re-run qaren pr",
            );
        }
        None
    }
}

pub fn validate_run_id(run_id: &str) -> Result<(), Failure> {
    let ok = !run_id.is_empty()
        && !run_id.starts_with('-')
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(Failure::new(
            "load",
            FailureCode::RunRecordInvalid,
            format!("run id {run_id:?} must match [A-Za-z0-9-]+ and not start with -"),
            "pass a run id exactly as emitted by qaren prepare",
        ))
    }
}

impl RunRecord {
    pub(crate) fn holds_device_lease(&self) -> bool {
        self.resources.lease.as_ref().is_some_and(|lease| {
            crate::buildplan::read_holder(&lease.lock_dir)
                .is_some_and(|h| h.holder == lease.holder && h.run_id == self.run_id)
        })
    }

    pub fn run_dir(runs_root: &Path, run_id: &str) -> PathBuf {
        runs_root.join(run_id)
    }

    pub fn path(runs_root: &Path, run_id: &str) -> PathBuf {
        Self::run_dir(runs_root, run_id).join("run.json")
    }

    pub fn save(&self, runs_root: &Path) -> Result<(), Failure> {
        validate_run_id(&self.run_id)?;
        let dir = Self::run_dir(runs_root, &self.run_id);
        let target = dir.join("run.json");
        let tmp = dir.join(format!(".run.json.tmp.{}", std::process::id()));
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            let body = serde_json::to_string_pretty(self)
                .map_err(|e| std::io::Error::other(format!("serialize run record: {e}")))?;
            std::fs::write(&tmp, body)?;
            std::fs::rename(&tmp, &target)?;
            Ok(())
        };
        write().map_err(|e| {
            Failure::new(
                self.phase.as_str(),
                FailureCode::RunRecordUpdateFailed,
                format!("cannot persist {}: {e}", target.display()),
                "check .qaren directory permissions",
            )
        })
    }

    pub fn load(runs_root: &Path, run_id: &str) -> Result<RunRecord, Failure> {
        validate_run_id(run_id)?;
        let path = Self::path(runs_root, run_id);
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            Failure::new(
                "load",
                FailureCode::RunRecordUnavailable,
                format!("cannot read {}: {e}", path.display()),
                "pass a run id that exists under .qaren/runs/",
            )
        })?;
        let record: RunRecord = serde_json::from_str(&raw).map_err(|e| {
            Failure::new(
                "load",
                FailureCode::RunRecordInvalid,
                format!("{} is not a valid {RUN_SCHEMA} record: {e}", path.display()),
                "the record is corrupt; resolve ownership manually before touching resources",
            )
        })?;
        if record.schema != RUN_SCHEMA {
            return Err(Failure::new(
                "load",
                FailureCode::RunRecordInvalid,
                format!(
                    "{} carries schema {:?}, expected {RUN_SCHEMA}",
                    path.display(),
                    record.schema
                ),
                "this qaren build cannot interpret the record; do not guess ownership",
            ));
        }
        if record.run_id != run_id {
            return Err(Failure::new(
                "load",
                FailureCode::RunRecordInvalid,
                format!(
                    "{} embeds run_id {:?}, expected {run_id:?}",
                    path.display(),
                    record.run_id
                ),
                "the record is inconsistent; resolve ownership manually before touching resources",
            ));
        }
        if !record.resources.borrowed_ios_stop.is_not_armed()
            && (record.scenario.platform != Platform::Ios
                || !record.resources.device_borrowed
                || !record
                    .resources
                    .ios_simulator
                    .as_ref()
                    .is_some_and(Resources::ios_simulator_canonical))
        {
            return Err(Failure::new(
                "load",
                FailureCode::RunRecordInvalid,
                format!(
                    "{} carries borrowed_ios_stop without a borrowed canonical iOS simulator resource",
                    path.display()
                ),
                "the record is inconsistent; resolve ownership manually before touching resources",
            ));
        }
        Ok(record)
    }

    // Only the recorded farm port's tunnel endpoint can address this run's emulator.
    pub fn farm_serial_consistent(&self) -> bool {
        let (Some(farm), Some(serial)) = (&self.resources.farm, &self.resources.adb_local_serial)
        else {
            return false;
        };
        let tunnel_port = self.resources.tunnel.as_ref().map(|t| t.local_port);
        crate::adapters::android::is_tunneled_serial(serial)
            && tunnel_port == Some(farm.adb_port)
            && *serial == crate::adapters::android::local_serial(farm.adb_port)
    }

    pub fn push_history(&mut self, at: String, note: &str) {
        self.history.push(HistoryEntry {
            at,
            phase: self.phase.as_str().to_string(),
            note: crate::redact::OutputText::from_output(note),
        });
    }
}

pub fn capture_pid_identity(runner: &mut dyn Runner, pid: i32) -> Option<PidIdentity> {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    let started = runner.run(&CmdSpec::new(
        "ps-lstart",
        "ps",
        &["-p", &pid.to_string(), "-o", "lstart="],
        10,
    ));
    let command = runner.run(&CmdSpec::new(
        "ps-command",
        "ps",
        &["-p", &pid.to_string(), "-o", "command="],
        10,
    ));
    if !started.ok()
        || started.stdout.trim().is_empty()
        || !command.ok()
        || command.stdout.trim().is_empty()
    {
        return None;
    }
    Some(PidIdentity {
        pid,
        started_at: started.stdout.trim().to_string(),
        command: crate::redact::OutputText::from_output(command.stdout.trim()),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidLiveness {
    AliveMatching,
    AliveForeign,
    Dead,
    Unknown,
}

pub fn probe_pid_identity(runner: &mut dyn Runner, recorded: &PidIdentity) -> PidLiveness {
    probe_pid_birth(runner, recorded).0
}

// Also reports whether the recorded birth still holds the pid, alive or as an unreaped zombie, so it cannot be reused.
pub fn probe_pid_birth(runner: &mut dyn Runner, recorded: &PidIdentity) -> (PidLiveness, bool) {
    let started = runner.run(&CmdSpec::new(
        "ps-lstart",
        "ps",
        &["-p", &recorded.pid.to_string(), "-o", "lstart="],
        10,
    ));
    if started.timed_out || started.exit_code.is_none() || !started.stderr.trim().is_empty() {
        return (PidLiveness::Unknown, false);
    }
    if !started.ok() || started.stdout.trim().is_empty() {
        return (PidLiveness::Dead, false);
    }
    // lstart is the birth identity; the command line is advisory only, because
    // pnpm shims exec-transition (sh -> node) after our capture.
    if started.stdout.trim() != recorded.started_at {
        return (PidLiveness::AliveForeign, false);
    }
    // A zombie keeps its lstart but is dead: unreaped child of a live
    // parent (e.g. a build that exited while prepare still polls it).
    let stat = runner.run(&CmdSpec::new(
        "ps-stat",
        "ps",
        &["-p", &recorded.pid.to_string(), "-o", "stat="],
        10,
    ));
    if !stat.ok() {
        return (PidLiveness::Unknown, false);
    }
    if stat.stdout.trim_start().starts_with('Z') {
        return (PidLiveness::Dead, true);
    }
    (PidLiveness::AliveMatching, true)
}
