use crate::candidate::Candidate;
use crate::failure::{Failure, FailureCode};
use crate::receipt::DeviceIdentity;
use crate::redact::OutputText;
use crate::runrecord::RunRecord;
use crate::timefmt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const HANDOFF_SCHEMA: &str = "qaren-handoff/1";

// The exact identity a managed-build receipt must carry to be adoptable.
// worktree_key/app_root_key reproduce the qaren session's source
// digests (sha256 over NUL-terminated parts), so a receipt minted by a
// session bound to any other worktree or app root refuses as foreign.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedReceipt {
    pub platform: String,
    pub device_id: String,
    pub app_id: String,
    pub worktree_key: String,
    pub app_root_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffDocument {
    pub schema: String,
    pub run_id: String,
    pub issued_at: String,
    pub candidate: Candidate,
    pub platform: String,
    pub device: DeviceIdentity,
    // The candidate's native fingerprint as issued — computed before the
    // session applies its integration, so it names the candidate inputs, not
    // the built tree.
    pub native_fingerprint: String,
    pub fingerprint_complete: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fingerprint_incompleteness: Vec<OutputText>,
    pub expected_receipt: ExpectedReceipt,
}

// Signer material (sessionId, signature, sourceKey, devClientUrl) is read
// from the evidence but never carried here, so it can never be persisted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcceptedReceipt {
    pub platform: String,
    pub device_id: String,
    pub app_id: String,
    pub metro_port: u16,
    pub artifact_digest: String,
    pub install_generation: String,
    pub build_generation: u64,
    pub build_kind: String,
    pub worktree_key: String,
    pub app_root_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffState {
    // sha256 of the issued document bytes: status proves the file on disk is
    // byte-identical to what this run issued, not merely shaped like it.
    pub document_sha256: String,
    pub expected: ExpectedReceipt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted: Option<AcceptedReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    // Only the hash of the evidence bytes is persisted — the operator-chosen
    // path could itself carry sensitive components.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence_sha256: Option<String>,
}

pub fn document_path(runs_root: &Path, run_id: &str) -> PathBuf {
    crate::runrecord::RunRecord::run_dir(runs_root, run_id).join("handoff.json")
}

pub fn verify_validity_window(
    record: &RunRecord,
    document: &HandoffDocument,
    observed_at_ms: u64,
    phase: &str,
) -> Result<(), Failure> {
    let invalid = |detail: String| {
        Failure::new(
            phase,
            FailureCode::RunRecordInvalid,
            detail,
            format!(
                "qaren cleanup {} --json, then re-run prepare",
                record.run_id
            ),
        )
    };
    let issued_at_ms = timefmt::parse_iso8601_utc(&document.issued_at).ok_or_else(|| {
        invalid(format!(
            "issued handoff timestamp {:?} is not valid UTC",
            document.issued_at
        ))
    })?;
    let window_seconds = record.scenario.deadlines.build_seconds;
    let deadline_ms = issued_at_ms
        .checked_add(
            window_seconds
                .checked_mul(1000)
                .ok_or_else(|| invalid("handoff build deadline overflows".to_string()))?,
        )
        .ok_or_else(|| invalid("handoff build deadline overflows".to_string()))?;
    if observed_at_ms < issued_at_ms {
        return Err(Failure::new(
            phase,
            FailureCode::ReadyDeadlineExceeded,
            format!(
                "{phase} observed the handoff at {} before its issued_at {}; the wall-clock validity window cannot be proven",
                timefmt::iso8601_utc(observed_at_ms),
                document.issued_at
            ),
            format!(
                "qaren cleanup {} --json, then re-run prepare to issue a fresh handoff",
                record.run_id
            ),
        ));
    }
    if observed_at_ms > deadline_ms {
        return Err(Failure::new(
            phase,
            FailureCode::ReadyDeadlineExceeded,
            format!(
                "handoff issued at {} expired at {} after its single {}s build window; {phase} observed it at {} ({}ms late), and retries do not reset the deadline",
                document.issued_at,
                timefmt::iso8601_utc(deadline_ms),
                window_seconds,
                timefmt::iso8601_utc(observed_at_ms),
                observed_at_ms - deadline_ms
            ),
            format!(
                "qaren cleanup {} --json, then re-run prepare to issue a fresh handoff",
                record.run_id
            ),
        ));
    }
    Ok(())
}

fn digest(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    format!("{:x}", hasher.finalize())
}

// A canonicalization failure falls back to the raw path, which can only make
// the derived key MISMATCH the plugin's realpath-based digest — a refusal at
// complete time, never a false acceptance.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn worktree_key(repo_root: &Path) -> String {
    digest(&["git-worktree", &canonical(repo_root).to_string_lossy()])
}

// Fails closed on a project root outside the worktree: aliasing it to "."
// would mint the worktree-root app's key for a foreign path.
pub fn app_root_key(repo_root: &Path, project_root: &Path) -> Option<String> {
    let repo = canonical(repo_root);
    let project = canonical(project_root);
    let rel = project
        .strip_prefix(&repo)
        .ok()?
        .to_string_lossy()
        .into_owned();
    let rel = if rel.is_empty() { ".".to_string() } else { rel };
    Some(digest(&["git-app", &rel]))
}

// Writes the document atomically and returns the sha256 of its bytes.
pub fn save_document(path: &Path, document: &HandoffDocument) -> std::io::Result<String> {
    let body = serde_json::to_string_pretty(document)
        .map_err(|e| std::io::Error::other(format!("serialize handoff: {e}")))?
        .into_bytes();
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    std::fs::write(&tmp, &body)?;
    std::fs::rename(&tmp, path)?;
    Ok(crate::candidate::sha256_hex(&body))
}

// The managed build prints its signed receipt as one JSON line on stdout;
// evidence is either that line alone or a build log containing it (a log
// wrapper may prefix the line, so parsing starts at each line's first `{`).
// Extraction is refusal-first: no receipt line refuses as missing, and
// conflicting envelopes — different payloads, or one payload carrying two
// different signatures — refuse as ambiguous.
pub fn extract_receipt_payload(evidence: &str) -> Result<Value, (FailureCode, String)> {
    let mut envelope: Option<(Value, String)> = None;
    for line in evidence.lines() {
        let Some(start) = line.find('{') else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line[start..]) else {
            continue;
        };
        let (Some(version), Some(payload), Some(signature)) = (
            value.get("version"),
            value.get("payload").filter(|p| p.is_object()),
            value
                .get("signature")
                .and_then(Value::as_str)
                .filter(|signature| !signature.is_empty()),
        ) else {
            continue;
        };
        if version != &Value::from(1) {
            return Err((
                FailureCode::HandoffEvidenceMismatch,
                format!("build receipt version {version} is not 1"),
            ));
        }
        let candidate = (payload.clone(), signature.to_string());
        match &envelope {
            None => envelope = Some(candidate),
            Some(existing) if existing == &candidate => {}
            Some(_) => {
                return Err((
                    FailureCode::HandoffEvidenceAmbiguous,
                    "the evidence contains conflicting managed-build receipt envelopes; pass the log of exactly one build".to_string(),
                ));
            }
        }
    }
    match envelope {
        None => Err((
            FailureCode::HandoffEvidenceMissing,
            "the evidence contains no managed-build receipt line ({\"version\":1,\"payload\":{...},\"signature\":...})".to_string(),
        )),
        Some((payload, _)) => Ok(payload),
    }
}

// Trust boundary: the receipt's HMAC signature is keyed by the session's
// private signer capability, which never leaves the qaren session —
// only the session itself verifies it (rn_session refuses a forged or foreign
// receipt at bind time, and its install-identity gate refuses gated tools
// when the installed artifact stops matching). qaren's acceptance binds the
// attested identity fields to this run's identity; it is a recording step,
// not an independent cryptographic proof.
pub fn validate_receipt_payload(
    payload: &Value,
    expected: &ExpectedReceipt,
) -> Result<AcceptedReceipt, (FailureCode, String)> {
    let field_str = |name: &str| -> Result<String, (FailureCode, String)> {
        payload
            .get(name)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                (
                    FailureCode::HandoffEvidenceMissing,
                    format!("build receipt payload lacks a non-empty string field {name:?}"),
                )
            })
    };
    let field_u64 = |name: &str| -> Result<u64, (FailureCode, String)> {
        payload.get(name).and_then(Value::as_u64).ok_or_else(|| {
            (
                FailureCode::HandoffEvidenceMissing,
                format!("build receipt payload lacks numeric field {name:?}"),
            )
        })
    };
    field_str("sessionId")?;
    field_str("sourceKey")?;
    let accepted = AcceptedReceipt {
        platform: field_str("platform")?,
        device_id: field_str("deviceId")?,
        app_id: field_str("appId")?,
        metro_port: u16::try_from(field_u64("metroPort")?)
            .ok()
            .filter(|port| *port >= 1)
            .ok_or_else(|| {
                (
                    FailureCode::HandoffEvidenceMissing,
                    "build receipt metroPort is not a valid port".to_string(),
                )
            })?,
        artifact_digest: field_str("artifactDigest")?,
        install_generation: field_str("installGeneration")?,
        build_generation: field_u64("buildGeneration")?,
        build_kind: field_str("buildKind")?,
        worktree_key: field_str("worktreeKey")?,
        app_root_key: field_str("appRootKey")?,
    };
    let mismatch = |what: &str, got: &str, want: &str| {
        (
            FailureCode::HandoffEvidenceMismatch,
            format!("build receipt {what} {got:?} does not match the handoff's expected {want:?}"),
        )
    };
    if accepted.platform != expected.platform {
        return Err(mismatch("platform", &accepted.platform, &expected.platform));
    }
    if accepted.device_id != expected.device_id {
        return Err(mismatch(
            "deviceId",
            &accepted.device_id,
            &expected.device_id,
        ));
    }
    if accepted.app_id != expected.app_id {
        return Err(mismatch("appId", &accepted.app_id, &expected.app_id));
    }
    if accepted.worktree_key != expected.worktree_key {
        return Err((
            FailureCode::HandoffEvidenceMismatch,
            "build receipt worktreeKey does not match this candidate worktree; the receipt was minted by a session bound to a different worktree".to_string(),
        ));
    }
    if accepted.app_root_key != expected.app_root_key {
        return Err((
            FailureCode::HandoffEvidenceMismatch,
            "build receipt appRootKey does not match the candidate project root; the receipt was minted for a different app root".to_string(),
        ));
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digests_match_the_plugin_derivation() {
        // sha256("git-app" \0 "." \0) — the plugin's appRootKey for a project
        // at the worktree root.
        let key = digest(&["git-app", "."]);
        let mut hasher = Sha256::new();
        hasher.update(b"git-app\0.\0");
        assert_eq!(key, format!("{:x}", hasher.finalize()));
    }

    #[test]
    fn extraction_refuses_missing_and_ambiguous() {
        assert_eq!(
            extract_receipt_payload("no receipts here\n{\"not\":\"a receipt\"}\n")
                .unwrap_err()
                .0,
            FailureCode::HandoffEvidenceMissing
        );
        let two = concat!(
            "{\"version\":1,\"payload\":{\"deviceId\":\"a\"},\"signature\":\"x\"}\n",
            "{\"version\":1,\"payload\":{\"deviceId\":\"b\"},\"signature\":\"x\"}\n",
        );
        assert_eq!(
            extract_receipt_payload(two).unwrap_err().0,
            FailureCode::HandoffEvidenceAmbiguous
        );
        // One payload carrying two different signatures: at most one can be
        // genuine, so the envelope conflict refuses.
        let conflicting_signatures = concat!(
            "{\"version\":1,\"payload\":{\"deviceId\":\"a\"},\"signature\":\"x\"}\n",
            "log noise\n",
            "{\"version\":1,\"payload\":{\"deviceId\":\"a\"},\"signature\":\"y\"}\n",
        );
        assert_eq!(
            extract_receipt_payload(conflicting_signatures)
                .unwrap_err()
                .0,
            FailureCode::HandoffEvidenceAmbiguous
        );
        // The same envelope printed twice (and a log-wrapper prefix) is fine.
        let repeated = concat!(
            "2026-08-30T10:00:00Z {\"version\":1,\"payload\":{\"deviceId\":\"a\"},\"signature\":\"x\"}\n",
            "{\"version\":1,\"payload\":{\"deviceId\":\"a\"},\"signature\":\"x\"}\n",
        );
        assert!(extract_receipt_payload(repeated).is_ok());
    }
}
