use crate::candidate::Candidate;
use crate::failure::Failure;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const RECEIPT_SCHEMA: &str = "qaren/1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptResult {
    Ready,
    Working,
    Failed,
    Cleaned,
    Refused,
    Unknown,
    Planned,
    Prewarmed,
    Pass,
    Fail,
    Published,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioIdentity {
    pub name: String,
    pub platform: String,
    pub path: PathBuf,
    pub sha256: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios_udid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios_device_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios_runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm_ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm_slot: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub farm_lease_holder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_adb_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_local_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_identity: Option<crate::runrecord::PidIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_adb_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_serial: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_lock_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usb_lock_holder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetroIdentity {
    pub port: u16,
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pgid: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<crate::runrecord::PidIdentity>,
}

// A passed block the core did not save, with the core's value-free reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockNotSaved {
    pub block: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hint {
    pub code: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub schema: String,
    pub verb: String,
    pub run_id: String,
    pub result: ReceiptResult,
    pub phase: String,
    pub emitted_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scenario: Option<ScenarioIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<DeviceIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metro: Option<MetroIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<crate::buildplan::BuildPlan>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outcomes: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub timings_ms: BTreeMap<String, u64>,
    pub commands_executed: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub artifacts: BTreeMap<String, PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cleanup: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_cleanup: Option<crate::runrecord::CoreCleanupEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh_install: Option<crate::runrecord::FreshInstallEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<crate::runrecord::LaneEvidence>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planned_commands: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ledger: Option<crate::report::LedgerSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight_jev: Option<crate::core::JevRollup>,
    // The PR head moved during a `qaren pr` run; this names the commit that was tested.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tested_older_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks_written: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<Hint>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocks_not_saved: Vec<BlockNotSaved>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktree_drift: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipe: Option<crate::recipes::RecipeOutcome>,
    pub next_action: String,
}

impl Receipt {
    pub fn new(
        verb: &str,
        run_id: &str,
        result: ReceiptResult,
        phase: &str,
        emitted_at: String,
    ) -> Self {
        Receipt {
            schema: RECEIPT_SCHEMA.to_string(),
            verb: verb.to_string(),
            run_id: run_id.to_string(),
            result,
            phase: phase.to_string(),
            emitted_at,
            scenario: None,
            candidate: None,
            device: None,
            metro: None,
            build: None,
            outcomes: BTreeMap::new(),
            timings_ms: BTreeMap::new(),
            commands_executed: 0,
            artifacts: BTreeMap::new(),
            failure: None,
            cleanup: BTreeMap::new(),
            core_cleanup: None,
            fresh_install: None,
            lane: None,
            planned_commands: Vec::new(),
            ledger: None,
            preflight_jev: None,
            tested_older_commit: None,
            blocks_written: Vec::new(),
            hints: Vec::new(),
            blocks_not_saved: Vec::new(),
            worktree_drift: Vec::new(),
            recipe: None,
            next_action: String::new(),
        }
    }

    pub fn to_json(&self) -> String {
        crate::redact::redact_api_key(&crate::redact::durable_json(self).unwrap_or_else(|e| {
            let fallback = serde_json::json!({
                "schema": RECEIPT_SCHEMA,
                "verb": self.verb,
                "run_id": self.run_id,
                "result": "unknown",
                "phase": "emit",
                "emitted_at": self.emitted_at,
                "commands_executed": self.commands_executed,
                "failure": {
                    "phase": "emit",
                    "code": "RUN_RECORD_UPDATE_FAILED",
                    "detail": format!("receipt serialization failed: {e}"),
                    "next_action": "inspect the run directory manually"
                },
                "next_action": "inspect the run directory manually"
            });
            crate::redact::durable_json(&fallback).expect("fallback receipt is plain strings")
        }))
    }
}
