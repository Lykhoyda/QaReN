use crate::exec::{CmdOutput, CmdSpec, DeadlineRunner, Runner};
use crate::failure::{Failure, FailureCode};
use crate::redact::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

mod diagnostics;

pub const WIRE_VERSION: u64 = 1;
const MAX_ROWS: usize = 10_000;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const INBOX_DEPTH: usize = 1_024;
const POST_KILL_GRACE_MS: u64 = 5_000;
// Time for a cancelled core to close its device session before the group is killed.
const CANCEL_GRACE_MS: u64 = 10_000;

// The request payload the core child reads as its first stdin line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRequest {
    pub run_id: String,
    pub t0: u64,
    pub walk_budget_ms: u64,
    pub attach_budget_ms: u64,
    pub plan: String,
    pub prepared: Value,
    pub preflight_calls: Vec<JevCall>,
    pub platform: String,
    pub app_id: String,
    pub app_root: PathBuf,
    pub run_dir: PathBuf,
    pub lease: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_block: Option<String>,
    pub video_policy: crate::record::VideoPolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_marker: Option<crate::config::LoginMarker>,
    pub target: CoreTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreTarget {
    pub device_id: String,
    pub device_name: String,
    pub metro_port: u16,
    pub metro_url_for_device: String,
    pub worktree: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metro_bundle_requests: Option<MetroBundleRequests>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_warm: Option<ManifestWarm>,
    // The CLI pinned this lane; the core must observe the app's first screen before row 1.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub warm_lane: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestWarm {
    pub ms: u64,
    pub attempts: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetroBundleRequests {
    pub path: PathBuf,
    pub at_launch: u64,
}

// The borrowed emulator the core's adb calls are pinned to.
pub struct AndroidEnv {
    pub serial: String,
    pub server_port: u16,
    pub platform_tools: PathBuf,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WithholdCause {
    RuntimeInput,
    ConcealedFill,
    SecureField,
    InputValue,
    GenericValue,
    CodeRow,
    Echo,
}

impl WithholdCause {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RuntimeInput => "runtime-input",
            Self::ConcealedFill => "concealed-fill",
            Self::SecureField => "secure-field",
            Self::InputValue => "input-value",
            Self::GenericValue => "generic-value",
            Self::CodeRow => "code-row",
            Self::Echo => "echo",
        }
    }

    pub fn sentence(self) -> &'static str {
        match self {
            Self::RuntimeInput => "the run holds runtime inputs",
            Self::ConcealedFill => "a filled field could not be read back",
            Self::SecureField => "a secure field was on screen",
            Self::InputValue => "an editable field showed text",
            Self::GenericValue => "a non-input element exposes an accessibility value",
            Self::CodeRow => "one-character boxes showed a typed value",
            Self::Echo => "a value already treated as private reappeared as text",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Input,
    Other,
    Text,
    Button,
    Cell,
    Image,
    Switch,
    Link,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaSource {
    Typed,
    Observed,
    Concealed,
    Secret,
    Code,
    Input,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaLatch {
    pub reason: WithholdCause,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<MediaKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<MediaSource>,
    pub line: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
}

impl MediaLatch {
    pub(crate) fn from_receipt_note(note: &str) -> Option<Self> {
        let (cause, line) = note.split_once("@line ")?;
        let (reason, qualifier) = cause
            .split_once('/')
            .map_or((cause, None), |(r, q)| (r, Some(q)));
        let reason: WithholdCause = serde_json::from_value(Value::String(reason.into())).ok()?;
        let mut entry = Self {
            reason,
            kind: None,
            source: None,
            line: line.parse().ok()?,
            count: None,
        };
        if let Some(qualifier) = qualifier {
            let value = Value::String(qualifier.into());
            match reason {
                WithholdCause::GenericValue => {
                    entry.kind = Some(serde_json::from_value(value).ok()?)
                }
                WithholdCause::Echo => entry.source = Some(serde_json::from_value(value).ok()?),
                _ => return None,
            }
        }
        (entry.receipt_note() == note).then_some(entry)
    }

    pub fn receipt_note(&self) -> String {
        let qualifier = self
            .kind
            .and_then(|kind| serde_json::to_value(kind).ok())
            .or_else(|| {
                self.source
                    .and_then(|source| serde_json::to_value(source).ok())
            });
        let qualifier = qualifier
            .as_ref()
            .and_then(Value::as_str)
            .map(|word| format!("/{word}"))
            .unwrap_or_default();
        format!("{}{qualifier}@line {}", self.reason.as_str(), self.line)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaWithheld {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshots: Option<MediaLatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<MediaLatch>,
}

// The ledger the child returns as its result line; the wire is a contract, so it is read strictly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub press_evidence: Option<PressEvidence>,
    pub verdict: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub video_publication: Option<crate::record::VideoPublication>,
    #[serde(default)]
    pub video_policy: crate::record::VideoPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_policy_source: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub non_strict_publication: Option<crate::record::NonStrictPublication>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub media_withheld: Option<MediaWithheld>,
    // Epoch ms at which the walk proved the app's bundle and cleared its dev overlays; earlier recorded frames are never published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_at_ms: Option<u64>,
    // Epoch ms after a pre-plan login replay; the uploaded copy starts here instead of admission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publish_from_ms: Option<u64>,
    #[serde(default)]
    pub publication_interrupted: bool,
    pub path: String,
    pub blocks: Vec<BlockResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks_written: Option<Vec<String>>,
    pub steps: Vec<Row>,
    pub jev: JevRollup,
    pub llm_turns: u64,
    pub escapes: u64,
    pub recoveries: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub speed: Option<LedgerSpeed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<LedgerFailure>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub recipe: Option<crate::recipes::RecipeCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PressEvidence {
    pub subreason: PressSubreason,
    pub held_press: HeldPress,
    pub outside_target_change: bool,
    pub captures: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PressSubreason {
    SelectionUnverified,
    TargetIdentityUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum HeldPress {
    NotTriedUnsafe,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockResult {
    pub key: String,
    pub outcome: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsavable: Option<String>,
}

// The identity a passed step used, stored in the block's action file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Selector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

pub fn valid_ledger_path(path: &str) -> bool {
    path == "walk"
        || path == "replay"
        || path.strip_prefix("replay→walk@").is_some_and(|line| {
            !line.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) && !line.starts_with('0')
        })
}

fn valid_blocks(blocks: &[BlockResult]) -> bool {
    blocks.iter().all(|block| {
        matches!(block.outcome.as_str(), "pass" | "fail")
            && matches!(block.source.as_str(), "discovered" | "replayed" | "patched")
            && block.saved != Some(true)
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevRollup {
    pub calls: u64,
    pub median_ms: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub call_details: Vec<JevCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevCall {
    pub question_ids: Vec<String>,
    pub scope: String,
    pub input_tokens: Option<u64>,
    pub ms: u64,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<JevDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case", try_from = "String")]
pub enum JevDiagnostic {
    RetryAfterOutsideWindow,
}

impl TryFrom<String> for JevDiagnostic {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "retry-after-outside-window" => Ok(Self::RetryAfterOutsideWindow),
            _ => Err("invalid Jev diagnostic"),
        }
    }
}

// The value-free announcement that a plan line begins; its row later carries the same operation id.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepStart {
    pub operation_id: u64,
    pub line: u64,
    pub kind: String,
    pub t: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub block: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub operation_id: u64,
    pub line: u64,
    pub attempt: u64,
    pub kind: String,
    pub resolved_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub screenshot_withheld: Option<WithholdCause>,
    pub t: u64,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unverified_press: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub react_coverage: Option<ReactCoverage>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub react_connections: Vec<ReactConnectionEvent>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub timing: Option<RowTiming>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<KeptCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_normalized: Option<CaseNormalized>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub entry_mismatch: Option<EntryMismatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog: Option<DialogTap>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub method: Option<FillMethod>,
}

// The Fill ladder rung a fill row used.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FillMethod {
    Keyboard,
    ClearType,
    SetHandler,
}

impl FillMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            FillMethod::Keyboard => "keyboard",
            FillMethod::ClearType => "clear-type",
            FillMethod::SetHandler => "set-handler",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ReactCoverage {
    Unknown,
    Incomplete,
    Reconnected,
    Lost,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ReactConnectionEvent {
    Lost,
    Reconnected,
}

impl ReactCoverage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Incomplete => "incomplete",
            Self::Reconnected => "reconnected",
            Self::Lost => "lost",
        }
    }
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

// Characters typed into a field that changed only their letter case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaseNormalized {
    pub chars: u64,
}

// How a refused private fill differed from the requested text, as counts only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryMismatch {
    pub len: u64,
    pub exp: u64,
    pub prefix: u64,
    pub suffix: u64,
    pub case_eq: bool,
}

impl EntryMismatch {
    pub fn detail(&self) -> String {
        format!(
            "field held {} of {} chars, first {} and last {} matching{}",
            self.len,
            self.exp,
            self.prefix,
            self.suffix,
            if self.case_eq {
                ", letter case only"
            } else {
                ""
            }
        )
    }
}

impl Row {
    // The value-free count line for an unverified fill, rendered from numbers the masking never saw.
    pub fn fill_detail(&self) -> Option<String> {
        self.kept
            .as_ref()
            .and_then(KeptCounts::detail)
            .or_else(|| {
                self.case_normalized
                    .as_ref()
                    .map(|n| format!("field case-normalized {} chars", n.chars))
            })
            .or_else(|| self.entry_mismatch.as_ref().map(EntryMismatch::detail))
    }
}

// Character counts of an unverified fill, carried as numbers because masking may hide digits in the reason.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeptCounts {
    pub typed: u64,
    pub observed: Vec<u64>,
}

impl KeptCounts {
    pub fn detail(&self) -> Option<String> {
        let first = *self.observed.first()?;
        let held = if self.observed.iter().all(|&n| n == first) {
            first.to_string()
        } else {
            let all: Vec<String> = self.observed.iter().map(u64::to_string).collect();
            all.join(" and ")
        };
        Some(format!(
            "field kept {held} of {} chars on {} attempts",
            self.typed,
            self.observed.len()
        ))
    }
}

// The system dialog button the runner proved it tapped; labels are system UI text, never input values.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DialogTap {
    pub label: String,
    pub rect: DialogRect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DialogRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Row {
    fn redact_evidence(&mut self) {
        if let Some(selector) = &mut self.selector {
            for text in [&mut selector.id, &mut selector.text].into_iter().flatten() {
                *text = redact_secrets(text);
            }
        }
        for text in [&mut self.text, &mut self.reason].into_iter().flatten() {
            *text = redact_secrets(text);
        }
    }
}

impl Ledger {
    fn redact_evidence(&mut self) {
        for row in &mut self.steps {
            row.redact_evidence();
        }
        for block in &mut self.blocks {
            if let Some(text) = &mut block.unsavable {
                *text = redact_secrets(text);
            }
        }
        if let Some(failure) = &mut self.failure {
            failure.seen = redact_secrets(&failure.seen);
        }
    }
}

// Timing is diagnostics only: a malformed value is dropped, never a reason to reject the row or ledger.
fn passive<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(serde_json::from_value(Value::deserialize(deserializer)?).ok())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RowTiming {
    pub capture_ms: u64,
    pub native_ms: u64,
    pub react_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence_ms: Option<u64>,
    pub resolve_ms: u64,
    pub jev_ms: u64,
    pub act_ms: u64,
    pub post_capture_ms: u64,
    pub other_ms: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSpeed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_median_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_p95_ms: Option<u64>,
    pub walk_ms: u64,
    #[serde(default)]
    pub steps: u64,
    #[serde(default)]
    pub passed: u64,
    #[serde(default)]
    pub failed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerFailure {
    pub step: u64,
    pub seen: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub kind: Option<FailureKind>,
}

// Only a plan step's own judgment is a step failure; anything else, or an older core, has no kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    Step,
}

#[derive(Debug, Clone, Copy)]
pub struct Budgets {
    pub walk_seconds: u64,
    pub step_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Refused { code: String, message: String },
}

#[derive(Debug, Clone)]
pub struct CoreOutcome {
    pub pid: i32,
    pub ledger: Ledger,
    pub verdict: Verdict,
    pub exit: Option<i32>,
    // Set when the ledger was synthesized: no result line, a contract violation, or a deadline kill.
    pub failure: Option<Failure>,
    // Exit/pipe grace expired; false is not proof that the process group is gone.
    pub group_survived: bool,
    // The child sent its admitted envelope: the bundle, dev overlays and any warm-lane first screen were proven.
    pub admitted: bool,
}

pub fn spawn_spec(
    node: &Path,
    runtime_dir: &Path,
    worktree: &Path,
    lease: &str,
    metro_port: u16,
    android: Option<&AndroidEnv>,
) -> CmdSpec {
    let spec = CmdSpec::new(
        "core-walk",
        &node.to_string_lossy(),
        &[&runtime_dir.join("qa").join("walk.js").to_string_lossy()],
        0,
    )
    .cwd(worktree)
    .env("QAREN_DEVICE_LEASE", lease)
    .env("QAREN_METRO_PORT", &metro_port.to_string());
    match android {
        Some(android) => with_android_env(spec, android),
        None => spec,
    }
}

// A core child's adb reaches only the run's server and the borrowed emulator.
fn with_android_env(spec: CmdSpec, android: &AndroidEnv) -> CmdSpec {
    let mut path = std::ffi::OsString::from(&android.platform_tools);
    if let Some(inherited) = std::env::var_os("PATH").filter(|p| !p.is_empty()) {
        path.push(":");
        path.push(inherited);
    }
    spec.env("ANDROID_SERIAL", &android.serial)
        .env(
            "ADB_SERVER_SOCKET",
            &crate::adapters::android::server_socket(android.server_port),
        )
        .env("PATH", &path.to_string_lossy())
}

pub fn preflight_spec(node: &Path, runtime_dir: &Path, plan_file: &Path) -> CmdSpec {
    CmdSpec::new(
        "plan-preflight",
        &node.to_string_lossy(),
        &[
            &runtime_dir.join("qa").join("walk.js").to_string_lossy(),
            "--preflight",
            &plan_file.to_string_lossy(),
        ],
        320,
    )
}

#[derive(PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum AdmissionProbeReason {
    InvalidDevice,
    ScanFailed,
    ScanTimeout,
    ScanOutputOversize,
    ScanUnavailable,
    ScanIncomplete,
    ScanStderr,
    ScanOversize,
    ScanCorrupt,
    ScanRowInvalid,
    ScanPidInvalid,
    CandidateBudgetExceeded,
    DeadlineExceeded,
    DriverOnSelectedDevice,
    ObserverUnavailable,
    ObserverFailed,
    ObserverTimeout,
    ObserverStderr,
    ObserverOutputOversize,
    ObserverInvalidJson,
    DriverIdentityUnproven,
    ExecutableIdentityUnproven,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct AdmissionProbeEvidence {
    reason: AdmissionProbeReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidates: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdmissionSummary {
    probe: String,
    initial_reason: String,
    terminal_reason: String,
    attempts: u8,
    elapsed_ms: u64,
    deadline_exceeded: bool,
}

impl AdmissionSummary {
    pub fn note(&self) -> String {
        serde_json::to_string(self).expect("admission summary is serializable")
    }

    pub(crate) fn from_note(note: &str) -> Option<Self> {
        let summary: Self = serde_json::from_str(note).ok()?;
        let closed_reason = |reason: &str| {
            [
                "not_started",
                "clear",
                "cancelled",
                "unavailable",
                "invalid_evidence",
                "envelope_mismatch",
                "invalid_response",
                "invalid_status",
                "clear_exit_mismatch",
            ]
            .contains(&reason)
                || serde_json::from_value::<AdmissionProbeReason>(json!(reason)).is_ok()
        };
        (summary.probe == "fresh-install-admission"
            && summary.attempts <= 2
            && closed_reason(&summary.initial_reason)
            && closed_reason(&summary.terminal_reason))
        .then_some(summary)
    }

    fn refusal(&self, mut failure: Failure) -> Failure {
        failure
            .evidence
            .push(crate::redact::OutputText::from_admission(self));
        failure
    }
}

// None admits an iOS simulator; Some scans the borrowed emulator through the run's adb server.
pub fn fresh_install_admission(
    runner: &mut dyn Runner,
    node: &Path,
    runtime_dir: &Path,
    worktree: &Path,
    device_id: &str,
    android: Option<&AndroidEnv>,
    caller_deadline_ms: Option<u64>,
) -> Result<AdmissionSummary, Failure> {
    let started = runner.monotonic_ms();
    let deadline_ms = caller_deadline_ms
        .unwrap_or(u64::MAX)
        .min(started.saturating_add(30_000));
    let mut summary = AdmissionSummary {
        probe: "fresh-install-admission".into(),
        initial_reason: "not_started".into(),
        terminal_reason: "not_started".into(),
        attempts: 0,
        elapsed_ms: 0,
        deadline_exceeded: false,
    };
    let script = runtime_dir
        .join("qa/fresh-install-preflight.js")
        .to_string_lossy()
        .into_owned();
    let platform = if android.is_some() { "android" } else { "ios" };
    // Android's scan is adb's process table; only the iOS scan needs the native observer.
    let observer = match android {
        Some(_) => None,
        None => Some(
            std::env::current_exe()
                .ok()
                .filter(|path| path.is_absolute())
                .and_then(|path| path.into_os_string().into_string().ok())
                .ok_or_else(|| {
                    summary.terminal_reason = "observer_unavailable".into();
                    summary.refusal(
                        Failure::new(
                            "fresh_install",
                            FailureCode::FreshInstallAdmissionUnknown,
                            "native process observer is unavailable",
                            "ensure the qaren executable is available and re-run",
                        )
                        .with_recovery(crate::failure::RecoveryReason::IdentityUnavailable),
                    )
                })?,
        ),
    };
    let mut args = vec![
        script.as_str(),
        "--platform",
        platform,
        "--device",
        device_id,
    ];
    if let Some(observer) = &observer {
        args.extend(["--process-observer", observer.as_str()]);
    }
    let spec = CmdSpec::new(
        "fresh-install-admission",
        &node.to_string_lossy(),
        &args,
        30,
    )
    .cwd(worktree);
    let spec = match android {
        Some(android) => with_android_env(spec, android),
        None => spec,
    };
    loop {
        let now = runner.monotonic_ms();
        summary.elapsed_ms = now.saturating_sub(started);
        summary.deadline_exceeded = now >= deadline_ms;
        if let Some(reason) = runner.cancellation() {
            summary.terminal_reason = "cancelled".into();
            return Err(summary.refusal(
                Failure::cancelled("fresh_install", &reason)
                    .with_recovery(crate::failure::RecoveryReason::RunCancelled),
            ));
        }
        let dispatched = !summary.deadline_exceeded;
        let output = if !dispatched {
            CmdOutput::default()
        } else {
            summary.attempts += 1;
            DeadlineRunner {
                inner: runner,
                deadline_ms,
            }
            .run(&spec)
        };
        let now = runner.monotonic_ms();
        summary.elapsed_ms = now.saturating_sub(started);
        summary.deadline_exceeded = now >= deadline_ms;
        if let Some(reason) = runner.cancellation() {
            summary.terminal_reason = "cancelled".into();
            return Err(summary.refusal(
                Failure::cancelled("fresh_install", &reason)
                    .with_recovery(crate::failure::RecoveryReason::RunCancelled),
            ));
        }
        let value = serde_json::from_str::<Value>(&output.stdout).ok();
        let matched = value.as_ref().filter(|v| {
            v.get("v").and_then(Value::as_u64) == Some(1)
                && v.get("platform").and_then(Value::as_str) == Some(platform)
                && v.get("deviceId").and_then(Value::as_str) == Some(device_id)
        });
        let status = matched
            .and_then(|v| v.get("status"))
            .and_then(Value::as_str);
        let validated = matched
            .and_then(|v| v.get("evidence"))
            .and_then(|v| serde_json::from_value::<AdmissionProbeEvidence>(v.clone()).ok())
            .filter(|e| e.pid != Some(0) && e.candidates.is_none_or(|n| n <= 1_048_576));
        let evidence = match matched.and_then(|v| v.get("evidence")) {
            _ if !dispatched => "not_run".into(),
            Some(_) => validated
                .as_ref()
                .and_then(|e| serde_json::to_string(e).ok())
                .unwrap_or_else(|| "invalid_evidence".into()),
            None if matched.is_some() => "unavailable".into(),
            None if value.is_some() => "envelope_mismatch".into(),
            None => "invalid_response".into(),
        };
        let clear = output.ok() && status == Some("clear") && !summary.deadline_exceeded;
        summary.terminal_reason = if summary.deadline_exceeded {
            "deadline_exceeded".into()
        } else if clear {
            "clear".into()
        } else if output.timed_out {
            "scan_timeout".into()
        } else if matched.is_some() && !matches!(status, Some("clear" | "unknown" | "busy")) {
            "invalid_status".into()
        } else if status == Some("clear") {
            "clear_exit_mismatch".into()
        } else {
            validated
                .as_ref()
                .map(|e| {
                    serde_json::to_value(&e.reason)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_string()
                })
                .unwrap_or_else(|| evidence.clone())
        };
        if summary.initial_reason == "not_started" && summary.attempts > 0 {
            summary.initial_reason = summary.terminal_reason.clone();
        }
        if clear {
            return Ok(summary);
        }
        let retry = android.is_none()
            && summary.attempts == 1
            && !summary.deadline_exceeded
            && !output.timed_out
            && output.exit_code == Some(4)
            && status == Some("unknown")
            && validated.as_ref().is_some_and(|e| {
                e.reason == AdmissionProbeReason::ExecutableIdentityUnproven && e.pid.is_some()
            });
        if retry {
            if let Some(reason) = runner.cancellation() {
                summary.terminal_reason = "cancelled".into();
                return Err(summary.refusal(
                    Failure::cancelled("fresh_install", &reason)
                        .with_recovery(crate::failure::RecoveryReason::RunCancelled),
                ));
            }
            let remaining = deadline_ms.saturating_sub(runner.monotonic_ms());
            runner.sleep(Duration::from_millis(500.min(remaining)));
            continue;
        }
        let busy = !summary.deadline_exceeded
            && !output.timed_out
            && output.exit_code == Some(4)
            && status == Some("busy");
        let probe_status = match status {
            _ if !dispatched => "not_run",
            Some("clear") => "clear",
            Some("busy") => "busy",
            Some("unknown") => "unknown",
            _ => "invalid",
        };
        let detail = format!(
            "{}; probe_status={probe_status}; probe_evidence={evidence}; exit_code={:?}; timed_out={}; deadline_exceeded={}",
            if summary.deadline_exceeded { "admission allowance expired" }
            else if busy { "a foreign automation flow is active on the selected device" }
            else { "strict foreign-flow admission did not prove the selected device clear" },
            output.exit_code, output.timed_out, summary.deadline_exceeded,
        );
        let foreign = (android.is_some() && busy)
            || (!summary.deadline_exceeded
                && !output.timed_out
                && output.exit_code == Some(4)
                && validated.as_ref().is_some_and(|e| {
                    e.pid.is_some()
                        && matches!(
                            (status, &e.reason),
                            (Some("busy"), AdmissionProbeReason::DriverOnSelectedDevice)
                                | (
                                    Some("unknown"),
                                    AdmissionProbeReason::DriverIdentityUnproven
                                        | AdmissionProbeReason::ExecutableIdentityUnproven
                                )
                        )
                }));
        let (recovery, next_action) = if foreign {
            (
                crate::failure::RecoveryReason::ForeignAdmissionUnresolved,
                "wait for the foreign process owner to finish, then re-run the check; do not signal or adopt the process",
            )
        } else {
            (
                crate::failure::RecoveryReason::IdentityUnavailable,
                "run qaren doctor; restore process observation and the qaren runtime, resolve the reported probe or deadline failure, then re-run the check; do not signal or adopt unproven processes",
            )
        };
        return Err(summary.refusal(
            Failure::new(
                "fresh_install",
                if busy {
                    FailureCode::DeviceBusy
                } else {
                    FailureCode::FreshInstallAdmissionUnknown
                },
                detail,
                next_action,
            )
            .with_recovery(recovery),
        ));
    }
}

enum Msg {
    Line(String),
    Oversize,
    Eof,
}

pub struct CoreChild {
    pub pid: i32,
    run_id: String,
    child: crate::exec::PipedChild,
    rx: mpsc::Receiver<Msg>,
    diagnostics: diagnostics::Sink,
}

// The caller could not persist the pid, so nothing else will ever find this child: kill its group now.
pub fn abort(mut core: CoreChild) {
    core.child.handle.kill_group();
}

// Spawns the child and writes the request; the caller persists the pid, then waits.
pub fn spawn(
    runner: &mut dyn Runner,
    spec: &CmdSpec,
    stderr_log: &Path,
    request: &CoreRequest,
) -> Result<CoreChild, Failure> {
    spawn_private(runner, spec, stderr_log, request, None, None)
}

pub fn spawn_private(
    runner: &mut dyn Runner,
    spec: &CmdSpec,
    stderr_log: &Path,
    request: &CoreRequest,
    inputs: Option<&crate::redact::ResolvedInputs<'_>>,
    login_snapshot: Option<&Value>,
) -> Result<CoreChild, Failure> {
    crate::cancel::ensure_running(runner, "core")?;
    let mut core_spec = spec.clone();
    core_spec.core_log = true;
    let mut child = runner.spawn_piped(&core_spec, stderr_log).map_err(|e| {
        Failure::new(
            "core",
            FailureCode::CoreSpawnFailed,
            format!("cannot spawn {}: {e}", spec.rendered()),
            "check the node path and the qaren runtime directory, then re-run",
        )
    })?;
    if let Err(failure) = crate::cancel::ensure_running(runner, "core") {
        child.handle.kill_group();
        return Err(failure);
    }
    let written = (|| {
        if let Some(inputs) = inputs {
            let mut public = serde_json::to_value(request)
                .map_err(|_| std::io::Error::other("private request failed"))?;
            if let Some(snapshot) = login_snapshot {
                public["loginSnapshot"] = snapshot.clone();
            }
            inputs.write_private(&mut child.stdin, &public, Some(&request.run_id))?;
        } else {
            let envelope = json!({ "v": WIRE_VERSION, "runId": request.run_id, "seq": 1, "type": "request", "payload": request });
            child.stdin.write_all(format!("{envelope}\n").as_bytes())?;
        }
        child.stdin.flush()
    })();
    if let Err(e) = written {
        child.handle.kill_group();
        return Err(Failure::new(
            "core",
            FailureCode::CoreSpawnFailed,
            format!("cannot write the request to the core child: {e}"),
            "inspect the core log, then re-run",
        ));
    }
    // Bounded: a flooding child blocks on the pipe instead of growing our memory.
    let (tx, rx) = mpsc::sync_channel::<Msg>(INBOX_DEPTH);
    let mut stdout = std::mem::replace(&mut child.stdout, Box::new(std::io::empty()));
    let input_scope = crate::redact::capture_input_scope();
    std::thread::spawn(move || {
        let mut read = || {
            let mut line = Vec::new();
            loop {
                line.clear();
                let mut limited = std::io::Read::take(&mut *stdout, MAX_LINE_BYTES as u64 + 1);
                match limited.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let msg = if line.len() > MAX_LINE_BYTES {
                            Msg::Oversize
                        } else {
                            Msg::Line(String::from_utf8_lossy(&line).trim_end().to_string())
                        };
                        let stop = matches!(msg, Msg::Oversize);
                        if tx.send(msg).is_err() || stop {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(Msg::Eof);
        };
        if let Some(scope) = input_scope {
            crate::redact::with_input_scope(scope, read);
        } else {
            read();
        }
    });
    Ok(CoreChild {
        pid: child.pid,
        run_id: request.run_id.clone(),
        child,
        rx,
        diagnostics: diagnostics::Sink::new(stderr_log),
    })
}

struct Inbox {
    run_id: String,
    last_seq: u64,
    rows: Vec<Row>,
    starts: usize,
    admitted: bool,
    drivers: Vec<i32>,
    announced: usize,
    result: Option<Value>,
    violation: Option<String>,
    diagnostics: diagnostics::Sink,
}

const MAX_RUNNER_DRIVERS: usize = 8;

impl Inbox {
    fn accept(&mut self, line: &str) -> bool {
        if self.result.is_some() {
            self.violation = Some(format!("output after the result line: {}", excerpt(line)));
            return false;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            self.violation = Some(format!("non-JSON line on the wire: {}", excerpt(line)));
            return false;
        };
        let v = value.get("v").and_then(Value::as_u64);
        let run_id = value.get("runId").and_then(Value::as_str);
        let seq = value.get("seq").and_then(Value::as_u64);
        let kind = value.get("type").and_then(Value::as_str);
        if v != Some(WIRE_VERSION) || run_id != Some(self.run_id.as_str()) {
            self.violation = Some(format!(
                "envelope for another run or wire version: {}",
                excerpt(line)
            ));
            return false;
        }
        match seq {
            Some(seq) if seq > self.last_seq => self.last_seq = seq,
            _ => {
                self.violation = Some(format!("envelope seq is not increasing: {}", excerpt(line)));
                return false;
            }
        }
        match (kind, value.get("payload")) {
            (Some("diagnostic"), Some(payload)) => {
                self.diagnostics.accept(payload);
                false
            }
            (Some("admitted"), Some(payload))
                if !self.admitted && payload.as_object().is_some_and(|p| p.is_empty()) =>
            {
                self.admitted = true;
                crate::events::admitted();
                true
            }
            (Some("resource"), Some(payload))
                if payload.get("kind").and_then(Value::as_str) == Some("runner_driver")
                    && payload.as_object().is_some_and(|p| p.len() == 2) =>
            {
                let pid = payload
                    .get("pid")
                    .and_then(Value::as_i64)
                    .and_then(|pid| i32::try_from(pid).ok())
                    .filter(|pid| *pid > 1);
                match pid {
                    Some(pid) if self.announced < MAX_RUNNER_DRIVERS => {
                        self.announced += 1;
                        self.drivers.push(pid);
                        true
                    }
                    Some(_) => {
                        self.violation =
                            Some(format!("more than {MAX_RUNNER_DRIVERS} runner drivers"));
                        false
                    }
                    None => {
                        self.violation =
                            Some(format!("runner driver pid is invalid: {}", excerpt(line)));
                        false
                    }
                }
            }
            // A start is telemetry only: it neither resets the step deadline nor becomes a ledger row.
            (Some("start"), Some(payload)) => {
                if self.starts >= MAX_ROWS {
                    self.violation = Some(format!("more than {MAX_ROWS} step starts"));
                    return false;
                }
                match serde_json::from_value::<StepStart>(payload.clone()) {
                    Ok(start)
                        if start.operation_id > 0
                            && start.line > 0
                            && matches!(start.kind.as_str(), "step" | "check") =>
                    {
                        self.starts += 1;
                        crate::events::step(&start);
                        false
                    }
                    _ => {
                        self.violation = Some(format!(
                            "start payload is not a step start: {}",
                            excerpt(line)
                        ));
                        false
                    }
                }
            }
            (Some("row"), Some(payload)) => {
                if self.rows.len() >= MAX_ROWS {
                    self.violation = Some(format!("more than {MAX_ROWS} rows"));
                    return false;
                }
                match serde_json::from_value::<Row>(payload.clone()) {
                    Ok(mut row) => {
                        row.redact_evidence();
                        crate::progress::row(&row);
                        crate::events::row(&row);
                        self.rows.push(row);
                        true
                    }
                    Err(e) => {
                        self.violation = Some(format!(
                            "row payload is not a ledger row ({e}): {}",
                            excerpt(line)
                        ));
                        false
                    }
                }
            }
            (Some("result"), Some(payload)) if self.result.is_none() => {
                self.result = Some(payload.clone());
                false
            }
            (Some("result"), _) => {
                self.violation = Some("a second result line arrived".to_string());
                false
            }
            _ => {
                self.violation = Some(format!("unknown envelope: {}", excerpt(line)));
                false
            }
        }
    }
}

fn excerpt(line: &str) -> String {
    if crate::redact::input_namespace_present() {
        return "[private output withheld]".into();
    }
    redact_secrets(line).chars().take(120).collect()
}

// A missing result or deadline kill becomes a FAIL attributed to the last row.
// `on_driver` records each announced runner driver before the walk goes on.
pub fn wait(
    runner: &mut dyn Runner,
    core: CoreChild,
    budgets: Budgets,
    on_driver: &mut dyn FnMut(&mut dyn Runner, i32),
) -> CoreOutcome {
    let CoreChild {
        pid,
        run_id,
        mut child,
        rx,
        diagnostics,
    } = core;
    let started = runner.monotonic_ms();
    let mut last_progress = started;
    let mut inbox = Inbox {
        run_id,
        last_seq: 1,
        rows: Vec::new(),
        starts: 0,
        admitted: false,
        drivers: Vec::new(),
        announced: 0,
        result: None,
        violation: None,
        diagnostics,
    };
    let mut exit: Option<i32> = None;
    let mut eof = false;
    let mut deadline_failure: Option<Failure> = None;
    let mut killed_at: Option<u64> = None;
    let mut result_at: Option<u64> = None;
    let mut killed_after_result = false;
    let mut group_survived = false;
    let mut cancel_deadline: Option<u64> = None;
    // Kill before reaping to keep the pgid from being recycled under us.
    loop {
        if killed_at.is_none() && cancel_deadline.is_none() {
            if let Some(reason) = runner.cancellation() {
                deadline_failure = Some(Failure::cancelled("walk", &reason));
                child.handle.terminate();
                cancel_deadline = Some(runner.monotonic_ms() + CANCEL_GRACE_MS);
            }
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Line(line)) => {
                if inbox.accept(&line) {
                    last_progress = runner.monotonic_ms();
                }
                for pid in std::mem::take(&mut inbox.drivers) {
                    on_driver(runner, pid);
                }
            }
            Ok(Msg::Oversize) => {
                inbox.violation = Some(format!("a wire line exceeded {MAX_LINE_BYTES} bytes"));
            }
            Ok(Msg::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                eof = true;
                runner.sleep(Duration::from_millis(50));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => runner.sleep(Duration::from_millis(50)),
        }
        if result_at.is_none() && inbox.result.is_some() {
            result_at = Some(runner.monotonic_ms());
        }
        let now = runner.monotonic_ms();
        if let Some(at) = killed_at {
            if exit.is_none() {
                // An unobservable leader is never guessed dead; the grace below reports it.
                exit = child.handle.try_wait().ok().flatten();
            }
            if exit.is_some() && eof {
                break;
            }
            if now.saturating_sub(at) > POST_KILL_GRACE_MS {
                group_survived = true;
                break;
            }
            continue;
        }
        if eof {
            killed_after_result = inbox.result.is_some();
            child.handle.kill_group();
            killed_at = Some(now);
            continue;
        }
        if let Some(deadline) = cancel_deadline {
            if now >= deadline {
                child.handle.kill_group();
                killed_at = Some(now);
            }
            continue;
        }
        // Setup uses only the walk budget; a held result uses only the exit grace.
        let walking = inbox.rows.iter().any(|r| r.line > 0);
        let reason = if inbox.violation.is_some() {
            inbox.violation.clone()
        } else if result_at.is_some() {
            None
        } else if now.saturating_sub(started) > budgets.walk_seconds.saturating_mul(1000) {
            Some(format!(
                "the walk exceeded its {}s budget after {} row(s)",
                budgets.walk_seconds,
                inbox.rows.len()
            ))
        } else if walking
            && now.saturating_sub(last_progress) > budgets.step_seconds.saturating_mul(1000)
        {
            Some(format!(
                "no ledger row within {}s after {}",
                budgets.step_seconds,
                describe_last(&inbox.rows)
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            let code = if inbox.violation.is_some() {
                FailureCode::CoreResultMissing
            } else if !inbox.admitted {
                FailureCode::CoreRefused
            } else {
                FailureCode::WalkDeadlineExceeded
            };
            let reason = if code == FailureCode::CoreRefused {
                let measured = match host_load_1m() {
                    Some(load) => format!("host 1-minute load {load:.1}"),
                    None => "host load unavailable".to_string(),
                };
                format!("cannot attach to the dev client before the walk deadline ({measured}; an environment refusal): {reason}")
            } else {
                reason
            };
            deadline_failure = Some(Failure::new(
                "walk",
                code,
                reason,
                "inspect the core log for the stuck or misbehaving step, then re-run",
            ));
            child.handle.kill_group();
            killed_at = Some(now);
        } else if let Some(at) = result_at {
            // The verdict is in hand; a child that overstays its exit is taken down without losing it.
            if now.saturating_sub(at) > budgets.step_seconds.saturating_mul(1000) {
                killed_after_result = true;
                child.handle.kill_group();
                killed_at = Some(now);
            }
        }
    }
    let admitted = inbox.admitted;
    let (ledger, verdict, failure) = interpret(inbox, exit, deadline_failure, killed_after_result);
    CoreOutcome {
        pid,
        ledger,
        verdict,
        exit,
        failure,
        group_survived,
        admitted,
    }
}

fn describe_last(rows: &[Row]) -> String {
    match rows.last() {
        Some(row) => format!("line {} (attempt {})", row.line, row.attempt),
        None => "the startup row".to_string(),
    }
}

// A signal from our post-result kill must not replace the child's held verdict.
fn interpret(
    inbox: Inbox,
    exit: Option<i32>,
    deadline_failure: Option<Failure>,
    killed_after_result: bool,
) -> (Ledger, Verdict, Option<Failure>) {
    let missing = |rows: &[Row], seen: String, code: FailureCode| {
        (
            synthesized_ledger(rows, "FAIL", &seen),
            Verdict::Fail,
            Some(Failure::new(
                "walk",
                code,
                seen,
                "inspect the core log, then re-run",
            )),
        )
    };
    if let Some(violation) = inbox.violation {
        return missing(
            &inbox.rows,
            format!("wire contract violated: {violation}"),
            FailureCode::CoreResultMissing,
        );
    }
    if let Some(failure) = deadline_failure {
        let seen = failure.detail.to_string();
        if matches!(
            failure.code,
            FailureCode::RunCancelled | FailureCode::CoreRefused
        ) {
            let mut ledger = synthesized_ledger(&inbox.rows, "REFUSED", &seen);
            if failure.code == FailureCode::RunCancelled {
                ledger.press_evidence = inbox
                    .result
                    .as_ref()
                    .and_then(|result| result.get("pressEvidence"))
                    .and_then(parse_press_evidence);
            }
            return (
                ledger,
                Verdict::Refused {
                    code: if failure.code == FailureCode::RunCancelled {
                        "RUN_CANCELLED"
                    } else {
                        "CDP_NOT_CONNECTED"
                    }
                    .to_string(),
                    message: seen,
                },
                Some(failure),
            );
        }
        return (
            synthesized_ledger(&inbox.rows, "FAIL", &seen),
            Verdict::Fail,
            Some(failure),
        );
    }
    let exit_text = exit.map_or("unknown".to_string(), |c| c.to_string());
    let Some(result) = inbox.result else {
        return missing(
            &inbox.rows,
            format!("core exited with code {exit_text} without a result line"),
            FailureCode::CoreResultMissing,
        );
    };
    let verdict = result
        .get("verdict")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expected_exit = match verdict.as_str() {
        "PASS" => Some(0),
        "FAIL" => Some(1),
        "REFUSED" => Some(4),
        _ => None,
    };
    let own_kill = killed_after_result && exit.is_some_and(|c| c < 0);
    if expected_exit.is_none() || (expected_exit != exit && !own_kill) {
        return missing(
            &inbox.rows,
            format!("result line says {verdict:?} but the core exited with code {exit_text}"),
            FailureCode::CoreResultMissing,
        );
    }
    if let Some(evidence) = result.get("pressEvidence") {
        if parse_press_evidence(evidence).is_none() {
            let (ledger, verdict, failure) = missing(
                &inbox.rows,
                "invalid press evidence".to_string(),
                FailureCode::CoreResultMissing,
            );
            return (
                ledger,
                verdict,
                failure.map(|mut failure| {
                    failure.next_action = crate::redact::OutputText::from_output(
                        "install_matching_runtime_then_rerun",
                    );
                    failure
                }),
            );
        }
    }
    if verdict == "REFUSED" {
        let code = (result
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("CORE_REFUSED"))
        .to_string();
        let message = redact_secrets(
            result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the core child refused the run"),
        );
        return match refusal_ledger(&result, &inbox.rows, &format!("{code}: {message}")) {
            Ok(ledger) => (ledger, Verdict::Refused { code, message }, None),
            Err(error) => missing(
                &inbox.rows,
                format!("refusal has invalid ledger evidence: {error}"),
                FailureCode::CoreResultMissing,
            ),
        };
    }
    match serde_json::from_value::<Ledger>(result) {
        Ok(ledger) if !valid_ledger_path(&ledger.path) || !valid_blocks(&ledger.blocks) => missing(
            &inbox.rows,
            "result line has an invalid ledger path or block".to_string(),
            FailureCode::CoreResultMissing,
        ),
        Ok(mut ledger) => {
            ledger.redact_evidence();
            let verdict = if verdict == "PASS" {
                Verdict::Pass
            } else {
                Verdict::Fail
            };
            (ledger, verdict, None)
        }
        Err(e) => missing(
            &inbox.rows,
            format!("result line is not a valid ledger: {e}"),
            FailureCode::CoreResultMissing,
        ),
    }
}

fn parse_press_evidence(value: &Value) -> Option<PressEvidence> {
    serde_json::from_value::<PressEvidence>(value.clone())
        .ok()
        .filter(|evidence| matches!(evidence.captures, 1 | 2))
}

fn refusal_ledger(result: &Value, rows: &[Row], seen: &str) -> Result<Ledger, String> {
    for field in ["code", "message", "lease"] {
        if result.get(field).is_some_and(|value| !value.is_string()) {
            return Err(format!("{field} must be a string when supplied"));
        }
    }
    let mut normalized = serde_json::to_value(synthesized_ledger(rows, "REFUSED", seen))
        .map_err(|error| error.to_string())?;
    for field in [
        "path",
        "blocks",
        "steps",
        "jev",
        "llmTurns",
        "escapes",
        "recoveries",
        "failure",
        "blocksWritten",
        "pressEvidence",
    ] {
        if let Some(value) = result.get(field) {
            if value.is_null() {
                return Err(format!("{field} must not be null when supplied"));
            }
            normalized[field] = value.clone();
        }
    }
    // Speed is passive: copied as-is, and a malformed or null value is dropped on decode.
    if let Some(speed) = result.get("speed") {
        normalized["speed"] = speed.clone();
    }
    if let Some(eligibility) = result.get("videoPublication") {
        normalized["videoPublication"] = eligibility.clone();
    }
    for key in ["videoPolicy", "nonStrictPublication"] {
        if let Some(value) = result.get(key) {
            normalized[key] = value.clone();
        }
    }
    if let Some(media) = result.get("mediaWithheld") {
        normalized["mediaWithheld"] = media.clone();
    }
    let mut ledger: Ledger =
        serde_json::from_value(normalized).map_err(|error| error.to_string())?;
    if !valid_ledger_path(&ledger.path) {
        return Err("path must be walk, replay or replay→walk@<line>".into());
    }
    if !valid_blocks(&ledger.blocks) {
        return Err("invalid block outcome or source".into());
    }
    if ledger.steps.len() > MAX_ROWS
        || ledger.steps.iter().any(|row| {
            !matches!(row.kind.as_str(), "step" | "check")
                || !matches!(row.resolved_by.as_str(), "exact" | "jev")
                || !matches!(row.outcome.as_str(), "pass" | "fail" | "retry")
        })
    {
        return Err("invalid ledger steps".into());
    }
    if ledger.jev.call_details.iter().any(|call| {
        !matches!(call.scope.as_str(), "preflight" | "parse" | "walk")
            || !matches!(
                call.outcome.as_str(),
                "ok" | "timeout" | "deadline" | "network" | "http" | "invalid"
            )
            || call
                .status
                .is_some_and(|status| !(100..=599).contains(&status))
    }) {
        return Err("invalid Jev call details".into());
    }
    if result.get("failure").is_none() {
        ledger.failure = Some(synthesized_failure(&ledger.steps, seen));
    }
    ledger.redact_evidence();
    Ok(ledger)
}

fn synthesized_failure(rows: &[Row], seen: &str) -> LedgerFailure {
    let last = rows.last();
    LedgerFailure {
        step: last.map_or(0, |row| row.line),
        seen: seen.to_string(),
        screenshot: last.and_then(|row| row.screenshot.clone()),
        kind: None,
    }
}

pub fn synthesized_ledger(rows: &[Row], verdict: &str, seen: &str) -> Ledger {
    let steps: Vec<Row> = rows.to_vec();
    Ledger {
        press_evidence: None,
        verdict: verdict.to_string(),
        video_publication: None,
        video_policy: Default::default(),
        video_policy_source: None,
        non_strict_publication: None,
        media_withheld: None,
        admitted_at_ms: None,
        publish_from_ms: None,
        publication_interrupted: false,
        path: "walk".to_string(),
        blocks: Vec::new(),
        blocks_written: None,
        failure: Some(synthesized_failure(&steps, seen)),
        steps,
        jev: JevRollup::default(),
        llm_turns: 0,
        escapes: 0,
        recoveries: 0,
        speed: None,
        recipe: None,
    }
}

pub(crate) fn host_load_1m() -> Option<f64> {
    let mut load = 0.0;
    (unsafe { libc::getloadavg(&mut load, 1) } == 1).then_some(load)
}

pub fn private_preflight_spec(node: &Path, runtime_dir: &Path) -> CmdSpec {
    CmdSpec::new(
        "plan-preflight",
        &node.to_string_lossy(),
        &[
            &runtime_dir.join("qa").join("walk.js").to_string_lossy(),
            "--preflight-stdin",
        ],
        320,
    )
}
