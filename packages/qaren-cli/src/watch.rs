use crate::events::Envelope;
use crate::report::{prose, term_safe};
use crate::runrecord::{validate_run_id, PidLiveness, RunRecord};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{IsTerminal, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const STAGES: [(&str, &str); 11] = [
    ("preflight", "Preflight"),
    ("deps", "Dependencies"),
    ("build_decision", "Build decision"),
    ("prebuild", "Prebuild"),
    ("native_build", "Native compile"),
    ("install_launch_ready", "Install·launch·ready"),
    ("verify", "Verify"),
    ("attach", "Debugger attach"),
    ("steps", "Steps"),
    ("recording", "Recording"),
    ("cleanup", "Cleanup"),
];

pub enum Target {
    RunId(String),
    Latest,
}

pub struct WatchArgs {
    pub target: Target,
    pub plain: bool,
    pub json: bool,
}

struct Tail {
    path: PathBuf,
    offset: u64,
    carry: Vec<u8>,
}

impl Tail {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            carry: Vec::new(),
        }
    }

    fn lines(&mut self) -> Vec<String> {
        if !regular_file(&self.path) {
            return Vec::new();
        }
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        self.carry.extend(bytes);
        let Some(last) = self.carry.iter().rposition(|b| *b == b'\n') else {
            return Vec::new();
        };
        let rest = self.carry.split_off(last + 1);
        let lines = self.carry[..last]
            .split(|b| *b == b'\n')
            .filter_map(|b| std::str::from_utf8(b).ok().map(str::to_owned))
            .collect();
        self.carry = rest;
        lines
    }
}

enum Input {
    Event(Envelope),
}

fn parse_event(line: &str) -> Option<Input> {
    let envelope: Envelope = serde_json::from_str(line).ok()?;
    (envelope.v == 1
        && envelope.payload.is_object()
        && matches!(
            envelope.event.as_str(),
            "run" | "stage" | "cmd" | "admitted" | "coreT0" | "step" | "row" | "end"
        ))
    .then_some(Input::Event(envelope))
}

#[derive(Default, Serialize)]
struct Stage {
    name: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    #[serde(skip)]
    began: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    operation_id: u64,
    #[serde(skip)]
    seq: u64,
    line: u64,
    attempt: u64,
    kind: String,
    resolved_by: String,
    outcome: String,
    t: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<crate::core::RowTiming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Default)]
struct State {
    run_id: String,
    verb: String,
    platform: String,
    stages: BTreeMap<String, Stage>,
    rows: BTreeMap<u64, Step>,
    commands: Vec<String>,
    end: Option<Value>,
    first_ms: Option<u64>,
    now_ms: u64,
    core_t0: Option<u64>,
    owner_dead: bool,
    terminal: bool,
    seq: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Status {
    Live,
    Finished,
    Incomplete,
}

fn string(p: &Value, key: &str) -> String {
    term_safe(p[key].as_str().unwrap_or_default())
        .chars()
        .take(128)
        .collect()
}

impl State {
    fn status(&self) -> Status {
        if self.end.is_some() {
            Status::Finished
        } else if self.owner_dead {
            Status::Incomplete
        } else {
            Status::Live
        }
    }

    fn fold(&mut self, Input::Event(e): Input) {
        if e.seq <= self.seq || self.end.is_some() {
            return;
        }
        self.seq = e.seq;
        self.first_ms.get_or_insert(e.at);
        self.now_ms = self.now_ms.max(e.at);
        let p = &e.payload;
        match e.event.as_str() {
            "run" => {
                self.run_id = string(p, "runId");
                self.verb = string(p, "verb");
                self.platform = string(p, "platform");
            }
            "stage" => {
                let name = string(p, "name");
                let state = string(p, "state");
                if !STAGES.iter().any(|(n, _)| *n == name)
                    || !matches!(state.as_str(), "running" | "passed" | "failed" | "skipped")
                {
                    return;
                }
                let old = self.stages.get(&name);
                let began = if state == "running" {
                    e.at
                } else {
                    old.map_or(e.at, |s| s.began)
                };
                self.stages.insert(
                    name.clone(),
                    Stage {
                        name,
                        state,
                        code: p["code"].as_str().map(term_safe),
                        ms: p["ms"].as_u64(),
                        began,
                    },
                );
            }
            "step" => {
                let Some(line) = p["line"].as_u64().filter(|l| *l > 0) else {
                    return;
                };
                let Some(operation_id) = p["operationId"].as_u64().filter(|id| *id > 0) else {
                    return;
                };
                let attempt = self.rows.get(&operation_id).map_or(1, |s| s.attempt);
                self.rows.insert(
                    operation_id,
                    Step {
                        operation_id,
                        seq: e.seq,
                        line,
                        attempt,
                        kind: string(p, "kind"),
                        resolved_by: String::new(),
                        outcome: "running".into(),
                        t: p["t"].as_u64().unwrap_or(0),
                        timing: None,
                        text: None,
                    },
                );
            }
            "row" => {
                let Some(line) = p["line"].as_u64().filter(|l| *l > 0) else {
                    return;
                };
                let Some(attempt) = p["attempt"].as_u64() else {
                    return;
                };
                let Some(operation_id) = p["operationId"].as_u64().filter(|id| *id > 0) else {
                    return;
                };
                self.rows.insert(
                    operation_id,
                    Step {
                        operation_id,
                        seq: e.seq,
                        line,
                        attempt,
                        kind: string(p, "kind"),
                        resolved_by: string(p, "resolvedBy"),
                        outcome: string(p, "outcome"),
                        t: p["t"].as_u64().unwrap_or(0),
                        timing: serde_json::from_value(p["timing"].clone()).ok(),
                        text: None,
                    },
                );
            }
            "cmd" => {
                let label = string(p, "label");
                if p["edge"] == "start" {
                    self.commands.push(label)
                } else if p["edge"] == "end" {
                    if let Some(i) = self.commands.iter().rposition(|l| *l == label) {
                        self.commands.remove(i);
                    }
                }
            }
            "coreT0" => self.core_t0 = p["t0"].as_u64(),
            "end" => {
                let mut end = json!({"result": string(p, "result"), "phase": string(p, "phase"),
                    "expectedExit": p["expectedExit"].as_u64(), "droppedEvents": p["droppedEvents"].as_u64(),
                    "cleanup": {}, "timingsMs": {}});
                for key in ["failureCode", "failurePhase"] {
                    if p[key].is_string() {
                        end[key] = string(p, key).into();
                    }
                }
                for key in [
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
                ] {
                    if let Some(kind) = p["cleanup"][key].as_str() {
                        end["cleanup"][key] = if matches!(
                            kind,
                            "removed"
                                | "absent"
                                | "kept"
                                | "released"
                                | "retained"
                                | "unresolved"
                                | "refused"
                        ) {
                            kind
                        } else {
                            "other"
                        }
                        .into();
                    }
                }
                if let Some(timings) = p["timingsMs"].as_object() {
                    for (key, value) in timings {
                        if let Some(ms) = value.as_u64() {
                            end["timingsMs"][term_safe(key)] = ms.into();
                        }
                    }
                }
                self.end = Some(end);
                self.settle();
            }
            _ => {}
        }
    }

    // A line that started but never reported stays visible without claiming it still runs.
    fn settle(&mut self) {
        for step in self.rows.values_mut().filter(|s| s.outcome == "running") {
            step.outcome = "unfinished".into();
        }
    }

    fn apply_ledger(&mut self, ledger: &crate::core::Ledger) {
        if self.status() == Status::Live && !self.terminal {
            return;
        }
        for row in &ledger.steps {
            if let Some(step) = self
                .rows
                .get_mut(&row.operation_id)
                .filter(|s| s.attempt == row.attempt)
            {
                step.text = row
                    .text
                    .as_deref()
                    .map(|s| term_safe(&prose(&term_safe(s))));
                if let Some(reason) = &row.reason {
                    let text = step.text.get_or_insert_with(String::new);
                    text.push_str(&format!(" — {}", term_safe(&prose(&term_safe(reason)))));
                }
            }
        }
    }

    fn counts(&self) -> (usize, usize) {
        let passed = self.rows.values().filter(|s| s.outcome == "pass").count();
        let failed = self.rows.values().filter(|s| s.outcome == "fail").count();
        (passed, failed)
    }
}

fn duration(ms: u64) -> String {
    if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.)
    } else {
        format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
    }
}

fn mark(state: &str) -> char {
    match state {
        "running" => '▶',
        "passed" | "pass" => '✓',
        "failed" | "fail" => '✗',
        "skipped" => '–',
        "retry" => '↻',
        _ => '·',
    }
}

fn stage_line(s: &State, name: &str, label: &str) -> String {
    let Some(stage) = s.stages.get(name) else {
        return format!("· {label}");
    };
    let label = if name == "build_decision" {
        stage
            .code
            .as_ref()
            .map_or(label.to_string(), |c| format!("{label} → {c}"))
    } else {
        label.to_string()
    };
    let mut details = Vec::new();
    match stage.state.as_str() {
        "skipped" => details.push("not needed".to_string()),
        "running" => details.push(format!(
            "running {}",
            duration(s.now_ms.saturating_sub(stage.began))
        )),
        _ => {
            if name != "build_decision" {
                if let Some(code) = &stage.code {
                    details.push(code.clone());
                }
            }
            if name == "steps" {
                details.push(format!("{}/{} passed", s.counts().0, s.rows.len()));
            }
            if let Some(ms) = stage.ms {
                details.push(duration(ms));
            }
        }
    }
    if stage.ms.is_some()
        && stage.state != "running"
        && name != "steps"
        && (stage.code.is_none() || name == "build_decision")
    {
        format!(
            "{} {label:<32}{:>5}",
            mark(&stage.state),
            details.join("  ")
        )
    } else {
        format!("{} {label:<33}{}", mark(&stage.state), details.join("  "))
    }
}

fn step_line(s: &Step) -> String {
    let result = if matches!(s.outcome.as_str(), "running" | "unfinished") {
        s.outcome.clone()
    } else if s.attempt > 1 {
        format!("{} (attempt {})", s.resolved_by, s.attempt)
    } else {
        s.resolved_by.clone()
    };
    let timing = |ms: u64| {
        if ms == 0 {
            "—".to_string()
        } else {
            duration(ms)
        }
    };
    let (act, capture, jev) = s
        .timing
        .as_ref()
        .map_or((0, 0, 0), |t| (t.act_ms, t.capture_ms, t.jev_ms));
    let text = s.text.as_ref().map_or(String::new(), |t| format!("  {t}"));
    format!(
        "{} {:>5}  {:<8}  {result:<21}{:>6}  {:>7}  {:>7}{text}",
        mark(&s.outcome),
        s.line,
        s.kind,
        timing(act),
        timing(capture),
        timing(jev)
    )
}

fn verdict(s: &State) -> Option<String> {
    if let Some(end) = &s.end {
        let code = end["failureCode"]
            .as_str()
            .map_or(String::new(), |c| format!("  {c}"));
        let clean = end["cleanup"].as_object().is_some_and(|legs| {
            legs.values()
                .all(|v| matches!(v.as_str(), Some("removed" | "absent" | "kept" | "released")))
        });
        let drops = end["droppedEvents"].as_u64().unwrap_or(0);
        let dropped = if drops > 0 {
            format!("  telemetry incomplete ({drops} dropped events)")
        } else {
            String::new()
        };
        Some(format!(
            "VERDICT {}  (expected exit {}){code}  cleanup {}{dropped}",
            string(end, "result").to_uppercase(),
            end["expectedExit"],
            if clean { "clean" } else { "unclean" }
        ))
    } else if s.status() == Status::Incomplete {
        Some("ENDED WITHOUT FINAL EVENT (telemetry incomplete)".to_string())
    } else {
        None
    }
}

fn header(s: &State) -> String {
    format!("qaren watch  {}  {}  {}", s.run_id, s.verb, s.platform)
}

fn frame(s: &State, width: u16, height: u16) -> Vec<String> {
    let status = match s.status() {
        Status::Live => "LIVE",
        Status::Finished => "FINISHED",
        Status::Incomplete => "INCOMPLETE",
    };
    let mut lines = vec![
        format!(
            "{}  {status}  {}",
            header(s),
            duration(s.now_ms.saturating_sub(s.first_ms.unwrap_or(s.now_ms)))
        ),
        "STAGES".into(),
    ];
    let compact = width < 64 || height < 22;
    lines.extend(STAGES.iter().map(|(n, l)| {
        if compact {
            format!(
                "{} {l} {}",
                mark(s.stages.get(*n).map_or("", |st| st.state.as_str())),
                s.stages
                    .get(*n)
                    .map_or("unobserved", |st| st.state.as_str())
            )
        } else {
            stage_line(s, n, l)
        }
    }));
    let (passed, failed) = s.counts();
    lines.push(format!(
        "STEPS  {} lines  ✓{passed}  ✗{failed}",
        s.rows.len()
    ));
    if !compact {
        lines.push("   line  kind      result                  act  capture      jev".into());
    }
    let mut footer = Vec::new();
    if s.status() == Status::Live && !compact {
        footer.push("Step text appears when the run ends.".into());
    }
    if let Some(last) = verdict(s) {
        footer.push(last);
    } else if let Some(cmd) = s.commands.last() {
        footer.push(format!("now: {cmd}"));
    }
    let capacity = (height as usize).saturating_sub(1 + lines.len() + footer.len());
    let count = if s.rows.len() > capacity {
        capacity.saturating_sub(1)
    } else {
        s.rows.len()
    };
    let mut rows: Vec<_> = s.rows.values().collect();
    rows.sort_by_key(|row| {
        (
            matches!(row.outcome.as_str(), "pass" | "fail"),
            std::cmp::Reverse(row.seq),
        )
    });
    rows.truncate(count);
    rows.sort_by_key(|row| row.operation_id);
    let omitted = s.rows.len() - rows.len();
    if omitted > 0 {
        lines.push(format!("{omitted} rows omitted"));
    }
    lines.extend(rows.into_iter().map(|row| {
        if compact {
            format!(
                "{} line {} {} {}",
                mark(&row.outcome),
                row.line,
                row.kind,
                row.outcome
            )
        } else {
            step_line(row)
        }
    }));
    lines.extend(footer);
    lines
        .into_iter()
        .map(|l| {
            let mut cells = 0;
            term_safe(&l)
                .chars()
                .take_while(|c| {
                    // Budget two cells for non-ASCII, including wide glyphs and emoji.
                    cells += if c.is_ascii() { 1 } else { 2 };
                    cells < width as usize
                })
                .collect()
        })
        .collect()
}

fn terminal_dimensions() -> Option<(u16, u16)> {
    #[cfg(unix)]
    {
        let mut size: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == 0
            && size.ws_col > 0
            && size.ws_row > 0
        {
            return Some((size.ws_col, size.ws_row));
        }
    }
    None
}

fn plain(s: &State, printed: &mut HashSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    if printed.insert("header".into()) {
        out.push(header(s));
    }
    for step in s.rows.values() {
        let key = format!("row:{}:{}", step.operation_id, step.attempt);
        let text_key = format!("text:{}:{}", step.operation_id, step.attempt);
        if printed.contains(&key) && step.text.is_some() && printed.insert(text_key) {
            out.push(format!(
                "        line {}: {}",
                step.line,
                step.text.as_deref().unwrap_or_default()
            ));
        }
    }
    for (name, label) in STAGES {
        if s.stages.get(name).is_some_and(|st| st.state != "running")
            && printed.insert(format!("stage:{name}"))
        {
            out.push(stage_line(s, name, label));
        }
    }
    for step in s.rows.values() {
        if matches!(step.outcome.as_str(), "pass" | "fail")
            && printed.insert(format!("row:{}:{}", step.operation_id, step.attempt))
        {
            out.push(format!("  {}", step_line(step)));
            if step.text.is_some() {
                printed.insert(format!("text:{}:{}", step.operation_id, step.attempt));
            }
        }
    }
    if let Some(last) = verdict(s) {
        if printed.insert("verdict".into()) {
            out.push(last);
        }
    }
    out
}

fn snapshot(s: &State) -> Value {
    json!({"runId": s.run_id, "verb": s.verb, "platform": s.platform,
        "state": match s.status() { Status::Live => "live", Status::Finished => "finished", Status::Incomplete => "incomplete" },
        "stages": STAGES.iter().map(|(n, _)| s.stages.get(*n).map_or_else(|| json!({"name": n, "state": "unobserved"}), |stage| serde_json::to_value(stage).unwrap_or(Value::Null))).collect::<Vec<_>>(),
        "steps": s.rows.values().collect::<Vec<_>>(), "end": s.end})
}

fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && path
            .parent()
            .is_some_and(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
}

fn latest(root: &Path) -> Option<String> {
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_owned();
            let record = e.path().join("run.json");
            if validate_run_id(&id).is_err() || !regular_file(&record) {
                return None;
            }
            Some((std::fs::metadata(record).ok()?.modified().ok()?, id))
        })
        .max()
        .map(|(_, id)| id)
}

fn owner_alive(record: &RunRecord) -> bool {
    let Some(owner) = &record.prepare else {
        return true;
    };
    !matches!(
        crate::runrecord::probe_pid_identity(&mut crate::exec::RealRunner::new(), owner),
        PidLiveness::Dead | PidLiveness::AliveForeign
    )
}

fn follow(
    root: &Path,
    args: &WatchArgs,
    out: &mut dyn Write,
    alive: &mut dyn FnMut(Option<&RunRecord>) -> bool,
    poll: Duration,
    owner_every: Duration,
) -> u8 {
    let id = match &args.target {
        Target::RunId(id) if validate_run_id(id).is_ok() => id.clone(),
        Target::RunId(_) => return 2,
        Target::Latest => match latest(root) {
            Some(id) => id,
            None => return 1,
        },
    };
    let dir = root.join(&id);
    if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return 1;
    }
    let events = dir.join("logs/events.jsonl");
    if !regular_file(&events) {
        return 3;
    }
    let mut tail = Tail::new(events);
    let mut state = State {
        run_id: id,
        ..State::default()
    };
    let mut printed = HashSet::new();
    let record_path = dir.join("run.json");
    let mut record_mtime = None;
    let mut record: Option<RunRecord> = None;
    let mut ledger: Option<crate::core::Ledger> = None;
    let mut plain_mode = args.plain;
    let mut probed: Option<Instant> = None;
    loop {
        let mtime = regular_file(&record_path)
            .then(|| {
                std::fs::metadata(&record_path)
                    .ok()
                    .and_then(|m| m.modified().ok())
            })
            .flatten();
        if record_mtime != mtime && regular_file(&record_path) {
            record = std::fs::read(&record_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            record_mtime = mtime;
        }
        for line in tail.lines() {
            if let Some(input) = parse_event(&line) {
                state.fold(input);
            }
        }
        // A finished run cannot change status, and each owner probe spawns `ps`.
        if state.end.is_none() && probed.is_none_or(|at| at.elapsed() >= owner_every) {
            probed = Some(Instant::now());
            state.owner_dead = !alive(record.as_ref());
            if state.owner_dead {
                for line in tail.lines() {
                    if let Some(input) = parse_event(&line) {
                        state.fold(input);
                    }
                }
                state.settle();
            }
        }
        state.terminal = record.as_ref().is_some_and(|r| r.terminal.is_some());
        if state.status() == Status::Live {
            state.now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
        }
        if ledger.is_none() && (state.end.is_some() || state.terminal) {
            let path = dir.join("ledger.json");
            if regular_file(&path) {
                ledger = std::fs::read(path)
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok());
            }
        }
        if let Some(ledger) = &ledger {
            state.apply_ledger(ledger);
        }
        let dimensions = terminal_dimensions();
        plain_mode |= dimensions.is_none_or(|(width, height)| width < 32 || height < 18);
        let lines = if args.json {
            vec![snapshot(&state).to_string()]
        } else if plain_mode {
            plain(&state, &mut printed)
        } else {
            if write!(out, "\x1b[H\x1b[2J").is_err() {
                return 0;
            }
            let (width, height) = dimensions.unwrap();
            frame(&state, width, height)
        };
        for line in lines {
            if writeln!(out, "{line}").is_err() {
                return 0;
            }
        }
        if out.flush().is_err() {
            return 0;
        }
        if args.json || state.status() != Status::Live {
            return 0;
        }
        // ponytail: 250 ms polling; add file notification only if users report lag.
        std::thread::sleep(poll);
    }
}

pub fn watch(root: &Path, mut args: WatchArgs) -> u8 {
    args.plain |= !std::io::stdout().is_terminal()
        || std::env::var_os("CI").is_some()
        || std::env::var_os("NO_COLOR").is_some();
    follow(
        root,
        &args,
        &mut std::io::stdout().lock(),
        &mut |r| r.is_none_or(owner_alive),
        Duration::from_millis(250),
        Duration::from_secs(2),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: u64 = 1_791_540_900_000;

    #[test]
    fn failed_spawn_does_not_leave_a_current_command_during_cleanup() {
        use crate::exec::{CmdSpec, RealRunner, Runner};

        let dir = temp_runs("failed-command");
        let path = dir.join("events.jsonl");
        crate::events::init();
        crate::events::attach(&path);
        let mut runner = RealRunner::with_log_executable(dir.join("missing-log-helper"));
        for grouped in [false, true] {
            let spec = CmdSpec::new("core-walk", "/missing/private-canary", &[], 1);
            let log = dir.join("stderr.log");
            let failed = if grouped {
                runner.spawn_group(&spec, &log).is_err()
            } else {
                runner.spawn_piped(&spec, &log).is_err()
            };
            assert!(failed);
        }
        crate::events::stage("cleanup", crate::events::StageState::Running, None, None);
        crate::events::finish();
        let events: Vec<_> = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect();
        let started = folded(&events[..1]);
        assert!(frame(&started, 80, 24).contains(&"now: core-walk".to_string()));
        let finished = folded(&events);
        assert!(finished.commands.is_empty());
        for (width, height) in [(80, 24), (80, 20), (32, 18)] {
            let rendered = frame(&finished, width, height);
            assert!(!rendered.iter().any(|line| line.contains("now:")));
            assert!(rendered.iter().any(|line| line.contains("Cleanup")));
            assert!(rendered.len() < height as usize);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn grouped_command_completion_clears_current_label_during_cleanup() {
        let events = [
            line(1, 0, "cmd", json!({"label": "expo-start", "edge": "start"})),
            line(2, 1, "cmd", json!({"label": "core-walk", "edge": "start"})),
            line(
                3,
                2,
                "cmd",
                json!({"label": "core-walk", "edge": "end", "ok": true, "ms": 1}),
            ),
            stage(4, 3, "cleanup", "running", json!({})),
            line(
                5,
                4,
                "cmd",
                json!({"label": "expo-start", "edge": "end", "ok": false, "ms": 4}),
            ),
        ];
        assert!(frame(&folded(&events[..2]), 80, 24).contains(&"now: core-walk".to_string()));
        assert!(frame(&folded(&events[..4]), 80, 24).contains(&"now: expo-start".to_string()));
        let finished = folded(&events);
        assert!(finished.commands.is_empty());
        for (width, height) in [(80, 24), (80, 20), (32, 18)] {
            let rendered = frame(&finished, width, height);
            assert!(!rendered.iter().any(|line| line.contains("now:")));
            assert!(rendered.iter().any(|line| line.contains("Cleanup")));
            assert!(rendered.len() < height as usize);
        }
    }

    fn line(seq: u64, at: u64, event: &str, payload: Value) -> String {
        json!({"v": 1, "seq": seq, "event": event, "at": T + at, "payload": payload}).to_string()
    }

    fn stage(seq: u64, at: u64, name: &str, state: &str, extra: Value) -> String {
        let mut p = json!({"name": name, "state": state});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        line(seq, at, "stage", p)
    }

    fn row(
        seq: u64,
        line_no: u64,
        attempt: u64,
        outcome: &str,
        by: &str,
        timing: [u64; 3],
    ) -> String {
        let [act, cap, jev] = timing;
        line(
            seq,
            60_000 + line_no,
            "row",
            json!({
                "operationId": line_no, "line": line_no, "attempt": attempt, "kind": "action", "resolvedBy": by, "t": 0, "outcome": outcome,
                "timing": {"captureMs": cap, "nativeMs": 0, "reactMs": 0, "resolveMs": 0, "jevMs": jev,
                           "actMs": act, "postCaptureMs": 0, "otherMs": 0, "total": act + cap + jev}
            }),
        )
    }

    // A Reuse check, mid-walk: the 100-column live frame of the mock.
    fn reuse_check_live() -> Vec<String> {
        vec![
            stage(1, 0, "preflight", "running", json!({})),
            line(
                2,
                10,
                "run",
                json!({"runId": "check-20261009T081500Z", "verb": "check", "platform": "ios", "ownerPid": 4242}),
            ),
            stage(3, 900, "preflight", "passed", json!({"ms": 900})),
            stage(4, 900, "deps", "running", json!({})),
            line(
                5,
                1000,
                "cmd",
                json!({"label": "pnpm-install", "edge": "start"}),
            ),
            line(
                6,
                22000,
                "cmd",
                json!({"label": "pnpm-install", "edge": "end", "ok": true, "ms": 21000}),
            ),
            stage(7, 22300, "deps", "passed", json!({"ms": 21400})),
            stage(8, 22300, "build_decision", "running", json!({})),
            stage(
                9,
                22700,
                "build_decision",
                "passed",
                json!({"code": "reuse", "ms": 400}),
            ),
            stage(10, 22700, "prebuild", "skipped", json!({})),
            stage(11, 22700, "native_build", "skipped", json!({})),
            stage(12, 22700, "install_launch_ready", "running", json!({})),
            stage(
                13,
                33900,
                "install_launch_ready",
                "passed",
                json!({"ms": 11200}),
            ),
            stage(14, 33900, "verify", "running", json!({})),
            stage(15, 34200, "verify", "passed", json!({"ms": 300})),
            stage(16, 34200, "recording", "skipped", json!({})),
            line(17, 34300, "coreT0", json!({"t0": T + 34300})),
            stage(18, 34300, "attach", "running", json!({})),
            line(19, 37400, "admitted", json!({})),
            stage(20, 37400, "attach", "passed", json!({"ms": 3100})),
            stage(21, 37400, "steps", "running", json!({})),
            row(22, 0, 1, "pass", "startup", [0, 0, 0]),
            row(23, 3, 1, "pass", "exact", [1100, 600, 0]),
            row(24, 4, 1, "pass", "jev", [2000, 800, 400]),
            row(25, 5, 1, "retry", "exact", [0, 1400, 0]),
            row(26, 5, 2, "pass", "exact", [900, 700, 0]),
            row(27, 7, 1, "fail", "exact\u{1b}[2J", [0, 900, 0]),
            line(
                28,
                98000,
                "cmd",
                json!({"label": "simctl-io", "edge": "start"}),
            ),
        ]
    }

    fn folded(lines: &[String]) -> State {
        let mut state = State::default();
        for l in lines {
            if let Some(input) = parse_event(l) {
                state.fold(input);
            }
        }
        state.now_ms = T + 102_000;
        state
    }

    fn finish(lines: &mut Vec<String>, result: &str, code: Option<&str>) {
        let n = lines.len() as u64;
        lines.push(stage(
            n + 1,
            100_000,
            "steps",
            "failed",
            json!({"code": "PLAN_STEP_FAILED", "ms": 62600}),
        ));
        lines.push(stage(n + 2, 100_000, "cleanup", "running", json!({})));
        lines.push(stage(
            n + 3,
            102_000,
            "cleanup",
            "passed",
            json!({"ms": 2000}),
        ));
        let mut end = json!({"result": result, "phase": "cleaned", "timingsMs": {"total": 102000},
            "cleanup": {"core": "absent", "metro": "removed", "simulator": "kept", "device_lease": "removed"},
            "expectedExit": 1, "droppedEvents": 0});
        if let Some(code) = code {
            end["failureCode"] = code.into();
            end["failurePhase"] = "walk".into();
        }
        lines.push(line(n + 4, 102_000, "end", end));
    }

    fn ledger() -> crate::core::Ledger {
        let step = |line: u64, attempt: u64, outcome: &str, text: &str, reason: Option<&str>| {
            json!({"block": "plan", "operationId": line, "line": line, "attempt": attempt, "kind": "action", "resolvedBy": "exact",
                   "t": 0, "outcome": outcome, "text": text, "reason": reason})
        };
        serde_json::from_value(json!({
            "verdict": "FAIL", "path": "walk", "blocks": [],
            "steps": [
                step(0, 1, "pass", "startup", None),
                step(3, 1, "pass", "Tap \"Tasks\"", None),
                step(4, 1, "pass", "Type ••• into \"Email\"", None),
                step(5, 2, "pass", "Wait for \"Welcome\"", None),
                step(7, 1, "fail", "✓ \"Balance\"\u{1b}]0;pwned\u{7}", Some("TARGET_AMBIGUOUS")),
                step(8, 1, "pass", "never streamed", None),
            ],
            "jev": {"calls": 1, "medianMs": 400}, "llmTurns": 0, "escapes": 0, "recoveries": 0
        }))
        .unwrap()
    }

    #[test]
    fn login_plan_and_retry_identities_survive_every_view() {
        let root = temp_runs("operations");
        let path = root.join("check-1/logs/events.jsonl");
        let mut events = crate::events::Events::start(None).unwrap();
        events.attach(&path);
        let specs = [
            (1, 3, 1, "pass", "plan-three"),
            (2, 1, 1, "pass", "login-one"),
            (3, 2, 1, "pass", "login-two"),
            (4, 3, 1, "pass", "login-three"),
            (5, 4, 1, "retry", "plan-four-retry"),
            (5, 4, 2, "pass", "plan-four"),
        ];
        let mut ledger = ledger();
        ledger.steps.clear();
        for (id, line, attempt, outcome, text) in specs {
            let row: crate::core::Row = serde_json::from_value(json!({
                "operationId": id, "block": "private-block", "line": line,
                "attempt": attempt, "kind": "step", "resolvedBy": "exact",
                "t": 0, "outcome": outcome, "text": text
            }))
            .unwrap();
            events.row(&row);
            ledger.steps.push(row);
        }
        let receipt = crate::receipt::Receipt::new(
            "check",
            "check-1",
            crate::receipt::ReceiptResult::Pass,
            "cleaned",
            "now".into(),
        );
        events.end(&receipt, 0);
        events.finish();
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(!raw.contains("private-block") && !raw.contains("login-three"));
        let mut state = folded(&raw.lines().map(str::to_owned).collect::<Vec<_>>());
        assert_eq!(state.rows.len(), 5);
        assert_eq!(state.counts(), (5, 0));
        assert_eq!(state.rows[&5].attempt, 2);
        let mut printed = HashSet::new();
        let live_plain = plain(&state, &mut printed);
        assert_eq!(
            live_plain.iter().filter(|l| l.starts_with("  ✓")).count(),
            5
        );
        state.apply_ledger(&ledger);
        let texts = plain(&state, &mut printed);
        assert_eq!(texts.len(), 5);
        assert!(plain(&state, &mut printed).is_empty());
        let json = snapshot(&state);
        assert_eq!(json["steps"].as_array().unwrap().len(), 5);
        for (index, text) in [
            "plan-three",
            "login-one",
            "login-two",
            "login-three",
            "plan-four",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(json["steps"][index]["operationId"], index + 1);
            assert_eq!(json["steps"][index]["text"], *text);
            assert!(frame(&state, 200, 100)
                .iter()
                .any(|line| line.ends_with(text)));
            assert!(texts.iter().any(|line| line.ends_with(text)));
        }
    }

    #[test]
    fn replay_miss_and_completion_display_two_passed_operations() {
        let mut state = folded(&[
            row(1, 3, 1, "pass", "exact", [1, 1, 0]),
            row(2, 4, 1, "retry", "exact", [0, 1, 0]),
            row(3, 4, 1, "pass", "exact", [1, 1, 0]),
            stage(4, 100_000, "steps", "passed", json!({"ms": 3})),
            line(
                5,
                100_000,
                "end",
                json!({"result": "pass", "phase": "cleaned", "expectedExit": 0}),
            ),
        ]);
        state.apply_ledger(&ledger());
        assert_eq!(state.rows.len(), 2);
        assert_eq!(state.counts(), (2, 0));
        assert!(state.rows.values().all(|step| step.outcome == "pass"));
        let json = snapshot(&state);
        assert_eq!(json["steps"].as_array().unwrap().len(), 2);
        assert!(frame(&state, 200, 100)
            .iter()
            .any(|line| line.contains("2/2 passed")));
        let mut printed = HashSet::new();
        let output = plain(&state, &mut printed);
        assert_eq!(
            output.iter().filter(|line| line.starts_with("  ✓")).count(),
            2
        );
        assert!(!output.iter().any(|line| line.contains('↻')));
        assert!(plain(&state, &mut printed).is_empty());
    }

    #[test]
    fn dialog_recovery_completion_uses_sequence_order_after_attempt_reset() {
        for outcome in ["pass", "fail"] {
            let retry = row(2, 3, 2, "retry", "exact", [1, 1, 0]);
            let mut state = folded(&[row(1, 3, 1, "retry", "exact", [1, 1, 0]), retry.clone()]);
            let mut printed = HashSet::new();
            assert!(!plain(&state, &mut printed)
                .iter()
                .any(|line| line.starts_with("  ")));
            state.fold(parse_event(&row(3, 3, 1, outcome, "exact", [1, 1, 0])).unwrap());
            state.fold(parse_event(&retry).unwrap());
            state.fold(
                parse_event(&stage(
                    4,
                    100_000,
                    "steps",
                    if outcome == "pass" {
                        "passed"
                    } else {
                        "failed"
                    },
                    json!({"ms": 3}),
                ))
                .unwrap(),
            );
            state.fold(parse_event(&line(5, 100_000, "end",
                json!({"result": outcome, "phase": "cleaned", "expectedExit": if outcome == "pass" { 0 } else { 1 }}))).unwrap());
            let mut ledger = ledger();
            let mut completion = ledger.steps[1].clone();
            completion.outcome = outcome.into();
            let mut retried = completion.clone();
            retried.attempt = 2;
            retried.outcome = "retry".into();
            retried.reason = Some("recovered: dialog".into());
            ledger.steps = vec![retried, completion];
            state.apply_ledger(&ledger);
            assert_eq!(state.rows.len(), 1);
            let passed = usize::from(outcome == "pass");
            assert_eq!(state.counts(), (passed, 1 - passed));
            let snapshot = snapshot(&state);
            assert_eq!(snapshot["steps"][0]["outcome"], outcome);
            assert_eq!(snapshot["steps"][0]["attempt"], 1);
            assert_eq!(snapshot["steps"][0]["text"], "Tap \"Tasks\"");
            let frame = frame(&state, 200, 100);
            assert!(frame
                .iter()
                .any(|line| line.contains(&format!("{passed}/1 passed"))));
            let output = plain(&state, &mut printed);
            let rows: Vec<_> = output
                .iter()
                .filter(|line| line.starts_with("  "))
                .collect();
            assert_eq!(rows.len(), 1);
            assert!(rows[0].starts_with(&format!("  {}", mark(outcome))));
            assert!(rows[0].ends_with("Tap \"Tasks\""));
            assert!(plain(&state, &mut printed).is_empty());
            assert!(!frame
                .iter()
                .chain(&output)
                .any(|line| line.contains('↻') || line.contains("recovered: dialog")));
        }
    }

    #[test]
    fn term_safe_strips_c0_and_c1_controls() {
        assert_eq!(
            term_safe("a\u{1b}[2Jb\u{7}c\u{9b}d\u{7f}e\tf\ng·✓"),
            "a[2Jbcdefg·✓"
        );
    }

    #[test]
    fn folds_a_reuse_check_into_the_golden_frame() {
        let state = folded(&reuse_check_live());
        assert_eq!(state.status(), Status::Live);
        let got = frame(&state, 100, 100);
        let golden = [
            "qaren watch  check-20261009T081500Z  check  ios  LIVE  1:42",
            "STAGES",
            "✓ Preflight                        0.9s",
            "✓ Dependencies                    21.4s",
            "✓ Build decision → reuse           0.4s",
            "– Prebuild                         not needed",
            "– Native compile                   not needed",
            "✓ Install·launch·ready            11.2s",
            "✓ Verify                           0.3s",
            "✓ Debugger attach                  3.1s",
            "▶ Steps                            running 1:04",
            "– Recording                        not needed",
            "· Cleanup",
            "STEPS  4 lines  ✓3  ✗1",
            "   line  kind      result                  act  capture      jev",
            "✓     3  action    exact                  1.1s     0.6s        —",
            "✓     4  action    jev                    2.0s     0.8s     0.4s",
            "✓     5  action    exact (attempt 2)      0.9s     0.7s        —",
            "✗     7  action    exact[2J                  —     0.9s        —",
            "Step text appears when the run ends.",
            "now: simctl-io",
        ];
        assert_eq!(got, golden);
        assert!(frame(&state, 20, 100)
            .iter()
            .all(|l| l.chars().count() <= 20));
    }

    #[test]
    fn bounded_frame_keeps_current_rows_and_counts_every_omission() {
        let mut events = reuse_check_live();
        for n in 1..=40 {
            events.push(row(
                100 + n,
                n,
                1,
                if n == 1 { "running" } else { "pass" },
                "exact",
                [0, 0, 0],
            ));
        }
        let state = folded(&events);
        let lines = frame(&state, 80, 24);
        assert_eq!(lines.len(), 23);
        assert!(lines.contains(&"35 rows omitted".to_string()), "{lines:#?}");
        assert!(
            lines.iter().any(|l| l.contains("    1  action")),
            "{lines:#?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("   40  action")),
            "{lines:#?}"
        );
        for (_, label) in STAGES {
            assert!(lines.iter().any(|l| l.contains(label)));
        }
        assert_eq!(snapshot(&state)["steps"].as_array().unwrap().len(), 40);
    }

    #[test]
    fn bounded_frame_retains_late_recovery_completions() {
        for outcome in ["pass", "fail"] {
            let mut events = vec![row(1, 1, 1, "retry", "exact", [0, 0, 0])];
            for operation in 2..=7 {
                events.push(row(operation, operation, 1, "pass", "exact", [0, 0, 0]));
            }
            events.push(row(8, 1, 1, outcome, "exact", [0, 0, 0]));
            let mut state = folded(&events);
            state.fold(parse_event(&events[0]).unwrap());
            for (width, height, retained) in [(80, 22, 4), (80, 18, 2), (32, 18, 2)] {
                let lines = frame(&state, width, height);
                let expected = if height < 22 {
                    format!("{} line 1 action {outcome}", mark(outcome))
                } else {
                    step_line(&state.rows[&1])
                };
                assert!(lines.contains(&expected), "{width}x{height}: {lines:#?}");
                let recent_login = if height < 22 {
                    "✓ line 7 action pass".to_string()
                } else {
                    step_line(&state.rows[&7])
                };
                assert!(
                    lines.contains(&recent_login),
                    "{width}x{height}: {lines:#?}"
                );
                assert!(lines.contains(&format!("{} rows omitted", 7 - retained)));
                assert!(lines.len() < height as usize);
                for (_, label) in STAGES {
                    assert!(lines.iter().any(|line| line.contains(label)));
                }
            }
            let json = snapshot(&state);
            assert_eq!(json["steps"].as_array().unwrap().len(), 7);
            assert_eq!(json["steps"][0]["outcome"], outcome);
            assert_eq!(
                json["steps"][0],
                json!({"operationId": 1, "line": 1, "attempt": 1, "kind": "action",
                    "resolvedBy": "exact", "outcome": outcome, "t": 0,
                    "timing": {"captureMs": 0, "nativeMs": 0, "reactMs": 0,
                        "resolveMs": 0, "jevMs": 0, "actMs": 0,
                        "postCaptureMs": 0, "otherMs": 0, "total": 0}})
            );
            let plain = plain(&state, &mut HashSet::new());
            assert!(plain.contains(&format!("  {}", step_line(&state.rows[&1]))));
            assert_eq!(
                plain.iter().filter(|line| line.starts_with("  ")).count(),
                7
            );
        }
    }

    #[test]
    fn wide_final_text_cannot_wrap_a_bounded_frame() {
        let mut events = reuse_check_live();
        finish(&mut events, "pass", None);
        let mut state = folded(&events);
        state.rows.values_mut().next().unwrap().text = Some("界😀".repeat(100));
        let lines = frame(&state, 80, 24);
        assert!(lines.iter().any(|l| l.contains('界')));
        for line in lines {
            let cells: usize = line
                .chars()
                .map(|c| if matches!(c, '界' | '😀') { 2 } else { 1 })
                .sum();
            assert!(cells < 80, "{line}");
        }
    }

    #[test]
    fn finished_view_takes_text_only_from_the_ledger() {
        let mut lines = reuse_check_live();
        let live = folded(&lines);
        let rendered =
            frame(&live, 200, 100).join("\n") + &plain(&live, &mut HashSet::new()).join("\n");
        assert!(
            !rendered.contains("Tasks") && !rendered.contains("Email"),
            "{rendered}"
        );
        assert!(!serde_json::to_string(&snapshot(&live))
            .unwrap()
            .contains("Tasks"));

        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        assert_eq!(done.status(), Status::Finished);
        done.apply_ledger(&ledger());
        let got = frame(&done, 200, 100);
        assert_eq!(
            got[0],
            "qaren watch  check-20261009T081500Z  check  ios  FINISHED  1:42"
        );
        assert!(got.contains(&"✓     4  action    jev                    2.0s     0.8s     0.4s  Type ••• into \"Email\"".to_string()), "{got:#?}");
        assert!(got.contains(&"✗     7  action    exact[2J                  —     0.9s        —  ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS".to_string()), "{got:#?}");
        assert!(
            got.contains(
                &"✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02"
                    .to_string()
            ),
            "{got:#?}"
        );
        assert_eq!(
            got.last().unwrap(),
            "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean"
        );
        assert!(!got.join("\n").contains("never streamed"));
        assert!(!got.join("\n").contains('\u{1b}') && !got.join("\n").contains('\u{7}'));
    }

    #[test]
    fn plain_prints_each_final_item_once_without_escapes() {
        let mut lines = reuse_check_live();
        let mut printed = HashSet::new();
        let first = plain(&folded(&lines[..8]), &mut printed);
        assert_eq!(
            first,
            [
                "qaren watch  check-20261009T081500Z  check  ios",
                "✓ Preflight                        0.9s",
                "✓ Dependencies                    21.4s",
            ]
        );
        assert!(plain(&folded(&lines[..8]), &mut printed).is_empty());
        let middle = plain(&folded(&lines), &mut printed);
        assert_eq!(middle[0], "✓ Build decision → reuse           0.4s");
        assert!(
            middle.contains(
                &"  ✗     7  action    exact[2J                  —     0.9s        —".to_string()
            ),
            "{middle:#?}"
        );
        assert!(!middle
            .iter()
            .any(|l| l.contains("Steps") || l.contains("Cleanup")));
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let last = plain(&done, &mut printed);
        assert_eq!(
            last,
            [
                "        line 3: Tap \"Tasks\"",
                "        line 4: Type ••• into \"Email\"",
                "        line 5: Wait for \"Welcome\"",
                "        line 7: ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS",
                "✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02",
                "✓ Cleanup                          2.0s",
                "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean",
            ]
        );
        assert!(plain(&done, &mut printed).is_empty());
        for l in first.iter().chain(&middle).chain(&last) {
            assert!(!l.chars().any(|c| c.is_control()), "{l:?}");
        }
    }

    #[test]
    fn a_finished_run_watched_later_prints_the_text_with_each_row() {
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let out = plain(&done, &mut HashSet::new());
        assert!(out.contains(&"  ✓     3  action    exact                  1.1s     0.6s        —  Tap \"Tasks\"".to_string()), "{out:#?}");
        assert!(!out.iter().any(|l| l.starts_with("        line")));
    }

    fn temp_runs(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qaren-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("check-1").join("logs")).unwrap();
        root
    }

    fn args(plain: bool, json: bool) -> WatchArgs {
        WatchArgs {
            target: Target::RunId("check-1".into()),
            plain,
            json,
        }
    }

    fn follow_out(root: &Path, args: WatchArgs, alive: bool) -> (u8, String) {
        let mut out = Vec::new();
        let code = follow(
            root,
            &args,
            &mut out,
            &mut |_| alive,
            Duration::ZERO,
            Duration::ZERO,
        );
        (code, String::from_utf8(out).unwrap())
    }

    #[test]
    fn owner_dead_without_end_reports_incomplete() {
        let root = temp_runs("dead");
        let lines = reuse_check_live();
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        let (code, out) = follow_out(&root, args(true, false), false);
        assert_eq!(code, 0);
        assert!(
            out.ends_with("ENDED WITHOUT FINAL EVENT (telemetry incomplete)\n"),
            "{out}"
        );
        assert!(out.contains("✓ Verify"));
        assert!(!out.contains('\u{1b}'));
        let (code, out) = follow_out(&root, args(false, true), false);
        assert_eq!(code, 0);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["state"], "incomplete");
        assert_eq!(
            v["stages"][2],
            json!({"name": "build_decision", "state": "passed", "code": "reuse", "ms": 400})
        );
        assert_eq!(v["steps"][3]["line"], 7);
        assert!(v["steps"][3].get("text").is_none());
    }

    #[test]
    fn terminal_ledger_projects_delayed_rows_before_rendering() {
        for is_plain in [false, true] {
            let root = temp_runs(if is_plain {
                "delayed-plain"
            } else {
                "delayed-frame"
            });
            let dir = root.join("check-1");
            let events = dir.join("logs/events.jsonl");
            let initial = [
                row(1, 3, 1, "retry", "exact", [0, 0, 0]),
                row(2, 4, 1, "pass", "exact", [0, 0, 0]),
            ];
            std::fs::write(&events, initial.join("\n") + "\n").unwrap();
            std::fs::write(
                dir.join("ledger.json"),
                serde_json::to_vec(&ledger()).unwrap(),
            )
            .unwrap();
            let (_, live) = follow_out(&root, args(false, true), true);
            let live: Value = serde_json::from_str(&live).unwrap();
            assert!(live["steps"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s.get("text").is_none()));
            let record: RunRecord = serde_json::from_value(json!({
                "schema": "qaren-run/1", "run_id": "check-1", "created_at": "2026-10-09T08:15:00Z",
                "scenario": {"schema": "qaren/1", "name": "test", "platform": "ios",
                    "candidate": {"project_root": ".", "app_id": "test", "revision": "HEAD"}},
                "scenario_path": "scenario.yaml", "scenario_sha256": "0",
                "candidate": {"repo_root": ".", "project_root": ".", "app_id": "test",
                    "git_sha": "0", "git_dirty": false, "lockfile_sha256": null},
                "phase": "cleaned", "prepare": null,
                "terminal": {"verdict": "PASS", "cancelled": false, "ownershipProven": true,
                    "finalVerification": {"tested": "0", "match": true}}
            }))
            .unwrap();
            std::fs::write(dir.join("run.json"), serde_json::to_vec(&record).unwrap()).unwrap();
            let mut tick = 0;
            let mut out = Vec::new();
            let code = follow(
                &root,
                &args(is_plain, false),
                &mut out,
                &mut |r| {
                    assert!(r.unwrap().terminal.is_some());
                    tick += 1;
                    let delayed = match tick {
                        1 => vec![
                            row(3, 3, 1, "pass", "exact", [0, 0, 0]),
                            row(4, 4, 1, "pass", "exact", [0, 0, 0]),
                        ],
                        2 => vec![line(
                            5,
                            1000,
                            "end",
                            json!({"result": "pass", "exit": 0, "cleanup": "clean"}),
                        )],
                        _ => Vec::new(),
                    };
                    if !delayed.is_empty() {
                        writeln!(
                            std::fs::OpenOptions::new()
                                .append(true)
                                .open(&events)
                                .unwrap(),
                            "{}",
                            delayed.join("\n")
                        )
                        .unwrap();
                    }
                    assert!(tick <= 2);
                    true
                },
                Duration::ZERO,
                Duration::ZERO,
            );
            assert_eq!(code, 0);
            assert_eq!(tick, 2);
            let out = String::from_utf8(out).unwrap();
            assert!(out.contains("Tap \"Tasks\""), "{out}");
            assert!(out.contains("Type ••• into \"Email\""), "{out}");
            assert!(!out.contains("never streamed"));
            if is_plain {
                assert_eq!(out.matches("Tap \"Tasks\"").count(), 1);
                assert_eq!(out.matches("Type ••• into \"Email\"").count(), 1);
                assert!(!out.contains('\u{1b}'));
            }
            let (_, out) = follow_out(&root, args(false, true), true);
            let snapshot: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(snapshot["state"], "finished");
            assert_eq!(snapshot["steps"].as_array().unwrap().len(), 2);
            assert_eq!(snapshot["steps"][0]["text"], "Tap \"Tasks\"");
            assert_eq!(snapshot["steps"][1]["text"], "Type ••• into \"Email\"");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn a_started_step_shows_as_running_until_its_outcome_folds_into_the_row() {
        let mut lines = reuse_check_live();
        lines.truncate(26);
        lines.push(line(
            27,
            97_000,
            "step",
            json!({"operationId": 7, "line": 7, "kind": "action", "t": 0}),
        ));
        let live = folded(&lines);
        let rendered = frame(&live, 100, 30);
        assert!(
            rendered
                .iter()
                .any(|l| l.starts_with("▶     7  action    running")),
            "{rendered:#?}"
        );
        assert!(!plain(&live, &mut HashSet::new())
            .iter()
            .any(|l| l.contains("running")));
        let steps = snapshot(&live)["steps"].clone();
        let started = steps
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["operationId"] == 7);
        assert_eq!(started.unwrap()["outcome"], "running");
        lines.push(row(28, 7, 1, "pass", "exact", [500, 400, 0]));
        let done = folded(&lines);
        let rendered = frame(&done, 100, 30);
        assert!(
            !rendered.iter().any(|l| l.contains("action    running")),
            "{rendered:#?}"
        );
        assert!(rendered
            .iter()
            .any(|l| l.starts_with("✓     7  action    exact")));
        assert_eq!(done.rows.len(), live.rows.len());
        lines.truncate(27);
        finish(&mut lines, "fail", Some("RUN_CANCELLED"));
        let ended = folded(&lines);
        let rendered = frame(&ended, 100, 30);
        assert!(
            rendered
                .iter()
                .any(|l| l.starts_with("·     7  action    unfinished")),
            "{rendered:#?}"
        );
        assert!(!rendered.iter().any(|l| l.contains("action    running")));
    }

    #[test]
    fn a_finished_run_never_probes_its_owner() {
        let root = temp_runs("finished-no-probe");
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        for (is_plain, json) in [(false, true), (true, false)] {
            let mut probes = 0;
            let code = follow(
                &root,
                &args(is_plain, json),
                &mut Vec::new(),
                &mut |_| {
                    probes += 1;
                    true
                },
                Duration::ZERO,
                Duration::ZERO,
            );
            assert_eq!((code, probes), (0, 0));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_live_owner_is_probed_once_per_interval_not_per_redraw() {
        let root = temp_runs("probe-interval");
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            reuse_check_live().join("\n") + "\n",
        )
        .unwrap();
        let started = Instant::now();
        let mut probes = 0;
        let code = follow(
            &root,
            &args(true, false),
            &mut Vec::new(),
            &mut |_| {
                probes += 1;
                probes < 3
            },
            Duration::from_millis(1),
            Duration::from_millis(40),
        );
        assert_eq!((code, probes), (0, 3));
        assert!(started.elapsed() >= Duration::from_millis(80));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_finished_run_is_printed_once_with_ledger_text() {
        let root = temp_runs("finished");
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        std::fs::write(
            root.join("check-1/ledger.json"),
            serde_json::to_string(&ledger()).unwrap(),
        )
        .unwrap();
        let (code, out) = follow_out(&root, args(true, false), true);
        assert_eq!(code, 0);
        assert!(out.contains("Type ••• into \"Email\""), "{out}");
        assert!(out.ends_with("VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean\n"));
        let (_, json_out) = follow_out(&root, args(false, true), true);
        let v: Value = serde_json::from_str(&json_out).unwrap();
        assert_eq!(v["state"], "finished");
        assert_eq!(v["end"]["result"], "fail");
        assert_eq!(v["steps"][1]["text"], "Type ••• into \"Email\"");
    }

    #[test]
    fn missing_events_is_unavailable_exit_3() {
        let root = temp_runs("missing");
        assert_eq!(follow_out(&root, args(true, false), true).0, 3);
        let none = WatchArgs {
            target: Target::RunId("check-2".into()),
            plain: true,
            json: false,
        };
        assert_eq!(follow_out(&root, none, true).0, 1);
        let bad = WatchArgs {
            target: Target::RunId("../etc".into()),
            plain: true,
            json: false,
        };
        assert_eq!(follow_out(&root, bad, true).0, 2);
        assert_eq!(
            follow_out(
                &root.join("absent"),
                WatchArgs {
                    target: Target::Latest,
                    plain: true,
                    json: false
                },
                true
            )
            .0,
            1
        );
    }

    #[test]
    fn latest_is_the_newest_run_record() {
        let root = temp_runs("latest");
        let newest = "check-20261009T081500Z-000001";
        std::fs::create_dir_all(root.join(newest).join("logs")).unwrap();
        std::fs::write(root.join("check-1/run.json"), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join(newest).join("run.json"), "{}").unwrap();
        std::fs::write(root.join(newest).join("logs/events.jsonl"), "").unwrap();
        std::fs::create_dir_all(root.join("check-3")).unwrap();
        for id in ["check.latest", "check_latest", "-check"] {
            std::fs::create_dir_all(root.join(id)).unwrap();
            std::fs::write(root.join(id).join("run.json"), "{}").unwrap();
        }
        assert_eq!(latest(&root).as_deref(), Some(newest));
        for target in [Target::Latest, Target::RunId(newest.into())] {
            let (code, out) = follow_out(
                &root,
                WatchArgs {
                    target,
                    plain: false,
                    json: true,
                },
                false,
            );
            assert_eq!(code, 0);
            let snapshot: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(snapshot["runId"], newest);
        }
    }

    #[test]
    fn the_tail_keeps_a_partial_line_until_it_completes() {
        let root = temp_runs("tail");
        let path = root.join("check-1/logs/events.jsonl");
        std::fs::write(&path, "one\ntw").unwrap();
        let mut tail = Tail::new(path.clone());
        assert_eq!(tail.lines(), ["one"]);
        assert!(tail.lines().is_empty());
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"o\nthree\n")
            .unwrap();
        assert_eq!(tail.lines(), ["two", "three"]);
    }
}
