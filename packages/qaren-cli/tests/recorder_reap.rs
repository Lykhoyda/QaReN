#![cfg(unix)]
mod common;

use qaren::commands::cleanup::Outcome;
use qaren::exec::{CmdOutput, CmdSpec, PipedChild, RealRunner, Runner, Spawned};
use qaren::record;
use qaren::runrecord::{capture_pid_identity, Phase, RecorderKind, RecorderResource, RunRecord};
use std::path::{Path, PathBuf};
use std::time::Duration;

const CLEAN_RECORDER: &str = "trap 'exit 0' INT; while :; do sleep 0.1; done";
const SURVIVING_MEMBER: &str =
    "trap 'exit 0' INT; (trap '' INT; while :; do sleep 0.1; done) & while :; do sleep 0.1; done";

fn runner() -> RealRunner {
    RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into())
}

fn walking_record() -> (PathBuf, RunRecord) {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "check-20261003T000000Z",
        Phase::Walking,
    );
    std::fs::create_dir_all(RunRecord::run_dir(&repo, &record.run_id).join("logs")).unwrap();
    record.save(&repo).unwrap();
    (repo, record)
}

fn own_recorder(runner: &mut dyn Runner, record: &mut RunRecord, root: &Path, script: &str) -> i32 {
    let log = RunRecord::run_dir(root, &record.run_id).join("logs/recorder.log");
    let spawned = runner
        .spawn_group(
            &CmdSpec::new("fake-recorder", "/bin/sh", &["-c", script], 0),
            &log,
        )
        .unwrap();
    // Let the shell install its trap before it is interrupted.
    std::thread::sleep(Duration::from_millis(300));
    let birth = capture_pid_identity(runner, spawned.pid).expect("recorder identity");
    record.resources.recorder = Some(RecorderResource {
        pid: Some(spawned.pid),
        birth: Some(birth),
        pulled_sha256: None,
        kind: RecorderKind::IosSimulator,
        device: "fixture-device".into(),
        output: PathBuf::from("raw.mov"),
    });
    spawned.pid
}

fn ps_stat(pid: i32) -> String {
    let output = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn kill_group(pgid: i32) {
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{pgid}")])
        .status();
}

// The same real runner, except it never reaps: the behaviour before owner reaping.
struct NeverReaps(RealRunner);

impl Runner for NeverReaps {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.0.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn monotonic_ms(&self) -> u64 {
        self.0.monotonic_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
}

#[test]
fn a_clean_recorder_stop_is_removed_once_its_owner_reaps_the_leader() {
    let (root, mut record) = walking_record();
    let mut runner = runner();
    let pid = own_recorder(&mut runner, &mut record, &root, CLEAN_RECORDER);

    let outcome = record::stop(&mut runner, &mut record, &root);

    assert_eq!(outcome, Outcome::Removed);
    assert_eq!(ps_stat(pid), "", "the leader is reaped, not a zombie");
    assert!(record.resources.recorder.is_none());
}

#[test]
fn without_owner_reaping_the_same_clean_stop_stays_unresolved() {
    let (root, mut record) = walking_record();
    let mut runner = NeverReaps(runner());
    let pid = own_recorder(&mut runner, &mut record, &root, CLEAN_RECORDER);

    let outcome = record::stop(&mut runner, &mut record, &root);

    assert!(matches!(outcome, Outcome::Unresolved(_)), "{outcome:?}");
    assert!(
        ps_stat(pid).starts_with('Z'),
        "an unreaped leader is a zombie"
    );
    assert!(record.resources.recorder.is_some());
    // Dropping the runner drops its Child handles; the zombie is reaped when this test process exits.
}

#[test]
fn a_surviving_group_member_keeps_the_recorder_unresolved_and_owned() {
    let (root, mut record) = walking_record();
    let mut runner = runner();
    let pid = own_recorder(&mut runner, &mut record, &root, SURVIVING_MEMBER);

    let outcome = record::stop(&mut runner, &mut record, &root);
    kill_group(pid);

    assert!(matches!(outcome, Outcome::Unresolved(_)), "{outcome:?}");
    assert!(
        record.resources.recorder.is_some(),
        "ownership retained for a retry"
    );
}

#[test]
fn a_zombie_leader_is_not_a_release_for_a_runner_that_does_not_own_it() {
    let (root, mut record) = walking_record();
    let mut owner = runner();
    let zombie = own_recorder(&mut owner, &mut record, &root, CLEAN_RECORDER);
    assert_eq!(unsafe { libc::getpgid(zombie) }, zombie);
    assert!(std::process::Command::new("/bin/kill")
        .args(["-INT", &zombie.to_string()])
        .status()
        .unwrap()
        .success());
    for _ in 0..100 {
        if ps_stat(zombie).starts_with('Z') {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        ps_stat(zombie).starts_with('Z'),
        "fixture must leave a zombie leader"
    );
    let mut runner = runner();

    let outcome = record::stop(&mut runner, &mut record, &root);
    assert!(owner.try_reap(zombie));

    assert!(matches!(outcome, Outcome::Unresolved(_)), "{outcome:?}");
    assert!(record.resources.recorder.is_some());
}
