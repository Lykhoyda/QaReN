use qaren::core::{DevErrorDismissal, Ledger};
use qaren::record::{VideoPublication, VideoStatus};
use qaren::redact::MachineIdentity;
use qaren::report::{self, LedgerSummary, PrRun, ReportInput};
use serde_json::{json, Value};

fn warning() -> Value {
    json!({ "variant": "redbox", "dismissal": 1, "afterAction": true,
        "proof": "next-test-id-appeared" })
}

fn ledger(metadata: Value) -> Ledger {
    serde_json::from_value(json!({
        "verdict": "PASS", "path": "walk", "blocks": [],
        "steps": [{ "block": "b", "line": 1, "attempt": 1, "kind": "step",
            "resolvedBy": "exact", "t": 0, "outcome": "pass", "devError": metadata }],
        "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 1,
    }))
    .unwrap()
}

#[test]
fn post_action_fields_and_legacy_dismissals_round_trip() {
    for wire in [warning(), json!({ "variant": "logbox", "dismissal": 2 })] {
        let decoded: DevErrorDismissal = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);
        assert_eq!(
            serde_json::to_value(ledger(wire.clone())).unwrap()["steps"][0]["devError"],
            wire
        );
    }
}

#[test]
fn invalid_post_action_combinations_are_rejected() {
    for (key, value) in [
        ("afterAction", Value::Null),
        ("proof", Value::Null),
        ("afterAction", json!(false)),
        ("dismissal", json!(2)),
        ("proof", json!("screen-changed")),
        ("variant", json!("logbox")),
        ("text", json!("CANARY_PRIVATE")),
    ] {
        let mut wire = warning();
        wire[key] = value;
        assert!(
            serde_json::from_value::<DevErrorDismissal>(wire.clone()).is_err(),
            "{wire}"
        );
    }
}

#[test]
fn summary_counts_warning_rows_once_and_preserves_legacy_summary() {
    let mut observed = ledger(warning());
    observed.steps.push(observed.steps[0].clone());
    observed.steps[1].line = 2;
    observed.steps[1].outcome = "retry".into();
    let summary = serde_json::to_value(report::summarize(&observed)).unwrap();
    assert_eq!(summary["devOverlayWarnings"], 1);
    assert_eq!(summary["verdict"], "PASS");
    let old = report::summarize(&ledger(json!({ "variant": "redbox", "dismissal": 1 })));
    let old = serde_json::to_value(old).unwrap();
    assert!(old.get("devOverlayWarnings").is_none());
    let decoded: LedgerSummary = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), old);
}

#[test]
fn every_report_verdict_discloses_development_overlay_warnings() {
    assert_eq!(
        report::dev_overlay_verdict("pass", 1),
        "pass (1 development overlay warning)"
    );
    assert_eq!(
        report::dev_overlay_verdict("PASS", 2),
        "PASS (2 development overlay warnings)"
    );
    assert_eq!(report::dev_overlay_verdict("fail", 1), "fail");
    let observed = ledger(warning());
    let input = ReportInput {
        video: None,
        run_id: "check-test",
        platform: "ios",
        app_id: "com.example",
        device: "test-device",
        ledger: &observed,
    };
    let pr = PrRun {
        tested_sha: "abcdef1234567",
        tested_older_commit: false,
        video: &VideoStatus::Available,
        video_continuity: &[],
        screenshot: None,
        plan_sha256: "plan-hash",
        video_publication: &VideoPublication::Eligible,
    };
    let machine = MachineIdentity::default();
    for output in [
        report::render(&input),
        report::render_pr_comment(&input, None, &pr, &machine),
        report::render_pr_description(
            &input,
            None,
            &pr,
            &machine,
            "https://example.org/comment",
            None,
        ),
    ] {
        assert!(
            output.contains("PASS (1 development overlay warning)"),
            "{output}"
        );
    }
}
