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
        (admission_output("unknown", "scan_failed"), Some(FailureCode::FreshInstallAdmissionUnknown), "scan_failed"),
        (admission_output("unknown", "scan_timeout"), Some(FailureCode::FreshInstallAdmissionUnknown), "scan_timeout"),
        (admission_output("unknown", "candidate_budget_exceeded"), Some(FailureCode::FreshInstallAdmissionUnknown), "candidate_budget_exceeded"),
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
    // AI-511: `waits` is the process-scan wait of each scan that was dispatched, and of no other.
    for (allowance, per_read, expected_attempts, terminal, elapsed, waits) in [
        (30_000, 10_000, 2, "clear", 20_500, ""),
        (30_000, 15_000, 2, "deadline_exceeded", 30_500, "2000,2000"),
        (60_000, 15_000, 2, "deadline_exceeded", 30_500, "2000,2000"),
        (30_000, 30_000, 1, "deadline_exceeded", 30_000, "2000"),
        (600, 100, 1, "deadline_exceeded", 600, "2000"),
        (700, 100, 2, "deadline_exceeded", 700, "2000,2000"),
        (0, 0, 0, "deadline_exceeded", 0, "none"),
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
            assert!(
                failure.detail.contains(&format!(
                    "; attempts={expected_attempts}; scan_timeouts_ms={waits}; host "
                )),
                "{}",
                failure.detail
            );
            assert!(failure.detail.contains("deadline_exceeded=true"));
            if allowance == 0 {
                assert!(failure.detail.contains("probe_status=not_run"));
                assert!(failure.detail.contains("timed_out=false"));
                assert!(!failure.detail.contains("invalid_response"));
            }
            if allowance == 600 {
                // AI-511: the allowance ran out in the pause; the answer that was observed stays in the refusal.
                assert!(failure.detail.contains(
                    r#"probe_status=unknown; probe_evidence={"reason":"executable_identity_unproven","pid":812}; exit_code=Some(4); timed_out=false; deadline_exceeded=true"#
                ), "{}", failure.detail);
            }
            admission_failure_summary(&failure)
        };
        assert_eq!(summary["terminalReason"], terminal);
        assert_eq!(summary["attempts"], expected_attempts);
        assert_eq!(summary["elapsedMs"], elapsed);
        assert_eq!(summary["deadlineExceeded"], terminal != "clear");
        assert_eq!(mock.remaining(), 0);
        if expected_attempts > 0 {
            assert_eq!(mock.calls[0].timeout_seconds, allowance.min(30_000) / 1000);
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
        let repo = common::temp_repo();
        let mut record = common::base_record(
            &repo,
            &common::ios_scenario_yaml(8791),
            "admitrun",
            qaren::runrecord::Phase::Failed,
        );
        record.failure = Some(failure.clone());
        record.save(&repo).unwrap();
        let loaded = qaren::runrecord::RunRecord::load(&repo, "admitrun")
            .unwrap()
            .failure
            .unwrap();
        assert_eq!(loaded.phase, "fresh_install");
        assert_eq!(
            admission_failure_summary(&loaded)["terminalReason"],
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
            assert!(failure.evidence.is_empty(), "{:?}", failure.evidence);
        }
        // AI-511: 53 scans and one identity re-probe are the most one allowance can hold.
        for (attempts, kept) in [(54, true), (55, false)] {
            let note = serde_json::json!({"probe":"fresh-install-admission","initialReason":"clear","terminalReason":"clear","attempts":attempts,"elapsedMs":0,"deadlineExceeded":false}).to_string();
            let output = qaren::redact::durable_json(
                &serde_json::json!({"outcomes":{"admission_before_deps":note}}),
            )
            .unwrap();
            assert_eq!(output.contains("clear"), kept, "{attempts}");
        }
    });
}

// AI-511: a scan that timed out is repeated with a longer wait while the allowance lasts.
fn timed_out_scan(platform: &str, device: &str, reason: &str) -> CmdOutput {
    let mut evidence = serde_json::json!({ "reason": reason });
    if reason != "scan_timeout" {
        evidence["pid"] = 812.into();
    }
    CmdOutput {
        exit_code: Some(4),
        stdout: serde_json::json!({"v":1,"platform":platform,"deviceId":device,"status":"unknown","evidence":evidence})
            .to_string(),
        ..Default::default()
    }
}

fn clear_scan(platform: &str, device: &str) -> CmdOutput {
    CmdOutput::success(
        &serde_json::json!({"v":1,"platform":platform,"deviceId":device,"status":"clear"})
            .to_string(),
    )
}

fn admit_on(
    mock: &mut MockRunner,
    platform: &str,
    deadline: Option<u64>,
) -> Result<core::AdmissionSummary, qaren::failure::Failure> {
    let android = core::AndroidEnv {
        serial: "emulator-5554".into(),
        server_port: 5038,
        platform_tools: "/android/platform-tools".into(),
    };
    core::fresh_install_admission(
        mock,
        Path::new("/node"),
        Path::new("/runtime"),
        Path::new("/app"),
        if platform == "ios" { "AAAA-1111" } else { "emulator-5554" },
        (platform == "android").then_some(&android),
        deadline,
    )
}

// The wait a scan command was told; None is the scanner's own 2 seconds.
fn scan_wait(spec: &CmdSpec) -> Option<&str> {
    let at = spec.args.iter().position(|arg| arg == "--scan-timeout-ms")?;
    assert_eq!(at, spec.args.len() - 2, "the wait is the last argument pair");
    Some(spec.args[at + 1].as_str())
}

// The advice of an unknown admission refusal that is not a foreign-owner case; an out-of-time refusal keeps it.
const UNKNOWN_NEXT: &str = "run qaren doctor; restore process observation and the qaren runtime, resolve the reported probe or deadline failure, then re-run the check; do not signal or adopt unproven processes";

fn read_host_load_1m() -> Option<f64> {
    let mut reading = 0.0f64;
    (unsafe { libc::getloadavg(&mut reading, 1) } == 1).then_some(reading)
}

// The tokens every out-of-time refusal adds to its detail. Its advice and recovery are the unchanged ones.
fn assert_out_of_time(failure: &qaren::failure::Failure, attempts: usize, waits: &str) {
    assert_eq!(failure.code, FailureCode::FreshInstallAdmissionUnknown);
    let detail = failure.detail.as_str();
    let (_, load) = detail
        .split_once(&format!("; attempts={attempts}; scan_timeouts_ms={waits}; "))
        .unwrap_or_else(|| panic!("{detail}"));
    // The reading is this machine's own: a finite non-negative number wherever the machine can give one.
    if read_host_load_1m().is_some() {
        assert!(
            load.strip_prefix("host 1-minute load ")
                .is_some_and(|n| n.parse::<f64>().is_ok_and(|n| n.is_finite() && n >= 0.0)),
            "{detail}"
        );
    } else {
        assert_eq!(load, "host load unavailable", "{detail}");
    }
    assert!(!detail.contains("did not prove the selected device clear"), "{detail}");
    assert_eq!(failure.next_action.as_str(), UNKNOWN_NEXT);
    assert_eq!(
        failure.build_recovery().unwrap(),
        &qaren::failure::Recovery::new(qaren::failure::RecoveryReason::IdentityUnavailable)
    );
}

// A clock on which every reading costs a millisecond, so two readings never agree.
struct TickingRunner {
    mock: MockRunner,
    ticks: std::cell::Cell<u64>,
}

impl Runner for TickingRunner {
    fn execute(&mut self, spec: &CmdSpec, interruptible: bool) -> CmdOutput {
        self.mock.execute(spec, interruptible)
    }
    fn spawn_group_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.mock.spawn_group_unchecked(spec, log)
    }
    fn spawn_piped_unchecked(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.mock.spawn_piped_unchecked(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        self.mock.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.ticks.set(self.ticks.get() + 1);
        self.mock.now_epoch_ms() + self.ticks.get()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
}

#[test]
fn fresh_admission_decides_the_command_time_and_the_wait_from_one_clock_reading() {
    // Sweep the allowance by the millisecond across whole-second boundaries and across expiry.
    for allowance in 3_000..9_000u64 {
        let mock = MockRunner::new();
        let mut runner = TickingRunner { mock, ticks: std::cell::Cell::new(0) };
        let deadline = runner.now_epoch_ms() + allowance;
        // More answers than any of these allowances can use.
        for _ in 0..14 {
            runner.mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
        }
        let failure = core::fresh_install_admission(
            &mut runner,
            Path::new("/node"),
            Path::new("/runtime"),
            Path::new("/app"),
            "AAAA-1111",
            None,
            Some(deadline),
        )
        .unwrap_err();
        let summary = admission_failure_summary(&failure);
        // Every counted attempt is a command that was handed to the runner.
        assert_eq!(summary["attempts"], runner.mock.calls.len(), "{allowance}");
        // With more than 4.6 s of allowance a second scan always fits after the first answer and the pause.
        assert!(allowance < 4_600 || runner.mock.calls.len() >= 2, "{allowance}");
        for call in &runner.mock.calls[1..] {
            // A scan after a timed-out read always has its wait plus the full reserve inside its command.
            let wait: u64 = scan_wait(call).unwrap_or("2000").parse().unwrap();
            assert!(wait + 2_000 <= call.timeout_seconds * 1_000, "{allowance}: {wait} in {}s", call.timeout_seconds);
        }
    }
}

#[test]
fn fresh_admission_repeats_a_timed_out_scan_with_a_longer_wait_and_admits() {
    for (platform, device) in [("ios", "AAAA-1111"), ("android", "emulator-5554")] {
        for (reason, timed_out) in [
            ("scan_timeout", 1),
            ("scan_timeout", 3),
            ("observer_timeout", 1),
            // The fifth answer clears: the last wait is kept, the scans do not stop at four.
            ("observer_timeout", 4),
            ("deadline_exceeded", 1),
            // The scanner also reports its own deadline without a pid.
            ("deadline_exceeded without a pid", 1),
        ] {
            if platform == "android" && reason != "scan_timeout" {
                continue;
            }
            let mut mock = MockRunner::new();
            for _ in 0..timed_out {
                mock.expect_run(
                    "fresh-install-preflight.js",
                    match reason.strip_suffix(" without a pid") {
                        Some(reason) => CmdOutput {
                            exit_code: Some(4),
                            stdout: serde_json::json!({"v":1,"platform":platform,"deviceId":device,"status":"unknown","evidence":{"reason":reason}}).to_string(),
                            ..Default::default()
                        },
                        None => timed_out_scan(platform, device, reason),
                    },
                );
            }
            let reason = reason.trim_end_matches(" without a pid");
            mock.expect_run("fresh-install-preflight.js", clear_scan(platform, device));
            let summary =
                serde_json::to_value(admit_on(&mut mock, platform, None).unwrap()).unwrap();
            assert_eq!(summary["initialReason"], reason);
            assert_eq!(summary["terminalReason"], "clear");
            assert_eq!(summary["attempts"], timed_out + 1);
            assert_eq!(summary["elapsedMs"], 500 * timed_out);
            assert_eq!(summary["deadlineExceeded"], false);
            assert_eq!(
                mock.calls.iter().map(scan_wait).collect::<Vec<_>>(),
                [None, Some("4000"), Some("8000"), Some("16000"), Some("16000")][..=timed_out],
                "{platform} {reason}"
            );
            for (index, call) in mock.calls.iter().enumerate() {
                // Each command gets the whole seconds the allowance leaves; apart from the wait it is the same scan.
                assert_eq!(call.timeout_seconds, (30_000 - 500 * index as u64) / 1000);
                let mut first = mock.calls[0].clone();
                let mut later = call.clone();
                if index > 0 {
                    later.args.truncate(later.args.len() - 2);
                }
                first.timeout_seconds = later.timeout_seconds;
                assert_eq!(first, later);
            }
            assert_eq!(mock.remaining(), 0);
        }
    }
}

#[test]
fn fresh_admission_refuses_spent_scans_as_out_of_time_with_attempts_waits_and_load() {
    for (platform, device) in [("ios", "AAAA-1111"), ("android", "emulator-5554")] {
        // per_read is what each scan costs on the clock. A later wait is cut to the whole seconds its command
        // gets, less the 2-second reserve; when that is under 2 seconds no scan starts and the last answer stands.
        for (allowance, per_read, waits, elapsed) in [
            (30_000, 6_500, vec![None, Some("4000"), Some("8000"), Some("7000")], 28_000),
            (30_000, 9_000, vec![None, Some("4000"), Some("8000")], 28_500),
            (30_000, 13_000, vec![None, Some("4000")], 27_000),
            // No room after the pause: the one scan's refusal stands and lists that one scan.
            (700, 100, vec![None], 600),
        ] {
            let mut mock = MockRunner::new();
            let start = mock.monotonic_ms();
            mock.advance_on = Some(("fresh-install-preflight.js".into(), per_read));
            let attempts = waits.len();
            for _ in 0..attempts {
                mock.expect_run("fresh-install-preflight.js", timed_out_scan(platform, device, "scan_timeout"));
            }
            let load_before = read_host_load_1m().map(|load| format!("{load:.1}"));
            let failure = admit_on(&mut mock, platform, Some(start + allowance)).unwrap_err();
            let load_after = read_host_load_1m().map(|load| format!("{load:.1}"));
            let listed = waits.iter().map(|wait| wait.unwrap_or("2000")).collect::<Vec<_>>().join(",");
            assert_out_of_time(&failure, attempts, &listed);
            if let (Some(before), Some(after)) = (&load_before, &load_after) {
                if before == after {
                    assert!(
                        failure.detail.ends_with(&format!("; host 1-minute load {before}")),
                        "{}",
                        failure.detail
                    );
                }
            }
            assert!(
                failure.detail.starts_with("the process-table read timed out before admission could prove the device clear; probe_status=unknown; probe_evidence={\"reason\":\"scan_timeout\"}; exit_code=Some(4); timed_out=false; deadline_exceeded=false; attempts="),
                "{}",
                failure.detail
            );
            // The child was told exactly the waits the refusal lists.
            assert_eq!(mock.calls.iter().map(scan_wait).collect::<Vec<_>>(), waits);
            let summary = admission_failure_summary(&failure);
            assert_eq!(summary["initialReason"], "scan_timeout");
            assert_eq!(summary["terminalReason"], "scan_timeout");
            assert_eq!(summary["attempts"], attempts);
            assert_eq!(summary["elapsedMs"], elapsed);
            assert_eq!(summary["deadlineExceeded"], false);
            assert_eq!(mock.remaining(), 0);
        }
    }
}

#[test]
fn fresh_admission_cuts_a_longer_wait_to_the_whole_seconds_its_command_gets() {
    // Two scans time out 100 ms each; the third is dispatched 1.2 s in, with its 8 s step in force.
    for (allowance, wait, command_seconds) in [
        // 10.875 s left: a 10 s command, so 8 s of wait and a full 2 s reserve.
        (12_075, "8000", 10),
        // 9.999 s left: a 9 s command, so 7 s of wait.
        (11_199, "7000", 9),
        // 4.0 s left: a 4 s command, so the scanner's own 2 s and no argument.
        (5_200, "2000", 4),
    ] {
        let mut mock = MockRunner::new();
        let start = mock.monotonic_ms();
        mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
        for _ in 0..2 {
            mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
        }
        mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
        admit_on(&mut mock, "ios", Some(start + allowance)).unwrap();
        assert_eq!(scan_wait(&mock.calls[2]).unwrap_or("2000"), wait, "{allowance}");
        assert_eq!(mock.calls[2].timeout_seconds, command_seconds, "{allowance}");
        assert_eq!(mock.remaining(), 0);
    }
    // One millisecond less: the second scan already had room for 2 s only, and 3.999 s left then gives a 3 s
    // command with no room for a 2 s wait, so the second timeout stands.
    let mut mock = MockRunner::new();
    let start = mock.monotonic_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
    for _ in 0..2 {
        mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
    }
    mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
    let failure = admit_on(&mut mock, "ios", Some(start + 5_199)).unwrap_err();
    assert_out_of_time(&failure, 2, "2000,2000");
    assert_eq!(mock.remaining(), 1, "the queued clear answer was never asked for");
}

#[test]
fn fresh_admission_names_which_read_ran_out_of_time() {
    for (reason, opening) in [
        ("observer_timeout", "the time available to establish process identity ran out before admission could prove the device clear; "),
        ("deadline_exceeded", "the scan exhausted its 20-second time budget before admission could prove the device clear; "),
    ] {
        let mut mock = MockRunner::new();
        let start = mock.monotonic_ms();
        mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", reason));
        // 3.5 s of allowance: after the pause the command would get 3 s, which leaves no 2 s wait.
        let failure = admit_on(&mut mock, "ios", Some(start + 3_500)).unwrap_err();
        assert!(failure.detail.starts_with(opening), "{}", failure.detail);
        assert_out_of_time(&failure, 1, "2000");
        let summary = admission_failure_summary(&failure);
        assert_eq!(summary["terminalReason"], reason);
        assert_eq!(summary["deadlineExceeded"], false);
        assert_eq!(summary["elapsedMs"], 500);
    }
    // The allowance ran out during the pause: no second scan is listed, and it reads as an expired allowance.
    let mut mock = MockRunner::new();
    let start = mock.monotonic_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
    mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
    let failure = admit_on(&mut mock, "ios", Some(start + 600)).unwrap_err();
    // The answer that was observed stays in the refusal; only an admission with no scan at all says not_run.
    assert!(
        failure.detail.starts_with(r#"admission allowance expired; probe_status=unknown; probe_evidence={"reason":"scan_timeout"}; exit_code=Some(4); timed_out=false; deadline_exceeded=true; "#),
        "{}",
        failure.detail
    );
    assert_out_of_time(&failure, 1, "2000");
    assert_eq!(admission_failure_summary(&failure)["terminalReason"], "deadline_exceeded");
    // Identity uncertainty, then a read stopped for time, then the allowance runs out in the pause: the last
    // typed cause is still there.
    let mut mock = MockRunner::new();
    let start = mock.monotonic_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
    mock.expect_run("fresh-install-preflight.js", admission_output("unknown", "executable_identity_unproven"));
    mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "observer_timeout"));
    let failure = admit_on(&mut mock, "ios", Some(start + 1_200)).unwrap_err();
    assert!(
        failure.detail.starts_with(r#"admission allowance expired; probe_status=unknown; probe_evidence={"reason":"observer_timeout","pid":812}; exit_code=Some(4); timed_out=false; deadline_exceeded=true; "#),
        "{}",
        failure.detail
    );
    assert_out_of_time(&failure, 2, "2000,2000");
    let summary = admission_failure_summary(&failure);
    assert_eq!(
        (summary["initialReason"].as_str(), summary["terminalReason"].as_str(), summary["deadlineExceeded"].as_bool()),
        (Some("executable_identity_unproven"), Some("deadline_exceeded"), Some(true))
    );
    // A busy answer that arrives after the deadline keeps its status and is not a busy refusal.
    let mut mock = MockRunner::new();
    let start = mock.monotonic_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 200));
    mock.expect_run("fresh-install-preflight.js", admission_output("busy", "driver_on_selected_device"));
    let failure = admit_on(&mut mock, "ios", Some(start + 100)).unwrap_err();
    assert!(
        failure.detail.starts_with(r#"admission allowance expired; probe_status=busy; probe_evidence={"reason":"driver_on_selected_device","pid":812}; "#),
        "{}",
        failure.detail
    );
    assert_out_of_time(&failure, 1, "2000");
    // A command the CLI had to stop is out of time too, and is not scanned again.
    let mut mock = MockRunner::new();
    mock.expect_run(
        "fresh-install-preflight.js",
        CmdOutput { timed_out: true, ..timed_out_scan("ios", "AAAA-1111", "scan_timeout") },
    );
    mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
    let failure = admit_on(&mut mock, "ios", None).unwrap_err();
    assert!(failure.detail.starts_with("the admission scan command did not answer within its time; "), "{}", failure.detail);
    assert_out_of_time(&failure, 1, "2000");
    assert_eq!(mock.remaining(), 1, "the queued clear answer was never asked for");
    // An earlier typed timeout followed by an empty stopped command replaces the earlier answer with the
    // transport failure, and does not scan again.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
    mock.expect_run(
        "fresh-install-preflight.js",
        CmdOutput {
            exit_code: None,
            timed_out: true,
            ..Default::default()
        },
    );
    mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
    let failure = admit_on(&mut mock, "ios", None).unwrap_err();
    assert_eq!(mock.calls.len(), 2);
    assert_eq!(
        mock.calls.iter().map(scan_wait).collect::<Vec<_>>(),
        [None, Some("4000")]
    );
    assert!(
        failure.detail.starts_with(
            "the admission scan command did not answer within its time; probe_status=invalid; probe_evidence=invalid_response; exit_code=None; timed_out=true; deadline_exceeded=false; "
        ),
        "{}",
        failure.detail
    );
    assert_out_of_time(&failure, 2, "2000,4000");
    assert_eq!(mock.remaining(), 1, "the queued clear answer was never asked for");
}

#[test]
fn fresh_admission_repeats_only_a_typed_timeout_and_never_a_busy_or_failed_scan() {
    let with = |platform: &str, status: &str, evidence: serde_json::Value| CmdOutput {
        exit_code: Some(4),
        stdout: serde_json::json!({"v":1,"platform":platform,
            "deviceId": if platform == "ios" { "AAAA-1111" } else { "emulator-5554" },
            "status":status,"evidence":evidence})
        .to_string(),
        ..Default::default()
    };
    let timeout = serde_json::json!({"reason":"scan_timeout"});
    use qaren::failure::RecoveryAction::{RestoreProcessObservation, WaitForOwner};
    for (platform, output, code, action) in [
        // A busy answer is never scanned again, whatever reason travels with it.
        ("ios", with("ios", "busy", timeout.clone()), FailureCode::DeviceBusy, RestoreProcessObservation),
        ("android", with("android", "busy", timeout.clone()), FailureCode::DeviceBusy, WaitForOwner),
        ("ios", with("ios", "busy", serde_json::json!({"reason":"driver_on_selected_device","pid":812})), FailureCode::DeviceBusy, WaitForOwner),
        // Not about time.
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_failed"})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_unavailable"})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"observer_failed","pid":812})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"driver_identity_unproven","pid":812})), FailureCode::FreshInstallAdmissionUnknown, WaitForOwner),
        // A timeout in a shape the platform's scanner never reports keeps the existing guidance.
        ("android", with("android", "unknown", serde_json::json!({"reason":"observer_timeout","pid":812})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("android", with("android", "unknown", serde_json::json!({"reason":"deadline_exceeded"})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"observer_timeout"})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_timeout","pid":812})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_timeout","candidates":3})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_timeout","extra":1})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        // A member the scanner never writes, even as null, is not its shape.
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"scan_timeout","pid":null})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("android", with("android", "unknown", serde_json::json!({"reason":"scan_timeout","candidates":null})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"observer_timeout","pid":812,"candidates":null})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"observer_timeout","pid":812,"candidates":2})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"deadline_exceeded","pid":null})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", with("ios", "unknown", serde_json::json!({"reason":"deadline_exceeded","candidates":2})), FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", CmdOutput { exit_code: Some(0), ..with("ios", "unknown", timeout.clone()) }, FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        ("ios", CmdOutput { exit_code: Some(1), ..with("ios", "unknown", timeout.clone()) }, FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
        // An unknown without evidence stays the unnamed unknown it was.
        ("android", CmdOutput { exit_code: Some(4), ..CmdOutput::success(r#"{"v":1,"platform":"android","deviceId":"emulator-5554","status":"unknown"}"#) }, FailureCode::FreshInstallAdmissionUnknown, RestoreProcessObservation),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run("fresh-install-preflight.js", output);
        mock.expect_run("fresh-install-preflight.js", clear_scan(platform, if platform == "ios" { "AAAA-1111" } else { "emulator-5554" }));
        let failure = admit_on(&mut mock, platform, None).unwrap_err();
        assert_eq!(failure.code, code, "{}", failure.detail);
        assert_eq!(failure.build_recovery().unwrap().action, action, "{}", failure.detail);
        assert!(!failure.detail.contains("scan_timeouts_ms"), "{}", failure.detail);
        assert_eq!(admission_failure_summary(&failure)["attempts"], 1);
        assert_eq!(mock.calls.len(), 1);
        assert_eq!(mock.remaining(), 1, "the queued clear answer was never asked for");
    }
    // Forms the evidence decoder accepts but the scanner never writes, exactly as they would arrive.
    for evidence in [
        r#"["scan_timeout",null,null]"#,
        r#"{"reason":{"scan_timeout":null}}"#,
        r#"["observer_timeout",812,null]"#,
        r#"{"reason":{"deadline_exceeded":null},"pid":812}"#,
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run(
            "fresh-install-preflight.js",
            CmdOutput {
                exit_code: Some(4),
                stdout: format!(r#"{{"v":1,"platform":"ios","deviceId":"AAAA-1111","status":"unknown","evidence":{evidence}}}"#),
                ..Default::default()
            },
        );
        mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
        let failure = admit(&mut mock, None).unwrap_err();
        assert_eq!(failure.build_recovery().unwrap().action, RestoreProcessObservation, "{evidence}");
        assert!(!failure.detail.contains("scan_timeouts_ms"), "{evidence}: {}", failure.detail);
        assert_eq!(mock.remaining(), 1, "{evidence}: the queued clear answer was never asked for");
    }
    // A scan that timed out and is then answered busy: the busy answer ends it.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "scan_timeout"));
    mock.expect_run("fresh-install-preflight.js", admission_output("busy", "driver_on_selected_device"));
    mock.expect_run("fresh-install-preflight.js", clear_scan("ios", "AAAA-1111"));
    let failure = admit(&mut mock, None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert_eq!(failure.build_recovery().unwrap().action, WaitForOwner);
    let summary = admission_failure_summary(&failure);
    assert_eq!((summary["attempts"].as_u64(), summary["initialReason"].as_str(), summary["terminalReason"].as_str()), (Some(2), Some("scan_timeout"), Some("driver_on_selected_device")));
    assert_eq!(mock.remaining(), 1);
}

#[test]
fn fresh_admission_keeps_one_identity_reprobe_beside_the_longer_scans() {
    let clear = || admission_output("clear", "scan_failed");
    let identity = || admission_output("unknown", "executable_identity_unproven");
    let timeout = || timed_out_scan("ios", "AAAA-1111", "scan_timeout");
    for (outputs, waits, terminal) in [
        // The re-probe repeats the wait in force; the next timeout moves on from it.
        (vec![identity(), timeout(), clear()], vec![None, None, Some("4000")], "clear"),
        (vec![timeout(), identity(), clear()], vec![None, Some("4000"), Some("4000")], "clear"),
        (vec![timeout(), identity(), identity()], vec![None, Some("4000"), Some("4000")], "executable_identity_unproven"),
    ] {
        let mut mock = MockRunner::new();
        let attempts = outputs.len();
        for output in outputs {
            mock.expect_run("fresh-install-preflight.js", output);
        }
        let summary = match admit(&mut mock, None) {
            Ok(summary) => serde_json::to_value(summary).unwrap(),
            Err(failure) => {
                assert_eq!(
                    failure.build_recovery().unwrap().action,
                    qaren::failure::RecoveryAction::WaitForOwner
                );
                admission_failure_summary(&failure)
            }
        };
        assert_eq!(summary["terminalReason"], terminal);
        assert_eq!(summary["attempts"], attempts);
        assert_eq!(mock.calls.iter().map(scan_wait).collect::<Vec<_>>(), waits);
        assert_eq!(mock.remaining(), 0);
    }
    // A re-probe is cut to the room its command has, like any other scan, but never below the scanner's 2 s.
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 9_000));
    for output in [timeout(), timeout(), identity(), identity()] {
        mock.expect_run("fresh-install-preflight.js", output);
    }
    let failure = admit(&mut mock, None).unwrap_err();
    assert_eq!(mock.calls.iter().map(scan_wait).collect::<Vec<_>>(), [None, Some("4000"), Some("8000"), None]);
    assert!(failure.detail.starts_with("admission allowance expired; "), "{}", failure.detail);
    assert_out_of_time(&failure, 4, "2000,4000,8000,2000");
}

#[test]
fn fresh_admission_scans_are_bounded_by_the_allowance_and_the_pause() {
    // Scans that cost no time at all: 53 fit before the room for a 2 s wait is gone.
    let mut mock = MockRunner::new();
    for _ in 0..53 {
        mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "observer_timeout"));
    }
    let failure = admit(&mut mock, None).unwrap_err();
    let summary = admission_failure_summary(&failure);
    assert_eq!((summary["attempts"].as_u64(), summary["elapsedMs"].as_u64()), (Some(53), Some(26_500)));
    assert_eq!(mock.calls.len(), 53);
    assert_eq!(scan_wait(mock.calls.last().unwrap()), None, "the last scan had room for 2 s only");
    assert_eq!(mock.remaining(), 0);
    // With the identity re-probe last, 54 is the most; the saved note survives with that count.
    let mut mock = MockRunner::new();
    for _ in 0..52 {
        mock.expect_run("fresh-install-preflight.js", timed_out_scan("ios", "AAAA-1111", "observer_timeout"));
    }
    for _ in 0..2 {
        mock.expect_run("fresh-install-preflight.js", admission_output("unknown", "executable_identity_unproven"));
    }
    let failure = admit(&mut mock, None).unwrap_err();
    assert_eq!(admission_failure_summary(&failure)["attempts"], 54);
    let saved: serde_json::Value =
        serde_json::from_str(&qaren::redact::durable_json(&failure).unwrap()).unwrap();
    let kept: serde_json::Value = serde_json::from_str(saved["evidence"][0].as_str().unwrap()).unwrap();
    assert_eq!(kept["attempts"], 54);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn fresh_admission_cancelled_while_pausing_before_a_longer_scan_stops() {
    // With a long allowance and with one that has no room left after the pause: cancellation wins both times.
    for allowance in [30_000, 700] {
        let mut mock = MockRunner::new();
        let start = mock.monotonic_ms();
        mock.cancel_at_ms = Some((start + 300, "cancelled".into()));
        mock.advance_on = Some(("fresh-install-preflight.js".into(), 100));
        mock.expect_run(
            "fresh-install-preflight.js",
            timed_out_scan("ios", "AAAA-1111", "scan_timeout"),
        );
        let failure = admit(&mut mock, Some(start + allowance)).unwrap_err();
        assert_eq!(failure.code, FailureCode::RunCancelled, "{allowance}");
        let summary = admission_failure_summary(&failure);
        assert_eq!((summary["attempts"].as_u64(), summary["terminalReason"].as_str()), (Some(1), Some("cancelled")));
        assert_eq!(mock.calls.len(), 1);
    }
}

// AI-469: the check before dependencies. It reads its own answers; strict admission is not involved.
fn driver_answer(platform: &str, status: &str, evidence: Option<serde_json::Value>) -> CmdOutput {
    let device = if platform == "ios" { "AAAA-1111" } else { "emulator-5554" };
    let mut answer = serde_json::json!({"v": 1, "platform": platform, "deviceId": device, "check": "driver", "status": status});
    if let Some(evidence) = evidence {
        answer["evidence"] = evidence;
    }
    CmdOutput {
        exit_code: Some(if status == "clear" { 0 } else { 4 }),
        stdout: answer.to_string(),
        ..Default::default()
    }
}

fn found(platform: &str, driver: &str) -> CmdOutput {
    let mut evidence = serde_json::json!({"reason": "driver_on_selected_device", "driver": driver});
    if platform == "ios" {
        evidence["pid"] = 4242.into();
    }
    driver_answer(platform, "busy", Some(evidence))
}

fn driver_preflight(
    mock: &mut MockRunner,
    platform: &str,
) -> Result<Vec<(String, String)>, qaren::failure::Failure> {
    let android = core::AndroidEnv {
        serial: "emulator-5554".into(),
        server_port: 5038,
        platform_tools: "/android/platform-tools".into(),
    };
    core::foreign_driver_preflight(
        mock,
        Path::new("/node"),
        Path::new("/runtime"),
        Path::new("/app"),
        if platform == "ios" { "AAAA-1111" } else { "emulator-5554" },
        (platform == "android").then_some(&android),
    )
}

// The result word and the detail note.
fn preflight_notes(notes: &[(String, String)]) -> (&str, &str) {
    assert_eq!(
        notes.iter().map(|(key, _)| key.as_str()).collect::<Vec<_>>(),
        ["driver_preflight", "driver_preflight_detail"]
    );
    (notes[0].1.as_str(), notes[1].1.as_str())
}

const DRIVER_NEXT_ACTION: &str = "wait for the other automation session on this device to finish, then run the same command again; QaReN did not stop it and did not restart the device";

#[test]
fn driver_preflight_clear_is_one_scan_of_its_own() {
    let observer = std::env::current_exe().unwrap().into_os_string().into_string().unwrap();
    for platform in ["ios", "android"] {
        let mut mock = MockRunner::new();
        let started = mock.now_epoch_ms();
        mock.expect_run("fresh-install-preflight.js", driver_answer(platform, "clear", None));
        let notes = driver_preflight(&mut mock, platform).unwrap();
        assert_eq!(
            preflight_notes(&notes),
            ("clear", "scans=1; elapsed_ms=0; last_answer=clear")
        );
        assert_eq!(mock.calls.len(), 1);
        let device = if platform == "ios" { "AAAA-1111" } else { "emulator-5554" };
        let mut args = vec![
            "/runtime/qa/fresh-install-preflight.js",
            "--platform",
            platform,
            "--device",
            device,
            "--check",
            "driver",
        ];
        if platform == "ios" {
            args.extend(["--process-observer", observer.as_str()]);
        }
        let spec = CmdSpec::new("driver-preflight", "/node", &args, 10).cwd(Path::new("/app"));
        assert_eq!(mock.calls[0].label, spec.label);
        assert_eq!(mock.calls[0].args, spec.args);
        assert_eq!(mock.calls[0].timeout_seconds, 10);
        assert_eq!(mock.calls[0].cwd, spec.cwd);
        // The Android scan goes through the run's adb server to the borrowed device only.
        let env = |name: &str| mock.calls[0].env.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str());
        assert_eq!(env("ANDROID_SERIAL"), (platform == "android").then_some("emulator-5554"));
        assert_eq!(env("ADB_SERVER_SOCKET").is_some(), platform == "android");
        assert_eq!(mock.now_epoch_ms(), started, "no pause after a clear answer");
    }
}

#[test]
fn driver_preflight_refuses_a_driver_that_stays_and_names_its_class() {
    for (platform, driver, opening) in [
        (
            "ios",
            "maestro_ios_runner",
            "a Maestro iOS UI-test runner (host process 4242) was found on the selected device before dependencies and no later scan proved it gone; driver=maestro_ios_runner; driver_pid=4242; ",
        ),
        (
            "ios",
            "xcodebuild_test",
            "an xcodebuild test session (host process 4242) was found on the selected device before dependencies and no later scan proved it gone; driver=xcodebuild_test; driver_pid=4242; ",
        ),
        (
            "android",
            "uiautomator",
            "a UIAutomator process was found on the selected device before dependencies and no later scan proved it gone; driver=uiautomator; ",
        ),
    ] {
        let mut mock = MockRunner::new();
        let started = mock.now_epoch_ms();
        for _ in 0..3 {
            mock.expect_run("fresh-install-preflight.js", found(platform, driver));
        }
        // A fourth answer is never asked for.
        mock.expect_run("fresh-install-preflight.js", driver_answer(platform, "clear", None));
        let failure = driver_preflight(&mut mock, platform).unwrap_err();
        assert_eq!((mock.calls.len(), mock.remaining()), (3, 1), "{driver}");
        assert!(mock.calls.iter().all(|call| call.label == "driver-preflight"));
        assert_eq!(mock.now_epoch_ms() - started, 4_000, "two pauses of two seconds");
        assert_eq!(
            (failure.phase.as_str(), failure.code, failure.subreason.as_deref()),
            ("preflight", FailureCode::DeviceBusy, Some("foreign-driver"))
        );
        assert_eq!(
            failure.detail.as_str(),
            format!("{opening}scans=3; driver_scans=3; last_answer=driver; observed_ms=4000")
        );
        assert_eq!(failure.next_action.as_str(), DRIVER_NEXT_ACTION);
        assert!(failure.evidence.is_empty());
        let recovery = failure.build_recovery().unwrap();
        assert_eq!(recovery.reason, qaren::failure::RecoveryReason::ForeignAdmissionUnresolved);
        assert_eq!(recovery.action, qaren::failure::RecoveryAction::WaitForOwner);
        assert_eq!(recovery.next_rung, Some(0));
        assert!(!recovery.destroys_state && !recovery.requires_user_ok);
    }
}

#[test]
fn driver_preflight_goes_on_when_a_later_complete_scan_finds_no_driver() {
    // One or two scans with the driver, then a complete scan without it: clear, or only a build.
    for (driver_scans, last, last_word) in [
        (1, driver_answer("ios", "clear", None), "clear"),
        (2, driver_answer("ios", "clear", None), "clear"),
        (1, found("ios", "xcodebuild_build"), "build_only"),
    ] {
        let mut mock = MockRunner::new();
        let started = mock.now_epoch_ms();
        for _ in 0..driver_scans {
            mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
        }
        mock.expect_run("fresh-install-preflight.js", last);
        let notes = driver_preflight(&mut mock, "ios").unwrap();
        let (result, detail) = preflight_notes(&notes);
        assert_eq!(result, "clear_after_recheck");
        assert_eq!(
            detail,
            format!("scans={}; elapsed_ms={}; last_answer={last_word}", driver_scans + 1, 2_000 * driver_scans)
        );
        assert_eq!(mock.now_epoch_ms() - started, 2_000 * driver_scans as u64);
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn driver_preflight_goes_on_past_a_build_and_past_an_answer_that_proves_nothing() {
    let unknown = |evidence: serde_json::Value| driver_answer("ios", "unknown", Some(evidence));
    let strict_busy = CmdOutput {
        exit_code: Some(4),
        stdout: r#"{"v":1,"platform":"ios","deviceId":"AAAA-1111","status":"busy","evidence":{"reason":"driver_on_selected_device","pid":812}}"#.into(),
        ..Default::default()
    };
    let mut other_device = driver_answer("ios", "clear", None);
    other_device.stdout = other_device.stdout.replace("AAAA-1111", "BBBB-2222");
    let mut other_check = driver_answer("ios", "clear", None);
    other_check.stdout = other_check.stdout.replace("\"check\":\"driver\"", "\"check\":\"strict\"");
    for (answer, result, word) in [
        (found("ios", "xcodebuild_build"), "build_only", "build_only"),
        (unknown(serde_json::json!({"reason": "driver_identity_unproven", "pid": 20})), "unproven", "driver_identity_unproven"),
        (unknown(serde_json::json!({"reason": "scan_timeout"})), "unproven", "scan_timeout"),
        (unknown(serde_json::json!({"reason": "candidate_budget_exceeded", "candidates": 65})), "unproven", "candidate_budget_exceeded"),
        (driver_answer("ios", "unknown", None), "unproven", "unavailable"),
        // An answer of strict admission, as a runtime without this check would give for the same command.
        (strict_busy, "unproven", "invalid_response"),
        (other_device, "unproven", "envelope_mismatch"),
        (other_check, "unproven", "envelope_mismatch"),
        (CmdOutput::failed(1, "not scripted"), "unproven", "invalid_response"),
        (CmdOutput { timed_out: true, ..Default::default() }, "unproven", "scan_timeout"),
    ] {
        let mut mock = MockRunner::new();
        let started = mock.now_epoch_ms();
        mock.expect_run("fresh-install-preflight.js", answer);
        mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
        let notes = driver_preflight(&mut mock, "ios").unwrap();
        assert_eq!(
            preflight_notes(&notes),
            (result, format!("scans=1; elapsed_ms=0; last_answer={word}").as_str())
        );
        assert_eq!((mock.calls.len(), mock.remaining()), (1, 1), "{word}: one scan, no re-check");
        assert_eq!(mock.now_epoch_ms(), started);
    }
}

#[test]
fn driver_preflight_keeps_a_driver_it_found_until_a_complete_scan_clears_it() {
    let unknown = || driver_answer("ios", "unknown", Some(serde_json::json!({"reason": "scan_timeout"})));
    // Found once, then two answers that prove nothing: refused, and the refusal says what the scans saw.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", unknown());
    mock.expect_run("fresh-install-preflight.js", unknown());
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let failure = driver_preflight(&mut mock, "ios").unwrap_err();
    assert_eq!((mock.calls.len(), mock.remaining()), (3, 1));
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.detail.ends_with("; driver=maestro_ios_runner; driver_pid=4242; scans=3; driver_scans=1; last_answer=scan_timeout; observed_ms=4000"), "{}", failure.detail);

    // Found, an answer that proves nothing, then a complete scan without it: the run goes on.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", unknown());
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let notes = driver_preflight(&mut mock, "ios").unwrap();
    assert_eq!(preflight_notes(&notes).0, "clear_after_recheck");
    assert_eq!(mock.remaining(), 0);

    // Another driver found later is the one named.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", found("ios", "webdriveragent"));
    mock.expect_run("fresh-install-preflight.js", found("ios", "webdriveragent"));
    let failure = driver_preflight(&mut mock, "ios").unwrap_err();
    assert!(failure.detail.starts_with("a WebDriverAgent runner (host process 4242) was found"), "{}", failure.detail);
    assert!(failure.detail.contains("; driver=webdriveragent; driver_pid=4242; scans=3; driver_scans=3; "));
}

#[test]
fn driver_preflight_reads_no_answer_after_its_allowance() {
    // Each scan takes five seconds: the second answer arrives at the twelfth second and is not read.
    let mut mock = MockRunner::new();
    let started = mock.now_epoch_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 5_000));
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let failure = driver_preflight(&mut mock, "ios").unwrap_err();
    assert_eq!((mock.calls.len(), mock.remaining()), (2, 1));
    assert_eq!(mock.now_epoch_ms() - started, 12_000);
    assert_eq!(
        mock.calls.iter().map(|call| call.timeout_seconds).collect::<Vec<_>>(),
        [10, 5],
        "a scan's command gets what the allowance leaves, at most ten seconds"
    );
    assert!(failure.detail.ends_with("; scans=2; driver_scans=1; last_answer=deadline_exceeded; observed_ms=12000"), "{}", failure.detail);

    // A driver found when no further scan fits after a pause: refused at once, naming what that scan saw.
    let mut mock = MockRunner::new();
    let started = mock.now_epoch_ms();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 9_500));
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let failure = driver_preflight(&mut mock, "ios").unwrap_err();
    assert_eq!((mock.calls.len(), mock.remaining()), (1, 1));
    assert_eq!(mock.now_epoch_ms() - started, 9_500, "no pause before a refusal");
    assert!(failure.detail.ends_with("; scans=1; driver_scans=1; last_answer=driver; observed_ms=9500"), "{}", failure.detail);

    // The same late answer with no driver seen before it: nothing is established and the run goes on.
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("fresh-install-preflight.js".into(), 12_000));
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    let notes = driver_preflight(&mut mock, "ios").unwrap();
    assert_eq!(
        preflight_notes(&notes),
        ("unproven", "scans=1; elapsed_ms=12000; last_answer=deadline_exceeded")
    );
}

#[test]
fn driver_preflight_cancelled_in_the_pause_stops_before_another_scan() {
    let mut mock = MockRunner::new();
    let started = mock.now_epoch_ms();
    mock.cancel_at_ms = Some((started + 1_000, "SIGINT".into()));
    mock.expect_run("fresh-install-preflight.js", found("ios", "maestro_ios_runner"));
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let failure = driver_preflight(&mut mock, "ios").unwrap_err();
    assert_eq!((failure.phase.as_str(), failure.code), ("preflight", FailureCode::RunCancelled));
    assert_eq!((mock.calls.len(), mock.remaining()), (1, 1));
}

#[test]
fn driver_preflight_reads_only_an_answer_whose_members_agree() {
    let busy = |platform: &str, evidence: serde_json::Value| driver_answer(platform, "busy", Some(evidence));
    let d = "driver_on_selected_device";
    let mut exit_zero = found("ios", "maestro_ios_runner");
    exit_zero.exit_code = Some(0);
    let mut clear_exit_four = driver_answer("ios", "clear", None);
    clear_exit_four.exit_code = Some(4);
    // A null envelope member: the closed type would read it as absent.
    let mut evidence_null = driver_answer("ios", "clear", None);
    evidence_null.stdout = evidence_null.stdout.replace("\"v\":1", "\"v\":1,\"evidence\":null");
    let mut extra_member = driver_answer("ios", "clear", None);
    extra_member.stdout = extra_member.stdout.replace("\"v\":1", "\"v\":1,\"note\":\"/private/tool\"");
    for (platform, answer, word) in [
        // A class outside the list, a class of the other platform, a pid where none belongs or none where one does.
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5, "driver": "/private/tool"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5, "driver": "uiautomator"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "driver": "maestro_ios_runner"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 0, "driver": "maestro_ios_runner"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5, "driver": "maestro_ios_runner", "candidates": 2})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5, "driver": "maestro_ios_runner", "command": "/private/tool"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": null, "driver": "maestro_ios_runner"})), "invalid_evidence"),
        // A null member that the closed type would read as absent: still not an answer of the scanner.
        ("ios", busy("ios", serde_json::json!({"reason": d, "pid": 5, "driver": "maestro_ios_runner", "candidates": null})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!({"reason": "scan_failed", "pid": 5, "driver": "maestro_ios_runner"})), "invalid_evidence"),
        ("ios", busy("ios", serde_json::json!([d])), "invalid_evidence"),
        ("android", busy("android", serde_json::json!({"reason": d, "driver": "maestro_ios_runner"})), "invalid_evidence"),
        ("android", busy("android", serde_json::json!({"reason": d, "driver": "xcodebuild_build"})), "invalid_evidence"),
        ("android", busy("android", serde_json::json!({"reason": d, "pid": 5, "driver": "uiautomator"})), "invalid_evidence"),
        // Status, exit code and evidence that do not belong together.
        ("ios", driver_answer("ios", "unknown", Some(serde_json::json!({"reason": d, "pid": 5}))), "invalid_response"),
        ("ios", driver_answer("ios", "unknown", Some(serde_json::json!({"reason": "scan_failed", "driver": "maestro_cli"}))), "invalid_response"),
        ("ios", driver_answer("ios", "clear", Some(serde_json::json!({"reason": "scan_failed"}))), "invalid_response"),
        ("ios", driver_answer("ios", "busy", None), "invalid_response"),
        ("ios", exit_zero, "invalid_response"),
        ("ios", clear_exit_four, "invalid_response"),
        ("ios", extra_member, "invalid_response"),
        ("ios", evidence_null, "invalid_response"),
        ("android", driver_answer("ios", "clear", None), "envelope_mismatch"),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run("fresh-install-preflight.js", answer.clone());
        let notes = driver_preflight(&mut mock, platform).unwrap();
        let (result, detail) = preflight_notes(&notes);
        assert_eq!(
            (result, detail),
            ("unproven", format!("scans=1; elapsed_ms=0; last_answer={word}").as_str()),
            "{}",
            answer.stdout
        );
        assert!(!detail.contains("/private/tool"));
    }
    // The same answers after a driver was found: they neither clear it nor replace it.
    let mut mock = MockRunner::new();
    mock.expect_run("fresh-install-preflight.js", found("android", "uiautomator"));
    mock.expect_run("fresh-install-preflight.js", busy("android", serde_json::json!({"reason": d, "driver": "xcodebuild_build"})));
    mock.expect_run("fresh-install-preflight.js", driver_answer("ios", "clear", None));
    let failure = driver_preflight(&mut mock, "android").unwrap_err();
    assert!(failure.detail.ends_with("; driver=uiautomator; scans=3; driver_scans=1; last_answer=envelope_mismatch; observed_ms=4000"), "{}", failure.detail);
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
        app_source: None,
        target: CoreTarget {
            device_id: "AAAA-1111".to_string(),
            device_name: "qaren-check".to_string(),
            metro_port: 8791,
            metro_url_for_device: "http://127.0.0.1:8791".to_string(),
            worktree: PathBuf::from("/tmp/app"),
            metro_bundle_requests: None,
            manifest_warm: None,
            warm_lane: false,
            android_launch_url: None,
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
fn an_interruption_rejection_is_persisted_without_runtime_inputs_or_a_later_miss() {
    for veto in ["later-target", "uncovered-target"] {
        let repo = common::temp_repo();
        let event = serde_json::json!({
            "kind": "interruption-rejected", "line": 7, "veto": veto,
            "targetIndex": 1, "exactDeclineCount": 6
        });
        let mut malformed = event.clone();
        malformed["label"] = "Close".into();
        let stdout = format!(
            "{}\n{}\n{}\n",
            envelope(2, "diagnostic", &event.to_string()),
            envelope(3, "diagnostic", &malformed.to_string()),
            envelope(4, "result", &pass_ledger(&[]))
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
        let result = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(result.verdict, Verdict::Pass);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert_eq!(stored.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(stored.trim()).unwrap(),
            event
        );
        assert!(!stored.contains("Close"));
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
fn preparation_reset_counts_preserve_private_metrics_and_reject_invalid_facts() {
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
        let metric = json!({
            "kind": "metric", "stage": "native-preparation", "edge": "point", "outcome": "ok",
            "at": 200, "ms": 80.5, "count": 6, "resets": 0
        });
        let mut reset = metric.clone();
        reset["resets"] = json!(2);
        let mut payloads = vec![metric.clone(), reset.clone()];
        for value in [
            json!(-1),
            json!(0.5),
            json!(9007199254740992_u64),
            json!("private-synthetic-value"),
            json!(null),
        ] {
            let mut invalid = metric.clone();
            invalid["resets"] = value;
            payloads.push(invalid);
        }
        let mut wrong_stage = metric.clone();
        wrong_stage["stage"] = json!("native-total");
        payloads.push(wrong_stage);
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
        let actual: Vec<serde_json::Value> = stored
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(actual, [metric, reset]);
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
fn t6_dispatch_trace_reaches_private_diagnostics_with_closed_words() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let repo = common::temp_repo();
    let inputs = Arc::new(InputValues::from_entries([(
        OsString::from("QAREN_INPUT_PASSWORD"),
        OsString::from("synthetic-private-input"),
    )]));
    with_input_scope(inputs, || {
        let expected = serde_json::json!({
            "kind": "timing", "stage": "dispatch", "code": "COMPLETED",
            "line": 1, "at": 10, "acquisitionMs": 2, "observationAgeMs": 8,
            "action": "press", "ok": false, "nativeMutation": "none",
            "resultCode": "KEYBOARD_DISMISS_FAILED"
        });
        let mut payloads = vec![expected.clone()];
        for key in ["action", "resultCode"] {
            let mut invalid = expected.clone();
            invalid[key] = "private-synthetic-word".into();
            payloads.push(invalid);
        }
        let mut stdout = String::new();
        for (i, event) in payloads.iter().enumerate() {
            stdout.push_str(&envelope(i as u64 + 2, "diagnostic", &event.to_string()));
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
        assert_eq!(got, [expected]);
        assert!(!stored.contains("private-synthetic-word"));
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
            installed_app: None,
            video: None,
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
        installed_app: None,
        video: None,
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
        (false, (2..102).map(|seq| envelope(seq, "diagnostic", r#"{"kind":"metric","stage":"admission","edge":"point","outcome":"unknown","at":0,"admission":"retry","attachBudgetMs":120000,"walkBudgetMs":1200000}"#) + "\n").collect::<String>()),
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
fn the_first_step_start_is_retained_without_becoming_a_ledger_row() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n{}\n",
        envelope(
            2,
            "start",
            r#"{"operationId":1,"line":1,"kind":"step","t":50}"#
        ),
        envelope(
            3,
            "start",
            r#"{"operationId":1,"line":1,"kind":"step","t":80}"#
        ),
        envelope(4, "row", &rows[0]),
        envelope(5, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Pass);
    assert_eq!(outcome.ledger.steps.len(), 1);
    assert_eq!(outcome.first_step_start_ms, Some(50));
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
        refused["inner"] = json!("dev_runtime_unproven");
        refused["bundleBuilt"] = json!("failed");
        refused["foreignPages"] = json!(2);
        refused["sameNameDevices"] = json!(1);
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
            ("bundleBuilt", json!(secret)),
            ("foreignPages", json!(1.5)),
            ("sameNameDevices", json!(-1)),
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
fn native_reread_probe_and_relaunch_timings_reach_the_run_receipt() {
    use qaren::redact::{with_input_scope, InputValues};
    use std::ffi::OsString;
    use std::sync::Arc;
    let verify = || {
        let repo = common::temp_repo();
        let events = [
            serde_json::json!({
                "kind": "metric", "stage": "native-reread", "edge": "point", "outcome": "ok",
                "at": 500
            }),
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
        stdout.push_str(&envelope(events.len() as u64 + 2, "result", &pass_ledger(&[])));
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

fn dev_admission_facts() -> serde_json::Value {
    serde_json::json!({
        "attempt": 2, "lastStarted": "retry_wait", "lastCompleted": "attach", "inner": "non_dev_bundle",
        "relaunches": 0, "relaunchFailed": false, "liveness": "not_probed",
        "elapsedMs": 120000, "remainingMs": 1080000, "budgetMs": 1200000,
        "attachBudgetMs": 120000, "walkBudgetMs": 1200000,
        "targetsTotal": 1, "devTrue": 0, "devFalse": 1, "devUndefined": 0, "devUnknown": 0
    })
}

#[test]
fn development_target_refusal_preserves_structured_facts() {
    let repo = common::temp_repo();
    let facts = dev_admission_facts();
    let result = serde_json::json!({"verdict":"REFUSED", "code":"DEV_TARGET_MISSING", "message":"development bundle required", "lease":request().lease, "admission":facts});
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &(envelope(2, "result", &result.to_string()) + "\n"),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert!(
        matches!(outcome.verdict, Verdict::Refused { ref code, .. } if code == "DEV_TARGET_MISSING")
    );
    assert_eq!(
        serde_json::to_value(outcome.ledger).unwrap()["admission"],
        facts
    );
}

#[test]
fn malformed_development_target_facts_fail_closed() {
    for (key, value) in [
        ("devFalse", serde_json::json!(-1)),
        ("devTrue", serde_json::json!(1)),
        ("targetsTotal", serde_json::json!(0)),
        ("inner", serde_json::json!("private-canary")),
        ("targetId", serde_json::json!("private-canary")),
        ("elapsedMs", serde_json::json!(0.5)),
    ] {
        let repo = common::temp_repo();
        let mut facts = dev_admission_facts();
        facts[key] = value;
        let result = serde_json::json!({"verdict":"REFUSED", "code":"DEV_TARGET_MISSING", "message":"development bundle required", "lease":request().lease, "admission":facts});
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &(envelope(2, "result", &result.to_string()) + "\n"),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(outcome.verdict, Verdict::Fail, "{key}");
        assert_eq!(
            outcome.failure.unwrap().code,
            FailureCode::CoreResultMissing
        );
    }
}

#[test]
fn continuous_diagnostics_before_any_row_cannot_extend_the_total_watchdog() {
    use qaren::exec::{CmdSpec, RealRunner};
    let repo = common::temp_repo();
    let script = r#"
      const reader = require('node:readline').createInterface({input: process.stdin});
      reader.once('line', input => {
        const {runId} = JSON.parse(input);
        let seq = 1;
        setInterval(() => process.stdout.write(JSON.stringify({v:1,runId,seq:++seq,type:'diagnostic',payload:{kind:'metric',stage:'admission',edge:'point',outcome:'unknown',at:seq,admission:'retry',walkBudgetMs:1000,attachBudgetMs:120000}}) + '\n'), 10);
      });
    "#;
    let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries([(
        std::ffi::OsString::from("QAREN_INPUT_UNUSED"),
        std::ffi::OsString::from("synthetic-unused-input"),
    )]));
    qaren::redact::with_input_scope(inputs, || {
        let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
        let spec = CmdSpec::new("diagnostic-fixture", "node", &["-e", script], 10);
        let child = core::spawn(&mut runner, &spec, &repo.join("core.log"), &request()).unwrap();
        let started = std::time::Instant::now();
        let outcome = core::wait(
            &mut runner,
            child,
            Budgets {
                walk_seconds: 1,
                step_seconds: 10,
            },
            &mut |_, _| {},
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(7));
        assert!(outcome.ledger.steps.is_empty());
        assert!(
            matches!(outcome.verdict, Verdict::Refused { ref code, .. } if code == "CDP_NOT_CONNECTED")
        );
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.next_action.as_str(), "inspect_admission_budget");
        assert!(!outcome.group_survived);
        let stored = std::fs::read_to_string(repo.join("core-diagnostics.jsonl")).unwrap();
        assert!(stored.lines().count() > 10);
    });
}

#[test]
fn malformed_unknown_development_facts_never_echo_raw_decoder_values() {
    let repo = common::temp_repo();
    let mut facts = dev_admission_facts();
    facts["inner"] = "no_dev_target_unknown".into();
    facts["elapsedMs"] = "private-admission-canary".into();
    let result = serde_json::json!({"verdict":"REFUSED", "code":"CDP_NOT_CONNECTED", "message":"development state unknown", "admission":facts});
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &(envelope(2, "result", &result.to_string()) + "\n"),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert!(!failure.detail.contains("private-admission-canary"));
}
