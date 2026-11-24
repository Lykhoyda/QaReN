use qaren::report::{InconclusivePresses, LedgerSummary, PressOutcomeUnknown};
use serde_json::{json, Value};

pub type Lists = (Vec<InconclusivePresses>, Vec<PressOutcomeUnknown>);

// Rows A1, A2 (one operation, retried), B (same line, another operation), C (lost reply),
// D (no evidence) and E (no operation id). No other member is named `line`.
pub fn ledger(reason: Option<&str>) -> qaren::core::Ledger {
    let mut c = json!({"block":"qa","line":2,"operationId":10,"attempt":1,"kind":"step",
        "resolvedBy":"exact","t":1,"outcome":"fail","pressOutcomeUnknown":1});
    if let Some(reason) = reason {
        c["reason"] = reason.into();
    }
    serde_json::from_value(json!({
        "verdict":"FAIL", "path":"walk", "blocks":[],
        "steps":[
            {"block":"qa","line":1,"operationId":7,"attempt":1,"kind":"step","resolvedBy":"exact",
             "t":1,"outcome":"retry","inconclusivePresses":{"deadline":1}},
            {"block":"qa","line":1,"operationId":7,"attempt":1,"kind":"step","resolvedBy":"exact",
             "t":1,"outcome":"pass","inconclusivePresses":{"ambiguous":1}},
            {"block":"qa","line":1,"operationId":9,"attempt":1,"kind":"step","resolvedBy":"exact",
             "t":1,"outcome":"pass","inconclusivePresses":{"deadline":2}},
            c,
            {"block":"qa","line":3,"operationId":11,"attempt":1,"kind":"step","resolvedBy":"exact",
             "t":1,"outcome":"pass"},
            {"block":"qa","line":7,"attempt":1,"kind":"step","resolvedBy":"exact",
             "t":1,"outcome":"pass","inconclusivePresses":{"absent":1}},
        ],
        "jev":{"calls":0,"medianMs":0}, "llmTurns":0, "escapes":0, "recoveries":0,
    }))
    .unwrap()
}

pub fn lists(inconclusive: Value, unknown: Value) -> Lists {
    (
        serde_json::from_value(inconclusive).unwrap(),
        serde_json::from_value(unknown).unwrap(),
    )
}

pub fn expected() -> Lists {
    lists(
        json!([
            {"operation_id":7,"line":1,"counts":{"ambiguous":1,"deadline":1}},
            {"operation_id":9,"line":1,"counts":{"deadline":2}},
            {"line":7,"counts":{"absent":1}},
        ]),
        json!([{"operation_id":10,"line":2,"count":1}]),
    )
}

pub fn summary_lists(summary: LedgerSummary) -> Lists {
    (summary.inconclusive_presses, summary.press_outcome_unknown)
}

pub fn input_scope(input: Option<&str>) -> std::sync::Arc<qaren::redact::InputValues> {
    std::sync::Arc::new(qaren::redact::InputValues::from_entries(input.map(
        |input| {
            (
                std::ffi::OsString::from("QAREN_INPUT_PASSWORD"),
                std::ffi::OsString::from(input),
            )
        },
    )))
}
