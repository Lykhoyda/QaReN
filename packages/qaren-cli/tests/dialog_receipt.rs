use qaren::core::Ledger;
use qaren::report::summarize;

#[test]
fn receipt_lists_each_proven_dialog_tap_with_its_label_and_frame() {
    let rect = serde_json::json!({ "x": 57.0, "y": 494.0, "width": 140.0, "height": 48.0 });
    let ledger: Ledger = serde_json::from_value(serde_json::json!({
        "verdict": "PASS", "path": "walk", "blocks": [],
        "steps": [
            { "block": "b", "line": 15, "attempt": 1, "kind": "step", "resolvedBy": "exact", "t": 0, "outcome": "pass" },
            { "block": "b", "line": 16, "attempt": 1, "kind": "step", "resolvedBy": "exact", "t": 0, "outcome": "pass",
              "dialog": { "label": "Don\u{2019}t Allow", "rect": rect } },
        ],
        "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 0,
    }))
    .unwrap();
    let summary = serde_json::to_value(summarize(&ledger)).unwrap();
    assert_eq!(
        summary["dialogs"],
        serde_json::json!([{ "line": 16, "label": "Don\u{2019}t Allow", "rect": rect }])
    );
    let plain: Ledger = serde_json::from_value(serde_json::json!({
        "verdict": "PASS", "path": "walk", "blocks": [], "steps": [],
        "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 0,
    }))
    .unwrap();
    assert!(serde_json::to_value(summarize(&plain))
        .unwrap()
        .get("dialogs")
        .is_none());
}
