use crate::adapters::{android, ios};
use crate::commands::prepare::missing_android_sdk;
use crate::commands::update::{INSTALLER, PLUGIN_MANIFEST};
use crate::config::{AndroidConfig, CheckConfig, DEFAULT_CONFIG_PATH};
use crate::exec::{CmdSpec, Runner};
use crate::scenario::Platform;
use serde::Serialize;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

mod host;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const INSTALL: &str = "bash <plugin>/scripts/ensure-qaren.sh --install";
const MCP_MARKERS: [&str; 2] = ["rn-dev-agent-core", "cdp-supervisor"];
const PROJECT_SENTINELS: [&str; 2] = [
    "<!-- rn-dev-agent:template-start -->",
    "<!-- rn-dev-agent:codex-template-start -->",
];
const ENV_PREFIXES: [&str; 2] = ["RN_DEV_AGENT_", "RN_AGENT_"];
const ENV_NAMES: [&str; 6] = [
    "RN_CDP_AUTOCONNECT",
    "RN_METRO_PORT",
    "RN_PROJECT_ROOT",
    "RN_DEVICE_KILL_LEGACY",
    "RN_GITIGNORE",
    "RN_BRIDGE_WORKER_PATH",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pass,
    Warn,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub status: Status,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

impl Check {
    fn pass(id: &'static str, detail: impl Into<String>) -> Self {
        Check {
            id,
            status: Status::Pass,
            detail: detail.into(),
            fix: None,
        }
    }

    fn skip(id: &'static str, detail: impl Into<String>) -> Self {
        Check {
            status: Status::Skip,
            ..Check::pass(id, detail)
        }
    }

    fn problem(
        id: &'static str,
        status: Status,
        detail: impl Into<String>,
        fix: impl Into<String>,
    ) -> Self {
        Check {
            id,
            status,
            detail: detail.into(),
            fix: Some(fix.into()),
        }
    }

    fn warn(id: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Self {
        Check::problem(id, Status::Warn, detail, fix)
    }

    fn fail(id: &'static str, detail: impl Into<String>, fix: impl Into<String>) -> Self {
        Check::problem(id, Status::Fail, detail, fix)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Identity {
    pub exe: Option<PathBuf>,
    pub version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build: Option<String>,
    pub runtime: PathBuf,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub identity: Identity,
    pub checks: Vec<Check>,
}

impl Report {
    fn failed(&self) -> bool {
        self.checks.iter().any(|check| check.status == Status::Fail)
    }

    pub fn exit_code(&self) -> u8 {
        u8::from(self.failed())
    }

    pub fn render(&self) -> String {
        let identity = &self.identity;
        let exe = identity
            .exe
            .as_ref()
            .map_or("an unknown path".to_string(), |exe| {
                exe.display().to_string()
            });
        let build = identity
            .build
            .as_ref()
            .map_or(String::new(), |build| format!(" (build {build})"));
        let mut out = printable(&format!(
            "qaren {} at {exe}{build}, runtime {}",
            identity.version,
            identity.runtime.display()
        )) + "\n";
        for check in &self.checks {
            let label = match check.status {
                Status::Pass => "PASS",
                Status::Warn => "WARN",
                Status::Fail => "FAIL",
                Status::Skip => "SKIP",
            };
            out.push_str(&format!(
                "{label} {}: {}\n",
                check.id,
                printable(&check.detail)
            ));
            if let Some(fix) = &check.fix {
                out.push_str(&format!(
                    "     fix: {}\n",
                    fix.lines()
                        .map(printable)
                        .collect::<Vec<_>>()
                        .join("\n     ")
                ));
            }
        }
        let count = |status| self.checks.iter().filter(|c| c.status == status).count();
        out.push_str(&format!(
            "doctor: {} fail, {} warn, {} pass, {} skip\n",
            count(Status::Fail),
            count(Status::Warn),
            count(Status::Pass),
            count(Status::Skip)
        ));
        crate::redact::redact_inputs(&out)
    }

    pub fn to_json(&self) -> String {
        let verdict = if self.failed() { "fail" } else { "pass" };
        crate::redact::durable_json(&serde_json::json!({
            "identity": self.identity,
            "checks": self.checks,
            "verdict": verdict,
        }))
        .unwrap_or_else(|_| "{}".to_string())
    }
}

// Read-only: host probes never change a device or start a service.
pub fn doctor(
    runner: &mut dyn Runner,
    home: &Path,
    cwd: &Path,
    exe: Option<PathBuf>,
    runtime: PathBuf,
    config_path: Option<&Path>,
) -> Report {
    let exe = exe.map(|exe| canonical(&exe));
    let runtime_root = canonical(&home.join(".qaren").join("runtime"));
    let config_file = cwd.join(config_path.unwrap_or(Path::new(DEFAULT_CONFIG_PATH)));
    let (config_row, config) = config_check(&config_file);
    let set = |name: &str| runner.env_var(name).filter(|value| !value.is_empty());
    let path_dirs: Vec<PathBuf> = set("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let codex_home = set("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let claude_config_dir = set("CLAUDE_CONFIG_DIR").map(PathBuf::from);
    let xdg_state = set("XDG_STATE_HOME").map(PathBuf::from);
    let android_home = set("ANDROID_HOME");
    let configured_node = config.as_ref().and_then(|c| c.node_path.clone());
    let ios_runtime = config
        .as_ref()
        .and_then(|c| c.ios.as_ref()?.runtime.clone());
    let qaren_hits = find_on_path(&path_dirs, "qaren");

    let mut checks = vec![
        xcode(runner),
        ios_runtimes(runner, ios_runtime.as_deref()),
        node_check(runner, configured_node.as_deref()),
        tool(
            runner,
            "pnpm",
            "pnpm",
            Status::Fail,
            "enable it: `corepack enable && corepack prepare pnpm@latest --activate && (cd / && pnpm --version)`",
        ),
        tool(
            runner,
            "corepack",
            "corepack",
            Status::Warn,
            "ships with Node 24; `corepack enable`",
        ),
        tool(
            runner,
            "cocoapods",
            "pod",
            Status::Warn,
            "`brew install cocoapods`; expo run:ios installs pods on the first iOS build",
        ),
        disk(runner, cwd, home),
    ];
    checks.extend(android_checks(
        runner,
        config.as_ref().and_then(|c| c.android.as_ref()),
        android_home.as_deref(),
    ));
    checks.push(evaluate_path(&qaren_hits, exe.as_deref(), &runtime_root));
    checks.push(effective_runtime(
        installed_build(
            exe.as_deref(),
            &runtime_root,
            qaren_hits.first().map(PathBuf::as_path),
        ),
        &runtime,
    ));
    checks.push(runtime_dirs(&runtime_root));
    checks.push(source_checkout(runner, cwd));
    checks.push(config_row);
    let app_root =
        crate::run::app_root_for(&config_file, cwd).unwrap_or_else(|_| cwd.to_path_buf());
    checks.extend(login_checks(runner, &app_root, config.as_ref()));
    checks.push(saved_blocks_check(runner, &app_root));
    checks.extend(leftover_rows(
        home,
        &codex_home,
        claude_config_dir.as_deref(),
        xdg_state.as_deref(),
        cwd,
        &path_dirs,
        &runner.env_names(),
    ));
    checks.extend(host::checks(runner, std::env::consts::OS));

    let build = exe
        .as_deref()
        .and_then(|exe| installed_version_dir(exe, &runtime_root))
        .and_then(|dir| sha256_record(&dir))
        .map(|sha| sha[..8].to_string());
    Report {
        identity: Identity {
            exe,
            version: VERSION,
            build,
            runtime,
        },
        checks,
    }
}

// Names read from files an app repository controls must not forge rows or drive the terminal.
fn printable(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c.is_control() {
                c.escape_default().to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

// One shell word for a name or path pasted into a fix command.
fn sh(word: impl std::fmt::Display) -> String {
    let word = word.to_string();
    if word.chars().any(char::is_control) {
        // Bash/zsh ANSI-C quoting preserves bytes without emitting terminal controls.
        let escaped: String = word.bytes().map(|byte| format!("\\{byte:03o}")).collect();
        return format!("$'{escaped}'");
    }
    let plain = !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-+@=:,".contains(c));
    if plain {
        word
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn executable(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

fn find_on_path(dirs: &[PathBuf], name: &str) -> Vec<PathBuf> {
    dirs.iter()
        .map(|dir| dir.join(name))
        .filter(|candidate| executable(candidate))
        .collect()
}

fn joined(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn sha256_record(version_dir: &Path) -> Option<String> {
    let sha = read(&version_dir.join(".tarball-sha256"))
        .trim()
        .to_string();
    (sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sha)
}

fn xcode(runner: &mut dyn Runner) -> Check {
    let output = runner.run(&ios::xcode_version_spec());
    if output.ok() && !output.stdout.trim().is_empty() {
        let lines: Vec<&str> = output.stdout.trim().lines().map(str::trim).collect();
        return Check::pass("xcode", lines.join(", "));
    }
    Check::fail(
        "xcode",
        format!("xcodebuild -version did not run: {}", output.summary()),
        "install Xcode and select it: `xcode-select -s /Applications/Xcode.app`",
    )
}

fn ios_runtimes(runner: &mut dyn Runner, configured: Option<&str>) -> Check {
    let output = runner.run(&ios::list_runtimes_spec());
    if output.timed_out {
        return Check::warn(
            "ios-runtime",
            "simctl did not read the runtime inventory in time; availability is unknown",
            "check the simulator-service row, then re-run doctor after the inventory responds",
        );
    }
    if !output.ok() {
        return Check::fail(
            "ios-runtime",
            format!("simctl could not list runtimes: {}", output.summary()),
            host::SIMCTL_FIX,
        );
    }
    let available = ios::parse_available_runtimes(&output.stdout);
    if available.is_empty() {
        return Check::fail(
            "ios-runtime",
            "no iOS simulator runtime is available",
            "install an iOS platform in Xcode > Settings > Components",
        );
    }
    let names = available
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    match configured {
        Some(wanted)
            if !available
                .iter()
                .any(|(name, identifier)| name == wanted || identifier == wanted) =>
        {
            Check::fail(
                "ios-runtime",
                format!("ios.runtime {wanted:?} is not available; available: {names}"),
                "check ios.device_type and ios.runtime against `xcrun simctl list`",
            )
        }
        _ => Check::pass("ios-runtime", format!("{names} available")),
    }
}

// A nodePath named by the project config is never run, so doctor is safe on an untrusted clone.
fn node_check(runner: &mut dyn Runner, configured: Option<&str>) -> Check {
    let env = runner.env_var("QAREN_NODE");
    if let (None, Some(configured)) = (&env, configured) {
        return if executable(Path::new(configured)) {
            Check::pass(
                "node",
                "configured nodePath is executable; version not checked; run qaren check to verify",
            )
        } else {
            Check::fail(
                "node",
                "configured nodePath is not an executable file",
                "point nodePath in .qaren/config.yaml at a node >= 24",
            )
        };
    }
    // The node is named by its source only: a QAREN_NODE value is never printed.
    let source = if env.is_some() {
        "QAREN_NODE"
    } else {
        "node on PATH"
    };
    let node = PathBuf::from(env.as_deref().unwrap_or("node"));
    match crate::run::preflight_node(runner, &node) {
        Ok(version) => Check::pass("node", format!("{source} reports {version}")),
        Err(failure) => {
            let detail = if failure.code == crate::failure::FailureCode::NodeUnsupported {
                format!("{source} is older than 24; qaren needs node >= 24")
            } else {
                format!("{source} did not run")
            };
            Check::fail("node", detail, failure.next_action.to_string())
        }
    }
}

fn tool(
    runner: &mut dyn Runner,
    id: &'static str,
    program: &str,
    missing: Status,
    fix: &str,
) -> Check {
    // Outside any project, so corepack neither refuses nor downloads a repository-pinned version.
    let output = runner.run(
        &CmdSpec::new(&format!("{program}-version"), program, &["--version"], 10)
            .cwd(Path::new("/"))
            .env("COREPACK_ENABLE_NETWORK", "0"),
    );
    if output.ok() {
        let version = output.stdout.trim().lines().next().unwrap_or_default();
        return Check::pass(id, format!("{program} {version}"));
    }
    // Corepack's launcher downloads the binary on first use, which this offline probe forbids.
    let output_text = format!("{}{}", output.stderr, output.stdout);
    if output_text.contains("Network access") && output_text.contains("disabled by the environment")
    {
        return Check::problem(
            id,
            missing,
            format!("{program} is enabled but has not downloaded its binary yet"),
            format!("finish the first-run download with network access: `(cd / && {program} --version)`"),
        );
    }
    Check::problem(
        id,
        missing,
        format!("{program} --version did not run: {}", output.summary()),
        fix,
    )
}

fn disk(runner: &mut dyn Runner, cwd: &Path, home: &Path) -> Check {
    match crate::run::tightest_volume(runner, &[cwd, home]) {
        Ok((kb, path)) => match crate::run::clean_ios_build_shortfall(kb, path) {
            Some(detail) => Check::warn("disk", detail, crate::run::FREE_DISK_FIX),
            None => Check::pass(
                "disk",
                format!("{:.1} GiB free", kb as f64 / (1024.0 * 1024.0)),
            ),
        },
        Err(failure) => Check::skip("disk", failure.detail.to_string()),
    }
}

fn android_checks(
    runner: &mut dyn Runner,
    android: Option<&AndroidConfig>,
    android_home: Option<&str>,
) -> [Check; 2] {
    let Some(android) = android else {
        return [
            Check::skip("android-sdk", "android is not configured"),
            Check::skip("android-avd", "android is not configured"),
        ];
    };
    let sdk = match (android_home, missing_android_sdk(android_home)) {
        (Some(sdk), None) => sdk,
        (_, missing) => {
            return [
                Check::fail(
                    "android-sdk",
                    format!("missing prerequisites: {}", missing.unwrap_or_default()),
                    "install the Android SDK platform-tools and export ANDROID_HOME",
                ),
                Check::skip("android-avd", "needs the Android SDK"),
            ]
        }
    };
    let adb = android::adb_path(sdk);
    // Even `adb version` creates ~/.android on a fresh HOME.
    if !executable(&adb) {
        return [
            Check::fail(
                "android-sdk",
                format!("adb at {} is not executable", adb.display()),
                "reinstall the Android SDK platform-tools",
            ),
            Check::skip("android-avd", "needs an executable adb"),
        ];
    }
    let emulator = android::emulator_path(sdk);
    let sdk_row = if emulator.is_file() {
        Check::pass("android-sdk", format!("adb at {}", adb.display()))
    } else {
        Check::warn(
            "android-sdk",
            format!("no emulator at {}", emulator.display()),
            "install the Android Emulator in Android Studio > SDK Manager",
        )
    };
    let avd_row = match (&android.avd, emulator.is_file()) {
        (None, _) => Check::skip("android-avd", "no android.avd configured"),
        (Some(_), false) => Check::skip("android-avd", "needs the Android Emulator"),
        (Some(avd), true) => {
            let listed = runner.run(&android::list_avds_spec(&emulator));
            if listed.ok() && listed.stdout.lines().any(|line| line.trim() == avd) {
                Check::pass("android-avd", format!("AVD {avd} exists"))
            } else {
                Check::fail(
                    "android-avd",
                    format!(
                        "AVD {avd:?} is not listed by {} -list-avds",
                        emulator.display()
                    ),
                    "create the AVD in Android Studio > Device Manager, or fix android.avd",
                )
            }
        }
    };
    [sdk_row, avd_row]
}

fn installed_version_dir(exe: &Path, runtime_root: &Path) -> Option<PathBuf> {
    let bin = exe.parent()?;
    let version_dir = bin.parent()?;
    (exe.file_name()? == "qaren"
        && bin.file_name()? == "bin"
        && version_dir.parent()? == runtime_root)
        .then(|| version_dir.to_path_buf())
}

fn installed_builds(runtime_root: &Path) -> Vec<PathBuf> {
    let mut builds: Vec<PathBuf> = std::fs::read_dir(runtime_root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .map(|entry| entry.path().join("bin").join("qaren"))
        .filter(|exe| executable(exe))
        .collect();
    builds.sort();
    builds
}

fn evaluate_path(hits: &[PathBuf], exe: Option<&Path>, runtime_root: &Path) -> Check {
    let Some(first) = hits.first() else {
        return Check::warn(
            "qaren-path",
            "no qaren executable on PATH",
            format!("`{INSTALL}` links it into ~/.local/bin"),
        );
    };
    let first_target = canonical(first);
    let first_installed = first_target.starts_with(runtime_root);
    if let Some(exe) = exe {
        // A development binary started by path while PATH runs the installed build is fine.
        let dev_beside_install = !exe.starts_with(runtime_root) && first_installed;
        if first_target != exe && !dev_beside_install {
            let wanted = hits
                .iter()
                .find(|hit| canonical(hit) == exe)
                .and_then(|hit| hit.parent())
                .or(exe.parent())
                .unwrap_or(exe);
            return Check::fail(
                "qaren-path",
                format!(
                    "PATH runs {} ({}), this is {}",
                    first.display(),
                    first_target.display(),
                    exe.display()
                ),
                format!(
                    "remove {} or put {} first in PATH",
                    sh(first.display()),
                    sh(wanted.display())
                ),
            );
        }
    }
    let mut seen = vec![first_target.clone()];
    let mut extras = Vec::new();
    for hit in &hits[1..] {
        let target = canonical(hit);
        if !seen.contains(&target) {
            seen.push(target);
            extras.push(hit.clone());
        }
    }
    let mut problems = Vec::new();
    let mut fixes = Vec::new();
    if !extras.is_empty() {
        problems.push(format!(
            "{} more qaren executables on PATH: {}",
            extras.len(),
            joined(&extras)
        ));
        fixes.push(format!(
            "remove them (rm <path>) or put {} first in PATH",
            sh(first.parent().unwrap_or(first).display())
        ));
    }
    if !first_installed {
        problems.push(format!(
            "{} is not the installed build under {}",
            first.display(),
            runtime_root.display()
        ));
        fixes.push(format!("install it with `{INSTALL}`"));
    }
    if problems.is_empty() {
        Check::pass(
            "qaren-path",
            format!("{} runs {}", first.display(), first_target.display()),
        )
    } else {
        Check::warn("qaren-path", problems.join("; "), fixes.join("; "))
    }
}

fn installed_build(exe: Option<&Path>, runtime_root: &Path, path_first: Option<&Path>) -> Check {
    let reinstall = format!("reinstall: `{INSTALL}`, or `qaren update` from a checkout");
    let Some(exe) = exe else {
        return Check::fail(
            "installed-build",
            "cannot resolve this binary's path",
            reinstall,
        );
    };
    if let Some(dir) = installed_version_dir(exe, runtime_root) {
        let mut missing = Vec::new();
        let version = read(&dir.join("VERSION")).trim().to_string();
        if version != VERSION {
            missing.push(format!(
                "VERSION does not match this binary's version {VERSION}"
            ));
        }
        if sha256_record(&dir).is_none() {
            missing.push(".tarball-sha256 is not a sha256".to_string());
        }
        if !dir.join("runtime").join("qa").join("walk.js").is_file() {
            missing.push("runtime/qa/walk.js is missing".to_string());
        }
        return if missing.is_empty() {
            Check::pass("installed-build", format!("installed at {}", dir.display()))
        } else {
            Check::fail(
                "installed-build",
                format!("{}: {}", dir.display(), missing.join("; ")),
                reinstall,
            )
        };
    }
    let installs = installed_builds(runtime_root);
    let runs_from_path = path_first.is_some_and(|first| canonical(first) == exe);
    match installs.first() {
        Some(installed) if runs_from_path => Check::fail(
            "installed-build",
            format!(
                "{} shadows the installed build at {}",
                exe.display(),
                installed.display()
            ),
            format!(
                "remove {} or put its directory after ~/.local/bin in PATH",
                sh(path_first.unwrap_or(exe).display())
            ),
        ),
        Some(installed) => Check::warn(
            "installed-build",
            format!(
                "development binary {}; the installed build is {}",
                exe.display(),
                installed.display()
            ),
            "run the installed build to check this host",
        ),
        None => Check::warn(
            "installed-build",
            format!("development binary {}; no installed build", exe.display()),
            format!("install with `{INSTALL}` or `qaren update` from a checkout"),
        ),
    }
}

// `check` runs the effective runtime (QAREN_RUNTIME or the installed one), so it must be complete too.
fn effective_runtime(installed: Check, runtime: &Path) -> Check {
    if installed.status == Status::Fail || runtime.join("qa").join("walk.js").is_file() {
        return installed;
    }
    Check::fail(
        "installed-build",
        "the runtime named in the identity line has no qa/walk.js",
        format!("unset QAREN_RUNTIME or point it at a complete runtime; otherwise reinstall: `{INSTALL}`"),
    )
}

fn runtime_dirs(runtime_root: &Path) -> Check {
    let Ok(entries) = std::fs::read_dir(runtime_root) else {
        return Check::skip(
            "runtime-dirs",
            format!("no runtime directory at {}", runtime_root.display()),
        );
    };
    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name != VERSION && name != "runners" && !name.starts_with(".lock-"))
        .collect();
    names.sort();
    if names.is_empty() {
        return Check::pass("runtime-dirs", "no other runtime versions");
    }
    let (staging, others): (Vec<String>, Vec<String>) = names
        .into_iter()
        .partition(|name| name.starts_with(".staging-"));
    let mut problems = Vec::new();
    let mut fixes = Vec::new();
    if !staging.is_empty() {
        problems.push(format!("interrupted install: {}", staging.join(", ")));
        fixes.push(format!("repair it with: {INSTALL}"));
    }
    if !others.is_empty() {
        problems.push(format!("other runtime versions: {}", others.join(", ")));
        fixes.extend(others.iter().map(|old| {
            format!(
                "`rm -r {}` once nothing links to it",
                sh(runtime_root.join(old).display())
            )
        }));
    }
    Check::warn("runtime-dirs", problems.join("; "), fixes.join("; "))
}

fn source_checkout(runner: &mut dyn Runner, cwd: &Path) -> Check {
    let manifest = cwd.join(PLUGIN_MANIFEST);
    if !cwd.join(INSTALLER).is_file() || !manifest.is_file() {
        return Check::skip("source-checkout", "not in an rn-dev-agent checkout");
    }
    let version = serde_json::from_str::<serde_json::Value>(&read(&manifest))
        .ok()
        .and_then(|json| json.get("version")?.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let head = runner
        .run(&CmdSpec::new("git-head", "git", &["rev-parse", "--short", "HEAD"], 10).cwd(cwd));
    let head = if head.ok() {
        head.stdout.trim().to_string()
    } else {
        "an unknown commit".to_string()
    };
    if version == VERSION {
        Check::pass(
            "source-checkout",
            format!("checkout at {head}, version {version}"),
        )
    } else {
        Check::warn(
            "source-checkout",
            format!("checkout at {head} is version {version}; this binary is {VERSION}"),
            "run `qaren update` here",
        )
    }
}

fn config_check(file: &Path) -> (Check, Option<CheckConfig>) {
    if !file.exists() {
        return (
            Check::skip("config", format!("no config at {}", file.display())),
            None,
        );
    }
    let config = match CheckConfig::load(file) {
        Ok((config, _)) => config,
        Err(failure) => {
            return (
                Check::fail(
                    "config",
                    format!("{}: {:?}", file.display(), failure.code),
                    "fix the config using the documented .qaren/config.yaml schema",
                ),
                None,
            )
        }
    };
    let mut validation = config.validate_for_platform(Platform::Ios);
    if validation.is_ok() && config.android.is_some() {
        validation = config.validate_for_platform(Platform::Android);
    }
    // Like check, nothing from a config that fails validation (such as nodePath) is ever run.
    match validation {
        Ok(()) => (
            Check::pass("config", format!("{} is valid", file.display())),
            Some(config),
        ),
        Err(failure) => (
            Check::fail(
                "config",
                format!("{}: {:?}", file.display(), failure.code),
                "fix the config using the documented .qaren/config.yaml schema",
            ),
            None,
        ),
    }
}

fn login_checks(runner: &mut dyn Runner, root: &Path, config: Option<&CheckConfig>) -> Vec<Check> {
    let Some(config) = config else {
        return vec![Check::skip("login", "no app config")];
    };
    let mut platforms = vec!["ios"];
    if config.android.is_some() {
        platforms.push("android");
    }
    platforms
        .into_iter()
        .map(|platform| {
            if let Some(slug) = &config.login_block {
                let Some(text) =
                    crate::actions::show_for(runner, root, slug, platform, &config.app_id)
                else {
                    return Check::warn(
                        "login",
                        format!("loginBlock {slug} is not saved for {platform}"),
                        "run the plan that holds its `### Sign in` block once",
                    );
                };
                let Some(block) = crate::actions::login_block(&text) else {
                    return Check::fail(
                        "login",
                        format!("loginBlock {slug} for {platform} is not a readable saved block"),
                        "run the plan that holds its `### Sign in` block once to save it again",
                    );
                };
                if let Some(hint) = block.config_hint(slug, config.login_marker.as_ref()) {
                    return Check::warn(
                        "login",
                        format!("loginBlock {slug} for {platform} cannot replay as login"),
                        hint.text,
                    );
                }
                Check::pass(
                    "login",
                    format!(
                        "loginBlock {slug} is saved for {platform} (inputs {})",
                        block.inputs.join(", ")
                    ),
                )
            } else {
                let hints: Vec<_> = crate::actions::list(runner, root)
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(|entry| {
                        crate::actions::login_hint(
                            runner,
                            root,
                            &entry.slug,
                            platform,
                            config,
                            true,
                        )
                    })
                    .collect();
                if hints.is_empty() {
                    Check::skip(
                        "login",
                        format!("no saved sign-in candidate for {platform}"),
                    )
                } else {
                    Check::warn(
                        "login",
                        format!("likely login block saved for {platform}"),
                        hints
                            .into_iter()
                            .map(|hint| hint.text)
                            .collect::<Vec<_>>()
                            .join("\n"),
                    )
                }
            }
        })
        .collect()
}

fn saved_blocks_check(runner: &mut dyn Runner, root: &Path) -> Check {
    use crate::actions::{corpus_hint, corpus_location, CorpusLocation};
    match corpus_location(runner, root) {
        CorpusLocation::NotGit => Check::skip("saved-blocks", "not a Git checkout"),
        CorpusLocation::Primary => Check::pass("saved-blocks", "primary checkout"),
        CorpusLocation::Linked { local: true }
            if crate::actions::actions_dir(runner, root).is_ok() =>
        {
            let status = crate::worktree::git(
                runner,
                "git-corpus-status",
                root,
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--ignored=matching",
                    "--",
                    ".qaren/actions",
                ],
                10,
            );
            match status
                .ok()
                .then(|| crate::run::porcelain_entries(&status.stdout).len())
            {
                Some(0) => Check::pass(
                    "saved-blocks",
                    "saved blocks in this linked worktree are committed",
                ),
                changed => Check::warn(
                    "saved-blocks",
                    "uncommitted saved blocks stay in this linked worktree",
                    corpus_hint(changed.unwrap_or_else(|| {
                        crate::actions::list(runner, root)
                            .map(|blocks| blocks.len())
                            .unwrap_or(0)
                    }))
                    .text,
                ),
            }
        }
        CorpusLocation::Linked { local: false }
            if crate::actions::actions_dir(runner, root).is_ok_and(|dir| dir.is_dir()) =>
        {
            Check::pass("saved-blocks", "saved blocks are linked to the main copy")
        }
        CorpusLocation::Linked { .. } => Check::warn("saved-blocks",
            "no shared saved-block corpus in this linked worktree",
            "commit saved blocks for other checkouts, or use the main-copy link described in the saved-block contract"),
    }
}

fn leftover(id: &'static str, found: Vec<String>, fixes: Vec<String>) -> Check {
    if found.is_empty() {
        Check::pass(id, "none found")
    } else {
        Check::warn(id, found.join("; "), fixes.join("; then "))
    }
}

fn dirs_present(dirs: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    dirs.into_iter().filter(|dir| dir.is_dir()).collect()
}

fn leftover_rows(
    home: &Path,
    codex_home: &Path,
    claude_config_dir: Option<&Path>,
    xdg_state: Option<&Path>,
    cwd: &Path,
    path_dirs: &[PathBuf],
    env_names: &[String],
) -> Vec<Check> {
    let claude_dir = claude_config_dir.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    let claude_config = claude_config_dir.unwrap_or(home).join(".claude.json");
    vec![
        claude_plugin(&claude_dir),
        codex_plugin(home, codex_home),
        mcp_servers(home, codex_home, cwd, &claude_config),
        binaries(path_dirs),
        home_dirs(home, xdg_state),
        project(cwd),
        environment(env_names),
    ]
}

fn claude_plugin(claude_dir: &Path) -> Check {
    let plugins = claude_dir.join("plugins");
    let mut found = Vec::new();
    for file in [
        plugins.join("installed_plugins.json"),
        claude_dir.join("settings.json"),
    ] {
        if read(&file).contains("rn-dev-agent@rn-dev-agent") {
            found.push(format!("rn-dev-agent@rn-dev-agent in {}", file.display()));
        }
    }
    let marketplaces = plugins.join("known_marketplaces.json");
    if read(&marketplaces).contains("\"rn-dev-agent\":") {
        found.push(format!(
            "marketplace rn-dev-agent in {}",
            marketplaces.display()
        ));
    }
    let mut fixes = Vec::new();
    if !found.is_empty() {
        fixes.push(
            "claude plugin uninstall rn-dev-agent@rn-dev-agent && claude plugin marketplace remove rn-dev-agent"
                .to_string(),
        );
    }
    for dir in dirs_present([
        plugins.join("cache").join("rn-dev-agent"),
        plugins.join("marketplaces").join("rn-dev-agent"),
    ]) {
        found.push(dir.display().to_string());
        fixes.push(format!("rm -r {}", sh(dir.display())));
    }
    leftover("1x-claude-plugin", found, fixes)
}

fn codex_plugin(home: &Path, codex_home: &Path) -> Check {
    let config = codex_home.join("config.toml");
    let text = read(&config);
    let mut found: Vec<String> = [
        "[plugins.\"rn-dev-agent@rn-dev-agent\"]",
        "[marketplaces.rn-dev-agent]",
    ]
    .into_iter()
    .filter(|header| text.contains(header))
    .map(|header| format!("{header} in {}", config.display()))
    .collect();
    found.extend(
        dirs_present([codex_home
            .join(".tmp")
            .join("marketplaces")
            .join("rn-dev-agent")])
        .iter()
        .map(|dir| dir.display().to_string()),
    );
    let mut fixes = Vec::new();
    if !found.is_empty() {
        fixes.push(
            "codex plugin remove rn-dev-agent@rn-dev-agent && codex plugin marketplace remove rn-dev-agent"
                .to_string(),
        );
    }
    for dir in dirs_present([codex_home
        .join("plugins")
        .join("cache")
        .join("rn-dev-agent")])
    {
        found.push(dir.display().to_string());
        fixes.push(format!(
            "rmdir {} (if it is not empty, inspect it rather than deleting it)",
            sh(dir.display())
        ));
    }
    let cursor = home.join(".cursor");
    let cursor_plugins = cursor.join("plugins");
    let mut cursor_found = dirs_present(
        std::fs::read_dir(cursor_plugins.join("cache"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|marketplace| marketplace.path().join("rn-dev-agent"))
            .chain([cursor_plugins.join("local").join("rn-dev-agent")]),
    );
    let cursor_mcp = cursor.join("mcp.json");
    if read(&cursor_mcp).contains("rn-dev-agent") {
        cursor_found.push(cursor_mcp);
    }
    if !cursor_found.is_empty() {
        cursor_found.sort();
        found.push(format!("Cursor: {}", joined(&cursor_found)));
        fixes.push("In Cursor, remove the plugin from Customize > Plugins".to_string());
    }
    leftover("1x-codex-plugin", found, fixes)
}

fn json_mcp_servers(file: &Path) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&read(file)) else {
        return Vec::new();
    };
    let mut tables = vec![json.get("mcpServers")];
    if let Some(projects) = json.get("projects").and_then(serde_json::Value::as_object) {
        tables.extend(projects.values().map(|project| project.get("mcpServers")));
    }
    let mut names: Vec<String> = tables
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_object)
        .flatten()
        .filter(|(_, server)| {
            let text = server.to_string();
            MCP_MARKERS.iter().any(|marker| text.contains(marker))
        })
        .map(|(name, _)| name.clone())
        .collect();
    names.dedup();
    names
}

// Only the section header is ever reported; the body can hold secrets.
fn table_header_end(line: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (index, ch) in line.char_indices() {
        match quote {
            Some('"') if escaped => escaped = false,
            Some('"') if ch == '\\' => escaped = true,
            Some(open) if ch == open => quote = None,
            Some(_) => {}
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch == ']' => return Some(index),
            None => {}
        }
    }
    None
}

#[derive(Debug, PartialEq)]
enum McpHeader {
    Named(String),
    Malformed(usize),
}

fn toml_mcp_headers(text: &str) -> Vec<McpHeader> {
    let mut current: Option<McpHeader> = None;
    let mut headers: Vec<McpHeader> = Vec::new();
    for (index, line) in text.lines().map(str::trim).enumerate() {
        if line.starts_with('[') {
            // An unclosed header is reported by line number only: its `# ...` tail can hold private notes.
            current = line.starts_with("[mcp_servers.").then(|| {
                table_header_end(line).map_or(McpHeader::Malformed(index + 1), |end| {
                    McpHeader::Named(line[..=end].to_string())
                })
            });
        }
        if MCP_MARKERS.iter().any(|marker| line.contains(marker)) {
            if let Some(header) = current.take().filter(|header| !headers.contains(header)) {
                headers.push(header);
            }
        }
    }
    headers
}

fn mcp_servers(home: &Path, codex_home: &Path, cwd: &Path, claude_config: &Path) -> Check {
    let mut found = Vec::new();
    let mut fixes = Vec::new();
    for (file, claude) in [
        (claude_config.to_path_buf(), true),
        (cwd.join(".mcp.json"), true),
        (home.join(".cursor").join("mcp.json"), false),
    ] {
        for name in json_mcp_servers(&file) {
            found.push(format!("server {name} in {}", file.display()));
            fixes.push(if claude {
                format!("claude mcp remove {}", sh(&name))
            } else {
                format!("delete {} from {}", sh(&name), sh(file.display()))
            });
        }
    }
    let codex_config = codex_home.join("config.toml");
    for header in toml_mcp_headers(&read(&codex_config)) {
        match header {
            McpHeader::Named(header) => {
                found.push(format!("{header} in {}", codex_config.display()));
                fixes.push(format!(
                    "delete {} from {}",
                    sh(&header),
                    sh(codex_config.display())
                ));
            }
            McpHeader::Malformed(line) => {
                found.push(format!(
                    "a malformed MCP entry referencing the 1.x server at line {line} of {}",
                    codex_config.display()
                ));
                fixes.push(format!(
                    "open {} and remove the malformed MCP entry at line {line}",
                    sh(codex_config.display())
                ));
            }
        }
    }
    leftover("1x-mcp", found, fixes)
}

fn binaries(path_dirs: &[PathBuf]) -> Check {
    let hits: Vec<PathBuf> = ["rn-dev-agent-core", "rn-experience-trends"]
        .into_iter()
        .flat_map(|name| find_on_path(path_dirs, name))
        .collect();
    let fixes = if hits.is_empty() {
        Vec::new()
    } else {
        vec!["npm rm -g rn-dev-agent-core".to_string()]
    };
    leftover(
        "1x-binaries",
        hits.iter().map(|hit| hit.display().to_string()).collect(),
        fixes,
    )
}

fn home_dirs(home: &Path, xdg_state: Option<&Path>) -> Check {
    let actions_home = home.join(".rn-dev-agent");
    let candidates = [
        actions_home.clone(),
        home.join(".cache").join("rn-dev-agent"),
        home.join("Library").join("Caches").join("rn-dev-agent"),
        home.join("Library")
            .join("Application Support")
            .join("rn-dev-agent"),
        home.join(".claude").join("rn-agent"),
    ]
    .into_iter()
    .chain(xdg_state.map(|state| state.join("rn-dev-agent")));
    let dirs = dirs_present(candidates);
    let fixes = dirs
        .iter()
        .map(|dir| {
            if *dir == actions_home {
                format!(
                    "archive {} if those flows matter, then rm -r {}",
                    sh(dir.join("actions.db").display()),
                    sh(dir.display())
                )
            } else {
                format!("rm -r {}", sh(dir.display()))
            }
        })
        .collect();
    leftover(
        "1x-home-dirs",
        dirs.iter().map(|dir| dir.display().to_string()).collect(),
        fixes,
    )
}

fn project(cwd: &Path) -> Check {
    let mut found = Vec::new();
    let mut fixes = Vec::new();
    let agent = cwd.join(".rn-agent");
    if agent.is_dir() {
        let parts: Vec<&str> = ["config.json", "actions/", "state/", "e2e/", "dev-bridge.ts"]
            .into_iter()
            .filter(|part| agent.join(part.trim_end_matches('/')).exists())
            .collect();
        found.push(if parts.is_empty() {
            agent.display().to_string()
        } else {
            format!("{} ({})", agent.display(), parts.join(", "))
        });
        fixes.push(
            "archive .rn-agent/actions/ if those flows matter, then retire .rn-agent/".to_string(),
        );
    }
    for name in ["CLAUDE.md", "AGENTS.md"] {
        let file = cwd.join(name);
        let text = read(&file);
        if PROJECT_SENTINELS
            .iter()
            .any(|sentinel| text.contains(sentinel))
        {
            found.push(format!("rn-dev-agent template block in {}", file.display()));
            fixes.push(format!("remove the rn-dev-agent block from {name}"));
        }
    }
    let tsconfig = cwd.join("tsconfig.json");
    if read(&tsconfig).contains(".rn-agent/dev-bridge.ts") {
        found.push(format!(".rn-agent/dev-bridge.ts in {}", tsconfig.display()));
        fixes.push("remove .rn-agent/dev-bridge.ts from tsconfig.json".to_string());
    }
    if !fixes.is_empty() {
        // The app repository may not be the user's to change, and QaReN never reads these files.
        fixes = vec![format!(
            "QaReN ignores these 1.x files, so leave them unless you maintain this repository; if you do, {}",
            fixes.join(", then ")
        )];
    }
    leftover("1x-project", found, fixes)
}

fn environment(names: &[String]) -> Check {
    let mut matched: Vec<String> = names
        .iter()
        .filter(|name| {
            ENV_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
                || ENV_NAMES.contains(&name.as_str())
        })
        .cloned()
        .collect();
    matched.sort();
    let fixes = if matched.is_empty() {
        Vec::new()
    } else {
        let names: Vec<String> = matched.iter().map(sh).collect();
        vec![format!("unset {} in your shell profile", names.join(" "))]
    };
    leftover("1x-env", matched, fixes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let root =
                std::env::temp_dir().join(format!("qaren-doctor-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Scratch(root.canonicalize().unwrap())
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.0.join(rel)
        }

        fn file(&self, rel: &str, content: &str) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, content).unwrap();
            path
        }

        fn exe(&self, rel: &str) -> PathBuf {
            let path = self.file(rel, "#!/bin/sh\n");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        fn link(&self, rel: &str, target: &Path) -> PathBuf {
            let path = self.path(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::os::unix::fs::symlink(target, &path).unwrap();
            path
        }

        fn install(&self, version: &str) -> PathBuf {
            let dir = format!(".qaren/runtime/{version}");
            self.file(&format!("{dir}/VERSION"), &format!("{version}\n"));
            self.file(
                &format!("{dir}/.tarball-sha256"),
                &format!("{}\n", "ab".repeat(32)),
            );
            self.file(&format!("{dir}/runtime/qa/walk.js"), "");
            self.exe(&format!("{dir}/bin/qaren"))
        }

        fn runtime_root(&self) -> PathBuf {
            self.path(".qaren/runtime")
        }

        fn tree(&self) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
            fn walk(dir: &Path, out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
                for entry in std::fs::read_dir(dir).unwrap().flatten() {
                    let meta = std::fs::symlink_metadata(entry.path()).unwrap();
                    out.push((entry.path(), meta.len(), meta.modified().unwrap()));
                    if meta.is_dir() {
                        walk(&entry.path(), out);
                    }
                }
            }
            let mut out = Vec::new();
            walk(&self.0, &mut out);
            out.sort();
            out
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn row<'a>(report: &'a Report, id: &str) -> &'a Check {
        report.checks.iter().find(|c| c.id == id).unwrap()
    }

    const RUNTIMES: &str = r#"{"runtimes":[{"name":"iOS 26.0","identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-0","platform":"iOS","isAvailable":true},{"name":"watchOS 26.0","identifier":"w","platform":"watchOS","isAvailable":true}]}"#;

    fn script_toolchain(runner: &mut MockRunner, node: Option<&str>, runtimes: &str) {
        runner.expect_run(
            "xcodebuild -version",
            CmdOutput::success("Xcode 26.0\nBuild version 17A324\n"),
        );
        runner.expect_run("simctl list runtimes --json", CmdOutput::success(runtimes));
        if let Some(node) = node {
            runner.expect_run("node --version", CmdOutput::success(node));
        }
        runner.expect_run("pnpm --version", CmdOutput::success("10.0.0\n"));
        runner.expect_run("corepack --version", CmdOutput::success("0.34.0\n"));
        runner.expect_run("pod --version", CmdOutput::success("1.16.2\n"));
        runner.expect_run("df -Pk", df(500_000_000));
    }

    fn df(available_kb: u64) -> CmdOutput {
        CmdOutput::success(&format!(
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 976490576 1 {available_kb} 45% /\n"
        ))
    }

    fn run_doctor(
        runner: &mut MockRunner,
        scratch: &Scratch,
        cwd: &Path,
        exe: Option<PathBuf>,
    ) -> Report {
        let runtime = exe
            .as_ref()
            .and_then(|exe| exe.parent()?.parent())
            .map_or(PathBuf::from("/runtime"), |dir| dir.join("runtime"));
        runner.expect_run(
            "--git-common-dir",
            CmdOutput::failed(128, "not a git checkout"),
        );
        script_host(runner);
        doctor(runner, &scratch.0, cwd, exe, runtime, None)
    }

    fn script_host(runner: &mut MockRunner) {
        runner.expect_run("ps -axww", CmdOutput::failed(1, "unavailable"));
        if cfg!(target_os = "macos") {
            runner.expect_run(
                "simctl list devices -j",
                CmdOutput::failed(1, "unavailable"),
            );
            for command in ["vm_stat", "sysctl", "top"] {
                runner.expect_run(command, CmdOutput::failed(1, "unavailable"));
            }
        } else {
            for command in ["/proc/meminfo", "/proc/loadavg", "/proc/stat", "/proc/stat"] {
                runner.expect_run(command, CmdOutput::failed(1, "unavailable"));
            }
        }
    }

    #[test]
    fn path_passes_when_the_first_hit_is_this_installed_binary() {
        let s = Scratch::new("path-pass");
        let exe = s.install(VERSION);
        let link = s.link("bin/qaren", &exe);
        let check = evaluate_path(&[link.clone(), link], Some(&exe), &s.runtime_root());
        assert_eq!(check.status, Status::Pass, "{check:?}");
    }

    #[test]
    fn path_fails_naming_both_when_another_qaren_runs_first() {
        let s = Scratch::new("path-fail");
        let exe = s.install(VERSION);
        let stray = s.exe("usr/local/bin/qaren");
        let link = s.link("bin/qaren", &exe);
        let check = evaluate_path(&[stray.clone(), link], Some(&exe), &s.runtime_root());
        assert_eq!(check.status, Status::Fail);
        assert!(
            check.detail.contains(&stray.display().to_string()),
            "{}",
            check.detail
        );
        assert!(
            check.detail.contains(&exe.display().to_string()),
            "{}",
            check.detail
        );
    }

    #[test]
    fn path_warns_listing_every_later_copy() {
        let s = Scratch::new("path-extras");
        let exe = s.install(VERSION);
        let link = s.link("bin/qaren", &exe);
        let one = s.exe("usr/local/bin/qaren");
        let two = s.exe("src/target/release/qaren");
        let check = evaluate_path(
            &[link, one.clone(), two.clone()],
            Some(&exe),
            &s.runtime_root(),
        );
        assert_eq!(check.status, Status::Warn);
        assert!(
            check.detail.starts_with("2 more qaren executables"),
            "{}",
            check.detail
        );
        assert!(check.detail.contains(&one.display().to_string()));
        assert!(check.detail.contains(&two.display().to_string()));
    }

    #[test]
    fn path_warns_when_the_first_hit_is_not_the_installed_build() {
        let s = Scratch::new("path-plain");
        let plain = s.exe("bin/qaren");
        let check = evaluate_path(
            std::slice::from_ref(&plain),
            Some(&plain),
            &s.runtime_root(),
        );
        assert_eq!(check.status, Status::Warn);
        assert!(
            check.detail.contains("not the installed build"),
            "{}",
            check.detail
        );
    }

    #[test]
    fn a_development_binary_started_by_path_beside_the_installed_build_is_not_a_failure() {
        let s = Scratch::new("path-dev");
        let installed = s.install(VERSION);
        let link = s.link("bin/qaren", &installed);
        let dev = s.exe("src/target/release/qaren");
        let root = s.runtime_root();
        assert_eq!(
            evaluate_path(std::slice::from_ref(&link), Some(&dev), &root).status,
            Status::Pass
        );
        assert_eq!(
            installed_build(Some(&dev), &root, Some(&link)).status,
            Status::Warn
        );
    }

    #[test]
    fn installed_build_checks_the_runtime_layout() {
        let s = Scratch::new("installed");
        let exe = s.install(VERSION);
        let root = s.runtime_root();
        assert_eq!(
            installed_build(Some(&exe), &root, Some(&exe)).status,
            Status::Pass
        );
        std::fs::remove_file(s.path(&format!(".qaren/runtime/{VERSION}/runtime/qa/walk.js")))
            .unwrap();
        let check = installed_build(Some(&exe), &root, Some(&exe));
        assert_eq!(check.status, Status::Fail);
        assert!(check.detail.contains("walk.js"), "{}", check.detail);
    }

    #[test]
    fn a_stray_first_on_path_shadows_the_installed_build() {
        let s = Scratch::new("shadow");
        let installed = s.install(VERSION);
        let stray = s.exe("usr/local/bin/qaren");
        let check = installed_build(Some(&stray), &s.runtime_root(), Some(&stray));
        assert_eq!(check.status, Status::Fail);
        assert!(
            check.detail.contains("shadows the installed build"),
            "{}",
            check.detail
        );
        assert!(check.detail.contains(&installed.display().to_string()));
    }

    #[test]
    fn a_development_binary_without_an_install_warns() {
        let s = Scratch::new("devonly");
        let dev = s.exe("src/target/release/qaren");
        let check = installed_build(Some(&dev), &s.runtime_root(), Some(&dev));
        assert_eq!(check.status, Status::Warn);
        assert!(check.detail.contains("development binary"));
    }

    #[test]
    fn runtime_dirs_warns_about_staging_and_other_versions() {
        let s = Scratch::new("runtime-dirs");
        s.install(VERSION);
        s.dir(".qaren/runtime/runners");
        s.file(&format!(".qaren/runtime/.lock-{VERSION}"), "");
        assert_eq!(runtime_dirs(&s.runtime_root()).status, Status::Pass);
        s.dir(&format!(".qaren/runtime/.staging-{VERSION}.abc123"));
        let staging = runtime_dirs(&s.runtime_root());
        assert_eq!(staging.status, Status::Warn);
        assert!(staging.detail.contains("interrupted install"));
        assert!(staging.fix.unwrap().contains("ensure-qaren.sh --install"));
        std::fs::remove_dir(s.path(&format!(".qaren/runtime/.staging-{VERSION}.abc123"))).unwrap();
        s.dir(".qaren/runtime/0.0.1");
        let old = runtime_dirs(&s.runtime_root());
        assert_eq!(old.status, Status::Warn);
        assert!(old.fix.unwrap().contains("rm -r"));
    }

    fn fabricate_leftovers(s: &Scratch) {
        s.file(
            ".claude/plugins/installed_plugins.json",
            r#"{"plugins":{"rn-dev-agent@rn-dev-agent":[]}}"#,
        );
        s.dir(".claude/plugins/cache/rn-dev-agent");
        s.file(
            ".codex/config.toml",
            "[plugins.\"rn-dev-agent@rn-dev-agent\"]\nenabled = true\n",
        );
        s.dir(".codex/plugins/cache/rn-dev-agent");
        s.file(".claude.json", r#"{"mcpServers":{"rn-agent":{"command":"node","args":["rn-dev-agent-core/dist/index.js"]}}}"#);
        s.exe("npm/bin/rn-dev-agent-core");
        s.dir(".rn-dev-agent");
        s.dir("app/.rn-agent/actions");
        s.file("app/.rn-agent/config.json", "{}");
    }

    #[test]
    fn doctor_uses_the_effective_claude_directory_for_every_user_config_read() {
        for mode in ["default", "empty", "custom", "missing", "explicit-default"] {
            let s = Scratch::new(mode);
            let app = s.dir("app");
            let mut runner = MockRunner::new();
            let custom = match mode {
                "custom" | "missing" => Some(s.path("custom config")),
                "explicit-default" => Some(s.path(".claude")),
                _ => None,
            };
            let config = custom.clone().unwrap_or_else(|| s.path(".claude"));
            if mode == "empty" {
                runner
                    .environment
                    .insert("CLAUDE_CONFIG_DIR".into(), String::new());
            } else if let Some(path) = &custom {
                runner
                    .environment
                    .insert("CLAUDE_CONFIG_DIR".into(), path.display().to_string());
            }
            for dir in [s.path(".claude"), config.clone()] {
                if mode == "missing" && dir == config {
                    continue;
                }
                std::fs::create_dir_all(dir.join("plugins/cache/rn-dev-agent")).unwrap();
                std::fs::create_dir_all(dir.join("plugins/marketplaces/rn-dev-agent")).unwrap();
                std::fs::create_dir_all(dir.join("rn-agent")).unwrap();
                std::fs::write(
                    dir.join("plugins/installed_plugins.json"),
                    r#"{"rn-dev-agent@rn-dev-agent":true}"#,
                )
                .unwrap();
                std::fs::write(
                    dir.join("plugins/known_marketplaces.json"),
                    r#"{"rn-dev-agent":{}}"#,
                )
                .unwrap();
                std::fs::write(
                    dir.join("settings.json"),
                    r#"{"rn-dev-agent@rn-dev-agent":true}"#,
                )
                .unwrap();
            }
            let mcp = r#"{"mcpServers":{"rn-agent":{"command":"cdp-supervisor"}}}"#;
            s.file(".claude.json", mcp);
            if custom.is_some() && mode != "missing" {
                std::fs::write(config.join(".claude.json"), mcp).unwrap();
            }
            let before = s.tree();
            script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
            let report = run_doctor(&mut runner, &s, &app, None);
            let legacy = row(&report, "1x-home-dirs");
            assert_eq!(legacy.status, Status::Warn, "{mode} {legacy:?}");
            assert!(
                legacy
                    .detail
                    .contains(&s.path(".claude/rn-agent").display().to_string()),
                "{mode} {legacy:?}"
            );
            if let Some(path) = custom.as_ref().filter(|path| **path != s.path(".claude")) {
                assert!(
                    !legacy.detail.contains(&path.display().to_string()),
                    "{mode} {legacy:?}"
                );
            }
            for id in ["1x-claude-plugin", "1x-mcp"] {
                let check = row(&report, id);
                assert_eq!(
                    check.status,
                    if mode == "missing" {
                        Status::Pass
                    } else {
                        Status::Warn
                    },
                    "{mode} {check:?}"
                );
                if mode != "missing" {
                    let expected = if id == "1x-mcp" {
                        custom.as_deref().unwrap_or(&s.0).join(".claude.json")
                    } else {
                        config.clone()
                    };
                    assert!(
                        check.detail.contains(&expected.display().to_string()),
                        "{mode} {check:?}"
                    );
                }
                if mode == "custom" {
                    assert!(
                        !check
                            .detail
                            .contains(&s.path(".claude").display().to_string()),
                        "{check:?}"
                    );
                    assert!(
                        !check
                            .fix
                            .as_deref()
                            .unwrap_or("")
                            .contains(&s.path(".claude").display().to_string()),
                        "{check:?}"
                    );
                }
            }
            let plugins = row(&report, "1x-claude-plugin");
            if mode != "missing" {
                for rel in [
                    "plugins/installed_plugins.json",
                    "plugins/known_marketplaces.json",
                    "plugins/cache/rn-dev-agent",
                    "plugins/marketplaces/rn-dev-agent",
                    "settings.json",
                ] {
                    assert!(
                        plugins
                            .detail
                            .contains(&config.join(rel).display().to_string()),
                        "{mode} {plugins:?}"
                    );
                }
            }
            assert_eq!(
                s.tree(),
                before,
                "doctor must not create even a missing config directory"
            );
            assert_eq!(runner.remaining(), 0);
        }
    }

    #[test]
    fn every_leftover_kind_warns_with_its_removal_command() {
        let s = Scratch::new("leftovers");
        fabricate_leftovers(&s);
        let env = vec!["RN_DEV_AGENT_SESSION_ID".to_string(), "HOME".to_string()];
        let rows = leftover_rows(
            &s.0,
            &s.path(".codex"),
            None,
            None,
            &s.path("app"),
            &[s.path("npm/bin")],
            &env,
        );
        let expected = [
            (
                "1x-claude-plugin",
                "claude plugin uninstall rn-dev-agent@rn-dev-agent",
            ),
            (
                "1x-codex-plugin",
                "codex plugin remove rn-dev-agent@rn-dev-agent",
            ),
            ("1x-mcp", "claude mcp remove rn-agent"),
            ("1x-binaries", "npm rm -g rn-dev-agent-core"),
            ("1x-home-dirs", "actions.db if those flows matter"),
            ("1x-project", "unless you maintain this repository"),
            ("1x-env", "unset RN_DEV_AGENT_SESSION_ID"),
        ];
        assert_eq!(rows.len(), expected.len());
        for (row, (id, command)) in rows.iter().zip(expected) {
            assert_eq!((row.id, row.status), (id, Status::Warn), "{row:?}");
            assert!(row.fix.as_deref().unwrap().contains(command), "{row:?}");
        }
    }

    #[test]
    fn an_empty_home_has_no_leftovers() {
        let s = Scratch::new("clean-home");
        let rows = leftover_rows(
            &s.0,
            &s.path(".codex"),
            None,
            None,
            &s.0,
            &[],
            &["HOME".to_string()],
        );
        assert!(
            rows.iter().all(|row| row.status == Status::Pass),
            "{rows:?}"
        );
    }

    #[test]
    fn project_leftover_advice_never_deletes_tracked_files() {
        let s = Scratch::new("project-advice");
        s.dir(".rn-agent/actions");
        s.file(".rn-agent/dev-bridge.ts", "");
        s.file("AGENTS.md", "<!-- rn-dev-agent:codex-template-start -->\n");
        let check = project(&s.0);
        assert_eq!(check.status, Status::Warn);
        let fix = check.fix.unwrap();
        assert!(!fix.contains("git rm") && !fix.contains("rm -r"), "{fix}");
        assert!(fix.starts_with("QaReN ignores these 1.x files"), "{fix}");
        assert!(fix.contains("archive .rn-agent/actions/"), "{fix}");
        assert!(fix.contains("block from AGENTS.md"), "{fix}");
    }

    #[test]
    fn pnpm_awaiting_its_first_run_download_says_how_to_finish_it() {
        for refusal in [
            "Network access is disabled by the environment, so the pnpm binary cannot be downloaded.",
            "Internal Error: Network access disabled by the environment; can't reach https://registry.npmjs.org/pnpm",
        ] {
            let mut runner = MockRunner::new();
            runner.expect_run("pnpm --version", CmdOutput::failed(1, refusal));
            let check = tool(&mut runner, "pnpm", "pnpm", Status::Fail, "unused");
            assert_eq!(check.status, Status::Fail);
            assert!(check.detail.contains("has not downloaded"), "{check:?}");
            assert!(
                check.fix.unwrap().contains("(cd / && pnpm --version)"),
                "the fix finishes the download doctor's offline probe needs"
            );
        }
    }

    #[test]
    fn the_suggested_pnpm_fix_ends_by_running_the_probe_once_online() {
        let s = Scratch::new("pnpm-fix");
        let mut runner = MockRunner::new();
        runner.expect_run("xcodebuild -version", CmdOutput::success("Xcode 26.0\n"));
        runner.expect_run("simctl list runtimes --json", CmdOutput::success(RUNTIMES));
        runner.expect_run("node --version", CmdOutput::success("v24.1.0\n"));
        runner.expect_run("pnpm --version", CmdOutput::failed(1, "boom"));
        runner.expect_run("corepack --version", CmdOutput::success("0.34.0\n"));
        runner.expect_run("pod --version", CmdOutput::success("1.16.2\n"));
        runner.expect_run("df -Pk", df(500_000_000));
        let report = run_doctor(&mut runner, &s, &s.0, None);
        assert!(row(&report, "pnpm")
            .fix
            .as_deref()
            .unwrap()
            .ends_with("&& (cd / && pnpm --version)`"));
    }

    #[test]
    fn disk_warns_below_a_clean_ios_build_and_names_the_tight_volume() {
        let s = Scratch::new("disk");
        let home = s.dir("home");
        let mut runner = MockRunner::new();
        runner.expect_run(
            "df -Pk",
            CmdOutput::success(
                "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/a 1 1 50000000 1% /\n/dev/b 1 1 4194304 99% /home\n",
            ),
        );
        let check = disk(&mut runner, &s.0, &home);
        assert_eq!(check.status, Status::Warn, "{check:?}");
        assert!(check.detail.starts_with("4.0 GiB free"), "{check:?}");
        assert!(check.detail.contains(&home.display().to_string()));
        assert!(check.detail.contains("about 10 GiB"), "{check:?}");
        assert!(check.fix.unwrap().contains("DerivedData"));

        let mut runner = MockRunner::new();
        runner.expect_run("df -Pk", df(20 * 1024 * 1024));
        assert_eq!(disk(&mut runner, &s.0, &home).status, Status::Pass);

        let mut runner = MockRunner::new();
        runner.expect_run("df -Pk", CmdOutput::failed(1, "df: nope"));
        assert_eq!(disk(&mut runner, &s.0, &home).status, Status::Skip);
    }

    #[test]
    fn project_leftovers_need_the_template_sentinel_not_a_mention() {
        let s = Scratch::new("project");
        s.file("CLAUDE.md", "We used to use rn-dev-agent here.\n");
        assert_eq!(project(&s.0).status, Status::Pass);
        let claude = s.file(
            "CLAUDE.md",
            "x\n<!-- rn-dev-agent:template-start -->\nold\n",
        );
        s.file(".rn-agent/config.json", "{}");
        let check = project(&s.0);
        assert_eq!(check.status, Status::Warn);
        assert!(check.detail.contains("config.json"), "{}", check.detail);
        assert!(
            check.detail.contains(&claude.display().to_string()),
            "{}",
            check.detail
        );
    }

    #[test]
    fn names_from_an_app_repository_cannot_forge_rows() {
        let s = Scratch::new("forge");
        s.file(
            ".mcp.json",
            r#"{"mcpServers":{"x\nPASS 1x-mcp: none found\u001b[2K":{"command":"cdp-supervisor"}}}"#,
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let text = run_doctor(&mut runner, &s, &s.0, None).render();
        assert!(!text.contains("\nPASS 1x-mcp"), "{text}");
        assert!(!text.contains('\u{1b}'));
        assert!(text.contains("x\\nPASS 1x-mcp"), "{text}");
    }

    #[test]
    fn node_rows_name_their_source_but_never_print_a_node_path() {
        let s = Scratch::new("node-source");
        let configured = s.exe("distinct-configured-node-7f3a/node");
        s.file(
            ".qaren/config.yaml",
            &format!(
                "appId: com.example\ndevClientScheme: exp+example\nnodePath: {}\n",
                configured.display()
            ),
        );
        let env_node = "/opt/distinct-qaren-node-env-9c1e/bin/node";
        for (env, version) in [
            (Some(env_node), "v22.0.0\n"),
            (Some(env_node), "v24.1.0\n"),
            (None, ""),
        ] {
            let mut runner = MockRunner::new();
            if let Some(env) = env {
                runner.environment.insert("QAREN_NODE".into(), env.into());
            }
            runner.expect_run("xcodebuild -version", CmdOutput::success("Xcode 26.0\n"));
            runner.expect_run("simctl list runtimes --json", CmdOutput::success(RUNTIMES));
            if env.is_some() {
                runner.expect_run("distinct-qaren-node-env-9c1e", CmdOutput::success(version));
            }
            runner.expect_run("pnpm --version", CmdOutput::success("10.0.0\n"));
            runner.expect_run("corepack --version", CmdOutput::success("0.34.0\n"));
            runner.expect_run("pod --version", CmdOutput::success("1.16.2\n"));
            runner.expect_run("df -Pk", df(500_000_000));
            let report = run_doctor(&mut runner, &s, &s.0, None);
            let node = row(&report, "node");
            assert!(
                node.detail.contains(if env.is_some() {
                    "QAREN_NODE"
                } else {
                    "configured nodePath"
                }),
                "{node:?}"
            );
            for out in [report.render(), report.to_json()] {
                assert!(!out.contains("distinct-qaren-node-env-9c1e"), "{out}");
                assert!(!out.contains("distinct-configured-node-7f3a"), "{out}");
            }
        }
    }

    #[test]
    fn rendered_mcp_fix_preserves_control_character_arguments() {
        let s = Scratch::new("control-quoting");
        for name in ["x\n\x1b[31m", "it's \\ $(exit 9); café\t\r\n\n"] {
            s.file(
                ".mcp.json",
                &serde_json::json!({"mcpServers": {name: {"command": "cdp-supervisor"}}})
                    .to_string(),
            );
            let report = Report {
                identity: Identity {
                    exe: None,
                    version: VERSION,
                    build: None,
                    runtime: s.0.clone(),
                },
                checks: vec![mcp_servers(
                    &s.0,
                    &s.path(".codex"),
                    &s.0,
                    &s.path(".claude.json"),
                )],
            };
            let text = report.render();
            let fix = text
                .lines()
                .find_map(|line| line.strip_prefix("     fix: "))
                .unwrap();
            assert!(!fix.chars().any(char::is_control), "{fix:?}");
            let json: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
            for command in [fix, json["checks"][0]["fix"].as_str().unwrap()] {
                let mut shells = vec!["bash"];
                if cfg!(target_os = "macos") {
                    shells.extend(["/bin/sh", "zsh"]);
                }
                for shell in shells {
                    let output = std::process::Command::new(shell)
                        .args([
                            "-c",
                            &format!("claude() {{ printf '%s\\0' \"$@\"; }}; {command}"),
                        ])
                        .output()
                        .unwrap();
                    assert!(output.status.success(), "{shell}: {output:?}");
                    assert_eq!(
                        output.stdout,
                        format!("mcp\0remove\0{name}\0").as_bytes(),
                        "{shell}: {command}"
                    );
                }
            }
        }
    }

    #[test]
    fn fix_commands_quote_names_and_paths_as_single_shell_words() {
        let s = Scratch::new("quoting");
        s.file(
            ".mcp.json",
            r#"{"mcpServers":{"x; rm -rf ~":{"command":"cdp-supervisor"}}}"#,
        );
        let support = s.dir("Library/Application Support/rn-dev-agent");
        let mcp = mcp_servers(&s.0, &s.path(".codex"), &s.0, &s.path(".claude.json"));
        assert!(
            mcp.fix
                .as_deref()
                .unwrap()
                .contains("claude mcp remove 'x; rm -rf ~'"),
            "{mcp:?}"
        );
        let dirs = home_dirs(&s.0, None);
        assert!(
            dirs.fix
                .as_deref()
                .unwrap()
                .contains(&format!("rm -r '{}'", support.display())),
            "{dirs:?}"
        );
        assert_eq!(sh("it's"), "'it'\\''s'");
        assert_eq!(sh("/plain/path-1.0"), "/plain/path-1.0");
    }

    #[test]
    fn toml_header_comments_are_never_reported() {
        let text = "[mcp_servers.rn] # TOKEN=private-value\ncommand = \"cdp-supervisor\"\n";
        assert_eq!(
            toml_mcp_headers(text),
            vec![McpHeader::Named("[mcp_servers.rn]".to_string())]
        );
    }

    #[test]
    fn toml_headers_keep_brackets_inside_quoted_keys() {
        let text = "[mcp_servers.\"rn]agent\"] # note\ncommand = \"cdp-supervisor\"\n\
            [mcp_servers.'lit]x'.env]\ncommand = \"cdp-supervisor\"\n\
            [mcp_servers.plain]\ncommand = \"cdp-supervisor\"\n";
        assert_eq!(
            toml_mcp_headers(text),
            [
                "[mcp_servers.\"rn]agent\"]",
                "[mcp_servers.'lit]x'.env]",
                "[mcp_servers.plain]"
            ]
            .map(|header| McpHeader::Named(header.to_string()))
        );
    }

    #[test]
    fn unclosed_toml_headers_warn_by_line_without_echoing_them() {
        let s = Scratch::new("unclosed-toml");
        let config = s.file(
            ".codex/config.toml",
            "[mcp_servers.plain]\ncommand = \"cdp-supervisor\"\n\
            [mcp_servers.\"rn] # TOKEN=private-value\ncommand = \"cdp-supervisor\"\n\
            [mcp_servers.other\ncommand = \"other\"\n\
            [mcp_servers.rn-dev-agent-core # TOKEN=private-value\n",
        );
        let mcp = mcp_servers(&s.0, &s.path(".codex"), &s.0, &s.path(".claude.json"));
        assert_eq!(mcp.status, Status::Warn, "{mcp:?}");
        let fix = mcp.fix.clone().unwrap();
        let shown = format!("{} {fix}", mcp.detail);
        assert!(
            !shown.contains("TOKEN") && !shown.contains("\"rn"),
            "{mcp:?}"
        );
        assert!(shown.contains("[mcp_servers.plain]"), "{mcp:?}");
        for line in [3, 7] {
            assert!(
                mcp.detail.contains(&format!(
                    "malformed MCP entry referencing the 1.x server at line {line} of {}",
                    config.display()
                )),
                "{mcp:?}"
            );
            assert!(fix.contains(&format!("entry at line {line}")), "{mcp:?}");
        }
        assert!(!mcp.detail.contains("line 5"), "{mcp:?}");
    }

    #[test]
    fn a_missing_effective_runtime_fails_even_beside_a_healthy_install() {
        let s = Scratch::new("effective-runtime");
        let exe = s.install(VERSION);
        let root = s.runtime_root();
        let healthy = installed_build(Some(&exe), &root, Some(&exe));
        assert_eq!(healthy.status, Status::Pass);
        let installed_runtime = exe.parent().unwrap().parent().unwrap().join("runtime");
        assert_eq!(
            effective_runtime(healthy.clone(), &installed_runtime).status,
            Status::Pass
        );
        let missing = effective_runtime(healthy, &s.path("elsewhere/runtime"));
        assert_eq!(missing.status, Status::Fail);
        assert!(missing.fix.unwrap().contains("QAREN_RUNTIME"));
    }

    #[test]
    fn mcp_reports_only_toml_section_headers() {
        let text = "[mcp_servers.rn]\ncommand = \"node\"\nargs = [\"/x/rn-dev-agent-core/dist/index.js\"]\nenv = { TOKEN = \"sk-fixture-secret\" }\n[mcp_servers.other]\ncommand = \"other\"\n";
        assert_eq!(
            toml_mcp_headers(text),
            vec![McpHeader::Named("[mcp_servers.rn]".to_string())]
        );
    }

    #[test]
    fn doctor_prints_key_names_and_paths_but_never_values_and_changes_nothing() {
        let s = Scratch::new("privacy");
        let exe = s.install(VERSION);
        let bin = s.dir("bin");
        s.link("bin/qaren", &exe);
        let settings = s.file(
            ".claude/settings.json",
            r#"{"env":{"ANTHROPIC_API_KEY":"sk-fixture-secret"},"enabledPlugins":{"rn-dev-agent@rn-dev-agent":true}}"#,
        );
        s.file(
            ".claude.json",
            r#"{"projects":{"/app":{"mcpServers":{"rn":{"command":"cdp-supervisor","env":{"KEY":"sk-fixture-secret"}}}}}}"#,
        );
        let before = s.tree();
        let mut runner = MockRunner::new();
        runner
            .environment
            .insert("PATH".into(), bin.display().to_string());
        runner
            .environment
            .insert("RN_DEV_AGENT_SESSION_ID".into(), "fixture-value".into());
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, Some(exe));
        let text = report.render();
        let json = report.to_json();
        for out in [&text, &json] {
            assert!(out.contains(&settings.display().to_string()), "{out}");
            assert!(out.contains("rn-dev-agent@rn-dev-agent"));
            assert!(out.contains("RN_DEV_AGENT_SESSION_ID"));
            assert!(out.contains("server rn in"));
            assert!(!out.contains("sk-fixture-secret"), "{out}");
            assert!(!out.contains("fixture-value"), "{out}");
        }
        assert_eq!(runner.remaining(), 0);
        assert!(runner.spawned_logs.is_empty());
        assert!(runner.calls.iter().all(|call| call.label == "doctor-host"
            || call.program == "df"
            || call.args.iter().any(|arg| arg == "--version"
                || arg == "-version"
                || arg == "list"
                || arg == "rev-parse")));
        assert_eq!(s.tree(), before);
        assert_eq!(
            report.exit_code(),
            u8::from(cfg!(target_os = "macos")),
            "{text}"
        );
        if cfg!(target_os = "macos") {
            let service = row(&report, "simulator-service");
            assert_eq!(service.status, Status::Fail);
            assert!(service.detail.contains("unavailable"));
            assert_eq!(service.fix.as_deref(), Some(host::SIMCTL_FIX));
        }
        assert!(text.starts_with(&format!("qaren {VERSION} at ")));
        assert!(text.contains("(build abababab)"));
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed["verdict"],
            if cfg!(target_os = "macos") {
                "fail"
            } else {
                "pass"
            }
        );
        assert_eq!(parsed["checks"].as_array().unwrap().len(), 27);
    }

    #[test]
    fn node_below_24_fails_with_the_preflight_wording() {
        let s = Scratch::new("node22");
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v22.4.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, None);
        let node = row(&report, "node");
        assert_eq!(node.status, Status::Fail);
        assert!(
            node.detail.contains("qaren needs node >= 24"),
            "{}",
            node.detail
        );
        assert_eq!(
            node.fix.as_deref(),
            Some("point nodePath in .qaren/config.yaml at a node >= 24")
        );
        assert_eq!(report.exit_code(), 1);
        assert_eq!(row(&report, "config").status, Status::Skip);
        assert_eq!(row(&report, "android-sdk").status, Status::Skip);
        assert_eq!(row(&report, "source-checkout").status, Status::Skip);
    }

    #[test]
    fn unreadable_runtime_inventory_warns_without_claiming_no_runtime_is_installed() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "simctl list runtimes --json",
            CmdOutput {
                timed_out: true,
                ..Default::default()
            },
        );
        let row = ios_runtimes(&mut runner, None);
        assert_eq!(row.status, Status::Warn);
        assert!(row.detail.contains("availability is unknown"));
        assert!(row.fix.unwrap().contains("simulator-service"));
    }

    #[test]
    fn a_failing_runtime_inventory_fails_with_simctl_error_and_the_xcode_fix() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "simctl list runtimes --json",
            CmdOutput::failed(1, "CoreSimulator is out of date"),
        );
        let row = ios_runtimes(&mut runner, None);
        assert_eq!(row.status, Status::Fail);
        assert!(row.detail.contains("CoreSimulator is out of date"));
        assert!(row.fix.unwrap().contains("xcodebuild -runFirstLaunch"));
    }

    #[test]
    fn no_available_ios_runtime_fails() {
        let s = Scratch::new("noruntime");
        let mut runner = MockRunner::new();
        script_toolchain(
            &mut runner,
            Some("v24.1.0\n"),
            r#"{"runtimes":[{"name":"iOS 26.0","identifier":"i","platform":"iOS","isAvailable":false}]}"#,
        );
        let report = run_doctor(&mut runner, &s, &s.0, None);
        assert_eq!(row(&report, "ios-runtime").status, Status::Fail);
    }

    #[test]
    fn a_configured_runtime_matches_by_name_or_identifier() {
        let s = Scratch::new("runtime-config");
        s.file(
            ".qaren/config.yaml",
            "appId: com.example\ndevClientScheme: exp+example\nios:\n  runtime: iOS 18.0\n",
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, None);
        let check = row(&report, "ios-runtime");
        assert_eq!(check.status, Status::Fail);
        assert!(check
            .fix
            .as_deref()
            .unwrap()
            .contains("against `xcrun simctl list`"));
        assert_eq!(row(&report, "config").status, Status::Pass);

        s.file(".qaren/config.yaml", "appId: com.example\ndevClientScheme: exp+example\nios:\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-0\n");
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        assert_eq!(
            row(&run_doctor(&mut runner, &s, &s.0, None), "ios-runtime").status,
            Status::Pass
        );
    }

    #[test]
    fn android_sdk_check_does_not_run_adb() {
        let s = Scratch::new("android-read-only");
        s.file(
            ".qaren/config.yaml",
            "appId: com.example\ndevClientScheme: exp+example\nandroid:\n  avd: Pixel\n",
        );
        s.exe("sdk/platform-tools/adb");
        let emulator = s.exe("sdk/emulator/emulator");
        let before = s.tree();
        let mut runner = MockRunner::new();
        runner
            .environment
            .insert("ANDROID_HOME".into(), s.path("sdk").display().to_string());
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        runner.expect_run(
            &android::list_avds_spec(&emulator).rendered(),
            CmdOutput::success("Pixel\n"),
        );
        let report = run_doctor(&mut runner, &s, &s.0, None);
        assert_eq!(row(&report, "android-sdk").status, Status::Pass);
        assert_eq!(row(&report, "android-avd").status, Status::Pass);
        assert_eq!(s.tree(), before);
        assert!(!runner.calls.iter().any(|call| call.label == "adb-version"));

        std::fs::set_permissions(
            s.path("sdk/platform-tools/adb"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let mut runner = MockRunner::new();
        let config = AndroidConfig {
            avd: Some("Pixel".into()),
        };
        let checks = android_checks(&mut runner, Some(&config), s.path("sdk").to_str());
        assert_eq!(checks[0].status, Status::Fail);
        assert_eq!(checks[1].status, Status::Skip);
        assert!(runner.calls.is_empty());
    }

    #[test]
    fn android_configured_without_android_home_fails() {
        let s = Scratch::new("android");
        s.file(
            ".qaren/config.yaml",
            "appId: com.example\ndevClientScheme: exp+example\nandroid:\n  avd: Pixel\n",
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, None);
        let sdk = row(&report, "android-sdk");
        assert_eq!(sdk.status, Status::Fail);
        assert!(
            sdk.detail.contains("ANDROID_HOME env var"),
            "{}",
            sdk.detail
        );
        assert_eq!(row(&report, "android-avd").status, Status::Skip);
        assert_eq!(report.exit_code(), 1);
    }

    #[test]
    fn a_config_that_fails_validation_never_supplies_the_node_to_run() {
        let s = Scratch::new("unvalidated-node");
        s.file(
            ".qaren/config.yaml",
            "appId: com.example\nnodePath: /tmp/not-a-node\n",
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, None);
        assert_eq!(row(&report, "config").status, Status::Fail);
        assert_eq!(runner.calls[2].program, "node");
    }

    #[test]
    fn a_configured_node_path_is_checked_on_disk_and_never_run() {
        let s = Scratch::new("configured-node");
        let node = s.exe("tools/node");
        s.file(
            ".qaren/config.yaml",
            &format!(
                "appId: com.example\ndevClientScheme: exp+example\nnodePath: {}\n",
                node.display()
            ),
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, None, RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, None);
        let check = row(&report, "node");
        assert_eq!(check.status, Status::Pass, "{check:?}");
        assert!(check
            .detail
            .contains("version not checked; run qaren check to verify"));
        assert!(runner
            .calls
            .iter()
            .all(|call| !call.rendered().contains("tools/node")));
        assert_eq!(runner.remaining(), 0);

        std::fs::remove_file(&node).unwrap();
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, None, RUNTIMES);
        assert_eq!(
            row(&run_doctor(&mut runner, &s, &s.0, None), "node").status,
            Status::Fail
        );
    }

    #[test]
    fn config_failures_never_print_file_values() {
        let s = Scratch::new("config-privacy");
        let canary = "private-config-canary";
        for field in [
            format!("packageManager: {canary}\n"),
            format!("metroPort: {canary}\n"),
            "metroPort: 80\n".to_string(),
            format!("appId: [{canary}\n"),
        ] {
            s.file(
                ".qaren/config.yaml",
                &format!("appId: com.example\ndevClientScheme: exp+example\n{field}"),
            );
            let before = s.tree();
            let mut runner = MockRunner::new();
            script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
            let report = run_doctor(&mut runner, &s, &s.0, None);
            assert_eq!(row(&report, "config").status, Status::Fail);
            assert!(row(&report, "config").fix.is_some());
            assert_eq!(report.exit_code(), 1);
            for out in [report.render(), report.to_json()] {
                assert!(!out.contains(canary), "{out}");
                assert!(!out.contains("metroPort 80"), "{out}");
            }
            assert_eq!(s.tree(), before);
        }
    }

    #[test]
    fn version_mismatch_never_prints_file_contents() {
        let s = Scratch::new("version-privacy");
        let exe = s.install(VERSION);
        let canary = "private-version-canary";
        s.file(&format!(".qaren/runtime/{VERSION}/VERSION"), canary);
        let before = s.tree();
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let report = run_doctor(&mut runner, &s, &s.0, Some(exe));
        let check = row(&report, "installed-build");
        assert_eq!(check.status, Status::Fail);
        assert!(check.detail.contains(VERSION));
        assert!(check.fix.is_some());
        assert_eq!(report.exit_code(), 1);
        for out in [report.render(), report.to_json()] {
            assert!(!out.contains(canary), "{out}");
        }
        assert_eq!(s.tree(), before);
    }

    #[test]
    fn an_invalid_config_reports_a_safe_failure_category() {
        let s = Scratch::new("badconfig");
        s.file(
            ".qaren/config.yaml",
            "appId: com.example\ndevClientScheme: exp+example\nmetroPort: 80\n",
        );
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        let check = row(&run_doctor(&mut runner, &s, &s.0, None), "config").clone();
        assert_eq!(check.status, Status::Fail);
        assert!(check.detail.contains("ScenarioInvalid"), "{}", check.detail);
    }

    #[test]
    fn login_rows_cover_missing_saved_candidate_and_sign_out_states() {
        let s = Scratch::new("login-rows");
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, None)[0].status,
            Status::Skip
        );
        let mut config: CheckConfig =
            serde_yaml::from_str("appId: com.example.app\ndevClientScheme: exp+example\n").unwrap();
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0].status,
            Status::Skip
        );
        config.login_block = Some("sign-in".into());
        config.login_marker = Some(serde_yaml::from_str("text: Email\n").unwrap());
        let missing = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
        assert_eq!(missing[0].status, Status::Warn);
        assert_eq!(
            missing[0].fix.as_deref(),
            Some("run the plan that holds its `### Sign in` block once")
        );
        let block = "appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: ios\n\n# 1. Fill email\n- tapOn: { text: Email }\n- inputText: { input: USERNAME }\n# 2. Fill password\n- tapOn: { id: password }\n- inputText: { input: PASSWORD }\n";
        s.file(".qaren/actions/sign-in.yaml", block);
        let saved = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
        assert_eq!(saved[0].status, Status::Pass);
        assert_eq!(
            saved[0].detail,
            "loginBlock sign-in is saved for ios (inputs USERNAME, PASSWORD)"
        );
        config.login_block = None;
        let candidate = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
        assert_eq!(candidate[0].status, Status::Warn);
        let fix = candidate[0].fix.as_ref().unwrap();
        assert!(fix.contains("is a likely login block"), "{fix}");
        assert!(fix.contains("Confirm it signs in"), "{fix}");
        assert!(fix.contains("text: \"Email\""), "{fix}");
        s.file(
            ".qaren/actions/sign-in.yaml",
            &block.replace(
                "# 1. Fill email",
                "# 1. Tap \"Sign out\"\n- tapOn: { text: \"Sign out\" }\n# 2. Fill email",
            ),
        );
        let warning = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
        assert!(warning[0]
            .fix
            .as_ref()
            .unwrap()
            .contains("signs out (step 1)"));
        assert!(!warning[0].fix.as_ref().unwrap().contains("loginMarker:"));
        config.login_block = Some("sign-in".into());
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0].status,
            Status::Warn
        );
        s.file(
            ".qaren/actions/sign-in.yaml",
            &block.replace("platform: ios", "platform: android"),
        );
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0].status,
            Status::Warn
        );
        config.android = Some(serde_yaml::from_str("{}\n").unwrap());
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[1].status,
            Status::Pass
        );
        config.app_id = "com.other.app".into();
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[1].status,
            Status::Warn
        );
    }

    #[test]
    fn login_rows_check_the_configured_marker_and_runtime_inputs() {
        let s = Scratch::new("login-marker");
        let mut config: CheckConfig = serde_yaml::from_str(
            "appId: com.example.app\ndevClientScheme: exp+example\nloginBlock: sign-in\nloginMarker:\n  id: home-tab\n",
        )
        .unwrap();
        let block = "appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: ios\n\n# 1. Fill email\n- tapOn: { id: login-email }\n- inputText: { input: USERNAME }\n";
        s.file(".qaren/actions/sign-in.yaml", block);
        let mismatch = &login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0];
        assert_eq!(mismatch.status, Status::Warn);
        let fix = mismatch.fix.as_ref().unwrap();
        assert!(fix.contains("is not the first selector"), "{fix}");
        assert!(fix.contains("visible only on the sign-in screen"), "{fix}");
        assert!(
            fix.contains("loginMarker:\n      id: \"login-email\""),
            "{fix}"
        );
        assert!(!fix.contains("home-tab"), "{fix}");
        config.login_marker = None;
        let unset = &login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0];
        assert_eq!(unset.status, Status::Warn);
        assert!(unset.fix.as_ref().unwrap().contains("id: \"login-email\""));
        config.login_marker = Some(serde_yaml::from_str("id: login-email\n").unwrap());
        assert_eq!(
            login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0].status,
            Status::Pass
        );
        s.file(
            ".qaren/actions/sign-in.yaml",
            &block.replace(
                "- inputText: { input: USERNAME }",
                "- inputText: \"someone\"",
            ),
        );
        let no_inputs = &login_checks(&mut MockRunner::new(), &s.0, Some(&config))[0];
        assert_eq!(no_inputs.status, Status::Warn);
        assert!(no_inputs
            .fix
            .as_ref()
            .unwrap()
            .contains("fills no runtime inputs"));
        assert!(!no_inputs.fix.as_ref().unwrap().contains("someone"));
    }

    #[test]
    fn unreadable_configured_login_blocks_fail_without_printing_their_body() {
        let s = Scratch::new("login-malformed");
        let config: CheckConfig = serde_yaml::from_str(
            "appId: com.example.app\ndevClientScheme: exp+example\nandroid:\n  avd: Pixel\nloginBlock: sign-in\nloginMarker:\n  id: login-email\n",
        )
        .unwrap();
        let canary = "private-login-canary";
        for platform in ["ios", "android"] {
            let valid = format!("appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: {platform}\n\n# 1. Fill email\n- tapOn: {{ id: login-email }}\n- inputText: {{ input: USERNAME }}\n");
            s.file(".qaren/actions/sign-in.yaml", &valid);
            let rows = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
            assert_eq!(
                rows.iter()
                    .find(|row| row.detail.contains(platform))
                    .unwrap()
                    .status,
                Status::Pass
            );
            for malformed in [
                valid.replace(
                    "input: USERNAME }",
                    &format!("input: USERNAME, text: \"{canary}\""),
                ),
                format!("{valid}broken: [{canary}\n"),
                format!("{valid}---\nbroken: [{canary}\n"),
                valid.replacen("appId: com.example.app", &format!("appId: [{canary}"), 1),
            ] {
                s.file(".qaren/actions/sign-in.yaml", &malformed);
                assert!(crate::actions::login_candidate(&malformed).is_none());
                assert!(crate::actions::login_hint(
                    &mut MockRunner::new(),
                    &s.0,
                    "sign-in",
                    platform,
                    &config,
                    true
                )
                .is_none());
                let rows = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
                let row = rows
                    .iter()
                    .find(|row| row.detail.contains(platform))
                    .unwrap();
                assert_eq!(row.status, Status::Fail, "{row:?}");
                assert_eq!(
                    row.detail,
                    format!("loginBlock sign-in for {platform} is not a readable saved block")
                );
                assert!(row.fix.as_ref().unwrap().contains("save it again"));
                let report = Report {
                    identity: Identity {
                        exe: None,
                        version: VERSION,
                        build: None,
                        runtime: s.0.clone(),
                    },
                    checks: rows,
                };
                assert_eq!(report.exit_code(), 1);
                for out in [report.render(), report.to_json()] {
                    assert!(!out.contains(canary), "{out}");
                    assert!(!out.contains("USERNAME"), "{out}");
                }
            }
        }
    }

    #[test]
    fn login_rows_inspect_default_ios_when_android_is_also_configured() {
        let s = Scratch::new("login-ios-default");
        let config: CheckConfig = serde_yaml::from_str(
            "appId: com.example.app\ndevClientScheme: exp+example\nandroid:\n  avd: Pixel\nloginBlock: sign-in\nloginMarker:\n  text: Email\n",
        )
        .unwrap();
        s.file(".qaren/actions/sign-in.yaml", "appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: ios\n\n# 1. Fill email\n- tapOn: { text: Email }\n- inputText: { input: USERNAME }\n");
        let rows = login_checks(&mut MockRunner::new(), &s.0, Some(&config));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].status, Status::Pass);
        assert_eq!(
            rows[0].detail,
            "loginBlock sign-in is saved for ios (inputs USERNAME)"
        );
        assert_eq!(
            rows[1].detail,
            "loginBlock sign-in is not saved for android"
        );
    }

    #[test]
    fn doctor_reads_saved_blocks_beside_an_app_relative_config() {
        let s = Scratch::new("login-app-root");
        s.file(
            "apps/mobile/.qaren/config.yaml",
            "appId: com.example.app\ndevClientScheme: exp+example\n",
        );
        s.file("apps/mobile/.qaren/actions/sign-in.yaml", "appId: com.example.app\n---\n# id: sign-in\n# intent: Sign in\n# appId: com.example.app\n# platform: ios\n\n# 1. Fill email\n- tapOn: { id: login-email }\n- inputText: { input: USERNAME }\n");
        let mut runner = MockRunner::new();
        script_toolchain(&mut runner, Some("v24.1.0\n"), RUNTIMES);
        runner.expect_run(
            "--git-common-dir",
            CmdOutput::failed(128, "not a git checkout"),
        );
        script_host(&mut runner);
        let report = doctor(
            &mut runner,
            &s.0,
            &s.0,
            None,
            PathBuf::from("/runtime"),
            Some(Path::new("apps/mobile/.qaren/config.yaml")),
        );
        let login = row(&report, "login");
        assert_eq!(login.status, Status::Warn, "{login:?}");
        assert!(login.fix.as_ref().unwrap().contains("id: \"login-email\""));
        let git = runner
            .calls
            .iter()
            .find(|call| call.args.iter().any(|arg| arg == "--git-common-dir"))
            .unwrap();
        assert!(
            git.cwd.as_ref().unwrap().ends_with("apps/mobile"),
            "{git:?}"
        );
    }

    #[test]
    fn saved_block_rows_skip_when_git_cannot_identify_a_checkout() {
        let mut runner = MockRunner::new();
        runner.expect_run(
            "--git-common-dir",
            CmdOutput::failed(128, "not a git checkout"),
        );
        let check = saved_blocks_check(&mut runner, Path::new("/not-a-checkout"));
        assert_eq!(check.status, Status::Skip);
        assert_eq!(check.detail, "not a Git checkout");
        assert!(check.fix.is_none());
    }

    #[test]
    fn saved_block_rows_inspect_only_an_isolated_temporary_git_repository() {
        let s = Scratch::new("corpus-rows");
        let mut runner = crate::exec::RealRunner::new();
        let primary = s.dir("primary");
        let linked = s.path("linked");
        for args in [
            vec!["init"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
            vec!["worktree", "add", "--detach", linked.to_str().unwrap()],
        ] {
            let output = runner.run(&CmdSpec::new("test-git", "git", &args, 10).cwd(&primary));
            assert!(output.ok(), "{}", output.stderr);
        }
        assert_eq!(
            saved_blocks_check(&mut runner, &primary).status,
            Status::Pass
        );
        std::fs::create_dir_all(linked.join(".qaren/actions")).unwrap();
        std::fs::write(linked.join(".qaren/actions/sign-in.yaml"), "steps: []\n").unwrap();
        let local = saved_blocks_check(&mut runner, &linked);
        assert_eq!(local.status, Status::Warn);
        let fix = local.fix.unwrap();
        assert!(fix.starts_with("▸ saved blocks: 1 written"), "{fix}");
        assert!(fix.contains("then: ln -s <main>/<app>/.qaren/actions .qaren/actions"));
        std::fs::write(linked.join(".gitignore"), ".qaren/actions/\n").unwrap();
        let ignored = saved_blocks_check(&mut runner, &linked);
        assert_eq!(ignored.status, Status::Warn, "{ignored:?}");
        assert!(ignored.fix.unwrap().contains("they leave with this"));
        std::fs::remove_file(linked.join(".gitignore")).unwrap();
        for args in [
            vec!["add", ".qaren/actions"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "blocks",
            ],
        ] {
            let output = runner.run(&CmdSpec::new("test-git", "git", &args, 10).cwd(&linked));
            assert!(output.ok(), "{}", output.stderr);
        }
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Pass
        );
        std::fs::write(
            linked.join(".gitignore"),
            ".qaren/actions/session-only.yaml\n",
        )
        .unwrap();
        std::fs::write(
            linked.join(".qaren/actions/session-only.yaml"),
            "steps: []\n",
        )
        .unwrap();
        let mixed = saved_blocks_check(&mut runner, &linked);
        assert_eq!(mixed.status, Status::Warn, "{mixed:?}");
        assert!(mixed.fix.unwrap().contains("they leave with this"));
        std::fs::remove_file(linked.join(".qaren/actions/session-only.yaml")).unwrap();
        std::fs::remove_file(linked.join(".gitignore")).unwrap();
        std::fs::write(linked.join(".qaren/actions/sign-in.yaml"), "steps: [1]\n").unwrap();
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Warn
        );
        let output = runner.run(
            &CmdSpec::new("test-git", "git", &["rm", "-rq", "--cached", ".qaren"], 10).cwd(&linked),
        );
        assert!(output.ok(), "{}", output.stderr);
        std::fs::remove_dir_all(linked.join(".qaren/actions")).unwrap();
        let target = primary.join(".qaren/actions");
        std::fs::create_dir_all(&target).unwrap();
        std::os::unix::fs::symlink(&target, linked.join(".qaren/actions")).unwrap();
        assert!(crate::actions::list(&mut runner, &linked).is_ok());
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Pass
        );
        let private_root = s.path("private-corpus-canary");
        std::fs::rename(primary.join(".qaren"), &private_root).unwrap();
        std::os::unix::fs::symlink(&private_root, primary.join(".qaren")).unwrap();
        assert!(crate::actions::list(&mut runner, &linked).is_err());
        let rejected = saved_blocks_check(&mut runner, &linked);
        assert_eq!(rejected.status, Status::Warn);
        assert!(!rejected.detail.contains("private-corpus-canary"));
        assert!(!rejected.fix.unwrap().contains("private-corpus-canary"));
        std::fs::remove_file(primary.join(".qaren")).unwrap();
        std::fs::rename(&private_root, primary.join(".qaren")).unwrap();
        assert!(crate::actions::list(&mut runner, &linked).is_ok());
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Pass
        );
        std::fs::remove_file(linked.join(".qaren/actions")).unwrap();
        std::os::unix::fs::symlink(s.dir("unrelated"), linked.join(".qaren/actions")).unwrap();
        assert!(crate::actions::list(&mut runner, &linked).is_err());
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Warn
        );
        std::fs::remove_file(linked.join(".qaren/actions")).unwrap();
        std::fs::remove_dir(linked.join(".qaren")).unwrap();
        std::os::unix::fs::symlink(primary.join(".qaren"), linked.join(".qaren")).unwrap();
        assert!(crate::actions::list(&mut runner, &linked).is_err());
        assert_eq!(
            saved_blocks_check(&mut runner, &linked).status,
            Status::Warn
        );
    }
}
