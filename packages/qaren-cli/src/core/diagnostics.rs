use serde_json::{Map, Value};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

fn clean_target_miss(fields: &Map<String, Value>) -> Option<Value> {
    if fields
        .keys()
        .any(|key| !["kind", "line", "reason", "truncated", "candidates"].contains(&key.as_str()))
    {
        return None;
    }
    let line = fields.get("line")?.as_u64()?;
    if line == 0 || line > MAX_NUMBER as u64 {
        return None;
    }
    let reason = fields.get("reason")?.as_str()?;
    if ![
        "absent",
        "only-in-aggregated-label",
        "not-scrollable",
        "present-but-unavailable",
        "evidence-incomplete",
    ]
    .contains(&reason)
    {
        return None;
    }
    let candidates = fields.get("candidates")?.as_array()?;
    if candidates.len() > 20 {
        return None;
    }
    let mut clean_candidates = Vec::new();
    for candidate in candidates {
        let candidate = candidate.as_object()?;
        if candidate
            .keys()
            .any(|key| !["identifier", "label", "match", "aggregated"].contains(&key.as_str()))
        {
            return None;
        }
        let matching = candidate.get("match")?.as_str()?;
        if !["exact", "inside-label", "near"].contains(&matching) {
            return None;
        }
        let mut clean = Map::new();
        clean.insert("match".into(), matching.into());
        clean.insert(
            "aggregated".into(),
            candidate.get("aggregated")?.as_bool()?.into(),
        );
        for key in ["identifier", "label"] {
            if let Some(value) = candidate.get(key) {
                let text = value.as_str()?;
                if text.encode_utf16().count() > 256 {
                    return None;
                }
                clean.insert(
                    key.into(),
                    crate::redact::redact_inputs(&crate::redact::redact_secrets(text))
                        .chars()
                        .take(256)
                        .collect::<String>()
                        .into(),
                );
            }
        }
        clean_candidates.push(Value::Object(clean));
    }
    Some(serde_json::json!({
        "kind": "target-miss", "line": line, "reason": reason,
        "truncated": fields.get("truncated")?.as_bool()?, "candidates": clean_candidates,
    }))
}

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
    "type-call",
    "type-readback",
    "relayout-retap",
    "settle",
    "keyboard",
    "relaunch",
    "admission",
    "runner-post-mortem",
    "dispatch-bind",
    "dispatch-native",
    "dispatch-settle",
    "dispatch-health",
    "dispatch-readback",
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
const HEALTH_DETAILS: &[&str] = &[
    "refused",
    "reset",
    "abort",
    "http-4xx",
    "http-5xx",
    "body-not-ok",
    "wedged",
    "transport-timeout",
    "http-protocol",
    "other",
];
const RUNNER_SIGNALS: &[&str] = &[
    "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGTRAP", "SIGSEGV", "SIGBUS",
    "SIGPIPE", "other",
];
const POST_MORTEM_FIELDS: &[&str] = &[
    "hostChild",
    "exitCode",
    "exitSignal",
    "appProcess",
    "markerReady",
    "markerWaiting",
    "markerWaitResult",
    "markerListenerFailed",
    "markerSendFailed",
    "markerIssueContained",
    "markerTestIssue",
    "markerTestFailed",
];

const ADMISSION_BOUNDARIES: &[&str] = &[
    "attach",
    "bundle_ready",
    "foreign_driver",
    "open",
    "prove",
    "relaunch",
    "retry_wait",
];
const ADMISSION_COMPLETED: &[&str] = &[
    "attach",
    "bundle_ready",
    "foreign_driver",
    "open",
    "prove",
    "relaunch",
    "retry_wait",
    "none",
];
const ADMISSION_INNER: &[&str] = &[
    "target_selection_platform_not_found",
    "target_selection_platform_conflict",
    "target_selection_device_not_found",
    "target_selection_device_ambiguous",
    "target_selection_bundle_not_found",
    "target_list_attempt_timeout",
    "target_readiness_timeout",
    "target_list_empty",
    "target_other_device",
    "bundle_readiness_timeout",
    "cdp_probe_timeout",
    "cdp_handshake_timeout",
    "cdp_target_closed",
    "cdp_request_timeout",
    "untyped",
    "none",
];
const ADMISSION_KEYS: &[&str] = &[
    "admission",
    "attempt",
    "lastStarted",
    "lastCompleted",
    "attachStage",
    "inner",
    "relaunches",
    "relaunchFailed",
    "liveness",
    "bundleRequest",
    "elapsedMs",
    "remainingMs",
];

fn clean(value: &Value) -> Option<Value> {
    let fields = value.as_object()?;
    let raw_kind = fields.get("kind")?.as_str()?;
    if raw_kind == "media-withheld" {
        let scope = fields.get("scope")?.as_str()?;
        if !["screenshots", "video"].contains(&scope) {
            return None;
        }
        let line = fields.get("line")?.as_u64()?;
        if line > MAX_NUMBER as u64 {
            return None;
        }
        let cause = fields.get("cause")?.as_object()?;
        let reason: super::WithholdCause =
            serde_json::from_value(cause.get("reason")?.clone()).ok()?;
        let mut clean_cause = serde_json::json!({"reason": reason});
        if let Some(kind) = cause.get("kind") {
            if reason != super::WithholdCause::GenericValue {
                return None;
            }
            let kind: super::MediaKind = serde_json::from_value(kind.clone()).ok()?;
            clean_cause["kind"] = serde_json::to_value(kind).ok()?;
        }
        if let Some(source) = cause.get("source") {
            if reason != super::WithholdCause::Echo {
                return None;
            }
            let source: super::MediaSource = serde_json::from_value(source.clone()).ok()?;
            clean_cause["source"] = serde_json::to_value(source).ok()?;
        }
        return Some(
            serde_json::json!({"kind": raw_kind, "scope": scope, "cause": clean_cause, "line": line}),
        );
    }
    let carrier_kind = [
        "input", "other", "text", "button", "cell", "image", "switch", "link",
    ]
    .contains(&raw_kind);
    if carrier_kind
        && (fields.get("stage")?.as_str()? != "screenshot"
            || fields.get("outcome")?.as_str()? != "withheld")
    {
        return None;
    }
    let kind = if carrier_kind { "metric" } else { raw_kind };
    if kind == "target-miss" {
        return clean_target_miss(fields);
    }
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
                "method",
                "settled",
                "hierarchyChanged",
                "event",
                "proof",
                "keyboard",
                "relaunch",
                "reapDisposition",
                "readinessReason",
                "withheld",
                "source",
                "admission",
                "attempt",
                "lastStarted",
                "lastCompleted",
                "attachStage",
                "inner",
                "relaunches",
                "relaunchFailed",
                "liveness",
                "bundleRequest",
                "elapsedMs",
                "remainingMs",
                "healthDetail",
                "hostChild",
                "exitCode",
                "exitSignal",
                "appProcess",
                "markerReady",
                "markerWaiting",
                "markerWaitResult",
                "markerListenerFailed",
                "markerSendFailed",
                "markerIssueContained",
                "markerTestIssue",
                "markerTestFailed",
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
                "refusalStage",
                "mutating",
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
    clean.insert("kind".into(), raw_kind.into());
    for (key, value) in fields {
        if key == "kind" {
            continue;
        }
        if !required.contains(&key.as_str()) && !optional.contains(&key.as_str()) {
            return None;
        }
        if ["withheld", "source"].contains(&key.as_str())
            && (kind != "metric"
                || fields.get("stage")?.as_str()? != "screenshot"
                || fields.get("outcome")?.as_str()? != "withheld")
        {
            return None;
        }
        if key == "readinessReason"
            && (fields.get("stage")?.as_str()? != "native-readiness"
                || fields.get("edge")?.as_str()? != "end")
        {
            return None;
        }
        if key == "healthDetail"
            && (fields.get("stage")?.as_str()? != "native-readiness"
                || fields.get("edge")?.as_str()? != "end"
                || fields.get("readinessReason")?.as_str()? != "health")
        {
            return None;
        }
        if POST_MORTEM_FIELDS.contains(&key.as_str())
            && fields.get("stage")?.as_str()? != "runner-post-mortem"
        {
            return None;
        }
        if ADMISSION_KEYS.contains(&key.as_str())
            && (fields.get("stage")?.as_str()? != "admission"
                || fields.get("edge")?.as_str()? != "point")
        {
            return None;
        }
        if key == "relaunchFailed" {
            clean.insert(key.clone(), value.as_bool()?.into());
            continue;
        }
        let words: Option<&[&str]> = match key.as_str() {
            "stage" if kind == "metric" => Some(STAGES),
            "stage" => Some(&["decision", "dispatch"]),
            "relaunch" if kind == "metric" => Some(&["attempted", "ready", "failed", "timeout"]),
            "reapDisposition" if kind == "metric" => {
                Some(&["reaped", "already-absent", "replacement-preserved"])
            }
            "edge" => Some(&["start", "end", "point"]),
            "outcome" if kind == "metric" => {
                Some(&["ok", "failed", "unknown", "withheld", "unavailable"])
            }
            "outcome" => Some(&["pass", "fail", "refused"]),
            "code" => Some(CODES),
            "nativeCode" => Some(NATIVE_CODES),
            "refusalStage" => Some(&["dispatch-error", "native-response", "settle"]),
            "method" => Some(&[
                "window-gate",
                "screen-static",
                "snapshot-eq",
                "timeout",
                "unknown",
            ]),
            "event" => Some(&["shown", "hidden", "relayout"]),
            "proof" => Some(&["focused", "not-proven"]),
            "settled" | "hierarchyChanged" if !value.is_boolean() => Some(&["unknown"]),
            "nativeMutation" => Some(&["none", "observed", "possible"]),
            "withheld" => Some(&[
                "runtime-input",
                "concealed-fill",
                "secure-field",
                "input-value",
                "generic-value",
                "code-row",
                "echo",
            ]),
            "source" => Some(&["typed", "observed", "concealed", "secret", "code", "input"]),
            "readinessReason" => Some(NATIVE_READINESS_REASONS),
            "admission" => Some(&["retry", "cancelled", "refused"]),
            "lastStarted" => Some(ADMISSION_BOUNDARIES),
            "lastCompleted" => Some(ADMISSION_COMPLETED),
            "attachStage" => Some(&["wait_targets", "connect_exact"]),
            "inner" => Some(ADMISSION_INNER),
            "liveness" => Some(&["not_probed", "alive", "dead", "probe_failed"]),
            "bundleRequest" => Some(&["received", "not_received", "unknown", "probe_failed"]),
            "healthDetail" => Some(HEALTH_DETAILS),
            "hostChild" => Some(&["alive", "exited", "unknown"]),
            "exitSignal" => Some(RUNNER_SIGNALS),
            "appProcess" => Some(&["same", "changed", "absent", "unknown"]),
            _ => None,
        };
        if let Some(words) = words {
            let word = words.iter().find(|&&word| value.as_str() == Some(word))?;
            clean.insert(key.clone(), (*word).into());
        } else if ["settled", "hierarchyChanged", "keyboard", "mutating"].contains(&key.as_str()) {
            clean.insert(key.clone(), value.as_bool()?.into());
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
    path: PathBuf,
    log: PathBuf,
    events: usize,
    outcomes: usize,
}

impl Sink {
    pub(super) fn new(log: &Path) -> Self {
        let path = log.with_file_name("core-diagnostics.jsonl");
        Self {
            file: crate::redact::private_output_mode()
                .then(|| private_file(&path))
                .flatten(),
            path,
            log: log.to_path_buf(),
            events: 0,
            outcomes: 0,
        }
    }

    pub(super) fn accept(&mut self, payload: &Value) {
        let Some(event) = clean(payload) else {
            return;
        };
        if self.file.is_none()
            && matches!(
                event["kind"].as_str(),
                Some("target-miss" | "media-withheld")
            )
        {
            self.file = private_file(&self.path);
        }
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
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(file, "{line}");
            if event["kind"] == "media-withheld" {
                let mut record = event["cause"].clone();
                record["v"] = 1.into();
                record["scope"] = event["scope"].clone();
                record["line"] = event["line"].clone();
                if let Some(mut log) = private_file(&self.log) {
                    let _ = writeln!(log, "media-withheld {record}");
                }
            }
        }
    }
}

fn private_file(path: &Path) -> Option<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).ok()
}
