use crate::exec::{CmdOutput, CmdSpec, Runner};
use std::path::Path;

pub fn expo_online(runner: &dyn Runner) -> bool {
    runner.env_var("EXPO_OFFLINE").as_deref() == Some("0")
}

// Where a Metro start listens. The iOS simulator reaches Metro on 127.0.0.1, so iOS binds to loopback;
// Android keeps expo's default and its adb-reverse path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Listen {
    Loopback,
    Default,
    // The one restart after a [::1]-only start: every interface, so no `localhost` resolution is involved,
    // with the manifest's host pinned to the 127.0.0.1 that the app and probes use.
    AllPinned,
}

pub fn start_spec(
    project_root: &Path,
    port: u16,
    listen: Listen,
    online: bool,
    preload: Option<&Path>,
    node_options: Option<&str>,
) -> CmdSpec {
    let port = port.to_string();
    let mut args = vec!["exec", "expo", "start", "--port", &port];
    if listen == Listen::Loopback {
        args.push("--localhost");
    }
    let spec = CmdSpec::new("expo-start", "pnpm", &args, 0)
        .cwd(project_root)
        .env_remove("CI")
        .env("EXPO_NO_TELEMETRY", "1")
        .env("EXPO_OFFLINE", if online { "0" } else { "1" })
        // Metro logs each request on receipt here, before any dependency-graph wait; the drain counts bundle requests.
        .env("DEBUG", crate::exec::log::METRO_REQUEST_LOG);
    if listen == Listen::Default {
        return spec;
    }
    // Node resolves `localhost` to ::1 first, so --localhost alone listens on IPv6 while every probe and the app use 127.0.0.1.
    let options = dev_server_node_options(node_options, preload);
    let mut spec = spec
        .env("NODE_OPTIONS", &options)
        .env("npm_config_node_options", &options);
    // pnpm workspace nodeOptions overrides the environment unless supplied on its command line.
    spec.args.insert(0, format!("--config.node-options={options}"));
    if listen == Listen::AllPinned {
        spec = spec.env("REACT_NATIVE_PACKAGER_HOSTNAME", "127.0.0.1");
    }
    spec
}

// Appends to the base options instead of replacing them; the preload path is quoted for Node's parser.
pub fn dev_server_node_options(base: Option<&str>, preload: Option<&Path>) -> String {
    let mut options: Vec<String> = base
        .map(str::trim)
        .filter(|options| !options.is_empty())
        .map(str::to_string)
        .into_iter()
        .collect();
    if let Some(preload) = preload {
        let escaped = preload
            .to_string_lossy()
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        options.push(format!("--require \"{escaped}\""));
    }
    options.join(" ")
}

// Reads `pnpm config get node-options --json`. pnpm 9+ prints a JSON string (nothing when unset), after any
// warning; pnpm 8 ignores --json and prints the raw value (`undefined` when unset). pnpm's warning and notice
// lines never become Node options; a raw value must be Node flags (start with `-`), and anything else left
// is unreadable (None).
pub fn parse_pnpm_node_options(stdout: &str) -> Option<Option<String>> {
    let lines: Vec<String> = stdout
        .lines()
        .map(|line| without_terminal_codes(line).trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let clean = |value: String| Some(value).filter(|value| !value.trim().is_empty());
    if let Some(json) = lines.last().filter(|line| line.starts_with('"')) {
        return serde_json::from_str::<String>(json).ok().map(clean);
    }
    let values: Vec<&str> = lines
        .iter()
        .map(String::as_str)
        .filter(|line| !pnpm_notice(line))
        .collect();
    match values.as_slice() {
        [] | ["undefined" | "null"] => Some(None),
        [raw] if raw.starts_with('-') => Some(Some(raw.to_string())),
        _ => None,
    }
}

// Colour codes (ESC `[` ... final letter) would hide a warning's prefix.
fn without_terminal_codes(line: &str) -> String {
    let mut plain = String::with_capacity(line.len());
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            plain.push(c);
        } else if chars.next() == Some('[') {
            chars.by_ref().find(char::is_ascii_alphabetic);
        }
    }
    plain
}

// shortcut: recognises pnpm/npm WARN, notice and ERR_PNPM lines and the boxed update notice; another message
// beside a pnpm 8 raw value makes the read unreadable (inherited options used), so extend this if one is seen.
fn pnpm_notice(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    ["warn", "notice", "npm warn", "npm notice", "err_pnpm"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
        || line.starts_with(['│', '╭', '╰', '─'])
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

// The address form of one listening socket; a wildcard is never counted as either family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundAddr {
    V4Loopback,
    V6Loopback,
    Wildcard,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Listeners {
    Seen(Vec<(i32, BoundAddr)>),
    CommandFailed,
    TimedOut,
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusProbe {
    Running,
    OtherBody,
    HttpError(u16),
    Empty,
    Refused,
    Timeout,
    ProbeFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindObservation {
    pub listeners: Listeners,
    pub v4: StatusProbe,
    pub v6: StatusProbe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindClass {
    V4,
    V6Only,
    Pending,
    Inconclusive,
}

pub fn listen_spec(port: u16) -> CmdSpec {
    CmdSpec::new(
        "lsof-listen",
        "lsof",
        &["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN"],
        15,
    )
}

// No -f, so an HTTP error keeps its code; the code follows the body on its own line.
pub fn bind_status_spec(port: u16, v6: bool) -> CmdSpec {
    let (label, url) = if v6 {
        ("metro-status-v6", format!("http://[::1]:{port}/status"))
    } else {
        ("metro-status", format!("http://127.0.0.1:{port}/status"))
    };
    let mut args = vec![
        "-q",
        "-s",
        "--max-time",
        "5",
        "--noproxy",
        "*",
        "-w",
        "\\n%{http_code}",
    ];
    if v6 {
        args.push("-g");
    }
    args.push(&url);
    CmdSpec::new(label, "curl", &args, 15)
}

// lsof exits 1 with no output when nothing listens; only that is an empty list.
pub fn parse_listeners(output: &CmdOutput, port: u16) -> Listeners {
    if output.timed_out {
        return Listeners::TimedOut;
    }
    match output.exit_code {
        Some(1) if output.stdout.trim().is_empty() && output.stderr.trim().is_empty() => {
            return Listeners::Seen(Vec::new())
        }
        Some(0) => {}
        _ => return Listeners::CommandFailed,
    }
    let suffix = format!(":{port}");
    let mut seen = Vec::new();
    for line in output
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with("COMMAND "))
    {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (Some(pid), true) = (
            cols.get(1)
                .and_then(|p| p.parse::<i32>().ok())
                .filter(|p| *p > 0),
            cols.len() >= 10 && cols[cols.len() - 1] == "(LISTEN)",
        ) else {
            return Listeners::Malformed;
        };
        let addr = match cols[cols.len() - 2].strip_suffix(&suffix) {
            Some("127.0.0.1") => BoundAddr::V4Loopback,
            Some("[::1]") => BoundAddr::V6Loopback,
            Some("*") => BoundAddr::Wildcard,
            _ => BoundAddr::Other,
        };
        seen.push((pid, addr));
    }
    if seen.is_empty() {
        return Listeners::Malformed;
    }
    Listeners::Seen(seen)
}

// curl exit 7 is a refused connection, 28 its own time-out, 52 an empty reply; anything else is not a refusal.
pub fn parse_status_probe(output: &CmdOutput) -> StatusProbe {
    if output.timed_out {
        return StatusProbe::ProbeFailed;
    }
    match output.exit_code {
        Some(0) => {}
        Some(7) => return StatusProbe::Refused,
        Some(28) => return StatusProbe::Timeout,
        Some(52) => return StatusProbe::Empty,
        _ => return StatusProbe::ProbeFailed,
    }
    let Some((body, code)) = output.stdout.rsplit_once('\n') else {
        return StatusProbe::ProbeFailed;
    };
    match code.trim().parse::<u16>() {
        Ok(200..=299) if body.trim() == "packager-status:running" => StatusProbe::Running,
        Ok(200..=299) => StatusProbe::OtherBody,
        Ok(code) if code >= 100 => StatusProbe::HttpError(code),
        _ => StatusProbe::ProbeFailed,
    }
}

pub fn bind_probe(runner: &mut dyn Runner, port: u16) -> BindObservation {
    let listeners = parse_listeners(&runner.run(&listen_spec(port)), port);
    let v4 = parse_status_probe(&runner.run(&bind_status_spec(port, false)));
    let v6 = parse_status_probe(&runner.run(&bind_status_spec(port, true)));
    BindObservation { listeners, v4, v6 }
}

// `owner` is the pid proven to be in QaReN's Metro group; doctor reads a Metro it does not own and passes none.
fn v6_only_candidate(obs: &BindObservation, owner: Option<i32>) -> bool {
    let Listeners::Seen(seen) = &obs.listeners else {
        return false;
    };
    obs.v4 != StatusProbe::Running
        && obs.v6 == StatusProbe::Running
        && seen
            .iter()
            .any(|(pid, addr)| *addr == BoundAddr::V6Loopback && owner.is_none_or(|o| o == *pid))
        && !seen
            .iter()
            .any(|(_, addr)| matches!(addr, BoundAddr::V4Loopback | BoundAddr::Wildcard))
}

pub fn classify(
    obs: &BindObservation,
    owner: Option<i32>,
    v4_after: &[StatusProbe],
    last: Option<&Listeners>,
) -> BindClass {
    let silent = |p: &StatusProbe| matches!(p, StatusProbe::Refused | StatusProbe::Timeout);
    if obs.v4 == StatusProbe::Running || v4_after.contains(&StatusProbe::Running) {
        BindClass::V4
    } else if v6_only_candidate(obs, owner)
        && v4_after.len() >= 2
        && v4_after.iter().all(silent)
        && last == Some(&obs.listeners)
    {
        BindClass::V6Only
    } else if silent(&obs.v4)
        && silent(&obs.v6)
        && !matches!(&obs.listeners, Listeners::Seen(seen) if !seen.is_empty())
    {
        BindClass::Pending
    } else {
        BindClass::Inconclusive
    }
}

// The confirmation reads go out only on the IPv6-only path: two more IPv4 looks one second apart, then the listeners again.
pub fn observe_bind(
    runner: &mut dyn Runner,
    port: u16,
    owner: Option<i32>,
) -> (BindObservation, BindClass) {
    let obs = bind_probe(runner, port);
    if !v6_only_candidate(&obs, owner) {
        let class = classify(&obs, owner, &[], None);
        return (obs, class);
    }
    let mut after = Vec::new();
    for _ in 0..2 {
        runner.sleep(std::time::Duration::from_secs(1));
        let probe = parse_status_probe(&runner.run(&bind_status_spec(port, false)));
        after.push(probe);
        if probe == StatusProbe::Running {
            let class = classify(&obs, owner, &after, None);
            return (obs, class);
        }
    }
    let last = parse_listeners(&runner.run(&listen_spec(port)), port);
    let class = classify(&obs, owner, &after, Some(&last));
    (obs, class)
}

// Only the four address forms and pids; any other address is written as `other`.
pub fn listener_forms(listeners: &Listeners, port: u16) -> String {
    let seen = match listeners {
        Listeners::Seen(seen) if seen.is_empty() => return "none".into(),
        Listeners::Seen(seen) => seen,
        Listeners::CommandFailed => return "the listener read failed".into(),
        Listeners::TimedOut => return "the listener read timed out".into(),
        Listeners::Malformed => return "the listener read was unreadable".into(),
    };
    seen.iter()
        .map(|(pid, addr)| match addr {
            BoundAddr::V4Loopback => format!("pid {pid} 127.0.0.1:{port}"),
            BoundAddr::V6Loopback => format!("pid {pid} [::1]:{port}"),
            BoundAddr::Wildcard => format!("pid {pid} *:{port}"),
            BoundAddr::Other => format!("pid {pid} other"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod bind_tests {
    use super::*;
    use crate::exec::MockRunner;

    const HEADER: &str = "COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME\n";

    fn lsof(rows: &str) -> CmdOutput {
        CmdOutput::success(&format!("{HEADER}{rows}"))
    }

    fn row(pid: i32, name: &str) -> String {
        format!(
            "node    {pid} anton   21u  IPv6 0x1d2e3f4a5b6c7d8e      0t0  TCP {name} (LISTEN)\n"
        )
    }

    fn curl(stdout: &str, exit: i32) -> CmdOutput {
        CmdOutput {
            stdout: stdout.into(),
            ..CmdOutput::failed(exit, "")
        }
    }

    // R1: the lines measured on 15 Nov, plus every way the read can fail.
    #[test]
    fn the_listener_read_keeps_pid_and_address_form_and_its_failures_apart() {
        use BoundAddr::*;
        let read = |output: CmdOutput| parse_listeners(&output, 8081);
        assert_eq!(
            read(lsof(&row(6001, "127.0.0.1:8081"))),
            Listeners::Seen(vec![(6001, V4Loopback)])
        );
        assert_eq!(
            read(lsof(&row(6001, "[::1]:8081"))),
            Listeners::Seen(vec![(6001, V6Loopback)])
        );
        assert_eq!(
            read(lsof(&row(6001, "*:8081"))),
            Listeners::Seen(vec![(6001, Wildcard)])
        );
        assert_eq!(
            read(lsof(&row(6001, "192.168.0.2:8081"))),
            Listeners::Seen(vec![(6001, Other)])
        );
        assert_eq!(
            read(lsof(&format!(
                "{}{}",
                row(6001, "[::1]:8081"),
                row(6002, "127.0.0.1:8081")
            ))),
            Listeners::Seen(vec![(6001, V6Loopback), (6002, V4Loopback)])
        );
        assert_eq!(read(CmdOutput::failed(1, "")), Listeners::Seen(vec![]));
        assert_eq!(
            read(CmdOutput::failed(1, "lsof: WARNING: can't stat()")),
            Listeners::CommandFailed
        );
        assert_eq!(read(CmdOutput::failed(127, "")), Listeners::CommandFailed);
        assert_eq!(
            read(CmdOutput {
                timed_out: true,
                exit_code: None,
                ..CmdOutput::success("")
            }),
            Listeners::TimedOut
        );
        assert_eq!(read(lsof("")), Listeners::Malformed);
        assert_eq!(read(lsof("node 6001 TCP\n")), Listeners::Malformed);
        assert_eq!(
            read(lsof(
                "node notapid anton 21u IPv6 0x1 0t0 TCP [::1]:8081 (LISTEN)\n"
            )),
            Listeners::Malformed
        );
    }

    // R2: only a refused connection is Refused; curl's own failures never are.
    #[test]
    fn status_probe_states_never_turn_a_failed_probe_into_refused() {
        let probe = |output: CmdOutput| parse_status_probe(&output);
        assert_eq!(
            probe(CmdOutput::success("packager-status:running\n200")),
            StatusProbe::Running
        );
        assert_eq!(
            probe(CmdOutput::success("<html>other</html>\n200")),
            StatusProbe::OtherBody
        );
        assert_eq!(
            probe(CmdOutput::success("not found\n404")),
            StatusProbe::HttpError(404)
        );
        assert_eq!(probe(curl("\n000", 52)), StatusProbe::Empty);
        assert_eq!(probe(curl("\n000", 7)), StatusProbe::Refused);
        assert_eq!(probe(curl("\n000", 28)), StatusProbe::Timeout);
        // A missing curl has no exit code; the runner's own time-out is abnormal too.
        assert_eq!(
            probe(CmdOutput {
                exit_code: None,
                ..CmdOutput::failed(0, "No such file or directory")
            }),
            StatusProbe::ProbeFailed
        );
        assert_eq!(
            probe(CmdOutput {
                timed_out: true,
                exit_code: None,
                ..CmdOutput::success("")
            }),
            StatusProbe::ProbeFailed
        );
        assert_eq!(probe(curl("", 6)), StatusProbe::ProbeFailed);
        assert_eq!(
            probe(CmdOutput::success("garbled")),
            StatusProbe::ProbeFailed
        );
    }

    fn observed(listeners: Listeners, v4: StatusProbe, v6: StatusProbe) -> BindObservation {
        BindObservation { listeners, v4, v6 }
    }

    // R3: every combination the wait can meet.
    #[test]
    fn classify_needs_consistent_evidence_before_calling_metro_ipv6_only() {
        use BoundAddr::*;
        use StatusProbe::*;
        let v6_only = Listeners::Seen(vec![(6001, V6Loopback)]);
        let refused_twice = [Refused, Timeout];
        let ipv6_alone = observed(v6_only.clone(), Refused, Running);
        assert_eq!(
            classify(
                &observed(Listeners::TimedOut, Running, Refused),
                Some(6001),
                &[],
                None
            ),
            BindClass::V4
        );
        assert_eq!(
            classify(&ipv6_alone, Some(6001), &[Timeout, Running], Some(&v6_only)),
            BindClass::V4
        );
        assert_eq!(
            classify(&ipv6_alone, Some(6001), &refused_twice, Some(&v6_only)),
            BindClass::V6Only
        );
        // The process that answered is not ours, the listener changed, or the evidence is short.
        assert_eq!(
            classify(&ipv6_alone, Some(7001), &refused_twice, Some(&v6_only)),
            BindClass::Inconclusive
        );
        let moved = Listeners::Seen(vec![(6002, V6Loopback)]);
        assert_eq!(
            classify(&ipv6_alone, Some(6001), &refused_twice, Some(&moved)),
            BindClass::Inconclusive
        );
        assert_eq!(
            classify(&ipv6_alone, Some(6001), &[Refused], Some(&v6_only)),
            BindClass::Inconclusive
        );
        assert_eq!(
            classify(&ipv6_alone, Some(6001), &refused_twice, None),
            BindClass::Inconclusive
        );
        assert_eq!(
            classify(
                &ipv6_alone,
                Some(6001),
                &[Refused, HttpError(500)],
                Some(&v6_only)
            ),
            BindClass::Inconclusive
        );
        // A wildcard listener is still starting its IPv4 side; an IPv4 listener is never IPv6-only.
        let wildcard = Listeners::Seen(vec![(6001, Wildcard)]);
        assert_eq!(
            classify(
                &observed(wildcard.clone(), Timeout, Running),
                Some(6001),
                &refused_twice,
                Some(&wildcard)
            ),
            BindClass::Inconclusive
        );
        let both = Listeners::Seen(vec![(6001, V6Loopback), (6001, V4Loopback)]);
        assert_eq!(
            classify(
                &observed(both.clone(), Refused, Running),
                Some(6001),
                &refused_twice,
                Some(&both)
            ),
            BindClass::Inconclusive
        );
        let other = Listeners::Seen(vec![(6001, Other)]);
        assert_eq!(
            classify(
                &observed(other.clone(), Refused, Running),
                Some(6001),
                &refused_twice,
                Some(&other)
            ),
            BindClass::Inconclusive
        );
        // Without an owner to prove (doctor), any pid on [::1] alone counts.
        assert_eq!(
            classify(&ipv6_alone, None, &refused_twice, Some(&v6_only)),
            BindClass::V6Only
        );
        assert_eq!(
            classify(
                &observed(Listeners::Seen(vec![]), Refused, Refused),
                Some(6001),
                &[],
                None
            ),
            BindClass::Pending
        );
        assert_eq!(
            classify(
                &observed(Listeners::CommandFailed, Timeout, Refused),
                Some(6001),
                &[],
                None
            ),
            BindClass::Pending
        );
        assert_eq!(
            classify(
                &observed(v6_only.clone(), Refused, Refused),
                Some(6001),
                &[],
                None
            ),
            BindClass::Inconclusive
        );
    }

    // The confirmation reads are sent only on the IPv6-only path, one second apart, then the listener again.
    #[test]
    fn observe_bind_confirms_ipv6_only_with_two_more_ipv4_looks_and_a_last_listener_read() {
        let mut mock = MockRunner::new();
        mock.expect_run("-iTCP:8081", lsof(&row(6001, "[::1]:8081")));
        mock.expect_run("http://127.0.0.1:8081/status", curl("\n000", 7));
        mock.expect_run(
            "http://[::1]:8081/status",
            CmdOutput::success("packager-status:running\n200"),
        );
        mock.expect_run("http://127.0.0.1:8081/status", curl("\n000", 7));
        mock.expect_run("http://127.0.0.1:8081/status", curl("\n000", 28));
        mock.expect_run("-iTCP:8081", lsof(&row(6001, "[::1]:8081")));
        let start = mock.monotonic_ms();
        let (observation, class) = observe_bind(&mut mock, 8081, Some(6001));
        assert_eq!(class, BindClass::V6Only);
        assert_eq!(observation.v6, StatusProbe::Running);
        assert!(mock.monotonic_ms() - start >= 2_000);
        assert_eq!(mock.remaining(), 0);
        let v6 = &mock.calls[2];
        assert_eq!(v6.args[0], "-q");
        assert!(v6.args.contains(&"-g".to_string()));
        assert!(v6.args.contains(&"--noproxy".to_string()));
        assert!(!v6.args.iter().any(|a| a == "-f" || a == "-sf"));
    }

    // R8: a listener on another address is written as `other`, never as the address.
    #[test]
    fn listener_forms_name_only_loopback_forms_and_the_wildcard() {
        let rows = [
            row(6001, "[::1]:8081"),
            row(6002, "192.168.0.2:8081"),
            row(6003, "*:8081"),
            row(6004, "127.0.0.1:8081"),
        ]
        .concat();
        let forms = listener_forms(&parse_listeners(&lsof(&rows), 8081), 8081);
        assert_eq!(
            forms,
            "pid 6001 [::1]:8081, pid 6002 other, pid 6003 *:8081, pid 6004 127.0.0.1:8081"
        );
        assert!(!forms.contains("192.168"));
        assert_eq!(listener_forms(&Listeners::Seen(vec![]), 8081), "none");
        assert_eq!(
            listener_forms(&Listeners::TimedOut, 8081),
            "the listener read timed out"
        );
    }
}
