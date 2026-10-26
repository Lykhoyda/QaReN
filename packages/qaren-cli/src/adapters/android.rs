use crate::exec::CmdSpec;
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

// The server's own host:version reply: proves an adb server listens, without any client that could restart it.
pub fn server_version(port: u16) -> Result<u32, String> {
    use std::io::{Read, Write};
    let budget = std::time::Duration::from_millis(500);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = std::net::TcpStream::connect_timeout(&addr, budget)
        .map_err(|e| format!("cannot connect to 127.0.0.1:{port}: {e}"))?;
    stream
        .set_read_timeout(Some(budget))
        .and_then(|()| stream.set_write_timeout(Some(budget)))
        .and_then(|()| stream.write_all(b"000chost:version"))
        .map_err(|e| format!("cannot ask 127.0.0.1:{port} for its version: {e}"))?;
    let mut head = [0u8; 8];
    stream
        .read_exact(&mut head)
        .map_err(|e| format!("no adb reply from 127.0.0.1:{port}: {e}"))?;
    let not_adb = || format!("127.0.0.1:{port} did not answer as an adb server");
    if &head[..4] != b"OKAY" {
        return Err(not_adb());
    }
    let len = parse_hex(&head[4..])
        .filter(|n| (1..=8).contains(n))
        .ok_or_else(not_adb)?;
    let mut body = vec![0u8; len as usize];
    stream.read_exact(&mut body).map_err(|_| not_adb())?;
    parse_hex(&body).ok_or_else(not_adb)
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

// (serial, state) pairs from `adb devices`, skipping the header and blank lines.
pub fn parse_devices(stdout: &str) -> Vec<(String, String)> {
    stdout
        .lines()
        .filter(|l| !l.starts_with("List of devices") && !l.starts_with('*'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
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

// --no-daemon so no Gradle JVM outlives the run's build group; ANDROID_HOME is inherited.
pub fn gradle_assemble_spec(project_root: &Path, abi: &str, deadline_seconds: u64) -> CmdSpec {
    CmdSpec::new(
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
    .env("EXPO_NO_TELEMETRY", "1")
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
            url,
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

// The runner's process and its instrumentation, in one ActivityManager dump.
pub fn runner_processes_spec(adb: &Path, server_port: u16, serial: &str) -> CmdSpec {
    adb_client(
        "adb-dumpsys-runner-processes",
        adb,
        server_port,
        &[
            "-s",
            serial,
            "shell",
            "dumpsys",
            "activity",
            "processes",
            RUNNER_PACKAGES[1],
        ],
        20,
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

pub fn pm_path_spec(adb: &Path, server_port: u16, serial: &str, app_id: &str) -> CmdSpec {
    adb_client(
        "adb-pm-path",
        adb,
        server_port,
        &["-s", serial, "shell", "pm", "path", app_id],
        30,
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
// direct adb invocation on top of that.
pub fn build_spec(
    project_root: &Path,
    serial: &str,
    server_port: u16,
    port: u16,
    deadline_seconds: u64,
) -> CmdSpec {
    CmdSpec::new(
        "expo-run-android",
        "pnpm",
        &["exec", "expo", "run:android", "--port", &port.to_string()],
        deadline_seconds,
    )
    .cwd(project_root)
    .env("CI", "1")
    .env("EXPO_NO_TELEMETRY", "1")
    .env("ANDROID_SERIAL", serial)
    .env("ADB_SERVER_SOCKET", &server_socket(server_port))
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
