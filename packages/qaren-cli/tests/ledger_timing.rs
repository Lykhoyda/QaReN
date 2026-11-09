use qaren::core::{Ledger, Row};
use qaren::report::{render, ReportInput};
use serde_json::json;

fn ledger(steps: serde_json::Value, speed: serde_json::Value) -> serde_json::Value {
    json!({"verdict":"PASS","path":"walk","videoPolicy":"undeclared","publicationInterrupted":false,"blocks":[],"steps":steps,
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
fn continuity_events_are_passive_and_report_the_first_counted_owner() {
    let mut raw = ledger(json!([]), serde_json::Value::Null);
    raw["admittedAtMs"] = json!(100_000);
    for (signal, owner, cause) in [
        (
            "runner-recovery",
            "qaren",
            "QaReN's runner restarted at 0:12 after admission (line 7)",
        ),
        (
            "runner-leak",
            "qaren",
            "QaReN's runner restarted at 0:12 after admission (line 7)",
        ),
        (
            "app-process-unproven",
            "qaren",
            "QaReN could not read the app's process at 0:12 after admission (line 7)",
        ),
        (
            "app-not-running",
            "app",
            "the app's process changed or stopped at 0:12 after admission (line 7)",
        ),
        (
            "app-process-changed",
            "app",
            "the app's process changed or stopped at 0:12 after admission (line 7)",
        ),
        (
            "app-process-gone",
            "app",
            "the app's process changed or stopped at 0:12 after admission (line 7)",
        ),
        (
            "dev-client-picker",
            "dev-client",
            "the dev client's picker came to the front at 0:12 after admission (line 7)",
        ),
        (
            "first-run-tutorial",
            "dev-client",
            "the dev client's first-run tutorial came to the front at 0:12 after admission (line 7)",
        ),
        (
            "dev-overlay",
            "dev-client",
            "the dev client's dev menu came to the front at 0:12 after admission (line 7)",
        ),
    ] {
        raw["continuityEvents"] = json!([
            {"signal":"runner-recovery","atMs":99_000,"counted":false,"beforeAdmission":true},
            {"signal":signal,"atMs":112_000,"line":7,"counted":true,"detail":{"front":"dev-menu","unresolved":true}}
        ]);
        raw["continuityEventsDropped"] = json!(2);
        let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(parsed.first_counted().unwrap().owner(), owner);
        assert_eq!(parsed.continuity_events_dropped, Some(2));
        let line = qaren::report::video_unavailable_line(
            &qaren::record::VideoStatus::unavailable(
                "app continuity was interrupted after admission".into(),
            ),
            Some(&parsed),
        )
        .unwrap();
        assert!(line.contains(cause), "{line}");
        assert!(line.contains(&format!("owner: {owner}")), "{line}");
        assert!(!line.contains("re-run"));
    }
    for malformed in [
        json!(null),
        json!({}),
        json!([{"signal":"runner-recovery","atMs":"bad"}]),
    ] {
        raw["continuityEvents"] = malformed;
        let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
        assert!(parsed.continuity_events.is_empty());
    }
    raw["continuityEvents"] = json!([{"signal":"future-signal","atMs":112_000,"counted":true}]);
    let parsed: Ledger = serde_json::from_value(raw).unwrap();
    assert_eq!(
        parsed.first_counted().unwrap().signal,
        qaren::core::ContinuitySignal::Unknown
    );
}

#[test]
fn kept_video_explains_runner_frames_only_inside_the_publication_window() {
    let mut raw = ledger(json!([]), serde_json::Value::Null);
    raw["admittedAtMs"] = json!(100_000);
    raw["publishFromMs"] = json!(110_000);
    raw["videoPolicy"] = json!("non-strict");
    raw["nonStrictPublication"] = json!("eligible");
    for (at_ms, expected) in [(99_000, false), (105_000, false), (112_000, true)] {
        raw["continuityEvents"] =
            json!([{"signal":"runner-recovery","atMs":at_ms,"counted":false}]);
        let parsed: Ledger = serde_json::from_value(raw.clone()).unwrap();
        let note = qaren::report::video_outcome_line(
            &parsed,
            &qaren::record::VideoPublication::Eligible,
            Some(&qaren::record::VideoStatus::Available),
        );
        assert_eq!(note.is_some(), expected);
        if let Some(note) = note {
            assert_eq!(note, "QaReN observed its runner recovery at 0:12 after admission; the app kept running (same process), so the video was kept. This is when the snapshot completed, not the start of the runner frames.");
        }
    }
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
            video: None,
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
        video: None,
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

#[test]
fn settle_and_preparation_facts_round_trip_and_remain_optional() {
    for method in [
        "window-gate",
        "screen-static",
        "snapshot-eq",
        "timeout",
        "unknown",
        "mixed",
    ] {
        let mut measured = timing();
        measured["settleMethod"] = json!(method);
        measured["settleMs"] = json!(0);
        measured["preparationSamples"] = json!(14);
        measured["preparationResets"] = json!(0);
        let raw = json!({"block":"qa","line":1,"attempt":1,"kind":"step",
            "resolvedBy":"exact","t":120,"outcome":"pass","timing":measured});
        let parsed: Row = serde_json::from_value(raw.clone()).unwrap();
        let facts = parsed.timing.as_ref().unwrap();
        assert_eq!(facts.settle_ms, Some(0));
        assert_eq!(facts.preparation_samples, Some(14));
        assert_eq!(facts.preparation_resets, Some(0));
        assert_eq!(serde_json::to_value(parsed).unwrap(), raw);
    }
    let legacy: qaren::core::RowTiming = serde_json::from_value(timing()).unwrap();
    assert!(legacy.settle_method.is_none());
    assert!(legacy.settle_ms.is_none());
    assert!(legacy.preparation_samples.is_none());
    assert!(legacy.preparation_resets.is_none());
    assert_eq!(serde_json::to_value(legacy).unwrap(), timing());
}

#[test]
fn malformed_settle_and_preparation_facts_cannot_reject_a_row() {
    for (field, value) in [
        ("settleMethod", json!("PRIVATE-method")),
        ("settleMs", json!(-1)),
        ("preparationSamples", json!(1.5)),
        ("preparationResets", json!("PRIVATE-count")),
    ] {
        let mut measured = timing();
        measured[field] = value;
        let parsed: Row = serde_json::from_value(json!({"block":"qa","line":1,
            "attempt":1,"kind":"step","resolvedBy":"exact","t":120,
            "outcome":"pass","timing":measured}))
        .unwrap();
        assert_eq!(parsed.outcome, "pass");
        assert!(parsed.timing.is_none());
    }
}

#[test]
fn launch_wait_round_trips_and_a_malformed_value_cannot_reject_a_row() {
    let row = |extra: serde_json::Value| {
        let mut raw = json!({"block":"qa","line":2,"attempt":1,"kind":"step",
            "resolvedBy":"exact","t":120,"outcome":"pass"});
        if let Some(fields) = extra.as_object() {
            for (key, value) in fields {
                raw[key] = value.clone();
            }
        }
        raw
    };
    let raw = row(json!({"implicitWaitMs":4900}));
    let parsed: Row = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(parsed.implicit_wait_ms, Some(4900));
    assert_eq!(serde_json::to_value(parsed).unwrap(), raw);

    let zero: Row = serde_json::from_value(row(json!({"implicitWaitMs":0}))).unwrap();
    assert_eq!(zero.implicit_wait_ms, Some(0));

    let legacy: Row = serde_json::from_value(row(json!({}))).unwrap();
    assert!(legacy.implicit_wait_ms.is_none());
    assert!(serde_json::to_value(legacy)
        .unwrap()
        .get("implicitWaitMs")
        .is_none());

    for value in [json!(-1), json!(1.5), json!("PRIVATE-ms")] {
        let parsed: Row = serde_json::from_value(row(json!({"implicitWaitMs":value}))).unwrap();
        assert_eq!(parsed.outcome, "pass");
        assert!(parsed.implicit_wait_ms.is_none());
    }
}

#[test]
fn proven_app_events_take_precedence_over_older_unproven_continuity_events() {
    for unproven in ["runner-recovery", "runner-leak", "app-process-unproven"] {
        for detail in [
            json!({"unresolved":true}),
            json!({}),
            serde_json::Value::Null,
        ] {
            for (signal, owner) in [
                ("app-not-running", "app"),
                ("app-process-changed", "app"),
                ("app-process-gone", "app"),
                ("dev-client-picker", "dev-client"),
                ("first-run-tutorial", "dev-client"),
            ] {
                let mut raw = ledger(json!([]), serde_json::Value::Null);
                raw["admittedAtMs"] = json!(100_000);
                raw["continuityEvents"] = json!([
                    {"signal":unproven,"atMs":101_000,"counted":true,"detail":detail},
                    {"signal":signal,"atMs":112_000,"counted":true,"line":7}
                ]);
                let parsed: Ledger = serde_json::from_value(raw).unwrap();
                let selected = parsed.first_counted().unwrap();
                assert_eq!(serde_json::to_value(selected.signal).unwrap(), signal);
                assert_eq!(selected.at_ms, 112_000);
                assert_eq!(selected.owner(), owner);
                assert_eq!(parsed.continuity_events[0].at_ms, 101_000);
                assert_eq!(
                    parsed.continuity_events[0].detail,
                    if detail.is_null() {
                        None
                    } else {
                        Some(detail.clone())
                    }
                );
                let status = qaren::record::VideoStatus::unavailable(
                    "app continuity was interrupted after admission".into(),
                );
                let receipt =
                    qaren::publish::VideoInterruption::from_ledger(&status, &parsed, 90_000)
                        .unwrap();
                assert_eq!(receipt.owner, owner);
                assert_eq!(receipt.at_ms, 112_000);
                assert_eq!(receipt.after_admission_ms, Some(12_000));
                assert_eq!(receipt.video_ms, Some(22_000));
                let line = qaren::report::video_unavailable_line(&status, Some(&parsed)).unwrap();
                assert!(line.contains("0:12 after admission (line 7)"), "{line}");
                assert!(line.contains(&format!("owner: {owner}")), "{line}");
                assert!(!line.contains("could not confirm"), "{line}");
            }
        }
    }
}

#[test]
fn first_counted_is_preserved_without_later_proven_app_evidence() {
    for (first, detail, later) in [
        (
            "runner-recovery",
            json!({"unresolved":true}),
            "app-process-unproven",
        ),
        ("runner-leak", json!({}), "future-signal"),
        (
            "runner-recovery",
            json!({"fromPid":41,"toPid":77}),
            "app-not-running",
        ),
        (
            "app-process-unproven",
            json!({"unresolved":true}),
            "dev-overlay",
        ),
        (
            "dev-overlay",
            json!({"front":"dev-menu"}),
            "app-not-running",
        ),
    ] {
        let mut raw = ledger(json!([]), serde_json::Value::Null);
        raw["continuityEvents"] = json!([
            {"signal":first,"atMs":101_000,"counted":true,"detail":detail},
            {"signal":later,"atMs":112_000,"counted":true}
        ]);
        let parsed: Ledger = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.first_counted().unwrap().at_ms, 101_000);
    }
}

#[test]
fn cover_wait_survives_stream_and_saved_ledger_and_drops_malformed_values() {
    for value in [
        json!(0),
        json!(1000),
        json!(5000),
        json!(-1),
        json!(1.5),
        json!("PRIVATE-ms"),
        json!(null),
        json!({"ms": 10}),
    ] {
        let raw = json!({"block":"qa","line":2,"attempt":1,"kind":"step",
            "resolvedBy":"exact","t":120,"outcome":"pass","coverWaitMs":value});
        let streamed: Row = serde_json::from_value(raw.clone()).unwrap();
        let saved: Ledger = serde_json::from_value(ledger(json!([raw]), json!(null))).unwrap();
        let expected = value.as_u64();
        assert_eq!(streamed.cover_wait_ms, expected);
        assert_eq!(saved.steps[0].cover_wait_ms, expected);
        for row in [streamed, saved.steps[0].clone()] {
            let encoded = serde_json::to_value(row).unwrap();
            if expected.is_some() {
                assert_eq!(encoded["coverWaitMs"], value);
            } else {
                assert!(encoded.get("coverWaitMs").is_none());
            }
        }
    }
    let legacy: Row = serde_json::from_value(json!({"block":"qa","line":2,"attempt":1,
        "kind":"step","resolvedBy":"exact","t":120,"outcome":"pass"}))
    .unwrap();
    assert!(legacy.cover_wait_ms.is_none());
}
