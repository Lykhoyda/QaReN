mod common;

use qaren::exec::{
    ChildHandle, CmdOutput, CmdSpec, MockRunner, PipedChild, RealRunner, Runner, Spawned,
};
use qaren::lease;
use qaren::native_suite;
use qaren::scenario::Platform;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const DEVICE: &str = "AAAABBBB-1111-2222-3333-444455556666";
const BIRTH: &str = "Wed Aug 12 16:02:00 2026";

fn inventory(state: &str) -> String {
    serde_json::json!({"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[{
        "udid":DEVICE,"state":state,"isAvailable":true,
        "name":"suite simulator","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"
    }]}})
    .to_string()
}

fn preflight(runner: &mut MockRunner, state: &str) {
    runner.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory(state)),
    );
    runner.expect_run("lstart=", CmdOutput::success(BIRTH));
    runner.expect_run("command=", CmdOutput::success("secret advisory command"));
}

fn admission(runner: &mut MockRunner, status: &str) {
    runner.expect_run(
        "fresh-install-preflight.js",
        CmdOutput {
            exit_code: Some(if status == "clear" { 0 } else { 4 }),
            stdout: serde_json::json!({"v":1,"platform":"ios","deviceId":DEVICE,"status":status})
                .to_string(),
            ..Default::default()
        },
    );
}

fn record_path(home: &std::path::Path) -> PathBuf {
    home.join(".qaren/native-suites")
        .join(format!("native-ios-1770000000000-{}", std::process::id()))
        .join("suite.json")
}

fn setup() -> (MockRunner, PathBuf) {
    let home = common::temp_repo().canonicalize().unwrap();
    let mut runner = MockRunner::new();
    runner
        .environment
        .insert("HOME".into(), home.display().to_string());
    runner.environment.insert(
        "QAREN_LOCK_ROOT".into(),
        home.join(".qaren/locks").display().to_string(),
    );
    (runner, home)
}

#[test]
fn unsupported_inventory_never_claims_or_spawns() {
    for inventory in ["not json", r#"{"devices":{}}"#, r#"{"devices":[]}"#] {
        let (mut runner, home) = setup();
        runner.expect_run("simctl list devices -j", CmdOutput::success(inventory));
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        assert!(!home.join(".qaren/locks").exists());
        assert!(runner.spawned_logs.is_empty());
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn admission_refusal_records_ownership_and_releases_without_mutation() {
    let (mut runner, home) = setup();
    preflight(&mut runner, "Shutdown");
    admission(&mut runner, "busy");
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    assert_eq!(runner.remaining(), 0);
    let raw = std::fs::read_to_string(record_path(&home)).unwrap();
    let record: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(record["device_id"], DEVICE);
    assert!(record["lease"]["token"].as_str().is_some());
    assert!(!raw.contains("secret advisory command"));
    assert!(!PathBuf::from(record["lock_dir"].as_str().unwrap()).exists());
    assert!(runner.spawned_logs.is_empty());
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fault {
    None,
    ClaimSave,
    PendingSave,
    SpawnGap,
    IdentitySave,
    CleanupSave,
}

struct Witness {
    mock: MockRunner,
    home: PathBuf,
    intent: std::cell::RefCell<Option<serde_json::Value>>,
    fault: Fault,
}

impl Witness {
    fn new(mock: MockRunner, home: &Path, fault: Fault) -> Self {
        Self {
            mock,
            home: home.into(),
            intent: Default::default(),
            fault,
        }
    }

    fn block_save(&self) {
        let path = record_path(&self.home);
        std::fs::rename(&path, path.with_extension("saved")).unwrap();
        std::fs::create_dir(path).unwrap();
    }

    fn restore_save(&self) {
        let path = record_path(&self.home);
        std::fs::remove_dir(&path).unwrap();
        std::fs::rename(path.with_extension("saved"), path).unwrap();
    }

    fn record(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(record_path(&self.home)).unwrap()).unwrap()
    }

    fn assert_lease(&self) {
        let record = self.record();
        let lock = PathBuf::from(record["lock_dir"].as_str().unwrap());
        let holder = qaren::buildplan::read_holder(&lock).unwrap();
        assert_eq!(holder.run_id, record["run_id"].as_str().unwrap());
        assert_eq!(holder.identity.unwrap().pid, std::process::id() as i32);
        assert_eq!(record["lease"]["lock_dir"], record["lock_dir"]);
    }
}

struct CheckedStart {
    inner: Box<dyn Write + Send>,
    record: PathBuf,
}

impl Write for CheckedStart {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&self.record)?).unwrap();
        assert_eq!(bytes, b"start\n");
        assert_eq!(record["process"]["state"], "spawned");
        assert_eq!(record["process"]["pgid"], 9000);
        assert_eq!(record["process"]["identity"]["pid"], 9000);
        assert_eq!(record["process"]["identity"]["started_at"], BIRTH);
        assert!(Path::new(record["lock_dir"].as_str().unwrap()).exists());
        self.inner.write(bytes)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl Runner for Witness {
    fn env_var(&self, name: &str) -> Option<String> {
        self.mock.env_var(name)
    }
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "fresh-install-admission" {
            self.assert_lease();
        }
        let output = self.mock.execute(spec, interruptible);
        if (self.fault == Fault::PendingSave && spec.label == "fresh-install-admission")
            || (self.fault == Fault::CleanupSave && spec.label == "simctl-launchctl")
        {
            self.block_save();
        }
        output
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        panic!("native suite must use a stdin-gated child")
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.assert_lease();
        assert_eq!(self.record()["process"]["state"], "spawn_pending");
        let mut contender = MockRunner::new();
        contender.expect_run("lstart=", CmdOutput::success(BIRTH));
        contender.expect_run("stat=", CmdOutput::success("S"));
        let error = lease::acquire(
            &mut contender,
            &self.home.join(".qaren/locks"),
            Platform::Ios,
            DEVICE,
            "other-check",
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, qaren::failure::FailureCode::DeviceBusy);
        let mut child = self.mock.spawn_piped_unchecked(spec, log)?;
        if self.fault == Fault::SpawnGap {
            return Err(std::io::Error::other("lost spawn acknowledgement"));
        }
        if self.fault == Fault::IdentitySave {
            self.block_save();
        }
        child.stdin = Box::new(CheckedStart {
            inner: child.stdin,
            record: record_path(&self.home),
        });
        Ok(child)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.mock.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        if record_path(&self.home).exists() && self.record()["lease"].is_null() {
            assert_eq!(self.record()["process"]["state"], "not_spawned");
            self.intent.replace(Some(self.record()));
            if self.fault == Fault::ClaimSave {
                self.block_save();
            }
        }
        self.mock.now_epoch_ms()
    }
    fn monotonic_ms(&self) -> u64 {
        self.mock.monotonic_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
}

fn suite(runner: &mut MockRunner, exit: Option<i32>) {
    admission(runner, "clear");
    runner.expect_spawn_piped("/bin/bash", 9000, "", exit);
    runner.expect_run("lstart=", CmdOutput::success(BIRTH));
    runner.expect_run("command=", CmdOutput::success("private suite command"));
}

fn absent_group(runner: &mut MockRunner) {
    runner.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
}

fn scoped_hosts(runner: &mut MockRunner, output: CmdOutput) {
    runner.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory("Booted")),
    );
    runner.expect_run(&format!("simctl spawn {DEVICE} launchctl list"), output);
}

fn absent_hosts(runner: &mut MockRunner) {
    scoped_hosts(
        runner,
        CmdOutput::success("PID\tStatus\tLabel\n1\t0\tcom.apple.SpringBoard\n"),
    );
}

#[test]
fn scoped_cleanup_releases_despite_an_unrelated_controller_without_post_admission() {
    let (mut runner, _) = setup();
    preflight(&mut runner, "Booted");
    suite(&mut runner, Some(65));
    runner.expect_run("ps -A", CmdOutput::success("1 1 S\n777 777 S\n"));
    absent_hosts(&mut runner);
    let record = native_suite::run(&mut runner, DEVICE).unwrap();
    assert_eq!(record.suite_exit, Some(65));
    assert!(!record.lock_dir.exists());
    assert_eq!(
        runner
            .calls
            .iter()
            .filter(|c| c.label == "fresh-install-admission")
            .count(),
        1
    );
    assert!(runner
        .calls
        .iter()
        .all(|c| c.program != "/bin/kill" && !c.args.iter().any(|a| a == "terminate")));
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn old_retained_suite_recovers_with_fresh_scoped_proof_and_preserves_exit_65() {
    let (mut runner, home, record) = abandoned();
    let mut old = serde_json::to_value(&record).unwrap();
    old["suite_exit"] = 65.into();
    old["cleanup"] = serde_json::json!({"group":"absent", "admission_clear":false});
    qaren::buildplan::save_json(&record_path(&home), &old).unwrap();
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    runner.expect_run("ps -A", CmdOutput::success("1 1 S\n777 777 S\n"));
    absent_hosts(&mut runner);
    let recovered = native_suite::recover(&mut runner, &record.run_id).unwrap();
    assert_eq!(recovered.suite_exit, Some(65));
    assert!(!record.lock_dir.exists());
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
    assert_eq!(saved["cleanup"]["runner_host"], "absent");
    assert_eq!(saved["cleanup"]["admission_clear"], false);
    assert_eq!(
        runner
            .calls
            .iter()
            .filter(|c| c.label == "fresh-install-admission")
            .count(),
        1
    );
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn scoped_hosts_present_or_unknown_retain_old_suite_without_signals() {
    for (output, reads) in [
        (CmdOutput::success("PID Status Label\n42 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner[abc][rb-legacy]\n"), 1),
        (CmdOutput::success("PID Status Label\n43 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner.uitests.xctrunner[abc]\n"), 1),
        (CmdOutput::failed(1, "unreadable inventory"), 3),
        (CmdOutput::success("PID Status Label\n42 0\n"), 3),
        (CmdOutput::success("PID Status Label\n1 0 com.apple.SpringBoard"), 3),
    ] {
        let (mut runner, home, record) = abandoned();
        let mut old = serde_json::to_value(&record).unwrap();
        old["cleanup"] = serde_json::json!({"group":"absent", "admission_clear":false});
        qaren::buildplan::save_json(&record_path(&home), &old).unwrap();
        runner.expect_run("lstart=", CmdOutput::failed(1, ""));
        absent_group(&mut runner);
        for _ in 0..reads {
            scoped_hosts(&mut runner, output.clone());
        }
        assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
        assert!(record.lock_dir.exists());
        assert!(runner.calls.iter().all(|c| c.program != "/bin/kill" && !c.args.iter().any(|a| a == "terminate")));
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn scoped_cleanup_requires_exact_readable_supported_simulator_inventory() {
    for output in [
        CmdOutput::success(
            &inventory("Shutdown").replace(DEVICE, "BBBBBBBB-1111-2222-3333-444455556666"),
        ),
        CmdOutput::success(&inventory("Shutting Down")),
        CmdOutput::success("not json"),
        CmdOutput::failed(1, "unreadable inventory"),
        CmdOutput {
            stderr: "warning".into(),
            ..CmdOutput::success(&inventory("Shutdown"))
        },
    ] {
        let (mut runner, _, record) = abandoned();
        runner.expect_run("lstart=", CmdOutput::failed(1, ""));
        absent_group(&mut runner);
        for _ in 0..3 {
            runner.expect_run("simctl list devices -j", output.clone());
        }
        assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
        assert!(record.lock_dir.exists());
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn old_successful_missing_lock_evidence_is_not_relabelled_as_scoped_proof() {
    let (mut runner, home, record) = abandoned();
    let mut old = serde_json::to_value(&record).unwrap();
    old["suite_exit"] = 65.into();
    old["cleanup"] = serde_json::json!({"group":"absent", "admission_clear":true});
    qaren::buildplan::save_json(&record_path(&home), &old).unwrap();
    lease::release(record.lease.as_ref().unwrap());
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    let recovered = native_suite::recover(&mut runner, &record.run_id).unwrap();
    assert_eq!(recovered.suite_exit, Some(65));
    assert!(serde_json::to_value(&recovered).unwrap()["cleanup"]["runner_host"].is_null());
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn exact_shutdown_inventory_releases_without_launchctl_or_post_admission() {
    let (mut runner, _, record) = abandoned();
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    absent_group(&mut runner);
    runner.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory("Shutdown")),
    );
    let recovered = native_suite::recover(&mut runner, &record.run_id).unwrap();
    assert!(!record.lock_dir.exists());
    assert_eq!(
        recovered.cleanup.unwrap().runner_host.as_deref(),
        Some("absent")
    );
    assert_eq!(runner.remaining(), 0);
    assert_eq!(
        runner
            .calls
            .iter()
            .filter(|c| c.label == "fresh-install-admission")
            .count(),
        1
    );
    assert!(runner.calls.iter().all(|c| c.label != "simctl-launchctl"));
}

#[test]
fn legacy_admission_cannot_override_new_unresolved_host_evidence_on_missing_lock() {
    let (mut runner, home, record) = abandoned();
    let mut contradictory = serde_json::to_value(&record).unwrap();
    contradictory["cleanup"] = serde_json::json!({"group":"absent", "admission_clear":true, "runner_host":"unresolved: present"});
    qaren::buildplan::save_json(&record_path(&home), &contradictory).unwrap();
    lease::release(record.lease.as_ref().unwrap());
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn exact_shutdown_and_booted_targets_run_only_after_durable_ownership() {
    for state in ["Shutdown", "Booted"] {
        let (mut mock, home) = setup();
        preflight(&mut mock, state);
        suite(&mut mock, Some(0));
        absent_group(&mut mock);
        absent_hosts(&mut mock);
        let mut runner = Witness::new(mock, &home, Fault::None);
        let record = native_suite::run(&mut runner, &DEVICE.to_ascii_lowercase()).unwrap();
        assert!(runner.intent.borrow().is_some());
        assert_eq!(record.suite_exit, Some(0));
        assert!(!record.lock_dir.exists());
        assert_eq!(runner.mock.piped_stdin_text(0), "start\n");
        assert_eq!(runner.mock.remaining(), 0);
        let spawn = runner
            .mock
            .calls
            .iter()
            .find(|c| c.program == "/bin/bash")
            .unwrap();
        assert!(spawn.env.contains(&(
            "RN_IOS_TEST_DESTINATION".into(),
            format!("platform=iOS Simulator,id={DEVICE}")
        )));
        let checkout = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        assert_eq!(spawn.cwd.as_deref(), Some(checkout));
        assert!(spawn.args.iter().any(|arg| arg
            == &checkout
                .join("scripts/test-native-ios.sh")
                .display()
                .to_string()));
        assert!(runner.mock.calls.iter().all(|c| ![
            "shutdown",
            "delete",
            "boot",
            "install",
            "uninstall"
        ]
        .iter()
        .any(|verb| c.args.iter().any(|a| a == verb))));
        assert!(runner.mock.spawned_logs[0].starts_with(record_path(&home).parent().unwrap()));
        let raw = std::fs::read_to_string(record_path(&home)).unwrap();
        assert!(!raw.contains("private suite command"));
    }
}

fn abandoned() -> (MockRunner, PathBuf, native_suite::NativeSuite) {
    let (mut runner, home) = setup();
    preflight(&mut runner, "Booted");
    suite(&mut runner, Some(0));
    runner.expect_run("ps -A", CmdOutput::failed(1, "private process failure"));
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    assert_eq!(runner.remaining(), 0);
    let record: native_suite::NativeSuite =
        serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
    assert!(record.lock_dir.exists());
    (runner, home, record)
}

#[test]
fn recovery_refuses_live_or_unknown_original_owner_without_signals() {
    for live in [true, false] {
        let (mut runner, _, record) = abandoned();
        if live {
            runner.expect_run("lstart=", CmdOutput::success(BIRTH));
            runner.expect_run("stat=", CmdOutput::success("S"));
        } else {
            runner.expect_run("lstart=", CmdOutput::failed(1, "unreadable"));
        }
        assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
        assert!(record.lock_dir.exists());
        assert_eq!(runner.remaining(), 0);
        assert!(runner.calls.iter().all(|call| call.program != "/bin/kill"));
    }
}

#[test]
fn dead_owner_recovery_releases_only_after_clean_evidence_and_is_idempotent() {
    let (mut runner, home, record) = abandoned();
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    absent_group(&mut runner);
    absent_hosts(&mut runner);
    let recovered = native_suite::recover(&mut runner, &record.run_id).unwrap();
    assert_eq!(recovered.suite_exit, Some(0));
    assert!(!record.lock_dir.exists());
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
    assert_eq!(saved["cleanup"]["group"], "absent");
    assert_eq!(saved["cleanup"]["runner_host"], "absent");
    assert_eq!(saved["cleanup"]["admission_clear"], false);
    runner.expect_run("lstart=", CmdOutput::failed(1, ""));
    native_suite::recover(&mut runner, &record.run_id).unwrap();
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn live_and_dead_check_leases_cannot_be_stolen_even_with_a_clear_driver_scan() {
    for live in [true, false] {
        let (mut runner, home) = setup();
        let locks = home.join("shared-locks");
        runner
            .environment
            .insert("QAREN_LOCK_ROOT".into(), locks.display().to_string());
        let claimed = lease::acquire(
            &mut MockRunner::new(),
            &locks,
            Platform::Ios,
            DEVICE,
            "check-owner",
            Some(common::identity(4242, BIRTH)),
        )
        .unwrap();
        preflight(&mut runner, "Shutdown");
        runner.expect_run(
            "ps -p 4242",
            if live {
                CmdOutput::success(BIRTH)
            } else {
                CmdOutput::failed(1, "")
            },
        );
        if live {
            runner.expect_run("stat=", CmdOutput::success("S"));
        }
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        assert_eq!(runner.remaining(), 0);
        assert!(runner.spawned_logs.is_empty());
        assert_eq!(
            qaren::buildplan::read_holder(&claimed.lock_dir)
                .unwrap()
                .run_id,
            "check-owner"
        );
        assert_eq!(
            lease::release(&claimed),
            qaren::buildplan::ReleaseOutcome::Removed
        );
    }
}

#[test]
fn absent_group_still_requires_fresh_scoped_host_absence() {
    for (output, reads) in [
        (
            CmdOutput::success(
                "PID Status Label\n42 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner[abc]\n",
            ),
            1,
        ),
        (CmdOutput::failed(1, "inventory unknown"), 3),
    ] {
        let (mut runner, home) = setup();
        preflight(&mut runner, "Booted");
        suite(&mut runner, Some(0));
        absent_group(&mut runner);
        for _ in 0..reads {
            scoped_hosts(&mut runner, output.clone());
        }
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        let record: native_suite::NativeSuite =
            serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
        assert!(record.lock_dir.exists());
        assert_eq!(record.suite_exit, Some(0));
        assert!(record
            .cleanup
            .unwrap()
            .runner_host
            .unwrap()
            .starts_with("unresolved"));
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn failure_signal_and_lost_exit_are_not_replaced_by_cleanup_success() {
    for exit in [Some(65), Some(-1), None] {
        let (mut runner, _) = setup();
        preflight(&mut runner, "Shutdown");
        suite(&mut runner, exit);
        absent_group(&mut runner);
        absent_hosts(&mut runner);
        let before = runner.now_epoch_ms();
        let record = native_suite::run(&mut runner, DEVICE).unwrap();
        assert_eq!(record.suite_exit, exit);
        assert_ne!(record.suite_exit, Some(0));
        assert!(!record.lock_dir.exists());
        assert_eq!(
            runner.now_epoch_ms() - before,
            if exit.is_none() { 1_200_000 } else { 0 }
        );
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn recovery_cannot_signal_without_the_matching_real_claim() {
    for replacement in ["foreign", "missing", "owner-birth", "unreadable", "symlink"] {
        let (mut runner, home, record) = abandoned();
        match replacement {
            "foreign" => {
                lease::release(record.lease.as_ref().unwrap());
                lease::acquire(
                    &mut MockRunner::new(),
                    record.lock_dir.parent().unwrap(),
                    Platform::Ios,
                    DEVICE,
                    "another-check",
                    Some(common::identity(777, BIRTH)),
                )
                .unwrap();
            }
            "missing" => {
                lease::release(record.lease.as_ref().unwrap());
            }
            "owner-birth" => {
                let mut holder = qaren::buildplan::read_holder(&record.lock_dir).unwrap();
                holder.identity.as_mut().unwrap().started_at = "different birth".into();
                qaren::buildplan::save_json(&record.lock_dir.join("holder.json"), &holder).unwrap();
            }
            "unreadable" => {
                std::fs::write(record.lock_dir.join("holder.json"), "invalid").unwrap();
            }
            "symlink" => {
                let moved = home.join("moved-lease");
                std::fs::rename(&record.lock_dir, &moved).unwrap();
                std::os::unix::fs::symlink(moved, &record.lock_dir).unwrap();
            }
            _ => unreachable!(),
        }
        runner.expect_run("lstart=", CmdOutput::failed(1, ""));
        assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
        assert_eq!(runner.remaining(), 0);
        assert!(runner.calls.iter().all(|c| c.program != "/bin/kill"));
        if replacement != "missing" {
            assert!(record.lock_dir.exists());
        }
    }
}

#[test]
fn recovery_rejects_record_paths_outside_the_configured_device_lock() {
    let (mut runner, home, mut record) = abandoned();
    record.lock_dir = home.join("unrelated-lock");
    qaren::buildplan::save_json(&record_path(&home), &record).unwrap();
    assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn unsupported_simulators_and_non_exact_selectors_never_get_a_lease() {
    for raw in [
        inventory("Creating"),
        inventory("Booted").replace("iOS-26-4", "tvOS-26-4"),
        inventory("Shutdown").replace("true", "false"),
        inventory("Booted").replace("isAvailable", "oldAvailability"),
        inventory("Booted").replace(DEVICE, "BBBBBBBB-1111-2222-3333-444455556666"),
    ] {
        let (mut runner, home) = setup();
        runner.expect_run("simctl list devices -j", CmdOutput::success(&raw));
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        assert!(!home.join(".qaren/locks").exists());
        assert_eq!(runner.remaining(), 0);
    }
    for device in [
        "booted",
        "iPhone 16",
        "",
        "../device",
        "AAAABBBB",
        "AAAABBBB-1111-2222-3333-44445555666G",
    ] {
        let (mut runner, _) = setup();
        assert!(native_suite::run(&mut runner, device).is_err());
        assert!(runner.calls.is_empty());
    }
}

#[test]
fn fixed_native_script_keeps_serial_execution_and_existing_skips() {
    use std::os::unix::fs::PermissionsExt;
    let root = common::temp_repo();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let stub = bin.join("xcodebuild");
    std::fs::write(&stub, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGS_FILE\"\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let args_file = root.join("args");
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/test-native-ios.sh");
    let status = std::process::Command::new("bash")
        .arg(script)
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .env("ARGS_FILE", &args_file)
        .env("RN_IOS_TEST_DESTINATION", format!("id={DEVICE}"))
        .env("RN_IOS_TEST_RESULTS", root.join("results"))
        .status()
        .unwrap();
    assert!(status.success());
    let output = std::fs::read_to_string(args_file).unwrap();
    let args: Vec<_> = output.lines().collect();
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-destination", &format!("id={DEVICE}")]));
    assert!(args
        .windows(2)
        .any(|pair| pair == ["-parallel-testing-enabled", "NO"]));
    assert!(args.contains(&"-skip-testing:QarenIosRunnerUITests/QarenIosRunnerTests"));
    assert!(args.contains(&"-skip-testing:QarenIosRunnerUITests/SnapshotForegroundRegressionTest"));
}

#[test]
fn persistence_refusals_before_spawn_release_the_claim() {
    for fault in [Fault::ClaimSave, Fault::PendingSave] {
        let (mut mock, home) = setup();
        preflight(&mut mock, "Shutdown");
        if fault == Fault::PendingSave {
            admission(&mut mock, "clear");
        }
        let mut runner = Witness::new(mock, &home, fault);
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        runner.restore_save();
        assert!(!Path::new(runner.record()["lock_dir"].as_str().unwrap()).exists());
        assert!(runner.mock.spawned_logs.is_empty());
        assert_eq!(runner.mock.remaining(), 0);
    }
}

#[test]
fn spawn_and_identity_persistence_gaps_recover_after_owner_death_without_sending_start() {
    for fault in [Fault::SpawnGap, Fault::IdentitySave] {
        let (mut mock, home) = setup();
        preflight(&mut mock, "Shutdown");
        if fault == Fault::IdentitySave {
            suite(&mut mock, None);
        } else {
            admission(&mut mock, "clear");
            mock.expect_spawn_piped("/bin/bash", 9000, "", None);
        }
        let mut runner = Witness::new(mock, &home, fault);
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        if fault == Fault::IdentitySave {
            runner.restore_save();
        }
        assert_eq!(runner.record()["process"]["state"], "spawn_pending");
        assert_eq!(runner.mock.piped_stdin_text(0), "");
        let record = runner.record();
        let lock = Path::new(record["lock_dir"].as_str().unwrap());
        assert!(lock.exists());
        runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
        absent_hosts(&mut runner.mock);
        let recovered =
            native_suite::recover(&mut runner.mock, record["run_id"].as_str().unwrap()).unwrap();
        assert!(!lock.exists());
        assert_eq!(recovered.suite_exit, None);
        assert!(matches!(
            recovered.process,
            native_suite::SuiteProcess::NotSpawned
        ));
        runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
        native_suite::recover(&mut runner.mock, &recovered.run_id).unwrap();
        assert_eq!(runner.mock.remaining(), 0);
        assert!(runner.mock.calls.iter().all(|c| c.program != "/bin/kill"));
    }
}

fn pending_spawn() -> Witness {
    let (mut mock, home) = setup();
    preflight(&mut mock, "Shutdown");
    admission(&mut mock, "clear");
    mock.expect_spawn_piped("/bin/bash", 9000, "", None);
    let mut runner = Witness::new(mock, &home, Fault::SpawnGap);
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    runner
}

#[test]
fn pending_recovery_refuses_live_unknown_or_foreign_holders_without_mutation() {
    for fault in ["live", "unknown", "foreign", "birth", "group"] {
        let mut runner = pending_spawn();
        let record = runner.record();
        let lock = Path::new(record["lock_dir"].as_str().unwrap());
        let mut holder = qaren::buildplan::read_holder(lock).unwrap();
        match fault {
            "live" => {
                runner.mock.expect_run("lstart=", CmdOutput::success(BIRTH));
                runner.mock.expect_run("stat=", CmdOutput::success("S"));
            }
            "unknown" => runner
                .mock
                .expect_run("lstart=", CmdOutput::failed(1, "unreadable")),
            _ => {
                runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
                match fault {
                    "foreign" => holder.run_id = "another-suite".into(),
                    "birth" => holder.identity.as_mut().unwrap().started_at = "other birth".into(),
                    "group" => holder.group = Some(9000),
                    _ => unreachable!(),
                }
                qaren::buildplan::save_json(&lock.join("holder.json"), &holder).unwrap();
            }
        }
        let claim = std::fs::read(lock.join("holder.json")).unwrap();
        assert!(
            native_suite::recover(&mut runner.mock, record["run_id"].as_str().unwrap()).is_err()
        );
        assert_eq!(std::fs::read(lock.join("holder.json")).unwrap(), claim);
        assert_eq!(runner.record(), record);
        assert_eq!(runner.mock.remaining(), 0);
        assert!(runner.mock.calls.iter().all(|c| c.program != "/bin/kill"));
    }
}

#[test]
fn pending_recovery_requires_runner_host_absence() {
    for (output, reads) in [
        (
            CmdOutput::success(
                "PID Status Label\n42 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner[abc]\n",
            ),
            1,
        ),
        (CmdOutput::failed(1, "unknown inventory"), 3),
    ] {
        let mut runner = pending_spawn();
        let record = runner.record();
        runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
        for _ in 0..reads {
            scoped_hosts(&mut runner.mock, output.clone());
        }
        assert!(
            native_suite::recover(&mut runner.mock, record["run_id"].as_str().unwrap()).is_err()
        );
        assert!(Path::new(record["lock_dir"].as_str().unwrap()).exists());
        assert_eq!(runner.record(), record);
        assert_eq!(runner.mock.remaining(), 0);
        assert!(runner.mock.calls.iter().all(|c| c.program != "/bin/kill"));
    }
}

#[test]
fn pending_recovery_retains_the_lease_when_its_transition_cannot_be_saved() {
    let mut runner = pending_spawn();
    let record = runner.record();
    runner.fault = Fault::CleanupSave;
    runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
    absent_hosts(&mut runner.mock);
    assert!(native_suite::recover(&mut runner, record["run_id"].as_str().unwrap()).is_err());
    runner.restore_save();
    assert_eq!(runner.record(), record);
    assert!(Path::new(record["lock_dir"].as_str().unwrap()).exists());
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn example_log_helper_supports_control_arguments_and_paired_streams() {
    assert!(std::process::Command::new(env!("CARGO"))
        .args(["build", "--locked", "--example", "native-ios-suite"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap()
        .success());
    let executable = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("examples/native-ios-suite");
    let dir = common::temp_repo();
    let mut runner = RealRunner::with_log_executable(executable);
    let log = dir.join("suite.log");
    let mut child = runner
        .spawn_piped(
            &CmdSpec::new(
                "suite-fixture",
                "/bin/sh",
                &[
                    "-c",
                    "printf 'stdout ready\\n'; printf 'stderr ready\\n' >&2",
                ],
                10,
            ),
            &log,
        )
        .unwrap();
    drop(child.stdin);
    let mut output = String::new();
    std::io::Read::read_to_string(&mut child.stdout, &mut output).unwrap();
    wait_for_fixture(|| child.handle.try_wait().unwrap() == Some(0));
    runner.flush_logs().unwrap();
    assert_eq!(output, "stdout ready\n");
    assert!(std::fs::read_to_string(log)
        .unwrap()
        .contains("stderr ready"));
    let paired_log = dir.join("paired.log");
    runner
        .spawn_group(
            &CmdSpec::new(
                "suite-paired-fixture",
                "/bin/sh",
                &[
                    "-c",
                    "printf 'paired stdout\\n'; printf 'paired stderr\\n' >&2",
                ],
                10,
            ),
            &paired_log,
        )
        .unwrap();
    wait_for_fixture(|| {
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(&paired_log).unwrap();
        stored.contains("paired stdout") && stored.contains("paired stderr")
    });
}

#[test]
fn cleanup_evidence_must_be_saved_before_release_and_recovery_rechecks() {
    let (mut mock, home) = setup();
    preflight(&mut mock, "Booted");
    suite(&mut mock, Some(0));
    absent_group(&mut mock);
    absent_hosts(&mut mock);
    let mut runner = Witness::new(mock, &home, Fault::CleanupSave);
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    runner.restore_save();
    let record = runner.record();
    let lock = Path::new(record["lock_dir"].as_str().unwrap());
    assert!(lock.exists());
    runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
    absent_group(&mut runner.mock);
    absent_hosts(&mut runner.mock);
    native_suite::recover(&mut runner.mock, record["run_id"].as_str().unwrap()).unwrap();
    assert!(!lock.exists());
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn acquisition_save_crash_recovers_the_real_holder_without_inventing_a_lease() {
    let (mut mock, home) = setup();
    preflight(&mut mock, "Shutdown");
    admission(&mut mock, "busy");
    let mut runner = Witness::new(mock, &home, Fault::None);
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    let intent = runner.intent.borrow().as_ref().unwrap().clone();
    assert!(intent["lease"].is_null());
    qaren::buildplan::save_json(&record_path(&home), &intent).unwrap();
    let pending: native_suite::NativeSuite = serde_json::from_value(intent.clone()).unwrap();
    lease::acquire(
        &mut MockRunner::new(),
        pending.lock_dir.parent().unwrap(),
        Platform::Ios,
        DEVICE,
        &pending.run_id,
        Some(pending.owner),
    )
    .unwrap();
    runner.mock.expect_run("lstart=", CmdOutput::failed(1, ""));
    let recovered =
        native_suite::recover(&mut runner.mock, intent["run_id"].as_str().unwrap()).unwrap();
    assert!(recovered.lease.is_none());
    assert!(!recovered.lock_dir.exists());
    assert_eq!(recovered.suite_exit, None);
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn recovery_rejects_a_corrupt_group_identity_before_any_cleanup_probe() {
    let (mut runner, home, mut record) = abandoned();
    if let native_suite::SuiteProcess::Spawned {
        identity: Some(identity),
        ..
    } = &mut record.process
    {
        identity.pid = 8888;
    } else {
        panic!("fixture must record a group leader");
    }
    qaren::buildplan::save_json(&record_path(&home), &record).unwrap();
    assert!(native_suite::recover(&mut runner, &record.run_id).is_err());
    assert!(record.lock_dir.exists());
    assert_eq!(runner.remaining(), 0);
}

#[test]
fn timeout_cleanup_interrupts_only_the_driver_and_requires_positive_absence() {
    for gone in [true, false] {
        let (mut runner, home) = setup();
        preflight(&mut runner, "Booted");
        suite(&mut runner, None);
        runner.expect_run("ps -A", CmdOutput::success("1 1 S\n9000 9000 S\n"));
        runner.expect_run("ps -p 9000 -o lstart=", CmdOutput::success(BIRTH));
        runner.expect_run("stat=", CmdOutput::success("S"));
        runner.expect_run("lstart=", CmdOutput::success(BIRTH));
        runner.expect_run("stat=", CmdOutput::success("S"));
        runner.expect_run("/bin/kill -INT -- 9000", CmdOutput::success(""));
        if gone {
            absent_group(&mut runner);
            absent_hosts(&mut runner);
        } else {
            runner.expect_run("ps -A", CmdOutput::failed(1, "unknown inventory"));
        }
        let result = native_suite::run(&mut runner, DEVICE);
        assert_eq!(result.is_ok(), gone);
        let record: native_suite::NativeSuite =
            serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
        assert_eq!(record.suite_exit, None);
        assert_eq!(record.lock_dir.exists(), !gone);
        assert_eq!(runner.remaining(), 0);
        assert!(
            !*runner.piped_killed[0].lock().unwrap(),
            "must not bypass shared cleanup via ChildHandle::kill_group"
        );
    }
}

#[test]
fn unknown_child_identity_never_starts_the_suite() {
    for gone in [true, false] {
        let (mut runner, home) = setup();
        preflight(&mut runner, "Shutdown");
        admission(&mut runner, "clear");
        runner.expect_spawn_piped("/bin/bash", 9000, "", None);
        runner.expect_run("lstart=", CmdOutput::failed(1, ""));
        runner.expect_run("command=", CmdOutput::success("withheld"));
        if gone {
            absent_group(&mut runner);
            absent_hosts(&mut runner);
        } else {
            runner.expect_run("ps -A", CmdOutput::failed(1, "unknown inventory"));
        }
        assert!(native_suite::run(&mut runner, DEVICE).is_err());
        assert_eq!(runner.piped_stdin_text(0), "");
        let record: native_suite::NativeSuite =
            serde_json::from_slice(&std::fs::read(record_path(&home)).unwrap()).unwrap();
        assert_eq!(record.lock_dir.exists(), !gone);
        assert_eq!(runner.remaining(), 0);
    }
}

#[test]
fn relative_lock_override_is_refused_instead_of_using_the_default() {
    let (mut runner, home) = setup();
    runner
        .environment
        .insert("QAREN_LOCK_ROOT".into(), "relative/locks".into());
    runner.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&inventory("Booted")),
    );
    let refused = native_suite::run(&mut runner, DEVICE).unwrap_err();
    assert!(
        refused.contains(
            "set QAREN_LOCK_ROOT to an absolute path without . or .. segments, or unset it"
        ),
        "{refused}"
    );
    assert_eq!(runner.remaining(), 0);
    assert!(!home.join(".qaren/locks").exists());
}

#[test]
fn lowercase_inventory_cannot_bypass_a_check_lease_on_the_inventory_bytes() {
    for device in [DEVICE.to_string(), DEVICE.to_ascii_lowercase()] {
        let (mut runner, home) = setup();
        let locks = home.join(".qaren/locks");
        let claimed = lease::acquire(
            &mut MockRunner::new(),
            &locks,
            Platform::Ios,
            &DEVICE.to_ascii_lowercase(),
            "check-owner",
            Some(common::identity(4242, BIRTH)),
        )
        .unwrap();
        runner.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&inventory("Booted").replace(DEVICE, &DEVICE.to_ascii_lowercase())),
        );
        assert!(native_suite::run(&mut runner, &device).is_err());
        assert_eq!(runner.remaining(), 0);
        assert!(runner.spawned_logs.is_empty());
        assert!(!home.join(".qaren/native-suites").exists());
        assert!(!locks.join(lease::lock_name(Platform::Ios, DEVICE)).exists());
        assert_eq!(
            qaren::buildplan::read_holder(&claimed.lock_dir)
                .unwrap()
                .run_id,
            "check-owner"
        );
        assert_eq!(
            lease::release(&claimed),
            qaren::buildplan::ReleaseOutcome::Removed
        );
    }
}

struct TrackedChild {
    handle: Arc<Mutex<Box<dyn ChildHandle + Send>>>,
    reaped: Arc<AtomicBool>,
}

impl ChildHandle for TrackedChild {
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        let result = self.handle.lock().unwrap().try_wait();
        if matches!(result, Ok(Some(_))) {
            self.reaped.store(true, Ordering::SeqCst);
        }
        result
    }

    fn kill_group(&mut self) {
        panic!("native suite must use the shared cleanup owner")
    }

    fn terminate(&mut self) {
        panic!("native suite must use the shared cleanup owner")
    }
}

struct HybridRunner {
    mock: MockRunner,
    real: RealRunner,
    home: PathBuf,
    child: Option<Arc<Mutex<Box<dyn ChildHandle + Send>>>>,
    pid: i32,
    saw_zombie: bool,
    reaped: Arc<AtomicBool>,
    after_reap: Option<qaren::adapters::metro::GroupPresence>,
    reprobes: usize,
    signals: usize,
    block_identity_save: bool,
}

impl HybridRunner {
    fn new() -> Self {
        let (mut mock, home) = setup();
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&inventory("Shutdown")),
        );
        admission(&mut mock, "clear");
        std::fs::write(
            home.join("harmless-suite.sh"),
            ": > \"$0.started\"\nexec /bin/sleep 60\n",
        )
        .unwrap();
        Self {
            mock,
            real: RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into()),
            home,
            child: None,
            pid: 0,
            saw_zombie: false,
            reaped: Arc::new(AtomicBool::new(false)),
            after_reap: None,
            reprobes: 0,
            signals: 0,
            block_identity_save: false,
        }
    }
}

impl Drop for HybridRunner {
    fn drop(&mut self) {
        if let Some(child) = &self.child {
            let mut child = child.lock().unwrap();
            if !matches!(child.try_wait(), Ok(Some(_))) {
                child.kill_group();
            }
        }
    }
}

fn wait_for_fixture(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "harmless fixture did not settle");
        std::thread::sleep(Duration::from_millis(10));
    }
}

impl Runner for HybridRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.mock.env_var(name)
    }

    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        match spec.label.as_str() {
            "simctl-list" | "simctl-launchctl" | "fresh-install-admission" => {
                self.mock.execute(spec, interruptible)
            }
            "ps-lstart" | "ps-command" | "ps-stat" | "ps-groups" | "kill-group" => {
                assert!(matches!(spec.program.as_str(), "ps" | "/bin/kill"));
                if spec.label == "ps-groups" && self.reaped.load(Ordering::SeqCst) {
                    if let Some(presence) = self.after_reap {
                        self.reprobes += 1;
                        return match presence {
                            qaren::adapters::metro::GroupPresence::Unknown => {
                                CmdOutput::failed(1, "unknown inventory")
                            }
                            qaren::adapters::metro::GroupPresence::Present => CmdOutput::success(
                                &format!("1 1 S\n{} {} S\n", self.pid + 1, self.pid),
                            ),
                            _ => unreachable!(),
                        };
                    }
                }
                if spec.label == "kill-group" {
                    self.signals += 1;
                }
                let mut output = self.real.execute(spec, interruptible);
                if spec.label == "ps-groups" {
                    // Isolate real fixture-group rows from unrelated host process churn.
                    if output.ok() && output.stdout.ends_with('\n') {
                        output.stdout = output
                            .stdout
                            .lines()
                            .filter(|line| {
                                let columns: Vec<_> = line.split_whitespace().collect();
                                columns.first().is_some_and(|pid| {
                                    *pid == self.pid.to_string()
                                        || *pid == std::process::id().to_string()
                                }) || columns
                                    .get(1)
                                    .is_some_and(|pgid| *pgid == self.pid.to_string())
                            })
                            .map(|line| format!("{line}\n"))
                            .collect();
                    }
                    self.saw_zombie |= output.stdout.lines().any(|line| {
                        let columns: Vec<_> = line.split_whitespace().collect();
                        columns.len() == 3
                            && columns[0] == self.pid.to_string()
                            && columns[2].starts_with('Z')
                    });
                }
                output
            }
            _ => panic!("unexpected hybrid runner command"),
        }
    }

    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        panic!("native suite must use piped spawn")
    }

    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(
            &spec.args[..5],
            &[
                "--noprofile",
                "--norc",
                "-c",
                "IFS= read -r start && [ \"$start\" = start ] || exit 4; exec /bin/bash \"$1\" >&2",
                "native-ios-suite",
            ]
        );
        let mut harmless = spec.clone();
        let script = harmless.args.last_mut().unwrap();
        assert!(script.ends_with("/scripts/test-native-ios.sh"));
        *script = self.home.join("harmless-suite.sh").display().to_string();
        let mut child = self.real.spawn_piped_unchecked(&harmless, log)?;
        self.pid = child.pid;
        let handle = Arc::new(Mutex::new(child.handle));
        self.child = Some(handle.clone());
        child.handle = Box::new(TrackedChild {
            handle,
            reaped: self.reaped.clone(),
        });
        if self.block_identity_save {
            let record = record_path(&self.home);
            std::fs::rename(&record, record.with_extension("saved")).unwrap();
            std::fs::create_dir(record).unwrap();
        }
        Ok(child)
    }

    fn sleep(&mut self, duration: Duration) {
        if duration == Duration::from_millis(100) {
            wait_for_fixture(|| self.home.join("harmless-suite.sh.started").exists());
            self.mock.sleep(Duration::from_secs(1200));
        } else {
            self.real.sleep(duration);
            self.mock.sleep(duration);
        }
    }

    fn now_epoch_ms(&self) -> u64 {
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed() + self.real.commands_executed()
    }
}

#[test]
fn real_timeout_reaps_the_killed_leader_before_proving_absence_and_releasing() {
    let mut runner = HybridRunner::new();
    absent_hosts(&mut runner.mock);
    let result = native_suite::run(&mut runner, DEVICE);
    assert!(runner.home.join("harmless-suite.sh.started").exists());
    assert!(runner.saw_zombie, "exercise the real unreaped group leader");
    let pgid = runner.pid;
    assert_eq!(
        qaren::adapters::metro::group_presence(&mut runner, pgid),
        qaren::adapters::metro::GroupPresence::Absent
    );
    let record: native_suite::NativeSuite =
        serde_json::from_slice(&std::fs::read(record_path(&runner.home)).unwrap()).unwrap();
    assert_eq!(
        record.suite_exit, None,
        "cleanup must not supply the suite verdict"
    );
    assert!(result.is_ok(), "timeout cleanup must settle: {result:?}");
    assert!(!record.lock_dir.exists());
    assert_eq!(record.cleanup.as_ref().unwrap().group, "absent");
    assert_eq!(
        record.cleanup.as_ref().unwrap().runner_host.as_deref(),
        Some("absent")
    );
    assert_eq!(runner.mock.remaining(), 0);
}

#[test]
fn reaping_the_leader_does_not_release_a_surviving_or_unknown_group() {
    use qaren::adapters::metro::GroupPresence;
    for remaining in [GroupPresence::Present, GroupPresence::Unknown] {
        let mut runner = HybridRunner::new();
        runner.after_reap = Some(remaining);
        let result = native_suite::run(&mut runner, DEVICE);
        assert!(result.is_err());
        assert!(
            runner.saw_zombie && runner.reaped.load(Ordering::SeqCst),
            "{result:?}; zombie={} reaped={} signals={} reprobes={}",
            runner.saw_zombie,
            runner.reaped.load(Ordering::SeqCst),
            runner.signals,
            runner.reprobes
        );
        assert_eq!(
            runner.reprobes,
            if remaining == GroupPresence::Present {
                2
            } else {
                1
            }
        );
        assert_eq!(
            runner.signals, 1,
            "a dead leader cannot authorize further signals"
        );
        let record: native_suite::NativeSuite =
            serde_json::from_slice(&std::fs::read(record_path(&runner.home)).unwrap()).unwrap();
        assert_eq!(record.suite_exit, None);
        assert!(record.lock_dir.exists());
        assert!(record
            .cleanup
            .as_ref()
            .unwrap()
            .group
            .starts_with("unresolved:"));
        assert!(!record.cleanup.as_ref().unwrap().admission_clear);
        assert_eq!(
            runner.mock.remaining(),
            0,
            "no host scan can replace group absence"
        );
    }
}

#[test]
fn real_stdin_eof_blocks_script_start_when_identity_cannot_be_saved() {
    let mut runner = HybridRunner::new();
    runner.block_identity_save = true;
    assert!(native_suite::run(&mut runner, DEVICE).is_err());
    let mut exit = None;
    wait_for_fixture(|| {
        exit = runner
            .child
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .try_wait()
            .unwrap();
        exit.is_some()
    });
    assert_eq!(exit, Some(4));
    assert!(!runner.home.join("harmless-suite.sh.started").exists());
    let record: native_suite::NativeSuite = serde_json::from_slice(
        &std::fs::read(record_path(&runner.home).with_extension("saved")).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        record.process,
        native_suite::SuiteProcess::SpawnPending
    ));
    assert!(record.lock_dir.exists());
    assert_eq!(record.suite_exit, None);
    assert_eq!(runner.signals, 0);
    assert_eq!(runner.mock.remaining(), 0);
}
