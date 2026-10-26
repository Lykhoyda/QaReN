mod common;

use qaren::failure::Failure;
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::redact::{OutputText, PRIVATE_KEY_WITHHELD};
use qaren::runrecord::{Phase, RunRecord};

const BODY: &str = "FAKEKEYBODY";
const KEY: &str = "-----BEGIN PRIVATE KEY-----\nFAKEKEYBODY\n-----END PRIVATE KEY-----";

fn output(raw: &str) -> OutputText {
    OutputText::from_output(raw)
}

fn raw_failure() -> Failure {
    serde_json::from_value(serde_json::json!({
        "phase": "allocate", "code": "TUNNEL_FAILED",
        "detail": format!("{BODY}1 -----end private key-----"),
        "evidence": ["clean", format!("PRIVATE KEY {BODY}2")],
        "next_action": format!("<redacted private key> {BODY}3"),
    }))
    .unwrap()
}

#[test]
fn run_json_and_receipts_withhold_key_strings_a_writer_did_not_redact() {
    let dir = common::temp_repo();
    let mut record = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "sinkrun",
        Phase::Failed,
    );
    record.failure = Some(raw_failure());
    record.save(&dir).unwrap();
    let mut receipt = Receipt::new(
        "prepare",
        "sinkrun",
        ReceiptResult::Failed,
        "allocate",
        String::new(),
    );
    receipt.failure = Some(raw_failure());
    receipt.next_action = format!("Private Key {BODY}4");
    let recorded = std::fs::read_to_string(RunRecord::path(&dir, "sinkrun")).unwrap();
    for durable in [recorded, receipt.to_json()] {
        assert!(!durable.contains(BODY), "{durable}");
        assert!(durable.contains(PRIVATE_KEY_WITHHELD), "{durable}");
        assert!(durable.contains("\"clean\""), "{durable}");
    }
    let reloaded = RunRecord::load(&dir, "sinkrun").unwrap();
    assert_eq!(reloaded.failure.unwrap().detail, PRIVATE_KEY_WITHHELD);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn operational_paths_survive_sinks_and_cleanup_releases_the_real_lock() {
    use qaren::exec::MockRunner;
    use qaren::scenario::Platform;
    let dir = common::temp_repo();
    let sensitive_dir = dir.join("Private Key qa");
    std::fs::create_dir(&sensitive_dir).unwrap();
    let locks = sensitive_dir.join("locks");
    let runs = dir.join("runs");
    std::os::unix::fs::symlink(&sensitive_dir, &runs).unwrap();
    let sdk = dir.join("sdk/platform-tools");
    std::fs::create_dir_all(&sdk).unwrap();
    let adb = sdk.join("adb");
    std::fs::write(sensitive_dir.join("adb"), "executable").unwrap();
    std::os::unix::fs::symlink(sensitive_dir.join("adb"), &adb).unwrap();
    let mut mock = MockRunner::new();
    mock.environment.insert(
        "QAREN_LOCK_ROOT".into(),
        locks.to_string_lossy().into_owned(),
    );
    let mut record = common::base_record(
        &sensitive_dir,
        &common::ios_scenario_yaml(8793),
        "identity",
        Phase::Failed,
    );
    let mut owner = std::process::Command::new("sh")
        .args(["-c", "exec sleep 30"])
        .spawn()
        .unwrap();
    let lease = qaren::lease::acquire(
        &mut mock,
        &locks,
        Platform::Ios,
        "device",
        "identity",
        Some(common::identity(owner.id() as i32, "birth")),
    )
    .unwrap();
    let actual_lock = lease.lock_dir.clone();
    record.resources.lease = Some(lease);
    record.resources.adb_path = Some(adb.clone());
    record.save(&runs).unwrap();
    let stored = RunRecord::load(&runs, "identity").unwrap();
    assert_eq!(stored.resources.lease.unwrap().lock_dir, actual_lock);
    assert_eq!(stored.resources.adb_path.unwrap(), adb);
    assert_eq!(stored.candidate.repo_root, sensitive_dir);
    assert!(actual_lock.is_dir());
    owner.kill().unwrap();
    owner.wait().unwrap();
    let receipt = qaren::commands::cleanup::cleanup(&mut mock, &runs, "identity");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(!actual_lock.exists());
    assert!(RunRecord::load(&runs, "identity")
        .unwrap()
        .resources
        .lease
        .is_none());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn output_fields_mask_on_load_and_keep_the_json_string_contract() {
    let dir = common::temp_repo();
    let mut record =
        common::base_record(&dir, &common::ios_scenario_yaml(8793), "load", Phase::Ready);
    record.push_history("now".into(), "plain");
    let mut value = serde_json::to_value(&record).unwrap();
    value["failure"] = serde_json::json!({"phase": "build", "code": "BUILD_FAILED", "detail": KEY, "evidence": [KEY], "next_action": KEY});
    value["prepare"]["command"] = serde_json::json!(KEY);
    value["history"][0]["note"] = serde_json::json!(KEY);
    value["build"]["reason"] = serde_json::json!(KEY);
    value["build"]["evidence"] = serde_json::json!([KEY]);
    value["resources"]["app_install"] = serde_json::json!({
        "app_id": "app", "serial": "serial", "server_port": 5037,
        "artifact": {"path": dir.join("app.apk"), "sha256": "sha", "kind": "apk"},
        "via": "expo-run-android", "installed_at": "now",
        "removal": {"at": "now", "installed_sha256": "sha", "outcome": KEY,
            "uninstall": KEY, "pm_path_after": KEY, "package_list_after": KEY}
    });
    let file = RunRecord::path(&dir, "load");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let original = serde_json::to_string(&value).unwrap();
    std::fs::write(&file, &original).unwrap();
    let loaded = RunRecord::load(&dir, "load").unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
    loaded.save(&dir).unwrap();
    let durable = std::fs::read_to_string(&file).unwrap();
    assert!(!durable.contains(BODY));
    let value: serde_json::Value = serde_json::from_str(&durable).unwrap();
    for pointer in [
        "/failure/detail",
        "/failure/evidence/0",
        "/failure/next_action",
        "/prepare/command",
        "/history/0/note",
        "/build/reason",
        "/build/evidence/0",
        "/resources/app_install/removal/outcome",
        "/resources/app_install/removal/uninstall",
        "/resources/app_install/removal/pm_path_after",
        "/resources/app_install/removal/package_list_after",
    ] {
        assert_eq!(
            value.pointer(pointer).unwrap().as_str(),
            Some(PRIVATE_KEY_WITHHELD)
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn cache_handoff_and_native_suite_writers_preserve_identity_and_mask_output() {
    use qaren::buildplan::{self, ArtifactKind, CachedArtifact, DepsPrewarm, NativeCacheState};
    use qaren::handoff::{ExpectedReceipt, HandoffDocument};
    use qaren::native_suite::{CleanupEvidence, NativeSuite, SuiteProcess};
    let dir = common::temp_repo();
    let identity = dir.join("private key/cache");
    std::fs::create_dir_all(&identity).unwrap();
    std::fs::create_dir_all(dir.join(".qaren")).unwrap();
    std::os::unix::fs::symlink(&identity, buildplan::cache_dir(&dir)).unwrap();
    let state = NativeCacheState {
        schema: buildplan::CACHE_SCHEMA.into(),
        fingerprint_parts: Default::default(),
        platform: "ios".into(),
        app_id: "app".into(),
        worktree_root: identity.clone(),
        fingerprint: "fp".into(),
        built_at: "now".into(),
        candidate_sha: "sha".into(),
        lockfile_sha256: "sha".into(),
        generated_native_dirs: Vec::new(),
        artifact: Some(CachedArtifact {
            path: identity.join("app"),
            sha256: "sha".into(),
            kind: ArtifactKind::AppBundle,
        }),
    };
    let cache_path = buildplan::state_path(&dir, "ios", "app");
    buildplan::save_json(&cache_path, &state).unwrap();
    let loaded: NativeCacheState =
        serde_json::from_slice(&std::fs::read(&cache_path).unwrap()).unwrap();
    assert_eq!(loaded.worktree_root, identity);
    assert_eq!(loaded.artifact.unwrap().path, identity.join("app"));
    let prewarm = DepsPrewarm {
        schema: buildplan::PREWARM_SCHEMA.into(),
        worktree_root: identity.clone(),
        project_root: identity.clone(),
        lockfile_sha256: "sha".into(),
        at: "now".into(),
    };
    let path = buildplan::prewarm_path(&dir);
    buildplan::save_json(&path, &prewarm).unwrap();
    assert_eq!(
        serde_json::from_slice::<DepsPrewarm>(&std::fs::read(path).unwrap())
            .unwrap()
            .project_root,
        identity
    );
    let record = common::base_record(
        &identity,
        &common::ios_scenario_yaml(8793),
        "handoff",
        Phase::HandedOff,
    );
    let document = HandoffDocument {
        schema: qaren::handoff::HANDOFF_SCHEMA.into(),
        run_id: "handoff".into(),
        issued_at: "now".into(),
        candidate: record.candidate,
        platform: "ios".into(),
        device: qaren::commands::device_identity(&common::base_record(
            &dir,
            &common::ios_scenario_yaml(8793),
            "handoff",
            Phase::HandedOff,
        )),
        native_fingerprint: "fp".into(),
        fingerprint_complete: false,
        fingerprint_incompleteness: vec![output(KEY)],
        expected_receipt: ExpectedReceipt {
            platform: "ios".into(),
            device_id: "device".into(),
            app_id: "app".into(),
            worktree_key: "key".into(),
            app_root_key: "key".into(),
        },
    };
    let path = dir.join("handoff.json");
    qaren::handoff::save_document(&path, &document).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(!raw.contains(BODY));
    let loaded: HandoffDocument = serde_json::from_str(&raw).unwrap();
    assert_eq!(loaded.candidate.repo_root, identity);
    assert_eq!(loaded.fingerprint_incompleteness[0], PRIVATE_KEY_WITHHELD);
    let mut owner = common::identity(999, "birth");
    owner.command = output(KEY);
    let suite = NativeSuite {
        schema: "qaren-native-suite/1".into(),
        run_id: "native-ios-1".into(),
        device_id: "device".into(),
        owner,
        lock_dir: identity.join("lock"),
        lease: None,
        process: SuiteProcess::NotSpawned,
        suite_exit: None,
        cleanup: Some(CleanupEvidence {
            group: output(KEY),
            admission_clear: false,
            runner_host: Some(output(KEY)),
        }),
    };
    let path = dir.join("suite.json");
    buildplan::save_json(&path, &suite).unwrap();
    let raw = std::fs::read_to_string(path).unwrap();
    assert!(!raw.contains(BODY));
    assert_eq!(
        serde_json::from_str::<NativeSuite>(&raw).unwrap().lock_dir,
        identity.join("lock")
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn native_recovery_through_a_phrase_named_symlink_releases_the_real_lease() {
    use qaren::exec::{CmdOutput, MockRunner};
    use qaren::native_suite::{NativeSuite, SuiteProcess};
    use qaren::scenario::Platform;
    let dir = common::temp_repo();
    let destination = dir.join("Private Key qa");
    std::fs::create_dir_all(&destination).unwrap();
    let locks = destination.join("locks");
    std::fs::create_dir(&locks).unwrap();
    let locks = locks.canonicalize().unwrap();
    std::fs::create_dir_all(dir.join(".qaren/native-suites")).unwrap();
    let suite_dir = dir.join(".qaren/native-suites/native-ios-1");
    std::os::unix::fs::symlink(&destination, &suite_dir).unwrap();
    let mut mock = MockRunner::new();
    mock.environment
        .insert("HOME".into(), dir.to_string_lossy().into_owned());
    mock.environment.insert(
        "QAREN_LOCK_ROOT".into(),
        locks.to_string_lossy().into_owned(),
    );
    let owner = common::identity(999, "birth");
    let device = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let lease = qaren::lease::acquire(
        &mut mock,
        &locks,
        Platform::Ios,
        device,
        "native-ios-1",
        Some(owner.clone()),
    )
    .unwrap();
    let lock_dir = lease.lock_dir.clone();
    let suite = NativeSuite {
        schema: "qaren-native-suite/1".into(),
        run_id: "native-ios-1".into(),
        device_id: device.into(),
        owner,
        lock_dir: lock_dir.clone(),
        lease: Some(lease),
        process: SuiteProcess::NotSpawned,
        suite_exit: None,
        cleanup: None,
    };
    qaren::buildplan::save_json(&suite_dir.join("suite.json"), &suite).unwrap();
    mock.expect_run(
        "ps",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let recovered = qaren::native_suite::recover(&mut mock, "native-ios-1").unwrap();
    assert_eq!(recovered.lock_dir, lock_dir);
    assert!(!lock_dir.exists());
    assert_eq!(recovered.cleanup.unwrap().group, "not_spawned");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn raw_command_output_and_unmasked_strings_cannot_be_serialized_as_output_text() {
    trait AmbiguousIfImpl<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousIfImpl<()> for T {}
    struct Serializable;
    impl<T: ?Sized + serde::Serialize> AmbiguousIfImpl<Serializable> for T {}
    let _ = <qaren::exec::CmdOutput as AmbiguousIfImpl<_>>::check;
    trait AmbiguousIfFromString<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousIfFromString<()> for T {}
    struct FromString;
    impl<T: From<String>> AmbiguousIfFromString<FromString> for T {}
    let _ = <OutputText as AmbiguousIfFromString<_>>::check;
    assert_eq!(output(KEY), PRIVATE_KEY_WITHHELD);
    let loaded: OutputText = serde_json::from_str(&serde_json::to_string(KEY).unwrap()).unwrap();
    assert_eq!(loaded, PRIVATE_KEY_WITHHELD);
    assert_eq!(
        serde_json::to_string(&loaded).unwrap(),
        serde_json::to_string(PRIVATE_KEY_WITHHELD).unwrap()
    );
}

#[test]
fn evidence_documents_and_reports_still_withhold_opaque_output() {
    let dir = common::temp_repo();
    let ledger = qaren::core::Ledger {
        verdict: "FAIL".into(),
        video_publication: None,
        media_withheld: None,
        admitted_at_ms: None,
        publish_from_ms: None,
        publication_interrupted: false,
        path: "walk".into(),
        blocks: Vec::new(),
        blocks_written: None,
        steps: Vec::new(),
        jev: Default::default(),
        llm_turns: 0,
        escapes: 0,
        recoveries: 0,
        speed: None,
        recipe: None,
        failure: Some(qaren::core::LedgerFailure {
            step: 1,
            seen: KEY.into(),
            screenshot: None,
            kind: None,
        }),
    };
    let path = dir.join("ledger.json");
    std::fs::write(&path, qaren::redact::durable_json(&ledger).unwrap()).unwrap();
    assert!(!std::fs::read_to_string(path).unwrap().contains(BODY));
    let report = qaren::report::write(
        &dir,
        &qaren::report::ReportInput {
            run_id: "evidence",
            platform: "ios",
            app_id: "app",
            device: "device",
            ledger: &ledger,
        },
    )
    .unwrap();
    assert!(!std::fs::read_to_string(report).unwrap().contains(BODY));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn withholding_codes_survive_input_collisions_without_exempting_free_text() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    for input in [
        "input",
        "echo",
        "generic-value",
        "other",
        "reason",
        "source",
        "steps",
        "mediaWithheld",
        "screenshotWithheld",
        "outcomes",
        "media_withheld",
    ] {
        with_input_scope(
            Arc::new(InputValues::from_entries([(
                OsString::from("QAREN_INPUT_PASSWORD"),
                OsString::from(input),
            )])),
            || {
                let ledger: qaren::core::Ledger = serde_json::from_value(serde_json::json!({
                "verdict":"PASS", "path":"walk", "blocks":[],
                "steps":[{"block":"qa","line":1,"attempt":1,"kind":"check","resolvedBy":"exact","t":1,"outcome":"pass","screenshotWithheld":"runtime-input"}],
                "jev":{"calls":0,"medianMs":0}, "llmTurns":0,"escapes":0,"recoveries":0,
                "mediaWithheld":{"screenshots":{"reason":"generic-value","kind":"input","line":0,"count":1},"video":{"reason":"echo","source":"input","line":1}},
                "failure":{"step":1,"seen":format!("untrusted {input}")}
            })).unwrap();
                let stored = qaren::redact::durable_json(&ledger).unwrap();
                let loaded: qaren::core::Ledger = serde_json::from_str(&stored).unwrap();
                assert_eq!(loaded.media_withheld, ledger.media_withheld, "{input}");
                assert_eq!(
                    loaded.steps[0].screenshot_withheld, ledger.steps[0].screenshot_withheld,
                    "{input}"
                );
                assert_eq!(loaded.failure.unwrap().seen, "untrusted [REDACTED_INPUT]");
                let mut receipt = Receipt::new(
                    "check",
                    "collision",
                    ReceiptResult::Pass,
                    "verify",
                    String::new(),
                );
                let note = ledger
                    .media_withheld
                    .as_ref()
                    .unwrap()
                    .screenshots
                    .as_ref()
                    .unwrap()
                    .receipt_note();
                receipt
                    .outcomes
                    .insert("media_withheld".into(), note.clone());
                receipt
                    .blocks_not_saved
                    .push(qaren::receipt::BlockNotSaved {
                        block: "qa".into(),
                        reason: input.into(),
                    });
                let stored = receipt.to_json();
                let raw: serde_json::Value = serde_json::from_str(&stored).unwrap();
                assert_eq!(
                    raw.pointer("/outcomes/media_withheld")
                        .and_then(serde_json::Value::as_str),
                    Some(note.as_str()),
                    "{input}"
                );
                assert!(!raw.to_string().contains(&format!("\"reason\":\"{input}\"")));
                let untrusted = serde_json::json!({"reason":input,"outcomes":{"media_withheld":format!("{input} arbitrary text")}});
                let stored = qaren::redact::durable_json(&untrusted).unwrap();
                assert!(stored.contains("[REDACTED_INPUT]"));
            },
        );
    }
}
