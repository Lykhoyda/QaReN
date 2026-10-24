use crate::client::Client;
use crate::core::{Row, RowTiming, StepStart};
use crate::receipt::Receipt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const EVENTS_VERSION: u32 = 1;
// ponytail: 1,024-event queue; drops are counted, raise it if a run reports drops
const QUEUE: usize = 1024;
const BEFORE_ATTACH: usize = 256;
const DRAIN: Duration = Duration::from_millis(500);
const CLEANUP_KEYS: [&str; 11] = [
    "build_process",
    "core",
    "metro",
    "runner_driver",
    "runner_host",
    "recorder",
    "simulator",
    "device_lease",
    "pr_worktree",
    "adb_reverse",
    "android_runner",
];
const CLEANUP_KINDS: [&str; 7] = [
    "removed",
    "absent",
    "kept",
    "released",
    "retained",
    "unresolved",
    "refused",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    pub seq: u64,
    pub event: String,
    pub at: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageState {
    Running,
    Passed,
    Failed,
    Skipped,
}

impl StageState {
    pub fn as_str(self) -> &'static str {
        match self {
            StageState::Running => "running",
            StageState::Passed => "passed",
            StageState::Failed => "failed",
            StageState::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

// Exactly the value-free fields of a streamed row; text, reason, selector, ref, block and screenshot have no slot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RowEvent<'a> {
    operation_id: u64,
    line: u64,
    attempt: u64,
    kind: String,
    resolved_by: String,
    t: u64,
    outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<&'a RowTiming>,
}

struct Shared {
    path: Mutex<Option<PathBuf>>,
    dropped: AtomicU64,
    end: OnceLock<Envelope>,
}

// One run's stream: the run thread submits, a detached writer thread owns the file.
pub struct Events {
    tx: SyncSender<Envelope>,
    shared: Arc<Shared>,
    done: Receiver<()>,
    seq: u64,
    ended: bool,
    running: Vec<(&'static str, Instant)>,
}

impl Events {
    pub fn start(gate: Option<Receiver<()>>) -> Option<Events> {
        Self::start_with_spawn(gate, |writer| {
            std::thread::Builder::new().spawn(writer).map(drop)
        })
    }

    fn start_with_spawn(
        gate: Option<Receiver<()>>,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<()>,
    ) -> Option<Events> {
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let (done_tx, done) = mpsc::sync_channel(1);
        let shared = Arc::new(Shared {
            path: Mutex::new(None),
            dropped: AtomicU64::new(0),
            end: OnceLock::new(),
        });
        let writer_shared = shared.clone();
        spawn(Box::new(move || {
            if let Some(gate) = gate {
                let _ = gate.recv();
            }
            write_events(rx, &writer_shared);
            let _ = done_tx.send(());
        }))
        .ok()?;
        Some(Events {
            tx,
            shared,
            done,
            seq: 0,
            ended: false,
            running: Vec::new(),
        })
    }

    #[cfg(test)]
    fn stalled() -> (Events, SyncSender<()>) {
        let (gate_tx, gate) = mpsc::sync_channel(1);
        (Events::start(Some(gate)).unwrap(), gate_tx)
    }

    fn envelope(&mut self, event: &str, payload: Value) -> Envelope {
        self.seq += 1;
        Envelope {
            v: EVENTS_VERSION,
            seq: self.seq,
            event: event.to_string(),
            at: epoch_ms(),
            payload,
        }
    }

    fn submit(&mut self, event: &str, payload: Value) {
        if self.ended {
            return;
        }
        let envelope = self.envelope(event, payload);
        if self.tx.try_send(envelope).is_err() {
            self.shared.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn attach(&mut self, path: &Path) {
        if self.ended {
            return;
        }
        if let Ok(mut slot) = self.shared.path.lock() {
            slot.get_or_insert_with(|| path.to_path_buf());
        }
    }

    pub fn run(
        &mut self,
        run_id: &str,
        verb: &str,
        platform: &str,
        client: &Client,
        flags: &[&'static str],
    ) {
        let mut payload = json!({
            "runId": token(run_id),
            "verb": token(verb),
            "platform": token(platform),
            "ownerPid": std::process::id(),
            "qarenVersion": token(env!("CARGO_PKG_VERSION")),
            "harness": token(client.harness),
            "markers": client.markers.iter().map(|m| token(m)).collect::<Vec<_>>(),
            "flags": flags.iter().map(|f| token(f)).collect::<Vec<_>>(),
        });
        if let Some(commit) = option_env!("QAREN_BUILD_COMMIT") {
            payload["qarenCommit"] = token(commit).into();
        }
        if let Some(model) = &client.model {
            payload["model"] = token(model).into();
        }
        self.submit("run", payload);
    }

    pub fn stage(
        &mut self,
        name: &'static str,
        state: StageState,
        code: Option<&str>,
        ms: Option<u64>,
    ) {
        let began = self.running.iter().position(|(n, _)| *n == name);
        let began = began.map(|i| self.running.remove(i).1);
        if state == StageState::Running {
            self.running.push((name, Instant::now()));
        }
        let mut payload = json!({"name": name, "state": state.as_str()});
        if let Some(code) = code {
            payload["code"] = token(code).into();
        }
        let measured = (state != StageState::Running)
            .then_some(began)
            .flatten()
            .map(|b| b.elapsed().as_millis() as u64);
        if let Some(ms) = ms.or(measured) {
            payload["ms"] = ms.into();
        }
        self.submit("stage", payload);
    }

    pub fn close_running(&mut self, state: StageState, code: Option<&str>, except: &[&str]) {
        let open: Vec<&'static str> = self
            .running
            .iter()
            .map(|(n, _)| *n)
            .filter(|n| !except.contains(n))
            .collect();
        for name in open {
            self.stage(name, state, code, None);
        }
    }

    pub fn cmd(&mut self, label: &str, edge: Edge, ok: Option<bool>, ms: Option<u64>) {
        let edge = match edge {
            Edge::Start => "start",
            Edge::End => "end",
        };
        let mut payload = json!({"label": token(label), "edge": edge});
        if let Some(ok) = ok {
            payload["ok"] = ok.into();
        }
        if let Some(ms) = ms {
            payload["ms"] = ms.into();
        }
        self.submit("cmd", payload);
    }

    pub fn admitted(&mut self) {
        self.submit("admitted", json!({}));
        self.stage("attach", StageState::Passed, None, None);
        self.stage("steps", StageState::Running, None, None);
    }

    pub fn core_t0(&mut self, t0: u64) {
        self.submit("coreT0", json!({ "t0": t0 }));
    }

    pub fn step(&mut self, start: &StepStart) {
        self.submit(
            "step",
            json!({"operationId": start.operation_id, "line": start.line, "kind": token(&start.kind), "t": start.t}),
        );
    }

    pub fn row(&mut self, row: &Row) {
        let event = RowEvent {
            operation_id: row.operation_id,
            line: row.line,
            attempt: row.attempt,
            kind: token(&row.kind),
            resolved_by: token(&row.resolved_by),
            t: row.t,
            outcome: token(&row.outcome),
            timing: row.timing.as_ref(),
        };
        if let Ok(payload) = serde_json::to_value(event) {
            self.submit("row", payload);
        }
    }

    // Stages a failure left open close with its code; `end` is held aside so a full queue cannot drop it.
    pub fn end(&mut self, receipt: &Receipt, expected_exit: u8) {
        if self.ended {
            return;
        }
        let failure_code = receipt.failure.as_ref().map(|f| code_str(&f.code));
        if let Some(code) = &failure_code {
            self.close_running(StageState::Failed, Some(code), &[]);
        }
        let cleanup: serde_json::Map<String, Value> = receipt
            .cleanup
            .iter()
            .filter(|(key, _)| CLEANUP_KEYS.contains(&key.as_str()))
            .map(|(key, value)| {
                let first = value.split(|c: char| !c.is_ascii_alphabetic()).next();
                let kind = first
                    .filter(|w| CLEANUP_KINDS.contains(w))
                    .unwrap_or("other");
                (key.clone(), kind.into())
            })
            .collect();
        let timings: serde_json::Map<String, Value> = receipt
            .timings_ms
            .iter()
            .map(|(k, v)| (token(k), (*v).into()))
            .collect();
        let mut payload = json!({
            "result": serde_json::to_value(receipt.result).unwrap_or(Value::Null),
            "phase": token(&receipt.phase),
            "timingsMs": timings,
            "cleanup": cleanup,
            "expectedExit": expected_exit,
            "droppedEvents": 0,
        });
        if let (Some(code), Some(failure)) = (failure_code, &receipt.failure) {
            payload["failureCode"] = code.into();
            payload["failurePhase"] = token(&failure.phase).into();
        }
        let envelope = self.envelope("end", payload);
        let _ = self.shared.end.set(envelope);
        self.ended = true;
    }

    // Gives the writer up to 500 ms to drain and write `end`; the run never waits longer.
    pub fn finish(self) {
        drop(self.tx);
        let _ = self.done.recv_timeout(DRAIN);
    }
}

struct Sink {
    file: Option<File>,
    broken: bool,
    pending: Vec<Envelope>,
}

impl Sink {
    fn push(&mut self, envelope: Envelope, shared: &Shared) {
        if self.broken {
            return;
        }
        if self.file.is_none() && self.pending.len() >= BEFORE_ATTACH {
            shared.dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        self.pending.push(envelope);
    }

    // On any I/O error the stream closes for good; the run never sees it.
    fn flush(&mut self, shared: &Shared) {
        if self.broken {
            return;
        }
        if self.file.is_none() {
            let path = shared.path.lock().ok().and_then(|p| p.clone());
            match path.map(|p| open(&p)) {
                Some(Ok(f)) => self.file = Some(f),
                Some(Err(_)) => return self.close(),
                None => return,
            }
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        let failed = self
            .pending
            .drain(..)
            .any(|e| write_line(file, &e).is_err());
        if failed {
            self.close();
        }
    }

    fn close(&mut self) {
        self.broken = true;
        self.file = None;
        self.pending.clear();
    }
}

// The sender is dropped by `finish`, so Disconnected arrives only after every queued event.
fn write_events(rx: Receiver<Envelope>, shared: &Shared) {
    let mut sink = Sink {
        file: None,
        broken: false,
        pending: Vec::new(),
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(envelope) => sink.push(envelope, shared),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        sink.flush(shared);
    }
    sink.flush(shared);
    if let (Some(file), Some(end)) = (sink.file.as_mut(), shared.end.get()) {
        let mut end = end.clone();
        end.payload["droppedEvents"] = shared.dropped.load(Ordering::Relaxed).into();
        let _ = write_line(file, &end);
    }
}

fn open(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}

fn write_line(file: &mut File, envelope: &Envelope) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(envelope).map_err(std::io::Error::other)?;
    line.push(b'\n');
    file.write_all(&line)?;
    file.flush()
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// Names, labels and codes only: anything else is cut to a bounded identifier.
fn token(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .take(64)
        .collect()
}

fn code_str(code: &crate::failure::FailureCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|v| v.as_str().map(token))
        .unwrap_or_default()
}

// Scoped to the run's thread: every hook fires on it, and parallel in-process runs stay apart.
thread_local! {
    static CURRENT: RefCell<Option<Events>> = const { RefCell::new(None) };
}

fn with(f: impl FnOnce(&mut Events)) {
    let _ = CURRENT.try_with(|current| {
        if let Ok(mut current) = current.try_borrow_mut() {
            if let Some(events) = current.as_mut() {
                f(events);
            }
        }
    });
}

pub fn init() {
    CURRENT.with(|current| *current.borrow_mut() = Events::start(None));
}

pub fn attach(path: &Path) {
    with(|e| e.attach(path));
}

pub fn run(run_id: &str, verb: &str, platform: &str, client: &Client, flags: &[&'static str]) {
    with(|e| e.run(run_id, verb, platform, client, flags));
}

pub fn stage(name: &'static str, state: StageState, code: Option<&str>, ms: Option<u64>) {
    with(|e| e.stage(name, state, code, ms));
}

pub fn close_running(state: StageState, code: Option<&str>, except: &[&str]) {
    with(|e| e.close_running(state, code, except));
}

pub fn cmd(label: &str, edge: Edge, ok: Option<bool>, ms: Option<u64>) {
    with(|e| e.cmd(label, edge, ok, ms));
}

pub fn admitted() {
    with(Events::admitted);
}

pub fn core_t0(t0: u64) {
    with(|e| e.core_t0(t0));
}

pub fn step(start: &StepStart) {
    with(|e| e.step(start));
}

pub fn row(row: &Row) {
    with(|e| e.row(row));
}

pub fn end(receipt: &Receipt, expected_exit: u8) {
    with(|e| e.end(receipt, expected_exit));
}

pub fn finish() {
    let events = CURRENT
        .try_with(|current| current.try_borrow_mut().ok().and_then(|mut c| c.take()))
        .ok()
        .flatten();
    if let Some(events) = events {
        events.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::failure::{Failure, FailureCode};
    use crate::receipt::{Receipt, ReceiptResult};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("qaren-events-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lines(path: &Path) -> Vec<Envelope> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn names(lines: &[Envelope]) -> Vec<String> {
        lines
            .iter()
            .map(|e| match e.payload.get("name").and_then(Value::as_str) {
                Some(name) => format!(
                    "{}:{name}:{}",
                    e.event,
                    e.payload["state"].as_str().unwrap()
                ),
                None => e.event.clone(),
            })
            .collect()
    }

    // Built from the wire shape, so fields the core adds later keep this compiling.
    fn row(line: u64, extra: Value) -> Row {
        let mut base = json!({
            "block": "b", "operationId": line, "line": line, "attempt": 1, "kind": "action", "resolvedBy": "exact",
            "t": 1200, "outcome": "pass",
            "timing": {"captureMs": 600, "nativeMs": 1, "reactMs": 2, "resolveMs": 3, "jevMs": 0,
                       "actMs": 1100, "postCaptureMs": 4, "otherMs": 5, "total": 1715}
        });
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn receipt(result: ReceiptResult) -> Receipt {
        let mut r = Receipt::new("check", "check-1", result, "cleaned", "now".into());
        r.timings_ms.insert("preflight".into(), 900);
        r
    }

    #[test]
    fn writer_start_failure_disables_hooks_without_changing_receipts() {
        let dir = temp("spawn-failed");
        let path = dir.join("events.jsonl");
        for verb in ["check", "pr"] {
            for result in [ReceiptResult::Pass, ReceiptResult::Fail] {
                let events = Events::start_with_spawn(None, |_writer| {
                    Err(std::io::Error::from(std::io::ErrorKind::WouldBlock))
                });
                assert!(events.is_none());
                CURRENT.with(|current| *current.borrow_mut() = events);
                stage("preflight", StageState::Running, None, None);
                run(
                    "check-1",
                    verb,
                    "ios",
                    &crate::client::detect(&crate::exec::MockRunner::new()),
                    &[],
                );
                attach(&path);
                stage("preflight", StageState::Passed, None, None);
                cmd("native-build", Edge::Start, None, None);
                cmd("native-build", Edge::End, Some(true), Some(10));
                core_t0(100);
                admitted();
                super::row(&row(3, json!({})));
                close_running(StageState::Failed, Some("PLAN_STEP_FAILED"), &[]);
                let receipt = Receipt::new(verb, "check-1", result, "cleaned", "now".into());
                let expected = receipt.to_json();
                end(&receipt, if result == ReceiptResult::Pass { 0 } else { 1 });
                finish();
                assert_eq!(receipt.to_json(), expected);
                assert_eq!(receipt.result, result);
                CURRENT.with(|current| assert!(current.borrow().is_none()));
                assert!(!path.exists());
            }
        }
    }

    #[test]
    fn envelope_order_and_fields() {
        let dir = temp("order");
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        ev.stage("preflight", StageState::Running, None, None);
        ev.run(
            "check-1",
            "check",
            "ios",
            &crate::client::detect(&crate::exec::MockRunner::new()),
            &[],
        );
        ev.attach(&path);
        ev.stage("preflight", StageState::Passed, None, None);
        ev.stage("prebuild", StageState::Skipped, None, None);
        ev.cmd("pnpm-install", Edge::Start, None, None);
        ev.cmd("pnpm-install", Edge::End, Some(true), Some(21400));
        ev.stage("attach", StageState::Running, None, None);
        ev.core_t0(1_770_000_000_000);
        ev.admitted();
        ev.row(&row(0, json!({})));
        ev.row(&row(3, json!({})));
        ev.end(&receipt(ReceiptResult::Pass), 0);
        ev.stage("cleanup", StageState::Running, None, None);
        ev.finish();

        let got = lines(&path);
        assert_eq!(
            names(&got),
            [
                "stage:preflight:running",
                "run",
                "stage:preflight:passed",
                "stage:prebuild:skipped",
                "cmd",
                "cmd",
                "stage:attach:running",
                "coreT0",
                "admitted",
                "stage:attach:passed",
                "stage:steps:running",
                "row",
                "row",
                "end",
            ]
        );
        for (i, e) in got.iter().enumerate() {
            assert_eq!(e.v, 1);
            assert_eq!(e.seq, i as u64 + 1, "seq strictly increasing in file order");
            assert!(e.at > 1_700_000_000_000);
        }
        assert!(got[2].payload["ms"].is_u64());
        assert!(got[3].payload.get("ms").is_none());
        assert_eq!(got[1].payload["runId"], "check-1");
        let mut expected = json!({
            "runId": "check-1", "verb": "check", "platform": "ios",
            "ownerPid": std::process::id(), "qarenVersion": token(env!("CARGO_PKG_VERSION")),
            "harness": "unknown", "markers": [], "flags": []
        });
        if let Some(commit) = option_env!("QAREN_BUILD_COMMIT") {
            expected["qarenCommit"] = token(commit).into();
        }
        assert_eq!(got[1].payload, expected);
        assert_eq!(got[1].payload["ownerPid"], std::process::id());
        assert_eq!(
            got[5].payload,
            json!({"label": "pnpm-install", "edge": "end", "ok": true, "ms": 21400})
        );
        assert_eq!(got[7].payload, json!({"t0": 1_770_000_000_000u64}));
        assert_eq!(got[8].payload, json!({}));
        assert_eq!(got[12].payload["line"], 3);
        assert_eq!(got[12].payload["timing"]["actMs"], 1100);
        let end = &got[13].payload;
        assert_eq!(end["result"], "pass");
        assert_eq!(end["expectedExit"], 0);
        assert_eq!(end["droppedEvents"], 0);
        assert_eq!(end["timingsMs"]["preflight"], 900);
        let file_mode = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777
        };
        assert_eq!(file_mode, 0o600);
    }

    #[test]
    fn run_identity_is_bounded_and_never_contains_session_or_flag_values() {
        let dir = temp("identity");
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        let client = Client {
            harness: "pi",
            markers: vec!["pi", "codex"],
            model: Some(format!("private/model name {}", "m".repeat(80))),
        };
        ev.run(
            "check-1",
            "pr",
            "ios",
            &client,
            &[
                "fresh_install",
                "boot_device",
                "restart_device",
                "shutdown_device_on_exit",
                "device",
                "pr",
            ],
        );
        ev.attach(&path);
        ev.finish();
        let payload = &lines(&path)[0].payload;
        assert_eq!(payload["harness"], "pi");
        assert_eq!(payload["markers"], json!(["pi", "codex"]));
        assert_eq!(
            payload["model"],
            format!("privatemodelname{}", "m".repeat(48))
        );
        assert_eq!(
            payload["flags"],
            json!([
                "fresh_install",
                "boot_device",
                "restart_device",
                "shutdown_device_on_exit",
                "device",
                "pr"
            ])
        );
        let mut keys: Vec<_> = payload
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.retain(|key| *key != "qarenCommit");
        assert_eq!(
            keys,
            [
                "flags",
                "harness",
                "markers",
                "model",
                "ownerPid",
                "platform",
                "qarenVersion",
                "runId",
                "verb"
            ]
        );
    }

    #[test]
    fn a_full_queue_drops_never_blocks_and_end_survives() {
        let dir = temp("full");
        let path = dir.join("events.jsonl");
        let (mut ev, gate) = Events::stalled();
        ev.attach(&path);
        let began = Instant::now();
        for _ in 0..5000 {
            ev.cmd("ps-scan", Edge::Start, None, None);
        }
        assert!(
            began.elapsed() < Duration::from_millis(50),
            "{:?}",
            began.elapsed()
        );
        ev.end(&receipt(ReceiptResult::Fail), 1);
        gate.send(()).unwrap();
        ev.finish();
        let got = lines(&path);
        let last = got.last().unwrap();
        assert_eq!(last.event, "end");
        assert!(last.payload["droppedEvents"].as_u64().unwrap() > 0);
        assert_eq!(
            got.len() as u64 - 1 + last.payload["droppedEvents"].as_u64().unwrap(),
            5000
        );
    }

    #[test]
    fn an_unwritable_file_never_fails_the_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("readonly");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        ev.attach(&path);
        ev.stage("preflight", StageState::Running, None, None);
        ev.row(&row(1, json!({})));
        ev.end(&receipt(ReceiptResult::Pass), 0);
        ev.finish();
        assert!(!path.exists());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn row_event_is_value_free() {
        let dir = temp("row");
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        ev.attach(&path);
        ev.row(&row(
            4,
            json!({
                "block": "canary-block", "ref": "canary-ref", "screenshot": "canary.png",
                "text": "Type \"canary-typed\" into \"Email\"", "reason": "canary-reason",
                "selector": {"id": "canary-id", "text": "canary-text"},
                "kind": "action\u{1b}[2Jcanary-escape-is-not-copied-verbatim"
            }),
        ));
        ev.finish();
        let raw = std::fs::read_to_string(&path).unwrap();
        for canary in [
            "canary-block",
            "canary-ref",
            "canary.png",
            "canary-typed",
            "canary-reason",
            "canary-id",
            "canary-text",
            "\\u001b",
        ] {
            assert!(!raw.contains(canary), "{canary} leaked: {raw}");
        }
        let got = lines(&path);
        assert_eq!(
            got[0]
                .payload
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            [
                "attempt",
                "kind",
                "line",
                "operationId",
                "outcome",
                "resolvedBy",
                "t",
                "timing"
            ]
        );
    }

    #[test]
    fn end_cleanup_is_allowlisted() {
        let dir = temp("cleanup");
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        ev.attach(&path);
        let mut r = receipt(ReceiptResult::Failed);
        r.outcomes
            .insert("core_exit".into(), "/Users/canary/app".into());
        r.cleanup.insert("metro".into(), "removed".into());
        r.cleanup.insert(
            "core".into(),
            "unresolved: pgid 9 at /Users/canary/x".into(),
        );
        r.cleanup.insert("recorder".into(), "canary-weird".into());
        r.cleanup.insert("canary_key".into(), "removed".into());
        r.failure = Some(Failure::new(
            "build",
            FailureCode::BuildFailed,
            "canary detail",
            "canary next",
        ));
        ev.end(&r, 1);
        ev.finish();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("canary"), "{raw}");
        let end = &lines(&path)[0].payload;
        assert_eq!(
            end["cleanup"],
            json!({"core": "unresolved", "metro": "removed", "recorder": "other"})
        );
        assert_eq!(end["failureCode"], "BUILD_FAILED");
        assert_eq!(end["failurePhase"], "build");
        assert_eq!(end["result"], "failed");
    }

    #[test]
    fn finish_failed_fails_every_running_stage() {
        let dir = temp("failrunning");
        let path = dir.join("events.jsonl");
        let mut ev = Events::start(None).unwrap();
        ev.attach(&path);
        ev.stage("recording", StageState::Running, None, None);
        ev.stage("steps", StageState::Running, None, None);
        ev.stage("verify", StageState::Passed, None, None);
        ev.close_running(StageState::Failed, Some("RUN_CANCELLED"), &[]);
        ev.stage("cleanup", StageState::Running, None, None);
        let mut r = receipt(ReceiptResult::Refused);
        r.failure = Some(Failure::new("walk", FailureCode::RunCancelled, "x", "y"));
        ev.end(&r, 4);
        ev.finish();
        let got = lines(&path);
        assert_eq!(
            names(&got),
            [
                "stage:recording:running",
                "stage:steps:running",
                "stage:verify:passed",
                "stage:recording:failed",
                "stage:steps:failed",
                "stage:cleanup:running",
                "stage:cleanup:failed",
                "end",
            ]
        );
        assert_eq!(got[3].payload["code"], "RUN_CANCELLED");
        assert_eq!(got[6].payload["code"], "RUN_CANCELLED");
    }

    #[test]
    fn a_run_that_ends_before_attach_writes_nothing_and_later_calls_are_ignored() {
        let dir = temp("noattach");
        let mut ev = Events::start(None).unwrap();
        ev.stage("preflight", StageState::Running, None, None);
        ev.end(&receipt(ReceiptResult::Failed), 1);
        ev.attach(&dir.join("late.jsonl"));
        ev.finish();
        assert!(!dir.join("late.jsonl").exists());
    }

    #[test]
    fn progress_off_keeps_events() {
        std::env::set_var("QAREN_PROGRESS", "off");
        crate::progress::enable();
        std::env::remove_var("QAREN_PROGRESS");
        let dir = temp("progressoff");
        let path = dir.join("logs").join("events.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        init();
        stage("preflight", StageState::Running, None, None);
        run(
            "check-1",
            "check",
            "ios",
            &crate::client::detect(&crate::exec::MockRunner::new()),
            &[],
        );
        attach(&path);
        stage("preflight", StageState::Passed, None, None);
        end(&receipt(ReceiptResult::Pass), 0);
        finish();
        stage("deps", StageState::Running, None, None);
        let got = lines(&path);
        assert_eq!(
            names(&got),
            [
                "stage:preflight:running",
                "run",
                "stage:preflight:passed",
                "end"
            ]
        );
    }
}
