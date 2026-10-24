use qaren::core::{Ledger, Row};
use qaren::report::{render, ReportInput};
use serde_json::json;

fn ledger(steps: serde_json::Value, speed: serde_json::Value) -> serde_json::Value {
    json!({"verdict":"PASS","path":"walk","publicationInterrupted":false,"blocks":[],"steps":steps,
        "jev":{"calls":0,"medianMs":0,"inputTokens":0,"callDetails":[]},"llmTurns":0,"escapes":0,"recoveries":0,"speed":speed})
}

fn timing() -> serde_json::Value {
    json!({"captureMs":40,"nativeMs":30,"reactMs":8,"presenceMs":26,"resolveMs":20,"jevMs":12,
        "actMs":15,"postCaptureMs":30,"otherMs":15,"total":120})
}

#[test]
fn row_timing_and_ledger_speed_round_trip_through_the_ledger() {
    let mut raw = ledger(
        json!([{"block":"qa","line":1,"attempt":1,"kind":"step","resolvedBy":"jev","t":120,
            "outcome":"pass","timing":timing()}]),
        json!({"stepMedianMs":120,"stepP95Ms":120,"walkMs":120,"steps":1,"passed":1,"failed":0}),
    );
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.steps[0].timing.as_ref().unwrap().post_capture_ms, 30);
    assert_eq!(parsed.speed.as_ref().unwrap().step_p95_ms, Some(120));
    assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
    assert_eq!(parsed.steps[0].operation_id, 0);
    assert_eq!(
        serde_json::to_value(&parsed.steps[0]).unwrap(),
        raw["steps"][0]
    );

    raw["steps"][0]["operationId"] = json!(7);
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.steps[0].operation_id, 7);
    assert_eq!(
        serde_json::to_value(&parsed.steps[0]).unwrap(),
        raw["steps"][0]
    );
    assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
}

#[test]
fn explicit_video_publication_survives_ledger_round_trip() {
    for eligibility in ["eligible", "withheld-fill", "withheld-privacy", "unknown"] {
        let mut raw = ledger(
            json!([]),
            json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
        );
        raw["videoPublication"] = json!(eligibility);
        let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
    }
}

#[test]
fn publication_interruption_survives_ledger_round_trip_and_defaults_to_false() {
    let mut raw = ledger(
        json!([]),
        json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
    );
    for interrupted in [false, true] {
        raw["publicationInterrupted"] = json!(interrupted);
        let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(parsed.publication_interrupted, interrupted);
        assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
    }
    raw.as_object_mut()
        .unwrap()
        .remove("publicationInterrupted");
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert!(!parsed.publication_interrupted);
    raw["publicationInterrupted"] = json!(false);
    assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
}

#[test]
fn the_admission_time_survives_ledger_round_trip() {
    let mut raw = ledger(
        json!([]),
        json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
    );
    raw["admittedAtMs"] = json!(1_791_100_000_123u64);
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.admitted_at_ms, Some(1_791_100_000_123));
    assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
}

#[test]
fn the_publish_window_survives_ledger_round_trip() {
    let mut raw = ledger(
        json!([]),
        json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
    );
    raw["admittedAtMs"] = json!(1_791_100_000_123u64);
    raw["publishFromMs"] = json!(1_791_100_004_567u64);
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.publish_from_ms, Some(1_791_100_004_567));
    assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
}

#[test]
fn malformed_timing_is_dropped_without_rejecting_the_row_or_ledger() {
    let row: Row = serde_json::from_value(json!({"block":"qa","line":1,"attempt":1,"kind":"step",
        "resolvedBy":"exact","t":5,"outcome":"pass","timing":{"captureMs":-1}}))
    .unwrap();
    assert!(row.timing.is_none());
    let parsed: Ledger =
        serde_json::from_value(ledger(json!([]), json!({"walkMs":"slow"}))).unwrap();
    assert!(parsed.speed.is_none());
    let untimed: Ledger =
        serde_json::from_value(json!({"verdict":"PASS","path":"walk","blocks":[],
        "steps":[],"jev":{"calls":0,"medianMs":0},"llmTurns":0,"escapes":0,"recoveries":0}))
        .unwrap();
    assert!(untimed.speed.is_none());
    assert!(!serde_json::to_string(&untimed).unwrap().contains("speed"));
}

#[test]
fn report_run_details_print_speed_only_when_present() {
    let input = |ledger: &Ledger| {
        render(&ReportInput {
            run_id: "check-1",
            platform: "ios",
            app_id: "com.example",
            device: "sim",
            ledger,
        })
    };
    let timed: Ledger = serde_json::from_value(ledger(
        json!([]),
        json!({"stepMedianMs":250,"stepP95Ms":400,"walkMs":1900,"steps":5,"passed":4,"failed":1}),
    ))
    .unwrap();
    assert!(input(&timed).contains(
        "stepMedianMs 250 · stepP95Ms 400 · walkMs 1900 · steps 5 (4 passed, 1 failed)\n"
    ));
    for (speed, expected) in [
        (
            json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
            "stepMedianMs n/a · stepP95Ms n/a · walkMs 0 · steps 0 (0 passed, 0 failed)\n",
        ),
        (
            json!({"stepMedianMs":10000,"stepP95Ms":10000,"walkMs":10000,"steps":1,"passed":0,"failed":1}),
            "stepMedianMs 10000 · stepP95Ms 10000 · walkMs 10000 · steps 1 (0 passed, 1 failed)\n",
        ),
        (
            json!({"stepMedianMs":10,"walkMs":10}),
            "stepMedianMs 10 · stepP95Ms n/a · walkMs 10 · steps 0 (0 passed, 0 failed)\n",
        ),
    ] {
        let parsed: Ledger = serde_json::from_value(ledger(json!([]), speed)).unwrap();
        assert!(input(&parsed).contains(expected));
    }
    let empty = ledger(
        json!([]),
        json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
    );
    let parsed: Ledger = serde_json::from_value(empty.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), empty);
    let untimed: Ledger = serde_json::from_value(ledger(json!([]), json!(null))).unwrap();
    assert!(!input(&untimed).contains("stepMedianMs"));
}

#[test]
fn media_withholding_round_trips_and_unknown_causes_are_passive() {
    let mut raw = ledger(
        json!([{"block":"qa","line":3,"attempt":1,"kind":"check","resolvedBy":"exact","t":1,"outcome":"pass","screenshotWithheld":"generic-value"}]),
        json!({"walkMs":0,"steps":0,"passed":0,"failed":0}),
    );
    raw["mediaWithheld"] = json!({"screenshots":{"reason":"generic-value","kind":"other","line":3,"count":2},"video":{"reason":"echo","source":"typed","line":5}});
    let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), raw);
    assert_eq!(
        parsed
            .media_withheld
            .as_ref()
            .unwrap()
            .screenshots
            .as_ref()
            .unwrap()
            .receipt_note(),
        "generic-value/other@line 3"
    );
    let report = render(&ReportInput {
        run_id: "check-1",
        platform: "ios",
        app_id: "com.test",
        device: "sim",
        ledger: &parsed,
    });
    assert!(report.contains("screenshot withheld (generic-value)"));
    assert!(report.contains("Screenshots withheld from line 3:"));
    raw["steps"][0]["screenshotWithheld"] = json!("future-code");
    raw["mediaWithheld"]["screenshots"]["reason"] = json!("future-code");
    let parsed: Ledger = serde_json::from_value(raw).unwrap();
    let serialized = serde_json::to_value(parsed).unwrap();
    assert!(serialized.get("mediaWithheld").is_none());
    assert!(serialized["steps"][0].get("screenshotWithheld").is_none());
}
