mod common;

use qaren::failure::FailureCode;
use qaren::receipt::{Receipt, ReceiptResult, RECEIPT_SCHEMA};
use qaren::runrecord::{validate_run_id, Phase, RunRecord, RUN_SCHEMA};

#[test]
fn declared_targeting_survives_row_and_receipt_summary_round_trip() {
    let fact = serde_json::json!({
        "methods": ["id", "label"], "binding": "author-declared", "preSelectionAuthorizations": 0,
        "evaluated": [
            {"method": "id", "observation": 7, "count": 0, "match": "none", "outcome": "missing"},
            {"method": "label", "observation": 7, "count": 1, "match": "segment", "outcome": "selected"}
        ],
        "originalMissing": "TARGET_NOT_FOUND", "selected": "label",
        "dispatchAttempted": true, "dispatchCount": 1, "outcome": "passed", "code": "ACTION_ACCEPTED"
    });
    let row = serde_json::json!({"block": "a", "operationId": 3, "line": 2, "attempt": 1,
        "kind": "step", "resolvedBy": "exact", "t": 1, "outcome": "pass", "targeting": fact});
    let decoded: qaren::core::Row = serde_json::from_value(row.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap()["targeting"], fact);
    let ledger: qaren::core::Ledger = serde_json::from_value(serde_json::json!({
        "verdict": "PASS", "path": "walk", "blocks": [], "steps": [row],
        "jev": {"calls": 0, "medianMs": 0}, "llmTurns": 0, "escapes": 0, "recoveries": 0
    }))
    .unwrap();
    let summary = qaren::report::summarize(&ledger);
    let serialized = serde_json::to_value(summary).unwrap();
    assert_eq!(serialized["targeting"][0]["fact"], fact);
    assert_eq!(serialized["targeting"][0]["operationId"], 3);
    assert_eq!(serialized["steps"], 1);
    let round_trip: qaren::report::LedgerSummary =
        serde_json::from_value(serialized.clone()).unwrap();
    assert_eq!(serde_json::to_value(round_trip).unwrap(), serialized);

    let mut receipt = Receipt::new(
        "check",
        "target-pair",
        ReceiptResult::Pass,
        "walk",
        "2026-10-15T00:00:00Z".into(),
    );
    receipt.ledger = Some(serde_json::from_value(serialized).unwrap());
    let success = serde_json::to_value(receipt).unwrap();
    let mut exhausted = success.clone();
    exhausted["result"] = serde_json::json!("fail");
    exhausted["ledger"]["verdict"] = serde_json::json!("FAIL");
    let fact = &mut exhausted["ledger"]["targeting"][0]["fact"];
    fact.as_object_mut().unwrap().remove("selected");
    fact["evaluated"][1]["count"] = serde_json::json!(0);
    fact["evaluated"][1]["match"] = serde_json::json!("none");
    fact["evaluated"][1]["outcome"] = serde_json::json!("missing");
    fact["dispatchAttempted"] = serde_json::json!(false);
    fact["dispatchCount"] = serde_json::json!(0);
    fact["outcome"] = serde_json::json!("exhausted");
    fact["code"] = serde_json::json!("ALTERNATIVES_EXHAUSTED");
    for value in [success, exhausted] {
        let decoded: Receipt = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), value);
        let passed = value["result"] == "pass";
        for (pointer, invalid) in [
            ("/dispatchCount", serde_json::json!(2)),
            ("/methods", serde_json::json!(["id", "id"])),
            ("/preSelectionAuthorizations", serde_json::json!(1)),
            ("/evaluated/1/count", serde_json::json!(2)),
            (
                "/outcome",
                serde_json::json!(if passed { "exhausted" } else { "passed" }),
            ),
            (
                "/code",
                serde_json::json!(if passed {
                    "ALTERNATIVES_EXHAUSTED"
                } else {
                    "ACTION_ACCEPTED"
                }),
            ),
        ] {
            let mut invalid_receipt = value.clone();
            let fact = &mut invalid_receipt["ledger"]["targeting"][0]["fact"];
            *fact.pointer_mut(pointer).unwrap() = invalid;
            let targeting: qaren::core::Targeting = serde_json::from_value(fact.clone()).unwrap();
            assert!(!targeting.valid(), "invalid fixture at {pointer}");
            assert!(
                serde_json::from_value::<Receipt>(invalid_receipt).is_err(),
                "receipt accepted invalid targeting at {pointer}"
            );
        }
    }
}

#[test]
fn typescript_declared_support_refusals_round_trip_value_free_receipts() {
    let output = std::process::Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../qaren-core"))
        .args(["--input-type=module", "--eval", r#"
import assert from 'node:assert/strict';
import { parsePlan } from './dist/qa/plan.js';
import { runPlan } from './dist/qa/walker.js';
import { element, screen, scriptedJudge, walker, joinedGapScreen } from './test/unit/qa/judgment-fixtures.ts';
const primary = 'private-support-id-canary', label = 'private-support-label-canary';
const ledgers = [];
for (const pressEvidenceGap of [false, true]) {
  for (const press of ['supported', 'unsupported', 'unknown', undefined]) {
    if (!pressEvidenceGap && press === 'supported') continue;
    const observed = screen([
      element('@input', 'Input', {kind: 'input', value: primary}),
      element('@label-input', 'Label input', {kind: 'input', value: label}),
      element('@private-primary', label, {testID: primary, semantic: press === undefined
        ? undefined : {press, fill: 'unsupported', visibility: 'visible'}}),
    ]);
    if (pressEvidenceGap) observed.pressEvidenceGap = 'private-support-gap-canary';
    const f = walker([observed], scriptedJudge(() => assert.fail('no refusal Jev')));
    const ledger = await runPlan(parsePlan('1. Tap id "' + primary + '" || label "' + label + '"').blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
    ledgers.push(ledger);
  }
}
for (const category of ['missing-host-evidence', 'incomplete-host-evidence', 'unassociated-hosts']) {
  for (const presence of [true, false, 'unknown']) {
    for (const typographyComplete of [true, false]) {
    const f = walker([joinedGapScreen(category, presence, typographyComplete)], scriptedJudge(() => assert.fail('no gap Jev')));
    const ledger = await runPlan(parsePlan('1. Tap id "private-gap-primary" || label "private-gap-label"').blocks, f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
    ledgers.push(ledger);
    }
  }
}
process.stdout.write(JSON.stringify(ledgers));
"#])
        .output().expect("node on PATH is required for the core receipt contract");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(values.len(), 25);
    for value in values {
        let ledger: qaren::core::Ledger = serde_json::from_value(value.clone()).unwrap();
        let expected = &value["steps"][0]["targeting"];
        let mut receipt = Receipt::new(
            "check",
            "support-refusal",
            ReceiptResult::Fail,
            "walk",
            "2026-10-15T00:00:00Z".into(),
        );
        receipt.ledger = Some(qaren::report::summarize(&ledger));
        let encoded =
            serde_json::to_value(serde_json::from_str::<Receipt>(&receipt.to_json()).unwrap())
                .unwrap();
        assert_eq!(&encoded["ledger"]["targeting"][0]["fact"], expected);
        assert_eq!(encoded["ledger"]["targeting"][0]["operationId"], 1);
        let report = qaren::report::render(&qaren::report::ReportInput {
            run_id: "support-refusal",
            platform: "ios",
            app_id: "com.example.app",
            device: "synthetic",
            ledger: &ledger,
        });
        for private in [
            "private-support-id-canary",
            "private-support-label-canary",
            "private-support-gap-canary",
            "@private-primary",
            "private-gap-primary",
            "private-gap-label",
            "private-unassociated-host-",
        ] {
            assert!(!receipt.to_json().contains(private));
            assert!(!report.contains(private));
        }
        let gap = &expected["evaluated"][0]["pressSupport"]["gap"];
        if !gap.is_null() {
            let mut mutations = vec![
                ("/category", serde_json::json!("private-category")),
                (
                    "/category",
                    serde_json::json!(if gap["category"] == "missing-host-evidence" {
                        "unassociated-hosts"
                    } else {
                        "missing-host-evidence"
                    }),
                ),
                (
                    "/hostEvidencePresent",
                    serde_json::json!(!gap["hostEvidencePresent"].as_bool().unwrap()),
                ),
                (
                    "/hostEvidenceComplete",
                    serde_json::json!(!gap["hostEvidenceComplete"].as_bool().unwrap()),
                ),
                (
                    "/typographyComplete",
                    serde_json::json!("private-typography"),
                ),
                (
                    "/nativePresenceAvailable",
                    serde_json::json!("private-presence"),
                ),
                ("/pressGapCount", serde_json::json!(-1)),
                ("/pressGapCount", serde_json::json!(4_294_967_296_u64)),
            ];
            if let Some(rows) = gap["gapHosts"]["rows"].as_array() {
                let mut too_many = rows.clone();
                too_many.push(rows[0].clone());
                let mut private_association = rows[0]["association"].clone();
                private_association["frameMismatch"] = serde_json::json!({"delta": {"x": 987654}});
                mutations.extend([
                    ("/gapHosts/rows", serde_json::json!(too_many)),
                    ("/gapHosts/total", serde_json::json!(0)),
                    ("/gapHosts/truncated", serde_json::json!(false)),
                    ("/gapHosts/rows/1/hostOrdinal", serde_json::json!(0)),
                    (
                        "/gapHosts/rows/0/hostKind",
                        serde_json::json!("private-kind"),
                    ),
                    (
                        "/gapHosts/rows/0/capabilities",
                        serde_json::json!({"press": true, "fill": false, "label": "private"}),
                    ),
                    ("/gapHosts/rows/0/association", private_association),
                    (
                        "/gapHosts/rows/0/association/identity",
                        serde_json::json!("private-reason"),
                    ),
                    (
                        "/gapHosts/rows/0/association/nativeIdentityCandidateCount",
                        serde_json::json!(-1),
                    ),
                    (
                        "/gapHosts/rows/0/association/ancestorPath",
                        serde_json::json!("private-path"),
                    ),
                ]);
            }
            for (pointer, invalid) in mutations {
                let mut bad_row = value["steps"][0].clone();
                *bad_row["targeting"]["evaluated"][0]["pressSupport"]["gap"]
                    .pointer_mut(pointer)
                    .unwrap() = invalid.clone();
                assert!(
                    serde_json::from_value::<qaren::core::Row>(bad_row).is_err(),
                    "{pointer}: {invalid}"
                );
                let mut bad_receipt = encoded.clone();
                *bad_receipt["ledger"]["targeting"][0]["fact"]["evaluated"][0]["pressSupport"]
                    ["gap"]
                    .pointer_mut(pointer)
                    .unwrap() = invalid;
                assert!(
                    serde_json::from_value::<Receipt>(bad_receipt).is_err(),
                    "{pointer}"
                );
            }
            let mut contradictory = value["steps"][0].clone();
            contradictory["targeting"]["evaluated"][0]["pressSupport"]["pressEvidenceGap"] =
                serde_json::json!(false);
            assert!(serde_json::from_value::<qaren::core::Row>(contradictory).is_err());
        }
        let mut legacy_row = value["steps"][0].clone();
        legacy_row["targeting"]["evaluated"][0]
            .as_object_mut()
            .unwrap()
            .remove("pressSupport");
        assert!(serde_json::from_value::<qaren::core::Row>(legacy_row).is_ok());
        let mut selected_row = value["steps"][0].clone();
        selected_row["outcome"] = serde_json::json!("pass");
        let selected_fact = &mut selected_row["targeting"];
        selected_fact["evaluated"][0]["outcome"] = serde_json::json!("selected");
        selected_fact["selected"] = serde_json::json!("id");
        selected_fact["dispatchAttempted"] = serde_json::json!(true);
        selected_fact["dispatchCount"] = serde_json::json!(1);
        selected_fact["outcome"] = serde_json::json!("passed");
        selected_fact["code"] = serde_json::json!("ACTION_ACCEPTED");
        assert!(serde_json::from_value::<qaren::core::Row>(selected_row.clone()).is_err());
        selected_row["targeting"]["evaluated"][0]
            .as_object_mut()
            .unwrap()
            .remove("pressSupport");
        assert!(serde_json::from_value::<qaren::core::Row>(selected_row).is_ok());
        for invalid in [
            serde_json::json!({"pressEvidenceGap": false, "semanticPress": "supported"}),
            serde_json::json!({"pressEvidenceGap": "private", "semanticPress": "unknown"}),
            serde_json::json!({"pressEvidenceGap": true, "semanticPress": "private"}),
            serde_json::json!({"pressEvidenceGap": true, "semanticPress": "unknown", "label": "private"}),
            serde_json::json!({"pressEvidenceGap": true}),
            serde_json::json!({"semanticPress": "absent"}),
        ] {
            let mut bad_receipt = encoded.clone();
            bad_receipt["ledger"]["targeting"][0]["fact"]["evaluated"][0]["pressSupport"] =
                invalid.clone();
            assert!(
                serde_json::from_value::<Receipt>(bad_receipt).is_err(),
                "{invalid}"
            );
            let mut bad_row = value["steps"][0].clone();
            bad_row["targeting"]["evaluated"][0]["pressSupport"] = invalid;
            assert!(serde_json::from_value::<qaren::core::Row>(bad_row).is_err());
        }
    }
}

#[test]
fn typescript_declared_targeting_round_trips_private_success_and_exhaustion_receipts() {
    let output = std::process::Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../qaren-core"))
        .args(["--input-type=module", "--eval", r#"
import assert from 'node:assert/strict';
import { parsePlan } from './dist/qa/plan.js';
import { runPlan } from './dist/qa/walker.js';
import { element, screen, scriptedJudge, walker } from './test/unit/qa/judgment-fixtures.ts';
const ledgers = [];
for (const found of [true, false]) {
  const primary = 'private-primary-canary', label = 'private-label-canary';
  const observed = screen([
    element('@field1', 'First field', {kind: 'input', value: primary}),
    element('@field2', 'Second field', {kind: 'input', value: label}),
    ...(found ? [element('@alternate', label)] : []),
  ]);
  const f = walker([observed], scriptedJudge(() => assert.fail('no pair Jev')));
  const ledger = await runPlan(parsePlan(`1. Tap id "${primary}" || label "${label}"`).blocks, f.deps);
  assert.equal(ledger.verdict, found ? 'PASS' : 'FAIL');
  assert.equal(f.actions.length, Number(found));
  const serialized = JSON.stringify({ledger, rows: f.rows});
  assert.ok(!serialized.includes(primary) && !serialized.includes(label));
  ledgers.push(ledger);
}
process.stdout.write(JSON.stringify(ledgers));
"#])
        .output().expect("node on PATH is required for the core receipt contract");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let values: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).unwrap();
    for value in values {
        let ledger: qaren::core::Ledger = serde_json::from_value(value.clone()).unwrap();
        let expected = &value["steps"][0]["targeting"];
        let result = if ledger.verdict == "PASS" {
            ReceiptResult::Pass
        } else {
            ReceiptResult::Fail
        };
        let mut receipt = Receipt::new(
            "check",
            "target-pair",
            result,
            "walk",
            "2026-10-15T00:00:00Z".into(),
        );
        receipt.ledger = Some(qaren::report::summarize(&ledger));
        let decoded: Receipt = serde_json::from_str(&receipt.to_json()).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();
        assert_eq!(&encoded["ledger"]["targeting"][0]["fact"], expected);
        assert_eq!(encoded["ledger"]["steps"], 1);
        let report = qaren::report::render(&qaren::report::ReportInput {
            run_id: "target-pair",
            platform: "ios",
            app_id: "com.example.app",
            device: "synthetic",
            ledger: &ledger,
        });
        assert!(report.contains("TARGET_NOT_FOUND"));
        assert!(
            !report.contains("private-primary-canary") && !report.contains("private-label-canary")
        );
        for (pointer, invalid) in [
            ("/methods", serde_json::json!(["id", "id"])),
            ("/methods", serde_json::json!(["id", "label", "id"])),
            ("/methods/1", serde_json::json!("semantic")),
            ("/evaluated/0/count", serde_json::json!(-1)),
            ("/evaluated/0/count", serde_json::json!(4_294_967_296_u64)),
            ("/evaluated/0/count", serde_json::json!(1)),
            ("/evaluated/1/observation", serde_json::json!(0)),
            ("/evaluated/1/observation", serde_json::json!(99)),
            ("/preSelectionAuthorizations", serde_json::json!(1)),
            ("/dispatchCount", serde_json::json!(2)),
            ("/selected", serde_json::json!("id")),
            ("/originalMissing", serde_json::json!("TARGET_AMBIGUOUS")),
            ("/code", serde_json::json!("raw private reason")),
            ("/binding", serde_json::json!("inferred")),
        ] {
            let mut invalid_ledger = value.clone();
            let fact = &mut invalid_ledger["steps"][0]["targeting"];
            if let Some(slot) = fact.pointer_mut(pointer) {
                *slot = invalid;
            } else {
                fact[pointer.strip_prefix('/').unwrap()] = invalid;
            }
            assert!(
                serde_json::from_value::<qaren::core::Ledger>(invalid_ledger).is_err(),
                "{pointer}"
            );
        }
    }
}

#[test]
fn build_spawn_requires_pending_and_rejects_replacement_or_invalid_identity() {
    use qaren::runrecord::{BuildProcess, Resources};
    let mut resources = Resources::default();
    let identity = common::identity(5000, "Wed Aug 12 16:01:00 2026");
    assert!(resources.can_release_build_ownership());
    assert!(resources
        .record_build_spawned(5000, Some(identity.clone()))
        .is_err());
    assert!(resources.build_process().is_none());

    resources.begin_build().unwrap();
    assert!(!resources.can_release_build_ownership());
    assert!(resources.begin_build().is_err());
    for (pgid, identity) in [
        (-5000, None),
        (0, None),
        (1, None),
        (5001, Some(identity.clone())),
        (5000, Some(common::identity(5000, " "))),
    ] {
        assert!(resources.record_build_spawned(pgid, identity).is_err());
        assert!(matches!(
            resources.build_process(),
            Some(BuildProcess::SpawnPending)
        ));
        assert!(!resources.can_release_build_ownership());
    }

    resources
        .record_build_spawned(5000, Some(identity))
        .unwrap();
    let running = serde_json::to_value(&resources).unwrap();
    assert!(resources.begin_build().is_err());
    assert!(resources.record_build_spawned(6000, None).is_err());
    assert_eq!(serde_json::to_value(&resources).unwrap(), running);
    assert!(!resources.can_release_build_ownership());
}

#[test]
fn build_retirement_requires_evidence_for_the_recorded_state_and_group() {
    use qaren::runrecord::{BuildCompletionEvidence, GroupCleanupResult, Resources};
    let group = |pgid, outcome| BuildCompletionEvidence::Group { pgid, outcome };
    let mut resources = Resources::default();
    assert!(resources
        .finish_build(BuildCompletionEvidence::NotSpawned)
        .is_err());
    assert!(resources
        .finish_build(group(5000, GroupCleanupResult::Absent))
        .is_err());

    resources.begin_build().unwrap();
    for outcome in [GroupCleanupResult::Absent, GroupCleanupResult::Removed] {
        assert!(resources.finish_build(group(5000, outcome)).is_err());
        assert!(!resources.can_release_build_ownership());
    }
    resources
        .finish_build(BuildCompletionEvidence::NotSpawned)
        .unwrap();
    assert!(resources.can_release_build_ownership());

    for identity in [
        None,
        Some(common::identity(5000, "Wed Aug 12 16:01:00 2026")),
    ] {
        for outcome in [GroupCleanupResult::Absent, GroupCleanupResult::Removed] {
            resources.begin_build().unwrap();
            resources
                .record_build_spawned(5000, identity.clone())
                .unwrap();
            let running = serde_json::to_value(&resources).unwrap();
            for evidence in [
                BuildCompletionEvidence::NotSpawned,
                group(6000, GroupCleanupResult::Absent),
                group(6000, GroupCleanupResult::Removed),
                group(5000, GroupCleanupResult::Refused),
                group(5000, GroupCleanupResult::Unresolved),
            ] {
                assert!(resources.finish_build(evidence).is_err());
                assert_eq!(serde_json::to_value(&resources).unwrap(), running);
                assert!(!resources.can_release_build_ownership());
            }
            resources.finish_build(group(5000, outcome)).unwrap();
            assert!(resources.can_release_build_ownership());
            assert!(resources.finish_build(group(5000, outcome)).is_err());
        }
    }
}

#[test]
fn run_record_round_trips() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "roundtrip1",
        Phase::Ready,
    );
    record.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: "qaren-roundtrip1".to_string(),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.metro = Some(qaren::runrecord::MetroResource {
        port: 8791,
        endpoint: "http://127.0.0.1:8791".to_string(),
        spawned: qaren::exec::Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, "Wed Aug 12 16:01:00 2026")),
        log: repo.join("build.log"),
    });
    record.save(&repo).unwrap();
    let loaded = RunRecord::load(&repo, "roundtrip1").unwrap();
    assert_eq!(loaded.schema, RUN_SCHEMA);
    assert_eq!(loaded.run_id, "roundtrip1");
    assert_eq!(loaded.phase, Phase::Ready);
    assert_eq!(loaded.candidate.app_id, "com.rndevagent.testapp");
    assert_eq!(loaded.scenario.metro.unwrap().port, 8791);
    let sim = loaded.resources.ios_simulator.as_ref().unwrap();
    assert_eq!(
        (sim.udid.as_str(), sim.name.as_str()),
        ("AAAA-1111", "qaren-roundtrip1")
    );
    let metro = loaded.resources.metro.as_ref().unwrap();
    assert_eq!(metro.spawned.pgid, 5000);
    assert_eq!(
        metro.identity.as_ref().unwrap().started_at,
        "Wed Aug 12 16:01:00 2026"
    );
    assert_eq!(loaded.prepare.as_ref().unwrap().pid, 999);
}

#[test]
fn load_rejects_embedded_run_id_mismatch() {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "realid",
        Phase::Ready,
    );
    record.save(&repo).unwrap();
    let src = RunRecord::path(&repo, "realid");
    let tampered_dir = repo.join("otherid");
    std::fs::create_dir_all(&tampered_dir).unwrap();
    std::fs::copy(&src, tampered_dir.join("run.json")).unwrap();
    let failure = RunRecord::load(&repo, "otherid").unwrap_err();
    assert_eq!(failure.code, FailureCode::RunRecordInvalid);
}

#[test]
fn load_rejects_corrupt_and_foreign_schema_records() {
    let repo = common::temp_repo();
    let dir = repo.join("corrupt1");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("run.json"), "{not json").unwrap();
    assert_eq!(
        RunRecord::load(&repo, "corrupt1").unwrap_err().code,
        FailureCode::RunRecordInvalid
    );

    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "schema1",
        Phase::Ready,
    );
    record.save(&repo).unwrap();
    let path = RunRecord::path(&repo, "schema1");
    let body = std::fs::read_to_string(&path)
        .unwrap()
        .replace(RUN_SCHEMA, "qaren-run/999");
    std::fs::write(&path, body).unwrap();
    assert_eq!(
        RunRecord::load(&repo, "schema1").unwrap_err().code,
        FailureCode::RunRecordInvalid
    );
}

#[test]
fn run_id_validation_blocks_traversal_and_flags() {
    assert!(validate_run_id("ios-simulator-20260812T160000Z").is_ok());
    for bad in ["", "../escape", "a/b", "-flag", "a b", "a.b"] {
        assert!(validate_run_id(bad).is_err(), "{bad:?} must be rejected");
    }
}

#[test]
fn save_refuses_invalid_run_id() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "ok1",
        Phase::Created,
    );
    record.run_id = "../escape".to_string();
    assert!(record.save(&repo).is_err());
}

#[test]
fn receipts_serialize_to_stable_parseable_json() {
    let mut receipt = Receipt::new(
        "prepare",
        "run1",
        ReceiptResult::Ready,
        "ready",
        "2026-08-12T16:00:00Z".to_string(),
    );
    receipt.next_action = "attach".to_string();
    receipt
        .outcomes
        .insert("build".to_string(), "ok".to_string());
    receipt.timings_ms.insert("total".to_string(), 1234);
    receipt.commands_executed = 42;
    let json = receipt.to_json();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["schema"], RECEIPT_SCHEMA);
    assert_eq!(value["verb"], "prepare");
    assert_eq!(value["result"], "ready");
    assert_eq!(value["run_id"], "run1");
    assert_eq!(value["commands_executed"], 42);
    assert_eq!(value["timings_ms"]["total"], 1234);
    assert!(
        value.get("failure").is_none(),
        "absent failure must not serialize"
    );

    let parsed: Receipt = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.result, ReceiptResult::Ready);
}

#[test]
fn failure_receipts_carry_bounded_codes_and_next_action() {
    let mut receipt = Receipt::new(
        "cleanup",
        "run2",
        ReceiptResult::Refused,
        "ready",
        "2026-08-12T16:00:00Z".to_string(),
    );
    receipt.failure = Some(qaren::failure::Failure::new(
        "cleanup",
        FailureCode::OwnershipUnproven,
        "simulator renamed",
        "resolve manually",
    ));
    receipt.next_action = "resolve manually".to_string();
    let value: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
    assert_eq!(value["failure"]["code"], "OWNERSHIP_UNPROVEN");
    assert_eq!(value["result"], "refused");
    assert_eq!(value["failure"]["next_action"], "resolve manually");
    assert_eq!(value["next_action"], "resolve manually");
}
