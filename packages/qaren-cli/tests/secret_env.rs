mod common;

use qaren::exec::{CmdSpec, RealRunner, Runner};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

const SECRETS: &[&str] = &[
    "TYPESAFE_API_KEY",
    "QAREN_INPUT_SLOT",
    "qaren_input_lower",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OP_SERVICE_ACCOUNT_TOKEN",
    "EXPO_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "COREPACK_NPM_TOKEN",
    "SENTRY_AUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "APP_SECRET",
    "serviceAPIKEY",
    "appPASSWORDfile",
    "dbPASSWD",
    "APP_CREDENTIALS_FILE",
    "SIGN_PRIVATE_KEY_FILE",
    "simpletoken",
    "typesafe_api_key",
    "APP_SECRET_OVERRIDE",
];
const REGISTRY: &[&str] = &[
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "YARN_NPM_AUTH_TOKEN",
    "COREPACK_NPM_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
];
const KEPT: &[&str] = &[
    "SSH_AUTH_SOCK",
    "ADB_VENDOR_KEYS",
    "ANDROID_HOME",
    "DEVELOPER_DIR",
    "AUTH",
    "KEY",
    "TOKEN_PATH",
];

fn names(output: &str) -> BTreeMap<&str, &str> {
    output
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect()
}

fn until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "fixture child did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn every_spawn_path_scrubs_secret_names_and_preserves_only_the_ruled_exemptions() {
    let dir = common::temp_repo();
    let mut worker = Command::new(std::env::current_exe().unwrap());
    worker
        .args([
            "--exact",
            "secret_environment_fixture_worker",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("QAREN_ENV_FIXTURE_DIR", &dir)
        .env("QAREN_LOG_ENV_RECEIPT", dir.join("helper-env"));
    for name in SECRETS.iter().chain(KEPT) {
        worker.env(name, format!("synthetic-{name}-value"));
    }
    let result = worker.output().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn secret_environment_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_ENV_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let wrapper = dir.join("log-helper");
    let binary = env!("CARGO_BIN_EXE_qaren").replace('\'', "'\\''");
    std::fs::write(
        &wrapper,
        format!("#!/bin/sh\n/usr/bin/env > \"$QAREN_LOG_ENV_RECEIPT\"\nexec '{binary}' \"$@\"\n"),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    for label in [
        "tool",
        "core-walk",
        "plan-preflight",
        "pnpm-install",
        "expo-prebuild",
    ] {
        for route in ["captured", "piped", "group"] {
            let _ = std::fs::remove_file(dir.join("helper-env"));
            let mut runner = RealRunner::with_log_executable(wrapper.clone());
            let spec = CmdSpec::new(label, "/usr/bin/env", &[], 5)
                .env("APP_SECRET_OVERRIDE", "synthetic-explicit-value");
            let log = dir.join("child.log");
            std::fs::write(&log, "").unwrap();
            let output = match route {
                "captured" => {
                    let output = runner.run(&spec);
                    assert!(output.ok());
                    output.stdout
                }
                "piped" => {
                    let mut child = runner.spawn_piped(&spec, &log).unwrap();
                    let mut output = String::new();
                    child.stdout.read_to_string(&mut output).unwrap();
                    until(|| child.handle.try_wait().unwrap().is_some());
                    output
                }
                _ => {
                    let child = runner.spawn_group(&spec, &log).unwrap();
                    until(|| runner.try_reap(child.pid));
                    runner.flush_logs().unwrap();
                    std::fs::read_to_string(&log).unwrap()
                }
            };
            let observed = names(&output);
            for name in SECRETS {
                let allowed = (*name == "TYPESAFE_API_KEY"
                    && matches!(label, "core-walk" | "plan-preflight"))
                    || (REGISTRY.contains(name)
                        && matches!(label, "pnpm-install" | "expo-prebuild"));
                assert_eq!(
                    observed.contains_key(name),
                    allowed,
                    "{label} {route} {name}"
                );
                if allowed && route != "group" {
                    assert_eq!(
                        observed.get(name).copied(),
                        Some(format!("synthetic-{name}-value").as_str()),
                        "{label} {route} {name}"
                    );
                }
            }
            for name in KEPT {
                assert_eq!(
                    observed.get(name).copied(),
                    Some(format!("synthetic-{name}-value").as_str()),
                    "{label} {route} {name}"
                );
            }
            assert_eq!(observed.get("PATH").copied(), Some("/usr/bin:/bin"));
            if route != "captured" {
                let helper = std::fs::read_to_string(dir.join("helper-env")).unwrap();
                let helper = names(&helper);
                for name in SECRETS {
                    assert!(!helper.contains_key(name), "log helper inherited {name}");
                }
            }
        }
    }
}

fn declared_spec(label: &str, script: &str, requested: &[&str]) -> CmdSpec {
    let mut json =
        serde_json::to_value(CmdSpec::new(label, "/bin/sh", &["-c", script], 5)).unwrap();
    json["registry_auth_env"] = serde_json::json!(requested);
    serde_json::from_value(json).unwrap()
}

fn registry_worker(test: &str) {
    let dir = common::temp_repo();
    let mut worker = Command::new(std::env::current_exe().unwrap());
    worker
        .args(["--exact", test, "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("QAREN_DECLARED_FIXTURE_DIR", &dir)
        .env("PRIVATE_REGISTRY_TOKEN", "synthetic-requested")
        .env("private_registry_token", "synthetic-case-variant")
        .env("EMPTY_SECRET", "")
        .env("UNREQUESTED_SECRET", "synthetic-unrequested")
        .env("REGISTRY_AUTH", "synthetic-ordinary");
    for name in SECRETS {
        worker.env(name, "synthetic-existing");
    }
    worker.env("NPM_TOKEN", "synthetic-requested");
    let result = worker.output().unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn declared_registry_auth_reaches_only_dependency_children() {
    registry_worker("declared_registry_fixture_worker");
}

fn run_registry_fixture(dir: &Path, spec: &CmdSpec, route: &str) -> String {
    let _ = std::fs::remove_file(dir.join("observed"));
    let log = dir.join("child.log");
    let wrapper = dir.join("registry-log-helper");
    let helper_receipt = dir.join("registry-helper-presence");
    let binary = env!("CARGO_BIN_EXE_qaren").replace('\'', "'\\''");
    std::fs::write(&wrapper, format!("#!/bin/sh\nif [ -n \"$PRIVATE_REGISTRY_TOKEN$UNREQUESTED_SECRET$TYPESAFE_API_KEY$QAREN_INPUT_SLOT\" ]; then echo present; else echo absent; fi > '{}'\nexec '{binary}' \"$@\"\n", helper_receipt.display())).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut runner = RealRunner::with_log_executable(wrapper);
    match route {
        "captured" => {
            assert!(runner.run(spec).ok());
        }
        "piped" => {
            let mut child = runner.spawn_piped(spec, &log).unwrap();
            let mut output = String::new();
            child.stdout.read_to_string(&mut output).unwrap();
            let mut status = None;
            until(|| {
                status = child.handle.try_wait().unwrap();
                status.is_some()
            });
            assert_eq!(status, Some(0));
        }
        _ => {
            let child = runner.spawn_group(spec, &log).unwrap();
            until(|| runner.try_reap(child.pid));
            runner.flush_logs().unwrap();
        }
    }
    if route != "captured" {
        assert_eq!(std::fs::read_to_string(helper_receipt).unwrap(), "absent\n");
    }
    std::fs::read_to_string(dir.join("observed")).unwrap()
}

const PRESENCE: &str = r#"
{
    test -n "$PRIVATE_REGISTRY_TOKEN" && echo requested
    test -n "$PRIVATE_REGISTRY_TOKEN" && test "$PRIVATE_REGISTRY_TOKEN" = "$NPM_TOKEN" && echo matches
    test -n "$private_registry_token" && echo variant
    test -n "$UNREQUESTED_SECRET" && echo unrequested
    test -n "$APP_SECRET_OVERRIDE" && echo explicit
    test -n "$TYPESAFE_API_KEY" && echo model
    test -n "$QAREN_INPUT_SLOT" && echo input
    test -n "$qaren_input_lower" && echo input_lower
    test -n "$REGISTRY_AUTH" && echo ordinary
    test "${EMPTY_SECRET+x}" = x && test -z "$EMPTY_SECRET" && echo empty
    test "${ABSENT_SECRET+x}" = x && echo absent
    test -n "$NPM_TOKEN" && echo conventional
    :
} > observed
"#;

#[test]
fn declared_registry_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_DECLARED_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    for label in [
        "pnpm-install",
        "expo-prebuild",
        "tool",
        "core-walk",
        "plan-preflight",
        "pnpm-fetch",
        "expo-run-ios",
        "gradle",
        "xcodebuild-ios",
        "metro",
        "git",
    ] {
        for route in ["captured", "piped", "group"] {
            let spec = declared_spec(
                label,
                PRESENCE,
                &[
                    "PRIVATE_REGISTRY_TOKEN",
                    "EMPTY_SECRET",
                    "ABSENT_SECRET",
                    "REGISTRY_AUTH",
                ],
            )
            .cwd(dir)
            .env("APP_SECRET_OVERRIDE", "synthetic-explicit");
            let observed = run_registry_fixture(dir, &spec, route);
            let has = |name| observed.lines().any(|line| line == name);
            let eligible = matches!(label, "pnpm-install" | "expo-prebuild");
            assert_eq!(has("requested"), eligible, "{label} {route}");
            assert_eq!(has("matches"), eligible, "{label} {route}");
            assert_eq!(has("empty"), eligible, "{label} {route}");
            assert_eq!(has("conventional"), eligible);
            assert_eq!(
                has("model"),
                matches!(label, "core-walk" | "plan-preflight")
            );
            assert!(has("ordinary"));
            for name in [
                "variant",
                "unrequested",
                "explicit",
                "input",
                "input_lower",
                "absent",
            ] {
                assert!(!has(name), "{label} {route} {name}");
            }
        }
    }
    for names in [
        vec![],
        vec!["PRIVATE_REGISTRY_TOKEN", "TYPESAFE_API_KEY"],
        vec!["PRIVATE_REGISTRY_TOKEN", "qaren_input_lower"],
        vec!["PRIVATE_REGISTRY_TOKEN", "BAD=NAME"],
    ] {
        for label in ["pnpm-install", "expo-prebuild"] {
            let spec = declared_spec(label, PRESENCE, &names).cwd(dir);
            let observed = run_registry_fixture(dir, &spec, "captured");
            for name in ["requested", "input", "input_lower", "model"] {
                assert!(!observed.lines().any(|line| line == name));
            }
        }
    }
    let spec = declared_spec("pnpm-install", PRESENCE, &["PRIVATE_REGISTRY_TOKEN"])
        .cwd(dir)
        .env_remove("PRIVATE_REGISTRY_TOKEN");
    assert!(!run_registry_fixture(dir, &spec, "captured")
        .lines()
        .any(|line| line == "requested"));
    let spec = declared_spec("pnpm-install", PRESENCE, &["private_registry_token"]).cwd(dir);
    let observed = run_registry_fixture(dir, &spec, "captured");
    assert!(observed.lines().any(|line| line == "variant"));
    assert!(!observed.lines().any(|line| line == "requested"));
}

#[test]
fn prebuild_descendant_inherits_declared_registry_auth() {
    registry_worker("prebuild_descendant_fixture_worker");
}

#[test]
fn prebuild_descendant_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_DECLARED_FIXTURE_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    std::fs::write(dir.join("grandchild.sh"), PRESENCE).unwrap();
    for requested in [vec![], vec!["PRIVATE_REGISTRY_TOKEN"]] {
        let spec = declared_spec("expo-prebuild", "/bin/sh grandchild.sh", &requested).cwd(dir);
        let observed = run_registry_fixture(dir, &spec, "captured");
        assert_eq!(
            observed.lines().any(|line| line == "requested"),
            !requested.is_empty()
        );
        assert_eq!(
            observed.lines().any(|line| line == "matches"),
            !requested.is_empty()
        );
        assert!(!observed.lines().any(|line| line == "unrequested"));
    }
}
