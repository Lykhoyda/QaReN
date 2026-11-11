mod common;

use qaren::failure::FailureCode;
use qaren::receipt::{Receipt, ReceiptResult, RECEIPT_SCHEMA};
use qaren::runrecord::{validate_run_id, Phase, RunRecord, RUN_SCHEMA};

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
        ..Default::default()
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

#[test]
fn borrowed_ios_stop_transitions_and_load_validation_require_canonical_borrowed_ios_target() {
    use qaren::runrecord::{BorrowedIosStop, IosSimResource, Resources};
    let udid = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let sim = IosSimResource {
        udid: udid.into(),
        name: "selected".into(),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17".into(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5".into(),
        ..Default::default()
    };
    let mut resources = Resources::default();
    assert_eq!(resources.borrowed_ios_stop(), BorrowedIosStop::NotArmed);
    assert!(resources.can_release_borrowed_ios_stop());
    assert!(resources.arm_borrowed_ios_stop().is_err());
    assert!(resources.complete_borrowed_ios_stop(udid).is_err());

    resources.device_borrowed = true;
    assert!(resources.arm_borrowed_ios_stop().is_err());
    resources.ios_simulator = Some(IosSimResource {
        udid: udid.to_lowercase(),
        ..sim.clone()
    });
    assert!(resources.arm_borrowed_ios_stop().is_err());

    resources.ios_simulator = Some(sim.clone());
    assert!(resources.arm_borrowed_ios_stop().is_err());
    resources.lease = Some(qaren::lease::Lease {
        run_id: "borrowed-stop".into(),
        token: "token".into(),
        lock_dir: std::path::PathBuf::from("/tmp/qaren-borrowed-stop"),
        holder: "holder".into(),
        released_orphan: None,
    });
    resources.arm_borrowed_ios_stop().unwrap();
    assert_eq!(resources.borrowed_ios_stop(), BorrowedIosStop::Pending);
    assert!(!resources.can_release_borrowed_ios_stop());
    assert!(resources.arm_borrowed_ios_stop().is_err());
    assert!(resources
        .complete_borrowed_ios_stop("76709EFC-0104-4A66-8908-F4F85A76F025")
        .is_err());
    assert_eq!(resources.borrowed_ios_stop(), BorrowedIosStop::Pending);

    resources.complete_borrowed_ios_stop(udid).unwrap();
    assert_eq!(resources.borrowed_ios_stop(), BorrowedIosStop::Completed);
    assert!(resources.can_release_borrowed_ios_stop());
    assert!(resources.complete_borrowed_ios_stop(udid).is_err());
    assert!(resources.arm_borrowed_ios_stop().is_err());

    resources.revert_borrowed_ios_stop(BorrowedIosStop::Pending);
    assert_eq!(resources.borrowed_ios_stop(), BorrowedIosStop::Pending);

    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "borrowed-stop",
        Phase::Ready,
    );
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(sim.clone());
    record.resources.lease = Some(qaren::lease::Lease {
        run_id: "borrowed-stop".into(),
        token: "token".into(),
        lock_dir: repo.join("locks"),
        holder: "holder".into(),
        released_orphan: None,
    });
    record.save(&repo).unwrap();
    let default_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(RunRecord::path(&repo, "borrowed-stop")).unwrap())
            .unwrap();
    assert!(default_json["resources"].get("borrowed_ios_stop").is_none());
    let loaded = RunRecord::load(&repo, "borrowed-stop").unwrap();
    assert_eq!(
        loaded.resources.borrowed_ios_stop(),
        BorrowedIosStop::NotArmed
    );

    record.resources.arm_borrowed_ios_stop().unwrap();
    record.save(&repo).unwrap();
    let pending_json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(RunRecord::path(&repo, "borrowed-stop")).unwrap())
            .unwrap();
    assert_eq!(pending_json["resources"]["borrowed_ios_stop"], "pending");
    assert_eq!(
        RunRecord::load(&repo, "borrowed-stop")
            .unwrap()
            .resources
            .borrowed_ios_stop(),
        BorrowedIosStop::Pending
    );

    for mutation in [
        "not_borrowed",
        "missing_sim",
        "lowercase_udid",
        "empty_runtime",
        "android_platform",
    ] {
        let mut bad = pending_json.clone();
        match mutation {
            "not_borrowed" => bad["resources"]["device_borrowed"] = false.into(),
            "missing_sim" => {
                bad["resources"]
                    .as_object_mut()
                    .unwrap()
                    .remove("ios_simulator");
            }
            "lowercase_udid" => {
                bad["resources"]["ios_simulator"]["udid"] = udid.to_lowercase().into();
            }
            "empty_runtime" => {
                bad["resources"]["ios_simulator"]["runtime"] = "".into();
            }
            "android_platform" => {
                bad["scenario"]["platform"] = "android".into();
            }
            _ => unreachable!(),
        }
        std::fs::write(
            RunRecord::path(&repo, "borrowed-stop"),
            serde_json::to_vec(&bad).unwrap(),
        )
        .unwrap();
        assert_eq!(
            RunRecord::load(&repo, "borrowed-stop").unwrap_err().code,
            FailureCode::RunRecordInvalid,
            "{mutation}"
        );
    }
}

#[test]
fn receipt_hints_are_optional_and_use_the_durable_redaction_owner() {
    let mut receipt = Receipt::new(
        "check",
        "hints",
        ReceiptResult::Pass,
        "complete",
        "now".into(),
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(&receipt.to_json())
            .unwrap()
            .get("hints")
            .is_none()
    );
    receipt.hints.push(qaren::receipt::Hint {
        code: "LOGIN_BLOCK_CANDIDATE".into(),
        text: "selector sentinel-value-123".into(),
    });
    let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries([(
        "QAREN_INPUT_PASSWORD".into(),
        "sentinel-value-123".into(),
    )]));
    let raw = qaren::redact::with_input_scope(inputs, || receipt.to_json());
    assert!(!raw.contains("sentinel-value-123"));
    let parsed: Receipt = serde_json::from_str(&raw).unwrap();
    assert_eq!(parsed.hints.len(), 1);
    assert_eq!(parsed.hints[0].code, "LOGIN_BLOCK_CANDIDATE");
    assert_eq!(parsed.next_action, receipt.next_action);
}

#[test]
fn receipts_and_records_from_before_build_lock_observation_still_load() {
    let old = r#"{"schema":"qaren/1","verb":"prepare","run_id":"r1","result":"refused","phase":"failed","emitted_at":"now","commands_executed":0,"failure":{"phase":"plan","code":"BUILD_CONTENDED","detail":"held","next_action":"wait"},"next_action":"wait"}"#;
    let parsed: Receipt = serde_json::from_str(old).unwrap();
    assert!(parsed.build_lock.is_none() && parsed.recovery.is_none());
    assert!(parsed.failure.unwrap().recovery.is_none());
    let record = common::base_record(
        std::path::Path::new("/s"),
        &common::ios_scenario_yaml(8791),
        "r1",
        Phase::Failed,
    );
    let mut value = serde_json::to_value(&record).unwrap();
    assert!(value.get("build_lock").is_none(), "absent until observed");
    value.as_object_mut().unwrap().remove("build_lock");
    let reloaded: RunRecord = serde_json::from_value(value).unwrap();
    assert!(reloaded.build_lock.is_none());
}

#[test]
fn build_failure_recovery_keeps_its_wire_shape_and_owned_cleanup() {
    use qaren::failure::{Failure, Recovery, RecoveryReason};
    let failure =
        Failure::cancelled("build", "stopped").with_recovery(RecoveryReason::RunCancelled);
    let value = serde_json::to_value(&failure).unwrap();
    assert_eq!(
        value["recovery"],
        serde_json::to_value(Recovery::new(RecoveryReason::RunCancelled)).unwrap()
    );
    let mut restored: Failure = serde_json::from_value(value).unwrap();
    restored.recovery = restored
        .recovery
        .take()
        .map(|recovery| Box::new(recovery.with_own_cleanup("own-run")));
    let recovery = restored.build_recovery().unwrap();
    assert_eq!(recovery.reason, RecoveryReason::RunCancelled);
    assert_eq!(recovery.next_rung, Some(5));
    assert!(recovery.own_cleanup_required);
    assert_eq!(recovery.own_run_id.as_deref(), Some("own-run"));
}

#[test]
fn press_failure_recovery_round_trips_without_build_metadata() {
    use qaren::failure::Failure;
    let failure = Failure::new(
        "walk",
        FailureCode::PressNotRegistered,
        "unverified",
        "read",
    )
    .with_press_recovery("PRESS_NOT_REGISTERED");
    let value = serde_json::to_value(&failure).unwrap();
    assert_eq!(
        value["recovery"]["action"],
        "rerun_then_ask_app_team_expose_selection_in_row_list"
    );
    assert_eq!(value["recovery"]["ladder"].as_array().unwrap().len(), 5);
    assert!(value["recovery"].get("reason").is_none());
    let restored: Failure = serde_json::from_value(value.clone()).unwrap();
    assert!(restored.build_recovery().is_none());
    let recovery = restored.recovery.unwrap().with_own_cleanup("own-run");
    assert_eq!(serde_json::to_value(recovery).unwrap(), value["recovery"]);
}

const ALL_PHASES: [Phase; 9] = [
    Phase::Created,
    Phase::DepsInstalled,
    Phase::ResourcesAllocated,
    Phase::Building,
    Phase::Ready,
    Phase::Walking,
    Phase::HandedOff,
    Phase::Failed,
    Phase::Cleaned,
];

fn state_terminal(cancelled: bool) -> qaren::runrecord::TerminalResult {
    qaren::runrecord::TerminalResult {
        verdict: "FAIL".into(),
        cancelled,
        final_verification: qaren::runrecord::FinalVerification {
            tested: "b".repeat(40),
            matched: true,
            detail: None,
            classification: None,
        },
        ownership_proven: true,
    }
}

fn state_held() -> qaren::runrecord::Held {
    qaren::runrecord::Held {
        since: "2026-11-10T10:00:00Z".into(),
        reason: "the walk failed".into(),
        retained: vec!["metro".into(), "lease".into()],
    }
}

fn state_record() -> RunRecord {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "state1",
        Phase::Created,
    )
}

#[test]
fn run_state_follows_the_derivation_table() {
    use qaren::runrecord::{Cleanup, RunState};
    let base = state_record();
    let terminal = state_terminal(false);
    let held = state_held();
    let record = |phase,
                  terminal: Option<&qaren::runrecord::TerminalResult>,
                  held: Option<&qaren::runrecord::Held>| {
        let mut record = base.clone();
        record.phase = phase;
        record.terminal = terminal.cloned();
        record.held = held.cloned();
        record
    };
    let ended = |walked, cleanup| RunState::Ended { walked, cleanup };
    let t = Some(&terminal);
    let h = Some(&held);
    let rows = [
        (1, record(Phase::Cleaned, t, h), ended(t, Cleanup::Clean)),
        (
            1,
            record(Phase::Cleaned, None, None),
            ended(None, Cleanup::Clean),
        ),
        (2, record(Phase::Failed, t, h), ended(t, Cleanup::Owed)),
        (
            2,
            record(Phase::Failed, None, None),
            ended(None, Cleanup::Owed),
        ),
        (
            3,
            record(Phase::Walking, t, h),
            ended(t, Cleanup::Held(&held)),
        ),
        (
            3,
            record(Phase::Walking, None, h),
            ended(None, Cleanup::Held(&held)),
        ),
        (4, record(Phase::Walking, t, None), ended(t, Cleanup::Owed)),
        (5, record(Phase::Walking, None, None), RunState::Walking),
        (6, record(Phase::Ready, t, h), ended(t, Cleanup::Owed)),
        (
            6,
            record(Phase::HandedOff, t, None),
            ended(t, Cleanup::Owed),
        ),
        (6, record(Phase::Building, t, None), ended(t, Cleanup::Owed)),
        (7, record(Phase::Ready, None, h), RunState::Ready),
        (8, record(Phase::HandedOff, None, h), RunState::HandedOff),
        (9, record(Phase::Created, None, h), RunState::Preparing),
        (
            9,
            record(Phase::DepsInstalled, None, None),
            RunState::Preparing,
        ),
        (
            9,
            record(Phase::ResourcesAllocated, None, None),
            RunState::Preparing,
        ),
        (9, record(Phase::Building, None, None), RunState::Preparing),
    ];
    for (row, record, expected) in &rows {
        assert_eq!(
            record.state(),
            *expected,
            "row {row}: {:?} terminal={} held={}",
            record.phase,
            record.terminal.is_some(),
            record.held.is_some()
        );
    }
}

// Each moved reader's expression before and after RunRecord::state(), over every field combination.
#[test]
fn run_state_readers_answer_as_the_field_expressions_did() {
    use qaren::runrecord::{Cleanup, RunState};
    let base = state_record();
    let mut checked = 0;
    for phase in ALL_PHASES {
        for terminal in [
            None,
            Some(state_terminal(false)),
            Some(state_terminal(true)),
        ] {
            for held in [None, Some(state_held())] {
                let mut r = base.clone();
                r.phase = phase;
                r.terminal = terminal.clone();
                r.held = held.clone();
                let case = format!(
                    "{phase:?} terminal={:?} held={}",
                    r.terminal.as_ref().map(|t| t.cancelled),
                    r.held.is_some()
                );

                // commands/prepare.rs ready_holder
                let old = matches!(r.phase, Phase::Ready | Phase::Walking | Phase::HandedOff)
                    && r.terminal.is_none();
                let new = matches!(
                    r.state(),
                    RunState::Ready
                        | RunState::HandedOff
                        | RunState::Walking
                        | RunState::Ended {
                            walked: None,
                            cleanup: Cleanup::Held(_)
                        }
                );
                assert_eq!(old, new, "ready_holder: {case}");

                // commands/status.rs hold note
                let old = r.held.as_ref().filter(|_| r.phase == Phase::Walking);
                let new = match r.state() {
                    RunState::Ended {
                        cleanup: Cleanup::Held(held),
                        ..
                    } => Some(held),
                    _ => None,
                };
                assert_eq!(old, new, "status hold note: {case}");

                // commands/doctor.rs hold note
                let old = r.held.clone().filter(|_| r.phase == Phase::Walking);
                let new = (|| {
                    let RunState::Ended {
                        cleanup: Cleanup::Held(held),
                        ..
                    } = r.state()
                    else {
                        return None;
                    };
                    Some(held)
                })();
                assert_eq!(old.as_ref(), new, "doctor hold note: {case}");

                // publish.rs final result
                let old = r.terminal.clone();
                let new = match r.state() {
                    RunState::Ended {
                        walked: Some(terminal),
                        ..
                    } => Some(terminal),
                    _ => None,
                };
                assert_eq!(old.as_ref(), new, "publish: {case}");

                // watch.rs terminal flag, on its Option<RunRecord>
                let record = Some(r.clone());
                let old = record.as_ref().is_some_and(|r| r.terminal.is_some());
                let new = record.as_ref().is_some_and(|r| {
                    matches!(
                        r.state(),
                        RunState::Ended {
                            walked: Some(_),
                            ..
                        }
                    )
                });
                assert_eq!(old, new, "watch: {case}");

                checked += 1;
            }
        }
    }
    assert_eq!(checked, 54);
}
