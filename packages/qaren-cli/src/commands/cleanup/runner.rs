use super::*;
use crate::failure::RecoveryReason;
use crate::runrecord::{
    RunnerDriverDetail, RunnerDriverResource, RunnerDriverResult, RunnerSignal,
};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerCleanupPolicy {
    GracefulOnly,
    ReapRecordedDriver,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DriverObservation {
    v: u8,
    pid: i32,
    birth: DriverBirth,
    executable: String,
    argv: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DriverBirth {
    seconds: u64,
    micros: u64,
}

fn eligible_command(saved: &str, raw: &str, argv: &[String], udid: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty()
        || raw.len() > 8192
        || raw.chars().any(char::is_control)
        || raw != saved
        || raw != argv.join(" ")
        || crate::redact::redact_secrets(raw) != raw
        || [
            "[REDACTED_SECRET]",
            "[output withheld:",
            "<redacted>",
            "[REDACTED_INPUT]",
        ]
        .iter()
        .any(|marker| raw.contains(marker))
        || argv.len() != 11
        || argv
            .iter()
            .any(|arg| arg.is_empty() || arg.chars().any(char::is_control))
    {
        return false;
    }
    let absolute = |s: &str| Path::new(s).is_absolute() && !s.split('/').any(|part| part == "..");
    if Path::new(&argv[0]).file_name().and_then(|s| s.to_str()) != Some("xcodebuild")
        || argv[1] != "test-without-building"
        || argv[2] != "-project"
        || !absolute(&argv[3])
        || argv[4] != "-scheme"
        || argv[6] != "-destination"
        || argv[7] != format!("platform=iOS Simulator,id={udid}")
        || argv[8] != "-derivedDataPath"
        || !absolute(&argv[9])
    {
        return false;
    }
    ["QarenIosRunner", "RnFastRunner"].iter().any(|family| {
        argv[3].ends_with(&format!("/{family}/{family}.xcodeproj"))
            && argv[5] == *family
            && argv[10] == format!("-only-testing:{family}UITests/{family}Tests/testCommand")
    })
}

fn driver_liveness(runner: &mut dyn Runner, identity: &PidIdentity) -> PidLiveness {
    let pid = identity.pid.to_string();
    let birth = runner.run(&CmdSpec::new(
        "ps-lstart",
        "ps",
        &["-p", &pid, "-o", "lstart="],
        10,
    ));
    if birth.timed_out || birth.exit_code.is_none() || !birth.stderr.is_empty() {
        return PidLiveness::Unknown;
    }
    if birth.stdout.trim().is_empty() && matches!(birth.exit_code, Some(0 | 1)) {
        return PidLiveness::Dead;
    }
    if !birth.ok() {
        return PidLiveness::Unknown;
    }
    if birth.stdout.trim() != identity.started_at {
        return PidLiveness::AliveForeign;
    }
    let stat = runner.run(&CmdSpec::new(
        "ps-stat",
        "ps",
        &["-p", &pid, "-o", "stat="],
        10,
    ));
    if !stat.ok()
        || !stat.stderr.is_empty()
        || stat.stdout.trim().is_empty()
        || stat.stdout.trim().chars().any(char::is_whitespace)
    {
        return PidLiveness::Unknown;
    }
    if stat.stdout.trim_start().starts_with('Z') {
        PidLiveness::Dead
    } else {
        PidLiveness::AliveMatching
    }
}

fn core_quiescent(record: &RunRecord) -> bool {
    record.resources.core.is_none()
        && record.resources.core_cleanup.as_ref().is_none_or(|e| {
            e.run_id == record.run_id
                && matches!(
                    e.outcome,
                    GroupCleanupResult::Absent | GroupCleanupResult::Removed
                )
        })
}

fn context_proof(
    runner: &mut dyn Runner,
    record: &RunRecord,
    runs_root: &Path,
    driver: &RunnerDriverResource,
) -> Result<String, RecoveryReason> {
    use RecoveryReason::*;
    let saved = RunRecord::load(runs_root, &record.run_id).map_err(|_| LeaseUnproven)?;
    let sim = record
        .resources
        .ios_simulator
        .as_ref()
        .ok_or(LeaseUnproven)?;
    let lease = record.resources.lease.as_ref().ok_or(LeaseUnproven)?;
    let saved_lease = saved.resources.lease.as_ref().ok_or(LeaseUnproven)?;
    if record.scenario.platform != Platform::Ios
        || saved
            .resources
            .ios_simulator
            .as_ref()
            .is_none_or(|s| s.udid != sim.udid)
        || lease.run_id != record.run_id
        || saved_lease.run_id != lease.run_id
        || saved_lease.holder != lease.holder
        || saved_lease.token != lease.token
        || saved_lease.lock_dir != lease.lock_dir
        || lease.lock_dir.file_name().and_then(|s| s.to_str())
            != Some(crate::lease::lock_name(Platform::Ios, &sim.udid).as_str())
        || !crate::buildplan::read_holder(&lease.lock_dir)
            .is_some_and(|h| h.holder == lease.holder && h.run_id == lease.run_id)
    {
        return Err(LeaseUnproven);
    }
    if !saved.resources.runner_drivers.iter().any(|d| {
        d.pgid == driver.pgid
            && d.identity.pid == driver.identity.pid
            && d.identity.started_at == driver.identity.started_at
            && d.identity.command == driver.identity.command
    }) {
        return Err(IdentityMismatch);
    }
    let owner = saved.prepare.as_ref().ok_or(OwnerUnproven)?;
    if !matches!(
        probe_pid_identity(runner, owner),
        PidLiveness::Dead | PidLiveness::AliveForeign
    ) {
        return Err(OwnerUnproven);
    }
    if !core_quiescent(record) || !core_quiescent(&saved) {
        return Err(CoreUnproven);
    }
    if let Some(core) = &saved.resources.core_cleanup {
        if metro::group_presence(runner, core.pgid) != metro::GroupPresence::Absent {
            return Err(CoreUnproven);
        }
    }
    Ok(sim.udid.clone())
}

fn live_proof(
    runner: &mut dyn Runner,
    record: &RunRecord,
    runs_root: &Path,
    driver: &RunnerDriverResource,
) -> Result<(), RecoveryReason> {
    use RecoveryReason::*;
    if driver.pgid <= 1 || driver.identity.pid != driver.pgid {
        return Err(IdentityMismatch);
    }
    let udid = context_proof(runner, record, runs_root, driver)?;
    match driver_liveness(runner, &driver.identity) {
        PidLiveness::AliveMatching => {}
        PidLiveness::Unknown => return Err(IdentityUnknown),
        _ => return Err(IdentityMismatch),
    }
    let pid = driver.identity.pid.to_string();
    let raw = runner.run_private(
        &CmdSpec::new(
            "runner-command-proof",
            "ps",
            &["-ww", "-p", &pid, "-o", "command="],
            10,
        ),
        b"",
    );
    let exe = std::env::current_exe().map_err(|_| IdentityUnknown)?;
    let observation = runner.run_private(
        &CmdSpec::new(
            "runner-argv-proof",
            &exe.to_string_lossy(),
            &[crate::process_observation::HELPER_ARG, &pid, "--argv"],
            10,
        ),
        b"",
    );
    if !raw.clean() || !observation.clean() || observation.stdout().len() > 32768 {
        return Err(IdentityUnknown);
    }
    let observation: DriverObservation =
        serde_json::from_str(observation.stdout()).map_err(|_| IdentityUnknown)?;
    if observation.v != 1
        || observation.pid != driver.identity.pid
        || observation.executable.is_empty()
        || observation.birth.seconds == 0
        || observation.birth.micros >= 1_000_000
        || observation.argv.iter().map(String::len).sum::<usize>() > 8192
    {
        return Err(IdentityUnknown);
    }
    if !eligible_command(
        &driver.identity.command,
        raw.stdout(),
        &observation.argv,
        &udid,
    ) {
        return Err(CommandIneligible);
    }
    context_proof(runner, record, runs_root, driver)?;
    match driver_liveness(runner, &driver.identity) {
        PidLiveness::AliveMatching => Ok(()),
        PidLiveness::Unknown => Err(IdentityUnknown),
        _ => Err(IdentityMismatch),
    }
}

fn absence(runner: &mut dyn Runner, driver: &RunnerDriverResource) -> Result<(), RecoveryReason> {
    let pid = driver_liveness(runner, &driver.identity);
    let group = metro::group_presence(runner, driver.pgid);
    match (pid, group) {
        (PidLiveness::Dead, metro::GroupPresence::Absent) => Ok(()),
        (PidLiveness::Unknown, _) => Err(RecoveryReason::IdentityUnknown),
        (PidLiveness::AliveForeign, _) => Err(RecoveryReason::IdentityMismatch),
        (_, metro::GroupPresence::Unknown) => Err(RecoveryReason::InventoryUnknown),
        (PidLiveness::Dead, _) => Err(RecoveryReason::GroupRemaining),
        _ => Err(RecoveryReason::DriverSurvived),
    }
}

fn refused(reason: RecoveryReason, signals: Vec<RunnerSignal>) -> RunnerDriverDetail {
    use RecoveryReason::*;
    let ownership = matches!(
        reason,
        IdentityMismatch
            | IdentityUnknown
            | CommandIneligible
            | LeaseUnproven
            | OwnerUnproven
            | CoreUnproven
    );
    RunnerDriverDetail {
        result: if ownership {
            RunnerDriverResult::Refused
        } else {
            RunnerDriverResult::Unresolved
        },
        identity_matched: !signals.is_empty(),
        signals,
        reason: Some(reason),
        liveness: None,
    }
}

fn reap_inner(
    runner: &mut dyn Runner,
    record: &RunRecord,
    runs_root: &Path,
    driver: &RunnerDriverResource,
) -> RunnerDriverDetail {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    runner.try_reap(driver.pgid);
    // Ownership is required even when the group disappeared before the driver did.
    if let Err(reason) = context_proof(runner, record, runs_root, driver) {
        return refused(reason, vec![]);
    }
    match absence(runner, driver) {
        Ok(()) => {
            return RunnerDriverDetail {
                result: RunnerDriverResult::Absent,
                signals: vec![],
                identity_matched: false,
                reason: None,
                liveness: None,
            }
        }
        Err(RecoveryReason::DriverSurvived) => {}
        Err(reason) => return refused(reason, vec![]),
    }
    let mut signals = Vec::new();
    for signal in [RunnerSignal::Int, RunnerSignal::Term, RunnerSignal::Kill] {
        match metro::group_presence(runner, driver.pgid) {
            metro::GroupPresence::Present => {}
            metro::GroupPresence::Unknown => {
                return refused(RecoveryReason::InventoryUnknown, signals)
            }
            metro::GroupPresence::Absent => {
                return match absence(runner, driver) {
                    Ok(()) => RunnerDriverDetail {
                        result: if signals.len() > 1 {
                            RunnerDriverResult::Reaped
                        } else if signals.is_empty() {
                            RunnerDriverResult::Absent
                        } else {
                            RunnerDriverResult::Removed
                        },
                        identity_matched: !signals.is_empty(),
                        signals,
                        reason: None,
                        liveness: None,
                    },
                    Err(reason) => refused(reason, signals),
                };
            }
        }
        if let Err(reason) = live_proof(runner, record, runs_root, driver) {
            return refused(reason, signals);
        }
        let name = match signal {
            RunnerSignal::Int => "-INT",
            RunnerSignal::Term => "-TERM",
            RunnerSignal::Kill => "-KILL",
        };
        signals.push(signal);
        runner.run(&CmdSpec::new(
            "kill-group",
            "/bin/kill",
            &[name, "--", &driver.identity.pid.to_string()],
            10,
        ));
        let polls = if signal == RunnerSignal::Int { 30 } else { 1 };
        for _ in 0..polls {
            runner.sleep(match signal {
                RunnerSignal::Int => Duration::from_secs(1),
                RunnerSignal::Term => Duration::from_millis(1500),
                RunnerSignal::Kill => Duration::from_millis(300),
            });
            runner.try_reap(driver.pgid);
            match absence(runner, driver) {
                Ok(()) => {
                    return RunnerDriverDetail {
                        result: if signals.len() > 1 {
                            RunnerDriverResult::Reaped
                        } else {
                            RunnerDriverResult::Removed
                        },
                        signals,
                        identity_matched: true,
                        reason: None,
                        liveness: None,
                    }
                }
                Err(RecoveryReason::DriverSurvived) => {}
                Err(reason) => return refused(reason, signals),
            }
        }
    }
    refused(RecoveryReason::DriverSurvived, signals)
}

pub(super) fn outcome(detail: &RunnerDriverDetail) -> Outcome {
    match detail.result {
        RunnerDriverResult::Absent => Outcome::Absent,
        RunnerDriverResult::Removed | RunnerDriverResult::Reaped => Outcome::Removed,
        RunnerDriverResult::Refused => {
            Outcome::Refused(format!("runner proof refused ({:?})", detail.reason))
        }
        RunnerDriverResult::Unresolved => {
            Outcome::Unresolved(format!("runner cleanup incomplete ({:?})", detail.reason))
        }
    }
}

fn graceful_inner(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
) -> RunnerDriverDetail {
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
    if pgid < 2 {
        return refused(RecoveryReason::IdentityMismatch, vec![]);
    }
    runner.try_reap(pgid);
    match metro::group_presence(runner, pgid) {
        metro::GroupPresence::Absent => {
            let missing = PidIdentity {
                pid: pgid,
                started_at: String::new(),
                command: crate::redact::OutputText::from_output(""),
            };
            return match probe_pid_identity(runner, identity.unwrap_or(&missing)) {
                PidLiveness::Dead => RunnerDriverDetail {
                    result: RunnerDriverResult::Absent,
                    signals: vec![],
                    identity_matched: false,
                    reason: None,
                    liveness: None,
                },
                _ => refused(RecoveryReason::IdentityUnknown, vec![]),
            };
        }
        metro::GroupPresence::Unknown => return refused(RecoveryReason::InventoryUnknown, vec![]),
        metro::GroupPresence::Present => {}
    }
    let Some(identity) = identity.filter(|identity| identity.pid == pgid) else {
        return refused(RecoveryReason::IdentityUnknown, vec![]);
    };
    if probe_pid_identity(runner, identity) != PidLiveness::AliveMatching {
        runner.sleep(Duration::from_millis(300));
        runner.try_reap(pgid);
        let driver = RunnerDriverResource {
            pgid,
            identity: identity.clone(),
        };
        return match absence(runner, &driver) {
            Ok(()) => RunnerDriverDetail {
                result: RunnerDriverResult::Absent,
                signals: vec![],
                identity_matched: false,
                reason: None,
                liveness: None,
            },
            Err(reason) => refused(reason, vec![]),
        };
    }
    if !crate::runrecord::probe_pid_birth(runner, identity).1 {
        return refused(RecoveryReason::IdentityMismatch, vec![]);
    }
    runner.run(&CmdSpec::new(
        "kill-group",
        "/bin/kill",
        &["-INT", "--", &pgid.to_string()],
        10,
    ));
    for _ in 0..30 {
        runner.sleep(Duration::from_secs(1));
        runner.try_reap(pgid);
        match metro::group_presence(runner, pgid) {
            metro::GroupPresence::Absent => {
                return match probe_pid_identity(runner, identity) {
                    PidLiveness::Dead => RunnerDriverDetail {
                        result: RunnerDriverResult::Removed,
                        signals: vec![RunnerSignal::Int],
                        identity_matched: true,
                        reason: None,
                        liveness: None,
                    },
                    _ => refused(RecoveryReason::IdentityUnknown, vec![RunnerSignal::Int]),
                }
            }
            metro::GroupPresence::Unknown => {
                return refused(RecoveryReason::InventoryUnknown, vec![RunnerSignal::Int])
            }
            metro::GroupPresence::Present => {}
        }
        match probe_pid_identity(runner, identity) {
            PidLiveness::AliveMatching => {}
            PidLiveness::Dead => {
                return refused(RecoveryReason::GroupRemaining, vec![RunnerSignal::Int])
            }
            PidLiveness::AliveForeign => {
                return refused(RecoveryReason::IdentityMismatch, vec![RunnerSignal::Int])
            }
            PidLiveness::Unknown => {
                return refused(RecoveryReason::IdentityUnknown, vec![RunnerSignal::Int])
            }
        }
    }
    refused(RecoveryReason::GracefulPending, vec![RunnerSignal::Int])
}

pub(super) fn graceful(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
) -> RunnerDriverDetail {
    let mut detail = graceful_inner(runner, identity, pgid);
    if pgid > 1 && detail.result == RunnerDriverResult::Refused {
        detail.result = RunnerDriverResult::Unresolved;
    }
    detail
}

pub(super) fn reap(
    runner: &mut dyn Runner,
    record: &RunRecord,
    runs_root: &Path,
    driver: &RunnerDriverResource,
) -> RunnerDriverDetail {
    use crate::runrecord::{RunnerDriverLiveness, RunnerPresence};
    let mut detail = reap_inner(runner, record, runs_root, driver);
    if driver.pgid <= 1 || driver.identity.pid != driver.pgid {
        return detail;
    }
    let pid = driver_liveness(runner, &driver.identity);
    let group = metro::group_presence(runner, driver.pgid);
    if outcome(&detail).clean()
        && !(pid == PidLiveness::Dead && group == metro::GroupPresence::Absent)
    {
        detail = refused(
            if pid == PidLiveness::Unknown {
                RecoveryReason::IdentityUnknown
            } else if pid == PidLiveness::AliveForeign {
                RecoveryReason::IdentityMismatch
            } else if group == metro::GroupPresence::Unknown {
                RecoveryReason::InventoryUnknown
            } else if pid == PidLiveness::Dead {
                RecoveryReason::GroupRemaining
            } else {
                RecoveryReason::DriverSurvived
            },
            detail.signals,
        );
    }
    detail.liveness = Some(RunnerDriverLiveness {
        driver: match pid {
            PidLiveness::Dead => RunnerPresence::Absent,
            PidLiveness::AliveMatching => RunnerPresence::Present,
            PidLiveness::AliveForeign => RunnerPresence::Foreign,
            PidLiveness::Unknown => RunnerPresence::Unknown,
        },
        group: match group {
            metro::GroupPresence::Absent => RunnerPresence::Absent,
            metro::GroupPresence::Present => RunnerPresence::Present,
            metro::GroupPresence::Unknown => RunnerPresence::Unknown,
        },
    });
    detail
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complete_argv_grammar_rejects_lossy_or_ambiguous_commands() {
        let argv: Vec<String> = [
            "xcodebuild",
            "test-without-building",
            "-project",
            "/runtime/QarenIosRunner/QarenIosRunner.xcodeproj",
            "-scheme",
            "QarenIosRunner",
            "-destination",
            "platform=iOS Simulator,id=synthetic",
            "-derivedDataPath",
            "/derived data",
            "-only-testing:QarenIosRunnerUITests/QarenIosRunnerTests/testCommand",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let command = argv.join(" ");
        assert!(eligible_command(
            &command,
            &format!(" {command}\n"),
            &argv,
            "synthetic"
        ));
        for (index, replacement) in [
            (0, "other-tool"),
            (1, "test"),
            (2, "-scheme"),
            (3, "relative/QarenIosRunner/QarenIosRunner.xcodeproj"),
            (3, "/runtime/../QarenIosRunner/QarenIosRunner.xcodeproj"),
            (4, "-project"),
            (5, "RnFastRunner"),
            (6, "-scheme"),
            (7, "platform=iOS Simulator,id=other"),
            (8, "-project"),
            (9, "relative"),
            (9, "/derived\ncontrol"),
            (9, "/[REDACTED_SECRET]"),
            (9, "/[REDACTED_INPUT]"),
            (9, "/<redacted>"),
            (9, "/[output withheld: command]"),
            (10, "-only-testing:OtherTests/testCommand"),
        ] {
            let mut changed = argv.clone();
            changed[index] = replacement.into();
            assert!(
                !eligible_command(
                    &changed.join(" "),
                    &changed.join(" "),
                    &changed,
                    "synthetic"
                ),
                "index {index}"
            );
        }
        assert!(!eligible_command("", "", &argv, "synthetic"));
        assert!(!eligible_command(
            &command,
            &format!("{command} extra"),
            &argv,
            "synthetic"
        ));
        let mut too_long = argv.clone();
        too_long[9] = format!("/{}", "x".repeat(8192));
        assert!(!eligible_command(
            &too_long.join(" "),
            &too_long.join(" "),
            &too_long,
            "synthetic"
        ));
    }
}
