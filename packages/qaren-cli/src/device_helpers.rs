//! Classify Android SDK emulator helpers and recover only proven same-user orphans.
use crate::exec::{CmdSpec, Runner};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// `ps -o` columns: the doctor process list and the run-start scan read the same shape.
pub const PROCESS_COLUMNS: &str = "pid=,ppid=,uid=,pcpu=,stat=,lstart=,ucomm=,args=";
const FIXED_WORDS: usize = 10;
const HOT_CPU: f64 = 100.0;
// Bounds the scan when other processes name many folders: at most this many 2 s package reads.
const MAX_PACKAGE_READS: usize = 4;
// Only a regular file is read, so a FIFO or device named source.properties cannot block the read.
const PACKAGE_READ: &str = "test -f \"$1\" && exec head -c 4096 \"$1\"";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HelperName {
    Netsimd,
    CrashpadHandler,
}

impl HelperName {
    fn as_str(self) -> &'static str {
        match self {
            HelperName::Netsimd => "netsimd",
            HelperName::CrashpadHandler => "crashpad_handler",
        }
    }
}

/// Why a proven SDK helper may be stopped or must be left alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Class {
    Orphan,
    Unproven,
    OtherUser,
    HasParent,
    Serving,
}

impl Class {
    fn as_str(self) -> &'static str {
        match self {
            Self::Orphan => "orphan",
            Self::Unproven => "unproven",
            Self::OtherUser => "other-user",
            Self::HasParent => "has-parent",
            Self::Serving => "serving",
        }
    }
    pub fn fix(self) -> &'static str {
        match self {
            Self::Orphan => "nothing to do by hand: the next `qaren check`, `qaren pr`, `qaren prepare` or `qaren cleanup <run id>` stops it and records it",
            Self::OtherUser => "it belongs to another user of this machine; ask that user to stop it",
            Self::Serving => "its emulator is running; ask the device owner to restart that emulator",
            Self::HasParent => "another running program started it; stop it from that program",
            Self::Unproven => "QaReN could not read the whole process list, so it leaves this alone; run `qaren doctor` again",
        }
    }
    fn listed(self, cpu: f64) -> bool {
        matches!(self, Self::Orphan | Self::Unproven | Self::OtherUser) || cpu > HOT_CPU
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Listed,
    StoppedTerm,
    StoppedKill,
    SurvivedKill,
    LeftAlone,
    Unknown,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Listed => "listed",
            Self::StoppedTerm => "stopped-term",
            Self::StoppedKill => "stopped-kill",
            Self::SurvivedKill => "survived-kill",
            Self::LeftAlone => "left-alone",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Signal {
    Term,
    Kill,
}

/// Fixed facts only; optional additions keep older saved receipts readable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub name: HelperName,
    pub pid: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub class: Option<Class>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signals: Option<Vec<Signal>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub name: HelperName,
    pub pid: u32,
    pub cpu: f64,
    pub class: Class,
    pub outcome: Outcome,
    pub signals: Vec<Signal>,
    start: String,
}

/// What one listing found, and whether every line of it could be read.
#[derive(Debug, Clone, PartialEq)]
pub struct Scan {
    pub helpers: Vec<Finding>,
    pub complete: bool,
}

impl Finding {
    pub fn hot(&self) -> bool {
        self.cpu > HOT_CPU
    }

    pub fn note(&self) -> Note {
        Note {
            name: self.name,
            pid: self.pid,
            cpu: Some(self.cpu.round() as u64),
            class: Some(self.class),
            outcome: Some(self.outcome),
            signals: Some(self.signals.clone()),
        }
    }

    pub fn describe(&self) -> String {
        format!(
            "{} (pid {}, {:.1}% CPU): {}",
            self.name.as_str(),
            self.pid,
            self.cpu,
            self.class.as_str()
        )
    }
}

/// One row of a `PROCESS_COLUMNS` listing.
pub struct Process<'a> {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub start: String,
    pub cpu: f64,
    pub stat: &'a str,
    pub ucomm: &'a str,
    pub args: &'a str,
}

impl Process<'_> {
    /// The AVD of a local Android emulator process (`qemu-system-*` with `-avd`).
    pub fn emulator_avd(&self) -> Option<&str> {
        if !self.ucomm.starts_with("qemu-system-") {
            return None;
        }
        let words: Vec<_> = self.args.split_whitespace().collect();
        Some(words.windows(2).find(|pair| pair[0] == "-avd")?[1])
    }

    // Running or starting, of any user and in any state; a look-alike name errs on the safe side.
    fn is_emulator(&self) -> bool {
        self.ucomm.starts_with("qemu-system-") || self.ucomm.starts_with("emulator")
    }

    /// The helper's name and the folder its executable sits in.
    fn helper(&self) -> Option<(HelperName, &str)> {
        // `ucomm` may be cut to 15 characters.
        let name = if self.ucomm == "netsimd" {
            HelperName::Netsimd
        } else if self.ucomm.starts_with("crashpad_handle") {
            HelperName::CrashpadHandler
        } else {
            return None;
        };
        if self.pid <= 1 || self.pid > i32::MAX as u32 || !self.args.starts_with('/') {
            return None;
        }
        // Cut at the first `/<name>` that ends a word: SDK paths may hold spaces or the name.
        let file = format!("/{}", name.as_str());
        let at = self
            .args
            .match_indices(&file)
            .map(|(at, _)| at)
            .find(|&at| {
                self.args[at + file.len()..]
                    .chars()
                    .next()
                    .is_none_or(char::is_whitespace)
            })?;
        Some((name, &self.args[..at]))
    }
}

pub struct ProcessList<'a> {
    pub rows: Vec<Process<'a>>,
    /// False when a line could not be read: it may hide an emulator.
    pub complete: bool,
}

/// Text after the first `skip` whitespace-separated columns, keeping spaces inside it.
fn after_columns(line: &str, skip: usize) -> &str {
    let mut rest = line.trim_start();
    for _ in 0..skip {
        rest = rest
            .split_once(char::is_whitespace)
            .map_or("", |(_, tail)| tail.trim_start());
    }
    rest
}

fn process(line: &str) -> Option<Process<'_>> {
    let words: Vec<_> = line.split_whitespace().take(FIXED_WORDS + 1).collect();
    if words.len() <= FIXED_WORDS {
        return None;
    }
    Some(Process {
        pid: words[0].parse().ok()?,
        ppid: words[1].parse().ok()?,
        // macOS ps prints nobody's uid 4294967294 as -2.
        uid: words[2]
            .parse()
            .or_else(|_| words[2].parse::<i32>().map(|v| v as u32))
            .ok()?,
        start: words[5..10].join(" "),
        cpu: words[3]
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite() && *v >= 0.0)?,
        stat: words[4],
        ucomm: words[FIXED_WORDS],
        args: after_columns(line, FIXED_WORDS + 1),
    })
}

/// Reads a `PROCESS_COLUMNS` listing; None when no line reads as a process.
pub fn parse(text: &str) -> Option<ProcessList<'_>> {
    let mut complete = true;
    let rows: Vec<_> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let row = process(line);
            complete &= row.is_some();
            row
        })
        .collect();
    (!rows.is_empty()).then_some(ProcessList { rows, complete })
}

// Other apps ship same-named programs: only the SDK's own emulator package holds the helpers.
fn emulator_package(runner: &mut dyn Runner, label: &str, folder: &str) -> bool {
    let path = format!("{folder}/source.properties");
    // The path is a positional argument, never shell text.
    let output = runner.run(
        &CmdSpec::new(
            label,
            "/bin/sh",
            &["-c", PACKAGE_READ, "sh", path.as_str()],
            2,
        )
        .cwd(Path::new("/"))
        .env("LC_ALL", "C"),
    );
    output.ok()
        && output
            .stdout
            .lines()
            .any(|line| line.trim() == "Pkg.Path=emulator")
}

/// Classifies the full list before filtering for display. The caller owns cached package
/// evidence and the deadline; refreshes never issue package reads.
fn classify(
    runner: &mut dyn Runner,
    label: &str,
    text: &str,
    uid: u32,
    packages: &mut HashMap<String, bool>,
    deadline: Option<u64>,
    read_packages: bool,
) -> Option<Scan> {
    let list = parse(text)?;
    let serving = list.rows.iter().any(Process::is_emulator);
    let mut helpers = Vec::new();
    let mut network_unproven = false;
    for row in &list.rows {
        let Some((name, folder)) = row.helper() else {
            continue;
        };
        if serving && row.cpu <= HOT_CPU {
            continue;
        }
        if !packages.contains_key(folder)
            && read_packages
            && packages.len() < MAX_PACKAGE_READS
            && deadline.is_none_or(|end| runner.monotonic_ms() < end)
        {
            let proven = emulator_package(runner, label, folder);
            packages.insert(folder.to_string(), proven);
        }
        let Some(proven) = packages.get(folder) else {
            network_unproven |= name == HelperName::Netsimd;
            continue;
        };
        if !proven {
            continue;
        }
        let class = if serving {
            Class::Serving
        } else if !list.complete {
            Class::Unproven
        } else if row.ppid != 1 {
            Class::HasParent
        } else if row.uid != uid {
            Class::OtherUser
        } else {
            Class::Orphan
        };
        helpers.push(Finding {
            name,
            pid: row.pid,
            cpu: row.cpu,
            class,
            outcome: Outcome::Listed,
            signals: Vec::new(),
            start: row.start.clone(),
        });
    }
    let network_class = if network_unproven {
        Some(Class::Unproven)
    } else {
        [Class::Unproven, Class::OtherUser, Class::HasParent]
            .into_iter()
            .find(|class| {
                helpers
                    .iter()
                    .any(|f| f.name == HelperName::Netsimd && f.class == *class)
            })
    };
    if let Some(class) = network_class {
        for helper in &mut helpers {
            if helper.name == HelperName::CrashpadHandler && helper.class == Class::Orphan {
                helper.class = class;
            }
        }
    }
    helpers.retain(|helper| helper.class.listed(helper.cpu));
    Some(Scan {
        helpers,
        complete: list.complete,
    })
}

/// Doctor's read-only entry: package evidence belongs to this one listing.
pub fn findings(runner: &mut dyn Runner, label: &str, text: &str) -> Option<Scan> {
    classify(
        runner,
        label,
        text,
        unsafe { libc::geteuid() },
        &mut HashMap::new(),
        None,
        true,
    )
}

fn read_list(runner: &mut dyn Runner, deadline: u64) -> Option<String> {
    if runner.monotonic_ms() >= deadline {
        return None;
    }
    let output = runner.run(
        &CmdSpec::new("device-helpers", "ps", &["-axww", "-o", PROCESS_COLUMNS], 3)
            .cwd(Path::new("/"))
            .env("LC_ALL", "C"),
    );
    output.ok().then_some(output.stdout)
}

fn same_identity(text: &str, helper: &Finding) -> bool {
    parse(text).is_some_and(|list| {
        list.rows.iter().any(|row| {
            row.pid == helper.pid
                && row.start == helper.start
                && row.helper().is_some_and(|(name, _)| name == helper.name)
        })
    })
}

// Only cached package facts may be consulted between the fresh list and a signal.
fn refresh(
    runner: &mut dyn Runner,
    packages: &mut HashMap<String, bool>,
    deadline: u64,
) -> Option<(String, Scan)> {
    let text = read_list(runner, deadline)?;
    let scan = classify(
        runner,
        "device-helpers",
        &text,
        unsafe { libc::geteuid() },
        packages,
        Some(deadline),
        false,
    )?;
    scan.complete.then_some((text, scan))
}

fn may_signal(text: &str, fresh: &Scan, helper: &Finding) -> bool {
    same_identity(text, helper)
        && fresh
            .helpers
            .iter()
            .any(|f| f.pid == helper.pid && f.class == Class::Orphan)
}

fn send_signal(
    runner: &mut dyn Runner,
    helper: &mut Finding,
    signal: Signal,
    deadline: u64,
) -> bool {
    if runner.monotonic_ms() >= deadline {
        return false;
    }
    let kind = match signal {
        Signal::Term => "-TERM",
        Signal::Kill => "-KILL",
    };
    // No process groups: only the identity just re-read, with a pid proven above 1.
    let _ = runner.run(
        &CmdSpec::new(
            "device-helper-signal",
            "/bin/kill",
            &[kind, &helper.pid.to_string()],
            2,
        )
        .cwd(Path::new("/"))
        .env("LC_ALL", "C"),
    );
    helper.signals.push(signal);
    true
}

fn pause(runner: &mut dyn Runner, ms: u64, deadline: u64) -> bool {
    if runner.monotonic_ms().saturating_add(ms) > deadline {
        return false;
    }
    runner.sleep(std::time::Duration::from_millis(ms));
    runner.monotonic_ms() < deadline
}

/// Bounded recovery of proven SDK orphans. All other classes remain read-only findings.
pub fn stop_orphans(runner: &mut dyn Runner, os: &str, signal: bool) -> Scan {
    let nothing = Scan {
        helpers: Vec::new(),
        complete: true,
    };
    if !matches!(os, "macos" | "linux") {
        return nothing;
    }
    let deadline = runner.monotonic_ms().saturating_add(15_000);
    let Some(text) = read_list(runner, deadline) else {
        return nothing;
    };
    let mut packages = HashMap::new();
    let Some(mut scan) = classify(
        runner,
        "device-helpers",
        &text,
        unsafe { libc::geteuid() },
        &mut packages,
        Some(deadline),
        true,
    ) else {
        return nothing;
    };
    if !signal {
        return scan;
    }
    let candidates: Vec<_> = scan
        .helpers
        .iter()
        .enumerate()
        .filter(|(_, f)| f.class == Class::Orphan)
        .take(4)
        .map(|(i, _)| i)
        .collect();
    for &i in &candidates {
        scan.helpers[i].outcome = Outcome::Unknown;
    }
    let mut pending = Vec::new();
    for i in candidates {
        let Some((text, fresh)) = refresh(runner, &mut packages, deadline) else {
            return scan;
        };
        let helper = &mut scan.helpers[i];
        if !may_signal(&text, &fresh, helper) {
            helper.outcome = Outcome::LeftAlone;
            continue;
        }
        if !send_signal(runner, helper, Signal::Term, deadline) {
            return scan;
        }
        pending.push(i);
    }
    for _ in 0..5 {
        if pending.is_empty() {
            return scan;
        }
        if !pause(runner, 1000, deadline) {
            return scan;
        }
        let Some((text, _)) = refresh(runner, &mut packages, deadline) else {
            return scan;
        };
        pending.retain(|&i| {
            if same_identity(&text, &scan.helpers[i]) {
                true
            } else {
                scan.helpers[i].outcome = Outcome::StoppedTerm;
                false
            }
        });
    }
    let mut killed = Vec::new();
    for i in pending {
        let Some((text, fresh)) = refresh(runner, &mut packages, deadline) else {
            return scan;
        };
        let helper = &mut scan.helpers[i];
        if !same_identity(&text, helper) {
            helper.outcome = Outcome::StoppedTerm;
            continue;
        }
        if !may_signal(&text, &fresh, helper) {
            helper.outcome = Outcome::LeftAlone;
            continue;
        }
        if !send_signal(runner, helper, Signal::Kill, deadline) {
            return scan;
        }
        killed.push(i);
    }
    if !killed.is_empty() {
        if !pause(runner, 300, deadline) {
            return scan;
        }
        let Some((text, _)) = refresh(runner, &mut packages, deadline) else {
            return scan;
        };
        for i in killed {
            scan.helpers[i].outcome = if same_identity(&text, &scan.helpers[i]) {
                Outcome::SurvivedKill
            } else {
                Outcome::StoppedKill
            };
        }
    }
    scan
}

/// The report line for run-start findings, or None when there are none.
pub fn report_line(scan: &Scan) -> Option<String> {
    (!scan.helpers.is_empty()).then(|| {
        let each: Vec<_> = scan
            .helpers
            .iter()
            .map(|f| format!("{}; {}", f.describe(), f.outcome.as_str()))
            .collect();
        let incomplete = if scan.complete {
            ""
        } else {
            " The process list had an unreadable line, so a running emulator may be hidden."
        };
        format!(
            "Android emulator helpers at start (QaReN did not start them): {}.{incomplete}",
            each.join("; ")
        )
    })
}

/// One `PROCESS_COLUMNS` line, for fixtures.
#[cfg(test)]
pub(crate) fn ps_line(pid: i64, cpu: &str, stat: &str, ucomm: &str, args: &str) -> String {
    ps_line_with_identity(
        pid,
        1,
        unsafe { libc::geteuid() },
        "Sun Nov 15 12:34:56 2026",
        cpu,
        stat,
        ucomm,
        args,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn ps_line_with_identity(
    pid: i64,
    ppid: u32,
    uid: u32,
    start: &str,
    cpu: &str,
    stat: &str,
    ucomm: &str,
    args: &str,
) -> String {
    format!("{pid:>6} {ppid} {uid} {cpu:>5} {stat:<4} {start} {ucomm} {args}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    const SDK: &str = "/Volumes/External SSD/Android/sdk/emulator";
    const PACKAGE: &str = "Pkg.Desc=Android Emulator\nPkg.Path=emulator\nPkg.Revision=37.2.13\n";

    fn netsimd(pid: i64, cpu: &str) -> String {
        ps_line(pid, cpu, "S", "netsimd", &format!("{SDK}/netsimd --flag"))
    }

    fn package(runner: &mut MockRunner, folder: &str, output: CmdOutput) {
        runner.expect_run(&format!("\" sh {folder}/source.properties"), output);
    }

    fn scan_text(runner: &mut MockRunner, text: &str) -> Option<Scan> {
        let scan = findings(runner, "device-helpers", text);
        assert_eq!(runner.remaining(), 0, "unread package answers");
        assert!(runner.calls.iter().all(|c| c.label == "device-helpers"
            && c.program == "/bin/sh"
            && c.args[..3] == ["-c", PACKAGE_READ, "sh"]
            && c.timeout_seconds == 2));
        scan
    }

    fn owned(pid: i64, parent: u32, uid: u32, name: &str, cpu: &str, folder: &str) -> String {
        ps_line_with_identity(
            pid,
            parent,
            uid,
            "Sun Nov 15 12:34:56 2026",
            cpu,
            "S",
            name,
            &format!("{folder}/{name} --grpc-uds-path /socket"),
        )
    }

    fn uid() -> u32 {
        unsafe { libc::geteuid() }
    }

    #[test]
    fn u1_u9_sdk_orphan_has_a_class_without_any_connection_read() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let scan = scan_text(&mut runner, &owned(4242, 1, uid(), "netsimd", "0.5", SDK)).unwrap();
        assert!(scan.helpers[0].describe().contains("orphan"));
        assert_eq!(runner.calls.len(), 1);
    }

    #[test]
    fn u4_a_live_parent_is_only_listed_when_hot() {
        for parent_name in ["sh", "systemd"] {
            for cpu in ["0.5", "960.0"] {
                let mut runner = MockRunner::new();
                package(&mut runner, SDK, CmdOutput::success(PACKAGE));
                let text = owned(4242, 900, uid(), "netsimd", cpu, SDK)
                    + &ps_line(900, "0.0", "S", parent_name, "/bin/parent");
                let scan = scan_text(&mut runner, &text).unwrap();
                assert_eq!(scan.helpers.len(), usize::from(cpu == "960.0"));
                if cpu == "960.0" {
                    assert!(scan.helpers[0].describe().contains("has-parent"));
                }
            }
        }
    }

    #[test]
    fn u8_another_users_orphan_is_listed_but_not_claimed() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let scan = scan_text(
            &mut runner,
            &owned(4242, 1, uid() + 1, "netsimd", "0.5", SDK),
        )
        .unwrap();
        assert!(scan.helpers[0].describe().contains("other-user"));
    }

    #[test]
    fn u10_crash_reporter_follows_all_network_helpers_before_display_filtering() {
        for (parent, owner, expected) in [
            (900, uid(), "has-parent"),
            (1, uid() + 1, "other-user"),
            (1, uid(), "orphan"),
        ] {
            for crash_first in [true, false] {
                let mut runner = MockRunner::new();
                let other = "/second/emulator";
                for folder in if crash_first {
                    [SDK, other]
                } else {
                    [other, SDK]
                } {
                    package(&mut runner, folder, CmdOutput::success(PACKAGE));
                }
                let crash = owned(4243, 1, uid(), "crashpad_handler", "960.0", SDK);
                let network = owned(4242, parent, owner, "netsimd", "0.5", other);
                let text = if crash_first {
                    crash + &network
                } else {
                    network + &crash
                };
                let scan = scan_text(&mut runner, &text).unwrap();
                assert!(
                    scan.helpers
                        .iter()
                        .find(|f| f.pid == 4243)
                        .unwrap()
                        .describe()
                        .contains(expected),
                    "{expected}"
                );
            }
        }
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let text = owned(4243, 1, uid(), "crashpad_handler", "960.0", SDK)
            + &owned(4242, 900, uid(), "netsimd", "0.5", SDK)
            + &owned(4244, 1, uid() + 1, "netsimd", "0.5", SDK);
        let scan = scan_text(&mut runner, &text).unwrap();
        assert!(scan.helpers[0].describe().contains("other-user"));
    }

    #[test]
    fn u11_incomplete_list_precedes_parent_and_owner() {
        for (parent, owner) in [(1, uid()), (900, uid()), (1, uid() + 1)] {
            let mut runner = MockRunner::new();
            package(&mut runner, SDK, CmdOutput::success(PACKAGE));
            let text = owned(4242, parent, owner, "netsimd", "0.5", SDK)
                + "one two three four five six seven eight nine\n";
            let scan = scan_text(&mut runner, &text).unwrap();
            assert!(!scan.complete);
            assert!(scan.helpers[0].describe().contains("unproven"));
        }
    }

    #[test]
    fn u10_an_unread_network_folder_makes_a_crash_reporter_unproven() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let mut text = owned(4243, 1, uid(), "crashpad_handler", "960.0", SDK);
        for n in 0..4 {
            let folder = format!("/sdk{n}/emulator");
            text += &owned(5000 + n, 1, uid(), "netsimd", "0.5", &folder);
            if n < 3 {
                package(&mut runner, &folder, CmdOutput::success(PACKAGE));
            }
        }
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(scan.helpers[0].class, Class::Unproven);
    }

    #[test]
    fn u15_pids_outside_the_kernel_pid_range_are_not_helpers() {
        for pid in [0, 1, i64::from(i32::MAX) + 1, i64::from(u32::MAX) + 1, -1] {
            let mut runner = MockRunner::new();
            let text = netsimd(pid, "960.0") + &ps_line(2, "0.0", "S", "idle", "/idle");
            let scan = scan_text(&mut runner, &text).unwrap();
            assert!(scan.helpers.is_empty());
        }
    }

    #[test]
    fn u13_later_arguments_and_relative_names_cannot_prove_a_helper() {
        let mut runner = MockRunner::new();
        let disguised = format!("/bin/tool {SDK}");
        package(
            &mut runner,
            &disguised,
            CmdOutput::failed(1, "not a folder"),
        );
        let text = ps_line(4242, "960.0", "S", "netsimd", "relative/netsimd")
            + &ps_line(
                4243,
                "960.0",
                "S",
                "netsimd",
                &format!("/bin/tool {SDK}/netsimd"),
            );
        assert!(scan_text(&mut runner, &text).unwrap().helpers.is_empty());
    }

    #[test]
    fn u3_u7_any_owners_emulator_in_any_state_serves_hot_helpers() {
        for owner in [uid(), uid() + 1] {
            for stat in ["S", "T", "Z"] {
                let mut runner = MockRunner::new();
                package(&mut runner, SDK, CmdOutput::success(PACKAGE));
                let text = netsimd(4242, "960.0")
                    + &ps_line_with_identity(
                        900,
                        1,
                        owner,
                        "Sun Nov 15 12:34:56 2026",
                        "0.0",
                        stat,
                        "qemu-system-aarch64",
                        "/sdk/qemu -avd Other",
                    );
                let scan = scan_text(&mut runner, &text).unwrap();
                assert_eq!(scan.helpers[0].class, Class::Serving);
            }
        }
    }

    #[test]
    fn i6_report_names_the_outcome_without_a_manual_stop_or_private_facts() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let scan = scan_text(&mut runner, &netsimd(4242, "960.0")).unwrap();
        let text = report_line(&scan).unwrap();
        assert!(text.contains("listed"));
        assert!(!text.contains("kill 4242") && !text.contains(SDK) && !text.contains("--flag"));
    }

    #[test]
    fn u16_new_columns_keep_the_process_name_and_arguments() {
        let text =
            "4242 1 501 960.0 S Sun Nov 15 12:34:56 2026 netsimd /sdk/emulator/netsimd --flag\n";
        let list = parse(text).unwrap();
        assert_eq!(list.rows[0].ucomm, "netsimd");
        assert_eq!(list.rows[0].ppid, 1);
        assert_eq!(list.rows[0].uid, 501);
        assert_eq!(list.rows[0].start, "Sun Nov 15 12:34:56 2026");
        assert_eq!(list.rows[0].args, "/sdk/emulator/netsimd --flag");
    }

    #[test]
    fn only_a_folder_holding_the_sdk_emulator_package_makes_a_helper() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let crash = ps_line(
            4243,
            "0.0",
            "S",
            "crashpad_handle",
            &format!("{SDK}/crashpad_handler --database=/x"),
        );
        let scan = scan_text(&mut runner, &format!("{}{crash}", netsimd(4242, "0.5"))).unwrap();
        assert!(scan.complete);
        let names: Vec<_> = scan.helpers.iter().map(|f| (f.name, f.pid)).collect();
        assert_eq!(
            names,
            vec![
                (HelperName::Netsimd, 4242),
                (HelperName::CrashpadHandler, 4243)
            ]
        );

        for answer in [
            CmdOutput::success("Pkg.Desc=Something else\nPkg.Path=platform-tools\n"),
            CmdOutput::failed(1, "No such file or directory"),
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        ] {
            let mut runner = MockRunner::new();
            package(&mut runner, SDK, answer);
            let scan = scan_text(&mut runner, &netsimd(4242, "960.0")).unwrap();
            assert!(scan.helpers.is_empty());
        }
    }

    #[test]
    fn same_named_programs_of_other_apps_are_never_read_or_reported() {
        let text = [
            ps_line(4244, "0.0", "S", "crashpad_handle", "/Applications/Other App.app/Contents/Frameworks/crashpad_handler --database=/x/emulator/y"),
            ps_line(4245, "960.0", "S", "netsimd", "netsimd -s"),
            ps_line(4246, "960.0", "S", "vim", &format!("/usr/bin/vim {SDK}/netsimd")),
            ps_line(4247, "960.0", "S", "netsimd", &format!("{SDK}/netsimdx")),
            ps_line(0, "960.0", "S", "netsimd", &format!("{SDK}/netsimd")),
            ps_line(1, "960.0", "S", "netsimd", &format!("{SDK}/netsimd")),
        ]
        .concat();
        let mut runner = MockRunner::new();
        package(
            &mut runner,
            "/Applications/Other App.app/Contents/Frameworks",
            CmdOutput::failed(1, "No such file"),
        );
        let scan = scan_text(&mut runner, &text).unwrap();
        assert!(scan.complete);
        assert!(scan.helpers.is_empty());
    }

    #[test]
    fn an_sdk_path_holding_the_helper_name_or_a_space_is_recognised() {
        let folder = "/tmp/netsimd-repro/sdk/emulator";
        let mut runner = MockRunner::new();
        package(&mut runner, folder, CmdOutput::success(PACKAGE));
        let text = ps_line(
            77,
            "0.0",
            "S",
            "Some Program",
            "/Applications/Some Program/tool",
        ) + &ps_line(
            4242,
            "0.0",
            "S",
            "netsimd",
            &format!("{folder}/netsimd --crashpad_handler"),
        );
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(scan.helpers.len(), 1);
    }

    #[test]
    fn a_starting_emulator_or_any_users_emulator_serves_every_helper() {
        for alive in [
            ps_line(
                900,
                "40.0",
                "S",
                "qemu-system-aar",
                &format!("{SDK}/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel"),
            ),
            ps_line(900, "40.0", "Z", "qemu-system-x86", "(qemu-system-x86)"),
            ps_line(
                899,
                "0.1",
                "S",
                "emulator",
                &format!("{SDK}/emulator -avd Pixel"),
            ),
            ps_line(
                899,
                "0.1",
                "S",
                "emulator-headless",
                &format!("{SDK}/emulator-headless -avd Pixel"),
            ),
            ps_line(
                898,
                "0.1",
                "S",
                "qemu-system-aar",
                "/Users/other/sdk/emulator/qemu/qemu-system-aarch64 -avd Theirs",
            ),
        ] {
            let mut runner = MockRunner::new();
            let scan =
                scan_text(&mut runner, &format!("{alive}{}", netsimd(4242, "12.5"))).unwrap();
            assert!(scan.helpers.is_empty(), "{alive}");
        }
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let hot = format!(
            "{}{}",
            ps_line(899, "0.1", "S", "emulator", "/sdk/emulator/emulator"),
            netsimd(4242, "960.0")
        );
        let scan = scan_text(&mut runner, &hot).unwrap();
        assert_eq!(scan.helpers.len(), 1);
        assert!(scan.helpers[0].class == Class::Serving && scan.helpers[0].hot());
    }

    #[test]
    fn an_unreadable_line_marks_the_list_incomplete_and_found_helpers_stay_listed() {
        for bad in [
            "   77  1.0 S\n".to_string(),
            ps_line(77, "NaN", "S", "x", "/x"),
            ps_line(77, "-1.0", "S", "x", "/x"),
            ps_line(77, "1.0", "S", "x", "/x").replace("77", "invalid"),
        ] {
            let mut runner = MockRunner::new();
            package(&mut runner, SDK, CmdOutput::success(PACKAGE));
            let scan = scan_text(&mut runner, &format!("{bad}{}", netsimd(4242, "0.5"))).unwrap();
            assert!(!scan.complete, "{bad}");
            assert_eq!(scan.helpers.len(), 1);
            assert!(report_line(&scan)
                .unwrap()
                .contains("a running emulator may be hidden"));
        }
        let valid = ps_line(632, "0.0", "S", "distnoted", "/usr/sbin/distnoted agent");
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let scan = scan_text(&mut runner, &format!("{valid}{}", netsimd(4242, "0.5"))).unwrap();
        assert!(scan.complete);
        assert!(!report_line(&scan).unwrap().contains("may be hidden"));
        for text in ["", "\n", "   77  1.0 S\n"] {
            assert!(
                findings(&mut MockRunner::new(), "device-helpers", text).is_none(),
                "{text:?}"
            );
        }
    }

    #[test]
    fn one_package_read_per_folder_and_reporting_fields_are_kept() {
        let mut runner = MockRunner::new();
        package(&mut runner, SDK, CmdOutput::success(PACKAGE));
        let text = format!("{}{}", netsimd(4242, "960.0"), netsimd(4250, "0.0"));
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(runner.calls.len(), 1);
        let first = &scan.helpers[0];
        assert_eq!(first.pid, 4242);
        assert!(first.class == Class::Orphan && first.hot());
        assert_eq!(first.describe(), "netsimd (pid 4242, 960.0% CPU): orphan");
    }

    #[test]
    fn package_reads_stop_at_the_cap_and_later_folders_are_not_named() {
        let mut runner = MockRunner::new();
        let mut text = String::new();
        for n in 0..6 {
            let folder = format!("/fake{n}/emulator");
            text.push_str(&ps_line(
                5000 + n,
                "0.0",
                "S",
                "netsimd",
                &format!("{folder}/netsimd"),
            ));
            if n < 4 {
                package(&mut runner, &folder, CmdOutput::success(PACKAGE));
            }
        }
        let scan = scan_text(&mut runner, &text).unwrap();
        assert_eq!(runner.calls.len(), 4);
        let pids: Vec<_> = scan.helpers.iter().map(|f| f.pid).collect();
        assert_eq!(pids, vec![5000, 5001, 5002, 5003]);
    }

    #[test]
    fn the_real_package_read_proves_a_regular_file_and_never_waits_on_a_fifo() {
        let root = std::env::temp_dir().join(format!("qaren-helper-pkg-{}", std::process::id()));
        let sdk = root.join("sdk $(touch shell-ran)/emulator");
        let fifo = root.join("fifo/emulator");
        std::fs::create_dir_all(&sdk).unwrap();
        std::fs::create_dir_all(&fifo).unwrap();
        std::fs::write(sdk.join("source.properties"), PACKAGE).unwrap();
        let fifo_file =
            std::ffi::CString::new(fifo.join("source.properties").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo_file.as_ptr(), 0o600) }, 0);
        let mut runner = crate::exec::RealRunner::new();

        assert!(emulator_package(
            &mut runner,
            "device-helpers",
            sdk.to_str().unwrap()
        ));
        assert!(!root.join("shell-ran").exists() && !Path::new("/shell-ran").exists());
        let started = std::time::Instant::now();
        assert!(!emulator_package(
            &mut runner,
            "device-helpers",
            fifo.to_str().unwrap()
        ));
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert!(!emulator_package(
            &mut runner,
            "device-helpers",
            root.join("missing").to_str().unwrap()
        ));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn healthy_helpers_and_unsupported_hosts_cost_no_package_read() {
        let mut runner = MockRunner::new();
        let alive = ps_line(
            900,
            "40.0",
            "S",
            "qemu-system-aar",
            "/sdk/emulator/qemu/qemu-system-aarch64 -avd Pixel",
        );
        assert!(
            scan_text(&mut runner, &format!("{alive}{}", netsimd(4242, "1.0")))
                .unwrap()
                .helpers
                .is_empty()
        );
        let mut runner = MockRunner::new();
        assert!(stop_orphans(&mut runner, "windows", false)
            .helpers
            .is_empty());
        assert!(runner.calls.is_empty());
    }
}

#[cfg(test)]
#[path = "device_helpers_stop_tests.rs"]
mod stop_tests;
