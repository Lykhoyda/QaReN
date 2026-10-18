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
