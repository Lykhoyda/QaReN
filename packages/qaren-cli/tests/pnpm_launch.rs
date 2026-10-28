mod common;

use qaren::adapters::pnpm::{group_probe_spec, source, GROUP_OK};
use qaren::commands::doctor::{doctor, Status};
use qaren::exec::{CmdOutput, MockRunner, RealRunner, Runner};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::process::Command;

#[test]
fn doctor_does_not_auto_pin_a_project_without_a_package_manager() {
    let root = common::temp_repo();
    let app = root.join("test-app");
    let package = app.join("package.json");
    let before = std::fs::read(&package).unwrap();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let pnpm = bin.join("pnpm");
    std::fs::write(
        &pnpm,
        r#"#!/bin/sh
if [ "${COREPACK_ENABLE_AUTO_PIN:-}" = 1 ] && [ "$PWD" = "$TEST_APP_ROOT" ]; then
  printf '{"packageManager":"pnpm@11.5.2"}\n' > package.json
fi
if [ "$1" = --version ]; then
  printf '11.5.2\n'
  exit 0
fi
if [ "$1" = --silent ]; then shift; fi
shift
exec "$@"
"#,
    )
    .unwrap();
    std::fs::set_permissions(&pnpm, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = root.join("config.yaml");
    std::fs::write(&config, "appId: com.example.fixture\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["doctor", "--json", "--config"])
        .arg(&config)
        .current_dir(&app)
        .env("HOME", root.join("home"))
        .env("QAREN_HOME", root.join("home/.qaren"))
        .env("COREPACK_ENABLE_AUTO_PIN", "1")
        .env("TEST_APP_ROOT", &app)
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        )
        .output()
        .unwrap();
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let row = report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == "pnpm-source")
        .unwrap();
    assert_eq!(row["status"], "pass");
    assert_eq!(std::fs::read(&package).unwrap(), before);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn exec_probe_accepts_preserved_groups_and_refuses_bootstrap_group_changes() {
    for body in [
        "shift; exec \"$@\"",
        "shift; set -m; \"$@\" & child=$!; wait \"$child\"",
    ] {
        let root = common::temp_repo();
        let bin = root.join("bin with spaces");
        std::fs::create_dir(&bin).unwrap();
        let launcher = bin.join("pnpm");
        std::fs::write(
            &launcher,
            format!(
                "#!/bin/bash\nif [ \"$1\" = --silent ]; then shift; else printf 'Already up to date\\nDone in 25ms using pnpm v11.5.2\\n'; fi\n{body}\n"
            ),
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = group_probe_spec(&root).env("PATH", bin.to_str().unwrap());
        let output = RealRunner::new().run(&spec);
        if body.contains("set -m") {
            assert!(!output.ok(), "{output:?}");
            assert_ne!(output.stdout, GROUP_OK);
        } else {
            assert!(output.ok(), "{output:?}");
            assert_eq!(output.stdout, GROUP_OK);
        }
        let mut runner = MockRunner::new();
        runner
            .environment
            .insert("PATH".into(), bin.display().to_string());
        for hint in [
            "xcodebuild",
            "simctl list runtimes",
            "node --version",
            "pnpm --version",
            "corepack --version",
            "pod --version",
            "df -Pk",
        ] {
            runner.expect_run(hint, CmdOutput::failed(1, "unavailable"));
        }
        runner.expect_run("QAREN_PNPM_LAUNCH_GROUP", output);
        runner.expect_run(
            "--git-common-dir",
            CmdOutput::failed(128, "not a git checkout"),
        );
        runner.expect_run("ps -axww", CmdOutput::failed(1, "unavailable"));
        if cfg!(target_os = "macos") {
            for hint in ["simctl list devices", "vm_stat", "sysctl", "top"] {
                runner.expect_run(hint, CmdOutput::failed(1, "unavailable"));
            }
        } else {
            for hint in ["/proc/meminfo", "/proc/loadavg", "/proc/stat", "/proc/stat"] {
                runner.expect_run(hint, CmdOutput::failed(1, "unavailable"));
            }
        }
        let report = doctor(
            &mut runner,
            &root,
            &root.join("home"),
            &root,
            None,
            root.join("runtime"),
            None,
        );
        let row = report
            .checks
            .iter()
            .find(|row| row.id == "pnpm-source")
            .unwrap();
        assert!(row.detail.contains(launcher.to_str().unwrap()));
        if body.contains("set -m") {
            assert_eq!(row.status, Status::Warn);
            assert!(row.detail.contains("PNPM_PROCESS_GROUP_UNSUPPORTED"));
            assert!(row
                .fix
                .as_ref()
                .unwrap()
                .contains("installed pnpm executable first"));
        } else {
            assert_eq!(row.status, Status::Pass);
            assert!(row.fix.is_none());
        }
        let json: serde_json::Value = serde_json::from_str(&report.to_json()).unwrap();
        let json_row = json["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == "pnpm-source")
            .unwrap();
        assert_eq!(
            json_row["status"],
            if body.contains("set -m") {
                "warn"
            } else {
                "pass"
            }
        );
        assert_eq!(runner.remaining(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn source_reports_first_executable_path_entry_and_its_resolved_target() {
    let root = common::temp_repo();
    let bin = root.join("bin");
    let target = root.join("corepack/dist/pnpm.js");
    std::fs::create_dir(&bin).unwrap();
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, "#!/usr/bin/env node\n").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&target, bin.join("pnpm")).unwrap();
    let mut runner = MockRunner::new();
    runner
        .environment
        .insert("PATH".into(), format!("{}:/usr/bin", bin.display()));
    assert_eq!(source(&runner), Some((bin.join("pnpm"), target)));
    std::fs::remove_dir_all(root).unwrap();
}
