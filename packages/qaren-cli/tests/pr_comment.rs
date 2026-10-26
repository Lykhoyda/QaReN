use qaren::core::Ledger;
use qaren::record::{VideoPublication, VideoStatus};
use qaren::redact::MachineIdentity;
use qaren::report::{render_pr_comment, PrRun, ReportInput};

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";

fn machine() -> MachineIdentity {
    MachineIdentity {
        hostname: Some("qa-mac-mini.local".into()),
        home: Some("/Users/qa".into()),
        ..Default::default()
    }
}

fn failing_ledger() -> Ledger {
    serde_json::from_value(serde_json::json!({
        "verdict": "FAIL",
        "path": "walk via cdp_tap and proofReplay transport from /private_workspace/secret_dir/x.txt",
        "blocks": [{"key": "plan", "outcome": "fail", "source": "cdp_discovered"}],
        "steps": [
            {"block": "plan", "line": 1, "attempt": 1, "kind": "step", "resolvedBy": "cdp_exact",
             "t": 100, "outcome": "pass", "screenshot": "screenshots/01.png"},
            {"block": "plan", "line": 2, "attempt": 2, "kind": "check", "resolvedBy": "proofReplay",
             "t": 200, "outcome": "fail", "screenshot": "screenshots/02.png",
             "reason": format!("transport lost on qa-mac-mini at /Users/qa/app/logs/core.log sim {UDID} metro 192.168.1.20:8081")}
        ],
        "jev": {"calls": 3, "medianMs": 41},
        "llmTurns": 1, "escapes": 0, "recoveries": 2,
        "failure": {"step": 2, "seen": format!("QA-MAC-MINI showed {UDID} at 10.1.2.3"), "screenshot": "screenshots/02.png"}
    }))
    .unwrap()
}

fn render(
    ledger: &Ledger,
    older: bool,
    video: &VideoStatus,
    video_publication: &VideoPublication,
) -> String {
    render_pr_comment(
        &ReportInput {
            run_id: "check-20261002T101500Z",
            platform: "ios",
            app_id: "com.rndevagent.testapp",
            device: "qaren-check",
            ledger,
        },
        None,
        &PrRun {
            tested_sha: &"a1b2c3d".repeat(6)[..40],
            tested_older_commit: older,
            video,
            screenshot: qaren::report::failing_screenshot(ledger).as_deref(),
            plan_sha256: &"e".repeat(64),
            video_publication,
        },
        &machine(),
    )
}

#[test]
fn the_comment_carries_no_machine_identity_or_internal_vocabulary() {
    let body = render(
        &failing_ledger(),
        false,
        &VideoStatus::Available,
        &VideoPublication::Eligible,
    );
    for leak in [
        "qa-mac-mini",
        "/Users",
        UDID,
        "192.168",
        "10.1.2.3",
        "cdp_",
        "cdp\\_",
        "private_",
        "secret",
        "proofReplay",
        "transport",
    ] {
        assert!(
            !body
                .to_ascii_lowercase()
                .contains(&leak.to_ascii_lowercase()),
            "{leak} leaked:\n{body}"
        );
    }
    assert!(body.starts_with("<!-- qaren-run: check-20261002T101500Z -->\nFAIL"));
    assert!(body.contains("Tested: commit `a1b2c3d` on ios\n"), "{body}");
    assert!(body.contains("Video of the walk is attached below."));
    // Rows carry no projected text here, so only the line is shown; the plan is never read.
    assert!(body.contains("- ✓ line 1\n"), "{body}");
    assert!(body.contains("- ✗ line 2 (attempt 2) — "), "{body}");
    assert!(
        body.contains("![Failing step](./screenshots/02.png)"),
        "{body}"
    );
    assert!(body.contains(&format!("Plan sha256 `{}`", "e".repeat(64))));
}

#[test]
fn a_moved_head_renders_the_older_commit_line() {
    let body = render(
        &failing_ledger(),
        true,
        &VideoStatus::Available,
        &VideoPublication::Eligible,
    );
    assert!(body.contains("this tested an older commit"), "{body}");
}

#[test]
fn run_details_list_every_field() {
    let body = render(
        &failing_ledger(),
        false,
        &VideoStatus::Unavailable("ffmpeg".into()),
        &VideoPublication::Eligible,
    );
    let details = &body[body
        .find("<details><summary>Run details</summary>")
        .unwrap()..];
    for field in [
        "steps 2",
        "jev.calls 3",
        "jev.medianMs 41",
        "llmTurns 1",
        "escapes 0",
        "recoveries 2",
        "path ",
    ] {
        assert!(details.contains(field), "{field}: {details}");
    }
    assert!(details.trim_end().ends_with("</details>"));
    assert!(body.contains("Video: unavailable (ffmpeg)."), "{body}");
}

#[test]
fn the_verdict_is_structured() {
    let body = render_pr_comment(
        &ReportInput {
            run_id: "r",
            platform: "ios",
            app_id: "a",
            device: "d",
            ledger: &failing_ledger(),
        },
        None,
        &PrRun {
            tested_sha: &"a".repeat(40),
            tested_older_commit: false,
            video: &VideoStatus::TooLarge,
            screenshot: None,
            plan_sha256: "0",
            video_publication: &VideoPublication::Eligible,
        },
        &machine(),
    );
    let sentence = body.lines().nth(1).unwrap();
    assert!(
        sentence.chars().count() <= 400,
        "{}",
        sentence.chars().count()
    );
    assert!(body.contains("too large to attach"));
}
