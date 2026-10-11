use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::redact::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_marker: Option<crate::config::LoginMarker>,
    pub target: CoreTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreTarget {
    pub device_id: String,
    pub metro_port: u16,
    pub metro_url_for_device: String,
    pub worktree: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adb: Option<AdbTarget>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_socket: Option<String>,
    pub serial: String,
}

// The ledger the child returns as its result line; the wire is a contract, so it is read strictly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub verdict: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "passive"
    )]
    pub video_publication: Option<crate::record::VideoPublication>,
    // Epoch ms at which the walk proved the app's bundle and cleared its dev overlays; earlier recorded frames are never published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admitted_at_ms: Option<u64>,
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
    pub t: u64,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog: Option<DialogTap>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

// Characters typed into a field that changed only their letter case.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaseNormalized {
    pub chars: u64,
}

impl Row {
    // The value-free count line for an unverified fill, rendered from numbers the masking never saw.
    pub fn fill_detail(&self) -> Option<String> {
        self.kept.as_ref().and_then(KeptCounts::detail).or_else(|| {
            self.case_normalized
                .as_ref()
                .map(|n| format!("field case-normalized {} chars", n.chars))
        })
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
}

pub fn spawn_spec(
    node: &Path,
    runtime_dir: &Path,
    worktree: &Path,
    lease: &str,
    metro_port: u16,
) -> CmdSpec {
    CmdSpec::new(
        "core-walk",
        &node.to_string_lossy(),
        &[&runtime_dir.join("qa").join("walk.js").to_string_lossy()],
        0,
    )
    .cwd(worktree)
    .env("QAREN_DEVICE_LEASE", lease)
    .env("QAREN_METRO_PORT", &metro_port.to_string())
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

pub fn fresh_install_admission(
    runner: &mut dyn Runner,
    node: &Path,
    runtime_dir: &Path,
    worktree: &Path,
    device_id: &str,
) -> Result<(), Failure> {
    let observer = std::env::current_exe()
        .ok()
        .filter(|path| path.is_absolute())
        .and_then(|path| path.into_os_string().into_string().ok())
        .ok_or_else(|| {
            Failure::new(
                "fresh_install",
                FailureCode::FreshInstallAdmissionUnknown,
                "native process observer is unavailable",
                "ensure the qaren executable is available and re-run",
            )
        })?;
    let output = runner.run(
        &CmdSpec::new(
            "fresh-install-admission",
            &node.to_string_lossy(),
            &[
                &runtime_dir
                    .join("qa/fresh-install-preflight.js")
                    .to_string_lossy(),
                "--platform",
                "ios",
                "--device",
                device_id,
                "--process-observer",
                &observer,
            ],
            30,
        )
        .cwd(worktree),
    );
    let value = serde_json::from_str::<Value>(&output.stdout).ok();
    let status = value
        .as_ref()
        .filter(|v| {
            v.get("v").and_then(Value::as_u64) == Some(1)
                && v.get("platform").and_then(Value::as_str) == Some("ios")
                && v.get("deviceId").and_then(Value::as_str) == Some(device_id)
        })
        .and_then(|v| v.get("status"))
        .and_then(Value::as_str);
    if output.ok() && status == Some("clear") {
        return Ok(());
    }
    let busy = !output.timed_out && output.exit_code == Some(4) && status == Some("busy");
    Err(Failure::new(
        "fresh_install",
        if busy {
            FailureCode::DeviceBusy
        } else {
            FailureCode::FreshInstallAdmissionUnknown
        },
        if busy {
            "a foreign automation flow is active on the selected device"
        } else {
            "strict foreign-flow admission did not prove the selected device clear"
        },
        "stop other automation drivers and ensure the runtime supports strict fresh-install preflight, \
         then re-run",
    ))
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
    crate::cancel::ensure_running(runner, "core")?;
    let mut child = runner.spawn_piped(spec, stderr_log).map_err(|e| {
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
    let envelope = json!({
        "v": WIRE_VERSION,
        "runId": request.run_id,
        "seq": 1,
        "type": "request",
        "payload": request,
    });
    let written = child
        .stdin
        .write_all(format!("{envelope}\n").as_bytes())
        .and_then(|()| child.stdin.flush());
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
    std::thread::spawn(move || {
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
    });
    Ok(CoreChild {
        pid: child.pid,
        run_id: request.run_id.clone(),
        child,
        rx,
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
    let (ledger, verdict, failure) = interpret(inbox, exit, deadline_failure, killed_after_result);
    CoreOutcome {
        pid,
        ledger,
        verdict,
        exit,
        failure,
        group_survived,
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
            return (
                synthesized_ledger(&inbox.rows, "REFUSED", &seen),
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
    }
}

pub fn synthesized_ledger(rows: &[Row], verdict: &str, seen: &str) -> Ledger {
    let steps: Vec<Row> = rows.to_vec();
    Ledger {
        verdict: verdict.to_string(),
        video_publication: None,
        admitted_at_ms: None,
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
    }
}

pub(crate) fn host_load_1m() -> Option<f64> {
    let mut load = 0.0;
    (unsafe { libc::getloadavg(&mut load, 1) } == 1).then_some(load)
}
