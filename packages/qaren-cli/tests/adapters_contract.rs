mod common;

use qaren::adapters::{android, ios, metro};
use qaren::exec::CmdOutput;
use std::path::Path;

#[test]
fn app_inventory_conversion_is_private_stdin_only_and_uses_exact_bundle_lookup() {
    let plist = include_str!("fixtures/installed-apps.plist");
    let converted = r#"{"com.rndevagent.testapp":{"CFBundleIdentifier":"com.rndevagent.testapp","Path":"/private/fixture/Applications/Test.app"},"com.private.unrelated":{"CFBundleIdentifier":"com.private.unrelated","DataContainer":"file:///private/fixture/Data/OTHER"}}"#;
    for (app, expected) in [
        ("com.rndevagent.testapp", ios::AppPresence::Installed),
        ("com.rndevagent", ios::AppPresence::ProvenAbsent),
    ] {
        let mut mock = qaren::exec::MockRunner::new();
        mock.expect_run(
            "xcrun simctl listapps selected-udid",
            CmdOutput::success(plist),
        );
        mock.expect_run("plutil -convert json -o - -", CmdOutput::success(converted));
        assert_eq!(
            ios::probe_app_presence(&mut mock, "selected-udid", app),
            expected
        );
        assert_eq!(
            mock.private_inputs,
            [Vec::<u8>::new(), plist.as_bytes().to_vec()]
        );
        assert_eq!(mock.calls[0].args, ["simctl", "listapps", "selected-udid"]);
        assert_eq!(mock.calls[1].args, ["-convert", "json", "-o", "-", "-"]);
        assert_eq!(mock.calls[1].timeout_seconds, 10);
        assert!(mock.spawned_logs.is_empty());
        assert!(!serde_json::to_string(&mock.calls)
            .unwrap()
            .contains("com.private.unrelated"));
    }
}

// Captured verbatim from `ssh nuc '~/bin/android-farm status'` on 2026-08-12.
const FARM_STATUS: &str = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\nslot=2 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5557 lease=free state=down\n";

#[test]
fn farm_status_parses_recorded_output() {
    let slot = android::parse_slot_status(FARM_STATUS, 1).unwrap();
    assert_eq!(slot.avd, "Pixel_10a");
    assert_eq!(slot.serial, "emulator-5554");
    assert_eq!(slot.adb_port, 5555);
    assert_eq!(slot.lease, "free");
    assert_eq!(slot.state, "down");
    let slot2 = android::parse_slot_status(FARM_STATUS, 2).unwrap();
    assert_eq!(slot2.adb_port, 5557);
    assert!(android::parse_slot_status(FARM_STATUS, 3).is_none());
}

#[test]
fn farm_status_parses_leased_slot_with_flattened_leasefile() {
    let leased = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-nuc-android-20260812T160000Z claimed_at=2026-08-12T16:00:00Z avd=Pixel_10a serial=emulator-5554 adb_port=5555 state=device\n";
    let slot = android::parse_slot_status(leased, 1).unwrap();
    assert_eq!(
        android::lease_holder_token(&slot.lease),
        "qaren-nuc-android-20260812T160000Z"
    );
    assert_eq!(slot.state, "device");
}

#[test]
fn farm_status_fields_come_from_the_authoritative_prefix_not_lease_noise() {
    // Everything after lease= is flattened lease-file content; the parser must
    // take the first occurrence of each field (the farm-emitted prefix).
    let adversarial = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=evil avd=Fake serial=usb-PHONE adb_port=9999 state=device\n";
    let slot = android::parse_slot_status(adversarial, 1).unwrap();
    assert_eq!(slot.avd, "Pixel_10a");
    assert_eq!(slot.serial, "emulator-5554");
    assert_eq!(slot.adb_port, 5555);
    assert_eq!(android::lease_holder_token(&slot.lease), "evil");
}

#[test]
fn farm_status_rejects_malformed_lines() {
    assert!(android::parse_slot_status(
        "slot=1 avd= serial=emulator-5554 adb_port=5555 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=usb-SERIAL adb_port=5555 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=emulator-5554 adb_port=0 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=emulator-5554 adb_port=5555 lease=free",
        1
    )
    .is_none());
}

#[test]
fn farm_start_output_parses() {
    let started = android::parse_started(
        "started slot=1 serial=emulator-5554 adb_port=5555 lease=qaren-x\nmac_tunnel: ssh -N ...\n",
        1,
    )
    .unwrap();
    assert_eq!(started.serial, "emulator-5554");
    assert_eq!(started.adb_port, 5555);
    assert_eq!(started.lease, "qaren-x");
    assert!(android::parse_started("error: slot 1 already leased by: someone", 1).is_none());
    assert!(
        android::parse_started("started slot=1 serial=usb-PHONE adb_port=5555 lease=x", 1)
            .is_none()
    );
    assert!(
        android::parse_started("started slot=1 serial=emulator-5554 adb_port=0 lease=x", 1)
            .is_none()
    );
    assert!(android::parse_started(
        "started slot=2 serial=emulator-5556 adb_port=5557 lease=x",
        1
    )
    .is_none());
    assert!(android::parse_started("started slot=1 serial= adb_port=5555 lease=x", 1).is_none());
}

#[test]
fn farm_commands_are_exact() {
    let status = android::farm_status_spec("nuc", "bin/android-farm");
    assert_eq!(status.program, "ssh");
    assert_eq!(
        status.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "status"
        ]
    );
    let start = android::farm_start_spec("nuc", "bin/android-farm", 1, "qaren-run", 420);
    assert_eq!(
        start.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "start",
            "1",
            "qaren-run"
        ]
    );
    assert_eq!(start.timeout_seconds, 480);
    let stop = android::farm_stop_spec("nuc", "bin/android-farm", 2);
    assert_eq!(
        stop.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "stop",
            "2"
        ]
    );
}

#[test]
fn tunnel_binds_loopback_only() {
    let tunnel = android::tunnel_spec("nuc", 5555);
    assert!(tunnel
        .args
        .contains(&"127.0.0.1:5555:127.0.0.1:5555".to_string()));
    assert!(tunnel
        .args
        .contains(&"ExitOnForwardFailure=yes".to_string()));
    assert!(tunnel.args.contains(&"-N".to_string()));
}

#[test]
fn adb_commands_pin_the_serial_and_private_server() {
    let adb = Path::new("/sdk/platform-tools/adb");
    for spec in [
        android::adb_get_state_spec(adb, 15037, "127.0.0.1:5555"),
        android::pm_path_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp"),
        android::pidof_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp"),
    ] {
        assert_eq!(spec.args[0], "-s", "{} must pin -s", spec.label);
        assert_eq!(spec.args[1], "127.0.0.1:5555");
        assert!(
            spec.env.contains(&(
                "ADB_SERVER_SOCKET".to_string(),
                "tcp:127.0.0.1:15037".to_string()
            )),
            "{} must address the private adb server",
            spec.label
        );
    }
    for spec in [
        android::adb_connect_spec(adb, 15037, "127.0.0.1:5555"),
        android::adb_disconnect_spec(adb, 15037, "127.0.0.1:5555"),
    ] {
        assert_eq!(spec.args[1], "127.0.0.1:5555");
        assert!(spec.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15037".to_string()
        )));
    }
}

#[test]
fn private_adb_server_binds_loopback_with_vendor_key() {
    let adb = Path::new("/sdk/platform-tools/adb");
    let spec = android::adb_server_spec(
        adb,
        15037,
        "127.0.0.1:5555",
        Path::new("/runs/x/nuc-adbkey"),
    );
    assert_eq!(
        spec.args,
        vec![
            "--one-device",
            "127.0.0.1:5555",
            "-L",
            "tcp:15037",
            "server",
            "nodaemon"
        ]
    );
    assert!(spec.env.contains(&(
        "ADB_VENDOR_KEYS".to_string(),
        "/runs/x/nuc-adbkey".to_string()
    )));
}

#[test]
fn tunneled_serial_allowlist() {
    assert!(android::is_tunneled_serial("127.0.0.1:5555"));
    assert!(!android::is_tunneled_serial("emulator-5554"));
    assert!(!android::is_tunneled_serial("R58M12ABCDE"));
    assert!(!android::is_tunneled_serial("127.0.0.1:0"));
    assert!(!android::is_tunneled_serial("192.168.1.4:5555"));
}

#[test]
fn android_build_command_pins_device_port_and_serial_env() {
    let spec = android::build_spec(
        Path::new("/repo/test-app"),
        "127.0.0.1:5555",
        15037,
        8792,
        2400,
    );
    assert_eq!(spec.program, "pnpm");
    assert_eq!(
        spec.args,
        vec!["exec", "expo", "run:android", "--port", "8792"]
    );
    assert!(spec
        .env
        .contains(&("ANDROID_SERIAL".to_string(), "127.0.0.1:5555".to_string())));
    assert!(spec.env.contains(&(
        "ADB_SERVER_SOCKET".to_string(),
        "tcp:127.0.0.1:15037".to_string()
    )));
    assert!(spec.env.contains(&("CI".to_string(), "1".to_string())));
    assert_eq!(spec.cwd.as_deref(), Some(Path::new("/repo/test-app")));
    assert_eq!(spec.timeout_seconds, 2400);
}

#[test]
fn ios_generic_build_capability_is_app_local_bounded_private_and_fail_closed() {
    let repo = common::temp_repo();
    let app = repo.join("test-app");
    let root = app.as_path();
    for output in [
        CmdOutput::success("--no-bundler\n-d, --device [device]\n"),
        CmdOutput::success(&common::IOS_BUILD_HELP.replace("--output", "--output-other")),
        CmdOutput::success(&common::IOS_BUILD_HELP.replace("generic", "selected")),
        CmdOutput::success(&common::IOS_BUILD_HELP.replace("--no-bundler", "--bundler")),
        CmdOutput::failed(127, "PRIVATE_CLI_MISSING"),
        CmdOutput {
            timed_out: true,
            ..CmdOutput::success(common::IOS_BUILD_HELP)
        },
        CmdOutput {
            stderr: "PRIVATE_PROMPT".into(),
            ..CmdOutput::success(common::IOS_BUILD_HELP)
        },
        CmdOutput::success(common::IOS_BUILD_HELP),
    ] {
        let supported =
            output.ok() && output.stderr.is_empty() && output.stdout == common::IOS_BUILD_HELP;
        let mut mock = qaren::exec::MockRunner::new();
        mock.expect_run(
            &format!(
                "{} run:ios --help",
                root.join("node_modules/.bin/expo").display()
            ),
            output,
        );
        let result = ios::require_build(&mut mock, root, None);
        assert_eq!(result.is_ok(), supported);
        if let Err(failure) = result {
            assert!(failure.code.is_refusal());
            assert_eq!(
                serde_json::to_value(failure.code).unwrap(),
                "IOS_BUILD_CAPABILITY_UNAVAILABLE"
            );
            assert!(!serde_json::to_string(&failure)
                .unwrap()
                .contains("PRIVATE_"));
            assert!(failure.evidence.is_empty());
        }
        assert_eq!(mock.private_inputs, vec![Vec::<u8>::new()]);
        let spec = &mock.calls[0];
        assert_eq!(spec.cwd.as_deref(), Some(root));
        assert_eq!(
            spec.program,
            root.join("node_modules/.bin/expo").to_string_lossy()
        );
        assert_eq!(spec.args, ["run:ios", "--help"]);
        assert_eq!(spec.timeout_seconds, 15);
        for key in ["EXPO_NO_TELEMETRY", "NO_COLOR"] {
            assert!(spec.env.contains(&(key.into(), "1".into())));
        }
        assert_eq!(spec.unset, ["CI"]);
        assert!(!spec.env.iter().any(|(k, _)| k == "CI"));
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        root.join("node_modules/.bin/expo"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    let mut mock = qaren::exec::MockRunner::new();
    assert!(ios::require_build(&mut mock, root, None)
        .unwrap_err()
        .code
        .is_refusal());
    assert!(
        mock.calls.is_empty(),
        "an unusable local CLI must not fall through to PATH"
    );
    std::fs::remove_file(root.join("node_modules/.bin/expo")).unwrap();
    let mut mock = qaren::exec::MockRunner::new();
    assert!(ios::require_build(&mut mock, root, None)
        .unwrap_err()
        .code
        .is_refusal());
    assert!(
        mock.calls.is_empty(),
        "must not fall back to a global Expo CLI"
    );
}

#[test]
fn ios_launch_targets_the_verified_bundle_without_scheme_approval() {
    let spec = ios::launch_spec("EXACT-UDID", "com.x.y", 8791);
    assert_eq!(spec.program, "xcrun");
    assert_eq!(
        spec.args,
        vec![
            "simctl",
            "launch",
            "--terminate-running-process",
            "EXACT-UDID",
            "com.x.y",
            "--initialUrl",
            "http://127.0.0.1:8791/?disableOnboarding=1"
        ]
    );
    assert_eq!(spec.timeout_seconds, 60);
}

#[test]
fn ios_build_command_is_finite_generic_and_writes_only_to_the_run_output() {
    let spec = ios::build_spec(
        Path::new("/repo/test-app"),
        Path::new("/runs/check/ios-build"),
        2400,
        None,
    );
    assert_eq!(
        spec.args,
        vec![
            "exec",
            "expo",
            "run:ios",
            "--device",
            "generic",
            "--no-bundler",
            "--output",
            "/runs/check/ios-build"
        ]
    );
    assert_eq!(spec.unset, ["CI"]);
    assert!(!spec.env.iter().any(|(k, _)| k == "CI"));
    assert_eq!(spec.timeout_seconds, 2400);
}

#[test]
fn explicit_ios_workspace_build_is_finite_generic_and_preserves_literal_names() {
    let workspace = qaren::scenario::IosWorkspaceBuild {
        workspace: "ios/Native Projects/Unrelated App.xcworkspace".into(),
        scheme: "Arbitrary App (Debug)".into(),
    };
    let spec = ios::build_spec(
        Path::new("/repo/My Project"),
        Path::new("/runs/check one/ios-build"),
        1234,
        Some(&workspace),
    );
    assert_eq!(spec.program, "xcrun");
    assert_eq!(
        spec.args,
        [
            "xcodebuild",
            "-workspace",
            "/repo/My Project/ios/Native Projects/Unrelated App.xcworkspace",
            "-scheme",
            "Arbitrary App (Debug)",
            "-configuration",
            "Debug",
            "-sdk",
            "iphonesimulator",
            "-destination",
            "generic/platform=iOS Simulator",
            "-derivedDataPath",
            "/runs/check one/ios-derived-data",
            "CODE_SIGNING_ALLOWED=YES",
            "CODE_SIGNING_REQUIRED=YES",
            "CODE_SIGN_IDENTITY=-",
            "CODE_SIGN_STYLE=Manual",
            "DEVELOPMENT_TEAM=",
            "PROVISIONING_PROFILE_SPECIFIER=",
            "build"
        ]
    );
    assert_eq!(spec.cwd.as_deref(), Some(Path::new("/repo/My Project")));
    assert_eq!(spec.timeout_seconds, 1234);
    assert_eq!(
        spec.env,
        [
            ("EXPO_NO_TELEMETRY".into(), "1".into()),
            ("RCT_NO_LAUNCH_PACKAGER".into(), "1".into()),
        ]
    );
    assert_eq!(spec.unset, ["CI"]);
}

#[test]
fn explicit_workspace_admission_and_revalidation_refuse_non_plain_paths_without_probes() {
    use std::os::unix::fs::symlink;
    for case in [
        "missing-root",
        "root-symlink",
        "missing-ios",
        "ios-file",
        "ios-symlink",
        "ancestor-file",
        "ancestor-symlink",
        "missing-workspace",
        "workspace-file",
        "workspace-symlink",
        "missing-data",
        "data-directory",
        "data-symlink",
        "data-dangling",
    ] {
        let repo = common::temp_repo();
        let mut root = repo.join("test-app");
        let spec = qaren::scenario::IosWorkspaceBuild {
            workspace: "ios/PRIVATE_NESTED/PRIVATE_APP.xcworkspace".into(),
            scheme: "PRIVATE_SCHEME".into(),
        };
        let workspace = root.join(&spec.workspace);
        let data = workspace.join("contents.xcworkspacedata");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&data, "PRIVATE_OPAQUE_CONTENT").unwrap();
        let mut runner = qaren::exec::MockRunner::new();
        ios::require_build(&mut runner, &root, Some(&spec)).unwrap();
        match case {
            "missing-root" => std::fs::remove_dir_all(&root).unwrap(),
            "root-symlink" => {
                let alias = repo.join("PRIVATE_ROOT");
                symlink(&root, &alias).unwrap();
                root = alias;
            }
            "missing-ios" | "ios-file" | "ios-symlink" => {
                let path = root.join("ios");
                let saved = repo.join("PRIVATE_SAVED_IOS");
                std::fs::rename(&path, &saved).unwrap();
                if case == "ios-file" {
                    std::fs::write(&path, "file").unwrap();
                }
                if case == "ios-symlink" {
                    symlink(&saved, &path).unwrap();
                }
            }
            "ancestor-file" | "ancestor-symlink" => {
                let path = workspace.parent().unwrap();
                let saved = repo.join("PRIVATE_SAVED_ANCESTOR");
                std::fs::rename(path, &saved).unwrap();
                if case == "ancestor-file" {
                    std::fs::write(path, "file").unwrap();
                } else {
                    symlink(&saved, path).unwrap();
                }
            }
            "missing-workspace" | "workspace-file" | "workspace-symlink" => {
                let saved = repo.join("PRIVATE_SAVED_WORKSPACE");
                std::fs::rename(&workspace, &saved).unwrap();
                if case == "workspace-file" {
                    std::fs::write(&workspace, "file").unwrap();
                }
                if case == "workspace-symlink" {
                    symlink(&saved, &workspace).unwrap();
                }
            }
            "missing-data" | "data-directory" | "data-symlink" | "data-dangling" => {
                let saved = repo.join("PRIVATE_SAVED_DATA");
                std::fs::rename(&data, &saved).unwrap();
                match case {
                    "data-directory" => std::fs::create_dir(&data).unwrap(),
                    "data-symlink" => symlink(&saved, &data).unwrap(),
                    "data-dangling" => symlink(repo.join("PRIVATE_ABSENT"), &data).unwrap(),
                    _ => {}
                }
            }
            _ => unreachable!(),
        }
        for result in [
            ios::validate_workspace(&root, &spec),
            ios::require_build(&mut runner, &root, Some(&spec)),
        ] {
            let failure = result.expect_err(case);
            assert_eq!(
                failure.code,
                qaren::failure::FailureCode::IosBuildCapabilityUnavailable
            );
            assert!(failure.evidence.is_empty());
            let public = serde_json::to_string(&failure).unwrap();
            assert!(!public.contains("PRIVATE_"), "{case}: {public}");
            assert!(!public.contains(&root.to_string_lossy().to_string()));
        }
        assert!(runner.calls.is_empty(), "{case}");
        assert!(runner.private_inputs.is_empty(), "{case}");
    }
}

#[test]
fn explicit_workspace_admission_refuses_lexical_escape_even_when_target_exists() {
    let repo = common::temp_repo();
    let root = repo.join("test-app");
    std::fs::create_dir_all(root.join("ios")).unwrap();
    let outside = root.join("PRIVATE_OUTSIDE.xcworkspace");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("contents.xcworkspacedata"), "opaque").unwrap();
    for workspace in [
        "ios/../PRIVATE_OUTSIDE.xcworkspace".to_string(),
        outside.to_string_lossy().to_string(),
    ] {
        let spec = qaren::scenario::IosWorkspaceBuild {
            workspace,
            scheme: "App".into(),
        };
        let failure = ios::validate_workspace(&root, &spec).unwrap_err();
        assert_eq!(
            failure.code,
            qaren::failure::FailureCode::IosBuildCapabilityUnavailable
        );
        assert!(!serde_json::to_string(&failure)
            .unwrap()
            .contains("PRIVATE_"));
    }
}

#[test]
fn ios_output_accepts_one_direct_app_with_extra_build_products() {
    let repo = common::temp_repo();
    let output = repo.join("ios-build");
    let app = output.join("Arbitrary App Name.app");
    common::write_ios_app(&app);
    for product in [
        "Pods.framework",
        "Resources.bundle",
        "Arbitrary App Name.app.dSYM",
        "Nested/Other.app",
    ] {
        std::fs::create_dir_all(output.join(product)).unwrap();
    }
    std::fs::write(output.join("libPods.a"), "library").unwrap();
    assert_eq!(ios::built_app(&output).unwrap(), app);
    assert!(output.join("Pods.framework").is_dir());
}

#[test]
fn ios_output_cannot_be_redirected_to_an_ambient_build() {
    let repo = common::temp_repo();
    let ambient = repo.join("ambient");
    common::write_ios_app(&ambient.join("testapp.app"));
    let output = repo.join("ios-build");
    std::os::unix::fs::symlink(&ambient, &output).unwrap();
    assert!(ios::built_app(&output).is_err());
}

#[test]
fn ios_artifact_requires_a_built_initial_url_launcher_not_just_a_successful_build() {
    let repo = common::temp_repo();
    let app = repo.join("test.app");
    common::write_ios_app(&app);
    let mut mock = qaren::exec::MockRunner::new();
    mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
    mock.expect_run("vtool", CmdOutput::success("platform IOSSIMULATOR\n"));
    mock.expect_run("otool -L", CmdOutput::success("test.app/binary:\n"));
    mock.expect_run("nm", CmdOutput::success("_main\n"));
    assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_launcher_verification_checks_the_linked_image_and_argument_and_refuses_local_js() {
    for debug in [false, true] {
        for output in [
            CmdOutput::success("0000000100012345  --initialUrl\n"),
            CmdOutput::success("0000000100012345  --initialUrlUnsupported\n"),
            CmdOutput::failed(1, "PRIVATE_BINARY_CONTENT"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("0000000100012345  --initialUrl\n")
            },
        ] {
            let supported = output.ok() && output.stdout == "0000000100012345  --initialUrl\n";
            let repo = common::temp_repo();
            let app = repo.join("test.app");
            common::write_ios_app(&app);
            std::fs::write(app.join("binary.debug.dylib"), "debug image").unwrap();
            let image = app.join(if debug {
                "binary.debug.dylib"
            } else {
                "binary"
            });
            let mut mock = qaren::exec::MockRunner::new();
            mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
            mock.expect_run("vtool", CmdOutput::success("platform IOSSIMULATOR\n"));
            mock.expect_run("otool -L", CmdOutput::success(if debug {
                "test.app/binary:\n  @rpath/binary.debug.dylib (compatibility version 0.0.0, current version 0.0.0)\n"
            } else { "test.app/binary:\n" }));
            mock.expect_run("nm", CmdOutput::success(common::IOS_LAUNCHER_SYMBOLS));
            mock.expect_run("otool -v -s __TEXT __cstring", output);
            let result = ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest");
            assert_eq!(result.is_ok(), supported);
            assert!(!format!("{result:?}").contains("PRIVATE_BINARY_CONTENT"));
            for spec in &mock.calls[3..] {
                assert_eq!(spec.args.last().unwrap(), &image.to_string_lossy());
                assert_eq!(spec.program, "/bin/bash");
                assert!(spec.args.iter().any(|a| a.contains("| grep ")));
            }
            assert_eq!(mock.private_inputs.len(), 5);
            assert_eq!(mock.remaining(), 0);
        }
    }
    let repo = common::temp_repo();
    let app = repo.join("test.app");
    common::write_ios_app(&app);
    std::fs::write(app.join("main.jsbundle"), "bundled JS bypasses initialUrl").unwrap();
    let mut mock = qaren::exec::MockRunner::new();
    mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
    mock.expect_run("vtool", CmdOutput::success("platform IOSSIMULATOR\n"));
    assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_launcher_verification_accepts_a_linked_debug_image_with_spaces_in_its_name() {
    let repo = common::temp_repo();
    let app = repo.join("My App.app");
    common::write_ios_app(&app);
    std::fs::rename(app.join("binary"), app.join("My App")).unwrap();
    let image = app.join("My App.debug.dylib");
    std::fs::write(&image, "debug image").unwrap();
    let mut info: serde_json::Value = serde_json::from_str(&common::ios_app_info()).unwrap();
    info["CFBundleExecutable"] = "My App".into();
    std::fs::write(app.join("Info.plist"), info.to_string()).unwrap();
    let mut mock = qaren::exec::MockRunner::new();
    mock.expect_run("plutil", CmdOutput::success(&info.to_string()));
    mock.expect_run("vtool", CmdOutput::success("platform IOSSIMULATOR\n"));
    mock.expect_run(
        "otool -L",
        CmdOutput::success("My App.app/My App:\n\t@rpath/My App.debug.dylib (compatibility version 0.0.0, current version 0.0.0)\n"),
    );
    mock.expect_run(
        &format!(
            "grep -F EXDevLauncherController qaren-probe {}",
            image.display()
        ),
        CmdOutput::success(common::IOS_LAUNCHER_SYMBOLS),
    );
    mock.expect_run(
        &format!("--initialUrl$' qaren-probe {}", image.display()),
        CmdOutput::success("0000000100012345  --initialUrl\n"),
    );

    assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_ok());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_output_requires_exactly_one_app_and_a_usable_matching_simulator_bundle() {
    use qaren::exec::MockRunner;
    use std::os::unix::fs::PermissionsExt;
    let repo = common::temp_repo();
    let output = repo.join("ios-build");
    assert!(ios::built_app(&output).is_err());
    std::fs::create_dir(&output).unwrap();
    assert!(ios::built_app(&output).is_err());
    let app = output.join("one.app");
    common::write_ios_app(&app);
    common::write_ios_app(&output.join("two.app"));
    assert!(ios::built_app(&output).is_err());
    std::fs::remove_dir_all(output.join("two.app")).unwrap();
    assert_eq!(ios::built_app(&output).unwrap(), app);

    for (field, value) in [
        ("CFBundleIdentifier", serde_json::json!("com.other.app")),
        ("CFBundlePackageType", serde_json::json!("FMWK")),
        (
            "CFBundleSupportedPlatforms",
            serde_json::json!(["iPhoneOS"]),
        ),
        ("CFBundleURLTypes", serde_json::json!([])),
        ("CFBundleExecutable", serde_json::json!("../outside")),
        ("CFBundleExecutable", serde_json::json!("missing")),
    ] {
        let mut info: serde_json::Value = serde_json::from_str(&common::ios_app_info()).unwrap();
        info[field] = value;
        let mut mock = MockRunner::new();
        mock.expect_run("plutil", CmdOutput::success(&info.to_string()));
        assert!(
            ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err(),
            "{field}"
        );
        assert_eq!(mock.remaining(), 0);
    }
    for output in [
        CmdOutput::failed(1, "bad plist"),
        CmdOutput::success("{}"),
        CmdOutput::success("not json"),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run("plutil", output);
        assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err());
    }
    for output in [
        CmdOutput::failed(1, "not Mach-O"),
        CmdOutput::success("platform IOS\n"),
        CmdOutput::success("platform IOSSIMULATOR\nplatform IOS\n"),
        CmdOutput::success(""),
    ] {
        let mut mock = MockRunner::new();
        mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
        mock.expect_run("vtool", output);
        assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err());
    }
    std::fs::set_permissions(app.join("binary"), std::fs::Permissions::from_mode(0o644)).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("plutil", CmdOutput::success(&common::ios_app_info()));
    assert!(ios::verify_app(&mut mock, &app, "com.rndevagent.testapp", "rndatest").is_err());
    std::os::unix::fs::symlink("/outside", app.join("escape")).unwrap();
    assert!(ios::verify_app(
        &mut MockRunner::new(),
        &app,
        "com.rndevagent.testapp",
        "rndatest"
    )
    .is_err());
}

#[test]
fn ios_sim_lifecycle_commands_are_exact() {
    assert_eq!(
        ios::create_spec("qaren-run1", "devtype", "runtime").args,
        vec!["simctl", "create", "qaren-run1", "devtype", "runtime"]
    );
    let bootstatus = ios::bootstatus_spec("UDID", 420);
    assert_eq!(bootstatus.args, vec!["simctl", "bootstatus", "UDID", "-b"]);
    assert_eq!(bootstatus.timeout_seconds, 420);
    assert_eq!(
        ios::shutdown_spec("UDID").args,
        vec!["simctl", "shutdown", "UDID"]
    );
    assert_eq!(
        ios::delete_spec("UDID").args,
        vec!["simctl", "delete", "UDID"]
    );
    assert_eq!(
        ios::app_container_spec("UDID", "com.x.y").args,
        vec!["simctl", "get_app_container", "UDID", "com.x.y", "app"]
    );
}

#[test]
fn sim_presence_parses_simctl_json() {
    let json = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
        {"udid":"AAAA","name":"qaren-run1","state":"Booted"},
        {"udid":"BBBB","name":"other","state":"Shutdown"}]}}"#;
    assert_eq!(
        ios::parse_sim_presence(json, "AAAA"),
        ios::SimPresence::Present {
            name: "qaren-run1".to_string(),
            state: "Booted".to_string()
        }
    );
    assert_eq!(
        ios::parse_sim_presence(json, "CCCC"),
        ios::SimPresence::Absent
    );
    assert_eq!(
        ios::parse_sim_presence("not json", "AAAA"),
        ios::SimPresence::Unparseable
    );
    let missing_name = r#"{"devices":{"rt":[{"udid":"AAAA","state":"Booted"}]}}"#;
    assert_eq!(
        ios::parse_sim_presence(missing_name, "AAAA"),
        ios::SimPresence::Unparseable
    );
}

#[test]
fn selected_ios_simulator_requires_unique_canonical_available_stable_metadata() {
    let udid = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
    let device_type = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    let sim = serde_json::json!({"udid":udid,"name":"selected","state":"Shutdown",
        "isAvailable":true,"deviceTypeIdentifier":device_type});
    let inventory = |rt: &str, entries: Vec<serde_json::Value>| {
        serde_json::json!({"devices":{rt:entries}}).to_string()
    };
    for (state, expected) in [
        ("Shutdown", ios::SimState::Shutdown),
        ("Booted", ios::SimState::Booted),
    ] {
        let mut entry = sim.clone();
        entry["state"] = state.into();
        let selected =
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), &udid.to_lowercase())
                .unwrap();
        assert_eq!(selected.udid, udid);
        assert_eq!(selected.name, "selected");
        assert_eq!(selected.device_type, device_type);
        assert_eq!(selected.runtime, runtime);
        assert_eq!(selected.state, expected);
    }
    for (field, value) in [
        ("udid", serde_json::json!(udid.to_lowercase())),
        ("udid", serde_json::json!("not-a-uuid")),
        (
            "udid",
            serde_json::json!("76709EFC-0104-4A66-8908-F4F85A76F025"),
        ),
        ("name", serde_json::json!("")),
        ("name", serde_json::json!("   ")),
        ("deviceTypeIdentifier", serde_json::json!("")),
        ("deviceTypeIdentifier", serde_json::json!(42)),
        ("isAvailable", serde_json::json!(false)),
        ("isAvailable", serde_json::json!("true")),
        ("state", serde_json::json!("Booting")),
        ("state", serde_json::json!("Shutting Down")),
        ("state", serde_json::json!("Unknown")),
    ] {
        let mut entry = sim.clone();
        entry[field] = value;
        assert!(
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), udid).is_none(),
            "{field}"
        );
    }
    for field in [
        "udid",
        "name",
        "state",
        "isAvailable",
        "deviceTypeIdentifier",
    ] {
        let mut entry = sim.clone();
        entry.as_object_mut().unwrap().remove(field);
        assert!(
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), udid).is_none(),
            "missing {field}"
        );
    }
    let mut lowercase = sim.clone();
    lowercase["udid"] = udid.to_lowercase().into();
    for json in [
        "not json".into(), "{}".into(), r#"{"devices":[]}"#.into(),
        r#"{"devices":{"bad":{}}}"#.into(),
        inventory(runtime, vec![]),
        inventory(runtime, vec![sim.clone(), sim.clone()]),
        inventory(runtime, vec![sim.clone(), lowercase]),
        inventory("", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.iOS-", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.watchOS-26-5", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.tvOS-26-5", vec![sim.clone()]),
        serde_json::json!({"devices":{runtime:[sim.clone()], "com.apple.CoreSimulator.SimRuntime.watchOS-26-5":[sim.clone()]}}).to_string(),
    ] {
        assert!(ios::parse_selected_sim(&json, udid).is_none(), "{json}");
    }
    for invalid in [
        "",
        "booted",
        "selected",
        "1DC408C451DA4C4FACA139881C916FDD",
        "1DC408C4-51DA-4C4F-ACA1-39881C916FDG",
    ] {
        assert!(ios::parse_selected_sim(&inventory(runtime, vec![sim.clone()]), invalid).is_none());
    }
}

#[test]
fn launchctl_parsing_requires_live_pid_and_exact_label() {
    let running = "512\t0\tUIKitApplication:com.rndevagent.testapp[a1b2][rb-legacy]";
    assert!(ios::app_running_in_launchctl(
        running,
        "com.rndevagent.testapp"
    ));
    let dead = "-\t0\tUIKitApplication:com.rndevagent.testapp[a1b2][rb-legacy]";
    assert!(!ios::app_running_in_launchctl(
        dead,
        "com.rndevagent.testapp"
    ));
    let other_app = "512\t0\tUIKitApplication:com.rndevagent.testapp.other[a1b2]";
    assert!(!ios::app_running_in_launchctl(
        other_app,
        "com.rndevagent.testapp"
    ));
}

#[test]
fn runner_host_inventory_is_bounded_complete_and_tri_state() {
    use ios::RunnerHostPresence::{Absent, Present, Unknown};
    let app = "dev.lykhoyda.rndevagent.fastrunner";
    let test = format!("{app}.uitests.xctrunner");
    for (rows, expected) in [
        ("1 0 com.apple.SpringBoard\n".into(), Absent),
        (
            format!("42 0 UIKitApplication:{app}[abc][rb-legacy]\n"),
            Present,
        ),
        (format!("43 0 UIKitApplication:{test}[abc]\n"), Present),
        (
            format!("- -9 UIKitApplication:{app}[abc]\n- 0 UIKitApplication:{test}[def]\n"),
            Absent,
        ),
        (
            format!(
                "42 0 UIKitApplication:{app}.other[abc]\n43 0 UIKitApplication:other.{app}[def]\n"
            ),
            Absent,
        ),
        (format!("42 0 {test}\n"), Present),
        (
            format!("42 0 UIKitApplication:{app}[abc]\nbroken\n"),
            Unknown,
        ),
        (format!("42 0 UIKitApplication:{app}\n"), Unknown),
        (format!("42 0 UIKitApplication:{app}[abc\n"), Unknown),
        (format!("42 0 UIKitApplication:{app}[]\n"), Unknown),
        (format!("42 0 UIKitApplication:{app}[abc]junk\n"), Unknown),
        ("".into(), Unknown),
        ("1 0 com.apple.SpringBoard".into(), Unknown),
        ("1 0 com.apple.SpringBoard\n\n".into(), Unknown),
        (
            "1 0 com.apple.SpringBoard\n1 0 com.apple.SpringBoard\n".into(),
            Unknown,
        ),
        ("1 0\n".into(), Unknown),
        ("1 0 com.apple.SpringBoard extra\n".into(), Unknown),
        ("-1 0 com.apple.SpringBoard\n".into(), Unknown),
        ("0 0 com.apple.SpringBoard\n".into(), Unknown),
        ("+1 0 com.apple.SpringBoard\n".into(), Unknown),
        ("1 status com.apple.SpringBoard\n".into(), Unknown),
        ("1 0 com.apple.\0SpringBoard\n".into(), Unknown),
        ("1 0 com.apple.\u{fffd}SpringBoard\n".into(), Unknown),
        ("1 0 com.apple.SpringBoard\r\n".into(), Unknown),
        (format!("1 0 {}\n", "x".repeat(1024 * 1024)), Unknown),
        (
            (1..=16_385)
                .map(|i| format!("{i} 0 service.{i}\n"))
                .collect(),
            Unknown,
        ),
    ] {
        assert_eq!(
            ios::parse_runner_hosts(&format!("PID\tStatus\tLabel\n{rows}")),
            expected,
            "rows: {:?}",
            &rows[..rows.len().min(150)]
        );
    }
    for raw in [
        "",
        "1 0 com.apple.SpringBoard\n",
        "pid status label\n1 0 com.apple.SpringBoard\n",
    ] {
        assert_eq!(ios::parse_runner_hosts(raw), Unknown);
    }
    let prefix = "PID Status Label\n1 0 ";
    let at_capture_boundary = format!("{prefix}{}\n", "x".repeat(1024 * 1024 - prefix.len() - 1));
    assert_eq!(ios::parse_runner_hosts(&at_capture_boundary), Unknown);
}

#[test]
fn runner_host_probe_requires_exact_inventory_and_clean_scoped_output() {
    use ios::RunnerHostPresence::{Absent, Unknown};
    let udid = "AAAABBBB-1111-2222-3333-444455556666";
    let sim = serde_json::json!({"udid":udid,"state":"Booted","isAvailable":true,
        "name":"selected","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"});
    let inventory = |sims: Vec<serde_json::Value>| {
        serde_json::json!({"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-26-4":sims
        }})
        .to_string()
    };
    let mut shutdown = sim.clone();
    shutdown["state"] = "Shutdown".into();
    let mut other = sim.clone();
    other["udid"] = "BBBBBBBB-1111-2222-3333-444455556666".into();
    for (raw, expected) in [
        (inventory(vec![shutdown.clone(), other.clone()]), Absent),
        (inventory(vec![other]), Unknown),
        (inventory(vec![shutdown.clone(), shutdown]), Unknown),
        (
            inventory(vec![sim.clone()]).replace("Booted", "Booting"),
            Unknown,
        ),
        (
            inventory(vec![sim.clone()]).replace("true", "false"),
            Unknown,
        ),
        (
            inventory(vec![sim.clone()]).replace("iOS-26-4", "tvOS-26-4"),
            Unknown,
        ),
        (
            inventory(vec![sim.clone()]).replace(udid, &udid.to_ascii_lowercase()),
            Unknown,
        ),
        ("{\"devices\":{}}".into(), Unknown),
        ("{\"devices\":".into(), Unknown),
    ] {
        let mut mock = qaren::exec::MockRunner::new();
        mock.expect_run("simctl list devices -j", CmdOutput::success(&raw));
        assert_eq!(ios::probe_runner_hosts(&mut mock, udid), expected);
        assert_eq!(mock.remaining(), 0);
        assert_eq!(mock.calls.len(), 1);
    }
    let clear = "PID Status Label\n1 0 com.apple.SpringBoard\n";
    for output in [
        CmdOutput::failed(1, ""),
        CmdOutput {
            timed_out: true,
            ..CmdOutput::success(clear)
        },
        CmdOutput {
            stderr: "warning".into(),
            ..CmdOutput::success(clear)
        },
        CmdOutput {
            exit_code: None,
            ..CmdOutput::success(clear)
        },
    ] {
        let mut mock = qaren::exec::MockRunner::new();
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&inventory(vec![sim.clone()])),
        );
        mock.expect_run(&format!("simctl spawn {udid} launchctl list"), output);
        assert_eq!(ios::probe_runner_hosts(&mut mock, udid), Unknown);
        assert_eq!(mock.remaining(), 0);
    }
    for invalid in ["booted", "", "other", &udid.to_ascii_lowercase()] {
        let mut mock = qaren::exec::MockRunner::new();
        assert_eq!(ios::probe_runner_hosts(&mut mock, invalid), Unknown);
        assert!(mock.calls.is_empty());
    }
}

#[test]
fn port_owner_parsing_is_strict() {
    let free = CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    };
    assert_eq!(metro::parse_port_owner(&free), metro::PortOwners::Free);
    let owned = CmdOutput::success("4242\n");
    assert_eq!(
        metro::parse_port_owner(&owned),
        metro::PortOwners::Owned(4242)
    );
    let multiple = CmdOutput::success("4242\n4243\n");
    assert_eq!(
        metro::parse_port_owner(&multiple),
        metro::PortOwners::Multiple
    );
    let garbled = CmdOutput::success("4242\nnot-a-pid\n");
    assert_eq!(
        metro::parse_port_owner(&garbled),
        metro::PortOwners::Unknown
    );
    let error_exit = CmdOutput::failed(2, "lsof: bad flag");
    assert_eq!(
        metro::parse_port_owner(&error_exit),
        metro::PortOwners::Unknown
    );
    let exit1_with_stderr = CmdOutput {
        exit_code: Some(1),
        stderr: "warning".to_string(),
        ..Default::default()
    };
    assert_eq!(
        metro::parse_port_owner(&exit1_with_stderr),
        metro::PortOwners::Unknown
    );
    let timed_out = CmdOutput {
        timed_out: true,
        ..Default::default()
    };
    assert_eq!(
        metro::parse_port_owner(&timed_out),
        metro::PortOwners::Unknown
    );
}

#[test]
fn holder_and_sim_name_derive_from_run_id() {
    assert_eq!(
        android::holder("nuc-android-20260812T160000Z"),
        "qaren-nuc-android-20260812T160000Z"
    );
    assert_eq!(
        ios::sim_name("ios-simulator-20260812T160000Z"),
        "qaren-ios-simulator-20260812T160000Z"
    );
}

#[test]
fn app_removal_commands_are_exact_and_routed_through_the_private_server() {
    let adb = Path::new("/sdk/platform-tools/adb");
    let private = (
        "ADB_SERVER_SOCKET".to_string(),
        "tcp:127.0.0.1:15037".to_string(),
    );
    let apk = "/data/app/~~AbC==/com.rndevagent.testapp-XyZ==/base.apk";

    let list =
        android::pm_list_packages_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp");
    assert_eq!(list.label, "adb-pm-list-packages");
    assert_eq!(list.program, "/sdk/platform-tools/adb");
    assert_eq!(
        list.args,
        vec![
            "-s",
            "127.0.0.1:5555",
            "shell",
            "pm",
            "list",
            "packages",
            "com.rndevagent.testapp"
        ]
    );
    assert_eq!(list.env, vec![private.clone()]);

    let hash = android::sha256sum_spec(adb, 15037, "127.0.0.1:5555", apk);
    assert_eq!(hash.label, "adb-sha256sum");
    assert_eq!(
        hash.args,
        vec!["-s", "127.0.0.1:5555", "shell", "sha256sum", apk]
    );
    assert_eq!(hash.env, vec![private.clone()]);

    let uninstall = android::uninstall_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp");
    assert_eq!(uninstall.label, "adb-uninstall");
    assert_eq!(
        uninstall.args,
        vec![
            "-s",
            "127.0.0.1:5555",
            "uninstall",
            "com.rndevagent.testapp"
        ],
        "no -k: the app's data must go with the package"
    );
    assert_eq!(uninstall.env, vec![private]);
    assert_eq!(uninstall.timeout_seconds, 120);
}

#[test]
fn app_removal_parsers_are_strict() {
    let apk = "/data/app/~~AbC-1==/com.rndevagent.testapp-XyZ_2==/base.apk";
    assert_eq!(
        android::pm_path_packages(&format!("package:{apk}\n")),
        vec![apk.to_string()]
    );
    assert!(android::pm_path_packages("").is_empty());
    assert!(android::pm_path_packages("error: device offline\n").is_empty());

    assert!(android::is_user_base_apk_path(apk));
    assert!(android::is_user_base_apk_path(
        "/data/app/com.foo-1/base.apk"
    ));
    for bad in [
        "/system/priv-app/Foo/base.apk",
        "/data/app/../../system/base.apk",
        "/data/app/x/split_config.arm64_v8a.apk",
        "/data/app/x/base.apk; rm -rf /",
        "/data/app/x/base.apk\n/data/app/y/base.apk",
        "/data/app/x y/base.apk",
        "",
    ] {
        assert!(!android::is_user_base_apk_path(bad), "{bad:?}");
    }

    let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert_eq!(
        android::parse_sha256sum(&format!("{sha}  {apk}\n"), apk).as_deref(),
        Some(sha)
    );
    assert_eq!(
        android::parse_sha256sum(&format!("{}  {apk}\n", sha.to_uppercase()), apk).as_deref(),
        Some(sha),
        "hex case is normalised"
    );
    for bad in [
        format!("{sha}  /data/app/other/base.apk\n"),
        format!("{sha}\n"),
        format!("{}  {apk}\n", &sha[..63]),
        format!("{sha}  {apk}\n{sha}  {apk}\n"),
        format!("{sha}  {apk} trailing\n"),
        "sha256sum: No such file or directory\n".to_string(),
        String::new(),
    ] {
        assert!(android::parse_sha256sum(&bad, apk).is_none(), "{bad:?}");
    }

    assert!(android::package_list_has_exact(
        "package:com.rndevagent.testapp.dev\npackage:com.rndevagent.testapp\n",
        "com.rndevagent.testapp"
    ));
    assert!(!android::package_list_has_exact(
        "package:com.rndevagent.testapp.dev\n",
        "com.rndevagent.testapp"
    ));
    assert!(!android::package_list_has_exact(
        "",
        "com.rndevagent.testapp"
    ));
}

#[test]
fn metro_never_passes_ci_into_app_config_evaluation() {
    let spec = metro::start_spec(Path::new("/repo/app"), 8791);
    assert_eq!(spec.unset, ["CI"]);
    assert!(!spec.env.iter().any(|(k, _)| k == "CI"));
}

#[test]
fn an_unset_variable_wins_over_the_spec_and_the_parent_environment() {
    use qaren::exec::{CmdSpec, RealRunner, Runner};
    let spec = CmdSpec::new("env", "/usr/bin/env", &[], 10)
        .env("CI", "1")
        .env("KEEP", "1")
        .env_remove("CI");
    let output = RealRunner::new().run(&spec);
    assert!(output.ok());
    assert!(output.stdout.lines().any(|l| l == "KEEP=1"));
    assert!(!output.stdout.lines().any(|l| l.starts_with("CI=")));
}

#[test]
fn expo_fingerprint_evaluates_config_in_the_ios_build_environment() {
    let root = Path::new("/repo/app");
    let build = ios::build_spec(root, Path::new("/runs/x/out"), 1800, None);
    let fingerprint =
        qaren::fingerprint::expo_fingerprint_spec("expo-fingerprint", root, &["cli.js"]);
    assert_eq!(fingerprint.program, build.program);
    assert_eq!(fingerprint.args[0], build.args[0]);
    assert_eq!(fingerprint.cwd, build.cwd);
    assert_eq!(fingerprint.unset, build.unset);
    assert_eq!(fingerprint.env, build.env);
    assert_eq!(fingerprint.timeout_seconds, 120);
}

#[test]
fn android_launch_deactivates_the_dev_menu_auto_launch() {
    let spec = android::am_start_deeplink_spec(
        Path::new("/sdk/adb"),
        5038,
        "127.0.0.1:15555",
        "rndatest://expo-development-client/?url=x",
        "com.rndevagent.testapp",
    );
    let args: Vec<&str> = spec.args.iter().map(String::as_str).collect();
    let start = args.iter().position(|a| *a == "start").unwrap();
    assert_eq!(
        &args[start..],
        [
            "start",
            "-a",
            "android.intent.action.VIEW",
            "--ez",
            "EXDevMenuDisableAutoLaunch",
            "true",
            "-d",
            "rndatest://expo-development-client/?url=x",
            "com.rndevagent.testapp",
        ]
    );
}
