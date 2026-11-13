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
        assert_eq!(
            mock.calls
                .iter()
                .filter(|c| c.label == "host-sample")
                .count(),
            4
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
fn f7_samples_bracket_every_command_including_teardown() {
    let (mut mock, req) = passing();
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert!(mock.calls.len() > 4);
    assert!(mock.calls[..2].iter().all(|c| c.label == "host-sample"));
    assert!(mock.calls[mock.calls.len() - 2..]
        .iter()
        .all(|c| c.label == "host-sample"));
    assert!(mock.calls[2..mock.calls.len() - 2]
        .iter()
        .all(|c| c.label != "host-sample"));
    let host = host_json(&receipt);
    assert_ne!(host["start"], host["end"]);
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
    assert_eq!(runner.calls.len(), 8);
}
