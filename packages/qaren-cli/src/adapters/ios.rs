use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::scenario::IosWorkspaceBuild;
use std::path::{Path, PathBuf};

pub fn require_build(
    runner: &mut dyn Runner,
    project_root: &Path,
    workspace: Option<&IosWorkspaceBuild>,
) -> Result<(), crate::failure::Failure> {
    if let Some(workspace) = workspace {
        return validate_workspace(project_root, workspace);
    }
    use std::os::unix::fs::PermissionsExt;
    let refused = crate::failure::Failure::new(
        "preflight",
        crate::failure::FailureCode::IosBuildCapabilityUnavailable,
        "app-local Expo CLI does not prove generic iOS build-only support with --output and --no-bundler",
        "use an app-local Expo CLI supporting generic build-only output, or configure ios.build.workspace and ios.build.scheme for an existing native workspace",
    );
    let expo = project_root.join("node_modules/.bin/expo");
    if !std::fs::metadata(&expo)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    {
        return Err(refused);
    }
    let output = runner.run_private(
        &CmdSpec::new(
            "expo-ios-build-help",
            &expo.to_string_lossy(),
            &["run:ios", "--help"],
            15,
        )
        .cwd(project_root)
        .env_remove("CI")
        .env("EXPO_NO_TELEMETRY", "1")
        .env("EXPO_OFFLINE", "1")
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("NO_COLOR", "1"),
        &[],
    );
    let option = |flag: &str| {
        output.stdout().lines().find_map(|line| {
            let line = line.trim_start();
            let line = line
                .strip_prefix("-d, ")
                .or_else(|| line.strip_prefix("-o, "))
                .unwrap_or(line);
            line.strip_prefix(flag)
                .and_then(|tail| tail.strip_prefix(' '))
        })
    };
    if !output.clean()
        || output.stdout().len() > 64 * 1024
        || option("--no-bundler").is_none()
        || !option("--output").is_some_and(|tail| tail.starts_with("<path>"))
        || !option("--device").is_some_and(|tail| tail.contains("\"generic\" for build-only"))
    {
        return Err(refused);
    }
    Ok(())
}

pub fn validate_workspace(project_root: &Path, spec: &IosWorkspaceBuild) -> Result<(), Failure> {
    let refused = || {
        Failure::new(
            "preflight",
            FailureCode::IosBuildCapabilityUnavailable,
            "explicit iOS build requires a plain workspace directory and contents.xcworkspacedata file",
            "provide an existing project-relative workspace under ios/ and an explicit scheme",
        )
    };
    spec.validate().map_err(|_| refused())?;
    if !std::fs::symlink_metadata(project_root).is_ok_and(|meta| meta.is_dir()) {
        return Err(refused());
    }
    let mut path = project_root.to_path_buf();
    for component in Path::new(&spec.workspace).components() {
        path.push(component);
        if !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_dir()) {
            return Err(refused());
        }
    }
    if !std::fs::symlink_metadata(path.join("contents.xcworkspacedata"))
        .is_ok_and(|meta| meta.is_file())
    {
        return Err(refused());
    }
    Ok(())
}

pub fn sim_name(run_id: &str) -> String {
    format!("qaren-{run_id}")
}

pub fn create_spec(name: &str, device_type: &str, runtime: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-create",
        "xcrun",
        &["simctl", "create", name, device_type, runtime],
        120,
    )
}

pub fn bootstatus_spec(udid: &str, deadline_seconds: u64) -> CmdSpec {
    CmdSpec::new(
        "simctl-bootstatus",
        "xcrun",
        &["simctl", "bootstatus", udid, "-b"],
        deadline_seconds,
    )
}

pub fn list_booted_spec() -> CmdSpec {
    CmdSpec::new(
        "simctl-list-booted",
        "xcrun",
        &["simctl", "list", "devices", "booted", "-j"],
        30,
    )
}

pub fn canonical_udid(udid: &str) -> Option<String> {
    (udid.len() == 36
        && udid.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        }))
    .then(|| udid.to_ascii_uppercase())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimState {
    Booted,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Simulator {
    pub udid: String,
    pub name: String,
    pub device_type: String,
    pub runtime: String,
    pub state: SimState,
}

fn parse_sim(runtime: &str, device: &serde_json::Value) -> Option<Simulator> {
    let field = |key: &str| device.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let sim = Simulator {
        udid: field("udid").to_string(),
        name: field("name").to_string(),
        device_type: field("deviceTypeIdentifier").to_string(),
        runtime: runtime.to_string(),
        state: match field("state") {
            "Booted" => SimState::Booted,
            "Shutdown" => SimState::Shutdown,
            _ => return None,
        },
    };
    if sim.udid.is_empty() || sim.device_type.is_empty() {
        return None;
    }
    Some(sim)
}

// Booted iOS simulators only; paired watchOS/tvOS runtimes are not walk targets.
pub fn parse_booted_sims(list_json: &str) -> Option<Vec<Simulator>> {
    let parsed: serde_json::Value = serde_json::from_str(list_json).ok()?;
    let devices = parsed.get("devices")?.as_object()?;
    let mut out = Vec::new();
    for (runtime, list) in devices {
        if !runtime.contains("SimRuntime.iOS") {
            continue;
        }
        for device in list.as_array()? {
            if device.get("state").and_then(|s| s.as_str()) != Some("Booted") {
                continue;
            }
            out.push(parse_sim(runtime, device)?);
        }
    }
    Some(out)
}

pub fn parse_selected_sim(list_json: &str, udid: &str) -> Option<Simulator> {
    let udid = canonical_udid(udid)?;
    let parsed: serde_json::Value = serde_json::from_str(list_json).ok()?;
    let devices = parsed.get("devices")?.as_object()?;
    let mut selected = None;
    for (runtime, list) in devices {
        for device in list.as_array()? {
            let observed = device.get("udid")?.as_str()?;
            if !observed.eq_ignore_ascii_case(&udid) {
                continue;
            }
            if selected.is_some()
                || observed != udid
                || !device.get("isAvailable")?.as_bool()?
                || runtime
                    .strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-")?
                    .is_empty()
            {
                return None;
            }
            let sim = parse_sim(runtime, device)?;
            if sim.name.trim().is_empty() || sim.device_type.trim().is_empty() {
                return None;
            }
            selected = Some(sim);
        }
    }
    selected
}

pub fn list_devices_spec() -> CmdSpec {
    CmdSpec::new(
        "simctl-list",
        "xcrun",
        &["simctl", "list", "devices", "-j"],
        30,
    )
}

pub fn app_container_spec(udid: &str, app_id: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-app-container",
        "xcrun",
        &["simctl", "get_app_container", udid, app_id, "app"],
        20,
    )
}

pub fn launchctl_list_spec(udid: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-launchctl",
        "xcrun",
        &["simctl", "spawn", udid, "launchctl", "list"],
        20,
    )
}

pub fn terminate_spec(udid: &str, bundle_id: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-terminate",
        "xcrun",
        &["simctl", "terminate", udid, bundle_id],
        20,
    )
}

pub fn install_app_spec(udid: &str, app_path: &Path) -> CmdSpec {
    CmdSpec::new(
        "simctl-install",
        "xcrun",
        &["simctl", "install", udid, &app_path.to_string_lossy()],
        120,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppPresence {
    Installed,
    ProvenAbsent,
    Unknown,
}

pub fn probe_app_presence(runner: &mut dyn Runner, udid: &str, app_id: &str) -> AppPresence {
    let output = runner.run_private(
        &CmdSpec::new(
            "simctl-listapps",
            "xcrun",
            &["simctl", "listapps", udid],
            30,
        ),
        &[],
    );
    if !output.clean() {
        return AppPresence::Unknown;
    }
    let converted = runner.run_private(
        &CmdSpec::new(
            "app-list-json",
            "plutil",
            &["-convert", "json", "-o", "-", "-"],
            10,
        ),
        output.stdout().as_bytes(),
    );
    if !converted.clean() {
        return AppPresence::Unknown;
    }
    let Ok(serde_json::Value::Object(apps)) = serde_json::from_str(converted.stdout()) else {
        return AppPresence::Unknown;
    };
    if apps.iter().any(|(id, info)| {
        info.get("CFBundleIdentifier")
            .and_then(serde_json::Value::as_str)
            != Some(id.as_str())
    }) {
        return AppPresence::Unknown;
    }
    if apps.contains_key(app_id) {
        AppPresence::Installed
    } else {
        AppPresence::ProvenAbsent
    }
}

// Mirrors RN_FAST_RUNNER_APP_BUNDLE_ID in the runner's Xcode project.
pub const RUNNER_HOST_BUNDLE_ID: &str = "dev.lykhoyda.rndevagent.fastrunner";

// Xcode adds .xctrunner to RN_FAST_RUNNER_TEST_BUNDLE_ID for the XCTest host.
pub const RUNNER_TEST_HOST_BUNDLE_ID: &str = "dev.lykhoyda.rndevagent.fastrunner.uitests.xctrunner";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerHostPresence {
    Present,
    Absent,
    Unknown,
}

pub fn parse_runner_hosts(output: &str) -> RunnerHostPresence {
    use RunnerHostPresence::{Absent, Present, Unknown};
    if output.len() >= 1024 * 1024
        || !output.ends_with('\n')
        || output
            .bytes()
            .any(|b| !b.is_ascii_graphic() && !matches!(b, b' ' | b'\t' | b'\n'))
    {
        return Unknown;
    }
    let mut lines = output.lines();
    if !lines
        .next()
        .is_some_and(|line| line.split_whitespace().eq(["PID", "Status", "Label"]))
    {
        return Unknown;
    }
    let mut labels = std::collections::HashSet::new();
    let mut present = false;
    for row in lines {
        let cols: Vec<_> = row.split_whitespace().collect();
        if cols.len() != 3
            || (cols[0] != "-"
                && !(cols[0].bytes().all(|b| b.is_ascii_digit())
                    && cols[0].parse::<i32>().is_ok_and(|pid| pid > 0)))
            || cols[1].parse::<i32>().is_err()
            || !labels.insert(cols[2])
            || labels.len() > 16_384
        {
            return Unknown;
        }
        let bundle = if let Some(label) = cols[2].strip_prefix("UIKitApplication:") {
            let Some((bundle, suffix)) = label.split_once('[') else {
                return Unknown;
            };
            if bundle.is_empty()
                || !bundle
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
            {
                return Unknown;
            }
            let mut tail = suffix;
            loop {
                let Some((identifier, rest)) = tail.split_once(']') else {
                    return Unknown;
                };
                if identifier.is_empty() || identifier.contains('[') {
                    return Unknown;
                }
                if rest.is_empty() {
                    break;
                }
                let Some(next) = rest.strip_prefix('[') else {
                    return Unknown;
                };
                tail = next;
            }
            bundle
        } else {
            cols[2]
        };
        present |=
            cols[0] != "-" && matches!(bundle, RUNNER_HOST_BUNDLE_ID | RUNNER_TEST_HOST_BUNDLE_ID);
    }
    if labels.is_empty() {
        Unknown
    } else if present {
        Present
    } else {
        Absent
    }
}

pub fn probe_runner_hosts(runner: &mut dyn Runner, udid: &str) -> RunnerHostPresence {
    if canonical_udid(udid).as_deref() != Some(udid) {
        return RunnerHostPresence::Unknown;
    }
    let inventory = runner.run(&list_devices_spec());
    if !inventory.ok() || !inventory.stderr.is_empty() || inventory.stdout.len() >= 1024 * 1024 {
        return RunnerHostPresence::Unknown;
    }
    match parse_selected_sim(&inventory.stdout, udid).map(|sim| sim.state) {
        Some(SimState::Shutdown) => RunnerHostPresence::Absent,
        Some(SimState::Booted) => {
            let output = runner.run(&launchctl_list_spec(udid));
            if output.ok() && output.stderr.is_empty() {
                parse_runner_hosts(&output.stdout)
            } else {
                RunnerHostPresence::Unknown
            }
        }
        None => RunnerHostPresence::Unknown,
    }
}

pub fn uninstall_app_spec(udid: &str, app_id: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-uninstall",
        "xcrun",
        &["simctl", "uninstall", udid, app_id],
        60,
    )
}

// Expo dev-client preferences written before launch: no floating gear, launch menu or onboarding sheet.
pub fn devmenu_defaults_specs(udid: &str, app_id: &str) -> Vec<CmdSpec> {
    [
        ("EXDevMenuShowFloatingActionButton", "NO"),
        ("EXDevMenuShowsAtLaunch", "NO"),
        ("EXDevMenuIsOnboardingFinished", "YES"),
    ]
    .into_iter()
    .map(|(key, value)| {
        CmdSpec::new(
            "simctl-devmenu-defaults",
            "xcrun",
            &[
                "simctl", "spawn", udid, "defaults", "write", app_id, key, "-bool", value,
            ],
            20,
        )
    })
    .collect()
}

pub fn launch_spec(udid: &str, app_id: &str, metro_port: u16) -> CmdSpec {
    CmdSpec::new(
        "simctl-launch",
        "xcrun",
        &[
            "simctl",
            "launch",
            "--terminate-running-process",
            udid,
            app_id,
            "--initialUrl",
            // Expo stores its dev-menu tutorial finished, so it never covers a fresh install.
            &format!("http://127.0.0.1:{metro_port}/?disableOnboarding=1"),
        ],
        60,
    )
}

pub fn shutdown_spec(udid: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-shutdown",
        "xcrun",
        &["simctl", "shutdown", udid],
        120,
    )
}

pub fn delete_spec(udid: &str) -> CmdSpec {
    CmdSpec::new("simctl-delete", "xcrun", &["simctl", "delete", udid], 120)
}

fn workspace_derived_data(output: &Path) -> PathBuf {
    output
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("ios-derived-data")
}

// Xcode's own products dir: a global CONFIGURATION_BUILD_DIR breaks use_frameworks! header paths.
pub fn workspace_products(output: &Path) -> PathBuf {
    workspace_derived_data(output).join("Build/Products/Debug-iphonesimulator")
}

pub fn build_spec(
    project_root: &Path,
    output: &Path,
    deadline_seconds: u64,
    workspace: Option<&IosWorkspaceBuild>,
) -> CmdSpec {
    if let Some(workspace) = workspace {
        let derived_data = workspace_derived_data(output);
        return CmdSpec::new(
            "xcodebuild-ios",
            "xcrun",
            &[
                "xcodebuild",
                "-workspace",
                &project_root.join(&workspace.workspace).to_string_lossy(),
                "-scheme",
                &workspace.scheme,
                "-configuration",
                "Debug",
                "-sdk",
                "iphonesimulator",
                "-destination",
                "generic/platform=iOS Simulator",
                "-derivedDataPath",
                &derived_data.to_string_lossy(),
                // Certificate-free ad-hoc signing keeps entitlements such as keychain access on the simulator.
                "CODE_SIGNING_ALLOWED=YES",
                "CODE_SIGNING_REQUIRED=YES",
                "CODE_SIGN_IDENTITY=-",
                "CODE_SIGN_STYLE=Manual",
                "DEVELOPMENT_TEAM=",
                "PROVISIONING_PROFILE_SPECIFIER=",
                "build",
            ],
            deadline_seconds,
        )
        .cwd(project_root)
        .env_remove("CI")
        .env("EXPO_NO_TELEMETRY", "1")
        .env("RCT_NO_LAUNCH_PACKAGER", "1");
    }
    CmdSpec::new(
        "expo-run-ios",
        "pnpm",
        &[
            "exec",
            "expo",
            "run:ios",
            "--device",
            "generic",
            "--no-bundler",
            "--output",
            &output.to_string_lossy(),
        ],
        deadline_seconds,
    )
    .cwd(project_root)
    .env_remove("CI")
    .env("EXPO_NO_TELEMETRY", "1")
}

pub fn built_app(output: &Path) -> Result<std::path::PathBuf, String> {
    if !std::fs::symlink_metadata(output)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("build output is not a real directory".into());
    }
    let mut apps = Vec::new();
    for entry in std::fs::read_dir(output).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "app") {
            apps.push(path);
        }
    }
    match apps.as_slice() {
        [app] => Ok(app.clone()),
        _ => Err(format!(
            "expected exactly one simulator .app, found {}",
            apps.len()
        )),
    }
}

pub fn verify_app(
    runner: &mut dyn Runner,
    path: &Path,
    app_id: &str,
    scheme: &str,
) -> Result<crate::buildplan::CachedArtifact, String> {
    use std::os::unix::fs::PermissionsExt;
    fn regular_tree(path: &Path) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                regular_tree(&entry.map_err(|e| e.to_string())?.path())?;
            }
        } else if !meta.is_file() {
            return Err("app bundle contains a symlink or special file".into());
        }
        Ok(())
    }
    if !path.is_dir() || path.extension().is_none_or(|ext| ext != "app") {
        return Err("artifact is not an app bundle directory".into());
    }
    regular_tree(path)?;
    let info = runner.run_private(
        &CmdSpec::new(
            "ios-app-info",
            "plutil",
            &[
                "-convert",
                "json",
                "-o",
                "-",
                &path.join("Info.plist").to_string_lossy(),
            ],
            10,
        ),
        &[],
    );
    if !info.clean() {
        return Err("app Info.plist could not be read".into());
    }
    let info: serde_json::Value =
        serde_json::from_str(info.stdout()).map_err(|_| "app Info.plist is not an object")?;
    if info["CFBundleIdentifier"].as_str() != Some(app_id)
        || info["CFBundlePackageType"].as_str() != Some("APPL")
        || info["CFBundleSupportedPlatforms"] != serde_json::json!(["iPhoneSimulator"])
        || !info["CFBundleURLTypes"].as_array().is_some_and(|types| {
            types.iter().any(|t| {
                t["CFBundleURLSchemes"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s.as_str() == Some(scheme)))
            })
        })
    {
        return Err(
            "app bundle identity, simulator platform or launch scheme does not match".into(),
        );
    }
    let executable = info["CFBundleExecutable"]
        .as_str()
        .ok_or("app executable is missing")?;
    if executable.is_empty() || executable == "." || executable == ".." || executable.contains('/')
    {
        return Err("app executable is not a bundle-local filename".into());
    }
    let executable = path.join(executable);
    let meta = std::fs::metadata(&executable).map_err(|_| "app executable is missing")?;
    if !meta.is_file() || meta.len() < 4 || meta.permissions().mode() & 0o111 == 0 {
        return Err("app executable is not usable".into());
    }
    let binary = runner.run_private(
        &CmdSpec::new(
            "ios-app-platform",
            "xcrun",
            &["vtool", "-show-build", &executable.to_string_lossy()],
            10,
        ),
        &[],
    );
    let platforms: Vec<_> = binary
        .stdout()
        .lines()
        .filter_map(|line| line.trim().strip_prefix("platform "))
        .collect();
    if !binary.clean()
        || platforms.is_empty()
        || platforms.iter().any(|p| p.trim() != "IOSSIMULATOR")
    {
        return Err("app executable does not prove an iOS simulator build".into());
    }
    verify_initial_url_launcher(runner, path, &executable)?;
    Ok(crate::buildplan::CachedArtifact {
        path: path.to_path_buf(),
        sha256: crate::buildplan::hash_artifact(path)?,
        kind: crate::buildplan::ArtifactKind::AppBundle,
    })
}

// Large debug images print tens of MB of symbols; filter in the child so the capture stays bounded.
fn filtered_probe(label: &str, pipeline: &str, image: &Path) -> CmdSpec {
    CmdSpec::new(
        label,
        "/bin/bash",
        &[
            "-o",
            "pipefail",
            "-c",
            pipeline,
            "qaren-probe",
            &image.to_string_lossy(),
        ],
        20,
    )
}

fn verify_initial_url_launcher(
    runner: &mut dyn Runner,
    app: &Path,
    executable: &Path,
) -> Result<(), String> {
    let refused = "app does not prove support for direct Metro launch via --initialUrl";
    if app.join("main.jsbundle").exists() {
        return Err(refused.into());
    }
    let linked = runner.run_private(
        &CmdSpec::new(
            "ios-app-linked-images",
            "xcrun",
            &["otool", "-L", &executable.to_string_lossy()],
            10,
        ),
        &[],
    );
    if !linked.clean() {
        return Err(refused.into());
    }
    // Xcode's debug executable may delegate to a bundle-local dylib.
    let debug_name = format!(
        "{}.debug.dylib",
        executable.file_name().unwrap().to_string_lossy()
    );
    let debug_link = format!("@rpath/{debug_name}");
    let image = if linked.stdout().lines().skip(1).any(|line| {
        line.rsplit_once(" (compatibility version ")
            .is_some_and(|(name, _)| name.trim() == debug_link)
    }) {
        app.join(debug_name)
    } else {
        executable.to_path_buf()
    };
    if !image.is_file() {
        return Err(refused.into());
    }
    let symbols = runner.run_private(
        &filtered_probe(
            "ios-app-launcher-symbols",
            "xcrun nm -j -U \"$1\" | grep -F EXDevLauncherController",
            &image,
        ),
        &[],
    );
    if !symbols.clean()
        || ![
            "+[EXDevLauncherController initialUrlFromProcessInfo]",
            "-[EXDevLauncherController start:launchOptions:]",
            "-[EXDevLauncherController loadApp:withProjectUrl:onSuccess:onError:]",
        ]
        .iter()
        .all(|required| symbols.stdout().lines().any(|line| line == *required))
    {
        return Err(refused.into());
    }
    let strings = runner.run_private(
        &filtered_probe(
            "ios-app-launcher-arguments",
            "xcrun otool -v -s __TEXT __cstring \"$1\" | grep -E '[[:space:]]--initialUrl$'",
            &image,
        ),
        &[],
    );
    if !strings.clean()
        || !strings.stdout().lines().any(|line| {
            let mut fields = line.split_whitespace();
            fields
                .next()
                .is_some_and(|address| address.bytes().all(|b| b.is_ascii_hexdigit()))
                && fields.next() == Some("--initialUrl")
                && fields.next().is_none()
        })
    {
        return Err(refused.into());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimPresence {
    Present { name: String, state: String },
    Absent,
    Unparseable,
}

pub fn parse_sim_presence(list_json: &str, udid: &str) -> SimPresence {
    let parsed: serde_json::Value = match serde_json::from_str(list_json) {
        Ok(v) => v,
        Err(_) => return SimPresence::Unparseable,
    };
    let Some(devices) = parsed.get("devices").and_then(|d| d.as_object()) else {
        return SimPresence::Unparseable;
    };
    for runtime_devices in devices.values() {
        let Some(list) = runtime_devices.as_array() else {
            return SimPresence::Unparseable;
        };
        for device in list {
            if device.get("udid").and_then(|u| u.as_str()) == Some(udid) {
                let name = device.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let state = device.get("state").and_then(|s| s.as_str()).unwrap_or("");
                if name.is_empty() || state.is_empty() {
                    return SimPresence::Unparseable;
                }
                return SimPresence::Present {
                    name: name.to_string(),
                    state: state.to_string(),
                };
            }
        }
    }
    SimPresence::Absent
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimNamed {
    Found { udid: String, state: String },
    Ambiguous(usize),
    Absent,
    Unparseable,
}

// Recovery path for a pending allocation whose create crashed before the udid
// was learned: the run-scoped name is the only ownership key.
pub fn parse_sim_named(list_json: &str, name: &str) -> SimNamed {
    let parsed: serde_json::Value = match serde_json::from_str(list_json) {
        Ok(v) => v,
        Err(_) => return SimNamed::Unparseable,
    };
    let Some(devices) = parsed.get("devices").and_then(|d| d.as_object()) else {
        return SimNamed::Unparseable;
    };
    let mut matches = Vec::new();
    for runtime_devices in devices.values() {
        let Some(list) = runtime_devices.as_array() else {
            return SimNamed::Unparseable;
        };
        for device in list {
            if device.get("name").and_then(|n| n.as_str()) == Some(name) {
                let udid = device.get("udid").and_then(|u| u.as_str()).unwrap_or("");
                let state = device.get("state").and_then(|s| s.as_str()).unwrap_or("");
                if udid.is_empty() || state.is_empty() {
                    return SimNamed::Unparseable;
                }
                matches.push((udid.to_string(), state.to_string()));
            }
        }
    }
    match matches.len() {
        0 => SimNamed::Absent,
        1 => {
            let (udid, state) = matches.remove(0);
            SimNamed::Found { udid, state }
        }
        n => SimNamed::Ambiguous(n),
    }
}

// launchctl list rows are "PID Status Label"; a loaded-but-dead job shows "-" as PID.
pub fn app_running_in_launchctl(launchctl_output: &str, app_id: &str) -> bool {
    let label_prefix = format!("UIKitApplication:{app_id}[");
    launchctl_output.lines().any(|line| {
        let mut cols = line.split_whitespace();
        let pid_ok = cols.next().is_some_and(|pid| pid.parse::<u32>().is_ok());
        let label_ok = cols
            .nth(1)
            .is_some_and(|label| label.starts_with(&label_prefix));
        pid_ok && label_ok
    })
}

#[cfg(test)]
mod tests {
    use super::filtered_probe;
    use crate::exec::{CmdSpec, RealRunner, Runner};
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    const FAKE_XCRUN: &str = r#"#!/bin/bash
filler() { head -c 20971520 /dev/zero | tr '\0' 'x' | fold -w 63; }
case "$1" in
  nm)
    filler
    [ "$QAREN_FAKE_MODE" = "filler" ] && exit 0
    printf '%s\n' '+[EXDevLauncherController initialUrlFromProcessInfo]' \
      '-[EXDevLauncherController start:launchOptions:]' \
      '-[EXDevLauncherController loadApp:withProjectUrl:onSuccess:onError:]'
    [ "$QAREN_FAKE_MODE" = "fail" ] && exit 1
    exit 0 ;;
  otool)
    filler
    printf '0000000100012345  --initialUrl\n' ;;
esac
"#;

    fn fake_tools(mode: &str) -> (PathBuf, String) {
        let dir =
            std::env::temp_dir().join(format!("qaren-fake-xcrun-{}-{mode}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let xcrun = dir.join("xcrun");
        std::fs::write(&xcrun, FAKE_XCRUN).unwrap();
        std::fs::set_permissions(&xcrun, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:/usr/bin:/bin", dir.display());
        (dir, path)
    }

    fn probes(image: &Path, path: &str, mode: &str) -> [CmdSpec; 2] {
        [
            filtered_probe(
                "ios-app-launcher-symbols",
                "xcrun nm -j -U \"$1\" | grep -F EXDevLauncherController",
                image,
            ),
            filtered_probe(
                "ios-app-launcher-arguments",
                "xcrun otool -v -s __TEXT __cstring \"$1\" | grep -E '[[:space:]]--initialUrl$'",
                image,
            ),
        ]
        .map(|spec| spec.env("PATH", path).env("QAREN_FAKE_MODE", mode))
    }

    #[test]
    fn filtered_launcher_probes_stay_under_the_capture_cap_for_a_20_mib_table() {
        let (dir, path) = fake_tools("ok");
        let image = dir.join("App.debug.dylib");
        let mut runner = RealRunner::new();
        let [symbols, strings] = probes(&image, &path, "ok");
        let symbols = runner.run_private(&symbols, &[]);
        let strings = runner.run_private(&strings, &[]);
        assert!(symbols.clean() && strings.clean());
        assert!(symbols.stdout().len() < 64 * 1024 && strings.stdout().len() < 64 * 1024);
        assert!(symbols
            .stdout()
            .lines()
            .any(|l| l == "-[EXDevLauncherController start:launchOptions:]"));
        assert!(strings.stdout().contains("--initialUrl"));
        let unfiltered = CmdSpec::new(
            "unfiltered-symbols",
            "xcrun",
            &["nm", "-j", "-U", &image.to_string_lossy()],
            20,
        )
        .env("PATH", &path)
        .env("QAREN_FAKE_MODE", "ok");
        assert!(!runner.run_private(&unfiltered, &[]).clean());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_failing_or_empty_symbol_probe_is_not_clean() {
        for mode in ["fail", "filler"] {
            let (dir, path) = fake_tools(mode);
            let image = dir.join("App.debug.dylib");
            let mut runner = RealRunner::new();
            let [symbols, _] = probes(&image, &path, mode);
            assert!(!runner.run_private(&symbols, &[]).clean(), "{mode}");
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}
