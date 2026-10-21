use qaren::commands::{cleanup, complete, doctor, prepare, prewarm, status, update};
use qaren::core::Budgets;
use qaren::exec::{RealRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::run::{
    self, default_runtime_dir as runtime_dir, RunRequest, DEFAULT_STEP_SECONDS,
    DEFAULT_WALK_SECONDS,
};
use qaren::scenario::Platform;
use std::path::PathBuf;
use std::process::ExitCode;

macro_rules! eprintln {
    ($($args:tt)*) => { std::eprintln!("{}", qaren::redact::redact_inputs(&format!($($args)*))) };
}

const USAGE: &str = "usage: qaren check --plan-file <plan.md> [--platform ios|android] [--device <udid>] [--config .qaren/config.yaml] [--fresh-install] [--boot-device | --restart-device] [--shutdown-device-on-exit] [--json]\n       qaren pr <number|url> --plan-file <plan.md> [--platform ios|android] [--device <udid>] [--config .qaren/config.yaml] [--fresh-install] [--boot-device | --restart-device] [--shutdown-device-on-exit] [--json]\n       qaren publish <run-id> [--json]\n       qaren prepare <scenario.yaml> [--device <udid> [--boot-device]] [--json] [--dry-run]\n       qaren prewarm <scenario.yaml> [--json]\n       qaren watch [<run-id> | --latest] [--plain] [--json]\n       qaren status  <run-id> [--json]\n       qaren complete <run-id> <build-log> [--json]\n       qaren cleanup <run-id> [--json] [--remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id>]\n       qaren actions list [--json]\n       qaren actions show <slug>\n       qaren update\n       qaren doctor [--json] [--config .qaren/config.yaml]\n       qaren --version\n\ncheck walks the plan on the booted simulator against the working tree; runs land in ~/.qaren/runs/<run-id>/.\npr walks the plan on a detached worktree at the pull request head, recording the screen; publish posts the reviewer comment and saves discovered blocks to the PR branch.\nupdate, run from the rn-dev-agent checkout root, fast-forwards it, rebuilds and reinstalls qaren, and says whether the build changed.\ndoctor checks this host, the installed build and the app config, and lists rn-dev-agent 1.x leftovers; it changes nothing.\n--fresh-install opts into removing the selected app and its data under the check device lease before installation.\n--boot-device opts into booting an exact iOS simulator UUID selected by --device under the check lease; cleanup leaves it running.\nprepare --device borrows that exact existing iOS simulator under the same lease instead of creating one; cleanup keeps it.\n--restart-device opts into restarting (or booting if Shutdown) an exact iOS simulator UUID selected by --device under the check lease.\n--shutdown-device-on-exit opts into shutting down the exact iOS simulator UUID selected by --device during teardown while this run holds its lease.\n--remove-app also uninstalls the app (and its data) this run installed on its leased Android emulator;\nthe confirmation must name exactly this run, its recorded emulator serial and its app id.";

fn user_home() -> Result<PathBuf, String> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() && PathBuf::from(&home).is_absolute() => {
            Ok(PathBuf::from(home))
        }
        _ => Err("HOME is not an absolute path".to_string()),
    }
}

fn qaren_home() -> Result<PathBuf, String> {
    user_home().map(|home| home.join(".qaren"))
}

// Absolute QAREN_LOCK_ROOT wins. QAREN_MACHINE_LOCKS=1 selects the OS parent.
// Otherwise the root stays $HOME/.qaren/locks.
fn lock_root() -> Result<PathBuf, String> {
    qaren::buildplan::configured_lock_root(
        std::env::var_os("QAREN_LOCK_ROOT").as_deref(),
        std::env::var_os(qaren::buildplan::MACHINE_LOCKS_OPT_IN).as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

fn runs_root() -> Result<PathBuf, String> {
    qaren_home().map(|home| home.join("runs"))
}

fn native_cache_root() -> Result<PathBuf, String> {
    let explicit = std::env::var_os("QAREN_NATIVE_CACHE_ROOT");
    #[cfg(target_os = "macos")]
    {
        qaren::buildplan::resolve_native_cache_root(explicit.as_deref(), unsafe { libc::geteuid() })
    }
    #[cfg(not(target_os = "macos"))]
    {
        match explicit {
            Some(value) => qaren::buildplan::resolve_native_cache_root(Some(&value), unsafe {
                libc::geteuid()
            }),
            None => qaren::buildplan::resolve_native_cache_root(
                Some(qaren_home()?.join("native-cache").as_os_str()),
                unsafe { libc::geteuid() },
            ),
        }
    }
}

fn build_roots() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    Ok((lock_root()?, runs_root()?, native_cache_root()?))
}

fn env_seconds(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn check_budgets() -> Budgets {
    Budgets {
        walk_seconds: env_seconds("QAREN_WALK_SECONDS", DEFAULT_WALK_SECONDS),
        step_seconds: env_seconds("QAREN_STEP_SECONDS", DEFAULT_STEP_SECONDS),
    }
}

fn failed_receipt(verb: &str, failure: Failure, runner: &dyn Runner) -> Receipt {
    let mut receipt = Receipt::new(
        verb,
        "none",
        if failure.code.is_refusal() {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        },
        &failure.phase.clone(),
        qaren::timefmt::iso8601_utc(runner.now_epoch_ms()),
    );
    receipt.next_action = failure.next_action.to_string();
    receipt.failure = Some(failure);
    receipt.commands_executed = runner.commands_executed();
    receipt
}

fn roots_failure(detail: String) -> Failure {
    let next_action =
        if detail.contains("QAREN_LOCK_ROOT") || detail.contains("QAREN_MACHINE_LOCKS") {
            "set an absolute QAREN_LOCK_ROOT, or leave QAREN_MACHINE_LOCKS unset"
        } else {
            "set HOME to an absolute path and QAREN_NATIVE_CACHE_ROOT to a supported private absolute directory"
        };
    Failure::new(
        "validate",
        FailureCode::PrereqMissing,
        format!("no host-level state root is available: {detail}"),
        next_action,
    )
}

// Saved plan blocks under the current app's .qaren/actions; read-only.
fn actions(args: &[String], json: bool) -> ExitCode {
    let app_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let result = match args {
        [sub] if sub == "list" => qaren::actions::list(&app_root).map(|entries| {
            if json {
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&entries).unwrap_or_else(|_| "[]".to_string())
                )
            } else {
                qaren::actions::render(&entries)
            }
        }),
        [sub, slug] if sub == "show" && !json => qaren::actions::show(&app_root, slug),
        _ => {
            eprintln!("usage: qaren actions list [--json] | qaren actions show <slug>\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(text) => {
            print!("{}", qaren::redact::redact_inputs(&text));
            ExitCode::from(0)
        }
        Err(detail) => {
            eprintln!("qaren actions: {detail}");
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let raw_args: Vec<_> = std::env::args_os().skip(1).collect();
    if raw_args
        .first()
        .is_some_and(|arg| arg == qaren::process_observation::HELPER_ARG)
    {
        return ExitCode::from(qaren::process_observation::run_helper(&raw_args));
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == qaren::exec::log::HELPER_ARG)
    {
        let paired = args.iter().any(|arg| arg == qaren::exec::log::PAIRED_ARG);
        return ExitCode::from(u8::from(qaren::exec::log::run_helper(paired).is_err()));
    }
    let inputs = std::sync::Arc::new(qaren::redact::InputValues::capture());
    qaren::redact::with_input_scope(inputs, || main_inner(args))
}

fn main_inner(args: Vec<String>) -> ExitCode {
    if args == ["--version"] {
        println!("qaren {}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }
    if args.first().is_some_and(|verb| verb == "watch") {
        return watch(&args[1..]);
    }
    let mut positional = Vec::new();
    let mut dry_run = false;
    let mut fresh_install = false;
    let mut boot_device = false;
    let mut restart_device = false;
    let mut shutdown_device_on_exit = false;
    let mut remove_app = false;
    let mut confirm_remove_app: Option<String> = None;
    let mut plan_file: Option<String> = None;
    let mut platform: Option<String> = None;
    let mut config: Option<String> = None;
    let mut device: Option<String> = None;
    let mut json = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let value_for = |flag: &str, iter: &mut std::slice::Iter<String>| -> Option<String> {
            match iter.next() {
                Some(value) if !value.starts_with('-') => Some(value.clone()),
                _ => {
                    eprintln!("{flag} requires a value\n{USAGE}");
                    None
                }
            }
        };
        match arg.as_str() {
            "--json" => json = true,
            "--dry-run" => dry_run = true,
            "--fresh-install" => fresh_install = true,
            "--boot-device" => boot_device = true,
            "--restart-device" => restart_device = true,
            "--shutdown-device-on-exit" => shutdown_device_on_exit = true,
            "--remove-app" => remove_app = true,
            "--confirm-remove-app" => match value_for("--confirm-remove-app", &mut iter) {
                Some(v) => confirm_remove_app = Some(v),
                None => return ExitCode::from(2),
            },
            "--plan-file" => match value_for("--plan-file", &mut iter) {
                Some(v) => plan_file = Some(v),
                None => return ExitCode::from(2),
            },
            "--platform" => match value_for("--platform", &mut iter) {
                Some(v) => platform = Some(v),
                None => return ExitCode::from(2),
            },
            "--config" => match value_for("--config", &mut iter) {
                Some(v) => config = Some(v),
                None => return ExitCode::from(2),
            },
            "--device" => match value_for("--device", &mut iter) {
                Some(v) => device = Some(v),
                None => return ExitCode::from(2),
            },
            "-h" | "--help" => {
                eprintln!("{USAGE}");
                return ExitCode::from(0);
            }
            other if other.starts_with('-') => {
                eprintln!("unknown flag {other}\n{USAGE}");
                return ExitCode::from(2);
            }
            other => positional.push(other.to_string()),
        }
    }
    let Some(verb) = positional.first().cloned() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let expected_positionals = match verb.as_str() {
        "check" | "update" | "doctor" => 1,
        "pr" | "publish" => 2,
        "complete" => 3,
        "actions" if positional.get(1).is_some_and(|sub| sub == "show") => 3,
        _ => 2,
    };
    if positional.len() != expected_positionals {
        eprintln!("wrong number of arguments for {verb}\n{USAGE}");
        return ExitCode::from(2);
    }
    if remove_app != confirm_remove_app.is_some() {
        eprintln!("--remove-app and --confirm-remove-app must be given together\n{USAGE}");
        return ExitCode::from(2);
    }
    if remove_app && verb != "cleanup" {
        eprintln!("--remove-app is only valid for cleanup\n{USAGE}");
        return ExitCode::from(2);
    }
    if dry_run && verb != "prepare" {
        eprintln!("--dry-run is only valid for prepare\n{USAGE}");
        return ExitCode::from(2);
    }
    if (plan_file.is_some()
        || platform.is_some()
        || (config.is_some() && verb != "doctor")
        || ((device.is_some() || boot_device) && verb != "prepare")
        || fresh_install
        || restart_device
        || shutdown_device_on_exit)
        && verb != "check"
        && verb != "pr"
    {
        eprintln!(
            "--plan-file, --platform, --config, --device, --fresh-install, --boot-device, --restart-device and --shutdown-device-on-exit are only valid for check and pr (--config also for doctor; --device and --boot-device also for prepare)\n{USAGE}"
        );
        return ExitCode::from(2);
    }
    if verb == "prepare" {
        if boot_device && device.is_none() {
            eprintln!("--boot-device requires --device with an exact iOS simulator UUID\n{USAGE}");
            return ExitCode::from(2);
        }
        if let Some(udid) = &device {
            match qaren::adapters::ios::canonical_udid(udid) {
                Some(canonical) => device = Some(canonical),
                None => {
                    eprintln!("--device must be an exact iOS simulator UUID, not a name or booted alias\n{USAGE}");
                    return ExitCode::from(2);
                }
            }
        }
    }
    if verb == "actions" {
        return actions(&positional[1..], json);
    }
    if verb == "update" {
        if json {
            eprintln!("--json is not valid for update\n{USAGE}");
            return ExitCode::from(2);
        }
        let home = match qaren_home() {
            Ok(home) => home,
            Err(e) => {
                eprintln!("qaren update: {e}");
                return ExitCode::from(2);
            }
        };
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return match update::update(&cwd, &home) {
            Ok(text) => {
                println!("{text}");
                ExitCode::SUCCESS
            }
            Err((code, message)) => {
                eprintln!("{message}");
                ExitCode::from(code)
            }
        };
    }
    if verb == "doctor" {
        let home = match user_home() {
            Ok(home) => home,
            Err(e) => {
                eprintln!("qaren doctor: {e}");
                return ExitCode::from(2);
            }
        };
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let report = doctor::doctor(
            &mut RealRunner::new(),
            &home,
            &cwd,
            std::env::current_exe().ok(),
            runtime_dir(),
            config.as_deref().map(std::path::Path::new),
        );
        print!(
            "{}",
            if json {
                format!("{}\n", report.to_json())
            } else {
                report.render()
            }
        );
        return ExitCode::from(report.exit_code());
    }
    let mut runner = RealRunner::new();
    let receipt = match verb.as_str() {
        "check" | "pr" => {
            let platform = match platform.as_deref() {
                None | Some("ios") => Platform::Ios,
                Some("android") => Platform::Android,
                Some(other) => {
                    eprintln!("--platform must be ios or android, not {other}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };
            if let Err(failure) = run::validate_boot_device(
                platform,
                device.as_deref(),
                boot_device,
                restart_device,
                shutdown_device_on_exit,
            ) {
                eprintln!("{}\n{USAGE}", failure.detail);
                return ExitCode::from(2);
            }
            let Some(plan_file) = plan_file else {
                eprintln!("{verb} requires --plan-file <plan.md>\n{USAGE}");
                return ExitCode::from(2);
            };
            qaren::cancel::install();
            runner.watch_caller();
            qaren::progress::enable();
            qaren::events::init();
            match build_roots() {
                Ok((lock_root, runs_root, native_cache_root)) => {
                    let project_root =
                        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                    let request = RunRequest {
                        config_path: project_root.join(
                            config
                                .as_deref()
                                .unwrap_or(qaren::config::DEFAULT_CONFIG_PATH),
                        ),
                        plan_file: project_root.join(plan_file),
                        project_root,
                        platform,
                        device,
                        boot_device,
                        restart_device,
                        shutdown_device_on_exit,
                        fresh_install,
                        runtime_dir: runtime_dir(),
                        node: std::env::var_os("QAREN_NODE").map(PathBuf::from),
                        lock_root,
                        runs_root,
                        native_cache_root,
                        android_home: std::env::var("ANDROID_HOME").ok(),
                        budgets: check_budgets(),
                        pr: (verb == "pr").then(|| run::PrTarget {
                            target: positional[1].clone(),
                        }),
                    };
                    run::run(&mut runner, &request)
                }
                Err(detail) => failed_receipt(&verb, roots_failure(detail), &runner),
            }
        }
        "publish" => match runs_root() {
            Ok(runs_root) => qaren::publish::publish(
                &mut runner,
                &runs_root,
                &positional[1],
                &qaren::redact::MachineIdentity::current(),
            ),
            Err(detail) => failed_receipt("publish", roots_failure(detail), &runner),
        },
        "prepare" => match build_roots() {
            Ok((lock_root, runs_root, native_cache_root)) => {
                let prepare_args = prepare::PrepareArgs {
                    scenario_path: PathBuf::from(&positional[1]),
                    dry_run,
                    android_home: std::env::var("ANDROID_HOME").ok(),
                    lock_root,
                    runs_root,
                    native_cache_root,
                    device,
                    boot_device,
                };
                prepare::prepare(&mut runner, &prepare_args)
            }
            Err(detail) => failed_receipt("prepare", roots_failure(detail), &runner),
        },
        "prewarm" => {
            let prewarm_args = prewarm::PrewarmArgs {
                scenario_path: PathBuf::from(&positional[1]),
            };
            prewarm::prewarm(&mut runner, &prewarm_args)
        }
        "status" | "cleanup" | "complete" => {
            let target = positional[1].as_str();
            match runs_root() {
                Ok(runs_root) => match verb.as_str() {
                    "status" => status::status(&mut runner, &runs_root, target),
                    "cleanup" => cleanup::cleanup_with(
                        &mut runner,
                        &runs_root,
                        target,
                        confirm_remove_app.as_deref(),
                    ),
                    _ => complete::complete(
                        &mut runner,
                        &runs_root,
                        target,
                        std::path::Path::new(&positional[2]),
                    ),
                },
                Err(detail) => {
                    let failure = roots_failure(detail);
                    let mut receipt = Receipt::new(
                        &verb,
                        target,
                        ReceiptResult::Unknown,
                        "load",
                        qaren::timefmt::iso8601_utc(runner.now_epoch_ms()),
                    );
                    receipt.next_action = failure.next_action.to_string();
                    receipt.failure = Some(failure);
                    receipt.commands_executed = runner.commands_executed();
                    receipt
                }
            }
        }
        other => {
            eprintln!("unknown verb {other}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    qaren::events::end(&receipt, receipt_exit_code(receipt.result));
    qaren::events::finish();
    qaren::progress::close();
    let receipt_delivered = {
        use std::io::Write;
        writeln!(std::io::stdout(), "{}", receipt.to_json()).is_ok()
    };
    if !receipt_delivered {
        eprintln!("qaren: could not write the receipt to stdout");
        return ExitCode::from(1);
    }
    eprintln!(
        "qaren {}: {} (run {}, phase {}, {} commands)",
        receipt.verb,
        result_str(receipt.result),
        receipt.run_id,
        receipt.phase,
        receipt.commands_executed
    );
    if let Some(failure) = &receipt.failure {
        eprintln!(
            "failure: {} — next: {}",
            failure.detail, failure.next_action
        );
    }
    if let Some(report) = receipt.artifacts.get("report") {
        eprintln!("report: {}", report.display());
    }

    ExitCode::from(receipt_exit_code(receipt.result))
}

fn watch(args: &[String]) -> ExitCode {
    let mut id = None;
    let mut latest = false;
    let mut plain = false;
    let mut json = false;
    for arg in args {
        match arg.as_str() {
            "--latest" => latest = true,
            "--plain" => plain = true,
            "--json" => json = true,
            "--help" | "-h" => {
                eprintln!("usage: qaren watch [<run-id> | --latest] [--plain] [--json]");
                return ExitCode::SUCCESS;
            }
            value if !value.starts_with('-') && id.is_none() => id = Some(value.to_string()),
            _ => {
                eprintln!("usage: qaren watch [<run-id> | --latest] [--plain] [--json]");
                return ExitCode::from(2);
            }
        }
    }
    let target = match (id, latest) {
        (Some(id), false) => qaren::watch::Target::RunId(id),
        (None, true) => qaren::watch::Target::Latest,
        _ => {
            eprintln!("usage: qaren watch [<run-id> | --latest] [--plain] [--json]");
            return ExitCode::from(2);
        }
    };
    let code = match runs_root() {
        Ok(root) => qaren::watch::watch(
            &root,
            qaren::watch::WatchArgs {
                target,
                plain,
                json,
            },
        ),
        Err(_) => 1,
    };
    if code != 0 {
        eprintln!(
            "qaren watch: {}",
            match code {
                1 => "no such run",
                2 => "invalid run id",
                _ => "telemetry unavailable",
            }
        );
    }
    ExitCode::from(code)
}

fn receipt_exit_code(result: ReceiptResult) -> u8 {
    match result {
        ReceiptResult::Ready
        | ReceiptResult::Cleaned
        | ReceiptResult::Planned
        | ReceiptResult::Prewarmed
        | ReceiptResult::Working
        | ReceiptResult::Pass
        | ReceiptResult::Published => 0,
        ReceiptResult::Failed | ReceiptResult::Fail => 1,
        ReceiptResult::Unknown => 3,
        ReceiptResult::Refused => 4,
    }
}

fn result_str(result: ReceiptResult) -> &'static str {
    match result {
        ReceiptResult::Ready => "ready",
        ReceiptResult::Working => "working",
        ReceiptResult::Failed => "failed",
        ReceiptResult::Cleaned => "cleaned",
        ReceiptResult::Refused => "refused",
        ReceiptResult::Unknown => "unknown",
        ReceiptResult::Planned => "planned",
        ReceiptResult::Prewarmed => "prewarmed",
        ReceiptResult::Pass => "pass",
        ReceiptResult::Fail => "fail",
        ReceiptResult::Published => "published",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_cache_root_child() {
        use qaren::buildplan::*;
        let Some(role) = std::env::var_os("QAREN_TEST_CACHE_CHILD") else {
            return;
        };
        let root = super::native_cache_root().unwrap();
        let dir = store_dir(&root, "ios", "com.example.fixture", "rnfp1:abcd");
        if role == "publish" {
            let app =
                std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join("fixture.app");
            std::fs::create_dir_all(&app).unwrap();
            std::fs::write(app.join("fixture"), "harmless fixture").unwrap();
            let root = open_native_store_root(&root, true).unwrap().unwrap();
            let entry = root
                .entry(
                    std::path::Path::new("ios/com.example.fixture/rnfp1-abcd"),
                    true,
                )
                .unwrap()
                .unwrap();
            let copy = entry
                .copy_app(
                    &qaren::exec::MockRunner::new(),
                    &app,
                    std::ffi::OsStr::new("run"),
                    &hash_artifact(&app).unwrap(),
                )
                .unwrap();
            let record = StoreRecord {
                artifact: copy.retain(),
                built_at: "fixture".into(),
                candidate_sha: "a".repeat(40),
            };
            assert!(publish_store_record(&entry, &record).unwrap());
            std::fs::write(
                std::env::var_os("QAREN_TEST_CACHE_BARRIER").unwrap(),
                std::fs::read(dir.join(STORE_RECORD)).unwrap(),
            )
            .unwrap();
        } else {
            let before =
                std::fs::read(std::env::var_os("QAREN_TEST_CACHE_BARRIER").unwrap()).unwrap();
            let root = open_native_store_root(&root, false).unwrap().unwrap();
            let entry = root
                .entry(
                    std::path::Path::new("ios/com.example.fixture/rnfp1-abcd"),
                    false,
                )
                .unwrap()
                .unwrap();
            let record = load_store_record(&entry)
                .unwrap()
                .expect("second HOME must see the first publication");
            assert_eq!(
                hash_artifact(&record.artifact.path).unwrap(),
                record.artifact.sha256
            );
            let parts = std::collections::BTreeMap::new();
            let worktree =
                std::path::PathBuf::from(std::env::var_os("QAREN_TEST_WORKTREE").unwrap());
            assert!(!state_path(&worktree, "ios", "com.example.fixture").exists());
            assert_eq!(
                super::runs_root().unwrap(),
                std::path::PathBuf::from(std::env::var_os("HOME").unwrap()).join(".qaren/runs")
            );
            let inputs = DecisionInputs {
                platform: "ios",
                app_id: "com.example.fixture",
                worktree_root: &worktree,
                candidate_sha: "bbbb",
                fingerprint: "rnfp1:abcd",
                fingerprint_parts: &parts,
                fingerprint_complete: true,
                incompleteness: &[],
                expo_unavailable: None,
                scheme: Some("fixture"),
                force_clean: false,
                native_dir_exists: false,
                native_dir_in_candidate: false,
            };
            assert_eq!(
                decide(
                    &inputs,
                    &StateStatus::Missing,
                    Some((record, ArtifactStatus::Verified))
                )
                .decision,
                BuildDecision::Reuse
            );
            assert_eq!(std::fs::read(dir.join(STORE_RECORD)).unwrap(), before);
        }
    }

    #[test]
    fn native_cache_root_reuses_across_home_processes() {
        use std::os::unix::fs::DirBuilderExt;
        let fixture =
            std::env::temp_dir().join(format!("qaren-cache-process-{}", std::process::id()));
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&fixture)
            .unwrap();
        let fixture = fixture.canonicalize().unwrap();
        for separate_worktrees in [false, true] {
            let case = fixture.join(if separate_worktrees {
                "separate"
            } else {
                "same"
            });
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&case)
                .unwrap();
            for role in ["publish", "reuse"] {
                let output = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "tests::native_cache_root_child", "--nocapture"])
                    .env("HOME", case.join(role))
                    .env("QAREN_NATIVE_CACHE_ROOT", case.join("store"))
                    .env(
                        "QAREN_TEST_WORKTREE",
                        case.join(if separate_worktrees { role } else { "worktree" }),
                    )
                    .env("QAREN_TEST_CACHE_CHILD", role)
                    .env("QAREN_TEST_CACHE_BARRIER", case.join("published"))
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{role}: {}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        std::fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn native_cache_root_adapter_child() {
        let Some(expected) = std::env::var_os("QAREN_TEST_EXPECT_CACHE") else {
            return;
        };
        if expected == "invalid" || expected == "utf8" {
            assert_eq!(
                super::native_cache_root().unwrap_err(),
                if expected == "utf8" {
                    "native cache root: path must be valid UTF-8"
                } else {
                    "native cache root: invalid absolute path"
                }
            );
        } else {
            assert_eq!(super::native_cache_root().unwrap().as_os_str(), expected);
        }
    }

    #[test]
    fn native_cache_root_adapter_preserves_presence_os_strings_and_default() {
        use std::os::unix::ffi::OsStringExt;
        let mut cases = vec![
            (
                Some(std::ffi::OsString::from("")),
                std::ffi::OsString::from("invalid"),
            ),
            (Some("relative".into()), "invalid".into()),
            (Some("/".into()), "invalid".into()),
            (Some("/private/./cache".into()), "invalid".into()),
            (Some("/private/../cache".into()), "invalid".into()),
            (
                Some("/private/exact-cache".into()),
                "/private/exact-cache".into(),
            ),
            (
                Some(std::ffi::OsString::from_vec(
                    b"/private/cache-\xff".to_vec(),
                )),
                "utf8".into(),
            ),
        ];
        #[cfg(target_os = "macos")]
        cases.push((
            None,
            qaren::buildplan::resolve_native_cache_root(None, unsafe { libc::geteuid() })
                .unwrap()
                .into_os_string(),
        ));
        #[cfg(not(target_os = "macos"))]
        cases.push((None, "/home-fixture/.qaren/native-cache".into()));
        for (explicit, expected) in cases {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "--exact",
                    "tests::native_cache_root_adapter_child",
                    "--nocapture",
                ])
                .env("HOME", "/home-fixture")
                .env("QAREN_HOME", "/irrelevant-qaren")
                .env("TMPDIR", "/irrelevant-temp")
                .env("XDG_CACHE_HOME", "/irrelevant-xdg")
                .env("QAREN_LOCK_ROOT", "/irrelevant-locks")
                .env("QAREN_TEST_EXPECT_CACHE", expected);
            if let Some(value) = explicit {
                child.env("QAREN_NATIVE_CACHE_ROOT", value);
            } else {
                child.env_remove("QAREN_NATIVE_CACHE_ROOT");
            }
            let output = child.output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn check_uses_the_run_defaults_and_honors_a_small_step_override() {
        let names = ["QAREN_STEP_SECONDS", "QAREN_WALK_SECONDS"];
        let prior = names.map(std::env::var_os);
        for name in names {
            std::env::remove_var(name);
        }
        assert_eq!(
            super::check_budgets().step_seconds,
            super::DEFAULT_STEP_SECONDS
        );
        assert_eq!(
            super::check_budgets().walk_seconds,
            super::DEFAULT_WALK_SECONDS
        );
        std::env::set_var("QAREN_STEP_SECONDS", "5");
        assert_eq!(super::check_budgets().step_seconds, 5);
        assert_eq!(
            super::check_budgets().walk_seconds,
            super::DEFAULT_WALK_SECONDS
        );
        for (name, value) in names.into_iter().zip(prior) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn runtime_dir_prefers_the_env_var_then_the_installed_layout_then_the_checkout() {
        let root = std::env::temp_dir().join(format!("qaren-runtime-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let install = root.join("install");
        std::fs::create_dir_all(install.join("bin")).unwrap();
        std::fs::create_dir_all(install.join("runtime/qa")).unwrap();
        let exe = install.join("bin/qaren");

        assert_eq!(
            qaren::run::runtime_dir_from(Some("/explicit".into()), Some(exe.clone())),
            std::path::PathBuf::from("/explicit")
        );

        let checkout = install.join("bin/../../../qaren-core/dist");
        assert_eq!(
            qaren::run::runtime_dir_from(None, Some(exe.clone())),
            checkout
        );

        std::fs::write(install.join("runtime/qa/walk.js"), "").unwrap();
        let installed = install.join("runtime").canonicalize().unwrap();
        assert_eq!(
            qaren::run::runtime_dir_from(None, Some(exe.clone())),
            installed
        );
        assert_eq!(
            qaren::run::runtime_dir_from(Some("".into()), Some(exe)),
            installed
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn runtime_dir_follows_a_symlinked_binary_to_its_installed_runtime() {
        let root = std::env::temp_dir().join(format!("qaren-runtime-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let install = root.join("install");
        std::fs::create_dir_all(install.join("bin")).unwrap();
        std::fs::create_dir_all(install.join("runtime/qa")).unwrap();
        std::fs::create_dir_all(root.join("links")).unwrap();
        std::fs::write(install.join("bin/qaren"), "").unwrap();
        std::fs::write(install.join("runtime/qa/walk.js"), "").unwrap();
        let link = root.join("links/qaren");
        std::os::unix::fs::symlink(install.join("bin/qaren"), &link).unwrap();

        assert_eq!(
            qaren::run::runtime_dir_from(None, Some(link)),
            install.join("runtime").canonicalize().unwrap()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_refused_receipt_exits_four_not_one() {
        assert_eq!(super::receipt_exit_code(super::ReceiptResult::Refused), 4);
        assert_eq!(super::receipt_exit_code(super::ReceiptResult::Fail), 1);
    }
}
