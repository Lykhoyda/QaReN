mod common;

use qaren::candidate::sha256_hex;
use qaren::commands::complete::complete;
use qaren::commands::prepare::{prepare, PrepareArgs};
use qaren::commands::{cleanup::cleanup, status::status};
use qaren::exec::{CmdOutput, MockRunner, Runner};
use qaren::failure::FailureCode;
use qaren::handoff::{app_root_key, worktree_key, ExpectedReceipt, HandoffDocument, HandoffState};
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{Phase, RunRecord};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";
const SERIAL: &str = "R5CR20XXYZ";

fn ios_handoff_yaml() -> String {
    "schema: qaren/1\nname: coop-ios\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n".to_string()
}

fn usb_handoff_yaml() -> String {
    format!(
        "schema: qaren/1\nname: coop-usb\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nandroid_usb:\n  serial: {SERIAL}\n"
    )
}

fn write_scenario(repo: &Path, yaml: &str) -> PathBuf {
    let path = repo.join("scenario.yaml");
    std::fs::write(&path, yaml).unwrap();
    path
}

fn prepare_args(scenario_path: &Path, android_home: Option<String>) -> PrepareArgs {
    PrepareArgs {
        scenario_path: scenario_path.to_path_buf(),
        dry_run: false,
        android_home,
        lock_root: scenario_path.parent().unwrap().join(".locks"),
        native_cache_root: scenario_path.parent().unwrap().join(".native-store"),
        native_cache_state_root: scenario_path.parent().unwrap().join(".runtime-state"),
        native_cache_mount_probe: common::fixture_mount,
        runs_root: scenario_path.parent().unwrap().to_path_buf(),
        device: None,
        boot_device: false,
        pool_root: scenario_path.parent().unwrap().join(".pool"),
        new_device: false,
    }
}

fn script_validation(mock: &mut MockRunner, repo: &Path, tools: &[&str]) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    for tool in tools {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
}

fn script_self_identity(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
}

fn script_candidate_recheck(mock: &mut MockRunner) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
}

const IOS_HANDOFF_TOOLS: &[&str] = &["git", "pnpm", "node", "ps", "xcrun"];
const USB_HANDOFF_TOOLS: &[&str] = &["git", "pnpm", "node", "ps"];

fn simctl_list_json(udid: &str, name: &str) -> String {
    serde_json::json!({"devices": {"rt": [{"udid": udid, "name": name, "state": "Booted"}]}})
        .to_string()
}

#[test]
fn ios_handoff_prepare_allocates_and_issues_typed_handoff_without_building() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_handoff_yaml());

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_HANDOFF_TOOLS);
    // No metro/adb port checks: handoff scenarios carry no qaren-owned ports.
    script_self_identity(&mut mock);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    script_candidate_recheck(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(receipt.phase, "handed_off");
    assert_eq!(mock.remaining(), 0);
    // qaren spawned nothing: no Metro, no build, no adb server.
    assert!(mock.spawned_logs.is_empty());
    assert_eq!(
        receipt.outcomes.get("handoff").map(String::as_str),
        Some("issued")
    );
    assert!(receipt.metro.is_none());
    assert!(receipt.build.is_none());
    assert!(receipt.next_action.contains("qaren complete"));

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::HandedOff);
    assert!(record.resources.metro.is_none());
    assert!(record.resources.build_lock.is_none());
    assert!(record.resources.adb_server.is_none());
    let sim = record.resources.ios_simulator.as_ref().unwrap();
    assert_eq!(sim.udid, UDID);

    let state = record.handoff.as_ref().unwrap();
    assert!(state.accepted.is_none() && state.completed_at.is_none());
    let raw = std::fs::read(qaren::handoff::document_path(&repo, &receipt.run_id)).unwrap();
    assert_eq!(sha256_hex(&raw), state.document_sha256);
    let doc: HandoffDocument = serde_json::from_slice(&raw).unwrap();
    assert_eq!(doc.schema, "qaren-handoff/1");
    assert_eq!(doc.run_id, receipt.run_id);
    assert_eq!(doc.platform, "ios");
    assert_eq!(doc.device.ios_udid.as_deref(), Some(UDID));
    assert!(doc.native_fingerprint.starts_with("rnfp1:"));
    assert_eq!(doc.expected_receipt.device_id, UDID);
    assert_eq!(doc.expected_receipt.app_id, "com.rndevagent.testapp");
    assert_eq!(doc.expected_receipt.worktree_key, worktree_key(&repo));
    assert_eq!(
        doc.expected_receipt.app_root_key,
        app_root_key(&repo, &repo.join("test-app")).unwrap()
    );
}

#[test]
fn usb_handoff_prepare_claims_lock_without_any_adb_contact() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &usb_handoff_yaml());

    let mut mock = MockRunner::new();
    // Base tools only: no java, and no ANDROID_HOME requirement.
    script_validation(&mut mock, &repo, USB_HANDOFF_TOOLS);
    script_self_identity(&mut mock);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    script_candidate_recheck(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(receipt.phase, "handed_off");
    assert_eq!(mock.remaining(), 0);
    assert!(mock.spawned_logs.is_empty());
    // No adb command ever ran: the session owns the adb lifecycle.
    assert!(mock.calls.iter().all(|c| !c.rendered().contains("adb")));

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    let usb = record.resources.usb_device.as_ref().unwrap();
    assert_eq!(usb.serial, SERIAL);
    assert!(usb.lock_dir.join("holder.json").is_file());
    assert!(record.resources.adb_server.is_none());
    assert!(record.resources.adb_path.is_none());
    let state = record.handoff.as_ref().unwrap();
    assert_eq!(state.expected.device_id, SERIAL);
    assert_eq!(state.expected.platform, "android");
}

#[test]
fn usb_handoff_prepare_refuses_contended_claim_without_adoption() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &usb_handoff_yaml());
    let lock_root = repo.join(".locks");
    let lock_dir = lock_root.join(format!("usb-{SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    std::fs::write(
        lock_dir.join("holder.json"),
        serde_json::to_vec(&json!({
            "holder": "qaren-other-run",
            "run_id": "other-run",
            "at": "2026-08-01T00:00:00Z"
        }))
        .unwrap(),
    )
    .unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, USB_HANDOFF_TOOLS);
    script_self_identity(&mut mock);
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, None));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::DeviceClaimContended
    );
    // The foreign claim survives untouched.
    assert!(lock_dir.join("holder.json").is_file());
}

fn receipt_payload(repo: &Path) -> serde_json::Value {
    receipt_payload_for_project(repo, Path::new("test-app"))
}

fn receipt_payload_for_project(repo: &Path, project_rel: &Path) -> serde_json::Value {
    json!({
        "sessionId": "SECRET-SESSION-ID",
        "sourceKey": "f".repeat(64),
        "worktreeKey": worktree_key(repo),
        "appRootKey": app_root_key(repo, &repo.join(project_rel)).unwrap(),
        "platform": "ios",
        "deviceId": UDID,
        "appId": "com.rndevagent.testapp",
        "metroPort": 8081,
        "artifactDigest": "d".repeat(64),
        "installGeneration": "gen-1",
        "buildGeneration": 3,
        "buildKind": "expo"
    })
}

fn receipt_line(payload: &serde_json::Value) -> String {
    json!({"version": 1, "payload": payload, "signature": "SECRET-HMAC-SIGNATURE"}).to_string()
}

// Seeds a handed-off run record (plus its handoff.json) exactly as
// prepare(owner: qaren) persists it.
fn seed_handoff_record(repo: &Path, run_id: &str) -> RunRecord {
    seed_handoff_record_for_project(repo, run_id, Path::new("test-app"))
}

fn seed_handoff_record_for_project(repo: &Path, run_id: &str, project_rel: &Path) -> RunRecord {
    let mut record = common::base_record(repo, &ios_handoff_yaml(), run_id, Phase::HandedOff);
    record.build = None;
    record.scenario.candidate.project_root = project_rel.to_string_lossy().into_owned();
    record.candidate.project_root = repo.join(project_rel);
    record.candidate.lockfile_sha256 = Some(sha256_hex(b"lockfileVersion: 9\n"));
    record.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
        udid: UDID.to_string(),
        name: format!("qaren-{run_id}"),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".to_string(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4".to_string(),
    });
    let expected = ExpectedReceipt {
        platform: "ios".to_string(),
        device_id: UDID.to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_key: worktree_key(repo),
        app_root_key: app_root_key(repo, &repo.join(project_rel)).unwrap(),
    };
    let document_path = qaren::handoff::document_path(repo, run_id);
    std::fs::create_dir_all(document_path.parent().unwrap()).unwrap();
    let document = HandoffDocument {
        schema: "qaren-handoff/1".to_string(),
        run_id: run_id.to_string(),
        issued_at: qaren::timefmt::iso8601_utc(MockRunner::new().now_epoch_ms()),
        candidate: record.candidate.clone(),
        platform: "ios".to_string(),
        device: qaren::commands::device_identity(&record),
        native_fingerprint: format!("rnfp1:{}", "e".repeat(64)),
        fingerprint_complete: true,
        fingerprint_incompleteness: Vec::new(),
        expected_receipt: expected.clone(),
    };
    let document_sha256 = qaren::handoff::save_document(&document_path, &document).unwrap();
    record.handoff = Some(HandoffState {
        document_sha256,
        expected,
        accepted: None,
        completed_at: None,
        evidence_sha256: None,
    });
    record.save(repo).unwrap();
    record
}

// The allocation-ownership probe complete runs before binding (iOS).
fn script_allocation_probe(mock: &mut MockRunner, run_id: &str) {
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&simctl_list_json(UDID, &format!("qaren-{run_id}"))),
    );
}

fn write_evidence(repo: &Path, name: &str, content: &str) -> PathBuf {
    let path = repo.join(name);
    std::fs::write(&path, content).unwrap();
    path
}

#[test]
fn complete_binds_matching_receipt_and_never_persists_signer_material() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-1");
    let evidence = write_evidence(
        &repo,
        "build.log",
        &format!(
            "noise before\n{}\nnoise after\n",
            receipt_line(&receipt_payload(&repo))
        ),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-1");
    script_candidate_recheck(&mut mock);
    let receipt = complete(&mut mock, &repo, "coop-1", &evidence);

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        receipt.outcomes.get("handoff").map(String::as_str),
        Some("completed")
    );

    let record = RunRecord::load(&repo, "coop-1").unwrap();
    let state = record.handoff.as_ref().unwrap();
    assert!(state.completed_at.is_some());
    let accepted = state.accepted.as_ref().unwrap();
    assert_eq!(accepted.device_id, UDID);
    assert_eq!(accepted.artifact_digest, "d".repeat(64));
    assert_eq!(accepted.build_generation, 3);

    // Signer material from the evidence must never reach the durable record.
    let raw = std::fs::read_to_string(RunRecord::path(&repo, "coop-1")).unwrap();
    assert!(!raw.contains("SECRET-SESSION-ID"));
    assert!(!raw.contains("SECRET-HMAC-SIGNATURE"));
    assert!(!raw.contains(&"f".repeat(64)));
}

#[test]
fn complete_accepts_at_the_handoff_deadline_boundary() {
    let repo = common::temp_repo();
    let mut record = seed_handoff_record(&repo, "coop-deadline-boundary");
    record.scenario.deadlines.build_seconds = 30;
    record.save(&repo).unwrap();
    let evidence = write_evidence(
        &repo,
        "boundary.log",
        &receipt_line(&receipt_payload(&repo)),
    );

    let mut mock = MockRunner::new();
    mock.sleep(Duration::from_secs(30));
    script_allocation_probe(&mut mock, "coop-deadline-boundary");
    script_candidate_recheck(&mut mock);
    let receipt = complete(&mut mock, &repo, "coop-deadline-boundary", &evidence);

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
}

#[test]
fn complete_retry_does_not_reset_the_handoff_deadline() {
    let repo = common::temp_repo();
    let mut record = seed_handoff_record(&repo, "coop-deadline-retry");
    record.scenario.deadlines.build_seconds = 30;
    record.save(&repo).unwrap();
    let incomplete = write_evidence(&repo, "incomplete.log", "build interrupted\n");
    let valid = write_evidence(&repo, "retry.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    mock.sleep(Duration::from_secs(29));
    let first = complete(&mut mock, &repo, "coop-deadline-retry", &incomplete);
    assert_eq!(first.result, ReceiptResult::Refused);
    assert_eq!(
        first.failure.as_ref().unwrap().code,
        FailureCode::HandoffEvidenceMissing
    );

    mock.sleep(Duration::from_secs(2));
    let retry = complete(&mut mock, &repo, "coop-deadline-retry", &valid);
    assert_eq!(retry.result, ReceiptResult::Refused);
    let failure = retry.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::ReadyDeadlineExceeded);
    assert!(failure.detail.contains("single 30s build window"));
    assert!(failure.detail.contains("retries do not reset"));
    assert!(mock.calls.is_empty());

    let record = RunRecord::load(&repo, "coop-deadline-retry").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn complete_refuses_double_adoption() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-2");
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-2");
    script_candidate_recheck(&mut mock);
    assert_eq!(
        complete(&mut mock, &repo, "coop-2", &evidence).result,
        ReceiptResult::Ready
    );

    // Second complete: refused, and the first binding survives unchanged.
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-2", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffNotPending
    );
}

#[test]
fn complete_refuses_runs_without_a_pending_handoff() {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "plain-ready",
        Phase::Ready,
    );
    record.save(&repo).unwrap();
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "plain-ready", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffNotPending
    );
}

#[test]
fn complete_refuses_missing_and_ambiguous_evidence() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-3");

    // Missing file.
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-3", &repo.join("absent.log"));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffEvidenceMissing
    );

    // A log with no receipt line.
    let no_receipt = write_evidence(&repo, "empty.log", "just build noise\n");
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-3", &no_receipt);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffEvidenceMissing
    );

    // Two conflicting receipt payloads.
    let mut other = receipt_payload(&repo);
    other["deviceId"] = json!("FFFFFFFF-9999-8888-7777-666655554444");
    let ambiguous = write_evidence(
        &repo,
        "two.log",
        &format!(
            "{}\n{}\n",
            receipt_line(&receipt_payload(&repo)),
            receipt_line(&other)
        ),
    );
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-3", &ambiguous);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffEvidenceAmbiguous
    );

    // Nothing was bound by any refusal.
    let record = RunRecord::load(&repo, "coop-3").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn complete_refuses_null_and_empty_receipt_signatures() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-signature");

    for (name, signature) in [("null", Value::Null), ("empty", json!(""))] {
        let envelope = json!({
            "version": 1,
            "payload": receipt_payload(&repo),
            "signature": signature,
        });
        let evidence = write_evidence(&repo, &format!("{name}.log"), &envelope.to_string());
        let mut mock = MockRunner::new();
        let receipt = complete(&mut mock, &repo, "coop-signature", &evidence);

        assert_eq!(receipt.result, ReceiptResult::Refused, "case {name}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::HandoffEvidenceMissing,
            "case {name}"
        );
        assert!(mock.calls.is_empty(), "case {name}");
    }

    let record = RunRecord::load(&repo, "coop-signature").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn complete_refuses_missing_signer_payload_identity() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-signer-identity");

    for (field, value) in [
        ("sessionId", None),
        ("sessionId", Some(json!(""))),
        ("sourceKey", None),
        ("sourceKey", Some(json!(""))),
    ] {
        let mut payload = receipt_payload(&repo);
        match value {
            Some(value) => payload[field] = value,
            None => {
                payload.as_object_mut().unwrap().remove(field);
            }
        }
        let evidence = write_evidence(
            &repo,
            &format!("missing-{field}.log"),
            &receipt_line(&payload),
        );
        let mut mock = MockRunner::new();
        let receipt = complete(&mut mock, &repo, "coop-signer-identity", &evidence);

        assert_eq!(receipt.result, ReceiptResult::Refused, "field {field}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::HandoffEvidenceMissing,
            "field {field}"
        );
        assert!(mock.calls.is_empty(), "field {field}");
    }
}

#[test]
fn complete_refuses_mismatched_and_foreign_receipts() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-4");

    let cases: Vec<(&str, serde_json::Value)> = vec![
        ("deviceId", json!("FFFFFFFF-9999-8888-7777-666655554444")),
        ("appId", json!("com.other.app")),
        ("platform", json!("android")),
        // Foreign: minted by a session bound to a different worktree/app.
        ("worktreeKey", json!("0".repeat(64))),
        ("appRootKey", json!("1".repeat(64))),
    ];
    for (field, value) in cases {
        let mut payload = receipt_payload(&repo);
        payload[field] = value;
        let evidence = write_evidence(&repo, "case.log", &receipt_line(&payload));
        let mut mock = MockRunner::new();
        let receipt = complete(&mut mock, &repo, "coop-4", &evidence);
        assert_eq!(receipt.result, ReceiptResult::Refused, "field {field}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::HandoffEvidenceMismatch,
            "field {field}"
        );
    }

    // A structurally incomplete receipt refuses as missing evidence.
    let mut payload = receipt_payload(&repo);
    payload.as_object_mut().unwrap().remove("artifactDigest");
    let evidence = write_evidence(&repo, "case.log", &receipt_line(&payload));
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-4", &evidence);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::HandoffEvidenceMissing
    );

    let record = RunRecord::load(&repo, "coop-4").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn complete_refuses_stale_candidate() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-5");
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    // HEAD moved since the handoff was issued.
    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-5");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "a".repeat(40))));
    let receipt = complete(&mut mock, &repo, "coop-5", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
    let record = RunRecord::load(&repo, "coop-5").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn status_of_handed_off_run_probes_allocation_and_handoff_document() {
    let repo = common::temp_repo();
    let record = seed_handoff_record(&repo, "coop-6");

    let mut mock = MockRunner::new();
    let sim_name = "qaren-coop-6".to_string();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&simctl_list_json(UDID, &sim_name)),
    );
    let receipt = status(&mut mock, &repo, "coop-6");
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "outcomes: {:?}",
        receipt.outcomes
    );
    assert_eq!(receipt.phase, "handed_off");
    assert_eq!(
        receipt.outcomes.get("handoff_issued").map(String::as_str),
        Some("pass")
    );
    assert_eq!(
        receipt.outcomes.get("handoff_state").map(String::as_str),
        Some("issued")
    );
    assert!(!receipt.outcomes.contains_key("app_installed"));

    // A rewritten handoff document fails the byte-identity probe.
    let _ = &record;
    let document = qaren::handoff::document_path(&repo, "coop-6");
    let mut doc: HandoffDocument =
        serde_json::from_slice(&std::fs::read(&document).unwrap()).unwrap();
    doc.expected_receipt.device_id = "TAMPERED".to_string();
    qaren::handoff::save_document(&document, &doc).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&simctl_list_json(UDID, &sim_name)),
    );
    let receipt = status(&mut mock, &repo, "coop-6");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.outcomes.get("handoff_issued").map(String::as_str),
        Some("fail")
    );
}

#[test]
fn status_refuses_an_expired_pending_handoff() {
    let repo = common::temp_repo();
    let mut record = seed_handoff_record(&repo, "coop-status-expired");
    record.scenario.deadlines.build_seconds = 30;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.sleep(Duration::from_secs(31));
    script_allocation_probe(&mut mock, "coop-status-expired");
    let receipt = status(&mut mock, &repo, "coop-status-expired");

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::ReadyDeadlineExceeded
    );
    assert_eq!(
        receipt.outcomes.get("handoff_validity").map(String::as_str),
        Some("fail")
    );
    assert!(receipt.next_action.contains("cleanup coop-status-expired"));
    assert!(receipt.next_action.contains("re-run prepare"));
}

#[test]
fn status_keeps_completed_handoffs_ready_after_the_validity_window() {
    let repo = common::temp_repo();
    let mut record = seed_handoff_record(&repo, "coop-status-completed");
    record.scenario.deadlines.build_seconds = 30;
    let completed_at = record.created_at.clone();
    record.handoff.as_mut().unwrap().completed_at = Some(completed_at);
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.sleep(Duration::from_secs(31));
    script_allocation_probe(&mut mock, "coop-status-completed");
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    let receipt = status(&mut mock, &repo, "coop-status-completed");

    assert_eq!(receipt.result, ReceiptResult::Ready);
    assert_eq!(
        receipt.outcomes.get("handoff_state").map(String::as_str),
        Some("completed")
    );
    assert!(!receipt.outcomes.contains_key("handoff_validity"));
}

#[test]
fn cleanup_of_handoff_run_cleans_only_the_allocation() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-7");

    let mut mock = MockRunner::new();
    let sim_name = "qaren-coop-7";
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&simctl_list_json(UDID, sim_name)),
    );
    mock.expect_run("simctl shutdown", CmdOutput::success(""));
    mock.expect_run("simctl delete", CmdOutput::success(""));

    let receipt = cleanup(&mut mock, &repo, "coop-7");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    assert_eq!(mock.remaining(), 0);
    // Only the simulator was touched — no kill, no lsof, no adb, no Metro.
    assert!(mock.calls.iter().all(|c| c.rendered().contains("simctl")));
    let record = RunRecord::load(&repo, "coop-7").unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
}

#[test]
fn cleanup_of_interrupted_usb_handoff_releases_only_the_owned_claim() {
    let repo = common::temp_repo();
    // Interrupted mid-allocation: claim persisted and taken, then the run
    // died before the handoff was issued.
    let mut record = common::base_record(
        &repo,
        &usb_handoff_yaml(),
        "coop-8",
        Phase::ResourcesAllocated,
    );
    record.build = None;
    let lock_root = repo.join(".locks");
    let lock_dir = lock_root.join(format!("usb-{SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    let holder = qaren::buildplan::LockHolder {
        holder: "qaren-coop-8".to_string(),
        run_id: "coop-8".to_string(),
        identity: None,
        at: "2026-08-30T10:00:00Z".to_string(),
        home: None,
        qaren_home: None,
        group: None,
    };
    std::fs::write(
        lock_dir.join("holder.json"),
        serde_json::to_vec(&holder).unwrap(),
    )
    .unwrap();
    record.resources.usb_device = Some(qaren::runrecord::UsbDeviceResource {
        serial: SERIAL.to_string(),
        lock_dir: lock_dir.clone(),
        holder: "qaren-coop-8".to_string(),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "coop-8");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    // Zero external commands: releasing the claim is pure filesystem work,
    // and no foreign process, device, or adb server is ever addressed.
    assert!(mock.calls.is_empty());
    assert!(!lock_dir.exists());
}

#[test]
fn cleanup_of_usb_handoff_run_never_releases_a_foreign_claim() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &usb_handoff_yaml(),
        "coop-9",
        Phase::ResourcesAllocated,
    );
    record.build = None;
    let lock_root = repo.join(".locks");
    let lock_dir = lock_root.join(format!("usb-{SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    let foreign = qaren::buildplan::LockHolder {
        holder: "qaren-other".to_string(),
        run_id: "other-run".to_string(),
        identity: None,
        at: "2026-08-30T10:00:00Z".to_string(),
        home: None,
        qaren_home: None,
        group: None,
    };
    std::fs::write(
        lock_dir.join("holder.json"),
        serde_json::to_vec(&foreign).unwrap(),
    )
    .unwrap();
    record.resources.usb_device = Some(qaren::runrecord::UsbDeviceResource {
        serial: SERIAL.to_string(),
        lock_dir: lock_dir.clone(),
        holder: "qaren-coop-9".to_string(),
    });
    record.save(&repo).unwrap();

    let foreign_bytes = std::fs::read(lock_dir.join("holder.json")).unwrap();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "coop-9");
    // Foreign proves this run's claim never succeeded; nothing of ours
    // remains, the foreign claim survives byte-identical, and no external
    // command inspected or signalled its holder.
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        std::fs::read(lock_dir.join("holder.json")).unwrap(),
        foreign_bytes
    );
    assert!(mock.calls.is_empty());
}

#[test]
fn complete_refuses_replayed_receipt_from_an_earlier_run() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-10");
    seed_handoff_record(&repo, "coop-11");
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-10");
    script_candidate_recheck(&mut mock);
    assert_eq!(
        complete(&mut mock, &repo, "coop-10", &evidence).result,
        ReceiptResult::Ready
    );

    // The same receipt (same install generation) against a second handoff on
    // the same worktree/app/device is stale evidence of the earlier install.
    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-11", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::HandoffEvidenceMismatch);
    assert!(failure.detail.contains("coop-10"), "{}", failure.detail);
}

#[test]
fn complete_refuses_when_replay_history_is_unreadable() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "corrupt-history");
    std::fs::write(RunRecord::path(&repo, "corrupt-history"), "{").unwrap();
    seed_handoff_record(&repo, "coop-history-check");
    let evidence = write_evidence(&repo, "history.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    let receipt = complete(&mut mock, &repo, "coop-history-check", &evidence);

    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::HandoffEvidenceMismatch);
    assert!(failure.detail.contains("corrupt-history"));
    assert!(failure.detail.contains("run.json"));
    assert!(mock.calls.is_empty());
}

#[test]
fn complete_tolerates_the_sessions_applied_integration_surface() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-12");
    std::fs::write(
        repo.join("test-app").join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android","test":"jest"}}"#,
    )
    .unwrap();
    std::fs::write(
        repo.join("test-app").join("metro.config.js"),
        "module.exports = config;\n\n// qaren session integration: begin\nmodule.exports = require('./.qaren/integration/rn-session-metro.cjs')(module.exports);\n// qaren session integration: end\n",
    )
    .unwrap();
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-12");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success(
            " M test-app/package.json\0 M test-app/metro.config.js\0?? test-app/.qaren/integration/rn-session-adapter.cjs\0",
        ),
    );
    mock.expect_run(
        "show HEAD:test-app/package.json",
        CmdOutput::success(
            r#"{"scripts":{"ios":"expo run:ios","android":"expo run:android","test":"jest"}}"#,
        ),
    );
    common::script_tracked_file_identity(&mut mock, "test-app/package.json", "100644");
    mock.expect_run(
        "show HEAD:test-app/metro.config.js",
        CmdOutput::success("module.exports = config;\n"),
    );
    common::script_tracked_file_identity(&mut mock, "test-app/metro.config.js", "100644");
    let receipt = complete(&mut mock, &repo, "coop-12", &evidence);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn complete_allows_saved_actions_and_refuses_other_non_integration_changes() {
    let cases = [
        ("?? test-app/.qaren/\0", ReceiptResult::Refused),
        ("?? test-app/.qaren/integration/\0", ReceiptResult::Refused),
        (
            "?? test-app/.qaren/actions/new.yaml\0",
            ReceiptResult::Ready,
        ),
        ("?? test-app/.qaren/actions/new.yml\0", ReceiptResult::Ready),
        ("?? test-app/.qaren/config.yaml\0", ReceiptResult::Refused),
        (
            " M test-app/.qaren/actions/existing.yaml\0",
            ReceiptResult::Ready,
        ),
        (
            " M test-app/.qaren/actions/existing.yml\0",
            ReceiptResult::Ready,
        ),
        (
            " M test-app/.qaren/actions/source.ts\0",
            ReceiptResult::Refused,
        ),
        (
            " M test-app/.qaren/integration/tracked.cjs\0",
            ReceiptResult::Refused,
        ),
        (
            "A  test-app/.qaren/integration/tracked.cjs\0",
            ReceiptResult::Refused,
        ),
        (
            " D test-app/.qaren/integration/tracked.cjs\0",
            ReceiptResult::Refused,
        ),
        (
            "R  test-app/.qaren/integration/new.cjs\0test-app/.qaren/integration/old.cjs\0",
            ReceiptResult::Refused,
        ),
    ];
    for (change, expected) in cases {
        let repo = common::temp_repo();
        seed_handoff_record(&repo, "integration-drift");
        let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));
        let mut mock = MockRunner::new();
        script_allocation_probe(&mut mock, "integration-drift");
        mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
        mock.expect_run(
            "git",
            CmdOutput::success(&format!(
                "?? test-app/.qaren/integration/rn-session-adapter.cjs\0{change}"
            )),
        );
        let receipt = complete(&mut mock, &repo, "integration-drift", &evidence);
        assert_eq!(receipt.result, expected, "{change:?}");
        if expected == ReceiptResult::Refused {
            assert_eq!(receipt.failure.unwrap().code, FailureCode::CandidateDrifted);
        } else {
            assert!(receipt.failure.is_none());
        }
        assert_eq!(mock.remaining(), 0);
        std::fs::remove_dir_all(repo).unwrap();
    }
}

#[test]
fn complete_refuses_malformed_metro_integration_markers() {
    let repo = common::temp_repo();
    let cases = [
        (
            "prefixed",
            "mutateOtherState(); // qaren session integration: begin\nhidden();\n// qaren session integration: end\n",
        ),
        (
            "suffixed",
            "// qaren session integration: begin trailing\nhidden();\n// qaren session integration: end\n",
        ),
        (
            "duplicate",
            "// qaren session integration: begin\none();\n// qaren session integration: end\n// qaren session integration: begin\ntwo();\n// qaren session integration: end\n",
        ),
        (
            "missing-end",
            "// qaren session integration: begin\nhidden();\n",
        ),
        (
            "out-of-order",
            "// qaren session integration: end\n// qaren session integration: begin\nhidden();\n// qaren session integration: end\n",
        ),
        ("missing-markers", "module.exports = changed;\n"),
    ];

    for (case, integration) in cases {
        let run_id = format!("metro-{case}");
        seed_handoff_record(&repo, &run_id);
        std::fs::write(
            repo.join("test-app").join("metro.config.js"),
            format!("module.exports = config;\n{integration}"),
        )
        .unwrap();
        let evidence = write_evidence(
            &repo,
            &format!("{case}.log"),
            &receipt_line(&receipt_payload(&repo)),
        );
        let mut mock = MockRunner::new();
        script_allocation_probe(&mut mock, &run_id);
        mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
        mock.expect_run("git", CmdOutput::success(" M test-app/metro.config.js\0"));
        mock.expect_run(
            "show HEAD:test-app/metro.config.js",
            CmdOutput::success("module.exports = config;\n"),
        );

        let receipt = complete(&mut mock, &repo, &run_id, &evidence);
        assert_eq!(receipt.result, ReceiptResult::Refused, "case {case}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::CandidateDrifted,
            "case {case}"
        );
    }
}

#[test]
fn complete_tolerates_crlf_head_through_the_exact_metro_transform() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "metro-crlf");
    std::fs::write(
        repo.join("test-app").join("metro.config.js"),
        "module.exports = config;\n\n// qaren session integration: begin\nmodule.exports = require('./.qaren/integration/rn-session-metro.cjs')(module.exports);\n// qaren session integration: end\n",
    )
    .unwrap();
    let evidence = write_evidence(&repo, "crlf.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "metro-crlf");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/metro.config.js\0"));
    mock.expect_run(
        "show HEAD:test-app/metro.config.js",
        CmdOutput::success("module.exports = config;\r\n"),
    );
    common::script_tracked_file_identity(&mut mock, "test-app/metro.config.js", "100644");

    let receipt = complete(&mut mock, &repo, "metro-crlf", &evidence);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
}

#[test]
fn complete_refuses_whitespace_drift_outside_the_metro_block() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "metro-whitespace");
    std::fs::write(
        repo.join("test-app").join("metro.config.js"),
        "module.exports = config;  \n\n// qaren session integration: begin\nmodule.exports = require('./.qaren/integration/rn-session-metro.cjs')(module.exports);\n// qaren session integration: end\n",
    )
    .unwrap();
    let evidence = write_evidence(
        &repo,
        "whitespace.log",
        &receipt_line(&receipt_payload(&repo)),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "metro-whitespace");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/metro.config.js\0"));
    mock.expect_run(
        "show HEAD:test-app/metro.config.js",
        CmdOutput::success("module.exports = config;\n"),
    );

    let receipt = complete(&mut mock, &repo, "metro-whitespace", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn complete_refuses_nonterminal_or_replaced_metro_wrappers() {
    let cases = [
        (
            "moved",
            "before();\n\n// qaren session integration: begin\nmodule.exports = require('./.qaren/integration/rn-session-metro.cjs')(module.exports);\n// qaren session integration: end\nafter();\n",
            "before();\nafter();\n",
        ),
        (
            "replaced",
            "before();\nafter();\n\n// qaren session integration: begin\nmodule.exports = changed;\n// qaren session integration: end\n",
            "before();\nafter();\n",
        ),
    ];

    for (case, working, head) in cases {
        let repo = common::temp_repo();
        let run_id = format!("metro-transform-{case}");
        seed_handoff_record(&repo, &run_id);
        std::fs::write(repo.join("test-app").join("metro.config.js"), working).unwrap();
        let evidence = write_evidence(
            &repo,
            &format!("{case}.log"),
            &receipt_line(&receipt_payload(&repo)),
        );

        let mut mock = MockRunner::new();
        script_allocation_probe(&mut mock, &run_id);
        mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
        mock.expect_run("git", CmdOutput::success(" M test-app/metro.config.js\0"));
        mock.expect_run(
            "show HEAD:test-app/metro.config.js",
            CmdOutput::success(head),
        );

        let receipt = complete(&mut mock, &repo, &run_id, &evidence);
        assert_eq!(receipt.result, ReceiptResult::Refused, "case {case}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::CandidateDrifted,
            "case {case}"
        );
    }
}

#[test]
fn complete_refuses_staged_drift_beneath_package_integration() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "package-staged");
    std::fs::write(
        repo.join("test-app").join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android"}}"#,
    )
    .unwrap();
    let evidence = write_evidence(
        &repo,
        "staged-package.log",
        &receipt_line(&receipt_payload(&repo)),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "package-staged");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success("MM test-app/package.json\0"));

    let receipt = complete(&mut mock, &repo, "package-staged", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[cfg(unix)]
#[test]
fn complete_refuses_mode_drift_beneath_package_integration() {
    use std::os::unix::fs::PermissionsExt;

    let repo = common::temp_repo();
    seed_handoff_record(&repo, "package-mode");
    let package = repo.join("test-app").join("package.json");
    std::fs::write(
        &package,
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android"}}"#,
    )
    .unwrap();
    std::fs::set_permissions(&package, std::fs::Permissions::from_mode(0o755)).unwrap();
    let evidence = write_evidence(
        &repo,
        "mode-package.log",
        &receipt_line(&receipt_payload(&repo)),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "package-mode");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/package.json\0"));
    mock.expect_run("show HEAD:test-app/package.json", CmdOutput::success("{}"));
    common::script_tracked_file_identity(&mut mock, "test-app/package.json", "100644");

    let receipt = complete(&mut mock, &repo, "package-mode", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn complete_refuses_unrelated_empty_scripts_structure_changes() {
    let cases = [
        ("removed", "{}", r#"{"scripts":{}}"#),
        ("added", r#"{"scripts":{}}"#, "{}"),
    ];

    for (case, working, head) in cases {
        let repo = common::temp_repo();
        let run_id = format!("package-structure-{case}");
        seed_handoff_record(&repo, &run_id);
        std::fs::write(repo.join("test-app").join("package.json"), working).unwrap();
        let evidence = write_evidence(
            &repo,
            &format!("{case}.log"),
            &receipt_line(&receipt_payload(&repo)),
        );

        let mut mock = MockRunner::new();
        script_allocation_probe(&mut mock, &run_id);
        mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
        mock.expect_run("git", CmdOutput::success(" M test-app/package.json\0"));
        mock.expect_run("show HEAD:test-app/package.json", CmdOutput::success(head));

        let receipt = complete(&mut mock, &repo, &run_id, &evidence);
        assert_eq!(receipt.result, ReceiptResult::Refused, "case {case}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::CandidateDrifted,
            "case {case}"
        );
    }
}

#[test]
fn complete_tolerates_integration_scripts_added_to_an_empty_package() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "package-empty");
    std::fs::write(
        repo.join("test-app").join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android"}}"#,
    )
    .unwrap();
    let evidence = write_evidence(
        &repo,
        "empty-package.log",
        &receipt_line(&receipt_payload(&repo)),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "package-empty");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/package.json\0"));
    mock.expect_run("show HEAD:test-app/package.json", CmdOutput::success("{}"));
    common::script_tracked_file_identity(&mut mock, "test-app/package.json", "100644");

    let receipt = complete(&mut mock, &repo, "package-empty", &evidence);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
}

#[test]
fn complete_tolerates_integration_in_a_project_path_with_spaces() {
    let repo = common::temp_repo();
    let project_rel = Path::new("apps/My App");
    std::fs::create_dir_all(repo.join("apps")).unwrap();
    std::fs::rename(repo.join("test-app"), repo.join(project_rel)).unwrap();
    seed_handoff_record_for_project(&repo, "coop-spaces", project_rel);
    std::fs::write(
        repo.join(project_rel).join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android","test":"jest"}}"#,
    )
    .unwrap();
    let evidence = write_evidence(
        &repo,
        "spaces.log",
        &receipt_line(&receipt_payload_for_project(&repo, project_rel)),
    );

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-spaces");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M apps/My App/package.json\0"));
    mock.expect_run(
        "show HEAD:apps/My App/package.json",
        CmdOutput::success(
            r#"{"scripts":{"ios":"expo run:ios","android":"expo run:android","test":"jest"}}"#,
        ),
    );
    common::script_tracked_file_identity(&mut mock, "apps/My App/package.json", "100644");

    let receipt = complete(&mut mock, &repo, "coop-spaces", &evidence);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    let status_call = mock
        .calls
        .iter()
        .find(|call| call.label == "git-dirty")
        .unwrap();
    assert!(status_call.args.iter().any(|arg| arg == "--porcelain=v1"));
    assert!(status_call.args.iter().any(|arg| arg == "-z"));
}

#[test]
fn complete_still_refuses_non_integration_package_json_drift() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-13");
    // A dependency edit rides along with the integration scripts: drift.
    std::fs::write(
        repo.join("test-app").join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android","test":"vitest"}}"#,
    )
    .unwrap();
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    let mut mock = MockRunner::new();
    script_allocation_probe(&mut mock, "coop-13");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/package.json\0"));
    mock.expect_run(
        "show HEAD:test-app/package.json",
        CmdOutput::success(
            r#"{"scripts":{"ios":"expo run:ios","android":"expo run:android","test":"jest"}}"#,
        ),
    );
    let receipt = complete(&mut mock, &repo, "coop-13", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn complete_refuses_when_the_allocation_is_no_longer_owned() {
    let repo = common::temp_repo();
    seed_handoff_record(&repo, "coop-14");
    let evidence = write_evidence(&repo, "build.log", &receipt_line(&receipt_payload(&repo)));

    // The recorded simulator now carries a foreign name.
    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&simctl_list_json(UDID, "someone-elses-sim")),
    );
    let receipt = complete(&mut mock, &repo, "coop-14", &evidence);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::OwnershipUnproven
    );
    let record = RunRecord::load(&repo, "coop-14").unwrap();
    assert!(record.handoff.as_ref().unwrap().completed_at.is_none());
}

#[test]
fn handoff_dry_run_plans_allocation_only() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_handoff_yaml());

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_HANDOFF_TOOLS);

    let args = PrepareArgs {
        scenario_path,
        dry_run: true,
        android_home: None,
        lock_root: repo.join(".locks"),
        native_cache_root: repo.join(".native-store"),
        native_cache_state_root: repo.join(".runtime-state"),
        native_cache_mount_probe: common::fixture_mount,
        runs_root: repo.to_path_buf(),
        device: None,
        boot_device: false,
        pool_root: repo.join(".pool"),
        new_device: false,
    };
    let receipt = prepare(&mut mock, &args);
    assert_eq!(receipt.result, ReceiptResult::Planned);
    // The exact allocation-only plan: deps, then simulator create + boot.
    // Nothing else — no Metro, no expo/xcodebuild/gradle, no adb.
    let heads: Vec<String> = receipt
        .planned_commands
        .iter()
        .map(|c| {
            let mut words = c.split_whitespace();
            format!(
                "{} {}",
                words.next().unwrap_or(""),
                words.next().unwrap_or("")
            )
        })
        .collect();
    assert_eq!(
        heads,
        vec!["pnpm install", "xcrun simctl", "xcrun simctl"],
        "planned: {:?}",
        receipt.planned_commands
    );
    assert!(receipt.planned_commands[1].contains("simctl create"));
    assert!(receipt.planned_commands[2].contains("simctl bootstatus"));
    assert_eq!(
        receipt.outcomes.get("build_owner").map(String::as_str),
        Some("qaren")
    );
}
