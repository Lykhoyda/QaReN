mod common;

use qaren::commands::cleanup::cleanup;
use qaren::exec::Spawned;
use qaren::exec::{CmdOutput, MockRunner, RealRunner, Runner};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{
    AdbServerResource, FarmResource, IosSimResource, MetroResource, Phase, RunRecord,
    TunnelResource,
};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

#[test]
fn interrupted_finite_build_retains_ownership_until_group_absence_is_proven() {
    use qaren::runrecord::BuildLockResource;
    for fault in ["pending", "unknown_group", "retirement_save"] {
        let pending = fault == "pending";
        let repo = common::temp_repo();
        let mut record = core_record(&repo);
        record.resources.core = None;
        record.resources.ios_simulator = Some(IosSimResource {
            udid: "selected-device".into(),
            name: "qaren-core-run".into(),
            device_type: "iPhone".into(),
            runtime: "iOS".into(),
        });
        record.resources.begin_build().unwrap();
        if !pending {
            record
                .resources
                .record_build_spawned(5000, Some(common::identity(5000, LSTART)))
                .unwrap();
        }
        record.resources.build_lock = Some(BuildLockResource {
            lock_dir: repo.join("locks/native-build-ios"),
            holder: "qaren-core-run".into(),
        });
        std::fs::create_dir_all(&record.resources.build_lock.as_ref().unwrap().lock_dir).unwrap();
        qaren::buildplan::save_json(
            &repo.join("locks/native-build-ios/holder.json"),
            &qaren::buildplan::LockHolder {
                holder: "qaren-core-run".into(),
                run_id: "core-run".into(),
                identity: None,
                at: "now".into(),
                home: None,
                qaren_home: None,
                group: None,
            },
        )
        .unwrap();
        record.save(&repo).unwrap();
        let lease_dir = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        let build_lock_dir = record
            .resources
            .build_lock
            .as_ref()
            .unwrap()
            .lock_dir
            .clone();
        let blocked_save = RunRecord::run_dir(&repo, "core-run")
            .join(format!(".run.json.tmp.{}", std::process::id()));
        if fault == "retirement_save" {
            std::fs::create_dir(&blocked_save).unwrap();
        }
        let mut mock = MockRunner::new();
        if !pending {
            mock.expect_run(
                "ps -A",
                if fault == "retirement_save" {
                    CmdOutput::success("1 1 S\n")
                } else {
                    CmdOutput::failed(1, "denied")
                },
            );
        }
        let receipt = cleanup(&mut mock, &repo, "core-run");
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert!(receipt.cleanup["build_process"].starts_with("unresolved"));
        assert!(receipt.cleanup["build_lock"].contains("retained"));
        assert!(receipt.cleanup["simulator"].contains("retained"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
        assert!(lease_dir.exists());
        assert!(build_lock_dir.exists());
        assert!(RunRecord::load(&repo, "core-run")
            .unwrap()
            .resources
            .build_process()
            .is_some());
        assert!(!mock.calls.iter().any(|c| c.label == "kill-group"));
        assert_eq!(mock.remaining(), 0);
        if fault == "retirement_save" {
            assert!(receipt.cleanup["build_process"].contains("could not be persisted"));
            std::fs::remove_dir(&blocked_save).unwrap();
        }
        if !pending {
            let mut recovery = MockRunner::new();
            recovery.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
            recovery.expect_run("simctl list", CmdOutput::success("{\"devices\":{}}"));
            let receipt = cleanup(&mut recovery, &repo, "core-run");
            assert_eq!(receipt.result, ReceiptResult::Cleaned);
            assert_eq!(receipt.cleanup["build_process"], "absent");
            assert_eq!(receipt.cleanup["build_lock"], "removed");
            assert!(!lease_dir.exists());
            assert!(!repo.join("locks/native-build-ios").exists());
            assert!(RunRecord::load(&repo, "core-run")
                .unwrap()
                .resources
                .build_process()
                .is_none());
            assert_eq!(recovery.remaining(), 0);
        }
    }
}

fn core_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::ios_scenario_yaml(8791),
        "core-run",
        Phase::Walking,
    );
    record.resources.core = Some(qaren::runrecord::CoreResource {
        pgid: 9000,
        identity: Some(common::identity(9000, LSTART)),
    });
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &repo.join("locks"),
            qaren::scenario::Platform::Ios,
            "selected-device",
            "core-run",
            None,
        )
        .unwrap(),
    );
    record
}

fn owner_gone(mock: &mut MockRunner) {
    mock.expect_run("ps -p 999 -o lstart=", CmdOutput::success(""));
}

fn write_original_core_record(repo: &std::path::Path, core: serde_json::Value) -> RunRecord {
    let record = core_record(repo);
    record.save(repo).unwrap();
    let mut stored = serde_json::to_value(&record).unwrap();
    stored["resources"]["core"] = core;
    std::fs::write(
        RunRecord::path(repo, "core-run"),
        serde_json::to_vec(&stored).unwrap(),
    )
    .unwrap();
    record
}

#[test]
fn original_schema_core_identity_loads_in_status_and_recovers_via_owned_group_cleanup() {
    let repo = common::temp_repo();
    let record = write_original_core_record(
        &repo,
        serde_json::json!({
            "pid": 9000, "started_at": "Wed Aug 12 16:01:00 2026", "command": "node /runtime/qa/walk.js"
        }),
    );
    let lock = record.resources.lease.unwrap().lock_dir;
    let original = std::fs::read(RunRecord::path(&repo, "core-run")).unwrap();
    let status = qaren::commands::status::status(&mut MockRunner::new(), &repo, "core-run");
    assert_eq!(status.phase, "walking");
    assert_eq!(status.failure.unwrap().code, FailureCode::Interrupted);
    assert_eq!(
        std::fs::read(RunRecord::path(&repo, "core-run")).unwrap(),
        original
    );
    assert!(lock.exists());

    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run(
        "ps -A",
        CmdOutput::success("1 1 S\n9000 9000 S\n9001 9000 S\n"),
    );
    mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::success(LSTART));
    mock.expect_run("ps -p 9000 -o stat=", CmdOutput::success("S"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -TERM -- -9000", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -KILL -- -9000", CmdOutput::success(""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.failure
    );
    assert_eq!(receipt.cleanup["core"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert!(stored.resources.core.is_none());
    assert!(stored.resources.lease.is_none());
    assert_eq!(stored.resources.core_cleanup.unwrap().pgid, 9000);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn original_schema_core_never_adopts_reused_or_unknown_process_ownership() {
    for (inventory, birth, stat) in [
        (
            CmdOutput::success("1 1 S\n9000 9000 S\n"),
            Some(CmdOutput::success("Thu Aug 13 16:01:00 2026")),
            None,
        ),
        (
            CmdOutput::success("1 1 S\n9001 9000 S\n"),
            Some(CmdOutput::failed(1, "")),
            None,
        ),
        (
            CmdOutput::success("1 1 S\n9000 9000 S\n"),
            Some(CmdOutput::failed(1, "ps denied")),
            None,
        ),
        (
            CmdOutput::success("1 1 S\n9000 9000 S\n"),
            Some(CmdOutput {
                timed_out: true,
                ..CmdOutput::success(LSTART)
            }),
            None,
        ),
        (
            CmdOutput::success("1 1 S\n9000 9000 S\n"),
            Some(CmdOutput::success(LSTART)),
            Some(CmdOutput::failed(1, "stat denied")),
        ),
        (CmdOutput::failed(1, "inventory denied"), None, None),
    ] {
        let repo = common::temp_repo();
        let record = write_original_core_record(
            &repo,
            serde_json::json!({
                "pid": 9000, "started_at": "Wed Aug 12 16:01:00 2026", "command": "node /runtime/qa/walk.js"
            }),
        );
        let lease = record.resources.lease.unwrap();
        let mut mock = MockRunner::new();
        let settles = birth.is_some();
        let settled_inventory = inventory.clone();
        owner_gone(&mut mock);
        mock.expect_run("ps -A", inventory);
        if let Some(birth) = birth {
            mock.expect_run("ps -p 9000 -o lstart=", birth);
        }
        if let Some(stat) = stat {
            mock.expect_run("ps -p 9000 -o stat=", stat);
        }
        if settles {
            mock.expect_run("ps -A", settled_inventory);
        }
        let started = mock.now_epoch_ms();
        let receipt = cleanup(&mut mock, &repo, "core-run");
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert!(receipt.cleanup["core"].starts_with("unresolved"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
        assert_eq!(mock.now_epoch_ms() - started, if settles { 300 } else { 0 });
        assert_eq!(
            mock.calls
                .iter()
                .filter(|spec| spec.label == "ps-groups")
                .count(),
            if settles { 2 } else { 1 }
        );
        assert_eq!(mock.remaining(), 0);
        assert!(lease.lock_dir.exists());
        let stored = RunRecord::load(&repo, "core-run").unwrap();
        let core = stored.resources.core.unwrap();
        assert_eq!(core.pgid, 9000);
        assert_eq!(core.identity.unwrap().started_at, LSTART);
        assert_eq!(stored.resources.lease.unwrap().wire(), lease.wire());
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(RunRecord::path(&repo, "core-run")).unwrap())
                .unwrap();
        assert_eq!(json["schema"], "qaren-run/1");
        assert_eq!(json["resources"]["core"]["pgid"], 9000);
        assert_eq!(json["resources"]["core"]["identity"]["pid"], 9000);
        assert!(json["resources"]["core"].get("pid").is_none());

        let mut retry = MockRunner::new();
        owner_gone(&mut retry);
        retry.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        assert_eq!(
            cleanup(&mut retry, &repo, "core-run").result,
            ReceiptResult::Cleaned
        );
        assert!(retry.calls.iter().all(|spec| spec.label != "kill-group"));
        assert!(!lease.lock_dir.exists());
    }
}

#[test]
fn original_schema_core_invalid_group_ids_refuse_without_probing_or_signaling() {
    for pid in [-9000, 0, 1] {
        let repo = common::temp_repo();
        let record = write_original_core_record(
            &repo,
            serde_json::json!({
                "pid": pid, "started_at": "Wed Aug 12 16:01:00 2026", "command": "node /runtime/qa/walk.js"
            }),
        );
        let lock = record.resources.lease.unwrap().lock_dir;
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        let receipt = cleanup(&mut mock, &repo, "core-run");
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert!(receipt.cleanup["core"].starts_with("refused"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        assert_eq!(mock.calls.len(), 1);
        assert_eq!(mock.calls[0].rendered(), "ps -p 999 -o lstart=");
        assert!(lock.exists());
    }
}

#[test]
fn ambiguous_same_schema_core_shapes_do_not_guess_ownership_or_rewrite_the_record() {
    for core in [
        serde_json::json!({"pid":9000,"started_at":LSTART,"command":"node walk.js","pgid":9001}),
        serde_json::json!({"pgid":9001,"identity":null,"pid":9000,"started_at":LSTART,"command":"node walk.js"}),
        serde_json::json!({"pid":"9000","started_at":LSTART,"command":"node walk.js"}),
        serde_json::json!({"pid":9000,"command":"node walk.js"}),
        serde_json::json!({"pid":2147483648_i64,"started_at":LSTART,"command":"node walk.js"}),
    ] {
        let repo = common::temp_repo();
        let record = write_original_core_record(&repo, core);
        let lock = record.resources.lease.unwrap().lock_dir;
        let path = RunRecord::path(&repo, "core-run");
        let before = std::fs::read(&path).unwrap();
        let mut mock = MockRunner::new();
        let receipt = cleanup(&mut mock, &repo, "core-run");
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::RunRecordInvalid);
        assert!(mock.calls.is_empty());
        assert!(lock.exists());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }
}

#[test]
fn core_group_settles_absent_in_one_cleanup_without_signaling_a_dead_leader() {
    let repo = common::temp_repo();
    let record = core_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 S\n"));
    mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let started = mock.now_epoch_ms();

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(receipt.cleanup["core"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert_eq!(stored.phase, Phase::Cleaned);
    assert!(stored.resources.core.is_none());
    assert!(stored.resources.lease.is_none());
    let evidence = stored.resources.core_cleanup.as_ref().unwrap();
    assert_eq!(evidence.run_id, "core-run");
    assert_eq!(evidence.pgid, 9000);
    assert_eq!(
        evidence.outcome,
        qaren::runrecord::GroupCleanupResult::Absent
    );
    assert_eq!(
        serde_json::to_value(receipt.core_cleanup).unwrap(),
        serde_json::to_value(stored.resources.core_cleanup).unwrap()
    );
    assert_eq!(mock.now_epoch_ms() - started, 300);
    assert_eq!(mock.calls.len(), 4);
    assert_eq!(mock.calls[0].rendered(), "ps -p 999 -o lstart=");
    assert_eq!(mock.calls[3].label, "ps-groups");
    assert_eq!(mock.calls[3].timeout_seconds, 10);
    assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn core_group_settle_retains_ownership_when_still_present_or_inventory_unknown() {
    for after in [
        CmdOutput::success("1 1 S\n9001 9000 S\n"),
        CmdOutput::failed(1, "inventory denied"),
        CmdOutput::success("1 1 S\nmalformed"),
        CmdOutput::success(""),
        CmdOutput {
            timed_out: true,
            ..CmdOutput::success("1 1 S\n")
        },
    ] {
        let repo = common::temp_repo();
        let record = core_record(&repo);
        let lease = record.resources.lease.as_ref().unwrap().clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 S\n"));
        mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::failed(1, ""));
        mock.expect_run("ps -A", after);
        let started = mock.now_epoch_ms();

        let receipt = cleanup(&mut mock, &repo, "core-run");

        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert!(receipt.cleanup["core"].starts_with("unresolved"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        let stored = RunRecord::load(&repo, "core-run").unwrap();
        assert_eq!(stored.resources.core.as_ref().unwrap().pgid, 9000);
        assert_eq!(
            stored.resources.lease.as_ref().unwrap().wire(),
            lease.wire()
        );
        assert!(lease.lock_dir.exists());
        assert_eq!(
            stored.resources.core_cleanup.as_ref().unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Unresolved
        );
        assert_eq!(
            serde_json::to_value(receipt.core_cleanup).unwrap(),
            serde_json::to_value(stored.resources.core_cleanup).unwrap()
        );
        assert_eq!(mock.now_epoch_ms() - started, 300);
        assert_eq!(mock.calls.len(), 4);
        assert_eq!(mock.calls[0].rendered(), "ps -p 999 -o lstart=");
        assert_eq!(mock.calls[3].label, "ps-groups");
        assert_eq!(mock.calls[3].timeout_seconds, 10);
        assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn core_group_inventory_reads_a_process_whose_state_ps_cannot_report() {
    let repo = common::temp_repo();
    let record = core_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run(
        "ps -A",
        CmdOutput::success("1 1 S\n715 54753 ?\n725 34131 ?+\n726 34131 ?E\n"),
    );
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert_eq!(receipt.cleanup["core"], "absent");
    assert!(!lock.exists());

    let repo = common::temp_repo();
    let record = core_record(&repo);
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 ?\n"));
    mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 ?\n"));
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert_eq!(
        receipt.cleanup["core"],
        "unresolved: process group remains but its leader ownership is unproven"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn core_group_unknown_initial_inventory_is_not_retried() {
    for inventory in [
        CmdOutput::failed(1, "inventory denied"),
        CmdOutput::success("1 1 S\nmalformed"),
        CmdOutput::success(""),
        CmdOutput {
            timed_out: true,
            ..CmdOutput::success("1 1 S\n")
        },
    ] {
        let repo = common::temp_repo();
        let record = core_record(&repo);
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        mock.expect_run("ps -A", inventory);
        let started = mock.now_epoch_ms();

        let receipt = cleanup(&mut mock, &repo, "core-run");

        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(
            receipt.cleanup["core"],
            "unresolved: process-group inventory is unknown"
        );
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        let stored = RunRecord::load(&repo, "core-run").unwrap();
        assert!(stored.resources.core.is_some());
        assert!(stored.resources.lease.is_some());
        assert!(lock.exists());
        assert_eq!(
            stored.resources.core_cleanup.unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Unresolved
        );
        assert_eq!(mock.now_epoch_ms(), started);
        assert_eq!(mock.calls.len(), 2);
        assert_eq!(mock.calls[0].rendered(), "ps -p 999 -o lstart=");
        assert_eq!(mock.calls[1].label, "ps-groups");
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn core_group_cleanup_requires_positive_inventory_after_kill_not_just_leader_exit() {
    for (after, clean) in [
        (CmdOutput::success("1 1 S\n"), true),
        (CmdOutput::success("1 1 S\n9001 9000 S\n"), false),
        (CmdOutput::failed(1, "denied"), false),
        (CmdOutput::success("1 1 S\nmalformed"), false),
    ] {
        let repo = common::temp_repo();
        let record = core_record(&repo);
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        mock.expect_run(
            "ps -A",
            CmdOutput::success("1 1 S\n9000 9000 S\n9001 9000 S\n"),
        );
        mock.expect_run("ps -p 9000", CmdOutput::success(LSTART));
        mock.expect_run("ps -p 9000", CmdOutput::success("S"));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill -TERM -- -9000", CmdOutput::success(""));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill -KILL -- -9000", CmdOutput::success(""));
        mock.expect_run("ps -A", after);
        let receipt = cleanup(&mut mock, &repo, "core-run");
        assert_eq!(receipt.result == ReceiptResult::Cleaned, clean);
        let record = RunRecord::load(&repo, "core-run").unwrap();
        assert_eq!(record.resources.core.is_none(), clean);
        assert_eq!(!lock.exists(), clean);
        assert_eq!(
            record.resources.core_cleanup.as_ref().unwrap().outcome,
            if clean {
                qaren::runrecord::GroupCleanupResult::Removed
            } else {
                qaren::runrecord::GroupCleanupResult::Unresolved
            }
        );
        assert_eq!(
            serde_json::to_value(receipt.core_cleanup).unwrap(),
            serde_json::to_value(record.resources.core_cleanup).unwrap()
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn core_cleanup_evidence_save_failure_retains_resource_and_lease_until_retry() {
    let repo = common::temp_repo();
    let record = core_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let blocked =
        RunRecord::run_dir(&repo, "core-run").join(format!(".run.json.tmp.{}", std::process::id()));
    std::fs::create_dir(&blocked).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 S\n"));
    mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert_ne!(receipt.result, ReceiptResult::Cleaned);
    assert!(receipt.cleanup["core"].contains("could not be persisted"));
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
    let record = RunRecord::load(&repo, "core-run").unwrap();
    assert!(record.resources.core.is_some());
    assert!(record.resources.core_cleanup.is_none());
    assert!(receipt.core_cleanup.is_none());
    assert!(lock.exists());
    assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
    assert_eq!(mock.remaining(), 0);
    std::fs::remove_dir(blocked).unwrap();
    let mut retry = MockRunner::new();
    owner_gone(&mut retry);
    retry.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    assert_eq!(
        cleanup(&mut retry, &repo, "core-run").result,
        ReceiptResult::Cleaned
    );
    assert!(!lock.exists());
}

#[test]
fn a_live_owner_keeps_its_core_and_no_signal_is_sent() {
    let mut owner = MockRunner::new();
    owner.expect_run(
        "ps -p 999 -o lstart=",
        CmdOutput::success("Wed Aug 12 15:00:00 2026"),
    );
    owner.expect_run("ps -p 999 -o stat=", CmdOutput::success("S"));
    assert_core_kept_for(owner, |_| {}, true);
}

#[test]
fn an_unknown_owner_keeps_its_core() {
    let mut owner = MockRunner::new();
    owner.expect_run("ps -p 999 -o lstart=", CmdOutput::failed(1, "ps denied"));
    assert_core_kept_for(owner, |_| {}, false);
}

#[test]
fn a_record_without_owner_identity_keeps_its_core() {
    assert_core_kept_for(MockRunner::new(), |record| record.prepare = None, false);
}

fn assert_core_kept_for(mut mock: MockRunner, edit: impl FnOnce(&mut RunRecord), live_owner: bool) {
    let repo = common::temp_repo();
    let mut record = core_record(&repo);
    edit(&mut record);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();

    let before = std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap();
    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(
        receipt.cleanup["core"],
        "refused: the run's qaren process is alive or unproven gone"
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(!mock
        .calls
        .iter()
        .any(|spec| spec.rendered().contains("/bin/kill")));
    assert!(!mock.calls.iter().any(|spec| spec.label == "ps-groups"));
    if live_owner {
        assert_live_owner_refusal(&receipt, &record, &mock, &repo, &before);
    } else {
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained"));
    }
    assert!(lock.exists());
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert_eq!(stored.resources.core.unwrap().pgid, 9000);
    assert!(stored.resources.core_cleanup.is_none());
    assert_eq!(mock.remaining(), 0);
}

fn assert_live_owner_refusal(
    receipt: &qaren::receipt::Receipt,
    record: &RunRecord,
    mock: &MockRunner,
    repo: &std::path::Path,
    before: &[u8],
) {
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.phase, record.phase.as_str());
    assert_eq!(
        receipt.cleanup,
        std::collections::BTreeMap::from([(
            "core".to_string(),
            "refused: the run's qaren process is alive or unproven gone".to_string(),
        )])
    );
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::OwnershipUnproven);
    assert_eq!(failure.detail, "not proven ours or unresolved: core (refused: the run's qaren process is alive or unproven gone)");
    assert_eq!(
        receipt.next_action,
        "resolve the listed resources manually; qaren will not touch them"
    );
    assert_eq!(failure.next_action, receipt.next_action);
    assert!(!receipt.outcomes.contains_key("record_saved"));
    let scenario = receipt.scenario.as_ref().unwrap();
    assert_eq!(scenario.name, record.scenario.name);
    assert_eq!(scenario.platform, "ios");
    assert_eq!(scenario.path, record.scenario_path);
    assert_eq!(scenario.sha256, record.scenario_sha256);
    assert_eq!(
        serde_json::to_value(&receipt.candidate).unwrap(),
        serde_json::to_value(Some(&record.candidate)).unwrap()
    );
    let device = receipt.device.as_ref().unwrap();
    assert_eq!(
        device.ios_udid,
        record
            .resources
            .ios_simulator
            .as_ref()
            .map(|s| s.udid.clone())
    );
    assert_eq!(
        device.ios_name,
        record
            .resources
            .ios_simulator
            .as_ref()
            .map(|s| s.name.clone())
    );
    assert_eq!(
        device.ios_device_type,
        record
            .resources
            .ios_simulator
            .as_ref()
            .map(|s| s.device_type.clone())
    );
    assert_eq!(
        device.ios_runtime,
        record
            .resources
            .ios_simulator
            .as_ref()
            .map(|s| s.runtime.clone())
    );
    assert_eq!(
        serde_json::to_value(&receipt.build).unwrap(),
        serde_json::to_value(&record.build).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&receipt.core_cleanup).unwrap(),
        serde_json::to_value(&record.resources.core_cleanup).unwrap()
    );
    assert_eq!(
        serde_json::to_value(&receipt.fresh_install).unwrap(),
        serde_json::to_value(&record.resources.fresh_install).unwrap()
    );
    assert_eq!(mock.calls.len(), 2);
    assert_eq!(mock.calls[0].rendered(), "ps -p 999 -o lstart=");
    assert_eq!(mock.calls[1].rendered(), "ps -p 999 -o stat=");
    assert_eq!(receipt.commands_executed, 2);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        std::fs::read(RunRecord::run_dir(repo, "core-run").join("run.json")).unwrap(),
        before
    );
    assert!(record.resources.lease.as_ref().unwrap().lock_dir.exists());
}

#[test]
fn a_live_walking_owner_refuses_the_whole_cleanup_without_commands_or_save() {
    let repo = common::temp_repo();
    let mut record = core_record(&repo);
    let siblings = ios_ready_record(&repo);
    record.resources.ios_simulator = siblings.resources.ios_simulator;
    record.resources.metro = siblings.resources.metro;
    record.save(&repo).unwrap();
    let before = std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "ps -p 999 -o lstart=",
        CmdOutput::success("Wed Aug 12 15:00:00 2026"),
    );
    mock.expect_run("ps -p 999 -o stat=", CmdOutput::success("S"));

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_live_owner_refusal(&receipt, &record, &mock, &repo, &before);
}

#[test]
fn an_unknown_borrowed_ios_owner_refuses_all_cleanup() {
    assert_borrowed_ios_owner_refusal_with_metro(true);
}

#[test]
fn a_borrowed_ios_record_without_owner_identity_refuses_all_cleanup() {
    assert_borrowed_ios_owner_refusal_with_metro(false);
}

fn assert_borrowed_ios_owner_refusal_with_metro(with_owner: bool) {
    let repo = common::temp_repo();
    let mut record = core_record(&repo);
    record.resources.metro = ios_ready_record(&repo).resources.metro;
    if !with_owner {
        record.prepare = None;
    }
    record.resources.ios_simulator = Some(IosSimResource {
        udid: "1DC408C4-51DA-4C4F-ACA1-39881C916FDD".into(),
        name: "borrowed".into(),
        device_type: "dt".into(),
        runtime: "rt".into(),
    });
    record.resources.device_borrowed = true;
    record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
        udid: "1DC408C4-51DA-4C4F-ACA1-39881C916FDD".into(),
        bundle_ids: vec!["dev.lykhoyda.rndevagent.fastrunner".into()],
    });
    record.save(&repo).unwrap();
    let before = std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap();
    let mut mock = MockRunner::new();
    if with_owner {
        mock.expect_run("ps -p 999 -o lstart=", CmdOutput::failed(1, "ps denied"));
    }
    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt.cleanup["simulator"].starts_with("refused:"));
    assert_eq!(mock.calls.len(), usize::from(with_owner));
    assert_eq!(mock.remaining(), 0);
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert_eq!(stored.resources.core.unwrap().pgid, 9000);
    assert!(stored.resources.core_cleanup.is_none());
    assert_eq!(stored.history.len(), record.history.len());
    assert_eq!(
        std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap(),
        before
    );
    assert!(record.resources.lease.as_ref().unwrap().lock_dir.exists());
}

#[test]
fn a_reused_owner_pid_counts_as_gone() {
    let repo = common::temp_repo();
    let record = core_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "ps -p 999 -o lstart=",
        CmdOutput::success("Thu Aug 13 09:00:00 2026"),
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n9001 9000 S\n"));
    mock.expect_run("ps -p 9000 -o lstart=", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(receipt.cleanup["core"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    assert_eq!(mock.remaining(), 0);
}

struct TestProcesses {
    owner: std::process::Child,
    groups: Vec<qaren::runrecord::PidIdentity>,
}

impl Drop for TestProcesses {
    fn drop(&mut self) {
        let _ = self.owner.kill();
        let _ = self.owner.wait();
        for core in &self.groups {
            let live = qaren::runrecord::probe_pid_identity(&mut RealRunner::new(), core);
            if live == qaren::runrecord::PidLiveness::AliveMatching {
                let _ = std::process::Command::new("/bin/kill")
                    .args(["-KILL", "--", &format!("-{}", core.pid)])
                    .status();
            }
        }
    }
}

fn process_exists(pid: i32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[test]
fn a_live_owner_keeps_a_real_core_group_alive_until_the_owner_is_gone() {
    let mut processes = TestProcesses {
        owner: std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap(),
        groups: Vec::new(),
    };
    let owner_pid = processes.owner.id() as i32;
    let prepare = qaren::runrecord::capture_pid_identity(&mut RealRunner::new(), owner_pid);
    assert!(prepare.is_some());

    let core_identity = spawn_test_group(&mut processes);
    let core_pid = core_identity.pid;
    let metro_identity = spawn_test_group(&mut processes);
    let metro_pid = metro_identity.pid;
    let port_reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let metro_port = port_reservation.local_addr().unwrap().port();

    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "core-run",
        Phase::Walking,
    );
    record.prepare = prepare;
    record.resources.core = Some(qaren::runrecord::CoreResource {
        pgid: core_pid,
        identity: Some(core_identity),
    });
    record.resources.metro = Some(MetroResource {
        port: metro_port,
        endpoint: format!("http://127.0.0.1:{metro_port}"),
        spawned: Spawned {
            pid: metro_pid,
            pgid: metro_pid,
        },
        identity: Some(metro_identity),
        log: repo.join("metro.log"),
    });
    record.save(&repo).unwrap();
    let before = std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap();
    drop(port_reservation);

    let receipt = cleanup(&mut RealRunner::new(), &repo, "core-run");
    assert_eq!(
        receipt.cleanup["core"],
        "refused: the run's qaren process is alive or unproven gone"
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(process_exists(core_pid));
    assert!(process_exists(metro_pid));
    assert_eq!(
        std::fs::read(RunRecord::run_dir(&repo, "core-run").join("run.json")).unwrap(),
        before
    );

    processes.owner.kill().unwrap();
    processes.owner.wait().unwrap();
    let receipt = cleanup(&mut RealRunner::new(), &repo, "core-run");
    assert_eq!(receipt.cleanup["core"], "removed", "{:?}", receipt.cleanup);
    assert_eq!(receipt.cleanup["metro"], "removed", "{:?}", receipt.cleanup);
    assert!(!process_exists(core_pid));
    assert!(!process_exists(metro_pid));
}

fn spawn_test_group(processes: &mut TestProcesses) -> qaren::runrecord::PidIdentity {
    let spawned = std::process::Command::new("sh")
        .args([
            "-c",
            "perl -e 'setpgrp(0,0); exec q(sleep), 30' </dev/null >/dev/null 2>&1 & echo $!",
        ])
        .output()
        .unwrap();
    let pid: i32 = String::from_utf8(spawned.stdout)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let identity = qaren::runrecord::capture_pid_identity(&mut RealRunner::new(), pid).unwrap();
    processes.groups.push(identity.clone());
    let leads_group = || {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pgid="])
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).trim() == pid.to_string())
    };
    for _ in 0..100 {
        if leads_group() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(leads_group());
    identity
}

fn ios_ready_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::ios_scenario_yaml(8791),
        "iosrun1",
        Phase::Ready,
    );
    record.resources.ios_simulator = Some(IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: "qaren-iosrun1".to_string(),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.metro = Some(MetroResource {
        port: 8791,
        endpoint: "http://127.0.0.1:8791".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record
}

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn sim_list_json(name: &str, state: &str) -> String {
    format!(r#"{{"devices":{{"rt":[{{"udid":"AAAA-1111","name":"{name}","state":"{state}"}}]}}}}"#)
}

#[test]
fn ios_happy_cleanup_then_idempotent_rerun() {
    let repo = common::temp_repo();
    ios_ready_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // metro group: leader alive+matching, port owned by a child of the group
    // -> TERM, KILL, leader gone, port free
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    // simulator: present with matching name, booted -> shutdown + delete
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("qaren-iosrun1", "Booted")),
    );
    mock.expect_run("simctl shutdown AAAA-1111", CmdOutput::success(""));
    mock.expect_run("simctl delete AAAA-1111", CmdOutput::success(""));

    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(receipt.cleanup.get("metro").unwrap(), "removed");
    assert_eq!(
        receipt.cleanup.get("simulator").unwrap(),
        "removed (reclaimed bytes unknown)"
    );
    assert_eq!(mock.remaining(), 0);

    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_eq!(reloaded.phase, Phase::Cleaned);

    // Second run: everything already gone -> cleaned again, no kill attempted.
    let mut mock2 = MockRunner::new();
    mock2.expect_run("ps", CmdOutput::failed(1, ""));
    mock2.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock2.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock2.expect_run(
        "simctl list",
        CmdOutput::success(r#"{"devices":{"rt":[]}}"#),
    );
    let receipt2 = cleanup(&mut mock2, &repo, "iosrun1");
    assert_eq!(receipt2.result, ReceiptResult::Cleaned);
    assert_eq!(receipt2.cleanup.get("metro").unwrap(), "absent");
    assert_eq!(receipt2.cleanup.get("simulator").unwrap(), "absent");
    assert!(
        !mock2.calls.iter().any(|c| c.program.contains("kill")),
        "idempotent rerun must not kill"
    );
}

#[test]
fn refuses_foreign_named_simulator() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("Someone-Elses-Sim", "Booted")),
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("simulator")
        .unwrap()
        .starts_with("refused"));
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::OwnershipUnproven
    );
    assert_eq!(
        mock.calls.len(),
        1,
        "the list probe must be the only command against a foreign sim"
    );
    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn port_group_equality_cannot_override_unproven_leader_identity() {
    for birth in [Some("Thu Aug 13 09:00:00 2026"), Some(""), None] {
        let repo = common::temp_repo();
        let mut record = ios_ready_record(&repo);
        record.resources.ios_simulator = None;
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        mock.expect_run(
            "ps",
            match birth {
                Some(value) => CmdOutput::success(value),
                None => CmdOutput::failed(1, "denied"),
            },
        );
        mock.expect_run("lsof", CmdOutput::success("6001\n"));
        mock.expect_run("ps", CmdOutput::success("5000\n"));
        let receipt = cleanup(&mut mock, &repo, "iosrun1");
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert!(receipt.cleanup["metro"].starts_with("unresolved"));
        assert!(RunRecord::load(&repo, "iosrun1")
            .unwrap()
            .resources
            .metro
            .is_some());
        assert!(!mock.calls.iter().any(|c| c.label == "kill-group"));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn refuses_corrupt_pgid() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    if let Some(metro) = &mut record.resources.metro {
        metro.spawned.pgid = 1;
    }
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt.cleanup.get("metro").unwrap().contains("pgid"));
    assert!(mock.calls.is_empty());
}

#[test]
fn android_cleanup_stops_only_own_lease() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun1",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun1".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: Some(common::identity(7000, LSTART)),
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.adb_local_serial = Some("127.0.0.1:5555".to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    let run_dir = RunRecord::run_dir(&repo, "androidrun1");
    std::fs::create_dir_all(&run_dir).unwrap();
    let vendor_key = run_dir.join("nuc-adbkey");
    std::fs::write(&vendor_key, "FAKEKEY").unwrap();
    record.resources.adb_server = Some(AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15037,
        log: repo.join("adb-server.log"),
    });
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // adb connection: server identity alive -> disconnect through it
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run(
        "disconnect 127.0.0.1:5555",
        CmdOutput::success("disconnected 127.0.0.1:5555\n"),
    );
    // adb server group: alive matching, port owned by the group -> TERM/KILL
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    // tunnel: alive matching, port owned by the group -> TERM/KILL -> dead, port free
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    // farm: lease is ours -> stop
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-androidrun1 claimed_at=x state=device\nslot=2 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5557 lease=free state=down\n",
    ));
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun1");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("adb_server").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("adb_vendor_key").unwrap(), "removed");
    assert!(
        !vendor_key.exists(),
        "the fetched vendor key must be deleted"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn tunnel_cleanup_retains_group_when_identity_missing_despite_port_match() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun4",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("7050\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    let receipt = cleanup(&mut mock, &repo, "androidrun4");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(receipt.cleanup["tunnel"].starts_with("unresolved"));
    assert!(RunRecord::load(&repo, "androidrun4")
        .unwrap()
        .resources
        .tunnel
        .is_some());
    assert!(!mock.calls.iter().any(|c| c.label == "kill-group"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn tunnel_cleanup_leaves_foreign_listener_on_local_port() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun5",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("8123\n"));
    mock.expect_run("ps", CmdOutput::success("9999\n")); // foreign pgid
    let receipt = cleanup(&mut mock, &repo, "androidrun5");
    // Without a recorded identity, a foreign listener proves nothing about the
    // spawned group; the honest answer is unresolved, never absent.
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(
        !mock.calls.iter().any(|c| c.program.contains("kill")),
        "a foreign listener on the tunnel port must never be killed"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "the port ownership probe must run before judging the group"
    );
}

#[test]
fn identity_missing_with_free_port_is_unresolved_not_absent() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun6",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // A free port does not prove a just-spawned, not-yet-bound group is gone.
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let receipt = cleanup(&mut mock, &repo, "androidrun6");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(!mock.calls.iter().any(|c| c.program.contains("kill")));
}

#[test]
fn cleanup_retains_farm_lease_when_tunnel_unproven() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun7",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun7".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // Tunnel port probe is inconclusive -> tunnel unresolved -> the lease must
    // be retained: releasing it would let the next lease share a port with a
    // possibly-live foreign forward.
    mock.expect_run("lsof", CmdOutput::failed(2, "lsof: internal error"));
    // The port-keyed lease gate re-probes and is equally inconclusive.
    mock.expect_run("lsof", CmdOutput::failed(2, "lsof: internal error"));
    let receipt = cleanup(&mut mock, &repo, "androidrun7");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert!(
        receipt
            .cleanup
            .get("farm_lease")
            .unwrap()
            .starts_with("refused"),
        "farm lease must be retained while the tunnel is unproven: {:?}",
        receipt.cleanup
    );
    assert!(
        !mock.calls.iter().any(|c| c.program == "ssh"),
        "no farm command may run while the tunnel is unproven"
    );
    let reloaded = RunRecord::load(&repo, "androidrun7").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

fn tunnel_and_farm_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::android_scenario_yaml(8792),
        run_id,
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: format!("qaren-{run_id}"),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record
}

fn farm_status_leased_by(run_id: &str) -> CmdOutput {
    CmdOutput::success(&format!(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-{run_id} claimed_at=x state=device\n"
    ))
}

#[test]
fn farm_lease_is_released_when_unresolved_tunnel_port_is_proven_free() {
    let repo = common::temp_repo();
    tunnel_and_farm_record(&repo, "androidrun20")
        .save(&repo)
        .unwrap();

    let mut mock = MockRunner::new();
    // No identity and a free port: the group stays unresolved (never guessed
    // absent), but the forwarded port is positively free.
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port()); // port-keyed lease gate
    mock.expect_run(
        "~/bin/android-farm status",
        farm_status_leased_by("androidrun20"),
    );
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun20");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(
        receipt.cleanup.get("farm_lease").unwrap(),
        "removed",
        "a provably free forwarded port cannot expose the next lease: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CleanupIncomplete
    );
    assert_eq!(mock.remaining(), 0);
    let reloaded = RunRecord::load(&repo, "androidrun20").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn farm_lease_is_released_after_the_recorded_group_owning_the_port_is_killed() {
    let repo = common::temp_repo();
    let mut record = tunnel_and_farm_record(&repo, "androidrun21");
    record.resources.tunnel.as_mut().unwrap().identity = Some(common::identity(7000, LSTART));
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("7050\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // listener is in our group
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run(
        "~/bin/android-farm status",
        farm_status_leased_by("androidrun21"),
    );
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun21");
    assert_eq!(receipt.cleanup.get("tunnel").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        mock.calls.iter().filter(|c| c.program == "lsof").count(),
        2,
        "a clean tunnel outcome already proves the port; no extra probe"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn farm_lease_is_retained_when_the_tunnel_port_has_a_foreign_owner() {
    let repo = common::temp_repo();
    tunnel_and_farm_record(&repo, "androidrun22")
        .save(&repo)
        .unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("8123\n"));
    mock.expect_run("ps", CmdOutput::success("9999\n")); // foreign pgid
    mock.expect_run("lsof", CmdOutput::success("8123\n")); // lease gate: still occupied

    let receipt = cleanup(&mut mock, &repo, "androidrun22");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert!(
        receipt
            .cleanup
            .get("farm_lease")
            .unwrap()
            .starts_with("refused"),
        "an occupied forwarded port must keep the slot held: {:?}",
        receipt.cleanup
    );
    assert!(
        !mock.calls.iter().any(|c| c.program == "ssh"),
        "no farm command may run while the forwarded port is occupied"
    );
    assert!(!mock.calls.iter().any(|c| c.program.contains("kill")));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn post_kill_indeterminate_port_probe_is_unresolved() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, "")); // leader gone
    mock.expect_run(
        "lsof",
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
    ); // post-kill port probe times out: survival cannot be excluded
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert!(receipt
        .cleanup
        .get("metro")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn cleanup_recovers_pending_simulator_by_run_scoped_name() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    // A crash between the pending-allocation save and the udid fill leaves an
    // empty udid; the run-scoped name is the recovery key.
    record.resources.ios_simulator.as_mut().unwrap().udid = String::new();
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("qaren-iosrun1", "Booted")),
    );
    mock.expect_run("simctl shutdown AAAA-1111", CmdOutput::success(""));
    mock.expect_run("simctl delete AAAA-1111", CmdOutput::success(""));
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(
        receipt.cleanup.get("simulator").unwrap(),
        "removed (reclaimed bytes unknown)"
    );
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
}

#[test]
fn cleanup_pending_simulator_absent_when_create_never_ran() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    record.resources.ios_simulator.as_mut().unwrap().udid = String::new();
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(r#"{"devices":{"rt":[{"udid":"BBBB-2222","name":"Someone-Elses-Sim","state":"Booted"}]}}"#),
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.cleanup.get("simulator").unwrap(), "absent");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        mock.calls.len(),
        1,
        "a foreign-named simulator must never be touched during name recovery"
    );
}

#[test]
fn cleanup_save_failure_downgrades_cleaned_to_failed() {
    use std::os::unix::fs::PermissionsExt;
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let run_dir = RunRecord::run_dir(&repo, "iosrun1");
    std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    // Environments that bypass mode bits (root, permissive ACLs) cannot
    // exercise this failure path; skip rather than flake.
    if std::fs::write(run_dir.join(".mode-probe"), b"x").is_ok() {
        let _ = std::fs::remove_file(run_dir.join(".mode-probe"));
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("skipping: filesystem does not enforce directory modes here");
        return;
    }

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "an unpersisted cleaned phase must not report cleaned"
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUpdateFailed
    );
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .next_action
        .contains("cleanup"));
}

#[test]
fn android_cleanup_refuses_foreign_lease() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun2",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun2".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ssh", CmdOutput::success(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=someone-else state=device\n",
    ));
    let receipt = cleanup(&mut mock, &repo, "androidrun2");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("farm_lease")
        .unwrap()
        .contains("someone-else"));
    assert_eq!(
        mock.calls.len(),
        1,
        "must not issue farm stop for a foreign lease"
    );
}

#[test]
fn android_cleanup_unreachable_farm_is_unresolved_not_cleaned() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun3",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun3".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "ssh",
        CmdOutput::failed(255, "ssh: connect to host nuc: timed out"),
    );
    let receipt = cleanup(&mut mock, &repo, "androidrun3");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CleanupIncomplete
    );
    let reloaded = RunRecord::load(&repo, "androidrun3").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn cleanup_without_record_is_refused() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "no-such-run");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUnavailable
    );
    assert!(mock.calls.is_empty(), "no probes may run without a record");
}

#[test]
fn cleanup_rejects_traversal_run_id() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "../escape");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordInvalid
    );
}

#[test]
fn vendor_key_is_deleted_even_when_the_adb_server_never_spawned() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun6",
        Phase::Failed,
    );
    let run_dir = RunRecord::run_dir(&repo, "androidrun6");
    std::fs::create_dir_all(&run_dir).unwrap();
    let vendor_key = run_dir.join("nuc-adbkey");
    std::fs::write(&vendor_key, "FAKEKEY").unwrap();
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "androidrun6");
    assert_eq!(receipt.cleanup.get("adb_vendor_key").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(
        !vendor_key.exists(),
        "the fetched vendor key must not survive a run that died before the server spawned"
    );
}

#[test]
fn cleanup_retains_the_device_lease_until_the_metro_group_is_proven_gone() {
    let repo = common::temp_repo();
    let lock_root = repo.join(".locks");
    let mut holder = MockRunner::new();
    let lease = qaren::lease::acquire(
        &mut holder,
        &lock_root,
        qaren::scenario::Platform::Ios,
        "AAAA-1111",
        "iosrun1",
        Some(common::identity(4242, LSTART)),
    )
    .unwrap();
    let lock_dir = lease.lock_dir.clone();
    let mut record = ios_ready_record(&repo);
    record.resources.device_borrowed = true;
    record.resources.lease = Some(lease);
    record.save(&repo).unwrap();

    // Metro group: alive, TERM, KILL, and the leader survives both -> unresolved.
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_ne!(receipt.result, ReceiptResult::Cleaned);
    assert!(receipt.cleanup["metro"].starts_with("unresolved"));
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: metro"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    assert!(
        lock_dir.exists(),
        "the lease survives an unresolved Metro leg"
    );
    assert_eq!(mock.remaining(), 0);

    // Metro leader dead and the port free -> the lease is released.
    let mut mock2 = MockRunner::new();
    owner_gone(&mut mock2);
    mock2.expect_run("ps", CmdOutput::failed(1, ""));
    mock2.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock2.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let receipt2 = cleanup(&mut mock2, &repo, "iosrun1");
    assert_eq!(
        receipt2.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt2.failure
    );
    assert_eq!(receipt2.cleanup["metro"], "absent");
    assert_eq!(receipt2.cleanup["device_lease"], "removed");
    assert!(!lock_dir.exists());
    assert_eq!(mock2.remaining(), 0);
}

#[test]
fn a_dead_owners_runner_host_must_exit_naturally_before_the_lease_is_released() {
    const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    const HOSTS: [&str; 2] = [
        "dev.lykhoyda.rndevagent.fastrunner",
        "dev.lykhoyda.rndevagent.fastrunner.uitests.xctrunner",
    ];
    let repo = common::temp_repo();
    let mut record = core_record(&repo);
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: UDID.to_string(),
        name: "borrowed".to_string(),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.runner_host = Some(qaren::runrecord::RunnerHostResource {
        udid: UDID.to_string(),
        bundle_ids: HOSTS.iter().map(|b| b.to_string()).collect(),
    });
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let inventory = format!(
        r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"udid":"{UDID}","name":"borrowed","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}}]}}}}"#
    );
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
    mock.expect_run(
        "launchctl list",
        CmdOutput::success(&format!(
            "PID Status Label\n42 0 UIKitApplication:{}[abc]\n",
            HOSTS[0]
        )),
    );
    mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
    mock.expect_run(
        "launchctl list",
        CmdOutput::success("PID Status Label\n1 0 com.apple.SpringBoard\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup["runner_host"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    assert!(mock
        .calls
        .iter()
        .all(|spec| spec.label != "simctl-terminate"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn a_transient_runner_host_read_releases_the_lease_on_the_first_cleanup() {
    const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let repo = common::temp_repo();
    let mut record = core_record(&repo);
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: UDID.into(),
        name: "borrowed".into(),
        device_type: "dt".into(),
        runtime: "rt".into(),
    });
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let inventory = serde_json::json!({"devices":{
        "com.apple.CoreSimulator.SimRuntime.iOS-27-0":[{
            "udid": UDID, "name":"borrowed", "state":"Booted", "isAvailable":true,
            "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"
        }]
    }})
    .to_string();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
    mock.expect_run(
        "launchctl list",
        CmdOutput::failed(1, "temporarily unavailable"),
    );
    mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
    mock.expect_run(
        "launchctl list",
        CmdOutput::success("PID Status Label\n1 0 com.apple.SpringBoard\n"),
    );
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup["runner_host"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    assert_eq!(mock.remaining(), 0);
}

fn driver_record(repo: &std::path::Path) -> RunRecord {
    let mut record = core_record(repo);
    record
        .resources
        .runner_drivers
        .push(qaren::runrecord::RunnerDriverResource {
            pgid: 7000,
            identity: common::identity(7000, LSTART),
        });
    record
}

#[test]
fn a_dead_owner_s_recorded_runner_driver_group_is_signaled_and_the_lease_released() {
    let repo = common::temp_repo();
    let record = driver_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n7000 7000 S\n"));
    mock.expect_run(
        "ps -A",
        CmdOutput::success("1 1 S\n7000 7000 S\n7001 7000 S\n"),
    );
    mock.expect_run("ps -p 7000", CmdOutput::success(LSTART));
    mock.expect_run("ps -p 7000", CmdOutput::success("S"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -INT -- 7000", CmdOutput::success(""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert_eq!(receipt.cleanup["core"], "absent");
    assert_eq!(receipt.cleanup["runner_driver"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(!lock.exists());
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert!(stored.resources.runner_drivers.is_empty());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn a_runner_driver_whose_leader_is_not_the_recorded_process_is_never_signaled() {
    let repo = common::temp_repo();
    let record = driver_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n7000 7000 S\n"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n7000 7000 S\n"));
    mock.expect_run("ps -p 7000", CmdOutput::success("Thu Aug 13 09:00:00 2026"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n7000 7000 S\n"));

    let receipt = cleanup(&mut mock, &repo, "core-run");

    assert!(receipt.cleanup["runner_driver"].starts_with("unresolved"));
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved"));
    assert!(lock.exists());
    assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert_eq!(stored.resources.runner_drivers.len(), 1);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn an_unproven_owner_keeps_its_runner_driver_without_signaling() {
    let repo = common::temp_repo();
    let mut record = driver_record(&repo);
    record.resources.core = None;
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps -p 999 -o lstart=", CmdOutput::failed(1, "denied"));
    let receipt = cleanup(&mut mock, &repo, "core-run");
    assert!(receipt.cleanup["runner_driver"].starts_with("refused"));
    assert!(mock.calls.iter().all(|spec| spec.label != "kill-group"));
    let stored = RunRecord::load(&repo, "core-run").unwrap();
    assert_eq!(stored.resources.runner_drivers.len(), 1);
}

const BORROWED: &str = "emulator-5554";
const ADB_CLIENT_41: &str = "Android Debug Bridge version 1.0.41\nVersion 36.0.0-13206524\n";
// Real `adb forward --list` bytes end with a blank line.
const RUNNER_FORWARD: &str =
    "emulator-5554 tcp:41234 tcp:22089\nemulator-5556 tcp:41299 tcp:22089\n\n";
// `dumpsys activity processes <runner>` on an API 37 emulator, runner instrumenting and stopped.
const RUNNER_PROCESSES: &str = include_str!("fixtures/android-runner-processes-running.txt");
const NO_RUNNER_PROCESS: &str = include_str!("fixtures/android-runner-processes-stopped.txt");

// A `qaren check` run on a borrowed emulator whose qaren process died mid-walk.
fn borrowed_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &format!(
            "schema: qaren/1\nname: check\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: 8791\nandroid_emulator:\n  serial: {BORROWED}\n  avd: Pixel_9_API_37\n"
        ),
        "borrowed-run",
        Phase::Walking,
    );
    record.resources.core = Some(qaren::runrecord::CoreResource {
        pgid: 9000,
        identity: Some(common::identity(9000, LSTART)),
    });
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &repo.join("locks"),
            qaren::scenario::Platform::Android,
            BORROWED,
            "borrowed-run",
            None,
        )
        .unwrap(),
    );
    record.resources.android_emulator = Some(qaren::runrecord::BorrowedEmulatorResource {
        serial: BORROWED.to_string(),
        avd: "Pixel_9_API_37".to_string(),
        server_port: 5037,
        api_level: 37,
        abi: "x86_64".to_string(),
    });
    record.resources.adb_path = Some(repo.join("sdk/platform-tools/adb"));
    record.resources.adb_local_serial = Some(BORROWED.to_string());
    record.resources.adb_reverse_port = Some(8791);
    record.resources.app_install = Some(qaren::runrecord::AppInstallResource {
        app_id: "com.rndevagent.testapp".to_string(),
        serial: BORROWED.to_string(),
        server_port: 5037,
        artifact: qaren::buildplan::CachedArtifact {
            path: repo.join("app-debug.apk"),
            sha256: "a".repeat(64),
            kind: qaren::buildplan::ArtifactKind::Apk,
        },
        via: "adb-install".to_string(),
        installed_at: "2026-08-12T16:00:00Z".to_string(),
        removal: None,
    });
    record
}

// The dead owner, its core group gone, then the borrowed server's version matching the recorded adb.
fn borrowed_mock() -> MockRunner {
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5037, 41));
    owner_gone(&mut mock);
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock
}

fn adb_commands(mock: &MockRunner) -> Vec<String> {
    mock.calls
        .iter()
        .filter(|c| c.program.ends_with("/adb"))
        .map(|c| c.args.join(" "))
        .collect()
}

fn assert_no_owned_server_legs(receipt: &qaren::receipt::Receipt) {
    for leg in [
        "adb_server",
        "adb_connection",
        "app_install",
        "adb_vendor_key",
        "farm_lease",
    ] {
        assert!(
            !receipt.cleanup.contains_key(leg),
            "{leg}: {:?}",
            receipt.cleanup
        );
    }
}

#[test]
fn android_borrowed_cleanup_removes_reverse_and_releases_runner() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = borrowed_mock();
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run(
        &format!("-s {BORROWED} reverse --remove tcp:8791"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        &format!("-s {BORROWED} reverse --list"),
        CmdOutput::success("host-19 tcp:8081 tcp:8081\n"),
    );
    mock.expect_run("forward --list", CmdOutput::success(RUNNER_FORWARD));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(RUNNER_PROCESSES),
    );
    mock.expect_run(
        &format!("-s {BORROWED} forward --remove tcp:41234"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        "am force-stop dev.lykhoyda.rndevagent.androidrunner.test",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "am force-stop dev.lykhoyda.rndevagent.androidrunner",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "forward --list",
        CmdOutput::success("emulator-5556 tcp:41299 tcp:22089\n\n"),
    );
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup["adb_reverse"], "removed");
    assert_eq!(receipt.cleanup["android_runner"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_no_owned_server_legs(&receipt);
    assert!(!lock.exists());
    assert_eq!(mock.remaining(), 0);
    for call in mock
        .calls
        .iter()
        .filter(|c| c.program.ends_with("/adb") && c.label != "adb-version")
    {
        assert!(call.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:5037".to_string()
        )));
        let rendered = call.rendered();
        assert!(
            !rendered.contains("uninstall")
                && !rendered.contains("kill-server")
                && !rendered.contains("emu kill")
        );
    }
    assert!(!adb_commands(&mock).iter().any(|c| c.contains("41299")));
}

#[test]
fn android_borrowed_cleanup_absent_reverse_is_absent() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = borrowed_mock();
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run(
        "reverse --remove tcp:8791",
        CmdOutput::failed(1, "adb: error: listener 'tcp:8791' not found"),
    );
    // A walk that never started a runner leaves nothing to release, and must not hold the lease.
    // Real adb prints a lone newline for an empty forward list.
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert_eq!(receipt.cleanup["adb_reverse"], "absent");
    assert_eq!(receipt.cleanup["android_runner"], "absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(!adb_commands(&mock).iter().any(|c| c.contains("force-stop")));
    assert!(!lock.exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_borrowed_cleanup_refuses_without_the_runs_lease() {
    for with_recorder in [false, true] {
        for foreign in [true, false] {
            let repo = common::temp_repo();
            let mut record = borrowed_record(&repo);
            if foreign {
                // A second run now holds the emulator's lease.
                record.resources.lease.as_mut().unwrap().holder = "another-run-holder".to_string();
            } else {
                let lease = record.resources.lease.take().unwrap();
                assert_eq!(
                    qaren::lease::release(&lease),
                    qaren::buildplan::ReleaseOutcome::Removed
                );
            }
            if with_recorder {
                record.resources.recorder = Some(qaren::runrecord::RecorderResource {
                    pid: None,
                    birth: None,
                    pulled_sha256: None,
                    kind: qaren::runrecord::RecorderKind::AndroidEmulator,
                    device: BORROWED.into(),
                    output: "/data/local/tmp/qaren-borrowed-run.mp4".into(),
                });
            }
            record.save(&repo).unwrap();
            let mut mock = borrowed_mock();
            if with_recorder {
                owner_gone(&mut mock);
            }

            let receipt = cleanup(&mut mock, &repo, "borrowed-run");

            for leg in ["adb_reverse", "android_runner"]
                .into_iter()
                .chain(with_recorder.then_some("recorder"))
            {
                assert_eq!(
                    receipt.cleanup[leg], "refused: the device lease is not held by this run",
                    "{leg}"
                );
            }
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert!(adb_commands(&mock).is_empty(), "{:?}", adb_commands(&mock));
            assert_no_owned_server_legs(&receipt);
            if foreign {
                assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained"));
            }
            assert_eq!(
                RunRecord::load(&repo, "borrowed-run")
                    .unwrap()
                    .resources
                    .recorder
                    .is_some(),
                with_recorder
            );
            assert_eq!(mock.remaining(), 0);
        }
    }
}

#[test]
fn android_borrowed_cleanup_waits_for_a_live_owner() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5037, 41));
    mock.expect_run(
        "ps -p 999 -o lstart=",
        CmdOutput::success("Wed Aug 12 15:00:00 2026"),
    );
    mock.expect_run("ps -p 999 -o stat=", CmdOutput::success("S"));

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert_eq!(
        receipt.cleanup["core"],
        "refused: the run's qaren process is alive or unproven gone"
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(adb_commands(&mock).is_empty());
    assert!(lock.exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_borrowed_runner_release_unverified_retains_the_lease() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = borrowed_mock();
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run("reverse --list", CmdOutput::success(""));
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(RUNNER_PROCESSES),
    );
    mock.expect_run("am force-stop", CmdOutput::success(""));
    mock.expect_run("am force-stop", CmdOutput::success(""));
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(RUNNER_PROCESSES),
    );

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert!(
        receipt.cleanup["android_runner"].starts_with("unresolved"),
        "{:?}",
        receipt.cleanup
    );
    assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained"));
    assert!(receipt.cleanup["device_lease"].contains("android_runner"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(lock.exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_borrowed_cleanup_never_runs_an_adb_the_borrowed_server_would_not_accept() {
    for with_recorder in [false, true] {
        for server in [Some(40), None] {
            let repo = common::temp_repo();
            let mut record = borrowed_record(&repo);
            let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
            if with_recorder {
                record.resources.recorder = Some(qaren::runrecord::RecorderResource {
                    pid: None,
                    birth: None,
                    pulled_sha256: None,
                    kind: qaren::runrecord::RecorderKind::AndroidEmulator,
                    device: BORROWED.into(),
                    output: "/data/local/tmp/qaren-borrowed-run.mp4".into(),
                });
            }
            record.save(&repo).unwrap();
            let mut mock = MockRunner::new();
            owner_gone(&mut mock);
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
            if with_recorder {
                owner_gone(&mut mock);
            }
            if let Some(version) = server {
                mock.adb_servers.push((5037, version));
                mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
                if with_recorder {
                    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
                }
            }

            let receipt = cleanup(&mut mock, &repo, "borrowed-run");

            for leg in ["adb_reverse", "android_runner"]
                .into_iter()
                .chain(with_recorder.then_some("recorder"))
            {
                assert!(
                    receipt.cleanup[leg].starts_with("unresolved"),
                    "{leg}: {:?}",
                    receipt.cleanup
                );
            }
            assert!(adb_commands(&mock).iter().all(|c| c == "version"));
            assert!(lock.exists());
            assert_eq!(
                RunRecord::load(&repo, "borrowed-run")
                    .unwrap()
                    .resources
                    .recorder
                    .is_some(),
                with_recorder
            );
            assert_eq!(mock.remaining(), 0);
        }
    }
}

#[test]
fn android_borrowed_remove_app_is_refused() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();

    let receipt = qaren::commands::cleanup::cleanup_with(
        &mut mock,
        &repo,
        "borrowed-run",
        Some(&format!("borrowed-run/{BORROWED}/com.rndevagent.testapp")),
    );

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::AppRemovalNotConfirmed);
    assert!(failure
        .detail
        .contains("a borrowed emulator keeps the app; uninstall it yourself"));
    assert!(receipt.next_action.contains("uninstall"));
    assert!(!receipt.next_action.contains("--confirm-remove-app"));
    assert!(mock.calls.is_empty());
}

#[test]
fn android_borrowed_reverse_still_listed_after_removal_is_unresolved() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = borrowed_mock();
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run(
        "reverse --list",
        CmdOutput::success("host-19 tcp:8791 tcp:8791\n"),
    );
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert!(
        receipt.cleanup["adb_reverse"].starts_with("unresolved"),
        "{:?}",
        receipt.cleanup
    );
    assert!(receipt.cleanup["device_lease"].contains("adb_reverse"));
    assert!(lock.exists());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_borrowed_runner_unrecognised_process_dump_is_not_absent() {
    // This image answers `dumpsys activity instrumentation` with an error and exit 0, runner up or not.
    let unsupported = include_str!("fixtures/android-dumpsys-unsupported.txt");
    for (dump, ok) in [(unsupported, true), ("", true), ("denied", false)] {
        let repo = common::temp_repo();
        let record = borrowed_record(&repo);
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = borrowed_mock();
        mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
        mock.expect_run(
            "reverse --remove tcp:8791",
            CmdOutput::failed(1, "adb: error: listener 'tcp:8791' not found"),
        );
        mock.expect_run("forward --list", CmdOutput::success("\n"));
        mock.expect_run(
            "dumpsys activity processes dev.lykhoyda.rndevagent.androidrunner",
            if ok {
                CmdOutput::success(dump)
            } else {
                CmdOutput::failed(1, dump)
            },
        );

        let receipt = cleanup(&mut mock, &repo, "borrowed-run");

        assert!(
            receipt.cleanup["android_runner"].starts_with("unresolved"),
            "{dump:?}: {:?}",
            receipt.cleanup
        );
        assert!(receipt.cleanup["device_lease"].contains("android_runner"));
        assert!(lock.exists());
        assert!(!adb_commands(&mock).iter().any(|c| c.contains("force-stop")));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn android_borrowed_runner_forward_that_cannot_be_parsed_is_not_absent() {
    let repo = common::temp_repo();
    let record = borrowed_record(&repo);
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    record.save(&repo).unwrap();
    let mut mock = borrowed_mock();
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run(
        "reverse --remove tcp:8791",
        CmdOutput::failed(1, "adb: error: listener 'tcp:8791' not found"),
    );
    let odd = "emulator-5554 localabstract:runner tcp:22089\n";
    mock.expect_run("forward --list", CmdOutput::success(odd));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );
    mock.expect_run("am force-stop", CmdOutput::success(""));
    mock.expect_run("am force-stop", CmdOutput::success(""));
    mock.expect_run("forward --list", CmdOutput::success(odd));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );

    let receipt = cleanup(&mut mock, &repo, "borrowed-run");

    assert!(receipt.cleanup["android_runner"].starts_with("unresolved"));
    assert!(lock.exists());
    assert_eq!(mock.remaining(), 0);
}

fn script_borrowed_recorder_release(mock: &mut MockRunner) {
    mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
    mock.expect_run("reverse --remove tcp:8791", CmdOutput::success(""));
    mock.expect_run("reverse --list", CmdOutput::success(""));
    mock.expect_run("forward --list", CmdOutput::success("\n"));
    mock.expect_run(
        "dumpsys activity processes",
        CmdOutput::success(NO_RUNNER_PROCESS),
    );
}

#[test]
fn dead_owner_android_recorder_is_reclaimed_before_borrowed_release_and_keeps_lease_on_failure() {
    use qaren::runrecord::{RecorderKind, RecorderResource};
    for failure in ["none", "pull", "rm", "changed", "probe"] {
        let repo = common::temp_repo();
        let mut record = borrowed_record(&repo);
        record.resources.core = None;
        let media = RunRecord::run_dir(&repo, &record.run_id).join("media");
        std::fs::create_dir_all(&media).unwrap();
        // The scripted successful pull supplies these bytes, without prior completion evidence.
        std::fs::write(media.join("raw.mp4"), "complete recording").unwrap();
        let path = format!("/data/local/tmp/qaren-{}.mp4", record.run_id);
        record.resources.recorder = Some(RecorderResource {
            pid: Some(7100),
            birth: Some(common::identity(7100, LSTART)),
            pulled_sha256: None,
            kind: RecorderKind::AndroidEmulator,
            device: BORROWED.into(),
            output: path.clone().into(),
        });
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        mock.adb_servers.push((5037, 41));
        owner_gone(&mut mock);
        mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
        mock.expect_run("shell pkill -INT -f", CmdOutput::success(""));
        mock.expect_run(
            "shell pgrep -f",
            if failure == "probe" {
                CmdOutput::failed(2, "unknown")
            } else {
                CmdOutput::failed(1, "")
            },
        );
        if failure != "probe" {
            mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
            mock.expect_run(
                "pull",
                if failure == "pull" {
                    CmdOutput::failed(1, "Permission denied")
                } else {
                    CmdOutput::success("")
                },
            );
            if failure != "pull" {
                mock.expect_run(
                    "shell rm -f",
                    if matches!(failure, "rm" | "changed") {
                        CmdOutput::failed(1, "Permission denied")
                    } else {
                        CmdOutput::success("")
                    },
                );
            }
        }
        script_borrowed_recorder_release(&mut mock);
        let receipt = cleanup(&mut mock, &repo, "borrowed-run");
        assert_eq!(mock.remaining(), 0, "{failure}");
        let position = |label: &str| {
            mock.calls
                .iter()
                .position(|call| call.label == label)
                .unwrap()
        };
        assert!(position("adb-device-pkill") < position("adb-reverse-remove"));
        if failure == "none" {
            assert!(position("adb-rm") < position("adb-reverse-remove"));
            assert_eq!(receipt.cleanup["recorder"], "removed");
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert!(!lock.exists());
            assert!(RunRecord::load(&repo, "borrowed-run")
                .unwrap()
                .resources
                .recorder
                .is_none());
        } else {
            assert!(
                receipt.cleanup["recorder"].starts_with("unresolved:"),
                "{failure}: {:?}",
                receipt.cleanup
            );
            assert!(receipt.cleanup["device_lease"].contains("recorder"));
            assert!(lock.exists());
            assert!(RunRecord::load(&repo, "borrowed-run")
                .unwrap()
                .resources
                .recorder
                .is_some());
            if failure == "pull" {
                assert!(receipt.cleanup["recorder"].contains(&path));
                assert!(!mock.calls.iter().any(|call| call.label == "adb-rm"));
            }
            if failure == "changed" {
                // A partial/replaced file is not the successfully pulled recording.
                std::fs::write(media.join("raw.mp4"), "partial recording").unwrap();
            }
            let mut retry = MockRunner::new();
            retry.adb_servers.push((5037, 41));
            owner_gone(&mut retry);
            retry.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
            retry.expect_run("shell pkill -INT -f", CmdOutput::failed(1, ""));
            retry.expect_run("shell pgrep -f", CmdOutput::failed(1, ""));
            retry.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
            if failure != "rm" {
                retry.expect_run("pull", CmdOutput::success(""));
            }
            retry.expect_run("shell rm -f", CmdOutput::success(""));
            script_borrowed_recorder_release(&mut retry);
            let recovered = cleanup(&mut retry, &repo, "borrowed-run");
            assert_eq!(recovered.cleanup["recorder"], "removed");
            assert_eq!(recovered.cleanup["device_lease"], "removed");
            assert!(!lock.exists());
            assert_eq!(retry.remaining(), 0);
        }
    }
}

// Model successful pull/rm at the device boundary, then interrupt only local retirement.
struct RecorderRetirementRunner {
    mock: MockRunner,
    record_path: std::path::PathBuf,
    device_media: bool,
    interrupt: Option<bool>,
}

impl qaren::exec::Runner for RecorderRetirementRunner {
    fn execute(&mut self, spec: &qaren::exec::CmdSpec, interruptible: bool) -> CmdOutput {
        if spec.label == "adb-pull" {
            self.mock.calls.push(spec.clone());
            let raw = spec.args.last().unwrap();
            if !self.device_media {
                return CmdOutput::failed(1, "remote file does not exist");
            }
            std::fs::write(raw, "complete recording").unwrap();
            return CmdOutput::success("");
        }
        let output = if spec.label == "adb-rm" {
            self.mock.calls.push(spec.clone());
            CmdOutput::success("")
        } else {
            self.mock.execute(spec, interruptible)
        };
        if spec.label == "adb-rm" && output.ok() {
            self.device_media = false;
            if let Some(crash) = self.interrupt.take() {
                if crash {
                    panic!("interrupted after successful device rm");
                }
                std::fs::create_dir(
                    self.record_path
                        .parent()
                        .unwrap()
                        .join(format!(".run.json.tmp.{}", std::process::id())),
                )
                .unwrap();
            }
        }
        output
    }
    fn adb_server_version(&self, port: u16) -> Result<u32, String> {
        self.mock.adb_server_version(port)
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::Spawned> {
        self.mock.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        self.mock.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.mock.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
}

#[test]
fn android_recorder_cleanup_recovers_after_device_rm_before_retirement_is_saved() {
    for crash in [true, false] {
        let repo = common::temp_repo();
        let mut record = borrowed_record(&repo);
        record.resources.core = None;
        record.resources.recorder = Some(qaren::runrecord::RecorderResource {
            pid: None,
            birth: None,
            pulled_sha256: None,
            kind: qaren::runrecord::RecorderKind::AndroidEmulator,
            device: BORROWED.into(),
            output: "/data/local/tmp/qaren-borrowed-run.mp4".into(),
        });
        record.save(&repo).unwrap();
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        let mut mock = MockRunner::new();
        mock.adb_servers.push((5037, 41));
        mock.expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
        mock.expect_run("shell pkill -INT", CmdOutput::success(""));
        mock.expect_run("shell pgrep", CmdOutput::failed(1, ""));
        let mut runner = RecorderRetirementRunner {
            mock,
            record_path: RunRecord::path(&repo, &record.run_id),
            device_media: true,
            interrupt: Some(crash),
        };
        let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            qaren::record::stop(&mut runner, &mut record, &repo)
        }));
        if crash {
            assert!(stopped.is_err());
        } else {
            assert_eq!(
                stopped.unwrap(),
                qaren::commands::cleanup::Outcome::Unresolved(
                    "recorder retirement was not persisted".into()
                )
            );
            std::fs::remove_dir(
                runner
                    .record_path
                    .parent()
                    .unwrap()
                    .join(format!(".run.json.tmp.{}", std::process::id())),
            )
            .unwrap();
        }
        assert!(!runner.device_media);
        assert!(lock.exists());
        assert!(RunRecord::load(&repo, "borrowed-run")
            .unwrap()
            .resources
            .recorder
            .is_some());
        assert_eq!(runner.mock.remaining(), 0);
        runner.mock.calls.clear();
        owner_gone(&mut runner.mock);
        runner
            .mock
            .expect_run("adb version", CmdOutput::success(ADB_CLIENT_41));
        runner
            .mock
            .expect_run("shell pkill -INT", CmdOutput::failed(1, ""));
        runner
            .mock
            .expect_run("shell pgrep", CmdOutput::failed(1, ""));
        script_borrowed_recorder_release(&mut runner.mock);
        let receipt = cleanup(&mut runner, &repo, "borrowed-run");
        assert_eq!(
            receipt.cleanup["recorder"], "removed",
            "{crash}: {:?}",
            receipt.cleanup
        );
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!lock.exists());
        assert!(!runner.mock.calls.iter().any(|c| c.label == "adb-pull"));
        assert_eq!(runner.mock.remaining(), 0);
        assert_eq!(
            std::fs::read(runner.record_path.parent().unwrap().join("media/raw.mp4")).unwrap(),
            b"complete recording"
        );
    }
}

const BORROWED_IOS_UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const BORROWED_IOS_OTHER_UDID: &str = "76709EFC-0104-4A66-8908-F4F85A76F025";
const BORROWED_IOS_RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const BORROWED_IOS_TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";

fn borrowed_ios_inventory(state: &str) -> String {
    serde_json::json!({
        "devices": {
            BORROWED_IOS_RUNTIME: [
                {
                    "udid": BORROWED_IOS_UDID,
                    "name": "qa-company-app",
                    "state": state,
                    "isAvailable": true,
                    "deviceTypeIdentifier": BORROWED_IOS_TYPE
                },
                {
                    "udid": BORROWED_IOS_OTHER_UDID,
                    "name": "other",
                    "state": "Booted",
                    "isAvailable": true,
                    "deviceTypeIdentifier": BORROWED_IOS_TYPE
                }
            ]
        }
    })
    .to_string()
}

fn borrowed_ios_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::ios_scenario_yaml(8791),
        "borrowed-ios-run",
        Phase::Ready,
    );
    record.scenario.ios = Some(qaren::scenario::IosSpec {
        device_type: BORROWED_IOS_TYPE.into(),
        runtime: BORROWED_IOS_RUNTIME.into(),
        max_devices: None,
    });
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: BORROWED_IOS_UDID.into(),
        name: "qa-company-app".into(),
        device_type: BORROWED_IOS_TYPE.into(),
        runtime: BORROWED_IOS_RUNTIME.into(),
    });
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &repo.join("locks"),
            qaren::scenario::Platform::Ios,
            BORROWED_IOS_UDID,
            "borrowed-ios-run",
            None,
        )
        .unwrap(),
    );
    record
}

fn script_borrowed_ios_admission(mock: &mut MockRunner, status: &str) {
    let exit_code = if status == "clear" { Some(0) } else { Some(4) };
    mock.expect_run(
        &format!("fresh-install-preflight.js --platform ios --device {BORROWED_IOS_UDID}"),
        CmdOutput {
            exit_code,
            stdout: serde_json::json!({
                "v": 1,
                "platform": "ios",
                "deviceId": BORROWED_IOS_UDID,
                "status": status
            })
            .to_string(),
            ..Default::default()
        },
    );
}

#[test]
fn pending_borrowed_ios_stop_refuses_build_cleanup_without_owner_death_or_save() {
    for owner_case in ["alive", "unknown", "missing"] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        record.resources.begin_build().unwrap();
        record
            .resources
            .record_build_spawned(5000, Some(common::identity(5000, LSTART)))
            .unwrap();
        if owner_case == "missing" {
            record.prepare = None;
        }
        record.save(&repo).unwrap();
        let before = std::fs::read(RunRecord::path(&repo, "borrowed-ios-run")).unwrap();
        let mut mock = MockRunner::new();
        match owner_case {
            "alive" => {
                mock.expect_run(
                    "ps -p 999 -o lstart=",
                    CmdOutput::success("Wed Aug 12 15:00:00 2026"),
                );
                mock.expect_run("ps -p 999 -o stat=", CmdOutput::success("S"));
            }
            "unknown" => {
                mock.expect_run("ps -p 999 -o lstart=", CmdOutput::failed(1, "ps denied"));
            }
            _ => {}
        }
        let receipt = cleanup(&mut mock, &repo, "borrowed-ios-run");
        assert_eq!(receipt.result, ReceiptResult::Refused, "{owner_case}");
        assert_eq!(
            std::fs::read(RunRecord::path(&repo, "borrowed-ios-run")).unwrap(),
            before,
            "{owner_case}"
        );
        let stored = RunRecord::load(&repo, "borrowed-ios-run").unwrap();
        assert!(stored.resources.build_process().is_some());
        assert!(stored.resources.lease.as_ref().unwrap().lock_dir.exists());
        assert!(!receipt.outcomes.contains_key("record_saved"));
        assert_eq!(
            mock.calls.len(),
            match owner_case {
                "alive" => 2,
                "unknown" => 1,
                _ => 0,
            }
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn borrowed_ios_stop_in_cleanup_enforces_owner_lease_quiescence_admission_and_idempotence() {
    use qaren::commands::cleanup::cleanup_with_runtime;
    use qaren::runrecord::BorrowedIosStop;
    let node = std::path::Path::new("/usr/local/bin/node");
    let runtime = std::path::Path::new("/runtime");

    // 1. Default NotArmed borrowed record keeps simulator and releases lease without admission or shutdown.
    {
        let repo = common::temp_repo();
        let record = borrowed_ios_record(&repo);
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        let receipt = cleanup(&mut mock, &repo, "borrowed-ios-run");
        assert_eq!(receipt.result, ReceiptResult::Cleaned);
        assert_eq!(receipt.cleanup["simulator"], "kept");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!lock.exists());
        assert_eq!(mock.calls.len(), 1);
    }

    // 2. Completed record never re-runs admission or shutdown even if the simulator is later Booted.
    {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        record
            .resources
            .complete_borrowed_ios_stop(BORROWED_IOS_UDID)
            .unwrap();
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        let receipt = cleanup_with_runtime(
            &mut mock,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(receipt.result, ReceiptResult::Cleaned);
        assert_eq!(receipt.cleanup["simulator"], "absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert!(!lock.exists());
        assert_eq!(mock.calls.len(), 1);
    }

    // 3. Live or unknown owner refuses without touching the simulator or releasing the lease.
    for owner_case in ["alive", "unknown_ps", "missing_prepare"] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        if owner_case == "missing_prepare" {
            record.prepare = None;
        }
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        match owner_case {
            "alive" => {
                mock.expect_run(
                    "ps -p 999 -o lstart=",
                    CmdOutput::success("Wed Aug 12 15:00:00 2026\n"),
                );
                mock.expect_run("ps -p 999 -o stat=", CmdOutput::success("S\n"));
            }
            "unknown_ps" => {
                mock.expect_run("ps -p 999 -o lstart=", CmdOutput::failed(1, "ps denied"));
            }
            "missing_prepare" => {}
            _ => unreachable!(),
        }
        let receipt = cleanup_with_runtime(
            &mut mock,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(receipt.result, ReceiptResult::Refused, "{owner_case}");
        if owner_case != "alive" {
            assert!(
                receipt.cleanup["simulator"].starts_with("refused:"),
                "{owner_case}: {:?}",
                receipt.cleanup
            );
        }
        assert!(lock.exists(), "{owner_case}");
        assert_eq!(
            RunRecord::load(&repo, "borrowed-ios-run")
                .unwrap()
                .resources
                .borrowed_ios_stop(),
            BorrowedIosStop::Pending,
            "{owner_case}"
        );
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "fresh-install-admission" | "simctl-shutdown"
        )));
        assert_eq!(mock.remaining(), 0, "{owner_case}");
    }

    // 4. Missing or foreign lease refuses without calling admission or shutdown.
    for lease_case in ["missing_lock", "foreign_holder"] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        if lease_case == "missing_lock" {
            std::fs::remove_dir_all(&lock).unwrap();
        } else {
            qaren::buildplan::save_json(
                &lock.join("holder.json"),
                &qaren::buildplan::LockHolder {
                    holder: "qaren-other".into(),
                    run_id: "other-run".into(),
                    identity: None,
                    at: "now".into(),
                    home: None,
                    qaren_home: None,
                    group: None,
                },
            )
            .unwrap();
        }
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        let receipt = cleanup_with_runtime(
            &mut mock,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(receipt.result, ReceiptResult::Refused, "{lease_case}");
        assert!(receipt.cleanup["simulator"].starts_with("refused:"));
        assert_eq!(
            RunRecord::load(&repo, "borrowed-ios-run")
                .unwrap()
                .resources
                .borrowed_ios_stop(),
            BorrowedIosStop::Pending
        );
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "fresh-install-admission" | "simctl-shutdown"
        )));
        assert_eq!(mock.remaining(), 0);
    }

    // 5. Surviving build, core, driver, host, or recorder retains pending stop and lease without shutting down.
    for blocker in [
        "build_pending",
        "core_alive",
        "runner_driver_unproven",
        "runner_host_present",
        "recorder_unproven",
    ] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        let mut mock = MockRunner::new();
        match blocker {
            "build_pending" => {
                record.resources.begin_build().unwrap();
                owner_gone(&mut mock);
            }
            "core_alive" => {
                record.phase = Phase::Walking;
                record.resources.core = Some(qaren::runrecord::CoreResource {
                    pgid: 9000,
                    identity: Some(common::identity(9000, LSTART)),
                });
                owner_gone(&mut mock);
                mock.expect_run("ps -A", CmdOutput::failed(1, "inventory denied"));
            }
            "runner_driver_unproven" => {
                record
                    .resources
                    .runner_drivers
                    .push(qaren::runrecord::RunnerDriverResource {
                        pgid: 7000,
                        identity: common::identity(7000, LSTART),
                    });
                owner_gone(&mut mock);
                mock.expect_run("ps -A", CmdOutput::failed(1, "inventory denied"));
            }
            "recorder_unproven" => {
                record.resources.recorder = Some(qaren::runrecord::RecorderResource {
                    pid: None,
                    birth: None,
                    pulled_sha256: None,
                    kind: qaren::runrecord::RecorderKind::IosSimulator,
                    device: BORROWED_IOS_UDID.into(),
                    output: repo.join("clip.mov"),
                });
                owner_gone(&mut mock);
            }
            "runner_host_present" => {
                owner_gone(&mut mock);
                record.phase = Phase::Walking;
                record.resources.core_cleanup = Some(qaren::runrecord::CoreCleanupEvidence {
                    run_id: "borrowed-ios-run".into(),
                    pgid: 9000,
                    at: "2026-08-12T16:05:00Z".into(),
                    outcome: qaren::runrecord::GroupCleanupResult::Absent,
                });
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl spawn {BORROWED_IOS_UDID} launchctl list"),
                    CmdOutput::success(
                        "PID Status Label\n42 0 UIKitApplication:dev.lykhoyda.rndevagent.fastrunner[abc][rb-legacy]\n",
                    ),
                );
            }
            _ => unreachable!(),
        }
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let receipt = cleanup_with_runtime(
            &mut mock,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(
            receipt.result,
            if blocker == "core_alive" {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Failed
            },
            "{blocker}"
        );
        assert!(
            receipt.cleanup["simulator"].starts_with("unresolved:"),
            "{blocker}: {}",
            receipt.cleanup["simulator"]
        );
        assert!(
            receipt.cleanup["device_lease"].starts_with("unresolved: retained:"),
            "{blocker}: {}",
            receipt.cleanup["device_lease"]
        );
        assert!(lock.exists(), "{blocker}");
        assert_eq!(
            RunRecord::load(&repo, "borrowed-ios-run")
                .unwrap()
                .resources
                .borrowed_ios_stop(),
            BorrowedIosStop::Pending,
            "{blocker}"
        );
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "fresh-install-admission" | "simctl-shutdown"
        )));
        assert_eq!(mock.remaining(), 0, "{blocker}");
    }

    // Missing candidate directory or runtime context stays unresolved and issues no shutdown.
    for gap in ["missing_directory", "empty_runtime"] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        if gap == "missing_directory" {
            record.candidate.project_root = repo.join("missing-app");
        }
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        let runtime_context = if gap == "empty_runtime" {
            Some((std::path::Path::new(""), runtime))
        } else {
            Some((node, runtime))
        };
        let receipt =
            cleanup_with_runtime(&mut mock, &repo, "borrowed-ios-run", None, runtime_context);
        assert_eq!(receipt.result, ReceiptResult::Failed, "{gap}");
        assert!(
            receipt.cleanup["simulator"].starts_with("unresolved:"),
            "{gap}: {}",
            receipt.cleanup["simulator"]
        );
        assert!(lock.exists(), "{gap}");
        assert_eq!(
            RunRecord::load(&repo, "borrowed-ios-run")
                .unwrap()
                .resources
                .borrowed_ios_stop(),
            BorrowedIosStop::Pending,
            "{gap}"
        );
        assert!(!mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "fresh-install-admission" | "simctl-shutdown"
        )));
        assert_eq!(mock.remaining(), 0, "{gap}");
    }

    // 6. Strict admission failure, shutdown failure, readback failure, or save failure retains pending + lease + pr_worktree, then recovers cleanly on retry.
    for fault in [
        "admission_busy",
        "admission_unknown",
        "shutdown_failed",
        "readback_booted",
        "save_failed",
    ] {
        let repo = common::temp_repo();
        let mut record = borrowed_ios_record(&repo);
        record.resources.arm_borrowed_ios_stop().unwrap();
        let wt = RunRecord::run_dir(&repo, "borrowed-ios-run").join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        record.resources.pr_worktree = Some(qaren::runrecord::PrWorktreeResource {
            repo_root: repo.clone(),
            path: wt.clone(),
        });
        let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
        record.save(&repo).unwrap();
        let blocked_save = RunRecord::run_dir(&repo, "borrowed-ios-run")
            .join(format!(".run.json.tmp.{}", std::process::id()));

        let mut mock = MockRunner::new();
        owner_gone(&mut mock);
        match fault {
            "admission_busy" => script_borrowed_ios_admission(&mut mock, "busy"),
            "admission_unknown" => script_borrowed_ios_admission(&mut mock, "unknown"),
            "shutdown_failed" => {
                script_borrowed_ios_admission(&mut mock, "clear");
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {BORROWED_IOS_UDID}"),
                    CmdOutput::failed(1, "shutdown failed"),
                );
            }
            "readback_booted" => {
                script_borrowed_ios_admission(&mut mock, "clear");
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {BORROWED_IOS_UDID}"),
                    CmdOutput::success(""),
                );
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Booted")),
                );
            }
            "save_failed" => {
                std::fs::create_dir(&blocked_save).unwrap();
                script_borrowed_ios_admission(&mut mock, "clear");
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Booted")),
                );
                mock.expect_run(
                    &format!("simctl shutdown {BORROWED_IOS_UDID}"),
                    CmdOutput::success(""),
                );
                mock.expect_run(
                    "simctl list devices -j",
                    CmdOutput::success(&borrowed_ios_inventory("Shutdown")),
                );
            }
            _ => unreachable!(),
        }
        let receipt = cleanup_with_runtime(
            &mut mock,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(receipt.result, ReceiptResult::Failed, "{fault}");
        assert!(
            receipt.cleanup["simulator"].starts_with("unresolved:"),
            "{fault}: {}",
            receipt.cleanup["simulator"]
        );
        assert!(
            receipt.cleanup["device_lease"].starts_with("unresolved: retained: simulator"),
            "{fault}: {}",
            receipt.cleanup["device_lease"]
        );
        assert!(
            receipt.cleanup["pr_worktree"].starts_with("unresolved:")
                && receipt.cleanup["pr_worktree"].contains("retained"),
            "{fault}: {}",
            receipt.cleanup["pr_worktree"]
        );
        assert!(lock.exists(), "{fault}");
        assert!(wt.exists(), "{fault}");
        assert_eq!(
            RunRecord::load(&repo, "borrowed-ios-run")
                .unwrap()
                .resources
                .borrowed_ios_stop(),
            BorrowedIosStop::Pending,
            "{fault}"
        );
        assert_eq!(mock.remaining(), 0, "{fault}");
        if fault == "save_failed" {
            std::fs::remove_dir(&blocked_save).unwrap();
        }

        // Retry succeeds (testing both Booted -> ShutDown and AlreadyShutdown recovery).
        let mut retry = MockRunner::new();
        owner_gone(&mut retry);
        script_borrowed_ios_admission(&mut retry, "clear");
        let already_shutdown = fault == "save_failed";
        retry.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&borrowed_ios_inventory(if already_shutdown {
                "Shutdown"
            } else {
                "Booted"
            })),
        );
        if !already_shutdown {
            retry.expect_run(
                &format!("simctl shutdown {BORROWED_IOS_UDID}"),
                CmdOutput::success(""),
            );
            retry.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&borrowed_ios_inventory("Shutdown")),
            );
        }
        std::fs::remove_dir_all(&wt).unwrap();
        retry.expect_run("worktree prune", CmdOutput::success(""));
        let recovered = cleanup_with_runtime(
            &mut retry,
            &repo,
            "borrowed-ios-run",
            None,
            Some((node, runtime)),
        );
        assert_eq!(
            recovered.result,
            ReceiptResult::Cleaned,
            "{fault}: {:?}",
            recovered.failure
        );
        assert_eq!(
            recovered.cleanup["simulator"],
            if already_shutdown {
                "absent"
            } else {
                "removed"
            },
            "{fault}"
        );
        assert_eq!(recovered.cleanup["device_lease"], "removed", "{fault}");
        assert_eq!(recovered.cleanup["pr_worktree"], "absent", "{fault}");
        assert!(!lock.exists(), "{fault}");
        let stored = RunRecord::load(&repo, "borrowed-ios-run").unwrap();
        assert_eq!(
            stored.resources.borrowed_ios_stop(),
            BorrowedIosStop::Completed
        );
        assert!(stored.resources.lease.is_none());
        assert!(stored.resources.pr_worktree.is_none());
        assert_eq!(retry.remaining(), 0, "{fault}");
    }
}

#[test]
fn crashed_pool_creation_deletes_the_owned_simulator_and_releases_the_creation_lock() {
    let repo = common::temp_repo();
    let run_id = "pool-crash-run";
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        run_id,
        Phase::Failed,
    );
    let name = format!("qaren-pool-{run_id}");
    record.resources.ios_simulator = Some(IosSimResource {
        udid: BORROWED_IOS_UDID.into(),
        name: name.clone(),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".into(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4".into(),
    });
    let lease = qaren::lease::acquire(
        &mut MockRunner::new(),
        &repo.join("locks"),
        qaren::scenario::Platform::Ios,
        BORROWED_IOS_UDID,
        run_id,
        None,
    )
    .unwrap();
    record.resources.lease = Some(lease.clone());
    let holder = qaren::buildplan::LockHolder {
        holder: format!("qaren-{run_id}"),
        run_id: run_id.into(),
        identity: None,
        at: "2026-10-22T00:00:00Z".into(),
        home: None,
        qaren_home: None,
        group: None,
    };
    let pool_root = repo.join(".pool");
    assert!(matches!(
        qaren::buildplan::claim_lock(
            &mut MockRunner::new(),
            &pool_root,
            "create-ios",
            &holder,
            qaren::buildplan::LockPolicy::Strict,
        ),
        qaren::buildplan::LockOutcome::Claimed { .. }
    ));
    record.resources.pool_create_lock = Some(qaren::runrecord::BuildLockResource {
        lock_dir: pool_root.join("create-ios"),
        holder: holder.holder.clone(),
    });
    record.save(&repo).unwrap();
    let inventory =
        serde_json::json!({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-4": [{
            "udid": BORROWED_IOS_UDID, "name": name, "state": "Shutdown", "isAvailable": true,
            "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
        }]}})
        .to_string();

    let mut mock = MockRunner::new();
    owner_gone(&mut mock);
    mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
    mock.expect_run(
        &format!("simctl delete {BORROWED_IOS_UDID}"),
        CmdOutput::success(""),
    );
    let receipt = cleanup(&mut mock, &repo, run_id);

    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{}",
        receipt.to_json()
    );
    assert!(receipt.cleanup["simulator"].starts_with("removed"));
    assert_eq!(receipt.cleanup["pool_create_lock"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    assert!(!pool_root.join("create-ios").exists());
    assert!(!lease.lock_dir.exists());
}

#[test]
fn cleanup_never_releases_the_pool_creation_lock_of_a_live_creator() {
    // Lock claimed before the pending simulator is recorded, and after it.
    for pending_simulator in [false, true] {
        let repo = common::temp_repo();
        let run_id = "pool-creating-run";
        let mut record = common::base_record(
            &repo,
            &common::ios_scenario_yaml(8791),
            run_id,
            Phase::DepsInstalled,
        );
        if pending_simulator {
            record.resources.ios_simulator = Some(IosSimResource {
                udid: String::new(),
                name: format!("qaren-pool-{run_id}"),
                device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".into(),
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4".into(),
            });
        }
        let holder = qaren::buildplan::LockHolder {
            holder: format!("qaren-{run_id}"),
            run_id: run_id.into(),
            identity: None,
            at: "2026-10-27T00:00:00Z".into(),
            home: None,
            qaren_home: None,
            group: None,
        };
        let pool_root = repo.join(".pool");
        assert!(matches!(
            qaren::buildplan::claim_lock(
                &mut MockRunner::new(),
                &pool_root,
                "create-ios",
                &holder,
                qaren::buildplan::LockPolicy::Strict,
            ),
            qaren::buildplan::LockOutcome::Claimed { .. }
        ));
        record.resources.pool_create_lock = Some(qaren::runrecord::BuildLockResource {
            lock_dir: pool_root.join("create-ios"),
            holder: holder.holder.clone(),
        });
        record.save(&repo).unwrap();
        let before = std::fs::read(RunRecord::path(&repo, run_id)).unwrap();

        let mut mock = MockRunner::new();
        mock.expect_run(
            "ps -p 999 -o lstart=",
            CmdOutput::success("Wed Aug 12 15:00:00 2026"),
        );
        mock.expect_run("ps -p 999 -o stat=", CmdOutput::success("S"));
        let receipt = cleanup(&mut mock, &repo, run_id);

        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "pending_simulator={pending_simulator}: {}",
            receipt.to_json()
        );
        assert_eq!(mock.remaining(), 0, "pending_simulator={pending_simulator}");
        assert!(
            !mock.calls.iter().any(|c| c.rendered().contains("simctl")),
            "pending_simulator={pending_simulator}"
        );
        assert_eq!(
            qaren::buildplan::read_holder(&pool_root.join("create-ios"))
                .unwrap()
                .run_id,
            run_id,
            "pending_simulator={pending_simulator}"
        );
        assert_eq!(
            std::fs::read(RunRecord::path(&repo, run_id)).unwrap(),
            before,
            "pending_simulator={pending_simulator}"
        );
    }
}
