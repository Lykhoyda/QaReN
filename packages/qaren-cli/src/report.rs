use crate::core::{Ledger, Row};
use crate::failure::{Failure, FailureCode};
use crate::record::{VideoPublication, VideoStatus};
use crate::redact::{redact_machine, redact_secrets, MachineIdentity};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

// The rollups every receipt carries, read from the ledger the core child returned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerSummary {
    pub verdict: String,
    pub path: String,
    pub steps: u64,
    pub jev_calls: u64,
    pub jev_median_ms: u64,
    #[serde(default)]
    pub jev_input_tokens: u64,
    pub llm_turns: u64,
    pub escapes: u64,
    pub recoveries: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<u64>,
    // Passing fills whose final value was not verified, with the ledger row's value-free reason.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unverified_fills: Vec<UnverifiedFill>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogs: Vec<DialogEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnverifiedFill {
    pub line: u64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<crate::core::KeptCounts>,
    #[serde(
        default,
        rename = "caseNormalized",
        skip_serializing_if = "Option::is_none"
    )]
    pub case_normalized: Option<crate::core::CaseNormalized>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DialogEvidence {
    pub line: u64,
    pub label: String,
    pub rect: crate::core::DialogRect,
}

pub fn summarize(ledger: &Ledger) -> LedgerSummary {
    LedgerSummary {
        verdict: ledger.verdict.clone(),
        path: ledger.path.clone(),
        steps: ledger.steps.len() as u64,
        jev_calls: ledger.jev.calls,
        jev_median_ms: ledger.jev.median_ms,
        jev_input_tokens: ledger.jev.input_tokens,
        llm_turns: ledger.llm_turns,
        escapes: ledger.escapes,
        recoveries: ledger.recoveries,
        failed_step: ledger.failure.as_ref().map(|f| f.step),
        unverified_fills: ledger
            .steps
            .iter()
            .filter(|row| row.outcome == "pass")
            .filter_map(|row| {
                let reason = row.reason.as_deref()?;
                reason
                    .starts_with("UNVERIFIED_FILL:")
                    .then(|| UnverifiedFill {
                        line: row.line,
                        reason: reason.to_string(),
                        kept: row.kept.clone(),
                        case_normalized: row.case_normalized.clone(),
                        detail: row.fill_detail(),
                    })
            })
            .collect(),
        dialogs: ledger
            .steps
            .iter()
            .filter(|row| row.outcome == "pass")
            .filter_map(|row| {
                row.dialog.as_ref().map(|tap| DialogEvidence {
                    line: row.line,
                    label: tap.label.clone(),
                    rect: tap.rect.clone(),
                })
            })
            .collect(),
    }
}

pub struct ReportInput<'a> {
    pub run_id: &'a str,
    pub platform: &'a str,
    pub app_id: &'a str,
    pub device: &'a str,
    pub ledger: &'a Ledger,
}

// Dynamic prose comes from the child and the app under test: redacted, one line, no Markdown syntax.
pub(crate) fn prose(raw: &str) -> String {
    let flat: String = redact_secrets(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::with_capacity(flat.len());
    for c in flat.chars() {
        if matches!(
            c,
            '[' | ']' | '!' | '#' | '<' | '>' | '*' | '_' | '`' | '~' | '|'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// Terminal output: C0 and C1 controls (escape sequences included) never reach the screen.
pub(crate) fn term_safe(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}'))
        .collect()
}

// Screenshots are run-local relative paths; anything else is not linked.
fn screenshot_link(path: &str) -> Option<String> {
    let p = Path::new(path);
    let plain = !p.is_absolute()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.extension()
            .is_some_and(|e| e == "png" || e == "jpg" || e == "jpeg")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
    (plain && redact_secrets(path) == path).then(|| path.to_string())
}

fn walked<'a>(input: &'a ReportInput<'_>) -> impl Iterator<Item = &'a Row> {
    input.ledger.steps.iter().filter(|row| row.line != 0)
}

fn row_line(row: &Row) -> String {
    row_line_with(row, &prose)
}

// Only the core's projected text is rendered; a row without it (a synthesized ledger) shows its line alone.
fn row_line_with(row: &Row, prose: &dyn Fn(&str) -> String) -> String {
    let text = row
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .map(|text| format!(": {}", prose(text)))
        .unwrap_or_default();
    let mark = if row.outcome == "pass" { "✓" } else { "✗" };
    let retry = if row.attempt > 1 {
        format!(" (attempt {})", row.attempt)
    } else {
        String::new()
    };
    let reason = row
        .reason
        .as_deref()
        .map(|r| format!(" — {}", prose(r)))
        .unwrap_or_default();
    let kept = row
        .fill_detail()
        .map(|detail| format!("; {detail}"))
        .unwrap_or_default();
    format!("- {mark} line {}{text}{retry}{reason}{kept}\n", row.line)
}

pub fn render(input: &ReportInput<'_>) -> String {
    let summary = summarize(input.ledger);
    let mut out = String::new();
    out.push_str(&format!("# QaReN check: {}\n\n", prose(&summary.verdict)));
    out.push_str(&format!(
        "Run `{}` · {} · `{}` · device {}\n\n",
        prose(input.run_id),
        prose(input.platform),
        prose(input.app_id),
        prose(input.device)
    ));
    out.push_str("## What was walked\n\n");
    for row in walked(input) {
        out.push_str(&row_line(row));
        if let Some(shot) = row.screenshot.as_deref().and_then(screenshot_link) {
            out.push_str(&format!("  ![line {}]({shot})\n", row.line));
        }
    }
    if !input.ledger.blocks.is_empty() {
        out.push_str("\n## Blocks\n\n");
        for block in &input.ledger.blocks {
            out.push_str(&format!(
                "- {}: {} ({})\n",
                prose(&block.key),
                prose(&block.outcome),
                prose(&block.source)
            ));
        }
    }
    if let Some(failure) = &input.ledger.failure {
        out.push_str("\n## Failure\n\n");
        out.push_str(&format!(
            "Step {}: {}\n",
            failure.step,
            prose(&failure.seen)
        ));
        if let Some(shot) = failure.screenshot.as_deref().and_then(screenshot_link) {
            out.push_str(&format!("\n![failure]({shot})\n"));
        }
    }
    out.push_str("\n## Run details\n\n");
    out.push_str(&format!(
        "steps {} · jev.calls {} · jev.medianMs {} · jev.inputTokens {} · llmTurns {} · escapes {} · recoveries {} · path {}\n",
        summary.steps,
        summary.jev_calls,
        summary.jev_median_ms,
        summary.jev_input_tokens,
        summary.llm_turns,
        summary.escapes,
        summary.recoveries,
        prose(&summary.path)
    ));
    if let Some(speed) = &input.ledger.speed {
        out.push_str(&format!(
            "stepMedianMs {} · stepP95Ms {} · walkMs {} · steps {} ({} passed, {} failed)\n",
            speed
                .step_median_ms
                .map_or_else(|| "n/a".to_string(), |ms| ms.to_string()),
            speed
                .step_p95_ms
                .map_or_else(|| "n/a".to_string(), |ms| ms.to_string()),
            speed.walk_ms,
            speed.steps,
            speed.passed,
            speed.failed
        ));
    }
    out
}

pub fn write(run_dir: &Path, input: &ReportInput<'_>) -> Result<PathBuf, Failure> {
    let path = run_dir.join("report.md");
    std::fs::write(&path, render(input)).map_err(|e| {
        Failure::new(
            "report",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot write {}: {e}", path.display()),
            "check the run directory permissions",
        )
    })?;
    Ok(path)
}

pub struct PrRun<'a> {
    pub tested_sha: &'a str,
    pub tested_older_commit: bool,
    pub video: &'a VideoStatus,
    pub screenshot: Option<&'a str>,
    pub plan_sha256: &'a str,
    pub video_publication: &'a VideoPublication,
}

// Public text must not carry internal transport vocabulary.
fn public(text: &str) -> String {
    text.replace("cdp_", "")
        .replace("proofReplay", "replay")
        .replace("transport", "connection")
        .replace("xcrun simctl", "simulator tooling")
        .replace("adb -s", "device tooling")
}

// The marker lets a rerun find a comment whose creation outcome was lost.
pub fn comment_marker(run_id: &str) -> String {
    format!("<!-- qaren-run: {} -->", prose(run_id))
}

pub fn failing_screenshot(ledger: &Ledger) -> Option<String> {
    let failure = ledger.failure.as_ref()?;
    failure.screenshot.as_deref().and_then(screenshot_link)
}

pub fn render_pr_comment(
    input: &ReportInput<'_>,
    refusal: Option<&Failure>,
    pr: &PrRun<'_>,
    machine: &MachineIdentity,
) -> String {
    let summary = summarize(input.ledger);
    // Sanitize raw text before Markdown escaping, which would otherwise split `cdp_` or a path.
    let clean = |raw: &str| prose(&public(&redact_machine(raw, machine)));
    let short: String = pr.tested_sha.chars().take(7).collect();
    let mut out = String::new();
    out.push_str(&comment_marker(input.run_id));
    out.push('\n');
    let verdict = match input.ledger.verdict.as_str() {
        "PASS" => "PASS",
        "FAIL" => "FAIL",
        _ => "REFUSED",
    };
    out.push_str(verdict);
    if verdict == "REFUSED" {
        if let Some(failure) = refusal {
            if let Ok(serde_json::Value::String(code)) = serde_json::to_value(&failure.code) {
                out.push_str(&format!(": {}", prose(&code)));
            }
        }
    }
    out.push_str("\n\n");
    out.push_str(&format!(
        "Tested: commit `{}` on {}",
        prose(&short),
        prose(input.platform)
    ));
    if pr.tested_older_commit {
        out.push_str(
            " — this tested an older commit; the pull request moved on while the run was going",
        );
    }
    out.push_str("\n\n");
    if let Some(reason) = pr.video_publication.withholding_reason() {
        out.push_str(&format!("Video withheld: {reason}.\n\n"));
    } else {
        match pr.video {
            VideoStatus::Available => out.push_str("Video of the walk is attached below.\n\n"),
            VideoStatus::TooLarge => {
                out.push_str("Video: the recording was too large to attach.\n\n")
            }
            VideoStatus::Unavailable(reason) => {
                out.push_str(&format!("Video: unavailable ({}).\n\n", clean(reason)))
            }
        }
    }
    out.push_str("**Plan**\n\n");
    for row in walked(input) {
        out.push_str(&row_line_with(row, &clean));
    }
    if let Some(failure) = &input.ledger.failure {
        out.push_str(&format!(
            "\n**Failing step** {}: {}\n",
            failure.step,
            clean(&failure.seen)
        ));
        if let Some(shot) = pr.screenshot {
            out.push_str(&format!("\n![Failing step](./{shot})\n"));
        }
    }
    out.push_str(&format!("\nPlan sha256 `{}`\n\n", prose(pr.plan_sha256)));
    out.push_str("<details><summary>Run details</summary>\n\n");
    out.push_str(&format!(
        "steps {} · jev.calls {} · jev.medianMs {} · llmTurns {} · escapes {} · recoveries {} · path {}\n",
        summary.steps,
        summary.jev_calls,
        summary.jev_median_ms,
        summary.llm_turns,
        summary.escapes,
        summary.recoveries,
        clean(&summary.path)
    ));
    out.push_str("\n</details>\n");
    redact_machine(&public(&redact_machine(&out, machine)), machine)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_counts_passing_unverified_fills() {
        let row = |line: u64, outcome: &str, reason: Option<&str>| {
            serde_json::json!({
                "block": "b", "line": line, "attempt": 1, "kind": "step",
                "resolvedBy": "exact", "t": 0, "outcome": outcome, "reason": reason,
            })
        };
        let ledger: Ledger = serde_json::from_value(serde_json::json!({
            "verdict": "PASS", "path": "walk", "blocks": [],
            "steps": [
                row(3, "pass", Some("UNVERIFIED_FILL: typed with the keyboard; the field kept 6 of 8 characters on 2 attempts")),
                row(4, "pass", None),
                row(5, "retry", Some("UNVERIFIED_FILL: retried")),
                row(6, "pass", Some("UNVERIFIED_FILL: the field's final value could not be read back, so the fill was not verified")),
            ],
            "jev": { "calls": 0, "medianMs": 0 },
            "llmTurns": 0, "escapes": 0, "recoveries": 0,
        }))
        .unwrap();
        let summary = summarize(&ledger);
        let lines: Vec<(u64, &str)> = summary
            .unverified_fills
            .iter()
            .map(|fill| (fill.line, fill.reason.as_str()))
            .collect();
        assert_eq!(
            lines,
            [
                (3, "UNVERIFIED_FILL: typed with the keyboard; the field kept 6 of 8 characters on 2 attempts"),
                (6, "UNVERIFIED_FILL: the field's final value could not be read back, so the fill was not verified"),
            ]
        );
        let clean: Ledger = serde_json::from_value(serde_json::json!({
            "verdict": "PASS", "path": "walk", "blocks": [], "steps": [row(1, "pass", None)],
            "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 0,
        }))
        .unwrap();
        let json = serde_json::to_value(summarize(&clean)).unwrap();
        assert!(json.get("unverified_fills").is_none());
    }

    #[test]
    fn kept_counts_survive_a_masked_reason_in_the_receipt_and_report() {
        let reason = "UNVERIFIED_FILL: typed with the keyboard; the field kept the same shorter value on every attempt";
        let ledger: Ledger = serde_json::from_value(serde_json::json!({
            "verdict": "PASS", "path": "walk", "blocks": [],
            "steps": [{
                "block": "b", "line": 9, "attempt": 1, "kind": "step", "resolvedBy": "exact",
                "t": 0, "outcome": "pass", "text": "Fill \"phone\" with \"•••\"", "reason": reason,
                "kept": { "typed": 13, "observed": [10, 10] },
            }],
            "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 0,
        }))
        .unwrap();
        let fill = &summarize(&ledger).unverified_fills[0];
        assert_eq!(fill.reason, reason);
        assert_eq!(
            fill.kept,
            Some(crate::core::KeptCounts {
                typed: 13,
                observed: vec![10, 10]
            })
        );
        assert_eq!(
            fill.detail.as_deref(),
            Some("field kept 10 of 13 chars on 2 attempts")
        );
        let line = row_line(&ledger.steps[0]);
        assert!(
            line.ends_with("; field kept 10 of 13 chars on 2 attempts\n"),
            "{line}"
        );
    }

    #[test]
    fn case_normalized_count_reaches_the_receipt_and_report() {
        let reason =
            "UNVERIFIED_FILL: the field changed only the letter case, so the fill was not verified";
        let ledger: Ledger = serde_json::from_value(serde_json::json!({
            "verdict": "PASS", "path": "walk", "blocks": [],
            "steps": [{
                "block": "b", "line": 4, "attempt": 1, "kind": "step", "resolvedBy": "exact",
                "t": 0, "outcome": "pass", "reason": reason,
                "caseNormalized": { "chars": 12 },
            }],
            "jev": { "calls": 0, "medianMs": 0 }, "llmTurns": 0, "escapes": 0, "recoveries": 0,
        }))
        .unwrap();
        let fill = &summarize(&ledger).unverified_fills[0];
        assert_eq!(
            fill.detail.as_deref(),
            Some("field case-normalized 12 chars")
        );
        let json = serde_json::to_value(fill).unwrap();
        assert_eq!(json["caseNormalized"]["chars"], 12);
        assert!(row_line(&ledger.steps[0]).ends_with("; field case-normalized 12 chars\n"));
    }
}
