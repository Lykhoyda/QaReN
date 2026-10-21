use serde_json::{Map, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;

const MAX_NUMBER: f64 = 9_007_199_254_740_991.0;
const STAGES: &[&str] = &[
    "walk",
    "capture",
    "native-total",
    "native-production",
    "native-initial-eligibility",
    "native-preparation",
    "native-enumeration",
    "native-observation",
    "native-final-eligibility",
    "native-revalidation",
    "native-readiness",
    "native-transport",
    "native-decode",
    "native-presence-v2",
    "native-read-only-v1",
    "react-private",
    "join-private",
    "privacy-history",
    "decision",
    "jev-attempt",
    "jev-validation",
    "jev-backoff",
    "screenshot",
    "cache-reuse",
    "mutation",
    "authorization",
    "refresh",
    "reask",
    "replay",
    "expiry",
    "readback",
    "settle-readback",
    "relaunch",
    "overflow",
];
const CODES: &[&str] = &[
    "ACCEPTED",
    "COMPLETED",
    "EVIDENCE_EXPIRED",
    "ITEM_DEADLINE_EXCEEDED",
    "ACTION_INTERRUPTED",
    "ACTION_CONTEXT_CHANGED",
    "RUN_CANCELLED",
    "ACTION_OUTCOME_UNCERTAIN",
    "TARGET_MOVED_BEFORE_DISPATCH",
    "CENTRE_COVERED",
    "SCREEN_EVIDENCE_INCOMPLETE",
];
const NATIVE_CODES: &[&str] = &[
    "ACTION_CONTEXT_CHANGED",
    "KEYBOARD_TARGET_STALE",
    "STALE_REF",
    "NO_TEXT_INPUT_TARGET",
    "TEXT_TARGET_FOCUS_FAILED",
    "OUTSIDE_APP_WINDOW",
    "RUNNER_OWNERSHIP_MISMATCH",
    "INTERACTION_NOT_ACTUATED",
    "KEYBOARD_RELAYOUT_REQUIRED",
    "RUNNER_TIMEOUT",
    "RUNNER_PROTOCOL_MISMATCH",
];
const NATIVE_READINESS_REASONS: &[&str] = &[
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

fn clean(value: &Value) -> Option<Value> {
    let fields = value.as_object()?;
    let kind = fields.get("kind")?.as_str()?;
    let (required, optional): (&[&str], &[&str]) = match kind {
        "metric" => (
            &["stage", "edge", "outcome", "at"],
            &[
                "line",
                "observation",
                "ms",
                "useMs",
                "ageMs",
                "count",
                "nextLine",
                "presence",
                "budgetMs",
                "appliedBudgetMs",
                "moved",
                "maxDelta",
                "relaunch",
                "reapDisposition",
                "readinessReason",
            ],
        ),
        "timing" => (
            &[
                "stage",
                "code",
                "line",
                "at",
                "acquisitionMs",
                "observationAgeMs",
            ],
            &[
                "authorizations",
                "observation",
                "nativeCode",
                "nativeMutation",
            ],
        ),
        "block-outcome" => (&["line", "outcome"], &[]),
        "login-outcome" => (&["outcome"], &[]),
        _ => return None,
    };
    if required.iter().any(|key| !fields.contains_key(*key)) {
        return None;
    }
    let mut clean = Map::new();
    clean.insert("kind".into(), kind.into());
    for (key, value) in fields {
        if key == "kind" {
            continue;
        }
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return None;
        }
        if key == "readinessReason"
            && (fields.get("stage")?.as_str()? != "native-readiness"
                || fields.get("edge")?.as_str()? != "end")
        {
            return None;
        }
        let words: Option<&[&str]> = match key.as_str() {
            "stage" if kind == "metric" => Some(STAGES),
            "stage" => Some(&["decision", "dispatch"]),
            "relaunch" if kind == "metric" => Some(&["attempted", "ready", "failed", "timeout"]),
            "reapDisposition" if kind == "metric" => {
                Some(&["reaped", "already-absent", "replacement-preserved"])
            }
            "edge" => Some(&["start", "end", "point"]),
            "outcome" if kind == "metric" => Some(&["ok", "failed", "unknown", "withheld"]),
            "outcome" => Some(&["pass", "fail", "refused"]),
            "code" => Some(CODES),
            "nativeCode" => Some(NATIVE_CODES),
            "nativeMutation" => Some(&["none", "observed", "possible"]),
            "readinessReason" => Some(NATIVE_READINESS_REASONS),
            _ => None,
        };
        if let Some(words) = words {
            let word = words.iter().find(|&&word| value.as_str() == Some(word))?;
            clean.insert(key.clone(), (*word).into());
        } else {
            let number = value.as_f64()?;
            if !number.is_finite()
                || !(0.0..=MAX_NUMBER).contains(&number)
                || (kind == "block-outcome" && key == "line" && number == 0.0)
            {
                return None;
            }
            clean.insert(key.clone(), value.clone());
        }
    }
    Some(clean.into())
}

pub(super) struct Sink {
    file: Option<File>,
    events: usize,
    outcomes: usize,
}

impl Sink {
    pub(super) fn new(log: &Path) -> Self {
        Self {
            file: crate::redact::private_output_mode()
                .then(|| {
                    OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(log.with_file_name("core-diagnostics.jsonl"))
                        .ok()
                })
                .flatten(),
            events: 0,
            outcomes: 0,
        }
    }

    pub(super) fn accept(&mut self, payload: &Value) {
        let Some(file) = &mut self.file else {
            return;
        };
        let outcome = matches!(
            payload["kind"].as_str(),
            Some("block-outcome" | "login-outcome")
        );
        let (count, limit) = if outcome {
            (&mut self.outcomes, 10_000)
        } else {
            (&mut self.events, 20_000)
        };
        if *count >= limit {
            return;
        }
        *count += 1;
        if let Some(event) = clean(payload) {
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}
