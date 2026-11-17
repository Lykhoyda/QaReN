mod common;
use qaren::buildplan::{claim_lock, LockHolder, LockOutcome, LockPolicy};
use qaren::commands::cleanup::{cleanup_deps_cache, cleanup_with_orphan_locks};
use qaren::exec::CmdOutput;
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::Phase;

fn process() -> String {
    format!("4242 1 {} 960.0 S Sun Nov 15 12:34:56 2026 netsimd /sdk/emulator/netsimd --private-canary\n", unsafe { libc::geteuid() })
}
fn cleanup_case(kind: &str) {
    let repo = common::temp_repo();
    let locks = repo.join("locks");
    let runs = repo.join("runs");
    let mut expected = None;
    for with_helper in [false, true] {
        let mut inner = common::IosBuildRunner::new();
        if kind == "normal" {
            let mut record = common::base_record(
                &repo,
                &common::ios_scenario_yaml(8791),
                "old-run",
                Phase::Cleaned,
            );
            record.prepare = None;
            record.save(&runs).unwrap();
        } else if kind == "orphan-lock" {
            let home = repo.join("holder-home");
            std::fs::create_dir_all(home.join(".qaren/runs")).unwrap();
            let holder = LockHolder {
                holder: "qaren-old-run".into(),
                run_id: "old-run".into(),
                identity: Some(common::identity(777, "Sun Nov 15 12:34:56 2026")),
                at: "2026-11-15T12:34:56Z".into(),
                home: Some(home),
                qaren_home: None,
                group: None,
            };
            assert!(matches!(
                claim_lock(
                    &mut inner,
                    &locks,
                    "native-build-ios",
                    &holder,
                    LockPolicy::Strict
                ),
                LockOutcome::Claimed { .. }
            ));
            inner.expect_run("ps -p 777 -o lstart=", CmdOutput::failed(1, ""));
        }
        let mut runner = common::host::HostRunner::new(inner);
        runner.processes = Some(if with_helper {
            process()
        } else {
            "2 1 0 0.0 S Sun Nov 15 12:34:56 2026 idle /idle\n".into()
        });
        let receipt = cleanup_with_orphan_locks(&mut runner, &runs, Some(&locks), "old-run", None);
        let result = (
            receipt.result.clone(),
            receipt.next_action.clone(),
            receipt.failure.as_ref().map(|f| f.code),
        );
        if let Some(expected) = &expected {
            assert_eq!(&result, expected);
        } else {
            expected = Some(result);
        }
        assert_eq!(
            receipt.result,
            if kind == "missing" {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Cleaned
            }
        );
        assert_eq!(runner.inner.remaining(), 0);
        if with_helper {
            let note = serde_json::to_value(&receipt.device_helpers).unwrap();
            assert_eq!(note[0]["outcome"], "stopped-term");
            assert_eq!(note[0]["signals"], serde_json::json!(["TERM"]));
            assert_eq!(receipt.commands_executed, runner.calls.len() as u64);
            assert_eq!(
                runner
                    .calls
                    .iter()
                    .filter(|c| matches!(
                        c.label.as_str(),
                        "device-helpers" | "device-helper-signal"
                    ))
                    .count(),
                5
            );
            assert!(!receipt.to_json().contains("private-canary"));
        } else {
            assert!(receipt.device_helpers.is_empty());
        }
    }
}
#[test]
fn i2_cleanup_normal_return_records_helpers() {
    cleanup_case("normal");
}
#[test]
fn i2_cleanup_orphan_lock_return_records_helpers() {
    cleanup_case("orphan-lock");
}
#[test]
fn i2_cleanup_missing_return_records_helpers() {
    cleanup_case("missing");
}
#[test]
fn i2_dependency_cache_cleanup_never_reads_helpers() {
    let repo = common::temp_repo();
    let mut runner = common::host::HostRunner::new(common::IosBuildRunner::new());
    runner.processes = Some(process());
    let receipt = cleanup_deps_cache(&mut runner, &repo);
    assert!(receipt.device_helpers.is_empty());
    assert!(runner
        .calls
        .iter()
        .all(|c| !c.label.starts_with("device-helper")));
}
#[test]
fn i2_cleanup_confirmation_refusal_never_reads_helpers() {
    let repo = common::temp_repo();
    let runs = repo.join("runs");
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "old-run",
        Phase::Cleaned,
    );
    record.prepare = None;
    record.save(&runs).unwrap();
    let mut runner = common::host::HostRunner::new(common::IosBuildRunner::new());
    runner.processes = Some(process());
    let receipt = cleanup_with_orphan_locks(
        &mut runner,
        &runs,
        Some(&repo.join("locks")),
        "old-run",
        Some("old-run/emulator-5554/com.typo.app"),
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().map(|f| f.code),
        Some(FailureCode::AppRemovalNotConfirmed)
    );
    assert!(runner
        .calls
        .iter()
        .all(|c| !c.label.starts_with("device-helper")));
    assert!(receipt.device_helpers.is_empty());
    assert_eq!(receipt.commands_executed, 0);
}
