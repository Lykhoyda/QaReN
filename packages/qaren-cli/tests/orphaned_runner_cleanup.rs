mod common;

use qaren::commands::cleanup::{cleanup_with_policy, RunnerCleanupPolicy};
use qaren::exec::{CmdOutput, CmdSpec, MockRunner, PipedChild, PrivateOutput, Runner, Spawned};
use qaren::failure::{FailureCode, RecoveryAction, RecoveryReason};
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::runrecord::{
    GroupCleanupResult, IosSimResource, Phase, RunRecord, RunnerDriverResource,
};
use qaren::scenario::Platform;
use std::path::{Path, PathBuf};
use std::time::Duration;

const BIRTH: &str = "Wed Aug 12 16:01:00 2026";
const DEVICE: &str = "AAAABBBB-1111-2222-3333-444455556666";

fn argv(family: &str) -> Vec<String> {
    vec![
        "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild".into(),
        "test-without-building".into(),
        "-project".into(),
        format!("/private/runtime/{family}/{family}.xcodeproj"),
        "-scheme".into(),
        family.into(),
        "-destination".into(),
        format!("platform=iOS Simulator,id={DEVICE}"),
        "-derivedDataPath".into(),
        "/private/derived data".into(),
        format!("-only-testing:{family}UITests/{family}Tests/testCommand"),
    ]
}

fn fixture(family: &str) -> (PathBuf, RunRecord, FakeRunner) {
    let root = common::temp_repo();
    let mut record = common::base_record(
        &root,
        &common::ios_scenario_yaml(8791),
        "orphan-run",
        Phase::Failed,
    );
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: DEVICE.into(),
        name: "qaren-orphan-run".into(),
        device_type: "iPhone".into(),
        runtime: "iOS".into(),
    });
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &root.join("locks"),
            Platform::Ios,
            DEVICE,
            &record.run_id,
            None,
        )
        .unwrap(),
    );
    // Exercise the actual stored legacy/current identity representation and redaction boundary.
    let driver: RunnerDriverResource = serde_json::from_value(serde_json::json!({
        "pgid": 7000, "identity": {"pid": 7000, "started_at": BIRTH, "command": argv(family).join(" ")}
    })).unwrap();
    record.resources.runner_drivers.push(driver);
    record.save(&root).unwrap();
    let fake = FakeRunner {
        mock: MockRunner::new(),
        argv: argv(family),
        alive: true,
        simulator_deleted: false,
        exit_after: 3,
        signals: vec![],
        fault: "",
        root: root.clone(),
        sleeps: vec![],
        observations: 0,
        step_inventory_reads: 0,
    };
    (root, record, fake)
}

struct FakeRunner {
    mock: MockRunner,
    argv: Vec<String>,
    alive: bool,
    simulator_deleted: bool,
    exit_after: usize,
    signals: Vec<String>,
    fault: &'static str,
    root: PathBuf,
    sleeps: Vec<Duration>,
    observations: usize,
    step_inventory_reads: usize,
}

impl FakeRunner {
    fn output(&mut self, spec: &CmdSpec) -> CmdOutput {
        match spec.label.as_str() {
            "ps-lstart" => {
                if spec.args.iter().any(|s| s == "7002") { return CmdOutput::success("foreign birth"); }
                if spec.args.iter().any(|s| s == "999") {
                    return if self.fault == "owner_unknown" {
                        CmdOutput::failed(1, "denied")
                    } else if self.fault == "owner_live" {
                        CmdOutput::success("Wed Aug 12 15:00:00 2026")
                    } else {
                        CmdOutput::success("")
                    };
                }
                if self.fault == "identity_unknown" {
                    return CmdOutput::failed(1, "denied");
                }
                if self.fault == "identity_changed"
                    || (self.fault == "change_after_term" && self.signals.len() >= 2)
                {
                    return CmdOutput::success("Thu Aug 13 16:01:00 2026");
                }
                CmdOutput::success(if self.alive { BIRTH } else { "" })
            }
            "ps-stat" => if self.fault == "stat_unknown" { CmdOutput::success("") }
                else if self.fault == "stat_stderr" { let mut out = CmdOutput::success("S"); out.stderr = "warning".into(); out }
                else { CmdOutput::success("S") },
            "kill-group" => {
                assert_eq!(spec.args[1], "--");
                assert_eq!(spec.args[2], "7000");
                self.signals.push(spec.args[0].clone());
                if self.signals.len() == self.exit_after {
                    self.alive = false;
                    if matches!(self.fault, "retirement_storage" | "retirement_only") {
                        std::fs::create_dir(self.storage_block()).unwrap();
                    }
                }
                CmdOutput::success("")
            }
            "runner-command-proof" => {
                self.observations += 1;
                if self.fault == "lease_changed_during_observation" {
                    let record = RunRecord::load(&self.root, "orphan-run").unwrap();
                    let lease = record.resources.lease.unwrap();
                    let mut held = qaren::buildplan::read_holder(&lease.lock_dir).unwrap();
                    held.holder = "foreign".into();
                    qaren::buildplan::save_json(&lease.lock_dir.join("holder.json"), &held).unwrap();
                }
                if self.fault == "command_unknown" {
                    return CmdOutput::failed(1, "denied");
                }
                if self.fault == "command_stderr" {
                    let mut out = CmdOutput::success(&self.argv.join(" "));
                    out.stderr = "warning".into();
                    return out;
                }
                CmdOutput::success(&format!("{}\n", self.argv.join(" ")))
            }
            "runner-argv-proof" => {
                let mut value = serde_json::json!({"v":1,"pid":7000,"birth":{"seconds":10,"micros":20},
                    "executable":"/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild","argv":self.argv});
                if self.fault == "malformed_helper" {
                    return CmdOutput::success("{");
                }
                if self.fault == "wrong_helper_pid" {
                    value["pid"] = 7001.into();
                }
                CmdOutput::success(&value.to_string())
            }
            "simctl-list" if self.simulator_deleted => {
                CmdOutput::success(r#"{"devices":{"rt":[]}}"#)
            }
            "simctl-shutdown" => CmdOutput::success(""),
            "simctl-delete" => {
                self.simulator_deleted = true;
                CmdOutput::success("")
            }
            "simctl-list" => CmdOutput::success(
                &serde_json::json!({"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{"udid":DEVICE,
                "state":"Booted","isAvailable":true,"name":"qaren-orphan-run",
                "deviceTypeIdentifier":"iPhone"}]}})
                .to_string(),
            ),
            "simctl-launchctl" => {
                if self.fault == "host_storage" && !self.storage_block().exists() { std::fs::create_dir(self.storage_block()).unwrap(); }
                CmdOutput::success(if self.fault == "host_remaining" {
                "PID Status Label\n42 0 dev.lykhoyda.rndevagent.fastrunner\n"
            } else {
                "PID Status Label\n1 0 com.apple.SpringBoard\n"
            }) },
            _ if spec.args.iter().any(|s| s == "-A") => {
                if (self.fault == "exit_between_steps" && self.signals.len() == 2)
                    || (self.fault == "exit_before_int" && self.signals.is_empty())
                {
                    self.step_inventory_reads += 1;
                    if self.step_inventory_reads == 2 {
                        self.alive = false;
                    }
                }
                if self.fault == "inventory_unknown" {
                    return CmdOutput::failed(1, "denied");
                }
                CmdOutput::success(if self.fault == "multi_driver" && !self.alive { "1 1 S\n7002 7002 S\n" }
                    else if self.fault == "missing_group" {
                    "1 1 S\n"
                } else if self.alive {
                    "1 1 S\n7000 7000 S\n7001 7000 S\n"
                } else if self.fault == "helper_remaining" {
                    "1 1 S\n7001 7000 S\n"
                } else {
                    "1 1 S\n"
                })
            }
            _ => panic!("unexpected command label: {}", spec.label),
        }
    }
    fn storage_block(&self) -> PathBuf {
        RunRecord::run_dir(&self.root, "orphan-run")
            .join(format!(".run.json.tmp.{}", std::process::id()))
    }
    fn run_cleanup(&mut self, policy: RunnerCleanupPolicy) -> Receipt {
        let root = self.root.clone();
        cleanup_with_policy(self, &root, "orphan-run", None, None, policy)
    }
}

impl Runner for FakeRunner {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        let out = self.output(spec);
        self.mock.expect_run(&spec.program, out);
        self.mock.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> PrivateOutput {
        assert!(matches!(
            spec.label.as_str(),
            "runner-command-proof" | "runner-argv-proof"
        ));
        assert_eq!(spec.timeout_seconds, 10);
        let out = self.output(spec);
        self.mock.expect_run(&spec.program, out);
        self.mock.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<Spawned> {
        panic!("no spawn")
    }
    fn spawn_piped_unchecked(&mut self, _: &CmdSpec, _: &Path) -> std::io::Result<PipedChild> {
        panic!("no spawn")
    }
    fn sleep(&mut self, duration: Duration) {
        self.sleeps.push(duration);
        self.mock.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        if self.fault == "final_storage" && !self.storage_block().exists() {
            let record = RunRecord::load(&self.root, "orphan-run").unwrap();
            if record.resources.lease.as_ref().is_some_and(|lease| !lease.lock_dir.exists()) {
                std::fs::create_dir(self.storage_block()).unwrap();
            }
        }
        if self.fault == "retirement_only" && self.storage_block().exists() {
            std::fs::remove_dir(self.storage_block()).unwrap();
        }
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
}

#[test]
fn exit_between_signal_steps_completes_after_fresh_absence_proof() {
    for (fault, signals, result) in [
        ("exit_between_steps", vec!["-INT", "-TERM"], "removed"),
        ("exit_before_int", vec![], "absent"),
    ] {
        let (_root, _record, mut fake) = fixture("QarenIosRunner");
        fake.fault = fault;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Cleaned);
        assert_eq!(fake.signals, signals);
        assert_eq!(receipt.cleanup["runner_driver"], result);
    }
}

#[test]
fn explicit_cleanup_reaps_both_lossless_command_families_and_is_idempotent() {
    for family in ["QarenIosRunner", "RnFastRunner"] {
        let (root, record, mut fake) = fixture(family);
        let lease = record.resources.lease.unwrap().lock_dir;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(
            receipt.result,
            ReceiptResult::Cleaned,
            "{}",
            receipt.to_json()
        );
        assert_eq!(fake.signals, ["-INT", "-TERM", "-KILL"]);
        assert_eq!(
            fake.sleeps
                .iter()
                .filter(|s| **s == Duration::from_secs(1))
                .count(),
            30
        );
        assert!(fake.sleeps.contains(&Duration::from_millis(1500)));
        assert!(fake.sleeps.contains(&Duration::from_millis(300)));
        assert_eq!(receipt.cleanup["runner_driver"], "removed");
        assert_eq!(
            serde_json::to_value(&receipt.cleanup_details).unwrap()["runner_driver"]["result"],
            "reaped"
        );
        assert!(!lease.exists());
        assert!(RunRecord::load(&root, "orphan-run")
            .unwrap()
            .resources
            .runner_drivers
            .is_empty());
        let previous = fake.signals.clone();
        assert_eq!(
            fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver)
                .result,
            ReceiptResult::Cleaned
        );
        assert_eq!(fake.signals, previous);
    }
}

#[test]
fn escalation_stops_after_each_proven_exit() {
    for count in [1, 2] {
        let (_, _, mut fake) = fixture("QarenIosRunner");
        fake.exit_after = count;
        assert_eq!(
            fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver)
                .result,
            ReceiptResult::Cleaned
        );
        assert_eq!(fake.signals.len(), count);
    }
}

#[test]
fn unknown_or_foreign_evidence_never_gets_a_signal_or_releases_the_lease() {
    for fault in [
        "owner_unknown",
        "owner_live",
        "identity_unknown",
        "identity_changed",
        "command_unknown",
        "command_stderr",
        "malformed_helper",
        "wrong_helper_pid",
        "inventory_unknown",
        "missing_group",
        "stat_unknown",
        "stat_stderr",
        "lease_changed_during_observation",
    ] {
        let (_, record, mut fake) = fixture("QarenIosRunner");
        fake.fault = fault;
        let lease = record.resources.lease.unwrap().lock_dir;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert!(fake.signals.is_empty(), "{fault}");
        assert!(lease.exists(), "{fault}");
        let failure = receipt.failure.unwrap();
        assert_eq!(receipt.next_action, failure.next_action.as_str());
        let recovery = failure.recovery.unwrap();
        assert_eq!(recovery.action, RecoveryAction::RetainAndReport);
        assert_eq!(recovery.next_rung, None);
        assert!(!recovery.ladder[2].applicable);
    }
}

#[test]
fn lossless_command_and_lease_gates_refuse_without_signaling() {
    for fault in [
        "redacted",
        "truncated",
        "wrong_project",
        "wrong_destination",
        "extra_arg",
        "ambiguous",
        "missing_lease",
        "foreign_lease",
        "wrong_lease_device",
        "core_unproven",
    ] {
        let (root, mut record, mut fake) = fixture("RnFastRunner");
        match fault {
            "redacted" => {
                record.resources.runner_drivers[0].identity.command =
                    qaren::redact::OutputText::from_output("[REDACTED_SECRET]")
            }
            "truncated" => {
                record.resources.runner_drivers[0].identity.command =
                    qaren::redact::OutputText::from_output("xcodebuild test-without-building")
            }
            "wrong_project" => {
                fake.argv[3] = "/private/Other/Other.xcodeproj".into();
            }
            "wrong_destination" => {
                fake.argv[7] = "platform=iOS Simulator,id=other-device".into();
            }
            "extra_arg" => fake.argv.push("-quiet".into()),
            "ambiguous" => fake.argv[9] = "/private/../derived".into(),
            "missing_lease" => record.resources.lease = None,
            "foreign_lease" => {
                let lease = record.resources.lease.as_ref().unwrap();
                let path = lease.lock_dir.join("holder.json");
                let mut holder = qaren::buildplan::read_holder(&lease.lock_dir).unwrap();
                holder.holder = "foreign".into();
                qaren::buildplan::save_json(&path, &holder).unwrap();
            }
            "wrong_lease_device" => {
                record.resources.ios_simulator.as_mut().unwrap().udid = "other-device".into()
            }
            "core_unproven" => {
                record.resources.core_cleanup = Some(qaren::runrecord::CoreCleanupEvidence {
                    run_id: record.run_id.clone(),
                    pgid: 9000,
                    at: "now".into(),
                    outcome: GroupCleanupResult::Unresolved,
                })
            }
            _ => unreachable!(),
        }
        if matches!(
            fault,
            "wrong_project" | "wrong_destination" | "extra_arg" | "ambiguous"
        ) {
            record.resources.runner_drivers[0].identity.command =
                qaren::redact::OutputText::from_output(&fake.argv.join(" "));
        }
        record.save(&root).unwrap();
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert!(fake.signals.is_empty(), "{fault}");
        assert_ne!(receipt.result, ReceiptResult::Cleaned, "{fault}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::OwnershipUnproven,
            "{fault}"
        );
        assert_eq!(
            RunRecord::load(&root, "orphan-run")
                .unwrap()
                .resources
                .runner_drivers
                .len(),
            1
        );
    }
}

#[test]
fn identity_loss_after_term_withholds_kill_and_keeps_ownership() {
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.fault = "change_after_term";
    fake.exit_after = 99;
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(fake.signals, ["-INT", "-TERM"]);
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    assert_eq!(
        receipt.failure.unwrap().recovery.unwrap().reason,
        RecoveryReason::IdentityMismatch
    );
}

#[test]
fn retained_helpers_host_or_driver_prevent_release_and_temporary_device_cleanup() {
    for fault in ["helper_remaining", "host_remaining", "never_exits"] {
        let (root, mut record, mut fake) = fixture("QarenIosRunner");
        record.resources.device_borrowed = false;
        record.save(&root).unwrap();
        fake.fault = fault;
        if fault == "never_exits" {
            fake.exit_after = 99;
        }
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_ne!(receipt.result, ReceiptResult::Cleaned, "{fault}");
        assert!(receipt.cleanup["simulator"].contains("retained"), "{fault}");
        assert!(record.resources.lease.unwrap().lock_dir.exists(), "{fault}");
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::CleanupIncomplete,
            "{fault}"
        );
    }
}

#[test]
fn automatic_cleanup_stays_graceful_and_projects_the_supported_next_step() {
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.exit_after = 99;
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::GracefulOnly);
    assert_eq!(fake.signals, ["-INT"]);
    assert_eq!(fake.observations, 0);
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CleanupIncomplete);
    assert_eq!(failure.recovery.unwrap().next_rung, Some(2));
    assert_eq!(receipt.next_action, failure.next_action.as_str());
}

#[test]
fn retirement_storage_failure_retains_driver_device_and_lease_even_if_final_save_succeeds() {
    for fault in ["retirement_storage", "retirement_only"] {
        let (root, mut record, mut fake) = fixture("QarenIosRunner");
        record.resources.device_borrowed = false;
        record.save(&root).unwrap();
        fake.fault = fault;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(failure.code, FailureCode::RunRecordUpdateFailed);
        assert_eq!(
            failure.recovery.as_ref().unwrap().reason,
            RecoveryReason::StorageFailed
        );
        assert_eq!(failure.next_action.as_str(), receipt.next_action);
        assert!(receipt.cleanup["simulator"].contains("retained"));
        assert!(record.resources.lease.as_ref().unwrap().lock_dir.exists());
        assert_eq!(
            RunRecord::load(&root, "orphan-run")
                .unwrap()
                .resources
                .runner_drivers
                .len(),
            1
        );
        if fake.storage_block().exists() {
            std::fs::remove_dir(fake.storage_block()).unwrap();
        }
        // Retry keeps the borrowed simulator and preserves attempted signal history.
        let mut stored = RunRecord::load(&root, "orphan-run").unwrap();
        stored.resources.device_borrowed = true;
        stored.save(&root).unwrap();
        fake.fault = "";
        let attempted = fake.signals.clone();
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Cleaned);
        assert_eq!(fake.signals, attempted);
    }
}

#[test]
fn host_absence_storage_failure_retains_the_device_and_lease() {
    for borrowed in [true, false] {
        let (root, mut record, mut fake) = fixture("QarenIosRunner");
        record.resources.device_borrowed = borrowed;
        record.save(&root).unwrap();
        fake.fault = "host_storage";
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunRecordUpdateFailed);
        assert_ne!(receipt.cleanup["device_lease"], "removed");
        assert!(record.resources.lease.unwrap().lock_dir.exists());
        assert!(!RunRecord::load(&root, "orphan-run")
            .unwrap()
            .resources.runner_driver_cleanup.unwrap().host_absent);
        std::fs::remove_dir(fake.storage_block()).unwrap();
    }
}

#[test]
fn final_save_failure_reports_the_lease_that_was_actually_released() {
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.fault = "final_storage";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!record.resources.lease.unwrap().lock_dir.exists());
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUpdateFailed
    );
    assert_eq!(
        receipt.failure.unwrap().recovery.unwrap().action,
        RecoveryAction::RepairRecordStorage
    );
    std::fs::remove_dir(fake.storage_block()).unwrap();
    fake.fault = "";
    let retry = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(retry.result, ReceiptResult::Cleaned);
    assert_eq!(fake.signals, ["-INT", "-TERM", "-KILL"]);
}

#[test]
fn temporary_simulator_cleanup_is_idempotent_after_success_or_final_save_failure() {
    for fault in ["", "final_storage"] {
        let (root, mut record, mut fake) = fixture("QarenIosRunner");
        record.resources.device_borrowed = false;
        record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
            udid: DEVICE.into(),
            bundle_ids: vec!["dev.lykhoyda.rndevagent.fastrunner".into()],
        });
        record.save(&root).unwrap();
        fake.fault = fault;
        let first = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(
            first.result,
            if fault.is_empty() {
                ReceiptResult::Cleaned
            } else {
                ReceiptResult::Failed
            }
        );
        assert!(fake.simulator_deleted);
        assert_eq!(first.cleanup["device_lease"], "removed");
        if !fault.is_empty() {
            assert_eq!(
                first.failure.unwrap().code,
                FailureCode::RunRecordUpdateFailed
            );
            std::fs::remove_dir(fake.storage_block()).unwrap();
        }
        fake.fault = "";
        let previous_calls = fake.mock.calls.len();
        let retry = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(retry.result, ReceiptResult::Cleaned, "{}", retry.to_json());
        assert_eq!(retry.cleanup["simulator"], "absent");
        assert!(fake.mock.calls[previous_calls..].iter().all(|call| {
            !matches!(call.label.as_str(), "kill-group" | "simctl-shutdown" | "simctl-delete")
        }));
        assert_eq!(fake.signals, ["-INT", "-TERM", "-KILL"]);
        assert_eq!(
            RunRecord::load(&root, "orphan-run").unwrap().phase,
            Phase::Cleaned
        );
    }
}

#[test]
fn final_save_retry_leaves_a_subsequent_lease_holder_untouched() {
    let (root, _, mut fake) = fixture("QarenIosRunner");
    fake.fault = "final_storage";
    assert_eq!(
        fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver).result,
        ReceiptResult::Failed
    );
    std::fs::remove_dir(fake.storage_block()).unwrap();
    let next_lease = qaren::lease::acquire(
        &mut MockRunner::new(), &root.join("locks"), Platform::Ios, DEVICE, "next-run", None,
    ).unwrap();
    let before = std::fs::read(next_lease.lock_dir.join("holder.json")).unwrap();
    fake.fault = "host_remaining";
    let retry = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(retry.result, ReceiptResult::Cleaned);
    assert_eq!(std::fs::read(next_lease.lock_dir.join("holder.json")).unwrap(), before);
    assert_eq!(fake.signals, ["-INT", "-TERM", "-KILL"]);
}

#[test]
fn partial_multi_driver_recovery_keeps_successful_evidence_in_record_order() {
    let (root, mut record, mut fake) = fixture("QarenIosRunner");
    let mut foreign = record.resources.runner_drivers[0].clone();
    foreign.pgid = 7002;
    foreign.identity.pid = 7002;
    record.resources.runner_drivers.push(foreign);
    record.save(&root).unwrap();
    fake.fault = "multi_driver";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    let details = serde_json::to_value(receipt.cleanup_details.unwrap()).unwrap();
    assert_eq!(details["runner_driver"]["result"], "refused");
    assert_eq!(details["runner_driver"]["drivers"][0]["result"], "reaped");
    assert_eq!(details["runner_driver"]["drivers"][1]["result"], "refused");
    assert_eq!(fake.signals, ["-INT", "-TERM", "-KILL"]);
    let stored = RunRecord::load(&root, "orphan-run").unwrap();
    assert_eq!(stored.resources.runner_drivers.len(), 1);
    assert_eq!(stored.resources.runner_drivers[0].pgid, 7002);
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    let json = details.to_string();
    for canary in [
        "7000",
        "7002",
        "/private/",
        DEVICE,
        "xcodebuild",
        "test-app",
    ] {
        assert!(!json.contains(canary), "leaked {canary}");
    }
}

#[test]
fn simulator_runner_app_without_a_host_driver_has_a_terminal_supported_next_step() {
    let (root, mut record, mut fake) = fixture("RnFastRunner");
    record.resources.runner_drivers.clear();
    record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
        udid: DEVICE.into(),
        bundle_ids: vec!["dev.lykhoyda.rndevagent.fastrunner".into()],
    });
    record.save(&root).unwrap();
    fake.fault = "host_remaining";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(fake.signals.is_empty());
    assert!(fake.mock.calls.iter().all(|s| s.label != "simctl-terminate"
        && s.label != "simctl-shutdown"
        && s.label != "simctl-delete"));
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CleanupIncomplete);
    let recovery = failure.recovery.unwrap();
    assert_eq!(recovery.reason, RecoveryReason::HostRemaining);
    assert_eq!(recovery.action, RecoveryAction::RetainAndReport);
    assert!(!recovery.ladder[2].applicable);
    assert!(recovery.ladder[2].instruction.contains("unavailable"));
    assert_eq!(receipt.next_action, failure.next_action.as_str());
}
