mod common;

use qaren::exec::{CmdSpec, RealRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use qaren::github::{comment_create, pr_view, remove_label, NEEDS_QA};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

const GH: &str = "opaque-synthetic-gh-credential-\"quote\\tail";
const GITHUB: &str = "opaque-synthetic-github-credential-42";

#[test]
fn isolated_github_auth_reaches_real_children_and_keeps_evidence_clean() {
    for mode in [
        "gh",
        "github",
        "both",
        "stored",
        "none",
        "denied",
        "network",
        "multiline",
    ] {
        let dir = common::temp_repo();
        let home = dir.join("home");
        std::fs::create_dir(&home).unwrap();
        if mode == "stored" {
            std::fs::write(home.join("stored-auth"), "fixture").unwrap();
        }
        let view = serde_json::json!({
            "number": 12,
            "url": "https://github.com/o/r/pull/12",
            "headRefOid": "a".repeat(40),
            "headRefName": format!("feature/{GH}/{GITHUB}"),
            "isCrossRepository": false,
            "labels": [{"name": "needs-qa"}]
        });
        let script = format!(
            r#"#!/bin/sh
set -eu
if [ -z "${{GH_TOKEN:-}}${{GITHUB_TOKEN:-}}" ] && [ ! -f "$HOME/stored-auth" ]; then
    echo 'authentication required' >&2
    exit 1
fi
printf '%s %s\n' "${{GH_TOKEN:-}}" "${{GITHUB_TOKEN:-}}" >&2
printf '%s %s\n' "$1" "$2" >> "$QAREN_GITHUB_FIXTURE_DIR/calls"
if [ "$FAKE_GH_MODE" = network ]; then echo 'network timeout' >&2; exit 1; fi
if [ "$1 $2" = 'auth status' ]; then exit 0; fi
if [ "$FAKE_GH_MODE" = denied ]; then echo 'Resource not accessible by token' >&2; exit 1; fi
case "$1 $2" in
    'pr view') printf '%s\n' '{view}' ;;
    'pr comment')
        test "$6" = --body-file
        test -s "$7"
        printf '%s\n' 'https://github.com/o/r/pull/12#issuecomment-9' ;;
    'pr edit') test "$6" = --remove-label ;;
    *) exit 2 ;;
esac
"#,
            view = view.to_string().replace('\'', "'\\''")
        );
        let gh = dir.join("gh");
        std::fs::write(&gh, script).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut worker = Command::new(std::env::current_exe().unwrap());
        worker
            .args(["--exact", "github_auth_fixture_worker", "--nocapture"])
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .env("HOME", &home)
            .env("GH_CONFIG_DIR", home.join("gh"))
            .env("QAREN_GITHUB_FIXTURE_DIR", &dir)
            .env("FAKE_GH_MODE", mode);
        if matches!(mode, "gh" | "both" | "denied" | "network") {
            worker.env("GH_TOKEN", GH);
        }
        if matches!(mode, "github" | "both") {
            worker.env("GITHUB_TOKEN", GITHUB);
        }
        if mode == "multiline" {
            worker.env("GH_TOKEN", format!("{GH}\nsecond-line"));
        }
        let result = worker.output().unwrap();
        assert!(
            result.status.success(),
            "fixture {mode} failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        for bytes in [&result.stdout, &result.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains(GH), "fixture output exposed GH_TOKEN");
            assert!(
                !text.contains(GITHUB),
                "fixture output exposed GITHUB_TOKEN"
            );
        }
        if matches!(mode, "gh" | "github" | "both" | "stored" | "multiline") {
            assert_eq!(
                std::fs::read_to_string(dir.join("calls")).unwrap(),
                "pr view\npr comment\npr edit\n"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn github_auth_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_GITHUB_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let mode = std::env::var("FAKE_GH_MODE").unwrap();
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let result = pr_view(&mut runner, "12", dir);
    if matches!(mode.as_str(), "none" | "denied" | "network") {
        let failure = result.unwrap_err();
        assert_eq!(
            failure.code,
            if mode != "denied" {
                FailureCode::GithubAuthUnavailable
            } else {
                FailureCode::PrUnavailable
            }
        );
        assert_eq!(failure.code.is_refusal(), mode != "denied");
        assert!(failure.next_action.contains("GH_TOKEN"));
        assert!(failure.next_action.contains("GITHUB_TOKEN"));
        assert!(failure.next_action.contains("gh auth login"));
        if mode == "denied" {
            assert!(failure.next_action.contains("write permissions"));
        }
        if mode == "network" {
            assert!(failure.detail.contains("network timeout"));
            assert!(failure.detail.contains("[REDACTED_SECRET]"));
            assert!(failure
                .next_action
                .contains("check network access to GitHub"));
        }
        assert_clean(&serde_json::to_string(&failure).unwrap());
        return;
    }
    let pr = result.unwrap();
    assert_clean(&serde_json::to_string(&pr).unwrap());
    let body_file = dir.join("comment.md");
    let body =
        qaren::redact::redact_machine(&format!("QA result {GH} {GITHUB}"), &Default::default());
    assert_clean(&body);
    std::fs::write(&body_file, &body).unwrap();
    assert_eq!(
        comment_create(&mut runner, &pr, &body_file, &[], dir).unwrap(),
        "https://github.com/o/r/pull/12#issuecomment-9"
    );
    assert!(remove_label(&mut runner, &pr, NEEDS_QA, dir).unwrap());

    let value = std::env::var("GH_TOKEN")
        .or_else(|_| std::env::var("GITHUB_TOKEN"))
        .unwrap_or_default();
    let escaped = serde_json::to_string(&value).unwrap();
    let raw = format!("stdout {value}\nstderr {escaped}");
    let failure = Failure::new("pr", FailureCode::PrUnavailable, &raw, &raw);
    let receipt =
        qaren::redact::durable_json(&serde_json::json!({"failure": failure, "detail": raw}))
            .unwrap();
    if !value.is_empty() {
        assert!(!receipt.contains(&value));
        assert!(!receipt.contains(&escaped[1..escaped.len() - 1]));
    }
    std::fs::write(dir.join("receipt.json"), &receipt).unwrap();
    let mut record = common::base_record(
        dir,
        &common::ios_scenario_yaml(8791),
        "github-auth",
        qaren::runrecord::Phase::Failed,
    );
    record.failure = Some(failure);
    record.save(dir).unwrap();
    let ledger = std::fs::read_to_string(dir.join("github-auth/run.json")).unwrap();
    if !value.is_empty() {
        assert!(!ledger.contains(&value));
    }

    let script = "printf '%s\\n' 'ready'; printf '%s\\n' \"$GH_TOKEN\" \"$GITHUB_TOKEN\" >&2";
    let log = dir.join("github.log");
    let spec = CmdSpec::new("gh-pr-view", "/bin/sh", &["-c", script], 5);
    let mut child = runner.spawn_piped(&spec, &log).unwrap();
    let mut stdout = String::new();
    child.stdout.read_to_string(&mut stdout).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while child.handle.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    drop(child);
    let stored = std::fs::read_to_string(&log).unwrap();
    if !value.is_empty() {
        assert!(!stored.contains(&value));
    }
    if mode == "multiline" {
        assert_eq!(stored, "[private output withheld]\n");
    } else if !value.is_empty() {
        assert!(stored.contains("[REDACTED_INPUT]"));
    }
}

fn assert_clean(text: &str) {
    for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Ok(value) = std::env::var(name) {
            let escaped = serde_json::to_string(&value).unwrap();
            assert!(!text.contains(&value), "evidence exposed {name}");
            assert!(
                !text.contains(&escaped[1..escaped.len() - 1]),
                "escaped evidence exposed {name}"
            );
        }
    }
}
