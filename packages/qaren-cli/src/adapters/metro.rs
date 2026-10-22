use crate::exec::{CmdOutput, CmdSpec, Runner};
use std::path::Path;

// Metro without a native build: the dev server this process group owns is the
// same cleanup contract as the expo run:* owner.
pub fn start_spec(project_root: &Path, port: u16) -> CmdSpec {
    CmdSpec::new(
        "expo-start",
        "pnpm",
        &["exec", "expo", "start", "--port", &port.to_string()],
        0,
    )
    .cwd(project_root)
    .env_remove("CI")
    .env("EXPO_NO_TELEMETRY", "1")
    // Bundle starts reach only Expo's event log when its output is piped; fd 2 is the drained stderr.
    .env(crate::exec::log::EXPO_EVENTS_ENV, "2")
}

// Metro answers this before launch so the dev client's own manifest request fits inside its timeout.
pub fn manifest_spec(port: u16, platform: &str) -> CmdSpec {
    CmdSpec::new(
        "metro-manifest",
        "curl",
        &[
            "-sf",
            "-o",
            "/dev/null",
            "-H",
            &format!("expo-platform: {platform}"),
            "-H",
            "accept: application/expo+json,application/json",
            &format!("http://127.0.0.1:{port}/"),
        ],
        60,
    )
}

pub fn port_owner_spec(port: u16) -> CmdSpec {
    CmdSpec::new(
        "lsof-port",
        "lsof",
        &["-nP", &format!("-tiTCP:{port}"), "-sTCP:LISTEN"],
        15,
    )
}

pub fn pgid_of_spec(pid: i32) -> CmdSpec {
    CmdSpec::new(
        "ps-pgid",
        "ps",
        &["-o", "pgid=", "-p", &pid.to_string()],
        10,
    )
}

pub fn status_spec(port: u16) -> CmdSpec {
    CmdSpec::new(
        "metro-status",
        "curl",
        &[
            "-sf",
            "--max-time",
            "5",
            &format!("http://127.0.0.1:{port}/status"),
        ],
        15,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortOwners {
    Free,
    Owned(i32),
    Multiple,
    Unknown,
}

// lsof -t exits 1 with empty output when nothing listens; treat only that as free.
pub fn parse_port_owner(output: &CmdOutput) -> PortOwners {
    if output.timed_out {
        return PortOwners::Unknown;
    }
    match output.exit_code {
        Some(1) if output.stdout.trim().is_empty() && output.stderr.trim().is_empty() => {
            return PortOwners::Free
        }
        Some(0) => {}
        _ => return PortOwners::Unknown,
    }
    let mut pids = Vec::new();
    for line in output.stdout.lines().filter(|l| !l.trim().is_empty()) {
        match line.trim().parse::<i32>() {
            Ok(pid) => pids.push(pid),
            Err(_) => return PortOwners::Unknown,
        }
    }
    match pids.as_slice() {
        [] => PortOwners::Unknown,
        [pid] => PortOwners::Owned(*pid),
        _ => PortOwners::Multiple,
    }
}

pub fn pgid_of(runner: &mut dyn Runner, pid: i32) -> Option<i32> {
    let output = runner.run(&pgid_of_spec(pid));
    if !output.ok() {
        return None;
    }
    output.stdout.trim().parse::<i32>().ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupPresence {
    Present,
    Absent,
    Unknown,
}

pub fn group_presence(runner: &mut dyn Runner, pgid: i32) -> GroupPresence {
    let output = runner.run(&CmdSpec::new(
        "ps-groups",
        "ps",
        &["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="],
        10,
    ));
    if !output.ok()
        || !output.stderr.is_empty()
        || output.stdout.trim().is_empty()
        || !output.stdout.ends_with('\n')
        || output.stdout.contains(['\0', '\r', '\u{fffd}'])
    {
        return GroupPresence::Unknown;
    }
    let mut present = false;
    let mut pids = std::collections::HashSet::new();
    for row in output.stdout.lines() {
        let cols: Vec<_> = row.split_whitespace().collect();
        if cols.len() != 3
            || !cols[0].parse::<i32>().is_ok_and(|id| id > 0)
            || !cols[1].parse::<i32>().is_ok_and(|id| id >= 0)
            || !pids.insert(cols[0].parse::<i32>().ok())
            // macOS prints `?` for a process caught mid-exec or mid-exit; its pgid still counts.
            || !cols[2].starts_with(['R', 'S', 'D', 'T', 't', 'Z', 'X', 'I', 'W', 'U', '?'])
            || !cols[2]
                .chars()
                .skip(1)
                .all(|flag| "<>NLsl+EXWVATIS".contains(flag))
        {
            return GroupPresence::Unknown;
        }
        present |= cols[1].parse::<i32>().ok() == Some(pgid);
    }
    if present {
        GroupPresence::Present
    } else {
        GroupPresence::Absent
    }
}

pub fn metro_responding(runner: &mut dyn Runner, port: u16) -> bool {
    let output = runner.run(&status_spec(port));
    output.ok() && output.stdout.trim() == "packager-status:running"
}
