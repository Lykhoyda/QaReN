use super::*;
use common::host::HostRunner;

fn passing() -> (HostRunner, RunRequest) {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    script_drift_status(&mut mock);
    script_host_probe(&mut mock, UDID, hosts_absent());
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    (HostRunner::new(mock), request(&repo, &app, 30))
}

fn refusing() -> (HostRunner, RunRequest) {
    let (repo, app) = app_repo();
    std::fs::write(
        app.join(".qaren/config.yaml"),
        "appId: com.rndevagent.testapp\nmetroPort: 8791\n",
    )
    .unwrap();
    (HostRunner::new(MockRunner::new()), request(&repo, &app, 30))
}

fn host_json(receipt: &qaren::receipt::Receipt) -> serde_json::Value {
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
    assert!(json["host"].is_object(), "missing typed host field: {json}");
    json["host"].clone()
}

#[test]
fn f1_passing_check_has_both_samples_and_report_line() {
    let (mut mock, req) = passing();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let host = host_json(&receipt);
    for (point, load) in [("start", 1.0), ("end", 12.0)] {
        assert_eq!(host[point]["load_1m"], load);
        assert_eq!(host[point]["cores"], 8);
        assert_eq!(host[point]["free_bytes"], 8u64 * 1024 * 1024 * 1024);
        assert_eq!(host[point]["available_bytes"], 8u64 * 1024 * 1024 * 1024);
        assert_eq!(host[point]["pressure"], "normal");
        assert_eq!(host[point]["swap_used_bytes"], 1024u64 * 1024 * 1024);
    }
    let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
    assert_eq!(report.matches("Host at start:").count(), 1);
    assert!(report.contains("load 1.0 on 8 cores"), "{report}");
    assert!(report.contains("At end: load 12.0 on 8 cores"), "{report}");
    assert!(report.contains("8.0 GiB free"), "{report}");
    assert!(report.contains("swap 1.0 GiB"), "{report}");
}

#[test]
fn f2_refused_check_has_both_samples() {
    let (mut mock, req) = refusing();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let host = host_json(&receipt);
    assert_eq!(host["start"]["load_1m"], 1.0);
    assert_eq!(host["end"]["load_1m"], 12.0);

    let (repo, app) = app_repo();
    let mut inner = MockRunner::new();
    script_preflight(&mut inner, &repo);
    inner.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    inner.expect_run(
        "expo run:ios --help",
        CmdOutput::success("--no-bundler\n--device [device]\n"),
    );
    let mut runner = HostRunner::new(inner);
    let receipt = run(&mut runner, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::IosBuildCapabilityUnavailable
    );
    let host = host_json(&receipt);
    assert_eq!(host["start"]["load_1m"], 1.0);
    assert_eq!(host["end"]["load_1m"], 12.0);
    let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
    assert!(report.contains("IOS_BUILD_CAPABILITY_UNAVAILABLE"));
    assert!(report.contains("Host at start: load 1.0 on 8 cores"));
    assert!(report.contains("At end: load 12.0 on 8 cores"));
    assert_eq!(runner.inner.remaining(), 0);
}

#[test]
fn f3_unreadable_probes_are_absent_and_do_not_change_the_verdict() {
    for timeout in [false, true] {
        let (mut mock, req) = passing();
        mock.malformed = !timeout;
        mock.timeout = timeout;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        let host = host_json(&receipt);
        assert_eq!(host["start"], serde_json::json!({}));
        assert_eq!(host["end"], serde_json::json!({}));
        let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
        assert!(
            report.contains("Host at start: unavailable. At end: unavailable."),
            "{report}"
        );
        // Start, the pre-build memory check, end.
        assert_eq!(
            mock.calls
                .iter()
                .filter(|c| c.label == "host-sample")
                .count(),
            6
        );
        assert!(mock
            .calls
            .iter()
            .filter(|c| c.label == "host-sample")
            .all(|c| c.timeout_seconds == 3));
    }
}

#[test]
fn f4_refusal_only_adds_context_when_the_end_host_is_constrained() {
    for (load, constrained) in [(7.99, false), (8.0, true)] {
        let (mut mock, req) = refusing();
        mock.end_load = load;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt
                .failure
                .as_ref()
                .unwrap()
                .detail
                .to_string()
                .contains("the host was under load:"),
            constrained
        );
    }
    let (mut runner, req) = refusing();
    runner.end_load = 1.0;
    runner.low_end_memory = true;
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .failure
        .unwrap()
        .detail
        .contains("the host was under load:"));
}

#[test]
fn f6_receipt_samples_cannot_hold_paths_or_process_names() {
    let (mut mock, req) = refusing();
    let receipt = run(&mut mock, &req);
    let host = host_json(&receipt);
    let text = host.to_string();
    assert!(!text.contains("probe-canary"));
    assert!(!text.contains("process-canary"));
    for point in ["start", "end"] {
        for (name, value) in host[point].as_object().unwrap() {
            match name.as_str() {
                "pressure" => {
                    assert!(["normal", "warning", "critical"].contains(&value.as_str().unwrap()))
                }
                "load_1m" | "cores" | "free_bytes" | "available_bytes" | "swap_used_bytes"
                | "total_bytes" => assert!(value.is_number()),
                other => panic!("unapproved host field: {other}"),
            }
        }
    }
}

#[test]
fn f6_typed_host_facts_round_trip_when_private_inputs_match_enum_values_or_keys() {
    let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_values(
        [
            "normal", "warning", "critical", "host", "start", "end", "cores", "free", "swap",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
    ));
    qaren::redact::with_input_scope(inputs, || {
        let (mut runner, req) = refusing();
        let mut receipt = run(&mut runner, &req);
        for pressure in [
            qaren::host_capacity::Pressure::Normal,
            qaren::host_capacity::Pressure::Warning,
            qaren::host_capacity::Pressure::Critical,
        ] {
            let host = receipt.host.as_mut().unwrap();
            host.start.pressure = Some(pressure);
            host.end.pressure = Some(pressure);
            let json = receipt.to_json();
            let restored: qaren::receipt::Receipt = serde_json::from_str(&json).unwrap();
            let host = restored.host.unwrap();
            assert_eq!(host.start.pressure, Some(pressure));
            assert_eq!(host.end.pressure, Some(pressure));
            assert_eq!(host.start.cores, Some(8));
            assert_eq!(host.start.free_bytes, Some(8u64 * 1024 * 1024 * 1024));
            assert_eq!(host.end.swap_used_bytes, Some(1024u64 * 1024 * 1024));
        }
    });
}

#[test]
fn f7_samples_bracket_every_command_including_teardown() {
    let (mut mock, req) = passing();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert!(mock.calls.len() > 4);
    assert!(mock.calls[..2].iter().all(|c| c.label == "host-sample"));
    assert!(mock.calls[mock.calls.len() - 2..]
        .iter()
        .all(|c| c.label == "host-sample"));
    // Between them, only the pre-build memory check, before the build command.
    let middle = &mock.calls[2..mock.calls.len() - 2];
    let samples: Vec<_> = middle
        .iter()
        .enumerate()
        .filter(|(_, c)| c.label == "host-sample")
        .map(|(i, _)| i)
        .collect();
    let build = middle
        .iter()
        .position(|c| c.label == "expo-run-ios")
        .unwrap();
    assert_eq!(samples.len(), 2, "{samples:?}");
    assert_eq!(samples[1], samples[0] + 1);
    assert!(samples[1] < build);
    let host = host_json(&receipt);
    assert_ne!(host["start"], host["end"]);
}

fn helpers() -> String {
    format!("4242 1 {0} 960.0 S Sun Nov 15 12:34:56 2026 netsimd /private/helper-canary/emulator/netsimd --token=secret-canary\n4243 1 {0} 0.0 S Sun Nov 15 12:34:56 2026 crashpad_handle /Applications/Chrome.app/crashpad_handler\n", unsafe { libc::geteuid() })
}

#[test]
fn e4_run_start_helper_scan_notes_executable_name_and_pid_only() {
    let (mut mock, req) = passing();
    mock.processes = Some(helpers());
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    let text = receipt.to_json();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        json["device_helpers"],
        serde_json::json!([{ "name": "netsimd", "pid": 4242, "cpu": 960, "class": "orphan", "outcome": "stopped-term", "signals": ["TERM"] }]),
        "{text}"
    );
    assert!(!text.contains("canary") && !text.contains("4243"), "{text}");
    let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
    let lines: Vec<_> = report
        .lines()
        .filter(|l| l.contains("netsimd (pid 4242"))
        .collect();
    assert_eq!(lines.len(), 1, "{report}");
    assert!(lines[0].contains("kill 4242"), "{report}");
    assert!(
        !report.contains("canary") && !report.contains("4243"),
        "{report}"
    );
    let scans: Vec<_> = mock
        .calls
        .iter()
        .enumerate()
        .filter(|(_, c)| matches!(c.label.as_str(), "device-helpers" | "device-helper-signal"))
        .map(|(index, c)| (index, c.program.as_str(), c.timeout_seconds))
        .collect();
    assert_eq!(
        scans,
        vec![(2, "ps", 3), (3, "/bin/sh", 2), (4, "/bin/sh", 2), (5, "ps", 3), (6, "/bin/kill", 2), (7, "ps", 3)],
        "one initial list, two package reads, a refresh, TERM and the poll"
    );

    let (mut mock, req) = refusing();
    mock.processes = Some(helpers());
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let json: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
    assert_eq!(
        json["device_helpers"],
        serde_json::json!([{ "name": "netsimd", "pid": 4242, "cpu": 960, "class": "orphan", "outcome": "stopped-term", "signals": ["TERM"] }])
    );
}

#[test]
fn e4_a_clean_or_unreadable_process_list_adds_no_note() {
    for processes in [Some(String::new()), None] {
        let (mut mock, req) = passing();
        mock.processes = processes;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert!(!receipt.to_json().contains("device_helpers"));
        let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
        assert!(!report.contains("helper"), "{report}");
    }
}

#[test]
fn pr_refusal_samples_bracket_the_github_commands() {
    let (repo, app) = app_repo();
    let mut inner = MockRunner::new();
    inner.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    inner.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    inner.expect_run(
        "gh pr view",
        CmdOutput::failed(1, "authentication required"),
    );
    inner.expect_run("gh auth status", CmdOutput::failed(1, "not logged in"));
    let mut runner = HostRunner::new(inner);
    let receipt = run(&mut runner, &pr_request(&repo, &app));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.verb, "pr");
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::GithubAuthUnavailable
    );
    let host = host_json(&receipt);
    assert_eq!(host["start"]["load_1m"], 1.0);
    assert_eq!(host["end"]["load_1m"], 12.0);
    assert!(runner.calls[..2].iter().all(|c| c.label == "host-sample"));
    assert!(runner.calls[runner.calls.len() - 2..]
        .iter()
        .all(|c| c.label == "host-sample"));
    assert_eq!(runner.calls[2].label, "device-helpers");
    assert_eq!(runner.calls.len(), 9);
}
