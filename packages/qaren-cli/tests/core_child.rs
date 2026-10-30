mod common;

use qaren::core::{self, Budgets, CoreRequest, CoreTarget, Verdict};
use qaren::exec::{CmdOutput, CmdSpec, HoldStdout, MockRunner, PipedChild, Runner, Spawned};
use qaren::failure::FailureCode;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN: &str = "check-20260921T100000Z";

#[test]
fn fresh_admission_command_pins_runtime_node_device_cwd_and_deadline_without_adopting_a_lease() {
    let observer = std::env::current_exe()
        .unwrap()
        .into_os_string()
        .into_string()
        .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "fresh-install-preflight.js",
        CmdOutput::success(r#"{"v":1,"platform":"ios","deviceId":"AAAA-1111","status":"clear"}"#),
    );
    core::fresh_install_admission(
        &mut mock,
        Path::new("/opt/node bin/node"),
        Path::new("/runtime path"),
        Path::new("/app path"),
        "AAAA-1111",
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        mock.calls,
        [CmdSpec::new(
            "fresh-install-admission",
            "/opt/node bin/node",
            &[
                "/runtime path/qa/fresh-install-preflight.js",
                "--platform",
                "ios",
                "--device",
                "AAAA-1111",
                "--process-observer",
                &observer,
            ],
            30
        )
        .cwd(Path::new("/app path"))]
    );
}

#[test]
fn fresh_admission_refusal_reports_only_validated_probe_evidence_and_transport_state() {
    for (evidence, expected) in [
        (
            serde_json::json!({"reason": "driver_identity_unproven", "pid": 20}),
            "driver_identity_unproven",
        ),
        (
            serde_json::json!({"reason": "candidate_budget_exceeded", "candidates": 65}),
            "candidate_budget_exceeded",
        ),
        (
            serde_json::json!({"reason": "/private/diagnostic-secret"}),
            "invalid_evidence",
        ),
        (
            serde_json::json!({"reason": "scan_failed", "command": "/private/diagnostic-secret"}),
            "invalid_evidence",
        ),
        (
            serde_json::json!({"reason": "observer_failed", "pid": 0}),
            "invalid_evidence",
        ),
        (
            serde_json::json!({"reason": "observer_failed", "pid": -1}),
            "invalid_evidence",
        ),
        (
            serde_json::json!({"reason": "candidate_budget_exceeded", "candidates": 1_048_577}),
            "invalid_evidence",
        ),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "fresh-install-preflight.js",
            CmdOutput {
                exit_code: Some(4),
                stdout: serde_json::json!({
                    "v": 1, "platform": "ios", "deviceId": "AAAA-1111", "status": "unknown",
                    "evidence": evidence
                })
                .to_string(),
                stderr: "/private/diagnostic-secret".into(),
                ..Default::default()
            },
        );
        let failure = core::fresh_install_admission(
            &mut mock,
            Path::new("/node"),
            Path::new("/runtime"),
            Path::new("/app"),
            "AAAA-1111",
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::FreshInstallAdmissionUnknown);
        let detail = failure.detail.as_str();
        assert!(detail.contains(expected), "{detail}");
        assert!(detail.contains("probe_status=unknown"));
        assert!(detail.contains("exit_code=Some(4)"));
        assert!(detail.contains("timed_out=false"));
        assert!(!detail.contains("diagnostic-secret"));
    }
}

fn admission_output(status: &str, reason: &str) -> CmdOutput {
    CmdOutput {
        exit_code: Some(if status == "clear" { 0 } else { 4 }),
        stdout: serde_json::json!({"v":1,"platform":"ios","deviceId":"AAAA-1111","status":status,
            "evidence":{"reason":reason,"pid":812}})
        .to_string(),
        ..Default::default()
    }
}

fn admit(
    mock: &mut MockRunner,
    deadline: Option<u64>,
) -> Result<core::AdmissionSummary, qaren::failure::Failure> {
    core::fresh_install_admission(
        mock,
        Path::new("/node"),
        Path::new("/runtime"),
        Path::new("/app"),
        "AAAA-1111",
        None,
        deadline,
    )
}

fn admission_failure_summary(failure: &qaren::failure::Failure) -> serde_json::Value {
    serde_json::from_str(failure.evidence.last().unwrap().as_str()).unwrap()
}

#[test]
fn fresh_admission_reprobe_is_one_new_whole_scan_and_uses_only_the_terminal_verdict() {
    for (output, code, reason) in [
        (admission_output("clear", "scan_failed"), None, "clear"),
        (
            admission_output("unknown", "executable_identity_unproven"),
            Some(FailureCode::FreshInstallAdmissionUnknown),
            "executable_identity_unproven",
        ),
        (
            admission_output("busy", "driver_on_selected_device"),
            Some(FailureCode::DeviceBusy),
            "driver_on_selected_device",
        ),
        (
            admission_output("unknown", "scan_corrupt"),
            Some(FailureCode::FreshInstallAdmissionUnknown),
            "scan_corrupt",
        ),
        (
            CmdOutput::success("malformed"),
            Some(FailureCode::FreshInstallAdmissionUnknown),
            "invalid_response",
        ),
        (
            CmdOutput::success(r#"{"v":1,"platform":"ios","deviceId":"OTHER","status":"clear"}"#),
            Some(FailureCode::FreshInstallAdmissionUnknown),
            "envelope_mismatch",
        ),
        (admission_output("busy", "scan_corrupt"), Some(FailureCode::DeviceBusy), "scan_corrupt"),
        (admission_output("unknown", "scan_unavailable"), Some(FailureCode::FreshInstallAdmissionUnknown), "scan_unavailable"),
        (admission_output("unknown", "observer_unavailable"), Some(FailureCode::FreshInstallAdmissionUnknown), "observer_unavailable"),
        (admission_output("unknown", "observer_failed"), Some(FailureCode::FreshInstallAdmissionUnknown), "observer_failed"),
        (admission_output("unknown", "observer_timeout"), Some(FailureCode::FreshInstallAdmissionUnknown), "observer_timeout"),
        (admission_output("unknown", "scan_failed"), Some(FailureCode::FreshInstallAdmissionUnknown), "scan_failed"),
        (admission_output("unknown", "scan_timeout"), Some(FailureCode::FreshInstallAdmissionUnknown), "scan_timeout"),
        (admission_output("unknown", "candidate_budget_exceeded"), Some(FailureCode::FreshInstallAdmissionUnknown), "candidate_budget_exceeded"),
        (admission_output("unknown", "deadline_exceeded"), Some(FailureCode::FreshInstallAdmissionUnknown), "deadline_exceeded"),
        (admission_output("invalid", "executable_identity_unproven"), Some(FailureCode::FreshInstallAdmissionUnknown), "invalid_status"),
        (CmdOutput { exit_code: Some(4), ..admission_output("clear", "scan_failed") }, Some(FailureCode::FreshInstallAdmissionUnknown), "clear_exit_mismatch"),
        (CmdOutput { stdout: r#"{"v":1,"platform":"ios","deviceId":"AAAA-1111","status":"unknown","evidence":{"reason":"/private/secret"}}"#.into(), ..admission_output("unknown", "scan_failed") }, Some(FailureCode::FreshInstallAdmissionUnknown), "invalid_evidence"),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "fresh-install-preflight.js",
            admission_output("unknown", "executable_identity_unproven"),
        );
        mock.expect_run("fresh-install-preflight.js", output);
        let result = admit(&mut mock, None);
        let summary = match code {
            None => serde_json::to_value(result.unwrap()).unwrap(),
            Some(code) => {
                let failure = result.unwrap_err();
                assert_eq!(failure.code, code);
                assert!(failure
                    .next_action
                    .as_str()
                    .contains("do not signal or adopt"));
                let recovery = failure.build_recovery().unwrap();
                assert!(
                    !recovery.destroys_state && !recovery.requires_user_ok && !recovery.automatic
                );
                if matches!(reason, "executable_identity_unproven" | "driver_on_selected_device") {
                    assert_eq!(recovery.action, qaren::failure::RecoveryAction::WaitForOwner);
                    assert_eq!(recovery.next_rung, Some(0));
                    assert_eq!(
                        recovery.ladder.iter().map(|s| s.rung).collect::<Vec<_>>(),
                        vec![0, 1, 2, 3, 4, 5]
                    );
                    assert!(recovery.ladder[1..5].iter().all(|s| !s.applicable));
                } else {
                    assert_eq!(recovery.action, qaren::failure::RecoveryAction::RestoreProcessObservation);
                    assert_eq!(recovery.reason, qaren::failure::RecoveryReason::IdentityUnavailable);
                    assert_eq!(recovery.next_rung, Some(1));
                    assert!(failure.next_action.contains("qaren doctor"));
                    assert!(!failure.next_action.contains("wait for the foreign"));
                }
                admission_failure_summary(&failure)
            }
        };
        assert_eq!(summary["initialReason"], "executable_identity_unproven");
        assert_eq!(summary["terminalReason"], reason);
        assert_eq!(summary["attempts"], 2);
        assert_eq!(summary["elapsedMs"], 500);
        assert_eq!(summary["deadlineExceeded"], false);
        let mut retry_spec = mock.calls[0].clone();
        retry_spec.timeout_seconds = 29;
        assert_eq!(
            retry_spec, mock.calls[1],
            "the same whole-device scan runs again, with no PID adoption"
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn fresh_admission_reprobe_requires_a_matching_typed_identity_refusal_with_a_pid() {
    let identity = admission_output("unknown", "executable_identity_unproven");
    let mut cases = vec![
        admission_output("busy", "driver_on_selected_device"),
        admission_output("unknown", "driver_identity_unproven"),
        CmdOutput::success("malformed"),
    ];
    for (key, value) in [
        ("v", serde_json::json!(2)),
        ("platform", serde_json::json!("android")),
        ("deviceId", serde_json::json!("OTHER")),
        ("status", serde_json::json!("invalid")),
        (
            "evidence",
            serde_json::json!({"reason":"executable_identity_unproven"}),
        ),
        (
            "evidence",
            serde_json::json!({"reason":"executable_identity_unproven","pid":0}),
        ),
        (
            "evidence",
            serde_json::json!({"reason":"executable_identity_unproven","pid":812,"argv":"private"}),
        ),
    ] {
        let mut output = identity.clone();
        let mut v: serde_json::Value = serde_json::from_str(&output.stdout).unwrap();
        v[key] = value;
        output.stdout = v.to_string();
        cases.push(output);
    }
    let mut wrong_exit = identity.clone();
    wrong_exit.exit_code = Some(0);
    cases.push(wrong_exit);
    let mut timeout = identity;
    timeout.timed_out = true;
    cases.push(timeout);
    for (index, output) in cases.into_iter().enumerate() {
        let mut mock = MockRunner::new();
        mock.expect_run("fresh-install-preflight.js", output);
        let failure = admit(&mut mock, None).unwrap_err();
        assert_eq!(
            failure.build_recovery().unwrap().action,
            if index < 2 {
                qaren::failure::RecoveryAction::WaitForOwner
            } else {
                qaren::failure::RecoveryAction::RestoreProcessObservation
            }
        );
        assert_eq!(admission_failure_summary(&failure)["attempts"], 1);
        assert_eq!(mock.calls.len(), 1);
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn fresh_admission_reprobe_shares_the_original_allowance_and_rejects_late_results() {
    for (allowance, per_read, expected_attempts, terminal, elapsed) in [
        (30_000, 10_000, 2, "clear", 20_500),
        (30_000, 15_000, 2, "deadline_exceeded", 30_500),
        (60_000, 15_000, 2, "deadline_exceeded", 30_500),
        (30_000, 30_000, 1, "deadline_exceeded", 30_000),
        (600, 100, 1, "deadline_exceeded", 600),
        (700, 100, 2, "deadline_exceeded", 700),
        (0, 0, 0, "deadline_exceeded", 0),
    ] {
        let mut mock = MockRunner::new();
        let start = mock.monotonic_ms();
        mock.advance_on = Some(("fresh-install-preflight.js".into(), per_read));
        if expected_attempts > 0 {
            mock.expect_run(
                "fresh-install-preflight.js",
                admission_output("unknown", "executable_identity_unproven"),
            );
        }
        if expected_attempts == 2 {
            mock.expect_run(
                "fresh-install-preflight.js",
                admission_output("clear", "scan_failed"),
            );
        }
        let result = admit(&mut mock, Some(start + allowance));
        let summary = if terminal == "clear" {
            serde_json::to_value(result.unwrap()).unwrap()
        } else {
            let failure = result.unwrap_err();
            assert_eq!(failure.code, FailureCode::FreshInstallAdmissionUnknown);
            assert_eq!(
                failure.build_recovery().unwrap().action,
                qaren::failure::RecoveryAction::RestoreProcessObservation
            );
            assert!(failure.next_action.contains("qaren doctor"));
            assert!(failure.detail.contains("admission allowance expired"));
            assert!(failure.detail.contains("deadline_exceeded=true"));
            if allowance == 0 || allowance == 600 {
                assert!(failure.detail.contains("probe_status=not_run"));
                assert!(failure.detail.contains("timed_out=false"));
                assert!(!failure.detail.contains("invalid_response"));
            }
            admission_failure_summary(&failure)
        };
        assert_eq!(summary["terminalReason"], terminal);
        assert_eq!(summary["attempts"], expected_attempts);
        assert_eq!(summary["elapsedMs"], elapsed);
        assert_eq!(summary["deadlineExceeded"], terminal != "clear");
        assert_eq!(mock.remaining(), 0);
        if expected_attempts > 0 {
            assert_eq!(
                mock.calls[0].timeout_seconds,
                allowance.min(30_000) / 1000
            );
        }
        if expected_attempts == 2 {
            assert_eq!(
                mock.calls[1].timeout_seconds,
                (allowance.min(30_000) - per_read - 500) / 1000
            );
        }
    }
}

#[test]
fn fresh_admission_cancellation_before_scan_after_scan_during_delay_and_after_reprobe_stops() {
    for (cancel_after_ms, reads) in [(0, 0), (100, 1), (300, 1), (700, 2)] {
        let mut mock = MockRunner::new();
        mock.cancel_at_ms = Some((mock.monotonic_ms() + cancel_after_ms, "cancelled".into()));
        mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
        if reads > 0 {
            mock.expect_run(
                "fresh-install-preflight.js",
                admission_output("unknown", "executable_identity_unproven"),
            );
        }
        if reads == 2 {
            mock.expect_run(
                "fresh-install-preflight.js",
                admission_output("clear", "scan_failed"),
            );
        }
        let failure = admit(&mut mock, None).unwrap_err();
        assert_eq!(failure.code, FailureCode::RunCancelled);
        assert_eq!(
            failure.build_recovery().unwrap().reason,
            qaren::failure::RecoveryReason::RunCancelled
        );
        let summary = admission_failure_summary(&failure);
        assert_eq!(summary["attempts"], reads);
        assert_eq!(summary["terminalReason"], "cancelled");
        assert_eq!(mock.remaining(), 0);
        assert_eq!(mock.calls.len(), reads as usize);
    }
}

#[test]
fn fresh_admission_android_busy_without_pid_evidence_waits_for_owner_without_reprobing() {
    let mut mock = MockRunner::new();
    mock.expect_run(
        "fresh-install-preflight.js",
        CmdOutput {
            exit_code: Some(4),
            stdout: r#"{"v":1,"platform":"android","deviceId":"emulator-5554","status":"busy"}"#
                .into(),
            ..Default::default()
        },
    );
    let android = core::AndroidEnv {
        serial: "emulator-5554".into(),
        server_port: 5038,
        platform_tools: "/android/platform-tools".into(),
    };
    let failure = core::fresh_install_admission(
        &mut mock,
        Path::new("/node"),
        Path::new("/runtime"),
        Path::new("/app"),
        "emulator-5554",
        Some(&android),
        None,
    )
    .unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    let recovery = failure.build_recovery().unwrap();
    assert_eq!(
        recovery.reason,
        qaren::failure::RecoveryReason::ForeignAdmissionUnresolved
    );
    assert_eq!(
        recovery.action,
        qaren::failure::RecoveryAction::WaitForOwner
    );
    assert!(failure
        .next_action
        .contains("wait for the foreign process owner"));
    assert_eq!(admission_failure_summary(&failure)["attempts"], 1);
    assert_eq!(mock.calls.len(), 1);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn fresh_admission_android_never_reprobes_ios_identity_evidence() {
    let mut mock = MockRunner::new();
    let mut output = admission_output("unknown", "executable_identity_unproven");
    output.stdout = output
        .stdout
        .replace("ios", "android")
        .replace("AAAA-1111", "emulator-5554");
    mock.expect_run("fresh-install-preflight.js", output);
    let android = core::AndroidEnv {
        serial: "emulator-5554".into(),
        server_port: 5038,
        platform_tools: "/android/platform-tools".into(),
    };
    let failure = core::fresh_install_admission(
        &mut mock,
        Path::new("/node"),
        Path::new("/runtime"),
        Path::new("/app"),
        "emulator-5554",
        Some(&android),
        None,
    )
    .unwrap_err();
    assert_eq!(admission_failure_summary(&failure)["attempts"], 1);
    assert_eq!(mock.calls.len(), 1);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn fresh_admission_closed_summary_survives_runtime_input_word_collisions() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let inputs = Arc::new(InputValues::from_entries([
        (
            OsString::from("QAREN_INPUT_PASSWORD"),
            OsString::from("executable_identity_unproven"),
        ),
        (OsString::from("QAREN_INPUT_CODE"), OsString::from("clear")),
    ]));
    with_input_scope(inputs, || {
        let mut mock = MockRunner::new();
        for _ in 0..2 {
            mock.expect_run(
                "fresh-install-preflight.js",
                admission_output("unknown", "executable_identity_unproven"),
            );
        }
        let failure = admit(&mut mock, None).unwrap_err();
        let summary = admission_failure_summary(&failure);
        assert_eq!(summary["initialReason"], "executable_identity_unproven");
        let json = qaren::redact::durable_json(&failure).unwrap();
        let saved: serde_json::Value = serde_json::from_str(&json).unwrap();
        let summary: serde_json::Value =
            serde_json::from_str(saved["evidence"][0].as_str().unwrap()).unwrap();
        assert_eq!(summary["terminalReason"], "executable_identity_unproven");
        let restored: qaren::failure::Failure = serde_json::from_str(&json).unwrap();
        assert_eq!(
            admission_failure_summary(&restored)["terminalReason"],
            "executable_identity_unproven"
        );
        mock.expect_run(
            "fresh-install-preflight.js",
            admission_output("clear", "scan_failed"),
        );
        let note = admit(&mut mock, None).unwrap().note();
        let receipt = serde_json::json!({"outcomes":{"admission_before_deps":note, "admission_before_mutation":note}, "failure":failure});
        let saved: serde_json::Value =
            serde_json::from_str(&qaren::redact::durable_json(&receipt).unwrap()).unwrap();
        for key in ["admission_before_deps", "admission_before_mutation"] {
            let summary: serde_json::Value =
                serde_json::from_str(saved["outcomes"][key].as_str().unwrap()).unwrap();
            assert_eq!(summary["terminalReason"], "clear");
        }
        let summary: serde_json::Value =
            serde_json::from_str(saved["failure"]["evidence"][0].as_str().unwrap()).unwrap();
        assert_eq!(summary["initialReason"], "executable_identity_unproven");
    });
}

#[test]
fn fresh_admission_projection_never_exempts_unvalidated_note_payloads() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let inputs = Arc::new(InputValues::from_entries([
        (
            OsString::from("QAREN_INPUT_PASSWORD"),
            OsString::from("private-admission-canary"),
        ),
        (OsString::from("QAREN_INPUT_CODE"), OsString::from("clear")),
    ]));
    with_input_scope(inputs, || {
        for field in ["probe", "initialReason", "terminalReason", "extra"] {
            let mut note = serde_json::json!({"probe":"fresh-install-admission","initialReason":"clear","terminalReason":"clear","attempts":1,"elapsedMs":0,"deadlineExceeded":false});
            note[field] = "private-admission-canary".into();
            let note = note.to_string();
            let receipt = serde_json::json!({"outcomes":{"admission_before_deps":note}, "failure":{"evidence":[note]}});
            let output = qaren::redact::durable_json(&receipt).unwrap();
            assert!(!output.contains("private-admission-canary"));
            let mut failure = qaren::failure::Failure::new(
                "fresh_install",
                FailureCode::FreshInstallAdmissionUnknown,
                "unknown",
                "retry later",
            );
            let mut value = serde_json::to_value(&failure).unwrap();
            value["evidence"] = serde_json::json!([note]);
            failure = serde_json::from_value(value).unwrap();
            assert!(!failure.evidence[0].contains("private-admission-canary"));
        }
        let note = serde_json::json!({"probe":"fresh-install-admission","initialReason":"clear","terminalReason":"clear","attempts":3,"elapsedMs":0,"deadlineExceeded":false}).to_string();
        let output = qaren::redact::durable_json(
            &serde_json::json!({"outcomes":{"admission_before_deps":note}}),
        )
        .unwrap();
        assert!(!output.contains("clear"));
    });
}

fn request() -> CoreRequest {
    CoreRequest {
        video_policy: Default::default(),
        run_id: RUN.to_string(),
        t0: 1_770_000_000_000,
        walk_budget_ms: 300_000,
        attach_budget_ms: 120_000,
        plan: "1. Tap \"Tasks\"\n✓ \"Tasks\"\n".to_string(),
        prepared: serde_json::json!({"hash":"test","blocks":[]}),
        preflight_calls: vec![],
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        app_root: PathBuf::from("/tmp/app"),
        run_dir: PathBuf::from("/tmp/qaren-runs/check"),
        lease: format!("{RUN}:abcdef0123456789abcdef0123456789"),
        login_block: None,
        login_marker: None,
        target: CoreTarget {
            device_id: "AAAA-1111".to_string(),
            device_name: "qaren-check".to_string(),
            metro_port: 8791,
            metro_url_for_device: "http://127.0.0.1:8791".to_string(),
            worktree: PathBuf::from("/tmp/app"),
            metro_bundle_requests: None,
            manifest_warm: None,
            warm_lane: false,
        },
    }
}

fn budgets() -> Budgets {
    Budgets {
        walk_seconds: 60,
        step_seconds: 10,
    }
}

fn envelope(seq: u64, kind: &str, payload: &str) -> String {
    format!(r#"{{"v":1,"runId":"{RUN}","seq":{seq},"type":"{kind}","payload":{payload}}}"#)
}

fn row(line: u64, attempt: u64, outcome: &str) -> String {
    format!(
        r#"{{"block":"plan","line":{line},"attempt":{attempt},"kind":"step","resolvedBy":"exact","ref":"@e3","screenshot":"screenshots/{line:02}.png","t":{},"outcome":"{outcome}","text":"Tap \"Tasks\""}}"#,
        line * 100
    )
}

fn pass_ledger(rows: &[String]) -> String {
    format!(
        r#"{{"verdict":"PASS","path":"walk","blocks":[{{"key":"plan","outcome":"pass","source":"discovered"}}],"steps":[{}],"jev":{{"calls":0,"medianMs":0}},"llmTurns":0,"escapes":0,"recoveries":0}}"#,
        rows.join(",")
    )
}

fn spec() -> qaren::exec::CmdSpec {
    core::spawn_spec(
        Path::new("/usr/local/bin/node"),
        Path::new("/runtime"),
        Path::new("/tmp/app"),
        &request().lease,
        8791,
        None,
    )
}

fn run_child(mock: &mut MockRunner, log: &Path) -> core::CoreOutcome {
    let child = core::spawn(mock, &spec(), log, &request()).unwrap();
    core::wait(mock, child, budgets(), &mut |_, _| {})
}

#[test]
fn candidate_provenance_diagnostics_are_value_free_and_private_without_inputs() {
    let repo = common::temp_repo();
    let event = serde_json::json!({
        "kind": "label-provenance", "line": 2, "requested": true, "sampleCount": 3,
        "nodeIndex": 47, "differedFields": ["frame", "parentIndex"], "deadlineExpired": true,
        "outcome": "source-changed", "directLabelIndices": [0, 47]
    });
    let mut with_raw = event.clone();
    with_raw["value"] = "private-diagnostic-canary".into();
    let mut invalid = event.clone();
    invalid["differedFields"] = serde_json::json!(["private-diagnostic-canary"]);
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "diagnostic", &with_raw.to_string()),
        envelope(3, "diagnostic", &invalid.to_string()),
        envelope(4, "result", &pass_ledger(&[]))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let result = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(result.verdict, Verdict::Pass);
    let path = repo.join("core-diagnostics.jsonl");
    let stored = std::fs::read_to_string(&path).unwrap();
    assert_eq!(stored.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(stored.trim()).unwrap(),
        event
    );
    assert!(!stored.contains("private-diagnostic-canary"));
    assert!(!std::fs::read_to_string(repo.join("core.log"))
        .unwrap_or_default()
        .contains("label-provenance"));
    assert!(!serde_json::to_string(&result.ledger)
        .unwrap()
        .contains("label-provenance"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn containment_provenance_resolution_stays_private_and_value_free() {
    for (outcome, resolved_by, requested) in [
        ("deadline-clean", "containment", true),
        ("unavailable", "aggregate-visibility", false),
    ] {
        let repo = common::temp_repo();
        let event = serde_json::json!({
            "kind": "label-provenance", "line": 2, "requested": requested, "sampleCount": 3,
            "nodeIndex": 47, "differedFields": ["frame", "parentIndex"], "deadlineExpired": true,
            "outcome": outcome, "resolvedBy": resolved_by
        });
        let mut with_raw = event.clone();
        with_raw["value"] = "private-diagnostic-canary".into();
        let mut invalid = event.clone();
        invalid["resolvedBy"] = "private-diagnostic-canary".into();
        let mut legacy = event.clone();
        legacy["outcome"] = "deadline".into();
        legacy["resolvedBy"] = "containment".into();
        let mut unknown = event.clone();
        unknown["outcome"] = "unknown-timeout".into();
        let stdout = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            envelope(2, "diagnostic", &with_raw.to_string()),
            envelope(3, "diagnostic", &invalid.to_string()),
            envelope(4, "diagnostic", &legacy.to_string()),
            envelope(5, "diagnostic", &unknown.to_string()),
            envelope(6, "result", &pass_ledger(&[]))
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let path = repo.join("core-diagnostics.jsonl");
        let stored = std::fs::read_to_string(&path).unwrap();
        assert_eq!(stored.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(stored.trim()).unwrap(),
            event
        );
        assert!(!stored.contains("private-diagnostic-canary"));
        assert!(!std::fs::read_to_string(repo.join("core.log"))
            .unwrap_or_default()
            .contains("label-provenance"));
        assert!(!serde_json::to_string(&result.ledger)
            .unwrap()
            .contains("label-provenance"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[test]
fn target_miss_diagnostics_stay_private_without_runtime_inputs() {
    let repo = common::temp_repo();
    let event = serde_json::json!({
        "kind": "target-miss", "line": 1, "reason": "only-in-aggregated-label", "truncated": false,
        "candidates": [{"identifier": "coverage-card", "label": "Coverage, Details", "match": "inside-label", "aggregated": true}]
    });
    let mut invalid = event.clone();
    invalid["candidates"][0]["value"] = "unallowed".into();
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "diagnostic", &event.to_string()),
        envelope(3, "diagnostic", &invalid.to_string()),
        envelope(4, "result", &pass_ledger(&[]))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let result = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(result.verdict, Verdict::Pass);
    let path = repo.join("core-diagnostics.jsonl");
    let stored = std::fs::read_to_string(&path).unwrap();
    assert_eq!(stored.lines().count(), 1);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(stored.trim()).unwrap(),
        event
    );
    assert!(!std::fs::read_to_string(repo.join("core.log"))
        .unwrap_or_default()
        .contains("coverage-card"));
    assert!(!serde_json::to_string(&result.ledger)
        .unwrap()
        .contains("coverage-card"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn target_miss_diagnostics_redact_inputs_and_reject_unbounded_candidates() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "synthetic-private-slot";
    let inputs = Arc::new(InputValues::from_entries([
        (OsString::from("QAREN_INPUT_NAME"), OsString::from(secret)),
        (OsString::from("QAREN_INPUT_CODE"), OsString::from("42")),
    ]));
    with_input_scope(inputs, || {
        let event = serde_json::json!({
            "kind": "target-miss", "line": 1, "reason": "absent", "truncated": false,
            "candidates": [{"label": format!("Coverage {secret}"), "match": "near", "aggregated": false}]
        });
        let mut oversized = event.clone();
        oversized["candidates"][0]["label"] = "x".repeat(257).into();
        let mut too_many = event.clone();
        too_many["candidates"] = vec![event["candidates"][0].clone(); 21].into();
        let mut expanding = event.clone();
        expanding["candidates"][0]["label"] = "42".repeat(128).into();
        let stdout = format!(
            "{}\n{}\n{}\n{}\n{}\n",
            envelope(2, "diagnostic", &event.to_string()),
            envelope(3, "diagnostic", &oversized.to_string()),
            envelope(4, "diagnostic", &too_many.to_string()),
            envelope(5, "diagnostic", &expanding.to_string()),
            envelope(6, "result", &pass_ledger(&[]))
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        assert_eq!(
            run_child(&mut mock, &repo.join("core.log")).verdict,
            Verdict::Pass
        );
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert_eq!(stored.lines().count(), 2);
        assert!(!stored.contains(secret));
        assert!(stored.contains("REDACTED_INPUT"));
        let bounded: serde_json::Value =
            serde_json::from_str(stored.lines().nth(1).unwrap()).unwrap();
        let label = bounded["candidates"][0]["label"].as_str().unwrap();
        assert!(!label.contains("42"));
        assert_eq!(label.chars().count(), 256);
    });
}

#[test]
fn slot_diagnostics_retain_only_allowlisted_events_without_affecting_the_result() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "private-synthetic-value";
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from(secret),
    )]));
    with_input_scope(inputs, || {
        let payloads = [
            r#"{"kind":"metric","stage":"relaunch","edge":"end","outcome":"failed","at":200,"ms":100,"relaunch":"timeout","reapDisposition":"reaped"}"#.to_string(),
            r#"{"kind":"timing","stage":"dispatch","code":"ACTION_INTERRUPTED","line":2,"at":220,"acquisitionMs":100,"observationAgeMs":120,"nativeCode":"RUNNER_TIMEOUT","nativeMutation":"possible"}"#.into(),
            r#"{"kind":"block-outcome","line":2,"outcome":"pass"}"#.into(),
            r#"{"kind":"login-outcome","outcome":"refused"}"#.into(),
            r#"{"kind":"interruption-rejected","line":2,"veto":"later-target","exactDeclineCount":1,"targetIndex":1}"#.into(),
            r#"{"kind":"fill-privacy","line":2,"cause":"secure-field","privateValue":true}"#.into(),
            r#"{"kind":"fill-privacy","line":2,"cause":"unreadable-check-subject","privateValue":true}"#.into(),
            r#"{"kind":"fill-privacy","line":2,"cause":"label-may-be-value","privateValue":false}"#.into(),
            format!(r#"{{"kind":"fill-privacy","line":2,"cause":"{secret}","privateValue":true}}"#),
            format!(r#"{{"kind":"fill-privacy","line":2,"cause":"secure-field","privateValue":true,"value":"{secret}"}}"#),
            r#"{"kind":"fill-privacy","line":0,"cause":"secure-field","privateValue":true}"#.into(),
            r#"{"kind":"fill-privacy","line":2,"cause":"secure-field","privateValue":"true"}"#.into(),
            format!(r#"{{"kind":"interruption-rejected","line":2,"veto":"{secret}","exactDeclineCount":1}}"#),
            r#"{"kind":"interruption-rejected","line":2,"veto":"no-candidate","exactDeclineCount":1,"label":"Maybe later"}"#.into(),
            r#"{"kind":"interruption-rejected","line":2,"veto":"no-candidate","exactDeclineCount":0.5}"#.into(),
            format!(r#"{{"kind":"metric","stage":"relaunch","edge":"end","outcome":"failed","at":200,"relaunch":"{secret}"}}"#),
            format!(r#"{{"kind":"login-outcome","outcome":"{secret}"}}"#),
            format!(r#"{{"kind":"block-outcome","line":2,"outcome":"pass","title":"{secret}"}}"#),
            format!(r#"{{"kind":"timing","stage":"dispatch","code":"{secret}","line":2,"at":1,"acquisitionMs":0,"observationAgeMs":0}}"#),
            r#"{"kind":"metric","stage":"capture","edge":"end","outcome":"ok","at":-1}"#.into(),
        ];
        let mut stdout = String::new();
        for (i, payload) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", payload));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            payloads.len() as u64 + 2,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(!stored.contains(secret));
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got.len(), 8);
        assert!(!stored.contains("Maybe later"));
        for (event, expected) in got.iter().zip(&payloads) {
            assert_eq!(
                *event,
                serde_json::from_str::<serde_json::Value>(expected).unwrap()
            );
        }
    });
}

#[test]
fn readiness_reasons_reach_private_diagnostics_only_as_classified_end_events() {
    use qaren::redact::{with_input_scope, InputValues};
    use serde_json::json;
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from("private-synthetic-value"),
    )]));
    with_input_scope(inputs, || {
        let reasons = [
            "alive",
            "dead",
            "health",
            "authority-mismatch",
            "legacy",
            "protocol-older",
            "protocol-newer",
            "version-skew",
            "missing-commands",
            "missing-features",
            "unknown",
        ];
        let metric = json!({
            "kind": "metric", "stage": "native-readiness", "edge": "end", "outcome": "failed",
            "at": 200, "line": 3, "observation": 7, "count": 2
        });
        let expected: Vec<_> = reasons
            .iter()
            .map(|reason| {
                let mut value = metric.clone();
                value["readinessReason"] = json!(reason);
                value
            })
            .collect();
        let mut payloads = expected.clone();
        payloads.push(metric.clone());
        for reason in [
            json!("private-synthetic-value"),
            json!({}),
            json!([]),
            json!(1),
            json!(null),
        ] {
            let mut invalid = metric.clone();
            invalid["readinessReason"] = reason;
            payloads.push(invalid);
        }
        for (key, value) in [
            ("stage", "capture"),
            ("edge", "start"),
            ("edge", "point"),
            ("raw", "private-synthetic-value"),
        ] {
            let mut invalid = expected[0].clone();
            invalid[key] = json!(value);
            payloads.push(invalid);
        }
        let mut stdout = String::new();
        for (i, value) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &value.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            payloads.len() as u64 + 2,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(!stored.contains("private-synthetic-value"));
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, [expected, vec![metric]].concat());
    });
}

#[test]
fn runner_termination_diagnostics_reach_private_diagnostics_only_as_fixed_words_and_counts() {
    use qaren::redact::{with_input_scope, InputValues};
    use serde_json::json;
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "private-synthetic-value";
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_OTP"),
        OsString::from(secret),
    )]));
    with_input_scope(inputs, || {
        let readiness = json!({
            "kind": "metric", "stage": "native-readiness", "edge": "end", "outcome": "failed",
            "at": 200, "ms": 2, "count": 1, "readinessReason": "health"
        });
        let post_mortem = json!({
            "kind": "metric", "stage": "runner-post-mortem", "edge": "point", "outcome": "failed",
            "at": 201, "count": 1, "hostChild": "exited", "exitCode": 0, "exitSignal": "SIGKILL",
            "appProcess": "changed", "markerReady": 1, "markerWaiting": 1, "markerWaitResult": 0,
            "markerListenerFailed": 0, "markerSendFailed": 2, "markerIssueContained": 2,
            "markerTestIssue": 1, "markerTestFailed": 1
        });
        let mut expected = Vec::new();
        for detail in [
            "refused",
            "reset",
            "abort",
            "http-4xx",
            "http-5xx",
            "body-not-ok",
            "wedged",
            "transport-timeout",
            "http-protocol",
            "other",
        ] {
            let mut value = readiness.clone();
            value["healthDetail"] = json!(detail);
            expected.push(value);
        }
        expected.push(post_mortem.clone());
        for stage in [
            "dispatch-bind",
            "dispatch-native",
            "dispatch-settle",
            "dispatch-health",
            "dispatch-readback",
        ] {
            expected.push(json!({
                "kind": "metric", "stage": stage, "edge": "end", "outcome": "ok", "at": 300, "line": 7, "ms": 17600
            }));
        }
        let mut payloads = expected.clone();
        for (key, value) in [
            ("healthDetail", json!(secret)),
            ("healthDetail", json!(1)),
            ("readinessReason", json!("dead")),
        ] {
            let mut invalid = expected[0].clone();
            invalid[key] = value;
            payloads.push(invalid);
        }
        for (key, value) in [
            ("hostChild", json!(secret)),
            ("appProcess", json!(4242)),
            ("exitSignal", json!(secret)),
            ("exitCode", json!(-1)),
            ("markerWaiting", json!(secret)),
            ("tail", json!(secret)),
        ] {
            let mut invalid = post_mortem.clone();
            invalid[key] = value;
            payloads.push(invalid);
        }
        for key in ["hostChild", "exitCode", "appProcess", "markerWaiting"] {
            let mut misplaced = readiness.clone();
            misplaced[key] = post_mortem[key].clone();
            payloads.push(misplaced);
        }
        let mut stdout = String::new();
        for (i, value) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &value.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            payloads.len() as u64 + 2,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(!stored.contains(secret));
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, expected);
    });
}

#[test]
fn slot_failure_path_diagnostics_keep_only_ruled_fields() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "private-synthetic-value";
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from(secret),
    )]));
    with_input_scope(inputs, || {
        let mut valid = Vec::new();
        for stage in [
            "type-call",
            "type-readback",
            "relayout-retap",
            "settle",
            "keyboard",
        ] {
            valid.push(serde_json::json!({"kind":"metric", "stage":stage, "edge":"end", "outcome":"failed", "at":16000, "ms":10000}));
        }
        valid.push(serde_json::json!({"kind":"metric", "stage":"settle", "edge":"end", "outcome":"ok", "at":16000, "ms":25, "method":"timeout", "settled":false, "hierarchyChanged":"unknown"}));
        valid.push(serde_json::json!({"kind":"metric", "stage":"keyboard", "edge":"point", "outcome":"ok", "at":16000, "ms":25, "event":"relayout", "proof":"not-proven", "keyboard":true}));
        valid.push(serde_json::json!({"kind":"metric", "stage":"type-readback", "edge":"end", "outcome":"unavailable", "at":16000, "ms":25}));
        valid.push(serde_json::json!({"kind":"timing", "stage":"dispatch", "code":"ACTION_INTERRUPTED", "line":17, "at":16000, "acquisitionMs":1, "observationAgeMs":16000, "authorizations":1, "refusalStage":"dispatch-error", "mutating":true, "nativeCode":"RUNNER_TIMEOUT"}));
        let mut settle_refusal = valid.last().unwrap().clone();
        settle_refusal["refusalStage"] = "settle".into();
        settle_refusal["nativeMutation"] = "possible".into();
        valid.push(settle_refusal);
        let mut invalid = Vec::new();
        for (index, key) in [
            (0, "stage"),
            (5, "method"),
            (5, "settled"),
            (5, "hierarchyChanged"),
            (6, "event"),
            (6, "proof"),
            (6, "keyboard"),
            (8, "refusalStage"),
            (8, "mutating"),
            (8, "nativeCode"),
        ] {
            let mut event = valid[index].clone();
            event[key] = secret.into();
            invalid.push(event);
        }
        let mut stdout = String::new();
        for (i, event) in valid.iter().chain(&invalid).enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &event.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            (valid.len() + invalid.len() + 2) as u64,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        assert_eq!(
            run_child(&mut mock, &repo.join("core.log")).verdict,
            Verdict::Pass
        );
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(!stored.contains(secret));
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, valid);
    });
}

#[test]
fn a_real_slot_child_keeps_raw_logs_withheld_while_retaining_structured_diagnostics() {
    use qaren::exec::RealRunner;
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "quote\"slash\\private-synthetic";
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from(secret),
    )]));
    with_input_scope(inputs.clone(), || {
        let resolved = inputs.admit(&["PASSWORD".into()]).unwrap();
        let script = r#"
          const reader = require('node:readline').createInterface({input: process.stdin});
          reader.once('line', input => {
            const { payload, runId } = JSON.parse(input);
            if (!payload.plan.includes('input PASSWORD (non-secret)')) process.exit(4);
            process.stderr.write(payload.inputs.PASSWORD + '\n');
            let seq = 1;
            const send = (type, payload) => process.stdout.write(JSON.stringify({v: 1, runId, seq: ++seq, type, payload}) + '\n');
            send('diagnostic', {kind: 'metric', stage: 'capture', edge: 'end', outcome: 'ok', at: 200, ms: 100});
            send('diagnostic', {kind: 'timing', stage: 'dispatch', code: 'COMPLETED', line: 2, at: 220, acquisitionMs: 100, observationAgeMs: 120});
            send('diagnostic', {kind: 'block-outcome', line: 2, outcome: 'pass'});
            send('diagnostic', {kind: 'login-outcome', outcome: 'pass'});
            send('diagnostic', {kind: 'login-outcome', outcome: payload.inputs.PASSWORD});
            send('diagnostic', {kind: 'media-withheld', scope: 'screenshots', cause: {reason: 'runtime-input', value: payload.inputs.PASSWORD}, line: 0});
            send('diagnostic', {kind: 'media-withheld', scope: 'video', cause: {reason: 'generic-value', kind: 'other'}, line: 2});
            send('diagnostic', {kind: 'media-withheld', scope: 'video', cause: {reason: payload.inputs.PASSWORD}, line: 3});
            send('diagnostic', {kind: 'media-withheld', scope: 'video', cause: {reason: 'echo', source: payload.inputs.PASSWORD}, line: 3});
            send('result', {verdict: 'PASS', path: 'walk', blocks: [], steps: [], jev: {calls: 0, medianMs: 0}, llmTurns: 0, escapes: 0, recoveries: 0});
            reader.close();
            process.stdin.destroy();
          });
        "#;
        let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
        let fixture = CmdSpec::new("fixture", "node", &["-e", script], 5);
        let raw_log = repo.join("core.log");
        let mut annotated = request();
        annotated.plan = "1. Fill \"code-field\" with input PASSWORD (non-secret)".into();
        let child = core::spawn_private(
            &mut runner,
            &fixture,
            &raw_log,
            &annotated,
            Some(&resolved),
            None,
        )
        .unwrap();
        let result = core::wait(&mut runner, child, budgets(), &mut |_, _| {});
        assert_eq!(result.verdict, Verdict::Pass);
        let log = std::fs::read_to_string(raw_log).unwrap();
        assert!(log.contains("[private output withheld]"));
        let records: Vec<serde_json::Value> = log
            .lines()
            .filter_map(|line| line.strip_prefix("media-withheld "))
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(
            records,
            vec![
                serde_json::json!({"v": 1, "scope": "screenshots", "reason": "runtime-input", "line": 0}),
                serde_json::json!({"v": 1, "scope": "video", "reason": "generic-value", "kind": "other", "line": 2}),
            ]
        );
        assert!(!log.contains("private-synthetic"));
        let retained = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert_eq!(retained.lines().count(), 6);
        assert!(!retained.contains(secret));
        assert!(!retained.contains("private-synthetic"));
        assert!(!format!("{result:?}").contains("private-synthetic"));
    });
}

#[test]
fn scripted_rows_and_a_pass_result_become_a_typed_ledger() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1]),
        envelope(4, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass);
    assert!(outcome.failure.is_none());
    assert_eq!(outcome.pid, 9000);
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert_eq!(outcome.ledger.steps[1].line, 2);
    assert_eq!(
        outcome.ledger.steps[1].screenshot.as_deref(),
        Some("screenshots/02.png")
    );
    assert_eq!(outcome.ledger.jev.calls, 0);

    let written = mock.piped_stdin_text(0);
    let envelope: serde_json::Value = serde_json::from_str(written.trim()).unwrap();
    assert_eq!(envelope["v"], 1);
    assert_eq!(envelope["type"], "request");
    assert_eq!(envelope["runId"], RUN);
    assert_eq!(envelope["payload"]["target"]["metroPort"], 8791);
    assert_eq!(envelope["payload"]["target"]["deviceName"], "qaren-check");
    assert_eq!(envelope["payload"]["lease"], request().lease);
    let spawn = &mock.calls[0];
    assert_eq!(spawn.label, "core-walk");
    assert!(spawn.args[0].ends_with("qa/walk.js"));
    assert!(spawn
        .env
        .iter()
        .any(|(k, v)| k == "QAREN_DEVICE_LEASE" && v == &request().lease));
    assert_eq!(spawn.cwd.as_deref(), Some(Path::new("/tmp/app")));
}

#[test]
fn a_child_without_a_result_line_fails_at_its_last_row() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 2, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "admitted", "{}"),
        envelope(3, "row", &rows[0]),
        envelope(4, "row", &rows[1])
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(1));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert_eq!(failure.phase, "walk");
    let ledger_failure = outcome.ledger.failure.unwrap();
    assert_eq!(ledger_failure.step, 2, "attributed to the last row");
    assert_eq!(
        ledger_failure.screenshot.as_deref(),
        Some("screenshots/02.png")
    );
    assert!(ledger_failure.seen.contains("code 1"));
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert_eq!(outcome.ledger.verdict, "FAIL");
}

#[test]
fn a_child_that_dies_before_any_row_fails_at_step_zero() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, "", Some(2));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let ledger_failure = outcome.ledger.failure.unwrap();
    assert_eq!(ledger_failure.step, 0);
    assert!(ledger_failure.seen.contains("without a result line"));
    assert!(outcome.ledger.steps.is_empty());
}

#[test]
fn a_result_that_disagrees_with_the_exit_code_is_not_trusted() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(1));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert!(
        failure.detail.contains("says \"PASS\""),
        "{}",
        failure.detail
    );
    assert_eq!(outcome.ledger.failure.unwrap().step, 1);
}

#[test]
fn the_result_line_and_the_exit_code_must_agree() {
    let rows = [row(1, 1, "pass")];
    let pass = pass_ledger(&rows);
    let fail = pass.replacen("\"verdict\":\"PASS\"", "\"verdict\":\"FAIL\"", 1);
    let refused =
        r#"{"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH","message":"port"}"#.to_string();
    let cases: &[(&str, &String, i32, bool)] = &[
        ("PASS", &pass, 0, true),
        ("FAIL", &fail, 1, true),
        ("REFUSED", &refused, 4, true),
        ("PASS", &pass, 1, false),
        ("PASS", &pass, 4, false),
        ("FAIL", &fail, 0, false),
        ("REFUSED", &refused, 0, false),
        ("REFUSED", &refused, 1, false),
    ];
    for (verdict, ledger, exit, agrees) in cases {
        let repo = common::temp_repo();
        let stdout = format!(
            "{}\n{}\n",
            envelope(2, "row", &rows[0]),
            envelope(3, "result", ledger)
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(*exit));
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        if *agrees {
            assert!(
                outcome.failure.is_none(),
                "{verdict}/{exit}: {:?}",
                outcome.failure
            );
            let expected = match *verdict {
                "PASS" => Verdict::Pass,
                "FAIL" => Verdict::Fail,
                _ => Verdict::Refused {
                    code: "METRO_ORIGIN_MISMATCH".to_string(),
                    message: "port".to_string(),
                },
            };
            assert_eq!(outcome.verdict, expected, "{verdict}/{exit}");
            assert_eq!(outcome.ledger.verdict, *verdict, "{verdict}/{exit}");
        } else {
            assert_eq!(outcome.verdict, Verdict::Fail, "{verdict}/{exit}");
            let failure = outcome
                .failure
                .expect("a disagreement is a synthesized failure");
            assert_eq!(
                failure.code,
                FailureCode::CoreResultMissing,
                "{verdict}/{exit}"
            );
            assert!(
                failure.detail.contains("but the core exited with code"),
                "{verdict}/{exit}: {}",
                failure.detail
            );
        }
    }
}

#[test]
fn a_typed_refusal_needs_exit_four() {
    let repo = common::temp_repo();
    let refusal = r#"{"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH","message":"scriptURL port 8081 != 8791","lease":"x"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", refusal)),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(
        outcome.verdict,
        Verdict::Refused {
            code: "METRO_ORIGIN_MISMATCH".to_string(),
            message: "scriptURL port 8081 != 8791".to_string()
        }
    );
    assert!(outcome.failure.is_none());
}

#[test]
fn react_coverage_loss_survives_the_child_receipt_and_report() {
    use qaren::receipt::{Receipt, ReceiptResult};
    use qaren::report::{self, ReportInput};

    for coverage in ["unknown", "incomplete", "reconnected", "lost"] {
        let repo = common::temp_repo();
        let mut step: serde_json::Value = serde_json::from_str(&row(2, 1, "pass")).unwrap();
        step["reactCoverage"] = coverage.into();
        let message =
            "React coverage was lost during the walk; native evidence alone cannot verify the run.";
        let result = serde_json::json!({
            "verdict": "REFUSED", "code": "REACT_COVERAGE_LOST", "message": message,
            "lease": request().lease, "path": "walk", "blocks": [], "steps": [step],
            "failure": {"step": 2, "seen": message},
            "jev": {"calls": 0, "medianMs": 0}, "llmTurns": 0, "escapes": 0, "recoveries": 0,
        });
        let stdout = format!(
            "{}\n{}\n",
            envelope(2, "row", &step.to_string()),
            envelope(3, "result", &result.to_string()),
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(4));
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(
            outcome.verdict,
            Verdict::Refused {
                code: "REACT_COVERAGE_LOST".into(),
                message: message.into(),
            }
        );
        assert_eq!(
            outcome.ledger.steps[0].react_coverage.unwrap().as_str(),
            coverage
        );

        let mut receipt = Receipt::new("check", RUN, ReceiptResult::Refused, "walk", "now".into());
        receipt.ledger = Some(report::summarize(&outcome.ledger));
        let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
        assert_eq!(json["ledger"]["verdict"], "REFUSED");
        assert_eq!(
            json["ledger"]["react_coverage_gaps"],
            serde_json::json!([
                {"line": 2, "coverage": coverage}
            ])
        );
        let rendered = report::render(&ReportInput {
            run_id: RUN,
            platform: "ios",
            app_id: "com.test",
            device: "test-device",
            ledger: &outcome.ledger,
        });
        assert!(rendered.contains("QaReN check: REFUSED"));
        assert!(rendered.contains(&format!("React coverage {coverage}")));
        assert!(rendered.contains(message));
    }
}

#[test]
fn same_line_loss_and_reconnect_survive_the_child_receipt_and_report() {
    use qaren::receipt::{Receipt, ReceiptResult};
    use qaren::report::{self, ReportInput};

    let repo = common::temp_repo();
    let mut step: serde_json::Value = serde_json::from_str(&row(22, 1, "pass")).unwrap();
    step["reactCoverage"] = "lost".into();
    step["reactConnections"] = serde_json::json!(["lost", "reconnected"]);
    let result = serde_json::json!({
        "verdict": "PASS", "lease": request().lease, "path": "walk",
        "blocks": [], "steps": [step], "jev": {"calls": 0, "medianMs": 0},
        "llmTurns": 0, "escapes": 0, "recoveries": 0,
    });
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &step.to_string()),
        envelope(3, "result", &result.to_string())
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Pass);
    assert_eq!(
        serde_json::to_value(&outcome.ledger.steps[0]).unwrap()["reactConnections"],
        step["reactConnections"]
    );
    let mut receipt = Receipt::new("check", RUN, ReceiptResult::Pass, "walk", "now".into());
    receipt.ledger = Some(report::summarize(&outcome.ledger));
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
    assert_eq!(
        json["ledger"]["react_reconnections"],
        serde_json::json!([22])
    );
    assert_eq!(
        json["ledger"]["react_coverage_gaps"],
        serde_json::json!([{"line": 22, "coverage": "lost"}])
    );
    let report = report::render(&ReportInput {
        run_id: RUN,
        platform: "ios",
        app_id: "com.test",
        device: "test-device",
        ledger: &outcome.ledger,
    });
    assert!(report.starts_with("# QaReN check: PASS · React reconnected at line 22\n"));
    assert!(report.contains("React coverage lost; React reconnected"));
}

#[test]
fn a_typed_refusal_keeps_its_walk_speed_and_drops_a_malformed_one() {
    for (speed, expected) in [
        (
            serde_json::json!({"stepMedianMs": 250, "stepP95Ms": 400, "walkMs": 1900, "steps": 5, "passed": 4, "failed": 1}),
            Some((Some(400), 5, 4, 1)),
        ),
        (
            serde_json::json!({"walkMs": 0, "steps": 0, "passed": 0, "failed": 0}),
            Some((None, 0, 0, 0)),
        ),
        (serde_json::Value::Null, None),
        (serde_json::json!({"walkMs": "slow"}), None),
    ] {
        let repo = common::temp_repo();
        let refusal = serde_json::json!({"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH",
            "message":"port","speed":speed});
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &refusal.to_string())),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert!(matches!(outcome.verdict, Verdict::Refused { .. }));
        assert!(outcome.failure.is_none());
        assert_eq!(
            outcome.ledger.speed.map(|speed| (
                speed.step_p95_ms,
                speed.steps,
                speed.passed,
                speed.failed
            )),
            expected
        );
    }
}

#[test]
fn jev_refusal_accounting_is_optional_but_strict_when_present() {
    for jev in [
        None,
        Some(serde_json::json!({"calls": "invalid"})),
        Some(serde_json::json!({
            "calls": 2, "medianMs": 25, "inputTokens": 12, "callDetails": [
                {"scope":"preflight", "questionIds":["preflight"], "inputTokens":12, "ms":10, "outcome":"ok", "status":200},
                {"scope":"walk", "questionIds":["front"], "inputTokens":null, "ms":40, "outcome":"http", "status":401}
            ]
        })),
    ] {
        let repo = common::temp_repo();
        let mut refusal = serde_json::json!({"verdict":"REFUSED", "code":"JEV_AUTH_FAILED", "message":"key rejected"});
        if let Some(jev) = &jev {
            refusal["jev"] = jev.clone();
        }
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &refusal.to_string())),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        if jev.as_ref().is_some_and(|j| j["calls"].is_string()) {
            assert_eq!(outcome.verdict, Verdict::Fail);
            assert_eq!(
                outcome.failure.unwrap().code,
                FailureCode::CoreResultMissing
            );
        } else {
            assert!(
                matches!(outcome.verdict, Verdict::Refused { ref code, .. } if code == "JEV_AUTH_FAILED")
            );
            assert!(outcome.failure.is_none());
            if let Some(jev) = jev {
                assert_eq!(serde_json::to_value(outcome.ledger.jev).unwrap(), jev);
            } else {
                assert_eq!(outcome.ledger.jev, Default::default());
            }
        }
    }
}

#[test]
fn jev_deadline_and_retry_backoff_diagnostic_roundtrip_in_results_and_refusals() {
    let jev = serde_json::json!({
        "calls": 2, "medianMs": 25, "inputTokens": 0, "callDetails": [
            {"scope":"walk", "questionIds":["front"], "inputTokens":null, "ms":10, "outcome":"deadline"},
            {"scope":"walk", "questionIds":["front"], "inputTokens":null, "ms":40, "outcome":"http", "status":429, "diagnostic":"retry-after-outside-window"}
        ]
    });
    for (verdict, exit) in [("PASS", 0), ("FAIL", 1), ("REFUSED", 4)] {
        let repo = common::temp_repo();
        let mut result: serde_json::Value = serde_json::from_str(&pass_ledger(&[])).unwrap();
        result["verdict"] = serde_json::json!(verdict);
        result["jev"] = jev.clone();
        result["code"] = serde_json::json!("JEV_DEADLINE_EXCEEDED");
        result["message"] = serde_json::json!("the observation or item deadline expired");
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &result.to_string())),
            Some(exit),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert!(
            outcome.failure.is_none(),
            "{verdict}: {:?}",
            outcome.failure
        );
        assert_eq!(outcome.ledger.verdict, verdict);
        let expected = match verdict {
            "PASS" => Verdict::Pass,
            "FAIL" => Verdict::Fail,
            _ => Verdict::Refused {
                code: "JEV_DEADLINE_EXCEEDED".to_string(),
                message: "the observation or item deadline expired".to_string(),
            },
        };
        assert_eq!(outcome.verdict, expected);
        assert_eq!(serde_json::to_value(outcome.ledger.jev).unwrap(), jev);
    }
}

#[test]
fn jev_optional_diagnostic_matches_status_missing_and_null_policy() {
    let call = serde_json::json!({
        "scope":"walk", "questionIds":[], "inputTokens":null, "ms":0, "outcome":"deadline"
    });
    for explicit_null in [false, true] {
        let mut supplied = call.clone();
        if explicit_null {
            supplied["status"] = serde_json::Value::Null;
            supplied["diagnostic"] = serde_json::Value::Null;
        }
        let parsed: core::JevCall = serde_json::from_value(supplied).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), call);
    }
}

#[test]
fn malformed_jev_diagnostics_are_rejected_in_results_and_refusals() {
    use serde_json::json;
    for diagnostic in [
        json!("arbitrary"),
        json!(""),
        json!(42),
        json!(true),
        json!([]),
        json!({}),
        json!({"retry-after-outside-window": null}),
    ] {
        for (verdict, exit) in [("PASS", 0), ("FAIL", 1), ("REFUSED", 4)] {
            let repo = common::temp_repo();
            let mut result: serde_json::Value = serde_json::from_str(&pass_ledger(&[])).unwrap();
            result["verdict"] = json!(verdict);
            result["jev"] = json!({
                "calls":1, "medianMs":0, "callDetails":[{
                    "scope":"walk", "questionIds":[], "inputTokens":null, "ms":0,
                    "outcome":"http", "status":429, "diagnostic":diagnostic
                }]
            });
            let mut mock = MockRunner::new();
            mock.expect_spawn_piped(
                "walk.js",
                9000,
                &format!("{}\n", envelope(2, "result", &result.to_string())),
                Some(exit),
            );
            let outcome = run_child(&mut mock, &repo.join("core.log"));
            assert_eq!(outcome.verdict, Verdict::Fail, "{verdict}: {diagnostic}");
            assert_eq!(
                outcome
                    .failure
                    .expect("invalid diagnostic must not be silently dropped")
                    .code,
                FailureCode::CoreResultMissing,
                "{verdict}: {diagnostic}"
            );
        }
    }
}

#[test]
fn default_step_budget_covers_reasks_and_the_bounded_scroll_schedule() {
    use qaren::run::{DEFAULT_STEP_SECONDS, DEFAULT_WALK_SECONDS};
    let judgment = 3 * 10 + 2 * 60;
    let check_with_reask = 2 * judgment + 1 + 30;
    let scroll_until = 7 * judgment + 150;
    assert_eq!(DEFAULT_STEP_SECONDS, 1200);
    assert!(DEFAULT_STEP_SECONDS >= check_with_reask);
    assert!(DEFAULT_STEP_SECONDS >= scroll_until);
    assert_eq!(
        DEFAULT_WALK_SECONDS, 1200,
        "the absolute walk cap is not extended or reset by retries"
    );
}

struct ScheduleRunner {
    inner: MockRunner,
    intervals: VecDeque<u64>,
    started_ms: u64,
    after_schedule_ms: u64,
}

impl Runner for ScheduleRunner {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.inner.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.inner.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.inner.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        if *self.inner.piped_killed[0].lock().unwrap() {
            self.inner.sleep(duration);
            return;
        }
        let ms = self.intervals.pop_front().unwrap_or_else(|| {
            self.after_schedule_ms
                .saturating_sub(self.inner.now_epoch_ms() - self.started_ms)
                .max(1)
        });
        self.inner.sleep(Duration::from_millis(ms));
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}

fn drive_schedule(intervals: Vec<u64>, budgets: Budgets) -> (core::CoreOutcome, ScheduleRunner) {
    let repo = common::temp_repo();
    let mut inner = MockRunner::new();
    inner.expect_spawn_piped(
        "walk.js",
        9000,
        &format!(
            "{}\n{}\n",
            envelope(2, "admitted", "{}"),
            envelope(3, "row", &row(1, 1, "pass"))
        ),
        None,
    );
    let mut runner = ScheduleRunner {
        started_ms: inner.now_epoch_ms(),
        inner,
        intervals: intervals.into(),
        after_schedule_ms: budgets.walk_seconds * 1000 + 1,
    };
    let child = core::spawn(&mut runner, &spec(), &repo.join("core.log"), &request()).unwrap();
    let outcome = core::wait(&mut runner, child, budgets, &mut |_, _| {});
    (outcome, runner)
}

fn judgment_schedule() -> Vec<u64> {
    vec![10_000, 60_000, 10_000, 60_000, 10_000]
}

fn scroll_schedule() -> Vec<u64> {
    let mut schedule = vec![15_000];
    schedule.extend(judgment_schedule());
    for _ in 0..6 {
        schedule.extend([5_000, 15_000]);
        schedule.extend(judgment_schedule());
    }
    schedule.push(15_000);
    schedule
}

#[test]
fn wait_allows_the_full_retry_reask_and_scroll_schedules_before_the_absolute_cap() {
    use qaren::run::{DEFAULT_STEP_SECONDS, DEFAULT_WALK_SECONDS};
    let mut reask = vec![15_000];
    reask.extend(judgment_schedule());
    reask.extend([500, 15_000]);
    reask.extend(judgment_schedule());
    reask.push(15_000);
    assert_eq!(judgment_schedule().iter().sum::<u64>(), 150_000);
    assert_eq!(reask.iter().sum::<u64>(), 345_500);
    assert_eq!(scroll_schedule().iter().sum::<u64>(), 1_200_000);
    for schedule in [judgment_schedule(), reask, scroll_schedule()] {
        let (outcome, runner) = drive_schedule(
            schedule,
            Budgets {
                walk_seconds: DEFAULT_WALK_SECONDS,
                step_seconds: DEFAULT_STEP_SECONDS,
            },
        );
        assert!(
            runner.intervals.is_empty(),
            "the permitted schedule was interrupted: {:?}",
            outcome.failure
        );
        assert_eq!(outcome.ledger.steps.len(), 1);
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
        assert!(
            failure.detail.contains("walk exceeded its 1200s budget"),
            "{}",
            failure.detail
        );
    }
}

#[test]
fn wait_honors_small_step_and_absolute_walk_caps_during_retries() {
    for (budgets, message) in [
        (
            Budgets {
                walk_seconds: 1200,
                step_seconds: 5,
            },
            "no ledger row within 5s",
        ),
        (
            Budgets {
                walk_seconds: 5,
                step_seconds: 1200,
            },
            "walk exceeded its 5s budget",
        ),
    ] {
        let (outcome, runner) = drive_schedule(scroll_schedule(), budgets);
        assert!(
            !runner.intervals.is_empty(),
            "a small override must interrupt the schedule"
        );
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
        assert!(failure.detail.contains(message), "{}", failure.detail);
        assert!(*runner.inner.piped_killed[0].lock().unwrap());
    }
}

#[test]
fn malformed_supplied_refusal_evidence_is_not_silently_synthesized() {
    use serde_json::json;
    let mut invalid_kind: serde_json::Value = serde_json::from_str(&row(9, 1, "fail")).unwrap();
    invalid_kind["kind"] = json!("unknown");
    let mut cases = vec![
        ("blocks", json!({})),
        ("blocks", json!([{"key":"account","outcome":"fail"}])),
        (
            "blocks",
            json!([{"key":false,"outcome":"fail","source":"discovered"}]),
        ),
        (
            "blocks",
            json!([{"key":"account","outcome":"unknown","source":"discovered"}]),
        ),
        ("failure", json!({"step":"nine","seen":"evidence"})),
        (
            "failure",
            json!({"step":9,"seen":"evidence","screenshot":42}),
        ),
        ("steps", json!({})),
        ("steps", json!([{}])),
        ("steps", json!([invalid_kind])),
        ("path", json!(42)),
        ("path", json!("unknown")),
        ("jev", json!({"calls":-1,"medianMs":0})),
        (
            "jev",
            json!({"calls":1,"medianMs":0,"callDetails":[{"scope":"unknown","questionIds":[],"ms":0,"inputTokens":null,"outcome":"ok"}]}),
        ),
        ("code", json!(42)),
        ("message", json!([])),
        ("lease", json!(false)),
        ("llmTurns", json!("one")),
        ("escapes", json!(-1)),
        ("recoveries", json!(0.5)),
    ];
    for field in [
        "blocks",
        "steps",
        "failure",
        "path",
        "jev",
        "llmTurns",
        "escapes",
        "recoveries",
    ] {
        cases.push((field, serde_json::Value::Null));
    }
    for (field, value) in cases {
        let repo = common::temp_repo();
        let mut refusal =
            json!({"verdict":"REFUSED","code":"JEV_REQUEST_INVALID","message":"refused"});
        refusal[field] = value;
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &refusal.to_string())),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(outcome.verdict, Verdict::Fail, "{field}");
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::CoreResultMissing, "{field}");
        assert!(
            failure.detail.contains("invalid ledger evidence"),
            "{field}: {}",
            failure.detail
        );
    }
}

#[test]
fn partial_and_startup_refusals_use_the_available_rows_for_missing_evidence() {
    for supplied_steps in [false, true] {
        let repo = common::temp_repo();
        let streamed = row(1, 1, "pass");
        let later = row(9, 1, "fail");
        let mut refusal =
            serde_json::json!({"verdict":"REFUSED","code":"JEV_AUTH_FAILED","message":"refused"});
        if supplied_steps {
            refusal["steps"] =
                serde_json::json!([serde_json::from_str::<serde_json::Value>(&later).unwrap()]);
        }
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!(
                "{}\n{}\n",
                envelope(2, "row", &streamed),
                envelope(3, "result", &refusal.to_string())
            ),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert!(matches!(outcome.verdict, Verdict::Refused { .. }));
        assert_eq!(outcome.exit, Some(4));
        let expected = if supplied_steps { 9 } else { 1 };
        assert_eq!(outcome.ledger.steps[0].line, expected);
        let failure = outcome.ledger.failure.unwrap();
        assert_eq!(failure.step, expected);
        assert_eq!(
            failure.screenshot,
            Some(format!("screenshots/{expected:02}.png"))
        );
        assert_eq!(failure.seen, "JEV_AUTH_FAILED: refused");
    }
}

#[test]
fn a_stuck_child_is_killed_at_the_step_budget_naming_the_last_row() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "admitted", "{}"),
        envelope(3, "row", &rows[0]),
        envelope(4, "row", &rows[1])
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, None);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
    assert_eq!(failure.phase, "walk");
    assert!(
        failure
            .detail
            .contains("no ledger row within 10s after line 2"),
        "{}",
        failure.detail
    );
    assert!(
        *mock.piped_killed[0].lock().unwrap(),
        "the child group was killed"
    );
    assert_eq!(outcome.exit, Some(-9));
    assert_eq!(outcome.ledger.failure.unwrap().step, 2);
}

#[test]
fn an_envelope_for_another_run_is_a_contract_violation() {
    let repo = common::temp_repo();
    let foreign = format!(
        r#"{{"v":1,"runId":"someone-else","seq":2,"type":"row","payload":{}}}"#,
        row(1, 1, "pass")
    );
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{foreign}\n{}\n",
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert!(
        failure.detail.contains("wire contract violated"),
        "{}",
        failure.detail
    );
    assert_eq!(outcome.ledger.verdict, "FAIL");
}

#[test]
fn a_refusal_ledger_says_refused_and_redacts_the_message() {
    let repo = common::temp_repo();
    let refusal = r#"{"verdict":"REFUSED","code":"JEV_UNAVAILABLE","message":"401 from api with Bearer sk-live-secret-token-value"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", refusal)),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.ledger.verdict, "REFUSED");
    let Verdict::Refused { message, .. } = outcome.verdict else {
        panic!("expected a refusal");
    };
    assert!(!message.contains("sk-live-secret-token-value"), "{message}");
}

#[test]
fn rows_after_the_result_line_are_a_contract_violation() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows)),
        envelope(4, "row", &row(2, 1, "pass"))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Fail);
    assert!(outcome
        .failure
        .unwrap()
        .detail
        .contains("output after the result line"));
}

#[test]
fn a_pass_result_that_is_not_a_ledger_is_a_fail() {
    let repo = common::temp_repo();
    let bogus = r#"{"verdict":"PASS"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", bogus)),
        Some(0),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Fail);
    assert!(outcome
        .failure
        .unwrap()
        .detail
        .contains("not a valid ledger"));
}

#[test]
fn a_held_verdict_survives_a_child_that_overstays_its_exit() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1]),
        envelope(4, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    // The child wrote its result, then never exits (stuck in runner teardown).
    mock.expect_spawn_piped("walk.js", 9000, &stdout, None);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(outcome.failure.is_none());
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert!(
        *mock.piped_killed[0].lock().unwrap(),
        "the overstaying child is taken down"
    );
    assert!(!outcome.group_survived);
}

#[test]
fn a_group_member_that_dies_with_the_kill_is_not_a_survivor() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    // The leader exits 0 but stdout stays open until the group is killed.
    mock.expect_spawn_piped_holding("walk.js", 9000, &stdout, Some(0), HoldStdout::UntilKill);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert!(!outcome.group_survived);
}

#[test]
fn a_group_member_that_outlives_the_kill_is_reported_as_a_survivor() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped_holding("walk.js", 9000, &stdout, Some(0), HoldStdout::Forever);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert!(outcome.group_survived);
}

fn block_ledger(path: &str, source: &str) -> serde_json::Value {
    let mut step: serde_json::Value = serde_json::from_str(&row(10, 1, "pass")).unwrap();
    step["selector"] = serde_json::json!({"id": "onboarding-finish"});
    serde_json::json!({
        "verdict": "PASS", "path": path,
        "blocks": [{"key": "plan", "outcome": "pass", "source": source}],
        "blocksWritten": ["plan"],
        "steps": [step], "jev": {"calls": 0, "medianMs": 0},
        "llmTurns": 0, "escapes": 0, "recoveries": 0
    })
}

fn run_result(result: &serde_json::Value, exit: i32) -> core::CoreOutcome {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", &result.to_string())),
        Some(exit),
    );
    run_child(&mut mock, &repo.join("core.log"))
}

#[test]
fn the_request_names_the_app_root_and_replay_ledgers_are_typed() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let result = block_ledger("replay→walk@10", "patched");
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", &result.to_string())),
        Some(0),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    let written: serde_json::Value = serde_json::from_str(mock.piped_stdin_text(0).trim()).unwrap();
    assert_eq!(written["payload"]["appRoot"], "/tmp/app");
    assert_eq!(outcome.verdict, Verdict::Pass);
    assert_eq!(outcome.ledger.path, "replay→walk@10");
    assert_eq!(outcome.ledger.blocks[0].source, "patched");
    assert_eq!(
        outcome.ledger.blocks_written,
        Some(vec!["plan".to_string()])
    );
    assert_eq!(
        outcome.ledger.steps[0]
            .selector
            .as_ref()
            .and_then(|s| s.id.as_deref()),
        Some("onboarding-finish")
    );
    for (path, source) in [("walk", "discovered"), ("replay", "replayed")] {
        assert_eq!(
            run_result(&block_ledger(path, source), 0).verdict,
            Verdict::Pass
        );
    }
}

#[test]
fn unknown_ledger_paths_and_block_sources_are_contract_violations() {
    for (path, source) in [
        ("replay→walk@", "patched"),
        ("replay→walk@x", "patched"),
        ("replay→walk@07", "patched"),
        ("rewalk", "discovered"),
        ("walk", "invented"),
    ] {
        let outcome = run_result(&block_ledger(path, source), 0);
        assert_eq!(outcome.verdict, Verdict::Fail, "{path} {source}");
        assert_eq!(
            outcome.failure.unwrap().code,
            FailureCode::CoreResultMissing,
            "{path} {source}"
        );
    }
    let mut saved = block_ledger("walk", "discovered");
    saved["blocks"][0]["saved"] = serde_json::json!(true);
    assert_eq!(run_result(&saved, 0).verdict, Verdict::Fail);
}

#[test]
fn a_refusal_during_replay_keeps_its_path_and_written_blocks() {
    let mut refusal = block_ledger("replay", "replayed");
    refusal["verdict"] = serde_json::json!("REFUSED");
    refusal["code"] = serde_json::json!("APP_PROCESS_UNKNOWN");
    refusal["message"] = serde_json::json!("the runner does not report the app process");
    let outcome = run_result(&refusal, 4);
    assert!(matches!(outcome.verdict, Verdict::Refused { .. }));
    assert_eq!(outcome.ledger.path, "replay");
    assert_eq!(
        outcome.ledger.blocks_written,
        Some(vec!["plan".to_string()])
    );
}

#[test]
fn cancellation_after_core_spawn_prevents_request_dispatch() {
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, "", None);
    mock.cancel_after = Some(("walk.js".into(), "received SIGTERM".into()));
    let result = core::spawn(
        &mut mock,
        &CmdSpec::new("core-walk", "node", &["walk.js"], 60),
        Path::new("unused.log"),
        &request(),
    );
    assert_eq!(result.err().unwrap().code, FailureCode::RunCancelled);
    assert!(mock.piped_stdin_text(0).is_empty());
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn deadline_before_admission_refuses_but_after_admission_fails() {
    for (admitted, stdout) in [
        (false, String::new()),
        (
            false,
            format!("{}\n", envelope(2, "row", &row(0, 1, "pass"))),
        ),
        (true, format!("{}\n", envelope(2, "admitted", "{}"))),
    ] {
        let repo = common::temp_repo();
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped_holding("walk.js", 9000, &stdout, None, HoldStdout::UntilKill);
        let child = core::spawn(&mut mock, &spec(), &repo.join("core.log"), &request()).unwrap();
        let outcome = core::wait(
            &mut mock,
            child,
            Budgets {
                walk_seconds: 1,
                step_seconds: 10,
            },
            &mut |_, _| {},
        );
        let failure = outcome.failure.unwrap();
        assert_eq!(
            failure.code,
            if admitted {
                FailureCode::WalkDeadlineExceeded
            } else {
                FailureCode::CoreRefused
            }
        );
        if admitted {
            assert_eq!(outcome.verdict, Verdict::Fail);
            assert_eq!(outcome.ledger.verdict, "FAIL");
        } else {
            assert!(
                matches!(outcome.verdict, Verdict::Refused { code, .. } if code == "CDP_NOT_CONNECTED")
            );
            assert_eq!(outcome.ledger.verdict, "REFUSED");
            assert!(failure.detail.contains("environment refusal"));
            assert!(failure.detail.contains("host"));
        }
        assert!(*mock.piped_killed[0].lock().unwrap());
    }
}

#[test]
fn announced_runner_drivers_reach_the_recorder_in_order_and_count_as_progress() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n{}\n",
        envelope(2, "resource", r#"{"kind":"runner_driver","pid":4242}"#),
        envelope(3, "row", &rows[0]),
        envelope(4, "resource", r#"{"kind":"runner_driver","pid":4343}"#),
        envelope(5, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let child = core::spawn(&mut mock, &spec(), &repo.join("core.log"), &request()).unwrap();
    let mut recorded = Vec::new();
    let outcome = core::wait(&mut mock, child, budgets(), &mut |_, pid| {
        recorded.push(pid)
    });
    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert_eq!(recorded, [4242, 4343]);
}

#[test]
fn core_log_redacts_test_pii_and_withholds_each_write_after_secure_promotion() {
    use qaren::exec::RealRunner;
    use qaren::redact::{with_input_scope, InputValues};
    use std::sync::Arc;
    const CODE: &str = "synthetic-code-123456";
    let repo = common::temp_repo();
    let inputs = Arc::new(InputValues::from_entries([(
        "QAREN_INPUT_CODE".into(),
        CODE.into(),
    )]));
    with_input_scope(inputs.clone(), || {
        let resolved = inputs.admit(&["CODE".into()]).unwrap();
        resolved.declare_test_pii(&["CODE".into()]);
        assert_eq!(
            CmdOutput::failed(1, "Account address").summary(),
            "[private output withheld]"
        );
        let entry = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("qaren-core/dist/qa/walk.js");
        let script = r#"
            const entry = process.argv[1];
            process.argv[1] = undefined;
            const {guardCoreLog} = await import(entry);
            const {RunInputs} = await import(new URL('./inputs.js', 'file://' + entry));
            const {createWriter} = await import(new URL('./wire.js', 'file://' + entry));
            const reader = (await import('node:readline')).createInterface({input:process.stdin});
            reader.once('line', line => {
                const {runId, payload} = JSON.parse(line);
                const inputs = new RunInputs(payload.inputs, ['CODE'], undefined, ['CODE']);
                guardCoreLog(inputs);
                process.stderr.write('before ' + payload.inputs.CODE.slice(0, 7));
                process.stderr.write(payload.inputs.CODE.slice(7) + '\n');
                inputs.protectFill('CODE', true);
                process.stderr.write('Account phone +44 7700 900123 and address 42 Test Street\n');
                const writer = createWriter(line => process.stdout.write(line), runId);
                writer.result({verdict:'PASS',path:'walk',blocks:[],steps:[],jev:{calls:0,medianMs:0},llmTurns:0,escapes:0,recoveries:0});
                reader.close(); process.stdin.destroy();
            });
        "#;
        let spec = CmdSpec::new(
            "core fixture",
            "node",
            &["--input-type=module", "-e", script, entry.to_str().unwrap()],
            5,
        );
        let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
        let log = repo.join("core.log");
        let child =
            core::spawn_private(&mut runner, &spec, &log, &request(), Some(&resolved), None)
                .unwrap();
        let outcome = core::wait(&mut runner, child, budgets(), &mut |_, _| {});
        assert_eq!(outcome.verdict, Verdict::Pass);
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(log).unwrap();
        assert!(stored.starts_with("before "), "{stored}");
        assert!(stored.contains("[private output withheld]"), "{stored}");
        for text in [CODE, "synthet", "123456", "Account phone", "42 Test Street"] {
            assert!(!stored.contains(text), "{stored}");
        }
    });
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn a_malformed_runner_driver_announcement_is_a_protocol_violation() {
    for payload in [
        r#"{"kind":"runner_driver","pid":1}"#,
        r#"{"kind":"runner_driver","pid":"4242"}"#,
        r#"{"kind":"runner_driver","pid":4242,"pgid":4242}"#,
        r#"{"kind":"metro","pid":4242}"#,
    ] {
        let repo = common::temp_repo();
        let rows = [row(1, 1, "pass")];
        let stdout = format!(
            "{}\n{}\n",
            envelope(2, "resource", payload),
            envelope(3, "result", &pass_ledger(&rows))
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let child = core::spawn(&mut mock, &spec(), &repo.join("core.log"), &request()).unwrap();
        let mut recorded = Vec::new();
        let outcome = core::wait(&mut mock, child, budgets(), &mut |_, pid| {
            recorded.push(pid)
        });
        assert_ne!(outcome.verdict, Verdict::Pass, "{payload}");
        assert!(recorded.is_empty());
    }
}

#[test]
fn step_starts_are_telemetry_and_never_ledger_rows() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(
            2,
            "start",
            r#"{"operationId":1,"line":1,"kind":"step","t":50}"#
        ),
        envelope(3, "row", &rows[0]),
        envelope(4, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Pass);
    assert_eq!(outcome.ledger.steps.len(), 1);
}

#[test]
fn a_step_start_carrying_anything_but_its_identity_is_a_protocol_violation() {
    for payload in [
        r#"{"operationId":1,"line":1,"kind":"step","t":50,"text":"Type \"secret\""}"#,
        r#"{"operationId":0,"line":1,"kind":"step","t":50}"#,
        r#"{"operationId":1,"line":0,"kind":"step","t":50}"#,
        r#"{"operationId":1,"line":1,"kind":"action","t":50}"#,
    ] {
        let repo = common::temp_repo();
        let rows = [row(1, 1, "pass")];
        let stdout = format!(
            "{}\n{}\n{}\n",
            envelope(2, "start", payload),
            envelope(3, "row", &rows[0]),
            envelope(4, "result", &pass_ledger(&rows))
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(outcome.verdict, Verdict::Fail, "{payload}");
        assert!(
            outcome.failure.unwrap().detail.contains("not a step start"),
            "{payload}"
        );
    }
}

#[test]
fn a_runner_driver_is_recorded_only_as_this_simulator_s_own_group_leader() {
    let command = "/usr/bin/xcodebuild test-without-building -project R.xcodeproj -destination platform=iOS Simulator,id=AAAA-1111";
    let real = "xcodebuild test-without-building -project /p/QarenIosRunner/QarenIosRunner.xcodeproj -scheme QarenIosRunner -destination platform=iOS Simulator,id=2E24DCF0-C991-4EB0-80CC-CCFEB9042A73 -derivedDataPath /p/build/DerivedData -only-testing:QarenIosRunnerUITests/QarenIosRunnerTests/testCommand";
    assert!(qaren::redact::OutputText::from_output(real)
        .as_str()
        .contains("2E24DCF0-C991-4EB0-80CC-CCFEB9042A73"));
    let mut mock = MockRunner::new();
    mock.expect_run("ps -o pgid= -p 4242", CmdOutput::success("4242"));
    mock.expect_run(
        "ps -p 4242 -o lstart=",
        CmdOutput::success("Wed Aug 12 16:01:00 2026"),
    );
    mock.expect_run("ps -p 4242 -o command=", CmdOutput::success(real));
    assert!(
        qaren::run::runner_driver(&mut mock, 4242, "2E24DCF0-C991-4EB0-80CC-CCFEB9042A73")
            .is_some()
    );
    for (pgid, cmd, recorded) in [
        ("4242", command, true),
        ("9000", command, false),
        (
            "4242",
            "/usr/bin/xcodebuild build-for-testing id=AAAA-1111",
            false,
        ),
        (
            "4242",
            "/usr/bin/xcodebuild test-without-building id=BBBB-2222",
            false,
        ),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run("ps -o pgid= -p 4242", CmdOutput::success(pgid));
        if pgid == "4242" {
            mock.expect_run(
                "ps -p 4242 -o lstart=",
                CmdOutput::success("Wed Aug 12 16:01:00 2026"),
            );
            mock.expect_run("ps -p 4242 -o command=", CmdOutput::success(cmd));
        }
        let driver = qaren::run::runner_driver(&mut mock, 4242, "AAAA-1111");
        assert_eq!(driver.is_some(), recorded, "{pgid} {cmd}");
        if let Some(driver) = driver {
            assert_eq!(driver.pgid, 4242);
            assert_eq!(driver.identity.pid, 4242);
        }
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn the_android_core_is_pinned_to_the_borrowed_serial_server_and_platform_tools() {
    let env = core::AndroidEnv {
        serial: "emulator-5554".to_string(),
        server_port: 5147,
        platform_tools: PathBuf::from("/sdk/platform-tools"),
    };
    let android = core::spawn_spec(
        Path::new("/usr/local/bin/node"),
        Path::new("/runtime"),
        Path::new("/tmp/app"),
        &request().lease,
        8791,
        Some(&env),
    );
    let get = |key: &str| {
        android
            .env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
            .unwrap_or_else(|| panic!("{key} unset"))
    };
    assert_eq!(get("ANDROID_SERIAL"), "emulator-5554");
    assert_eq!(get("ADB_SERVER_SOCKET"), "tcp:127.0.0.1:5147");
    assert!(
        get("PATH").starts_with("/sdk/platform-tools:"),
        "{}",
        get("PATH")
    );
    assert!(!spec()
        .env
        .iter()
        .any(|(k, _)| k == "ANDROID_SERIAL" || k == "PATH"));
}

#[test]
fn admission_facts_reach_private_diagnostics_only_as_allowlisted_admission_points() {
    use qaren::redact::{with_input_scope, InputValues};
    use serde_json::json;
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let secret = "private-synthetic-value";
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from(secret),
    )]));
    with_input_scope(inputs, || {
        let cancelled = json!({
            "kind": "metric", "stage": "admission", "edge": "point", "outcome": "failed",
            "at": 611000, "admission": "cancelled", "attempt": 20, "lastStarted": "attach",
            "lastCompleted": "retry_wait", "attachStage": "wait_targets",
            "inner": "target_readiness_timeout", "relaunches": 0, "relaunchFailed": false,
            "liveness": "alive", "bundleRequest": "received", "elapsedMs": 610000, "remainingMs": 589000, "budgetMs": 1199000
        });
        let mut retry = cancelled.clone();
        retry["outcome"] = json!("unknown");
        retry["admission"] = json!("retry");
        retry["lastStarted"] = json!("foreign_driver");
        retry["lastCompleted"] = json!("foreign_driver");
        retry["liveness"] = json!("probe_failed");
        retry["relaunches"] = json!(1);
        retry["relaunchFailed"] = json!(true);
        retry.as_object_mut().unwrap().remove("attachStage");
        let mut refused = cancelled.clone();
        refused["admission"] = json!("refused");
        refused["inner"] = json!("none");
        let expected = vec![retry, cancelled.clone(), refused];
        let mut payloads = expected.clone();
        for (key, value) in [
            ("admission", json!(secret)),
            ("lastStarted", json!(secret)),
            ("lastCompleted", json!(secret)),
            ("attachStage", json!(secret)),
            ("inner", json!(secret)),
            ("liveness", json!(secret)),
            ("bundleRequest", json!(secret)),
            ("relaunchFailed", json!(secret)),
            ("relaunchFailed", json!(1)),
            ("attempt", json!(secret)),
            ("elapsedMs", json!(-1)),
            ("stage", json!("capture")),
            ("edge", json!("end")),
            ("inference", json!({"targets": []})),
        ] {
            let mut invalid = cancelled.clone();
            invalid[key] = value;
            payloads.push(invalid);
        }
        let mut stdout = String::new();
        for (i, value) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &value.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            payloads.len() as u64 + 2,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(!stored.contains(secret));
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, expected);
    });
}

#[test]
fn exact_selection_refusal_classes_survive_private_diagnostics() {
    use qaren::redact::{with_input_scope, InputValues};
    use serde_json::json;
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from("private-synthetic-value"),
    )]));
    let expected: Vec<serde_json::Value> = [
        "target_selection_device_not_found",
        "target_selection_device_ambiguous",
        "target_selection_bundle_not_found",
    ]
    .iter()
    .map(|inner| {
        json!({
            "kind": "metric", "stage": "admission", "edge": "point", "outcome": "failed",
            "at": 1000, "admission": "refused", "attempt": 1, "lastStarted": "attach",
            "lastCompleted": "none", "attachStage": "connect_exact", "inner": inner,
            "relaunches": 0, "relaunchFailed": false, "liveness": "not_probed",
            "elapsedMs": 900, "remainingMs": 100, "budgetMs": 1000
        })
    })
    .collect();
    let mut stdout = String::new();
    for (i, value) in expected.iter().enumerate() {
        stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &value.to_string()));
        stdout.push('\n');
    }
    stdout.push_str(&envelope(
        expected.len() as u64 + 2,
        "result",
        &pass_ledger(&[]),
    ));
    stdout.push('\n');
    with_input_scope(inputs, || {
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, expected);
    });
}

#[test]
fn screenshot_withholding_metrics_accept_only_closed_words_on_withheld_frames() {
    use qaren::redact::{with_input_scope, InputValues};
    use serde_json::json;
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from("private-synthetic-value"),
    )]));
    with_input_scope(inputs, || {
        let metric = json!({"kind":"metric","stage":"screenshot","edge":"point","outcome":"withheld","at":1,"withheld":"echo","source":"typed"});
        let qualified = json!({"kind":"other","stage":"screenshot","edge":"point","outcome":"withheld","at":1,"withheld":"generic-value"});
        let mut wrong_stage = qualified.clone();
        wrong_stage["stage"] = "capture".into();
        let mut wrong_kind = qualified.clone();
        wrong_kind["kind"] = "private-synthetic-value".into();
        let mut payloads = vec![metric.clone(), qualified.clone(), wrong_stage, wrong_kind];
        for (key, value) in [
            ("stage", "capture"),
            ("outcome", "ok"),
            ("withheld", "private-synthetic-value"),
            ("source", "private-synthetic-value"),
        ] {
            let mut invalid = metric.clone();
            invalid[key] = value.into();
            payloads.push(invalid);
        }
        let mut stdout = String::new();
        for (i, payload) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &payload.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(
            payloads.len() as u64 + 2,
            "result",
            &pass_ledger(&[]),
        ));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        assert_eq!(
            run_child(&mut mock, &repo.join("core.log")).verdict,
            Verdict::Pass
        );
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        let got: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(got, vec![metric, qualified]);
    });
}

#[test]
fn media_diagnostics_reach_the_private_sink_with_unused_or_absent_inputs() {
    use qaren::exec::RealRunner;
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    for unused in [true, false] {
        let entries = if unused {
            vec![(
                OsString::from("QAREN_INPUT_PASSWORD"),
                OsString::from("private-canary"),
            )]
        } else {
            vec![]
        };
        with_input_scope(Arc::new(InputValues::from_entries(entries)), || {
            let repo = common::temp_repo();
            let wire = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("qaren-core/dist/qa/wire.js");
            let script = r#"
                const {createWriter} = await import(process.argv[1]);
                const reader = (await import('node:readline')).createInterface({input: process.stdin});
                reader.once('line', input => {
                    const {runId} = JSON.parse(input);
                    if (process.argv[2] === 'unused') process.stderr.write('private-canary\n');
                    const writer = createWriter(line => process.stdout.write(line), runId);
                    for (const scope of ['screenshots', 'video']) writer.diagnostic({kind:'media-withheld', scope, cause:{reason:'secure-field'}, line:1});
                    process.stdout.write(JSON.stringify({v:1, runId, seq:writer.seq+1, type:'result', payload:{verdict:'PASS',path:'walk',blocks:[],steps:[],jev:{calls:0,medianMs:0},llmTurns:0,escapes:0,recoveries:0}})+'\n');
                    reader.close(); process.stdin.destroy();
                });
            "#;
            let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
            let fixture = CmdSpec::new(
                "fixture",
                "node",
                &[
                    "--input-type=module",
                    "-e",
                    script,
                    wire.to_str().unwrap(),
                    if unused { "unused" } else { "absent" },
                ],
                5,
            );
            let log_path = repo.join("core.log");
            let child =
                core::spawn_private(&mut runner, &fixture, &log_path, &request(), None, None)
                    .unwrap();
            let result = core::wait(&mut runner, child, budgets(), &mut |_, _| {});
            assert_eq!(result.verdict, Verdict::Pass);
            let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
            let records: Vec<serde_json::Value> = stored
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(
                records,
                vec![
                    serde_json::json!({"kind":"media-withheld","scope":"screenshots","cause":{"reason":"secure-field"},"line":1}),
                    serde_json::json!({"kind":"media-withheld","scope":"video","cause":{"reason":"secure-field"},"line":1}),
                ]
            );
            let log = std::fs::read_to_string(log_path).unwrap();
            assert!(!log.contains("private-canary"));
            assert_eq!(log.contains("[private output withheld]"), unused);
            assert_eq!(
                log.lines()
                    .filter(|line| line.starts_with("media-withheld "))
                    .count(),
                2
            );
            std::fs::remove_dir_all(repo).unwrap();
        });
    }
}

#[test]
fn manifest_probe_and_relaunch_timings_reach_the_run_receipt() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let verify = || {
        let repo = common::temp_repo();
        let events = [
            serde_json::json!({
                "kind": "metric", "stage": "manifest-probe", "edge": "end", "outcome": "failed",
                "at": 10000, "ms": 10000, "count": 1, "method": "timeout"
            }),
            serde_json::json!({
                "kind": "metric", "stage": "manifest-probe", "edge": "end", "outcome": "ok",
                "at": 12000, "ms": 1000, "count": 2, "method": "unknown"
            }),
            serde_json::json!({
                "kind": "metric", "stage": "dev-client-relaunch", "edge": "end", "outcome": "ok",
                "at": 13000, "ms": 500, "count": 1, "relaunch": "ready"
            }),
        ];
        let mut stdout = String::new();
        for (i, event) in events.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &event.to_string()));
            stdout.push('\n');
        }
        stdout.push_str(&envelope(5, "result", &pass_ledger(&[])));
        stdout.push('\n');
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        let actual: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(actual, events);
    };
    verify();
    with_input_scope(
        Arc::new(InputValues::from_entries([(
            OsString::from("QAREN_INPUT_PASSWORD"),
            OsString::from("synthetic-password"),
        )])),
        verify,
    );
}

#[test]
fn press_evidence_survives_refusal_normalization_with_closed_fields() {
    let evidence = serde_json::json!({"subreason":"selection_unverified","heldPress":"not_tried_unsafe","outsideTargetChange":true,"captures":2});
    for code in [
        "PRESS_NOT_REGISTERED",
        "NATIVE_CAPTURE_UNAVAILABLE",
        "ITEM_DEADLINE_EXCEEDED",
        "EVIDENCE_EXPIRED",
        "RUN_CANCELLED",
    ] {
        let result = serde_json::json!({"verdict":"REFUSED", "code":code, "message":"Selection could not be verified; no second press was sent.", "pressEvidence":evidence});
        let outcome = run_result(&result, 4);
        assert!(matches!(outcome.verdict, Verdict::Refused { .. }));
        assert_eq!(
            serde_json::to_value(outcome.ledger).unwrap()["pressEvidence"],
            evidence
        );
    }
    let mut cases = vec![serde_json::Value::Null, serde_json::json!({})];
    for (key, value) in [
        ("subreason", serde_json::json!("PRIVATE_CANARY")),
        ("heldPress", serde_json::json!("tried")),
        ("outsideTargetChange", serde_json::json!("PRIVATE_CANARY")),
        ("captures", serde_json::json!(3)),
        ("captures", serde_json::json!(0)),
        ("extra", serde_json::json!("PRIVATE_CANARY")),
    ] {
        let mut invalid = evidence.clone();
        invalid[key] = value;
        cases.push(invalid);
    }
    for invalid in cases {
        let outcome = run_result(
            &serde_json::json!({"verdict":"REFUSED","code":"PRESS_NOT_REGISTERED","pressEvidence":invalid}),
            4,
        );
        assert_eq!(outcome.verdict, Verdict::Fail);
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::CoreResultMissing);
        assert!(!failure.detail.contains("PRIVATE_CANARY"));
    }
    assert_eq!(run_result(&serde_json::json!({"verdict":"REFUSED","code":"PRESS_NOT_REGISTERED","pressEvidence":evidence}), 0).verdict, Verdict::Fail);
}

#[test]
fn signal_cancellation_preserves_validated_press_evidence_from_the_child_result() {
    let repo = common::temp_repo();
    let evidence = serde_json::json!({"subreason":"selection_unverified","heldPress":"not_tried_unsafe","outsideTargetChange":false,"captures":2});
    let result =
        serde_json::json!({"verdict":"REFUSED","code":"RUN_CANCELLED","pressEvidence":evidence});
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped_holding(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", &result.to_string())),
        None,
        HoldStdout::UntilKill,
    );
    mock.cancel_at_ms = Some((mock.monotonic_ms() + 50, "received SIGTERM".into()));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert!(matches!(&outcome.verdict, Verdict::Refused { code, .. } if code == "RUN_CANCELLED"));
    assert_eq!(outcome.failure.unwrap().code, FailureCode::RunCancelled);
    assert_eq!(
        serde_json::to_value(outcome.ledger).unwrap()["pressEvidence"],
        evidence
    );
    assert!(*mock.piped_terminated[0].lock().unwrap());
}
