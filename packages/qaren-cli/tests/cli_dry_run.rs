mod common;

use std::path::Path;
use std::process::Command;

// Bounded integration coverage: the real binary against the checked-in iOS
// scenario in --dry-run mode. Requires the host toolchain (git/pnpm/xcrun)
// but never allocates a device, port, or run record.
#[test]
fn dry_run_against_checked_in_ios_scenario_emits_parseable_receipt() {
    for tool in ["git", "pnpm", "xcrun"] {
        if !Command::new("/usr/bin/which")
            .arg(tool)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            eprintln!("skipping: {tool} unavailable on this host");
            return;
        }
    }
    let cache_fixture = common::temp_repo();
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let scenario = manifest_dir.join("scenarios/ios-simulator.yaml");
    let toplevel = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(manifest_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match toplevel {
        Some(root) if Path::new(&root).join("test-app").is_dir() => {}
        _ => {
            eprintln!("skipping: the checked-in scenario's test-app candidate is absent here");
            return;
        }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .env("QAREN_NATIVE_CACHE_ROOT", cache_fixture.join("store"))
        .args(["prepare", scenario.to_str().unwrap(), "--json", "--dry-run"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("stdout must be pure JSON ({e}): {stdout}"));
    assert_eq!(value["schema"], "qaren/1");
    assert_eq!(value["verb"], "prepare");
    let result = value["result"].as_str().unwrap();
    match result {
        "refused" => {
            assert_eq!(output.status.code(), Some(4));
            assert_eq!(value["failure"]["code"], "DEV_CLIENT_SCHEME_REQUIRED");
            assert_eq!(value["commands_executed"], 0);
        }
        "planned" => {
            assert!(output.status.success());
            let planned = value["planned_commands"].as_array().unwrap();
            assert!(planned
                .iter()
                .any(|c| c.as_str().unwrap().contains("expo run:ios")));
            assert!(value["candidate"]["git_sha"].as_str().unwrap().len() == 40);
        }
        "failed" => {
            // A busy host may legitimately hold the scenario port; the receipt
            // must still be a bounded structured failure with exit code 1.
            assert_eq!(output.status.code(), Some(1));
            let code = value["failure"]["code"].as_str().unwrap();
            assert!(
                code == "METRO_PORT_OCCUPIED" || code == "PREREQ_MISSING",
                "unexpected dry-run failure code {code}"
            );
        }
        other => panic!("unexpected dry-run result {other}"),
    }
}

#[test]
fn usage_errors_exit_2_with_empty_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_qaren")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        output.stdout.is_empty(),
        "usage errors must not write to stdout"
    );

    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["status", "run", "--dry-run"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn fresh_install_is_check_only_and_opt_in() {
    for verb in ["prepare", "prewarm", "status", "cleanup", "complete"] {
        let mut args = vec![verb, "missing", "--fresh-install"];
        if verb == "complete" {
            args.push("log");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("only valid for check"));
        assert!(output.stdout.is_empty());
    }
    for fresh in [false, true] {
        let mut args = vec![
            "check",
            "--plan-file",
            "missing",
            "--config",
            "/nonexistent/qaren-config",
        ];
        if fresh {
            args.push("--fresh-install");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["commands_executed"], 0);
    }
}

#[test]
fn status_of_unknown_run_exits_3_with_receipt() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ghost = format!("ghost-run-{}", std::process::id());
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .current_dir(manifest_dir)
        .args(["status", &ghost, "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["result"], "unknown");
    assert_eq!(value["failure"]["code"], "RUN_RECORD_UNAVAILABLE");
}

#[test]
fn boot_device_usage_requires_check_ios_and_an_exact_device_uuid() {
    for args in [
        vec!["prepare", "missing", "--boot-device"],
        vec!["prewarm", "missing", "--boot-device"],
        vec!["status", "missing", "--boot-device"],
        vec!["cleanup", "missing", "--boot-device"],
        vec!["complete", "missing", "log", "--boot-device"],
        vec!["check", "--plan-file", "missing", "--boot-device"],
        vec![
            "check",
            "--plan-file",
            "missing",
            "--boot-device",
            "--device",
            "booted",
        ],
        vec![
            "check",
            "--plan-file",
            "missing",
            "--boot-device",
            "--device",
            "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
            "--platform",
            "android",
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--boot-device"));
        assert!(!stderr.contains("unknown flag"), "{stderr}");
    }
    for udid in [
        "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
        "1dc408c4-51da-4c4f-aca1-39881c916fdd",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args([
                "check",
                "--plan-file",
                "missing",
                "--boot-device",
                "--device",
                udid,
                "--config",
                "/nonexistent/qaren-config",
            ])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["commands_executed"], 0);
    }
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    let help = String::from_utf8_lossy(&output.stderr);
    assert!(help.contains("[--boot-device | --restart-device]"));
    assert!(help.contains("[--shutdown-device-on-exit]"));
    assert!(help.contains("exact iOS simulator UUID"));
}

#[test]
fn restart_device_and_shutdown_device_on_exit_require_check_or_pr_ios_exact_uuid_and_reject_redundant_boot(
) {
    let udid = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    for flag in ["--restart-device", "--shutdown-device-on-exit"] {
        for args in [
            vec!["prepare", "missing", flag],
            vec!["prewarm", "missing", flag],
            vec!["status", "missing", flag],
            vec!["cleanup", "missing", flag],
            vec!["complete", "missing", "log", flag],
            vec!["publish", "missing", flag],
            vec!["check", "--plan-file", "missing", flag],
            vec![
                "check",
                "--plan-file",
                "missing",
                flag,
                "--device",
                "booted",
            ],
            vec![
                "check",
                "--plan-file",
                "missing",
                flag,
                "--device",
                "qa-company-app",
            ],
            vec![
                "check",
                "--plan-file",
                "missing",
                flag,
                "--device",
                udid,
                "--platform",
                "android",
            ],
            vec!["pr", "12", flag],
            vec!["pr", "12", flag, "--device", "booted"],
            vec!["pr", "12", flag, "--device", udid, "--platform", "android"],
        ] {
            let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
                .args(&args)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(2), "{args:?}");
            assert!(output.stdout.is_empty());
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert!(stderr.contains(flag), "{args:?}: {stderr}");
            assert!(!stderr.contains("unknown flag"), "{stderr}");
        }
    }
    for args in [
        vec![
            "check",
            "--plan-file",
            "missing",
            "--boot-device",
            "--restart-device",
            "--device",
            udid,
        ],
        vec![
            "pr",
            "12",
            "--boot-device",
            "--restart-device",
            "--device",
            udid,
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("redundant"), "{stderr}");
    }
    for candidate_udid in [udid, "1dc408c4-51da-4c4f-aca1-39881c916fdd"] {
        for extra in [
            vec!["--restart-device"],
            vec!["--shutdown-device-on-exit"],
            vec!["--boot-device", "--shutdown-device-on-exit"],
            vec!["--restart-device", "--shutdown-device-on-exit"],
        ] {
            let mut check_args = vec![
                "check",
                "--plan-file",
                "missing",
                "--device",
                candidate_udid,
                "--config",
                "/nonexistent/qaren-config",
            ];
            check_args.extend_from_slice(&extra);
            let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
                .args(&check_args)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(1), "{check_args:?}");
            let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(receipt["commands_executed"], 0);

            let mut pr_args = vec![
                "pr",
                "12",
                "--plan-file",
                "missing",
                "--device",
                candidate_udid,
                "--config",
                "/nonexistent/qaren-config",
            ];
            pr_args.extend_from_slice(&extra);
            let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
                .args(&pr_args)
                .output()
                .unwrap();
            assert_eq!(output.status.code(), Some(1), "{pr_args:?}");
            let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(receipt["commands_executed"], 0);
        }
    }
}

#[test]
fn remove_app_flags_are_usage_errors_unless_paired_on_cleanup() {
    let cases: &[&[&str]] = &[
        &["cleanup", "run", "--remove-app"],
        &["cleanup", "run", "--remove-app", "--confirm-remove-app"],
        &[
            "cleanup",
            "run",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
        &[
            "status",
            "run",
            "--remove-app",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
        &[
            "prepare",
            "s.yaml",
            "--remove-app",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(*args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            output.stdout.is_empty(),
            "{args:?} must not write a receipt"
        );
    }
}

#[test]
fn confirmed_removal_of_unknown_run_is_refused_with_receipt() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ghost = format!("ghost-run-{}", std::process::id());
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .current_dir(manifest_dir)
        .args([
            "cleanup",
            &ghost,
            "--json",
            "--remove-app",
            "--confirm-remove-app",
            &format!("{ghost}/emulator-5554/com.rndevagent.testapp"),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["result"], "refused");
    assert_eq!(value["failure"]["code"], "RUN_RECORD_UNAVAILABLE");
}

#[test]
fn prepare_accepts_only_an_exact_device_and_boot_permission_from_the_check_lifecycle_flags() {
    let uuid = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let lower = uuid.to_lowercase();
    for args in [
        vec!["prepare", "/nonexistent/scenario.yaml", "--device", uuid],
        vec![
            "prepare",
            "/nonexistent/scenario.yaml",
            "--device",
            lower.as_str(),
            "--boot-device",
        ],
        vec![
            "prepare",
            "/nonexistent/scenario.yaml",
            "--device",
            uuid,
            "--dry-run",
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(&args)
            .output()
            .unwrap();
        assert_ne!(output.status.code(), Some(2), "{args:?}");
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["verb"], "prepare");
        assert_eq!(receipt["commands_executed"], 0);
    }
    for args in [
        vec!["prepare", "missing", "--device", "booted"],
        vec!["prepare", "missing", "--device", "1DC408C4-51DA-4C4F-ACA1"],
        vec!["prepare", "missing", "--device"],
        vec!["prepare", "missing", "--boot-device"],
        vec!["prepare", "missing", "--device", uuid, "--restart-device"],
        vec![
            "prepare",
            "missing",
            "--device",
            uuid,
            "--shutdown-device-on-exit",
        ],
        vec!["prepare", "missing", "--device", uuid, "--platform", "ios"],
        vec!["prepare", "missing", "--device", uuid, "--fresh-install"],
        vec!["prepare", "missing", "--device", uuid, "--config", "c.yaml"],
        vec!["prewarm", "missing", "--device", uuid],
        vec!["status", "missing", "--device", uuid],
        vec!["cleanup", "missing", "--device", uuid],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
    }
}

#[test]
fn invalid_native_root_is_a_failed_receipt_with_exit_one_without_input_echo() {
    let fixture = common::temp_repo();
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .env("HOME", &fixture)
        .env(
            "QAREN_NATIVE_CACHE_ROOT",
            "private-override-canary/../cache",
        )
        .args(["prepare", "missing-scenario", "--dry-run", "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["result"], "failed");
    assert_eq!(receipt["failure"]["code"], "PREREQ_MISSING");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("private-override-canary"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("private-override-canary"));
    assert_eq!(receipt["commands_executed"], 0);
}

#[test]
fn non_utf8_native_root_fails_before_publication_or_run_record_serialization() {
    use std::os::unix::ffi::OsStringExt;
    let fixture = common::temp_repo();
    let root = fixture.join(std::ffi::OsString::from_vec(
        b"private-canary-\xff".to_vec(),
    ));
    for args in [
        vec!["prepare", "missing-scenario", "--dry-run", "--json"],
        vec!["prepare", "missing-scenario", "--json"],
        vec!["check", "--plan-file", "missing-plan", "--json"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .env("HOME", &fixture)
            .env("QAREN_NATIVE_CACHE_ROOT", &root)
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["result"], "failed");
        assert_eq!(receipt["failure"]["code"], "PREREQ_MISSING");
        assert!(receipt["failure"]["detail"]
            .as_str()
            .unwrap()
            .contains("path must be valid UTF-8"));
        assert_eq!(receipt["commands_executed"], 0);
        for bytes in [&output.stdout, &output.stderr] {
            let text = String::from_utf8_lossy(bytes);
            assert!(!text.contains("private-canary"));
            assert!(!text.contains("RUN_RECORD_UPDATE_FAILED"));
        }
        assert!(!root.exists());
        assert!(!fixture.join(".qaren").exists());
    }
}

#[test]
fn new_is_prepare_only_and_excludes_an_existing_device() {
    for args in [
        vec![
            "prepare",
            "missing",
            "--new",
            "--device",
            "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
        ],
        vec![
            "prepare",
            "missing",
            "--new",
            "--device",
            "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
            "--boot-device",
        ],
        vec!["check", "--plan-file", "missing", "--new"],
        vec!["cleanup", "missing", "--new"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("--new"), "{stderr}");
        assert!(!stderr.contains("unknown flag"), "{stderr}");
    }
}
