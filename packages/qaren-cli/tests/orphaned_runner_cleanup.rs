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
        host_bundles: vec![],
        host_terminations: vec![],
        host_settle_remaining: 0,
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
    host_bundles: Vec<&'static str>,
    host_terminations: Vec<String>,
    host_settle_remaining: usize,
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
            "simctl-terminate" => {
                assert_eq!(spec.args[..3], ["simctl", "terminate", DEVICE]);
                let bundle = spec.args[3].clone();
                assert!(matches!(bundle.as_str(), qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID | qaren::adapters::ios::RUNNER_TEST_HOST_BUNDLE_ID));
                self.host_terminations.push(bundle.clone());
                if self.fault == "host_terminate_error" { return CmdOutput::failed(1, "refused"); }
                if self.fault == "host_terminate_timeout" {
                    let mut output = CmdOutput::success("");
                    output.timed_out = true;
                    output.exit_code = None;
                    return output;
                }
                if self.fault == "host_terminate_stderr" {
                    let mut output = CmdOutput::success("");
                    output.stderr = "warning".into();
                    return output;
                }
                if self.fault == "host_exit_together" { self.host_bundles.clear(); }
                if !matches!(self.fault, "host_survives" | "host_delayed") {
                    self.host_bundles.retain(|id| *id != bundle);
                }
                CmdOutput::success("")
            }
            "simctl-launchctl" => {
                if self.fault == "host_storage" && !self.storage_block().exists() {
                    std::fs::create_dir(self.storage_block()).unwrap();
                }
                if self.fault == "host_unknown" || (self.fault == "host_unknown_after" && !self.host_terminations.is_empty()) {
                    return CmdOutput::failed(1, "refused");
                }
                if self.fault == "host_core_changed" {
                    let mut record = RunRecord::load(&self.root, "orphan-run").unwrap();
                    record.resources.core_cleanup = Some(qaren::runrecord::CoreCleanupEvidence {
                        run_id: record.run_id.clone(), pgid: 9000, at: "now".into(),
                        outcome: GroupCleanupResult::Unresolved,
                    });
                    record.save(&self.root).unwrap();
                }
                if self.fault == "host_lease_changed"
                    || (self.fault == "host_lease_changed_after" && !self.host_terminations.is_empty())
                {
                    let record = RunRecord::load(&self.root, "orphan-run").unwrap();
                    let lease = record.resources.lease.unwrap();
                    let mut holder = qaren::buildplan::read_holder(&lease.lock_dir).unwrap();
                    holder.holder = "later-holder".into();
                    qaren::buildplan::save_json(&lease.lock_dir.join("holder.json"), &holder).unwrap();
                }
                if self.fault == "host_token_changed" {
                    let mut record = RunRecord::load(&self.root, "orphan-run").unwrap();
                    record.resources.lease.as_mut().unwrap().token = "different-token".into();
                    record.save(&self.root).unwrap();
                }
                if self.fault == "host_delayed" && !self.host_terminations.is_empty() {
                    if self.host_settle_remaining == 0 { self.host_bundles.clear(); }
                    else { self.host_settle_remaining -= 1; }
                }
                let mut rows = "PID Status Label\n1 0 com.apple.SpringBoard\n".to_string();
                if self.fault == "host_remaining" {
                    rows.push_str("42 0 dev.lykhoyda.rndevagent.fastrunner\n");
                }
                for (index, bundle) in self.host_bundles.iter().enumerate() {
                    rows.push_str(&format!("{} 0 UIKitApplication:{bundle}[abc][rb-legacy]\n", 42 + index));
                }
                if self.fault == "host_foreign" || (self.fault == "host_foreign_after" && !self.host_terminations.is_empty()) {
                    rows.push_str("99 0 UIKitApplication:com.example.foreign[foreign]\n");
                }
                if self.fault == "host_truncated" { rows.pop(); }
                CmdOutput::success(&rows)
            }
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
        fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
        let lease = record.resources.lease.unwrap().lock_dir;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert!(fake.signals.is_empty(), "{fault}");
        assert!(fake.host_terminations.is_empty(), "{fault}");
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
        fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
        record.save(&root).unwrap();
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert!(fake.signals.is_empty(), "{fault}");
        assert!(fake.host_terminations.is_empty(), "{fault}");
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
        fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(fake.host_terminations.len(), 1);
        assert!(!fake.simulator_deleted);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunRecordUpdateFailed);
        assert_ne!(receipt.cleanup["device_lease"], "removed");
        assert!(record.resources.lease.unwrap().lock_dir.exists());
        assert!(!RunRecord::load(&root, "orphan-run")
            .unwrap()
            .resources.runner_host_absent);
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
fn missing_lease_without_host_checkpoint_refuses_even_when_phase_is_cleaned() {
    let (root, mut record, mut fake) = fixture("QarenIosRunner");
    record.resources.runner_drivers.clear();
    let lease = record.resources.lease.take().unwrap();
    record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
        udid: DEVICE.into(),
        bundle_ids: vec!["dev.lykhoyda.rndevagent.fastrunner".into()],
    });
    record.phase = Phase::Cleaned;
    record.save(&root).unwrap();
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt.cleanup["runner_host"].contains("lease proof is missing"));
    assert_eq!(receipt.recovery.as_ref().unwrap().reason, RecoveryReason::LeaseUnproven);
    assert_eq!(receipt.recovery.as_ref().unwrap().action, RecoveryAction::RetainAndReport);
    assert!(lease.lock_dir.exists());
    assert!(fake.mock.calls.is_empty());
    assert!(!RunRecord::load(&root, "orphan-run").unwrap().resources.runner_host_absent);
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
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(fake.signals.is_empty());
    assert!(fake.mock.calls.iter().all(|s| s.label != "simctl-terminate"
        && s.label != "simctl-shutdown"
        && s.label != "simctl-delete"));
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::OwnershipUnproven);
    let recovery = failure.recovery.unwrap();
    assert_eq!(recovery.reason, RecoveryReason::HostCleanupFailed);
    assert_eq!(recovery.action, RecoveryAction::RequestExactSimulatorShutdown);
    assert_eq!(recovery.next_rung, Some(3));
    assert!(recovery.ladder[2].applicable);
    assert!(recovery.requires_user_ok);
    assert!(receipt.next_action.contains("only this run's simulator"));
    assert_eq!(receipt.next_action, failure.next_action.as_str());
}

#[test]
fn explicit_cleanup_terminates_only_constant_hosts_after_driver_retirement() {
    use qaren::adapters::ios::{RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID};
    for (initially_alive, fault) in [(false, ""), (true, ""), (false, "host_exit_together")] {
        let (root, record, mut fake) = fixture("QarenIosRunner");
        fake.alive = initially_alive;
        fake.fault = fault;
        fake.host_bundles = vec![RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID];
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Cleaned, "{}", receipt.to_json());
        assert_eq!(receipt.cleanup["runner_host"], "removed");
        let expected = if fault == "host_exit_together" { vec![RUNNER_HOST_BUNDLE_ID] }
            else { vec![RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID] };
        assert_eq!(fake.host_terminations, expected);
        assert!(!record.resources.lease.unwrap().lock_dir.exists());
        let stored = RunRecord::load(&root, "orphan-run").unwrap();
        assert!(stored.resources.runner_host_absent);
        assert!(stored.resources.runner_drivers.is_empty());
        assert_eq!(fake.signals.len(), if initially_alive { 3 } else { 0 });
        assert_eq!(fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver).result, ReceiptResult::Cleaned);
        assert_eq!(fake.host_terminations, expected);
    }
}

#[test]
fn explicit_host_cleanup_uses_the_existing_settle_polls() {
    let (_, _, mut fake) = fixture("QarenIosRunner");
    fake.alive = false;
    fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
    fake.fault = "host_delayed";
    fake.host_settle_remaining = 2;
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(fake.host_terminations.len(), 1);
    assert_eq!(fake.sleeps.iter().filter(|d| **d == Duration::from_millis(200)).count(), 2);
}

#[test]
fn automatic_host_cleanup_never_terminates_and_keeps_its_existing_advice() {
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.exit_after = 1;
    fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::GracefulOnly);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(fake.host_terminations.is_empty());
    assert!(record.resources.lease.unwrap().lock_dir.exists());
    let recovery = receipt.recovery.unwrap();
    assert_eq!(recovery.reason, RecoveryReason::HostRemaining);
    assert_eq!(recovery.action, RecoveryAction::RetainAndReport);
    assert!(recovery.ladder[2].instruction.contains("unavailable"));
}

#[test]
fn failed_explicit_host_cleanup_retains_the_lease_and_selects_exact_shutdown_advice() {
    for (fault, attempts) in [
        ("host_foreign", 0), ("host_unknown", 0), ("host_truncated", 0),
        ("host_lease_changed", 0), ("host_token_changed", 0), ("host_core_changed", 0),
        ("host_terminate_error", 1), ("host_terminate_stderr", 1),
        ("host_terminate_timeout", 1), ("host_lease_changed_after", 1),
        ("host_survives", 1), ("host_unknown_after", 1),
    ] {
        let (root, record, mut fake) = fixture("QarenIosRunner");
        fake.alive = false;
        fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
        fake.fault = fault;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_ne!(receipt.result, ReceiptResult::Cleaned, "{fault}");
        assert!(record.resources.lease.unwrap().lock_dir.exists(), "{fault}");
        assert!(!RunRecord::load(&root, "orphan-run").unwrap().resources.runner_host_absent, "{fault}");
        assert_eq!(fake.host_terminations.len(), attempts, "{fault}");
        assert!(fake.signals.is_empty(), "{fault}");
        let failure = receipt.failure.unwrap();
        assert_eq!(failure.next_action.as_str(), receipt.next_action);
        let recovery = failure.recovery.unwrap();
        if matches!(fault, "host_lease_changed" | "host_token_changed" | "host_lease_changed_after" | "host_core_changed") {
            let expected_reason = if fault == "host_core_changed" { RecoveryReason::CoreUnproven } else { RecoveryReason::LeaseUnproven };
            assert_eq!(recovery.reason, expected_reason, "{fault}");
            assert_eq!(recovery.action, RecoveryAction::RetainAndReport);
            assert_eq!(recovery.next_rung, None);
            assert!(!recovery.destroys_state && !recovery.requires_user_ok);
        } else {
            assert_eq!(recovery.reason, RecoveryReason::HostCleanupFailed, "{fault}");
            assert_eq!(recovery.action, RecoveryAction::RequestExactSimulatorShutdown, "{fault}");
            assert_eq!(recovery.next_rung, Some(3));
            assert!(recovery.destroys_state && recovery.requires_user_ok);
        }
    }
}

#[test]
fn explicit_host_cleanup_rechecks_inventory_before_the_second_bundle() {
    use qaren::adapters::ios::{RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID};
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.alive = false;
    fake.host_bundles = vec![RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID];
    fake.fault = "host_foreign_after";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_ne!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(fake.host_terminations, [RUNNER_HOST_BUNDLE_ID]);
    assert!(record.resources.lease.unwrap().lock_dir.exists());
}

#[test]
fn invalid_explicit_host_authority_never_terminates() {
    use qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID;
    for fault in ["missing-retirement", "wrong-device", "empty-token", "wrong-host-device"] {
        let (root, mut record, mut fake) = fixture("QarenIosRunner");
        fake.alive = false;
        fake.host_bundles = vec![RUNNER_HOST_BUNDLE_ID];
        record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
            udid: DEVICE.into(), bundle_ids: vec![RUNNER_HOST_BUNDLE_ID.into()],
        });
        match fault {
            "missing-retirement" => record.resources.runner_drivers.clear(),
            "wrong-device" => {
                record.resources.lease = Some(qaren::lease::acquire(
                    &mut MockRunner::new(), &root.join("locks"), Platform::Ios,
                    "AAAABBBB-1111-2222-3333-444455557777", &record.run_id, None,
                ).unwrap());
            }
            "empty-token" => record.resources.lease.as_mut().unwrap().token.clear(),
            "wrong-host-device" => record.resources.runner_host.as_mut().unwrap().udid = "AAAABBBB-1111-2222-3333-444455557777".into(),
            _ => unreachable!(),
        }
        record.save(&root).unwrap();
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Refused, "{fault}: {}", receipt.to_json());
        assert!(fake.host_terminations.is_empty(), "{fault}");
        assert!(fake.signals.is_empty(), "{fault}");
        assert!(record.resources.lease.unwrap().lock_dir.exists(), "{fault}");
        let expected = if matches!(fault, "wrong-device" | "empty-token" | "wrong-host-device") {
            RecoveryAction::RetainAndReport
        } else {
            RecoveryAction::RequestExactSimulatorShutdown
        };
        assert_eq!(receipt.recovery.unwrap().action, expected, "{fault}");
    }
}

#[test]
fn explicit_host_cleanup_preserves_a_holder_that_changes_between_bundles() {
    use qaren::adapters::ios::{RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID};
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.alive = false;
    fake.host_bundles = vec![RUNNER_HOST_BUNDLE_ID, RUNNER_TEST_HOST_BUNDLE_ID];
    fake.fault = "host_lease_changed_after";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(fake.host_terminations, [RUNNER_HOST_BUNDLE_ID]);
    let holder = qaren::buildplan::read_holder(&record.resources.lease.unwrap().lock_dir).unwrap();
    assert_eq!(holder.holder, "later-holder");
    assert_eq!(receipt.recovery.unwrap().action, RecoveryAction::RetainAndReport);
}

#[test]
fn a_running_app_without_a_qaren_host_does_not_block_explicit_cleanup() {
    let (_, record, mut fake) = fixture("QarenIosRunner");
    fake.alive = false;
    fake.fault = "host_foreign";
    let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(receipt.cleanup["runner_host"], "absent");
    assert!(fake.host_terminations.is_empty());
    assert!(!record.resources.lease.unwrap().lock_dir.exists());
}

#[test]
fn explicit_host_cleanup_refuses_a_live_or_unknown_owner_after_recorded_driver_retirement() {
    for fault in ["owner_live", "owner_unknown"] {
        let (root, _, mut fake) = fixture("QarenIosRunner");
        fake.alive = false;
        fake.host_bundles = vec![qaren::adapters::ios::RUNNER_HOST_BUNDLE_ID];
        fake.fault = "host_survives";
        assert_ne!(fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver).result, ReceiptResult::Cleaned);
        let mut record = RunRecord::load(&root, "orphan-run").unwrap();
        assert!(record.resources.runner_drivers.is_empty());
        record.resources.device_borrowed = false;
        record.save(&root).unwrap();
        let attempts = fake.host_terminations.len();
        fake.fault = fault;
        let receipt = fake.run_cleanup(RunnerCleanupPolicy::ReapRecordedDriver);
        assert_eq!(receipt.result, ReceiptResult::Refused, "{fault}");
        assert_eq!(fake.host_terminations.len(), attempts);
        assert!(!fake.simulator_deleted);
        assert!(record.resources.lease.unwrap().lock_dir.exists());
        assert_eq!(receipt.recovery.as_ref().unwrap().reason, RecoveryReason::OwnerUnproven);
        assert_eq!(receipt.recovery.unwrap().action, RecoveryAction::RetainAndReport);
    }
}
