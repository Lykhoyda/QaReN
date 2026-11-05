use crate::exec::{CmdOutput, CmdSpec, Runner};
use std::path::Path;

pub fn expo_online(runner: &dyn Runner) -> bool {
    runner.env_var("EXPO_OFFLINE").as_deref() == Some("0")
}

// The iOS simulator reaches Metro on 127.0.0.1, so iOS binds to loopback; Android keeps its adb-reverse path.
// `preload` is QaReN's run-local runtime-version preload (`expo_updates::write_preload`), iOS only.
pub fn start_spec(
    project_root: &Path,
    port: u16,
    localhost: bool,
    online: bool,
    preload: Option<&Path>,
) -> CmdSpec {
    let port = port.to_string();
    let mut args = vec!["exec", "expo", "start", "--port", &port];
    if localhost {
        args.push("--localhost");
    }
    let spec = CmdSpec::new("expo-start", "pnpm", &args, 0)
        .cwd(project_root)
        .env_remove("CI")
        .env("EXPO_NO_TELEMETRY", "1")
        .env("EXPO_OFFLINE", if online { "0" } else { "1" })
        // Metro logs each request on receipt here, before any dependency-graph wait; the drain counts bundle requests.
        .env("DEBUG", crate::exec::log::METRO_REQUEST_LOG);
    if !localhost {
        return spec;
    }
    // Node resolves `localhost` to ::1 first, so --localhost alone listens on IPv6 while every probe and the app use 127.0.0.1.
    // `pnpm exec` replaces the child's NODE_OPTIONS with a configured `node-options`, and reads
    // npm_config_node_options over .npmrc, so a configured value is composed and passed both ways.
    let configured = std::env::var("npm_config_node_options")
        .ok()
        .filter(|options| !options.trim().is_empty())
        .or_else(|| npmrc_node_options(project_root));
    let inherited = std::env::var("NODE_OPTIONS").ok();
    let options = dev_server_node_options(configured.as_deref().or(inherited.as_deref()), preload);
    let spec = spec.env("NODE_OPTIONS", &options);
    if configured.is_some() {
        spec.env("npm_config_node_options", &options)
    } else {
        spec
    }
}

// shortcut: reads only the project's own .npmrc and leaves values with interpolation, escapes or comments to
// pnpm; a node-options set in a workspace-root, user or global rc or pnpm-workspace.yaml, or one left to pnpm,
// still replaces these options (the receipt then shows pin=written), so resolve pnpm's effective setting if seen.
fn npmrc_node_options(project_root: &Path) -> Option<String> {
    let rc = std::fs::read_to_string(project_root.join(".npmrc")).ok()?;
    let value = rc.lines().rev().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        (key.trim() == "node-options").then(|| value.trim().to_string())
    })?;
    // ini parses a fully quoted value as a JSON string; anything else is taken verbatim.
    let value = if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        serde_json::from_str::<String>(&value).ok()?
    } else {
        value
    };
    (!value.trim().is_empty() && !value.contains(['$', '\\', ';', '#'])).then_some(value)
}

// Appends to the base options instead of replacing them; the preload path is quoted for Node's parser.
pub fn dev_server_node_options(base: Option<&str>, preload: Option<&Path>) -> String {
    let mut options: Vec<String> = base
        .map(str::trim)
        .filter(|options| !options.is_empty())
        .map(str::to_string)
        .into_iter()
        .collect();
    options.push("--dns-result-order=ipv4first".into());
    if let Some(preload) = preload {
        let escaped = preload
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        options.push(format!("--require \"{escaped}\""));
    }
    options.join(" ")
}

// Expo serves `/` and `/status` itself; only Metro's own handler logs this path, arming the drained count before launch.
pub fn request_probe_spec(port: u16) -> CmdSpec {
    CmdSpec::new(
        "metro-request-probe",
        "curl",
        &[
            "-s",
            "-o",
            "/dev/null",
            &format!("http://127.0.0.1:{port}/qaren-request-probe"),
        ],
        15,
    )
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
    group_presence_until(runner, pgid, None)
}

pub(crate) fn group_presence_until(
    runner: &mut dyn Runner,
    pgid: i32,
    deadline_ms: Option<u64>,
) -> GroupPresence {
    let Some(seconds) = crate::runrecord::probe_seconds_left(runner, deadline_ms) else {
        return GroupPresence::Unknown;
    };
    let output = runner.run(&CmdSpec::new(
        "ps-groups",
        "ps",
        &["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat="],
        seconds,
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
