use crate::exec::{CmdOutput, CmdSpec};
use std::path::{Path, PathBuf};

pub fn holder(run_id: &str) -> String {
    format!("qaren-{run_id}")
}

pub fn local_serial(adb_port: u16) -> String {
    format!("127.0.0.1:{adb_port}")
}

// Only loopback-tunneled endpoints are legal local serials; anything else
// (USB serials in particular) must never be addressed.
pub fn is_tunneled_serial(serial: &str) -> bool {
    match serial.strip_prefix("127.0.0.1:") {
        Some(port) => port.parse::<u16>().map(|p| p > 0).unwrap_or(false),
        None => false,
    }
}

pub fn adb_path(android_home: &str) -> PathBuf {
    Path::new(android_home).join("platform-tools").join("adb")
}

pub fn emulator_path(android_home: &str) -> PathBuf {
    Path::new(android_home).join("emulator").join("emulator")
}

pub fn list_avds_spec(emulator: &Path) -> CmdSpec {
    CmdSpec::new(
        "emulator-list-avds",
        &emulator.to_string_lossy(),
        &["-list-avds"],
        20,
    )
}

fn ssh_base(host: &str, args: &[String], label: &str, timeout_seconds: u64) -> CmdSpec {
    let mut full = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "--".to_string(),
        host.to_string(),
    ];
    full.extend(args.iter().cloned());
    CmdSpec {
        core_log: false,
        count_lines: false,
        label: label.to_string(),
        program: "ssh".to_string(),
        args: full,
        cwd: None,
        env: Vec::new(),
        unset: Vec::new(),
        registry_auth_env: Vec::new(),
        timeout_seconds,
    }
}

pub fn farm_status_spec(host: &str, farm_path: &str) -> CmdSpec {
    ssh_base(
        host,
        &[format!("~/{farm_path}"), "status".to_string()],
        "farm-status",
        60,
    )
}

pub fn farm_start_spec(
    host: &str,
    farm_path: &str,
    slot: u8,
    holder: &str,
    boot_deadline_seconds: u64,
) -> CmdSpec {
    ssh_base(
        host,
        &[
            format!("~/{farm_path}"),
            "start".to_string(),
            slot.to_string(),
            holder.to_string(),
        ],
        "farm-start",
        boot_deadline_seconds + 60,
    )
}

pub fn farm_stop_spec(host: &str, farm_path: &str, slot: u8) -> CmdSpec {
    ssh_base(
        host,
        &[
            format!("~/{farm_path}"),
            "stop".to_string(),
            slot.to_string(),
        ],
        "farm-stop",
        120,
    )
}

pub fn tunnel_spec(host: &str, adb_port: u16) -> CmdSpec {
    CmdSpec {
        core_log: false,
        count_lines: false,
        label: "ssh-tunnel".to_string(),
        program: "ssh".to_string(),
        args: vec![
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "ConnectTimeout=10".to_string(),
            "-o".to_string(),
            "ExitOnForwardFailure=yes".to_string(),
            "-N".to_string(),
            "-L".to_string(),
            format!("127.0.0.1:{adb_port}:127.0.0.1:{adb_port}"),
            "--".to_string(),
            host.to_string(),
        ],
        cwd: None,
        env: Vec::new(),
        unset: Vec::new(),
        registry_auth_env: Vec::new(),
        timeout_seconds: 0,
    }
}

// The borrowed server: ADB_SERVER_SOCKET (loopback only), then ANDROID_ADB_SERVER_PORT, then 5037.
pub fn borrowed_server_port(socket: Option<&str>, port: Option<&str>) -> Result<u16, String> {
    let parse = |raw: &str| raw.parse::<u16>().ok().filter(|p| *p > 0);
    if let Some(socket) = socket.filter(|s| !s.is_empty()) {
        return ["tcp:localhost:", "tcp:127.0.0.1:"]
            .iter()
            .find_map(|prefix| socket.strip_prefix(prefix))
            .and_then(parse)
            .ok_or_else(|| {
                format!(
                    "ADB_SERVER_SOCKET {socket:?} is not a loopback adb server (tcp:localhost:<port> or tcp:127.0.0.1:<port>)"
                )
            });
    }
    match port.filter(|p| !p.is_empty()) {
        Some(raw) => {
            parse(raw).ok_or_else(|| format!("ANDROID_ADB_SERVER_PORT {raw:?} is not a TCP port"))
        }
        None => Ok(5037),
    }
}

// One host request to the local adb server, without any client that could start or restart one.
// Request: four hex digits of payload length, then the payload. Reply: OKAY or FAIL, four hex digits of length, that many bytes.
// max_len bounds an OKAY body and 1024 a FAIL message; each read waits at most 500 ms and the whole reply one second.
fn server_query(port: u16, request: &str, max_len: u32) -> Result<Vec<u8>, String> {
    use std::io::{ErrorKind, Read, Write};
    use std::time::{Duration, Instant};
    let budget = Duration::from_millis(500);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, budget)
        .map_err(|e| format!("cannot connect to 127.0.0.1:{port}: {e}"))?;
    stream
        .set_write_timeout(Some(budget))
        .and_then(|()| stream.write_all(format!("{:04x}{request}", request.len()).as_bytes()))
        .map_err(|e| format!("cannot ask 127.0.0.1:{port} for {request}: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut read_exact = |buf: &mut [u8]| -> std::io::Result<()> {
        let mut filled = 0;
        while filled < buf.len() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(ErrorKind::TimedOut.into());
            }
            stream.set_read_timeout(Some(left.min(budget)))?;
            match stream.read(&mut buf[filled..]) {
                Ok(0) => return Err(ErrorKind::UnexpectedEof.into()),
                Ok(n) => filled += n,
                Err(e) if e.kind() == ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    };
    let mut head = [0u8; 8];
    read_exact(&mut head).map_err(|e| format!("no adb reply from 127.0.0.1:{port}: {e}"))?;
    let not_adb = || format!("127.0.0.1:{port} did not answer as an adb server");
    let refused = match &head[..4] {
        b"OKAY" => false,
        b"FAIL" => true,
        _ => return Err(not_adb()),
    };
    // A refusal is one short line from adb; its own cap keeps the message whatever the success cap.
    let cap = if refused { 1024 } else { max_len };
    let len = parse_hex(&head[4..])
        .filter(|n| *n <= cap)
        .ok_or_else(not_adb)?;
    let mut body = vec![0u8; len as usize];
    read_exact(&mut body).map_err(|_| not_adb())?;
    if refused {
        let message: String = String::from_utf8_lossy(&body).chars().take(200).collect();
        return Err(format!(
            "the adb server on 127.0.0.1:{port} refused {request}: {message}"
        ));
    }
    Ok(body)
}

// The server's own host:version reply: proves an adb server listens, without any client that could restart it.
pub fn server_version(port: u16) -> Result<u32, String> {
    let body = server_query(port, "host:version", 8)?;
    parse_hex(&body).ok_or_else(|| format!("127.0.0.1:{port} did not answer as an adb server"))
}

// The server's own device list, in `adb devices` row form without the header; OKAY0000 is an empty list.
pub fn server_devices(port: u16) -> Result<String, String> {
    server_query(port, "host:devices", 0xffff)
        .map(|body| String::from_utf8_lossy(&body).into_owned())
}

fn parse_hex(bytes: &[u8]) -> Option<u32> {
    bytes
        .iter()
        .all(u8::is_ascii_hexdigit)
        .then(|| u32::from_str_radix(std::str::from_utf8(bytes).ok()?, 16).ok())
        .flatten()
}

pub fn client_version_spec(adb: &Path) -> CmdSpec {
    CmdSpec::new("adb-version", &adb.to_string_lossy(), &["version"], 20)
}

// "Android Debug Bridge version 1.0.N": N is the number the server reports.
pub fn parse_client_version(stdout: &str) -> Option<u32> {
    stdout
        .lines()
        .find_map(|l| l.trim().strip_prefix("Android Debug Bridge version "))
        .and_then(|v| v.rsplit('.').next())
        .and_then(|n| n.parse().ok())
}

// Any adb call would start a missing server or restart one of another version; prove neither applies.
pub fn borrowed_server_compatible(
    runner: &mut dyn crate::exec::Runner,
    adb: &Path,
    server_port: u16,
) -> Result<(), String> {
    let server = runner.adb_server_version(server_port).map_err(|_| {
        format!("no adb server answers on port {server_port}; start it, then re-run")
    })?;
    let output = runner.run(&client_version_spec(adb));
    let client = output
        .ok()
        .then(|| parse_client_version(&output.stdout))
        .flatten()
        .ok_or_else(|| format!("cannot read the version of {}", adb.display()))?;
    if client != server {
        return Err(format!(
            "adb at {} is version {client}, the server on port {server_port} is {server}; running it would restart the server",
            adb.display()
        ));
    }
    Ok(())
}

pub fn devices_spec(adb: &Path, server_port: u16) -> CmdSpec {
    adb_client("adb-devices", adb, server_port, &["devices"], 20)
}

// (serial, state) pairs from `adb devices` or host:devices, skipping the header and blank lines.
// Rows are `serial\tstate`; a serial adb cannot read may contain spaces (`(no serial number)`).
// The state is the first word, except `no permissions (...)`, which keeps both words.
pub fn parse_devices(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter(|l| !l.starts_with("List of devices") && !l.starts_with('*'))
        .filter_map(|l| {
            let line = l.trim();
            let (serial, rest) = line
                .split_once('\t')
                .or_else(|| line.split_once(char::is_whitespace))?;
            let (serial, rest) = (serial.trim(), rest.trim_start());
            let state = if rest.starts_with("no permissions") {
                "no permissions"
            } else {
                rest.split_whitespace().next()?
            };
            Some((serial.to_string(), state.to_string()))
        })
        .collect()
}

// A listed row that is not an emulator, a host:port endpoint or a wireless connection; an unreadable serial still counts.
pub fn is_physical_serial(serial: &str) -> bool {
    !crate::scenario::is_emulator_serial(serial)
        && !serial.contains(':')
        && !crate::scenario::is_wireless_serial(serial)
}

// (subreason, detail, next step) for an attached device that cannot be used.
pub type DeviceProblem = (&'static str, String, String);

fn device_label(serial: &str) -> String {
    if crate::scenario::is_usb_serial(serial) {
        format!("Android device {serial}")
    } else {
        "an attached device whose serial adb cannot read".to_string()
    }
}

// Shared device-state causes and fixes for doctor and check.
pub fn device_problem(serial: &str, state: &str, linux: bool) -> Option<DeviceProblem> {
    let who = device_label(serial);
    let replug = "replug the USB cable and wake the phone; re-run when it lists as `device`";
    Some(match state {
        "device" => return None,
        "no permissions" => (
            "usb-no-permissions",
            format!("{who}: this account has no USB permission for it (adb: no permissions)"),
            if linux {
                "give this account USB access: add it to the plugdev group (`sudo usermod -aG plugdev $LOGNAME`, then log out and in) and install the Android udev rules (Ubuntu: `apt-get install android-sdk-platform-tools-common`), replug the phone, restart this account's adb server, then re-run"
            } else {
                "replug the phone and check the cable, then re-run"
            }
            .to_string(),
        ),
        "unauthorized" => (
            "usb-unauthorized",
            format!("{who}: USB debugging from this computer is not accepted on the phone (adb: unauthorized)"),
            "unlock the phone and accept 'Allow USB debugging' (tick 'Always allow from this computer'); if no prompt shows, replug the cable; then re-run".to_string(),
        ),
        "offline" => ("device-offline", format!("{who}: offline (adb: offline)"), replug.to_string()),
        other => {
            // The state is the server's text: show it only as one short plain word.
            let shown = if other.len() <= 32 && other.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
                other
            } else {
                "an unrecognized state"
            };
            ("device-offline", format!("{who}: not ready (adb: {shown})"), replug.to_string())
        }
    })
}

// One USB device is held by one adb server: name the one that holds it, never stop it.
pub fn held_by_other_server(serial: &str, port: u16, holder_port: u16) -> DeviceProblem {
    (
        "device-held-by-other-server",
        format!(
            "{} is attached to the adb server on port {holder_port}, not to the one on port {port}",
            device_label(serial)
        ),
        format!("set ANDROID_ADB_SERVER_PORT={holder_port} and unset ADB_SERVER_SOCKET to run through it, or have its owner stop it; QaReN does not stop a server it did not start"),
    )
}

pub fn not_attached(serial: &str, port: u16) -> DeviceProblem {
    (
        "device-not-attached",
        format!(
            "no Android device with serial {serial} is attached to the adb server on port {port}"
        ),
        "attach the phone over USB with USB debugging enabled, then re-run".to_string(),
    )
}

// The adb server a user's own adb client starts; it may hold a phone another port cannot see.
pub const DEFAULT_ADB_PORT: u16 = 5037;

// Readable USB serials the server on 5037 lists as `device` and the run's port does not, listed there or not.
// One raw host:devices query: no adb client runs and no server starts; no answer means nobody holds one.
pub fn held_on_default_server(
    runner: &dyn crate::exec::Runner,
    port: u16,
    rows: &[(String, String)],
) -> Vec<String> {
    if port == DEFAULT_ADB_PORT {
        return Vec::new();
    }
    let Ok(listed) = runner.adb_server_devices(DEFAULT_ADB_PORT) else {
        return Vec::new();
    };
    parse_devices(&listed)
        .into_iter()
        .filter(|(serial, state)| {
            state == "device"
                && crate::scenario::is_usb_serial(serial)
                && !rows.iter().any(|(s, st)| s == serial && st == "device")
        })
        .map(|(serial, _)| serial)
        .collect()
}

// The one cause for a phone on the run's port (`state` None: not listed there), for doctor and check alike.
// Another server having it as `device` comes before its own state: that next step can be taken at once.
pub fn device_cause(
    serial: &str,
    state: Option<&str>,
    port: u16,
    held: &[String],
    linux: bool,
) -> Option<DeviceProblem> {
    if state == Some("device") {
        return None;
    }
    if port != DEFAULT_ADB_PORT && held.iter().any(|s| s == serial) {
        return Some(held_by_other_server(serial, port, DEFAULT_ADB_PORT));
    }
    match state {
        Some(state) => device_problem(serial, state, linux),
        None => Some(not_attached(serial, port)),
    }
}

pub fn wireless_not_supported(serial: &str) -> DeviceProblem {
    (
        "wireless-not-supported",
        format!("{serial} is a wireless adb connection; QaReN uses a phone over a USB cable only"),
        "attach the phone with a USB cable and pass the serial adb lists for the cable connection, then re-run".to_string(),
    )
}

// For texts that say what was listed and not used; empty when no wireless row is listed.
pub fn wireless_note(rows: &[(String, String)]) -> String {
    match rows
        .iter()
        .filter(|(serial, _)| crate::scenario::is_wireless_serial(serial))
        .count()
    {
        0 => String::new(),
        n => format!("; {n} wireless adb connection(s) listed and not used (USB cable only)"),
    }
}

pub fn getprop_spec(adb: &Path, server_port: u16, serial: &str, prop: &str) -> CmdSpec {
    adb_client(
        "adb-getprop",
        adb,
        server_port,
        &["-s", serial, "shell", "getprop", prop],
        20,
    )
}

pub fn avd_name_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-emu-avd-name",
        adb,
        server_port,
        &["-s", serial, "emu", "avd", "name"],
        20,
    )
}

pub fn parse_avd_name(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && *l != "OK")
        .map(str::to_string)
}

// A positive "nothing listens": only a refused loopback connect; a timeout or any other error is inconclusive.
pub fn server_absent(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    matches!(
        std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(500)),
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused
    )
}

// adb prefers ADB_SERVER_SOCKET and hands it to the server it launches as `-L`, which rejects an
// explicit host: the bare port binds loopback on exactly the port the run resolved.
pub fn start_server_spec(adb: &Path, server_port: u16) -> CmdSpec {
    CmdSpec::new(
        "adb-start-server",
        &adb.to_string_lossy(),
        &["start-server"],
        30,
    )
    .env("ADB_SERVER_SOCKET", &server_bind_socket(server_port))
}

// getprop ro.product.model as a record-safe name: other characters become `_`, at most 128 bytes.
pub fn sanitize_model(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(128)
        .collect()
}

pub fn dumpsys_power_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-dumpsys-power",
        adb,
        server_port,
        &["-s", serial, "shell", "dumpsys", "power"],
        20,
    )
}

pub fn dumpsys_window_policy_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-dumpsys-window-policy",
        adb,
        server_port,
        &["-s", serial, "shell", "dumpsys", "window", "policy"],
        20,
    )
}

pub fn wake_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-wake",
        adb,
        server_port,
        &["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"],
        20,
    )
}

// Dismisses only a non-secure keyguard; a PIN or pattern stays, whatever the exit status says.
pub fn dismiss_keyguard_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-dismiss-keyguard",
        adb,
        server_port,
        &["-s", serial, "shell", "wm", "dismiss-keyguard"],
        20,
    )
}

// None is unknown: an unreadable read or a field this Android version does not print.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockState {
    pub awake: Option<bool>,
    pub showing: Option<bool>,
    pub secure: Option<bool>,
}

impl LockState {
    pub fn secure_lock_showing(&self) -> bool {
        self.showing == Some(true) && self.secure == Some(true)
    }

    pub fn unknown(&self) -> bool {
        self.awake.is_none() || self.showing.is_none() || self.secure.is_none()
    }

    pub fn describe(&self) -> String {
        let show = |v: Option<bool>| v.map_or("unknown".to_string(), |v| v.to_string());
        format!(
            "awake={} keyguard showing={} secure={}",
            show(self.awake),
            show(self.showing),
            show(self.secure)
        )
    }
}

// `dumpsys power` mWakefulness=, then `dumpsys window policy`'s KeyguardServiceDelegate block: exact keys only,
// so showingAndNotOccluded= and the nested KeyguardStateMonitor's mIsShowing= never count.
pub fn parse_lock_state(power: Option<&str>, window: Option<&str>) -> LockState {
    let awake = power.and_then(|text| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix("mWakefulness="))
            .map(|v| v.trim() == "Awake")
    });
    let mut showing = None;
    let mut secure = None;
    if let Some(text) = window {
        let mut lines = text.lines();
        if let Some(head) = lines
            .by_ref()
            .find(|l| l.trim() == "KeyguardServiceDelegate")
        {
            let depth = head.len() - head.trim_start().len();
            for line in lines {
                let indent = line.len() - line.trim_start().len();
                if line.trim().is_empty() || indent <= depth {
                    break;
                }
                let flag = |v: &str| match v.trim() {
                    "true" => Some(true),
                    "false" => Some(false),
                    _ => None,
                };
                if let Some(v) = line.trim().strip_prefix("showing=") {
                    showing = flag(v);
                } else if let Some(v) = line.trim().strip_prefix("secure=") {
                    secure = flag(v);
                }
            }
        }
    }
    LockState {
        awake,
        showing,
        secure,
    }
}

// Two reads, never a change: a failed read leaves its fields unknown.
pub fn read_lock_state(
    runner: &mut dyn crate::exec::Runner,
    adb: &Path,
    server_port: u16,
    serial: &str,
) -> LockState {
    let mut read = |spec: CmdSpec| {
        let output = runner.run(&spec);
        output.ok().then_some(output.stdout)
    };
    let power = read(dumpsys_power_spec(adb, server_port, serial));
    let window = read(dumpsys_window_policy_spec(adb, server_port, serial));
    parse_lock_state(power.as_deref(), window.as_deref())
}

// QaReN neither can nor may pass a PIN or pattern: a lock still showing after one wake and dismiss refuses.
// `tried` says what QaReN already did; a secure lock seen at selection is refused before any attempt.
pub fn device_locked(serial: &str, state: &LockState, tried: &str) -> DeviceProblem {
    (
        "device-locked",
        format!(
            "{serial} shows its lock screen ({}); {tried}",
            state.describe()
        ),
        "unlock the device; for a dedicated test phone set Screen lock to None or Swipe; then re-run"
            .to_string(),
    )
}

pub fn several_devices(serials: &[&str]) -> DeviceProblem {
    let listed = serials.join(", ");
    (
        "several-devices",
        format!(
            "{} physical devices are ready ({listed}); qaren check borrows exactly one",
            serials.len()
        ),
        format!("pass --device <serial>: {listed}"),
    )
}

// One start was tried: report what the command said and that the port still does not answer, separately.
pub fn server_not_started(adb: &Path, port: u16, command: &str, probe: &str) -> DeviceProblem {
    (
        "adb-server-not-started",
        format!(
            "no adb server answered on port {port}; QaReN ran `adb start-server` once ({command}) and the port still does not answer ({probe})"
        ),
        format!(
            "QaReN tried once to start the adb server on port {port} and it does not answer; run `ADB_SERVER_SOCKET={} '{}' start-server` and read its error, then re-run",
            server_bind_socket(port),
            adb.display()
        ),
    )
}

// Preserve user options, then apply QaReN's worker cap and daemon policy.
pub fn gradle_opts(
    user: Option<&str>,
    jobs: Option<std::num::NonZeroU32>,
    no_daemon: bool,
) -> Option<String> {
    // The user's text stays verbatim: gradlew parses its quoting.
    let mut opts: Vec<String> = user
        .filter(|u| !u.trim().is_empty())
        .map(str::to_string)
        .into_iter()
        .collect();
    if let Some(jobs) = jobs {
        opts.push(format!("-Dorg.gradle.workers.max={jobs}"));
    }
    if no_daemon {
        opts.push("-Dorg.gradle.daemon=false".into());
    }
    (!opts.is_empty()).then(|| opts.join(" "))
}

fn with_gradle_opts(spec: CmdSpec, gradle_opts: Option<&str>) -> CmdSpec {
    match gradle_opts {
        Some(opts) => spec.env("GRADLE_OPTS", opts),
        None => spec,
    }
}

// --no-daemon so no Gradle JVM outlives the run's build group; ANDROID_HOME is inherited.
pub fn gradle_assemble_spec(
    project_root: &Path,
    abi: &str,
    deadline_seconds: u64,
    gradle_opts: Option<&str>,
) -> CmdSpec {
    let spec = CmdSpec::new(
        "gradle-assemble",
        "./gradlew",
        &[
            ":app:assembleDebug",
            &format!("-PreactNativeArchitectures={abi}"),
            "--no-daemon",
            "--console=plain",
        ],
        deadline_seconds,
    )
    .cwd(&project_root.join("android"))
    .env("CI", "1")
    .env("EXPO_NO_TELEMETRY", "1");
    with_gradle_opts(spec, gradle_opts)
}

pub fn server_socket(server_port: u16) -> String {
    format!("tcp:127.0.0.1:{server_port}")
}

// adb's server-side -L rejects explicit hostnames; a bare port binds loopback.
pub fn server_bind_socket(server_port: u16) -> String {
    format!("tcp:{server_port}")
}

pub fn fetch_adbkey_spec(host: &str) -> CmdSpec {
    ssh_base(
        host,
        &["cat".to_string(), "~/.android/adbkey".to_string()],
        "fetch-adbkey",
        30,
    )
}

// The run-scoped adb server: bound to an explicit loopback port, authenticating
// with the farm host's vendor key, never the Mac's global adb server.
// --one-device hard-limits the server to the leased endpoint (USB devices stay
// invisible), and disabling emulator port scanning keeps the tunneled endpoint
// a plain 127.0.0.1:<port> transport instead of a phantom emulator-<console>
// serial whose console port is not tunneled.
pub fn adb_server_spec(adb: &Path, server_port: u16, serial: &str, vendor_key: &Path) -> CmdSpec {
    CmdSpec::new(
        "adb-private-server",
        &adb.to_string_lossy(),
        &[
            "--one-device",
            serial,
            "-L",
            &server_bind_socket(server_port),
            "server",
            "nodaemon",
        ],
        0,
    )
    .env("ADB_VENDOR_KEYS", &vendor_key.to_string_lossy())
    .env("ADB_LOCAL_TRANSPORT_MAX_PORT", "5553")
}

// The run-scoped adb server for an explicitly claimed physical USB device:
// --one-device makes the named serial the only device the server (and every
// client routed through it, expo's included) can ever see. The host's default
// adb key — the one the phone already trusts — is pinned explicitly so an
// ambient ADB_VENDOR_KEYS cannot swap credentials nondeterministically.
pub fn usb_adb_server_spec(adb: &Path, server_port: u16, serial: &str, host_key: &Path) -> CmdSpec {
    CmdSpec::new(
        "adb-usb-server",
        &adb.to_string_lossy(),
        &[
            "--one-device",
            serial,
            "-L",
            &server_bind_socket(server_port),
            "server",
            "nodaemon",
        ],
        0,
    )
    .env("ADB_VENDOR_KEYS", &host_key.to_string_lossy())
    .env("ADB_LOCAL_TRANSPORT_MAX_PORT", "5553")
}

pub fn usb_lock_name(serial: &str) -> String {
    format!("usb-{serial}")
}

// -r replaces an existing install, -d allows a versionCode downgrade: a
// verified cached dev client may legitimately be older than what a physical
// device currently carries.
pub fn adb_install_spec(adb: &Path, server_port: u16, serial: &str, apk: &Path) -> CmdSpec {
    adb_client(
        "adb-install",
        adb,
        server_port,
        &["-s", serial, "install", "-r", "-d", &apk.to_string_lossy()],
        300,
    )
}

// The dev client reaches this host's Metro through adb reverse, identically on
// tunneled emulators and USB devices.
pub fn adb_reverse_spec(adb: &Path, server_port: u16, serial: &str, metro_port: u16) -> CmdSpec {
    let forward = format!("tcp:{metro_port}");
    adb_client(
        "adb-reverse",
        adb,
        server_port,
        &["-s", serial, "reverse", &forward, &forward],
        30,
    )
}

// A borrowed emulator's existing mapping is someone else's: never rebind it.
pub fn adb_reverse_no_rebind_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    metro_port: u16,
) -> CmdSpec {
    let forward = format!("tcp:{metro_port}");
    adb_client(
        "adb-reverse",
        adb,
        server_port,
        &["-s", serial, "reverse", "--no-rebind", &forward, &forward],
        30,
    )
}

pub fn adb_reverse_remove_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    metro_port: u16,
) -> CmdSpec {
    let forward = format!("tcp:{metro_port}");
    adb_client(
        "adb-reverse-remove",
        adb,
        server_port,
        &["-s", serial, "reverse", "--remove", &forward],
        30,
    )
}

pub fn adb_reverse_list_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-reverse-list",
        adb,
        server_port,
        &["-s", serial, "reverse", "--list"],
        20,
    )
}

// `reverse --list` lines are `<transport> tcp:<device> tcp:<host>`; the device side names the mapping.
pub fn reverse_listed(stdout: &str, port: u16) -> bool {
    let device = format!("tcp:{port}");
    stdout
        .lines()
        .any(|line| line.split_whitespace().nth(1) == Some(device.as_str()))
}

// adb joins the arguments of `shell` with spaces and the device shell parses the line.
fn device_shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

// The intent carries the app id as its package constraint so the deep link can
// only resolve into the app this run installed, never a chooser or another
// scheme handler.
pub fn am_start_deeplink_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    url: &str,
    app_id: &str,
) -> CmdSpec {
    let quoted_url = device_shell_quote(url);
    adb_client(
        "adb-am-start",
        adb,
        server_port,
        &[
            "-s",
            serial,
            "shell",
            "am",
            "start",
            "-a",
            "android.intent.action.VIEW",
            // Expo's dev menu reads this extra and skips opening itself at launch.
            "--ez",
            "EXDevMenuDisableAutoLaunch",
            "true",
            "-d",
            &quoted_url,
            app_id,
        ],
        60,
    )
}

fn adb_client(
    label: &str,
    adb: &Path,
    server_port: u16,
    args: &[&str],
    timeout_seconds: u64,
) -> CmdSpec {
    CmdSpec::new(label, &adb.to_string_lossy(), args, timeout_seconds)
        .env("ADB_SERVER_SOCKET", &server_socket(server_port))
}

pub fn adb_connect_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client("adb-connect", adb, server_port, &["connect", serial], 30)
}

pub fn adb_disconnect_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-disconnect",
        adb,
        server_port,
        &["disconnect", serial],
        30,
    )
}

pub fn adb_get_state_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-get-state",
        adb,
        server_port,
        &["-s", serial, "get-state"],
        20,
    )
}

// The core's runner packages and its device port; a core sync test pins both.
pub const RUNNER_PACKAGES: [&str; 2] = [
    "dev.lykhoyda.rndevagent.androidrunner.test",
    "dev.lykhoyda.rndevagent.androidrunner",
];
pub const RUNNER_DEVICE_PORT: u16 = 22089;

pub fn forward_list_spec(adb: &Path, server_port: u16) -> CmdSpec {
    adb_client(
        "adb-forward-list",
        adb,
        server_port,
        &["forward", "--list"],
        20,
    )
}

pub fn forward_remove_spec(adb: &Path, server_port: u16, serial: &str, host_port: u16) -> CmdSpec {
    let local = format!("tcp:{host_port}");
    adb_client(
        "adb-forward-remove",
        adb,
        server_port,
        &["-s", serial, "forward", "--remove", &local],
        20,
    )
}

pub fn force_stop_spec(adb: &Path, server_port: u16, serial: &str, package: &str) -> CmdSpec {
    adb_client(
        "adb-force-stop",
        adb,
        server_port,
        &["-s", serial, "shell", "am", "force-stop", package],
        20,
    )
}

// Recording uses a per-run device path as its identity; the host adb child owns a group.
pub fn screenrecord_spec(adb: &Path, port: u16, serial: &str, path: &Path) -> CmdSpec {
    adb_client(
        "adb-screenrecord",
        adb,
        port,
        &[
            "-s",
            serial,
            "shell",
            "screenrecord",
            "--time-limit",
            "0",
            "--bit-rate",
            "4000000",
            &path.to_string_lossy(),
        ],
        0,
    )
}

pub fn device_pkill_spec(
    adb: &Path,
    port: u16,
    serial: &str,
    signal: &str,
    path: &Path,
) -> CmdSpec {
    adb_client(
        "adb-device-pkill",
        adb,
        port,
        &[
            "-s",
            serial,
            "shell",
            "pkill",
            &format!("-{signal}"),
            "-f",
            &path.to_string_lossy(),
        ],
        20,
    )
}

pub fn device_pgrep_spec(adb: &Path, port: u16, serial: &str, path: &Path) -> CmdSpec {
    adb_client(
        "adb-device-pgrep",
        adb,
        port,
        &[
            "-s",
            serial,
            "shell",
            "pgrep",
            "-f",
            &path.to_string_lossy(),
        ],
        20,
    )
}

pub fn pull_spec(adb: &Path, port: u16, serial: &str, path: &Path, local: &Path) -> CmdSpec {
    adb_client(
        "adb-pull",
        adb,
        port,
        &[
            "-s",
            serial,
            "pull",
            &path.to_string_lossy(),
            &local.to_string_lossy(),
        ],
        60,
    )
}

pub fn rm_spec(adb: &Path, port: u16, serial: &str, path: &Path) -> CmdSpec {
    adb_client(
        "adb-rm",
        adb,
        port,
        &["-s", serial, "shell", "rm", "-f", &path.to_string_lossy()],
        20,
    )
}

// The runner's process and its instrumentation, in one ActivityManager dump. `scale` multiplies
// the 20 s budget; from Android 8 (API 26) dumpsys takes `-t`, so the service gets the same
// budget instead of its own 10 s, after which it prints only a timeout banner.
pub fn runner_processes_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    scale: u64,
    api_level: u32,
) -> CmdSpec {
    let budget = 20 * scale;
    let service_timeout = budget.to_string();
    let mut args = vec!["-s", serial, "shell", "dumpsys"];
    if api_level >= 26 {
        args.extend(["-t", service_timeout.as_str()]);
    }
    args.extend(["activity", "processes", RUNNER_PACKAGES[1]]);
    adb_client(
        "adb-dumpsys-runner-processes",
        adb,
        server_port,
        &args,
        budget,
    )
}

// dumpsys's own `*** SERVICE '<name>' DUMP TIMEOUT (<n>ms) EXPIRED ***`: the device answered
// but the service did not finish, so whatever precedes it is not a complete dump.
pub fn dump_timed_out(stdout: &str) -> bool {
    stdout.lines().map(str::trim).any(|line| {
        line.starts_with("*** SERVICE ")
            && line.contains(" DUMP TIMEOUT")
            && line.ends_with("EXPIRED ***")
    })
}

// The cheapest round trip to the device's shell: an answer means slow, not gone. 40 s, because a
// starved but live emulator was measured past 20 s; no answer in 40 s means stalled.
pub fn shell_true_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-shell-true",
        adb,
        server_port,
        &["-s", serial, "shell", "true"],
        40,
    )
}

const PROCESSES_HEADER: &str = "ACTIVITY MANAGER RUNNING PROCESSES (dumpsys activity processes)";

// Some(listed) only for a recognised processes dump: the instrumentation runs in the runner
// package's process, so any mention of that package is a live runner. Anything else is None,
// which never reads as absence.
pub fn runner_in_processes(stdout: &str) -> Option<bool> {
    let first = stdout.lines().find(|line| !line.trim().is_empty())?;
    (first.trim() == PROCESSES_HEADER).then(|| stdout.contains(RUNNER_PACKAGES[1]))
}

// `forward --list` lines `<serial> <host> tcp:<runner device port>`: the runner's forwards on this serial.
fn runner_forward_lines<'a>(stdout: &'a str, serial: &'a str) -> impl Iterator<Item = &'a str> {
    let device = format!("tcp:{RUNNER_DEVICE_PORT}");
    stdout.lines().filter_map(move |line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Lazy: real output has blank lines, whose fields cannot be indexed.
        (fields.len() == 3 && fields[0] == serial && fields[2] == device).then(|| fields[1])
    })
}

// Host ports of the runner's tcp forwards on this serial.
pub fn runner_forwards(stdout: &str, serial: &str) -> Vec<u16> {
    runner_forward_lines(stdout, serial)
        .filter_map(|local| local.strip_prefix("tcp:")?.parse().ok())
        .collect()
}

// Any forward to the runner's device port on this serial, removable or not.
pub fn runner_forward_remains(stdout: &str, serial: &str) -> bool {
    runner_forward_lines(stdout, serial).next().is_some()
}

pub fn pm_path_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    app_id: &str,
    budget_seconds: u64,
) -> CmdSpec {
    adb_client(
        "adb-pm-path",
        adb,
        server_port,
        &["-s", serial, "shell", "pm", "path", app_id],
        budget_seconds,
    )
}

pub fn pm_list_packages_spec(adb: &Path, server_port: u16, serial: &str, app_id: &str) -> CmdSpec {
    adb_client(
        "adb-pm-list-packages",
        adb,
        server_port,
        &["-s", serial, "shell", "pm", "list", "packages", app_id],
        30,
    )
}

pub fn sha256sum_spec(adb: &Path, server_port: u16, serial: &str, apk_path: &str) -> CmdSpec {
    adb_client(
        "adb-sha256sum",
        adb,
        server_port,
        &["-s", serial, "shell", "sha256sum", apk_path],
        60,
    )
}

// No -k: the app's data goes with the package.
pub fn uninstall_spec(adb: &Path, server_port: u16, serial: &str, app_id: &str) -> CmdSpec {
    adb_client(
        "adb-uninstall",
        adb,
        server_port,
        &["-s", serial, "uninstall", app_id],
        120,
    )
}

pub fn pm_path_packages(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .map(str::to_string)
        .collect()
}

// Device-provided paths become remote shell arguments, so restrict them to user base APKs.
pub fn is_user_base_apk_path(path: &str) -> bool {
    path.starts_with("/data/app/")
        && path.ends_with("/base.apk")
        && !path.split('/').any(|seg| seg == "..")
        && path.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '~' | '=' | '+' | '-')
        })
}

// Multiple hash records are ambiguous and cannot prove the requested APK's identity.
pub fn parse_sha256sum(stdout: &str, expected_path: &str) -> Option<String> {
    let tokens: Vec<&str> = stdout.split_whitespace().collect();
    let [hash, path] = tokens.as_slice() else {
        return None;
    };
    let well_formed = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
    (well_formed && *path == expected_path).then(|| hash.to_ascii_lowercase())
}

pub fn package_list_has_exact(stdout: &str, app_id: &str) -> bool {
    let wanted = format!("package:{app_id}");
    stdout.lines().any(|l| l.trim() == wanted)
}

pub fn pidof_spec(adb: &Path, server_port: u16, serial: &str, app_id: &str) -> CmdSpec {
    adb_client(
        "adb-pidof",
        adb,
        server_port,
        &["-s", serial, "shell", "pidof", app_id],
        30,
    )
}

// No --device flag: expo matches it against device *names*, not serials. The
// run-owned adb server is started with --one-device <serial>, so the leased
// endpoint is the only device expo can ever see; ANDROID_SERIAL pins every
// direct adb invocation on top of that. Not a finite build, so a niced build
// carries nice itself; Metro then runs at that priority too.
pub fn build_spec(
    project_root: &Path,
    serial: &str,
    server_port: u16,
    port: u16,
    deadline_seconds: u64,
    niced: bool,
    gradle_opts: Option<&str>,
) -> CmdSpec {
    let port = port.to_string();
    let expo = ["exec", "expo", "run:android", "--port", &port];
    let spec = if niced {
        let mut args = vec!["-n", "10", "pnpm"];
        args.extend(expo);
        CmdSpec::new("expo-run-android", "nice", &args, deadline_seconds)
    } else {
        CmdSpec::new("expo-run-android", "pnpm", &expo, deadline_seconds)
    }
    .cwd(project_root)
    .env("CI", "1")
    .env("EXPO_NO_TELEMETRY", "1")
    .env("ANDROID_SERIAL", serial)
    .env("ADB_SERVER_SOCKET", &server_socket(server_port));
    with_gradle_opts(spec, gradle_opts).count_lines()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlotStatus {
    pub slot: u8,
    pub avd: String,
    pub serial: String,
    pub adb_port: u16,
    pub lease: String,
    pub state: String,
}

fn farm_field(line: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=");
    let start = line.find(&marker)? + marker.len();
    // split (not split_whitespace) so an empty value stays empty
    // instead of skipping ahead to the next token.
    let value = line[start..]
        .split(char::is_whitespace)
        .next()
        .unwrap_or("");
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

pub fn parse_slot_status(stdout: &str, slot: u8) -> Option<SlotStatus> {
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with(&format!("slot={slot} ")) {
            continue;
        }
        let field = |key: &str| farm_field(line, key);
        let lease = {
            let marker = "lease=";
            let start = line.find(marker)? + marker.len();
            let rest = &line[start..];
            let end = rest.find(" state=")?;
            rest[..end].trim().to_string()
        };
        let serial = field("serial")?;
        if !serial.starts_with("emulator-") {
            return None;
        }
        let adb_port: u16 = field("adb_port")?.parse().ok()?;
        if adb_port == 0 {
            return None;
        }
        return Some(SlotStatus {
            slot,
            avd: field("avd")?,
            serial,
            adb_port,
            lease,
            state: field("state")?,
        });
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartedSlot {
    pub serial: String,
    pub adb_port: u16,
    pub lease: String,
}

pub fn parse_started(stdout: &str, slot: u8) -> Option<StartedSlot> {
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with(&format!("started slot={slot} ")) {
            continue;
        }
        let field = |key: &str| farm_field(line, key);
        let serial = field("serial")?;
        if !serial.starts_with("emulator-") {
            return None;
        }
        let adb_port: u16 = field("adb_port")?.parse().ok()?;
        if adb_port == 0 {
            return None;
        }
        return Some(StartedSlot {
            serial,
            adb_port,
            lease: field("lease")?,
        });
    }
    None
}

// The lease file's first line is the holder; farm status flattens it with
// claimed_at/avd metadata, so match the first token only.
pub fn lease_holder_token(lease: &str) -> &str {
    lease.split_whitespace().next().unwrap_or("")
}

const DEVMENU_PREFS_PATH: &str = "shared_prefs/expo.modules.devmenu.sharedpreferences.xml";
const DEVMENU_PREFS_TEMP_PATH: &str =
    "shared_prefs/expo.modules.devmenu.sharedpreferences.xml.qaren";
const DEVMENU_PREFS_XML_HEADER: &str = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>";
const DEVMENU_SHOW_FAB_FALSE_LINE: &str = "    <boolean name=\"showFab\" value=\"false\" />";

pub fn devmenu_pidof_spec(adb: &Path, server_port: u16, serial: &str, app_id: &str) -> CmdSpec {
    adb_client(
        "adb-devmenu-pidof",
        adb,
        server_port,
        &["-s", serial, "shell", "pidof", app_id],
        10,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessRead {
    Absent,
    Running,
    Unreadable,
}

pub fn devmenu_process_read(output: &CmdOutput) -> ProcessRead {
    if !output.timed_out
        && output.exit_code == Some(1)
        && output.stdout.trim().is_empty()
        && output.stderr.trim().is_empty()
    {
        return ProcessRead::Absent;
    }
    let valid_pid = |token: &str| {
        !token.is_empty()
            && token.bytes().all(|b| b.is_ascii_digit())
            && token.parse::<u32>().is_ok()
    };
    let mut tokens = output.stdout.split_whitespace();
    if output.ok() && tokens.next().is_some_and(valid_pid) && tokens.all(valid_pid) {
        return ProcessRead::Running;
    }
    ProcessRead::Unreadable
}

pub fn devmenu_prefs_read_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    app_id: &str,
) -> CmdSpec {
    let script = device_shell_quote(&format!(
        "if [ -e {DEVMENU_PREFS_PATH}.bak ]; then exit 5; elif [ -f {DEVMENU_PREFS_PATH} ] && [ -r {DEVMENU_PREFS_PATH} ]; then cat {DEVMENU_PREFS_PATH}; elif [ -e {DEVMENU_PREFS_PATH} ]; then exit 4; else exit 3; fi"
    ));
    adb_client(
        "adb-devmenu-prefs-read",
        adb,
        server_port,
        &["-s", serial, "shell", "run-as", app_id, "sh", "-c", &script],
        10,
    )
}

pub fn devmenu_current_user_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-devmenu-user",
        adb,
        server_port,
        &["-s", serial, "shell", "am", "get-current-user"],
        10,
    )
}

pub fn devmenu_prefs_write_script(bytes: usize) -> String {
    device_shell_quote(&format!(
        "umask 077; rm -f {DEVMENU_PREFS_TEMP_PATH}; mkdir -p shared_prefs && cat > {DEVMENU_PREFS_TEMP_PATH} && [ \"$(wc -c < {DEVMENU_PREFS_TEMP_PATH})\" -eq {bytes} ] && mv -f {DEVMENU_PREFS_TEMP_PATH} {DEVMENU_PREFS_PATH}; r=$?; rm -f {DEVMENU_PREFS_TEMP_PATH}; exit $r"
    ))
}

pub fn devmenu_prefs_write_spec(
    adb: &Path,
    server_port: u16,
    serial: &str,
    app_id: &str,
    bytes: usize,
) -> CmdSpec {
    let script = devmenu_prefs_write_script(bytes);
    adb_client(
        "adb-devmenu-prefs-write",
        adb,
        server_port,
        &["-s", serial, "shell", "run-as", app_id, "sh", "-c", &script],
        10,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevMenuPrefs {
    Hidden,
    Write(String),
    Unrecognised,
}

enum ParsedDevMenuPrefs<'a> {
    SelfClosing,
    Entries {
        lines: Vec<&'a str>,
        show_fab: Option<(usize, bool)>,
    },
}

fn valid_signed_digits(raw: &str) -> bool {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

fn valid_float_value(raw: &str) -> bool {
    if matches!(raw, "NaN" | "Infinity" | "-Infinity") {
        return true;
    }
    let rest = raw.strip_prefix('-').unwrap_or(raw);
    let (mantissa, exp) = match rest.split_once(['e', 'E']) {
        Some((m, e)) => (m, Some(e)),
        None => (rest, None),
    };
    let valid_digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    let mantissa_ok = match mantissa.split_once('.') {
        Some((int_part, frac_part)) => valid_digits(int_part) && valid_digits(frac_part),
        None => valid_digits(mantissa),
    };
    let exp_ok = match exp {
        Some(e) => valid_digits(e.strip_prefix(['+', '-']).unwrap_or(e)),
        None => true,
    };
    mantissa_ok && exp_ok
}

fn parse_devmenu_prefs(document: &str) -> Option<ParsedDevMenuPrefs<'_>> {
    if !document.is_ascii() {
        return None;
    }
    let trimmed = document.strip_suffix('\n').unwrap_or(document);
    let lines: Vec<&str> = trimmed
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    if lines.len() < 2 || lines[0] != DEVMENU_PREFS_XML_HEADER {
        return None;
    }
    if lines.len() == 2 && lines[1] == "<map />" {
        return Some(ParsedDevMenuPrefs::SelfClosing);
    }
    if lines.len() < 3 || lines[1] != "<map>" || *lines.last()? != "</map>" {
        return None;
    }
    let entry_lines = &lines[2..lines.len() - 1];
    let mut seen = std::collections::HashSet::with_capacity(entry_lines.len());
    let mut show_fab = None;
    for (index, &line) in entry_lines.iter().enumerate() {
        let rest = line.strip_prefix("    <")?.strip_suffix(" />")?;
        let (ty, rest) = rest.split_once(" name=\"")?;
        let (name, rest) = rest.split_once("\" value=\"")?;
        let value = rest.strip_suffix('"')?;
        if !matches!(ty, "boolean" | "int" | "long" | "float") {
            return None;
        }
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
        {
            return None;
        }
        let value_ok = match ty {
            "boolean" => matches!(value, "true" | "false"),
            "int" => valid_signed_digits(value) && value.parse::<i32>().is_ok(),
            "long" => valid_signed_digits(value) && value.parse::<i64>().is_ok(),
            "float" => valid_float_value(value),
            _ => false,
        };
        if !value_ok || !seen.insert(name) {
            return None;
        }
        if name == "showFab" {
            if ty != "boolean" {
                return None;
            }
            show_fab = Some((index, value == "true"));
        }
    }
    Some(ParsedDevMenuPrefs::Entries {
        lines: entry_lines.to_vec(),
        show_fab,
    })
}

fn render_devmenu_prefs(entries: &[&str]) -> String {
    let mut out = Vec::with_capacity(entries.len() + 3);
    out.push(DEVMENU_PREFS_XML_HEADER);
    out.push("<map>");
    out.extend_from_slice(entries);
    out.push("</map>");
    let mut doc = out.join("\n");
    doc.push('\n');
    doc
}

pub fn devmenu_prefs_fab_hidden(document: &str) -> bool {
    matches!(
        parse_devmenu_prefs(document),
        Some(ParsedDevMenuPrefs::Entries {
            show_fab: Some((_, false)),
            ..
        })
    )
}

pub fn devmenu_prefs_hide_fab(existing: Option<&str>) -> DevMenuPrefs {
    let Some(document) = existing else {
        return DevMenuPrefs::Write(render_devmenu_prefs(&[DEVMENU_SHOW_FAB_FALSE_LINE]));
    };
    let Some(parsed) = parse_devmenu_prefs(document) else {
        return DevMenuPrefs::Unrecognised;
    };
    match parsed {
        ParsedDevMenuPrefs::SelfClosing => {
            DevMenuPrefs::Write(render_devmenu_prefs(&[DEVMENU_SHOW_FAB_FALSE_LINE]))
        }
        ParsedDevMenuPrefs::Entries {
            lines: _,
            show_fab: Some((_, false)),
        } => DevMenuPrefs::Hidden,
        ParsedDevMenuPrefs::Entries {
            mut lines,
            show_fab: Some((index, true)),
        } => {
            lines[index] = DEVMENU_SHOW_FAB_FALSE_LINE;
            DevMenuPrefs::Write(render_devmenu_prefs(&lines))
        }
        ParsedDevMenuPrefs::Entries {
            mut lines,
            show_fab: None,
        } => {
            lines.push(DEVMENU_SHOW_FAB_FALSE_LINE);
            DevMenuPrefs::Write(render_devmenu_prefs(&lines))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    const FRESH_PREFS: &str = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n";

    #[test]
    fn devmenu_prefs_grammar_and_hide_transitions() {
        assert_eq!(FRESH_PREFS.len(), 115);
        assert_eq!(
            devmenu_prefs_hide_fab(None),
            DevMenuPrefs::Write(FRESH_PREFS.to_string())
        );
        assert!(devmenu_prefs_fab_hidden(FRESH_PREFS));
        assert_eq!(
            devmenu_prefs_hide_fab(Some(FRESH_PREFS)),
            DevMenuPrefs::Hidden
        );
        // CRLF and a missing final newline are recognised.
        let crlf_no_trailing_nl = FRESH_PREFS.trim_end_matches('\n').replace('\n', "\r\n");
        assert!(devmenu_prefs_fab_hidden(&crlf_no_trailing_nl));
        assert_eq!(
            devmenu_prefs_hide_fab(Some(&crlf_no_trailing_nl)),
            DevMenuPrefs::Hidden
        );

        // Self-closing <map /> form without showFab.
        let self_closing = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map />\n";
        assert!(!devmenu_prefs_fab_hidden(self_closing));
        assert_eq!(
            devmenu_prefs_hide_fab(Some(self_closing)),
            DevMenuPrefs::Write(FRESH_PREFS.to_string())
        );

        // <map> form without showFab preserves existing entries and inserts before </map>.
        let without_show_fab = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"isOnboardingFinished\" value=\"true\" />\n    <int name=\"count\" value=\"-42\" />\n    <long name=\"stamp\" value=\"9223372036854775807\" />\n    <float name=\"ratio\" value=\"1.5e-2\" />\n    <float name=\"nanVal\" value=\"NaN\" />\n    <float name=\"posInf\" value=\"Infinity\" />\n    <float name=\"negInf\" value=\"-Infinity\" />\n</map>\n";
        assert!(!devmenu_prefs_fab_hidden(without_show_fab));
        let expected_inserted = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"isOnboardingFinished\" value=\"true\" />\n    <int name=\"count\" value=\"-42\" />\n    <long name=\"stamp\" value=\"9223372036854775807\" />\n    <float name=\"ratio\" value=\"1.5e-2\" />\n    <float name=\"nanVal\" value=\"NaN\" />\n    <float name=\"posInf\" value=\"Infinity\" />\n    <float name=\"negInf\" value=\"-Infinity\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n";
        assert_eq!(
            devmenu_prefs_hide_fab(Some(without_show_fab)),
            DevMenuPrefs::Write(expected_inserted.to_string())
        );
        assert!(devmenu_prefs_fab_hidden(expected_inserted));

        // showFab=true with two other booleans and two fabPosition floats: only showFab changes.
        let with_true = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"isOnboardingFinished\" value=\"true\" />\n    <boolean name=\"showFab\" value=\"true\" />\n    <boolean name=\"showsAtLaunch\" value=\"false\" />\n    <float name=\"fabPositionX\" value=\"0.5\" />\n    <float name=\"fabPositionY\" value=\"0.75\" />\n</map>\n";
        let expected_replaced = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"isOnboardingFinished\" value=\"true\" />\n    <boolean name=\"showFab\" value=\"false\" />\n    <boolean name=\"showsAtLaunch\" value=\"false\" />\n    <float name=\"fabPositionX\" value=\"0.5\" />\n    <float name=\"fabPositionY\" value=\"0.75\" />\n</map>\n";
        assert!(!devmenu_prefs_fab_hidden(with_true));
        assert_eq!(
            devmenu_prefs_hide_fab(Some(with_true)),
            DevMenuPrefs::Write(expected_replaced.to_string())
        );
        assert!(devmenu_prefs_fab_hidden(expected_replaced));

        // Every unrecognised shape is left alone and never read as hidden.
        for bad in [
            "<?xml nonsense?>\n<map>\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"other\" value=\"\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"other\" value=\"99999999999\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name=\"other\">hello</string>\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name=\"other\"><![CDATA[<boolean name=\"showFab\" value=\"false\" />]]></string>\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <string name=\"other\">\n    <boolean name=\"showFab\" value=\"false\" />\n    </string>\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <!-- comment -->\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"false\" />\n    <boolean name=\"showFab\" value=\"true\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name='showFab' value='false' />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"false\"/>\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"false\" />\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFäb\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"showFab\" value=\"0\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <float name=\"fabPositionX\" value=\"inf\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <float name=\"fabPositionX\" value=\"nan\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <float name=\"fabPositionX\" value=\"+Infinity\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <int name=\"other\" value=\"+1\" />\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n",
            "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"false\" />\n</map>\n\n",
        ] {
            assert_eq!(devmenu_prefs_hide_fab(Some(bad)), DevMenuPrefs::Unrecognised, "{bad}");
            assert!(!devmenu_prefs_fab_hidden(bad), "{bad}");
        }
    }

    #[test]
    fn devmenu_process_read_distinguishes_absent_running_and_faults() {
        assert_eq!(
            devmenu_process_read(&CmdOutput::failed(1, "")),
            ProcessRead::Absent
        );
        assert_eq!(
            devmenu_process_read(&CmdOutput::failed(1, "error: device offline\n")),
            ProcessRead::Unreadable
        );
        assert_eq!(
            devmenu_process_read(&CmdOutput {
                timed_out: true,
                exit_code: Some(1),
                ..Default::default()
            }),
            ProcessRead::Unreadable
        );
        assert_eq!(
            devmenu_process_read(&CmdOutput::success("4242\n")),
            ProcessRead::Running
        );
        assert_eq!(
            devmenu_process_read(&CmdOutput::success("4242 4243\n")),
            ProcessRead::Running
        );
        assert_eq!(
            devmenu_process_read(&CmdOutput::success("")),
            ProcessRead::Unreadable
        );
    }

    #[test]
    fn devmenu_prefs_write_script_replaces_only_after_full_byte_count() {
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let scratch = Scratch(
            std::env::temp_dir().join(format!("qaren-devmenu-write-{}-{nonce}", std::process::id())),
        );
        let prefs_file = scratch.0.join(DEVMENU_PREFS_PATH);
        let temp_file = scratch.0.join(DEVMENU_PREFS_TEMP_PATH);
        std::fs::create_dir_all(prefs_file.parent().unwrap()).unwrap();

        let original = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n    <boolean name=\"showFab\" value=\"true\" />\n    <float name=\"fabPositionX\" value=\"0.5\" />\n</map>\n";
        let quoted = devmenu_prefs_write_script(FRESH_PREFS.len());
        let script = quoted
            .strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
            .expect("outer single quotes");
        assert!(!script.contains('\''));

        let run_sh = |stdin_bytes: &[u8]| {
            let mut child = Command::new("sh")
                .arg("-c")
                .arg(script)
                .current_dir(&scratch.0)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(stdin_bytes)
                .unwrap();
            child.wait_with_output().unwrap()
        };

        // Full 115 bytes: replaces existing file and leaves no .qaren temporary file.
        std::fs::write(&prefs_file, original).unwrap();
        std::fs::write(&temp_file, "stale leftover").unwrap();
        let full = run_sh(FRESH_PREFS.as_bytes());
        assert!(full.status.success(), "{full:?}");
        assert_eq!(std::fs::read_to_string(&prefs_file).unwrap(), FRESH_PREFS);
        assert!(!temp_file.exists());

        // Short transfer (40 bytes): non-zero exit, original file untouched byte-for-byte, no .qaren file.
        std::fs::write(&prefs_file, original).unwrap();
        let short = run_sh(&FRESH_PREFS.as_bytes()[..40]);
        assert!(!short.status.success(), "{short:?}");
        assert_eq!(std::fs::read_to_string(&prefs_file).unwrap(), original);
        assert!(!temp_file.exists());
    }
}
