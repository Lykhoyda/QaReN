mod common;
use common::{ios_scenario_yaml, IosBuildRunner as MockRunner};

use qaren::commands::prepare::{prepare, PrepareArgs};
use qaren::exec::{CmdOutput, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{Phase, RunRecord};

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";
const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn write_scenario(repo: &std::path::Path, yaml: &str) -> std::path::PathBuf {
    let path = repo.join("scenario.yaml");
    std::fs::write(&path, yaml).unwrap();
    path
}

fn prepare_args(
    scenario_path: &std::path::Path,
    dry_run: bool,
    android_home: Option<String>,
) -> PrepareArgs {
    PrepareArgs {
        scenario_path: scenario_path.to_path_buf(),
        dry_run,
        android_home,
        // Per-test lock root keeps parallel tests from contending on the
        // shared build-serialization lock name.
        lock_root: scenario_path.parent().unwrap().join(".locks"),
        native_cache_root: scenario_path.parent().unwrap().join(".native-store"),
        runs_root: scenario_path.parent().unwrap().to_path_buf(),
        device: None,
        boot_device: false,
        pool_root: scenario_path.parent().unwrap().join(".pool"),
        // iOS tests keep the fresh temporary simulator (--new); pool tests opt out explicitly.
        new_device: std::fs::read_to_string(scenario_path)
            .is_ok_and(|yaml| yaml.contains("platform: ios") && !yaml.contains("owner: qaren")),
    }
}

fn script_validation(mock: &mut MockRunner, repo: &std::path::Path, tools: &[&str]) {
    script_validation_porcelain(mock, repo, tools, "");
}

fn script_validation_porcelain(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    tools: &[&str],
    porcelain: &str,
) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain));
    for tool in tools {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
}

#[test]
fn prepare_checks_the_installed_cli_before_device_allocation() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    qaren::adapters::ios::require_build(&mut mock, &repo.join("test-app"), None).unwrap();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(tool));
    }
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success("--no-bundler\n--device [device]\n"),
    );
    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        serde_json::to_value(receipt.failure.unwrap().code).unwrap(),
        "IOS_BUILD_CAPABILITY_UNAVAILABLE"
    );
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(!record.resources.any_owned());
    assert!(record.build.is_none());
    assert!(!repo.join(".locks").exists());
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.label == "simctl-create" || c.label == "simctl-bootstatus"));
}

const IOS_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];
const ANDROID_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "ssh", "java"];

#[test]
fn dry_run_refuses_unsupported_ios_cli_without_installing_or_allocating() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success("--no-bundler\n--device [device]\n"),
    );

    let receipt = prepare(&mut mock, &prepare_args(&scenario, true, None));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::IosBuildCapabilityUnavailable
    );
    assert_eq!(receipt.run_id, "none");
    assert_eq!(mock.remaining(), 0);
    assert!(!repo.join(".locks").exists());
    assert!(!mock.calls.iter().any(|c| matches!(
        c.label.as_str(),
        "pnpm-install" | "simctl-create" | "simctl-bootstatus"
    )));
}

#[test]
fn missing_launch_scheme_refuses_prepare_before_any_command_or_allocation() {
    let repo = common::temp_repo();
    let path = write_scenario(
        &repo,
        &ios_scenario_yaml(8791).replace("  dev_client_scheme: rndatest\n", ""),
    );
    for dry_run in [false, true] {
        let mut mock = MockRunner::new();
        let receipt = prepare(&mut mock, &prepare_args(&path, dry_run, None));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::DevClientSchemeRequired
        );
        assert!(mock.calls.is_empty());
        assert!(!repo.join(".locks").exists());
    }
}

#[test]
fn invalid_ios_launch_scheme_stops_prepare_without_echoing_input() {
    for scheme in [
        "private://log-payload",
        "private invalid",
        "private\npayload",
        &"a".repeat(129),
    ] {
        let repo = common::temp_repo();
        let yaml = ios_scenario_yaml(8791).replace(
            "dev_client_scheme: rndatest",
            &format!(
                "dev_client_scheme: {}",
                serde_json::to_string(scheme).unwrap()
            ),
        );
        let path = write_scenario(&repo, &yaml);
        let mut mock = MockRunner::new();
        let receipt = prepare(&mut mock, &prepare_args(&path, false, None));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::DevClientSchemeRequired
        );
        assert!(!receipt.to_json().contains("private"));
        assert!(!receipt.to_json().contains(&"a".repeat(129)));
        assert!(mock.calls.is_empty());
        assert!(!repo.join(".locks").exists());
    }
}

#[test]
fn ios_prepare_happy_path_produces_ready_receipt_and_record() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_ios_ready(&mock, &repo, receipt);
    let position = |label: &str| mock.calls.iter().position(|c| c.label == label).unwrap();
    // Metro starts only after the build is published and its lock released.
    assert!(position("expo-run-ios") < position("expo-start"));
    assert!(position("expo-start") < position("simctl-install"));
    assert!(position("simctl-install") < position("metro-status"));
    assert_eq!(
        mock.calls
            .iter()
            .filter(|c| c.label == "expo-start")
            .count(),
        1
    );
}

#[test]
fn ios_prepare_proceeds_after_two_launch_timeouts_with_each_attempt_in_the_receipt() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_launch(&mut mock, &repo, |m| {
        m.expect_run("launchctl list", CmdOutput::success(""));
        m.expect_run("launchctl list", CmdOutput::success(""));
        common::script_ios_launch(m);
    });
    mock.timeouts = [
        ("simctl-launch".into(), 60_000),
        ("simctl-launch".into(), 60_000),
    ]
    .into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-launch_attempt_1"], 60_000);
    assert_eq!(receipt.timings_ms["simctl-launch_attempt_2"], 60_000);
    assert_eq!(receipt.timings_ms["simctl-launch_attempt_3"], 0);
    assert!(mock
        .calls
        .iter()
        .any(|call| call.label == "simctl-launchctl"));
    assert!(!receipt.outcomes.contains_key("launch_proof"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_launch_timeout_with_the_app_job_present_is_accepted_as_the_launch() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_launch(&mut mock, &repo, |m| {
        m.expect_run(
            "launchctl list",
            CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
        );
    });
    mock.timeouts = [("simctl-launch".into(), 60_000)].into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-launch_attempt_1"], 60_000);
    assert!(receipt.outcomes["simctl-launch_attempt_1"].contains("timed out"));
    assert!(!receipt.timings_ms.contains_key("simctl-launch_attempt_2"));
    assert_eq!(receipt.outcomes["launch_proof"], "launchctl-job");
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("simctl-launch"), 1);
    assert_eq!(
        count("simctl-launchctl"),
        3,
        "receipt, readiness, then launch settle"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_launch_timeout_without_the_app_job_is_retried() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_launch(&mut mock, &repo, |m| {
        m.expect_run(
            "launchctl list",
            CmdOutput::success("-\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
        );
        common::script_ios_launch(m);
    });
    mock.timeouts = [("simctl-launch".into(), 60_000)].into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-launch_attempt_2"], 0);
    assert_eq!(
        mock.calls
            .iter()
            .filter(|c| c.label == "simctl-launch")
            .count(),
        2
    );
    assert!(!receipt.outcomes.contains_key("launch_proof"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_launch_error_stays_a_build_failure_without_a_receipt() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_devmenu(&mut mock, &repo);
    common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
    mock.expect_run(
        "simctl launch --terminate-running-process",
        CmdOutput::failed(1, "no such app"),
    );
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed,
        "{}",
        receipt.to_json()
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("simctl-launch"), 1);
    assert_eq!(count("simctl-launchctl"), 0);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_prepare_pins_a_fresh_lane_before_the_dev_menu_defaults_and_launch() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    mock.lane = common::Lane::Fresh;
    script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    let labels: Vec<&str> = mock.calls.iter().map(|c| c.label.as_str()).collect();
    let writes: Vec<usize> = (0..labels.len())
        .filter(|&i| labels[i] == "simctl-lane-defaults")
        .collect();
    assert_eq!(writes.len(), qaren::adapters::ios::lane_defaults().len());
    let devmenu = labels
        .iter()
        .position(|l| *l == "simctl-devmenu-defaults")
        .unwrap();
    assert!(writes.iter().all(|&i| i < devmenu));
    assert_eq!(
        labels.iter().filter(|l| **l == "simctl-lane-read").count(),
        4
    );
    assert!(mock
        .calls
        .iter()
        .filter(|c| c.label.starts_with("simctl-lane"))
        .all(|c| c.args[2] == UDID));
    let lane = receipt.lane.expect("warm-lane record");
    assert_eq!(lane.device_id, UDID);
    assert_eq!(lane.layout, "en_US@sw=QWERTY;hw=Automatic");
    assert_eq!(lane.normalized.len(), writes.len());
    assert_eq!(
        lane.normalized[..3],
        ["AppleLanguages", "AppleLocale", "AppleKeyboards"]
    );
    assert_eq!(lane.first_screen, None);
    assert!(receipt.outcomes["lane"].contains("value(s) normalized"));
}

#[test]
fn ios_prepare_leaves_a_pinned_lane_unwritten() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("simctl-lane-read"), 2);
    assert_eq!(count("simctl-lane-defaults"), 0);
    assert!(receipt
        .lane
        .expect("warm-lane record")
        .normalized
        .is_empty());
}

#[test]
fn ios_prepare_disconnects_the_exact_device_hardware_keyboard_and_reads_it_back() {
    for missing in [false, true] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        mock.hardware_keyboard = true;
        mock.hardware_keyboard_missing = missing;
        script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));
        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));
        assert_eq!(
            receipt.result,
            ReceiptResult::Ready,
            "{}",
            receipt.to_json()
        );
        let lane = receipt.lane.unwrap();
        assert_eq!(lane.hardware_keyboard, Some(false));
        assert_eq!(lane.normalized, ["ConnectHardwareKeyboard"]);
        let calls: Vec<_> = mock
            .calls
            .iter()
            .filter(|c| c.label.starts_with("plistbuddy-hardware-keyboard"))
            .collect();
        assert_eq!(calls.len(), if missing { 4 } else { 3 });
        assert_eq!(
            calls[0].args[1],
            format!("Print :DevicePreferences:{UDID}:ConnectHardwareKeyboard")
        );
        assert_eq!(
            calls[1].args[1],
            format!("Set :DevicePreferences:{UDID}:ConnectHardwareKeyboard false")
        );
        if missing {
            assert_eq!(
                calls[2].args[1],
                format!("Add :DevicePreferences:{UDID}:ConnectHardwareKeyboard bool false")
            );
        }
        assert_eq!(calls.last().unwrap().args, calls[0].args);
        let labels: Vec<&str> = mock.calls.iter().map(|c| c.label.as_str()).collect();
        let mkdir = labels
            .iter()
            .position(|l| *l == "mkdir-simulator-preferences")
            .expect("the preferences directory is ensured before the write");
        let write = labels
            .iter()
            .position(|l| *l == "plistbuddy-hardware-keyboard-write")
            .unwrap();
        assert!(mkdir < write);
        assert_eq!(
            mock.calls[mkdir].args,
            ["-p", "/hermetic-home/Library/Preferences"]
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn ios_prepare_refuses_missing_or_unreadable_hardware_keyboard_proof_before_launch() {
    for output in [
        None,
        Some(CmdOutput::success("")),
        Some(CmdOutput::failed(1, "unreadable")),
    ] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        if let Some(output) = output {
            mock.hardware_keyboard_read = Some(output);
        } else {
            mock.environment.remove("HOME");
        }
        script_ios_prepare_before_devmenu(&mut mock, &repo);
        common::script_ios_metro_cleanup(&mut mock);
        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));
        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{}",
            receipt.to_json()
        );
        assert_eq!(receipt.failure.unwrap().code, FailureCode::LaneNotWarm);
        assert!(receipt.lane.is_none());
        assert!(!mock.calls.iter().any(|c| c.label == "simctl-launch"));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn ios_prepare_refuses_a_lane_that_keeps_its_unpinned_values_before_launch() {
    for hardware_keyboard in [false, true] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        if hardware_keyboard {
            mock.hardware_keyboard = true;
            mock.hardware_keyboard_stuck = true;
            mock.inner
                .environment
                .insert("HOME".into(), repo.display().to_string());
        } else {
            mock.lane = common::Lane::Stuck;
        }
        script_ios_prepare_before_devmenu(&mut mock, &repo);
        common::script_ios_metro_cleanup(&mut mock);

        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{}",
            receipt.to_json()
        );
        let failure = receipt.failure.as_ref().unwrap();
        assert_eq!(failure.code, FailureCode::LaneNotWarm);
        assert!(failure.code.is_refusal());
        let detail = failure.detail.to_string();
        assert!(
            detail.contains(if hardware_keyboard {
                "hardware keyboard"
            } else {
                "AppleKeyboards"
            }),
            "{detail}"
        );
        let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
        assert_eq!(count("simctl-devmenu-defaults"), 0);
        assert_eq!(count("simctl-launch"), 0);
        assert!(receipt.lane.is_none());
        assert_eq!(mock.remaining(), 0);
    }
}

const APP_EXITED: &str = "-\t0\tUIKitApplication:com.rndevagent.testapp[abc]";

fn script_ios_app_tick(mock: &mut qaren::exec::MockRunner, launchctl: &str) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run("simctl spawn", CmdOutput::success(launchctl));
}

// Metro does not answer, so only the watched app is probed.
fn script_ios_metro_busy_tick(mock: &mut qaren::exec::MockRunner, launchctl: CmdOutput) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::failed(7, ""));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run("simctl spawn", launchctl);
}

fn script_ios_launched(mock: &mut MockRunner, repo: &std::path::Path) {
    script_ios_prepare_before_devmenu(mock, repo);
    common::script_devmenu_defaults(mock, CmdOutput::success(""));
    common::script_ios_launch(mock);
}

// A synthetic dyld launch crash in the simulator .ips shape: header line, then body.
fn write_dyld_crash_report(home: &std::path::Path, udid: &str, library: &str) {
    let name = library.rsplit('/').next().unwrap();
    let reports = home.join("Library/Logs/DiagnosticReports");
    std::fs::create_dir_all(&reports).unwrap();
    let header = serde_json::json!({"bundleID": "com.rndevagent.testapp", "bug_type": "309"});
    let body = serde_json::json!({
        "procPath": format!("/Users/someone/Library/Developer/CoreSimulator/Devices/{udid}/data/Containers/Bundle/Application/X/testapp.app/testapp"),
        "captureTime": "2026-02-02 02:40:01.0000 +0000",
        "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
        "termination": {
            "namespace": "DYLD",
            "indicator": "Library missing",
            "details": ["(terminated at launch; ignore backtrace)"],
            "reasons": [
                format!("Library not loaded: {library}"),
                "Referenced from: <UUID> /Users/someone/secret-project/testapp.app/testapp",
            ],
        },
    });
    std::fs::write(
        reports.join(format!("testapp-{udid}-{name}.ips")),
        format!("{header}\n{body}"),
    )
    .unwrap();
}

#[test]
fn ios_app_exiting_at_launch_fails_within_seconds_citing_the_crash_report() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let home = repo.join("home");
    write_dyld_crash_report(
        &home,
        UDID,
        "@rpath/ReactNativeDependencies.framework/ReactNativeDependencies",
    );
    write_dyld_crash_report(
        &home,
        "FFFFFFFF-0000-0000-0000-000000000000",
        "@rpath/OtherDevice.framework/OtherDevice",
    );
    let mut mock = MockRunner::new();
    mock.inner
        .environment
        .insert("HOME".into(), home.to_string_lossy().into_owned());
    script_ios_launched(&mut mock, &repo);
    script_ios_app_tick(&mut mock, APP_EXITED);
    script_ios_app_tick(&mut mock, "");
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("an exited app fails");
    assert_eq!(
        failure.code,
        FailureCode::AppExitedAtLaunch,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let detail = failure.detail.to_string();
    assert!(detail.contains("was not running 5s after"), "{detail}");
    assert!(
        detail.contains("crash report: exception EXC_CRASH, termination DYLD Library missing, missing library ReactNativeDependencies.framework"),
        "{detail}"
    );
    assert!(!detail.contains("/Users/") && !detail.contains("Referenced"));
    assert!(
        detail.contains("delete ios/Pods and reinstall the pods"),
        "{detail}"
    );
    // prepare leaves its simulator owned, so cleanup comes first; check carries the remedy.
    assert_eq!(
        failure.next_action.to_string(),
        format!("qaren cleanup {} --json", receipt.run_id)
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("simctl-launchctl"), 2);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_app_seen_alive_once_then_gone_after_the_launch_settle_fails_as_exited() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let home = repo.join("home");
    let mut mock = MockRunner::new();
    mock.inner
        .environment
        .insert("HOME".into(), home.to_string_lossy().into_owned());
    let mut launchctl_probes = 0;
    mock.observe = Some(Box::new(move |spec| {
        if spec.label == "simctl-launchctl" {
            launchctl_probes += 1;
            if launchctl_probes == 3 {
                write_dyld_crash_report(
                    &home,
                    UDID,
                    "@rpath/ReactNativeDependencies.framework/ReactNativeDependencies",
                );
            }
        }
    }));
    script_ios_launched(&mut mock, &repo);
    script_ios_app_tick(&mut mock, common::APP_RUNNING);
    mock.expect_run("simctl spawn", CmdOutput::success(APP_EXITED));
    script_ios_app_tick(&mut mock, APP_EXITED);
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("an exited app fails");
    assert_eq!(
        failure.code,
        FailureCode::AppExitedAtLaunch,
        "{}",
        receipt.to_json()
    );
    let detail = failure.detail.to_string();
    assert!(
        detail.contains("missing library ReactNativeDependencies.framework")
            && detail.contains("delete ios/Pods"),
        "{detail}"
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(
        count("simctl-launchctl"),
        3,
        "first sighting, settle, then the confirming tick"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_unreadable_launch_settle_probe_never_accepts_a_crashed_app() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_launched(&mut mock, &repo);
    script_ios_app_tick(&mut mock, common::APP_RUNNING);
    mock.expect_run(
        "simctl spawn",
        CmdOutput::failed(1, "launchctl unavailable"),
    );
    script_ios_app_tick(&mut mock, APP_EXITED);
    script_ios_app_tick(&mut mock, APP_EXITED);
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt
        .failure
        .as_ref()
        .expect("an unconfirmed launch is not ready");
    assert_eq!(
        failure.code,
        FailureCode::AppExitedAtLaunch,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_unreadable_launch_settle_probe_settles_again_on_the_next_sighting() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_launch(&mut mock, &repo, |m| {
        common::script_ios_launch(m);
        script_ios_app_tick(m, common::APP_RUNNING);
        m.expect_run(
            "simctl spawn",
            CmdOutput::failed(1, "launchctl unavailable"),
        );
    });

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(
        count("simctl-launchctl"),
        4,
        "sighting, failed settle, sighting, settle"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_app_exiting_while_metro_stalls_fails_without_waiting_for_metro() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_launched(&mut mock, &repo);
    script_ios_metro_busy_tick(&mut mock, CmdOutput::success(APP_EXITED));
    script_ios_metro_busy_tick(&mut mock, CmdOutput::success(APP_EXITED));
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt
        .failure
        .as_ref()
        .expect("a stalled Metro cannot hide the exit");
    assert_eq!(
        failure.code,
        FailureCode::AppExitedAtLaunch,
        "{}",
        receipt.to_json()
    );
    assert!(failure.detail.to_string().contains("5s after"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_app_relaunched_under_a_new_pid_during_the_launch_settle_fails_as_exited() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_launched(&mut mock, &repo);
    script_ios_app_tick(&mut mock, common::APP_RUNNING);
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("513\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("a replaced process fails");
    assert_eq!(failure.code, FailureCode::AppExitedAtLaunch);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_missing_system_library_gets_the_crash_report_remedy_not_the_pods_one() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let home = repo.join("home");
    write_dyld_crash_report(
        &home,
        UDID,
        "/System/Library/Frameworks/ActivityKit.framework/ActivityKit",
    );
    let mut mock = MockRunner::new();
    mock.inner
        .environment
        .insert("HOME".into(), home.to_string_lossy().into_owned());
    script_ios_launched(&mut mock, &repo);
    script_ios_app_tick(&mut mock, APP_EXITED);
    script_ios_app_tick(&mut mock, APP_EXITED);
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("an exited app fails");
    assert_eq!(failure.code, FailureCode::AppExitedAtLaunch);
    let detail = failure.detail.to_string();
    assert!(
        detail.contains("missing library ActivityKit.framework")
            && detail.contains("read the newest com.rndevagent.testapp crash report")
            && !detail.contains("Pods"),
        "{detail}"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_app_exiting_during_readiness_fails_without_a_crash_report() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_launched(&mut mock, &repo);
    script_ios_metro_busy_tick(&mut mock, CmdOutput::success(common::APP_RUNNING));
    script_ios_metro_busy_tick(&mut mock, CmdOutput::success(common::APP_RUNNING));
    script_ios_app_tick(&mut mock, APP_EXITED);
    script_ios_app_tick(&mut mock, APP_EXITED);
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("an exited app fails");
    assert_eq!(failure.code, FailureCode::AppExitedAtLaunch);
    let detail = failure.detail.to_string();
    assert!(
        detail.contains("15s after")
            && detail.contains("no crash report")
            && detail.contains("~/Library/Logs/DiagnosticReports"),
        "{detail}"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_slow_but_alive_app_is_never_refused_for_a_single_missed_probe() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_launch(&mut mock, &repo, |m| {
        common::script_ios_launch(m);
        for _ in 0..6 {
            script_ios_metro_busy_tick(m, CmdOutput::success(common::APP_RUNNING));
        }
        script_ios_app_tick(m, APP_EXITED);
        // Seen alive again, so the next single miss starts a fresh count.
        script_ios_metro_busy_tick(m, CmdOutput::success(common::APP_RUNNING));
        script_ios_app_tick(m, APP_EXITED);
        let launchctl_failed = CmdOutput::failed(1, "launchctl unavailable");
        m.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
        m.expect_run("ps", CmdOutput::success("S\n"));
        m.expect_run("lsof", CmdOutput::success("6001\n"));
        m.expect_run("ps", CmdOutput::success("6000\n"));
        m.expect_run("curl", CmdOutput::success("packager-status:running"));
        m.expect_run(
            "simctl get_app_container",
            CmdOutput::success("/containers/app\n"),
        );
        m.expect_run("simctl spawn", launchctl_failed);
    });

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(
        count("simctl-launchctl"),
        12,
        "six alive with Metro busy, missed, alive, missed, unknown, running, then launch settle"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_prepare_proceeds_after_two_devmenu_timeouts_with_each_attempt_in_the_receipt() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));
    mock.timeouts = [
        ("simctl-devmenu-defaults".into(), 20_000),
        ("simctl-devmenu-defaults".into(), 20_000),
    ]
    .into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(
        receipt.timings_ms["simctl-devmenu-defaults_attempt_1"],
        20_000
    );
    assert_eq!(
        receipt.timings_ms["simctl-devmenu-defaults_attempt_2"],
        20_000
    );
    assert_eq!(receipt.timings_ms["simctl-devmenu-defaults_attempt_3"], 0);
    assert!(!receipt.outcomes.contains_key("dev_menu_defaults"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_over_120_seconds_completes_within_the_preparation_budget() {
    let repo = common::temp_repo();
    let scenario = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 150\n",
            ios_scenario_yaml(8791)
        ),
    );
    let mut mock = MockRunner::new();
    script_ios_prepare_install(&mut mock, &repo, CmdOutput::success(""), |m| {
        m.expect_run(
            "simctl install",
            CmdOutput {
                duration_ms: 130_000,
                ..CmdOutput::success("")
            },
        );
    });
    mock.advance_on = Some(("simctl install".into(), 130_000));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-install_attempt_1"], 130_000);
    let installs: Vec<_> = mock
        .calls
        .iter()
        .filter(|call| call.label == "simctl-install")
        .collect();
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].timeout_seconds, 150);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_timeout_proven_by_the_installed_bundle_is_not_reissued() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_install(&mut mock, &repo, CmdOutput::success(""), |_| {});
    mock.timeouts = [("simctl-install".into(), 120_000)].into();
    mock.container_is_installed_app = true;

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-install_attempt_1"], 120_000);
    assert!(receipt.outcomes["simctl-install_attempt_1"].contains("timed out"));
    assert!(!receipt.timings_ms.contains_key("simctl-install_attempt_2"));
    assert_eq!(receipt.outcomes["install_proof"], "container-hash");
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "simctl-install")
            .count(),
        1
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_timeout_without_an_installed_bundle_reinstalls_within_the_budget() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_install(&mut mock, &repo, CmdOutput::success(""), |m| {
        m.expect_run(
            "simctl get_app_container",
            CmdOutput::failed(2, "No such file or directory"),
        );
        m.expect_run("simctl install", CmdOutput::success(""));
    });
    mock.timeouts = [("simctl-install".into(), 120_000)].into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["simctl-install_attempt_1"], 120_000);
    assert_eq!(receipt.timings_ms["simctl-install_attempt_2"], 0);
    assert!(!receipt.outcomes.contains_key("install_proof"));
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "simctl-install")
            .count(),
        2
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_timeouts_fail_once_the_shared_budget_is_spent() {
    let repo = common::temp_repo();
    let scenario = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 150\n",
            ios_scenario_yaml(8791)
        ),
    );
    let mut mock = MockRunner::new();
    script_ios_prepare_before_install(&mut mock, &repo);
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::failed(2, "No such file or directory"),
    );
    common::script_ios_metro_cleanup(&mut mock);
    mock.timeouts = [("simctl-install".into(), 150_000)].into();

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("budget spent must fail");
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(failure.detail.contains("(install-timeout):"), "{failure:?}");
    assert!(failure.detail.contains("1 attempts"), "{failure:?}");
    assert_eq!(receipt.outcomes["launch_ready_budget"], "spent");
    assert_eq!(receipt.outcomes["substage"], "install_cached");
    assert_eq!(receipt.timings_ms["simctl-install_attempt_1"], 150_000);
    let installs: Vec<_> = mock
        .calls
        .iter()
        .filter(|call| call.label == "simctl-install")
        .collect();
    assert_eq!(installs.len(), 1);
    assert_eq!(installs[0].timeout_seconds, 150);
    assert!(mock.timeouts.is_empty());
    assert_eq!(mock.remaining(), 0);
}

const IX_REFUSAL: &str = "An error was encountered processing the command (domain=IXErrorDomain, code=2):\nSimulator device failed to install the application.\nFailed to locate promise.\nUnderlying error (domain=IXErrorDomain, code=2):\n\tFailed to set metadata for <bundle>\n\tFailed to create promise.";

#[test]
fn ios_install_coordination_refusal_is_retried_within_the_budget() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_install(&mut mock, &repo, CmdOutput::success(""), |m| {
        m.expect_run("simctl install", CmdOutput::failed(2, IX_REFUSAL));
        m.expect_run("simctl install", CmdOutput::success(""));
    });

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert!(receipt.outcomes["simctl-install_attempt_1"].contains("IXErrorDomain"));
    assert!(receipt.timings_ms.contains_key("simctl-install_attempt_2"));
    assert!(!receipt.outcomes.contains_key("install_proof"));
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "simctl-install")
            .count(),
        2
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_coordination_refusals_fail_once_the_shared_budget_is_spent() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_install(&mut mock, &repo);
    for _ in 0..4 {
        mock.expect_run("simctl install", CmdOutput::failed(2, IX_REFUSAL));
    }
    common::script_ios_metro_cleanup(&mut mock);
    mock.advance_on = Some(("simctl install".into(), 600_000));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("budget spent must fail");
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(
        failure.detail.contains("preparation budget of 2400s spent"),
        "{failure:?}"
    );
    assert_eq!(receipt.outcomes["launch_ready_budget"], "spent");
    assert_eq!(receipt.outcomes["substage"], "install_cached");
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "simctl-install")
            .count(),
        4
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_invalid_cached_bundle_preserves_rebuild_and_cleanup_advice() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let source = repo.join("cached.app");
    std::fs::create_dir(&source).unwrap();
    std::fs::write(source.join("binary"), b"cached app").unwrap();
    let mut fp_runner = qaren::exec::MockRunner::new();
    fp_runner.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut fp_runner);
    let fp =
        qaren::fingerprint::compute(&mut fp_runner, &repo, &repo.join("test-app"), "ios").unwrap();
    let artifact = common::seed_store(
        &repo.join(".native-store"),
        "ios",
        &fp.value,
        &source,
        qaren::buildplan::ArtifactKind::AppBundle,
    );

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run("simctl bootstatus", CmdOutput::success("finished"));
    mock.expect_run("plutil", CmdOutput::success("{}"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{}",
        receipt.to_json()
    );
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(
        failure.detail.contains("(artifact-invalid):"),
        "{failure:?}"
    );
    let expected = format!(
        "delete the machine store entry {} to force a rebuild, then qaren cleanup {} --json and re-run prepare",
        artifact.path.parent().unwrap().parent().unwrap().display(),
        receipt.run_id
    );
    assert_eq!(receipt.next_action, expected);
    assert_eq!(failure.next_action.as_str(), expected);
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.failure.unwrap().next_action.as_str(), expected);
    assert!(record.resources.ios_simulator.is_some());
    assert!(artifact.path.exists());
    assert!(!mock.calls.iter().any(|call| call.label == "simctl-install"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_error_fails_after_one_attempt() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_install(&mut mock, &repo);
    mock.expect_run(
        "simctl install",
        CmdOutput::failed(1, "An error was encountered processing the command"),
    );
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("install error must fail");
    assert_eq!(failure.code, FailureCode::ArtifactInstallFailed);
    assert!(failure.detail.contains("(install-failed):"), "{failure:?}");
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "simctl-install")
            .count(),
        1
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_install_refusal_on_stdout_is_terminal() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_install(&mut mock, &repo);
    mock.expect_run(
        "simctl install",
        CmdOutput {
            stdout: IX_REFUSAL.into(),
            ..CmdOutput::failed(2, "")
        },
    );
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::ArtifactInstallFailed
    );
    assert!(!receipt.timings_ms.contains_key("simctl-install_attempt_2"));
    assert_eq!(mock.remaining(), 0);
}

fn script_ios_prepare_before_devmenu(mock: &mut MockRunner, repo: &std::path::Path) {
    script_ios_prepare_before_manifest(mock, repo);
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
}

fn script_ios_prepare_before_manifest(mock: &mut MockRunner, repo: &std::path::Path) {
    script_ios_prepare_before_install(mock, repo);
    mock.expect_run("simctl install", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
}

fn manifest_answered_in(duration_ms: u64) -> CmdOutput {
    CmdOutput {
        duration_ms,
        ..CmdOutput::success("")
    }
}

#[test]
fn ios_prepare_warms_metro_until_the_manifest_answers_twice_inside_half_the_dev_client_timeout() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_manifest(&mut mock, &repo);
    // 7 s fits the dev client's 10 s limit but not the 5 s margin, so it restarts the count.
    let answers = [12_000, 4_000, 7_000, 4_999, 1_000];
    for ms in answers {
        mock.expect_run("expo-platform", manifest_answered_in(ms));
    }
    common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
    common::script_ios_launch(&mut mock);
    script_ios_readiness(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    for (attempt, ms) in answers.into_iter().enumerate() {
        assert_eq!(
            receipt.timings_ms[&format!("metro-manifest_attempt_{}", attempt + 1)],
            ms
        );
    }
    let labels: Vec<&str> = mock.calls.iter().map(|c| c.label.as_str()).collect();
    let manifests: Vec<usize> = (0..labels.len())
        .filter(|i| labels[*i] == "metro-manifest")
        .collect();
    assert_eq!(manifests.len(), 5);
    let launch = labels.iter().position(|l| *l == "simctl-launch").unwrap();
    assert!(manifests[4] < launch);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_prepare_retries_a_manifest_request_timeout_with_the_original_attempt_bound() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_manifest(&mut mock, &repo);
    mock.expect_run(
        "expo-platform",
        CmdOutput {
            timed_out: true,
            duration_ms: 60_000,
            ..Default::default()
        },
    );
    mock.expect_run("expo-platform", manifest_answered_in(4_999));
    mock.expect_run("expo-platform", manifest_answered_in(4_999));
    common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
    common::script_ios_launch(&mut mock);
    script_ios_readiness(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.timings_ms["metro-manifest_attempt_1"], 60_000);
    assert_eq!(receipt.timings_ms["metro-manifest_attempt_2"], 4_999);
    assert_eq!(receipt.timings_ms["metro-manifest_attempt_3"], 4_999);
    assert!(receipt.outcomes["metro-manifest_attempt_1"].contains("timed out"));
    let manifests: Vec<_> = mock
        .calls
        .iter()
        .filter(|c| c.label == "metro-manifest")
        .collect();
    assert_eq!(manifests.len(), 3);
    assert!(manifests.iter().all(|c| c.timeout_seconds == 60));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_prepare_refuses_when_the_manifest_never_answers_twice_inside_half_the_dev_client_timeout() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_manifest(&mut mock, &repo);
    for ms in [12_000, 1_000, 12_000, 1_000] {
        mock.expect_run("expo-platform", manifest_answered_in(ms));
    }
    common::script_ios_metro_cleanup(&mut mock);
    mock.advance_on = Some(("expo-platform".into(), 600_000));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    let failure = receipt.failure.as_ref().expect("slow manifest refuses");
    assert_eq!(failure.code, FailureCode::CoreRefused);
    assert!(
        failure
            .detail
            .starts_with("dev client manifest did not become ready within the preparation budget"),
        "{failure:?}"
    );
    assert!(failure.detail.contains("after 4 attempts"), "{failure:?}");
    assert!(failure.detail.contains("host"), "{failure:?}");
    assert_eq!(receipt.outcomes["launch_ready_budget"], "spent");
    assert_eq!(receipt.outcomes["substage"], "dev_client_manifest");
    for (attempt, ms) in [12_000, 1_000, 12_000, 1_000].into_iter().enumerate() {
        assert_eq!(
            receipt.timings_ms[&format!("metro-manifest_attempt_{}", attempt + 1)],
            ms
        );
    }
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("metro-manifest"), 4);
    assert_eq!(count("simctl-devmenu-defaults"), 0);
    assert_eq!(count("simctl-launch"), 0);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_manifest_error_after_a_slow_answer_stays_a_build_failure() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_manifest(&mut mock, &repo);
    mock.expect_run("expo-platform", manifest_answered_in(12_000));
    mock.expect_run("expo-platform", CmdOutput::failed(22, "HTTP 500"));
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed,
        "{}",
        receipt.to_json()
    );
    let count = |label: &str| mock.calls.iter().filter(|c| c.label == label).count();
    assert_eq!(count("metro-manifest"), 2);
    assert_eq!(count("simctl-devmenu-defaults"), 0);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_prepare_cancellation_preempts_a_slow_manifest_retry() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_before_manifest(&mut mock, &repo);
    mock.expect_run("expo-platform", manifest_answered_in(12_000));
    common::script_ios_metro_cleanup(&mut mock);
    mock.cancel_after = Some(("expo-platform".into(), "received SIGTERM".into()));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunCancelled
    );
    assert_eq!(receipt.timings_ms["metro-manifest_attempt_1"], 12_000);
    assert_eq!(receipt.outcomes["substage"], "dev_client_manifest");
    assert_eq!(
        mock.calls
            .iter()
            .filter(|c| c.label == "metro-manifest")
            .count(),
        1
    );
    assert_eq!(mock.remaining(), 0);
}

fn script_ios_prepare_before_install(mock: &mut MockRunner, repo: &std::path::Path) {
    script_validation(mock, repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run("simctl bootstatus", CmdOutput::success("finished"));
    common::script_finite_ios_build_only(mock, "expo run:ios");
    script_ios_prepublish(mock, "", |m| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    });
    common::script_ios_app_verification(mock);
    common::script_ios_metro_spawn(mock);
}

// The provenance and fingerprint checks that run under the build lock before cache publication.
fn script_ios_prepublish(
    mock: &mut MockRunner,
    porcelain: &str,
    fingerprint: impl FnOnce(&mut MockRunner),
) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain));
    fingerprint(mock);
}

#[test]
fn ios_prepare_retries_timeouts_until_the_shared_budget_is_spent() {
    for label in ["simctl-launch", "simctl-devmenu-defaults"] {
        let repo = common::temp_repo();
        let scenario = write_scenario(
            &repo,
            &format!(
                "{}deadlines:\n  build_seconds: 150\n",
                ios_scenario_yaml(8791)
            ),
        );
        let mut mock = MockRunner::new();
        script_ios_prepare_before_devmenu(&mut mock, &repo);
        if label == "simctl-launch" {
            common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
            for _ in 0..3 {
                mock.expect_run("launchctl list", CmdOutput::success(""));
            }
        }
        let durations: Vec<u64> = if label == "simctl-launch" {
            vec![60_000, 60_000, 10_000]
        } else {
            vec![
                20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 10_000,
            ]
        };
        mock.timeouts = durations.iter().map(|ms| (label.into(), *ms)).collect();
        if label == "simctl-launch" {
            mock.timeouts
                .push_front(("simctl-devmenu-defaults".into(), 20_000));
        }
        common::script_ios_metro_cleanup(&mut mock);

        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{}",
            receipt.to_json()
        );
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::CoreRefused
        );
        assert_eq!(receipt.outcomes["launch_ready_budget"], "spent");
        let substage = if label == "simctl-launch" {
            "app_launch"
        } else {
            "dev_menu_defaults"
        };
        assert_eq!(receipt.outcomes["substage"], substage);
        for (index, duration) in durations.iter().enumerate() {
            let key = format!("{label}_attempt_{}", index + 1);
            assert_eq!(receipt.timings_ms[&key], *duration);
            assert!(receipt.outcomes[&key].contains("timed out"));
        }
        let attempts: Vec<_> = mock
            .calls
            .iter()
            .filter(|spec| spec.label == label)
            .collect();
        assert_eq!(attempts.len(), durations.len());
        assert_eq!(
            attempts.last().unwrap().timeout_seconds * 1000,
            *durations.last().unwrap()
        );
        assert!(mock.timeouts.is_empty());
        assert_eq!(mock.remaining(), 0);
        let count = |want: &str| mock.calls.iter().filter(|c| c.label == want).count();
        assert_eq!(count("simctl-app-container"), 0, "readiness never ran");
        let receipts = if label == "simctl-launch" { 3 } else { 0 };
        assert_eq!(count("simctl-launchctl"), receipts);
    }
}

#[test]
fn ios_prepare_cancellation_preempts_a_timeout_retry() {
    for label in ["simctl-launch", "simctl-devmenu-defaults"] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_ios_prepare_before_devmenu(&mut mock, &repo);
        if label == "simctl-launch" {
            common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
        }
        let hint = if label == "simctl-launch" {
            "simctl launch"
        } else {
            "defaults write"
        };
        mock.cancel_after = Some((hint.into(), "received SIGTERM".into()));
        mock.timeouts = [(label.into(), 20_000)].into();
        common::script_ios_metro_cleanup(&mut mock);

        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::RunCancelled
        );
        assert_eq!(receipt.timings_ms[&format!("{label}_attempt_1")], 20_000);
        assert_eq!(
            mock.calls.iter().filter(|spec| spec.label == label).count(),
            1
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn ios_prepare_writes_dev_menu_defaults_on_the_app_domain_before_launch() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Ready);
    let labels: Vec<&str> = mock.calls.iter().map(|c| c.label.as_str()).collect();
    let launch = labels.iter().position(|l| *l == "simctl-launch").unwrap();
    let writes: Vec<_> = mock
        .calls
        .iter()
        .enumerate()
        .filter(|(_, c)| c.label == "simctl-devmenu-defaults")
        .collect();
    assert_eq!(writes.len(), 3);
    assert!(writes.iter().all(|(i, _)| *i < launch));
    let expected = [
        ("EXDevMenuShowFloatingActionButton", "NO"),
        ("EXDevMenuShowsAtLaunch", "NO"),
        ("EXDevMenuIsOnboardingFinished", "YES"),
    ];
    for ((_, call), (key, value)) in writes.iter().zip(expected) {
        assert_eq!(
            call.args,
            vec![
                "simctl",
                "spawn",
                UDID,
                "defaults",
                "write",
                "com.rndevagent.testapp",
                key,
                "-bool",
                value
            ]
        );
    }
    assert!(!receipt.outcomes.contains_key("dev_menu_defaults"));
}

#[test]
fn ios_prepare_continues_with_a_note_when_dev_menu_defaults_fail() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare(&mut mock, &repo, CmdOutput::failed(1, "defaults failed"));
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Ready);
    assert!(mock.calls.iter().any(|c| c.label == "simctl-launch"));
    assert_eq!(
        receipt
            .outcomes
            .get("dev_menu_defaults")
            .map(String::as_str),
        Some("unconfirmed")
    );
}

fn script_ios_prepare(mock: &mut MockRunner, repo: &std::path::Path, defaults: CmdOutput) {
    script_ios_prepare_install(mock, repo, defaults, |m| {
        m.expect_run("simctl install", CmdOutput::success(""))
    });
}

fn script_ios_prepare_install(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    defaults: CmdOutput,
    install: impl FnOnce(&mut qaren::exec::MockRunner),
) {
    let empty = |m: &mut MockRunner| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    };
    script_ios_prepare_fingerprints(
        mock,
        repo,
        defaults,
        empty,
        empty,
        empty,
        install,
        common::script_ios_launch,
    );
}

fn script_ios_prepare_launch(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    launch: impl FnOnce(&mut qaren::exec::MockRunner),
) {
    let empty = |m: &mut MockRunner| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    };
    script_ios_prepare_fingerprints(
        mock,
        repo,
        CmdOutput::success(""),
        empty,
        empty,
        empty,
        |m| m.expect_run("simctl install", CmdOutput::success("")),
        launch,
    );
}

#[allow(clippy::too_many_arguments)]
fn script_ios_prepare_fingerprints(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    defaults: CmdOutput,
    plan: impl FnOnce(&mut MockRunner),
    prepublish: impl FnOnce(&mut MockRunner),
    recheck: impl FnOnce(&mut MockRunner),
    install: impl FnOnce(&mut qaren::exec::MockRunner),
    launch: impl FnOnce(&mut qaren::exec::MockRunner),
) {
    script_validation(mock, repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n")); // self command
    common::script_ios_deps(mock);
    plan(mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(mock, "expo run:ios");
    script_ios_prepublish(mock, "", prepublish);
    common::script_ios_after_publish(mock, defaults, install, launch);
    script_ios_readiness(mock);
    recheck(mock);
}

fn script_ios_readiness(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // liveness probe
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n")); // port owner pgid
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    mock.expect_run("simctl spawn", CmdOutput::success(common::APP_RUNNING));
    // Provenance recheck immediately before ready: unchanged sha, still clean.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
}

#[test]
fn expo_hash_drift_between_plan_and_readiness_fails_as_candidate_drift() {
    const XCODE: &str = "Xcode 27.0\nBuild version 27A266a\n";
    let repo = common::temp_repo();
    std::fs::write(
        repo.join("test-app/app.config.ts"),
        "export default () => ({});\n",
    )
    .unwrap();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let fingerprint = |hash: &'static str| {
        move |m: &mut MockRunner| {
            m.expect_run("ls-files", CmdOutput::success("test-app/app.config.ts\0"));
            common::script_expo_fingerprint(m, hash, XCODE);
        }
    };
    let mut mock = MockRunner::new();
    script_ios_prepare_fingerprints(
        &mut mock,
        &repo,
        CmdOutput::success(""),
        fingerprint("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        fingerprint("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        fingerprint("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        |m| m.expect_run("simctl install", CmdOutput::success("")),
        common::script_ios_launch,
    );
    common::script_ios_metro_cleanup(&mut mock);
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.expect("drift must fail prepare");
    assert_eq!(failure.code, FailureCode::CandidateDrifted, "{failure:?}");
    assert!(failure
        .detail
        .contains("native inputs changed during preparation"));
}

#[test]
fn expo_hash_drift_before_publication_never_publishes_or_installs() {
    const XCODE: &str = "Xcode 27.0\nBuild version 27A266a\n";
    let repo = common::temp_repo();
    std::fs::write(
        repo.join("test-app/app.config.ts"),
        "export default () => ({});\n",
    )
    .unwrap();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success("test-app/app.config.ts\0"));
    common::script_expo_fingerprint(&mut mock, &"a".repeat(40), XCODE);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    script_ios_prepublish(&mut mock, "", |m| {
        m.expect_run("ls-files", CmdOutput::success("test-app/app.config.ts\0"));
        common::script_expo_fingerprint(m, &"b".repeat(40), XCODE);
    });

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.expect("drift must fail prepare");
    assert_eq!(failure.code, FailureCode::CandidateDrifted, "{failure:?}");
    assert!(!labels(&mock)
        .iter()
        .any(|l| matches!(l.as_str(), "simctl-install" | "expo-start")));
    // Nothing reached the machine store or the worktree's native state.
    assert!(!matches!(
        qaren::buildplan::load_state(&repo, "ios", "com.rndevagent.testapp"),
        qaren::buildplan::StateStatus::Loaded(_)
    ));
    let store = scenario_path.parent().unwrap().join(".native-store");
    assert!(walk_files(&store).is_empty(), "{:?}", walk_files(&store));
}

fn walk_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .flat_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                walk_files(&path)
            } else {
                vec![path]
            }
        })
        .collect()
}

fn assert_ios_ready(mock: &MockRunner, repo: &std::path::Path, receipt: qaren::receipt::Receipt) {
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt.run_id.starts_with("ios-simulator-"));
    let device = receipt.device.unwrap();
    assert_eq!(device.ios_udid.as_deref(), Some(UDID));
    assert_eq!(
        device.ios_name.as_deref(),
        Some(format!("qaren-{}", receipt.run_id).as_str())
    );
    let metro = receipt.metro.unwrap();
    assert_eq!(metro.port, 8791);
    assert_eq!(metro.endpoint, "http://127.0.0.1:8791");
    assert_eq!(metro.pid, Some(6000));
    let candidate = receipt.candidate.unwrap();
    assert_eq!(candidate.git_sha, "b".repeat(40));
    assert!(!candidate.git_dirty);
    assert!(candidate.lockfile_sha256.is_some());
    assert!(receipt.timings_ms.contains_key("total"));
    assert_eq!(receipt.commands_executed, mock.calls.len() as u64);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    let sim = record.resources.ios_simulator.as_ref().unwrap();
    assert_eq!(sim.udid, UDID);
    assert_eq!(sim.name, format!("qaren-{}", receipt.run_id));
    let metro = record.resources.metro.as_ref().unwrap();
    assert_eq!(metro.spawned.pgid, 6000);
    assert_eq!(metro.identity.as_ref().unwrap().started_at, LSTART);

    // Only installation and launch target the owned simulator; compilation is generic.
    let create = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-create")
        .unwrap();
    assert_eq!(create.args[2], format!("qaren-{}", receipt.run_id));
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-ios")
        .unwrap();
    let device_pos = build.args.iter().position(|a| a == "--device").unwrap();
    assert_eq!(build.args[device_pos + 1], "generic");
    assert!(build.args.contains(&"--no-bundler".into()));
    assert!(!build.args.contains(&"--port".into()));
    let install = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-install")
        .unwrap();
    assert_eq!(install.args[2], UDID);
    assert!(install.args[3].contains(&receipt.run_id));
    let launch = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-launch")
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "simctl",
            "launch",
            "--terminate-running-process",
            UDID,
            "com.rndevagent.testapp",
            "--initialUrl",
            "http://127.0.0.1:8791/?disableOnboarding=1"
        ]
    );
}

#[test]
fn android_prepare_happy_path_leases_tunnels_and_pins_serial() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n",
        ),
    );
    // farm adb port preflight on this host
    mock.expect_run("lsof", free_port());
    // MockRunner's clock is fixed until the first sleep, so the run id (and
    // therefore the echoed lease holder) is deterministic.
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // listener pgid == tunnel pgid
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n")); // listener pgid == server pgid
    mock.expect_run(
        "connect 127.0.0.1:5555",
        CmdOutput::success("connected to 127.0.0.1:5555\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    mock.expect_spawn(
        "expo run:android",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:android\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );
    // Provenance recheck immediately before ready: unchanged sha, still clean.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.label == "simctl-devmenu-defaults"));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let device = receipt.device.unwrap();
    assert_eq!(device.farm_slot, Some(1));
    assert_eq!(
        device.farm_lease_holder.as_deref(),
        Some(format!("qaren-{}", receipt.run_id).as_str())
    );
    assert_eq!(device.remote_serial.as_deref(), Some("emulator-5554"));
    assert_eq!(device.local_adb_serial.as_deref(), Some("127.0.0.1:5555"));
    assert_eq!(device.tunnel_local_port, Some(5555));

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    assert_eq!(
        record.resources.farm.as_ref().unwrap().holder,
        format!("qaren-{}", receipt.run_id)
    );
    assert!(record
        .resources
        .adb_path
        .as_ref()
        .unwrap()
        .ends_with("platform-tools/adb"));
    let server = record.resources.adb_server.as_ref().unwrap();
    assert_eq!(server.server_port, 15037);
    assert!(
        record.resources.app_install.is_none(),
        "no hashed artifact means no install provenance can be claimed"
    );
    let vendor_key = record.resources.adb_vendor_key.as_ref().unwrap();
    assert!(vendor_key.ends_with("nuc-adbkey"));
    let key_meta = std::fs::metadata(vendor_key).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        key_meta.permissions().mode() & 0o777,
        0o600,
        "vendor key must be private"
    );

    // Every adb invocation must either name the loopback endpoint positionally
    // (connect/disconnect) or pin it with -s; the build must carry ANDROID_SERIAL.
    let start = mock.calls.iter().find(|c| c.label == "farm-start").unwrap();
    assert_eq!(
        start.args.last().unwrap(),
        &expected_holder,
        "farm start must claim our holder"
    );
    for call in mock.calls.iter().filter(|c| {
        (c.program.ends_with("/adb") || c.program == "adb") && c.label != "adb-private-server"
    }) {
        let pinned = (call.args.first().map(|a| a == "-s").unwrap_or(false)
            && call
                .args
                .get(1)
                .map(|a| a == "127.0.0.1:5555")
                .unwrap_or(false))
            || (matches!(
                call.args.first().map(String::as_str),
                Some("connect") | Some("disconnect")
            ) && call
                .args
                .get(1)
                .map(|a| a == "127.0.0.1:5555")
                .unwrap_or(false));
        assert!(pinned, "unpinned adb call: {}", call.rendered());
    }
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-android")
        .unwrap();
    assert!(build
        .env
        .contains(&("ANDROID_SERIAL".to_string(), "127.0.0.1:5555".to_string())));
    assert!(
        build.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15037".to_string()
        )),
        "the build must route adb through the run-owned server"
    );
    assert!(build.args.contains(&"8792".to_string()));
}

#[test]
fn occupied_metro_port_fails_before_any_allocation() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", CmdOutput::success("4321\n"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::MetroPortOccupied
    );
    assert_eq!(receipt.run_id, "none", "no run may exist before allocation");
    let mut entries: Vec<String> = std::fs::read_dir(&repo)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    assert_eq!(
        entries,
        ["scenario.yaml", "test-app"],
        "no run dir may exist"
    );
}

#[test]
fn android_prepare_refuses_leased_slot_and_records_failure() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=other-holder state=device\n"),
    );

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::FarmSlotLeased
    );
    assert_eq!(
        mock.remaining(),
        0,
        "farm start must never run against a leased slot"
    );

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_none(),
        "no lease was claimed, none may be recorded"
    );
}

#[test]
fn android_prepare_refuses_unleased_but_running_emulator() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=device\n",
        ),
    );

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::FarmSlotLeased
    );
    assert_eq!(mock.remaining(), 0);
}

fn android_sdk(repo: &std::path::Path) -> std::path::PathBuf {
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();
    sdk
}

fn script_android_through_farm_status(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    slot_line: &str,
) {
    script_validation(mock, repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(slot_line));
}

const FREE_SLOT_LINE: &str =
    "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n";

#[test]
fn a_failing_farm_status_never_records_a_truncated_key_after_a_marker_mention() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::failed(
            255,
            "error: unterminated -----BEGIN marker\n-----BEGIN PRIVATE KEY-----\nFAKEKEYBODY1\nFAKEKEYBODY2\nFAKEKEYBODY3\n",
        ),
    );
    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let printed = serde_json::to_string(&receipt).unwrap();
    let recorded = std::fs::read_to_string(RunRecord::path(&repo, &receipt.run_id)).unwrap();
    for evidence in [&printed, &recorded] {
        assert!(!evidence.contains("FAKEKEYBODY"), "{evidence}");
    }
    assert!(
        printed.contains(qaren::redact::PRIVATE_KEY_WITHHELD),
        "{printed}"
    );
}

#[test]
fn android_prepare_fails_when_farm_adb_port_is_occupied_locally() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    // Preflight of the farm-advertised adb port on this host: occupied.
    mock.expect_run("lsof", CmdOutput::success("4321\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::TunnelFailed
    );
    assert!(
        !mock.calls.iter().any(|c| c.label == "farm-start"),
        "no lease may be claimed while the local tunnel port is occupied"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_none(),
        "no lease was claimed, none may be recorded"
    );
}

#[test]
fn android_prepare_refuses_foreign_listener_on_tunnel_port() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    // The port is listening, but its owner belongs to a foreign process group.
    mock.expect_run("lsof", CmdOutput::success("9999\n"));
    mock.expect_run("ps", CmdOutput::success("4242\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::TunnelFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    assert!(
        !mock
            .calls
            .iter()
            .any(|c| c.label == "fetch-adbkey" || c.label == "adb-connect"),
        "a foreign listener must stop the run before any adb activity"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_some() && record.resources.tunnel.is_some(),
        "the claimed lease and spawned tunnel must stay recorded for cleanup"
    );
}

#[test]
fn android_prepare_refuses_foreign_listener_on_adb_server_port() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // tunnel listener is ours
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    // A foreign process owns the private adb server port.
    mock.expect_run("lsof", CmdOutput::success("8888\n"));
    mock.expect_run("ps", CmdOutput::success("4242\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::AdbServerFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    assert!(
        !mock.calls.iter().any(|c| c.label == "adb-connect"),
        "adb connect must never run against an unproven server"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_some()
            && record.resources.tunnel.is_some()
            && record.resources.adb_server.is_some(),
        "the lease, tunnel, and spawned adb server must stay recorded for cleanup"
    );
}

#[test]
fn android_prepare_never_records_key_bytes_from_a_failed_key_fetch() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port());
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    // SSH delivers part of the key, then the connection drops.
    let key_lines = [
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7leakA",
        "Zq3rT9vLmN2pQxW8yK4bH1cF6dJ0sE5gU7iO3aR2tY9wX1zV8nM4kLeakB",
    ];
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput {
            exit_code: Some(255),
            stdout: format!(
                "-----BEGIN PRIVATE KEY-----\n{}\n{}\n",
                key_lines[0], key_lines[1]
            ),
            stderr: "Connection to farm closed by remote host.\n".to_string(),
            ..Default::default()
        },
    );

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::AdbServerFailed);
    assert!(
        failure.detail.contains("exit=Some(255)"),
        "{}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);

    let printed = serde_json::to_string(&receipt).unwrap();
    let recorded = std::fs::read_to_string(RunRecord::path(&repo, &receipt.run_id)).unwrap();
    for evidence in [&printed, &recorded] {
        for line in key_lines {
            assert!(!evidence.contains(line), "key bytes leaked: {evidence}");
        }
        assert!(!evidence.contains("PRIVATE KEY"), "{evidence}");
    }
}

#[test]
fn android_prepare_fails_fast_when_the_tunnel_dies_before_listening() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", free_port()); // nothing listening yet
    mock.expect_run("ps", CmdOutput::failed(1, "")); // ...because the tunnel already exited

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::TunnelFailed);
    assert!(
        failure
            .detail
            .contains("exited before the port started listening"),
        "a dead tunnel must be reported as such, not as a deadline: {}",
        failure.detail
    );
    assert!(
        !failure.evidence.is_empty(),
        "the tunnel log tail must be attached as evidence"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "the wait must end on the first poll, not burn the full deadline"
    );
}

#[test]
fn vendor_key_is_recorded_before_the_adb_server_spawns() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port());
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn_failure("server nodaemon", "fork failed");

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::AdbServerFailed
    );

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(
        record.resources.adb_server.is_none(),
        "the server never spawned"
    );
    let vendor_key = record
        .resources
        .adb_vendor_key
        .as_ref()
        .expect("the fetched key must be recorded independently of the server");
    assert!(vendor_key.exists(), "the key was written to the run dir");
}

// Observe durable ownership or inject a filesystem fault at a command boundary.
struct RecordProbeRunner {
    inner: MockRunner,
    repo: std::path::PathBuf,
    run_id: String,
    probe_label: String,
    observed: Option<String>,
    cancel_copy: Option<std::rc::Rc<std::cell::RefCell<std::path::PathBuf>>>,
    copied_bytes: std::cell::Cell<u64>,
    at_probe: Option<Box<dyn FnOnce(&std::path::Path)>>,
}

impl qaren::exec::Runner for RecordProbeRunner {
    fn cancellation(&self) -> Option<String> {
        if let Some(path) = &self.cancel_copy {
            let candidate = path.borrow().clone();
            if let Some(bucket) = candidate
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
            {
                if let Ok(entries) = std::fs::read_dir(bucket) {
                    if let Some(staging) = entries
                        .flatten()
                        .find(|e| e.file_name().to_string_lossy().starts_with(".staging-"))
                    {
                        *path.borrow_mut() = staging.path().join("testapp.app/binary");
                    }
                }
            }
            let bytes = std::fs::metadata(&*path.borrow())
                .map(|m| m.len())
                .unwrap_or(0);
            if bytes > 0 {
                self.copied_bytes.set(bytes);
            }
            if self.copied_bytes.get() > 0 {
                return Some("received SIGTERM".into());
            }
        }
        None
    }
    fn execute(&mut self, spec: &qaren::exec::CmdSpec, interruptible: bool) -> CmdOutput {
        // `label#n` probes the n-th call with that label; a bare label probes the first.
        let (label, nth) = match self.probe_label.split_once('#') {
            Some((label, nth)) => (label, nth.parse().unwrap()),
            None => (self.probe_label.as_str(), 1),
        };
        let seen = self.inner.calls.iter().filter(|c| c.label == label).count();
        if spec.label == label && seen + 1 == nth {
            self.observed = std::fs::read_to_string(RunRecord::path(&self.repo, &self.run_id)).ok();
            if let Some(probe) = self.at_probe.take() {
                probe(&RunRecord::run_dir(&self.repo, &self.run_id));
            }
        }
        self.inner.execute(spec, interruptible)
    }
    fn execute_private(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        input: &[u8],
        interruptible: bool,
    ) -> qaren::exec::PrivateOutput {
        self.inner.execute_private(spec, input, interruptible)
    }
    fn spawn_group_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log_path: &std::path::Path,
    ) -> std::io::Result<Spawned> {
        self.inner.spawn_group_unchecked(spec, log_path)
    }
    fn spawn_piped_unchecked(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        stderr_log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        self.inner.spawn_piped_unchecked(spec, stderr_log)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.inner.sleep(duration)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}

#[test]
fn prepare_refuses_preexisting_run_dir_without_clobbering() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    // MockRunner's clock is frozen, so the run id is deterministic.
    let run_id = format!(
        "ios-simulator-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    let run_dir = RunRecord::run_dir(&repo, &run_id);
    std::fs::create_dir_all(&run_dir).unwrap();
    std::fs::write(run_dir.join("run.json"), "SENTINEL").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunAlreadyExists
    );
    assert_eq!(
        std::fs::read_to_string(run_dir.join("run.json")).unwrap(),
        "SENTINEL",
        "an existing run's record must never be clobbered"
    );
}

#[test]
fn farm_lease_is_recorded_before_start_command() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);
    let run_id = format!(
        "nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight
                                          // A crash inside `farm start` must still leave the claim discoverable, so
                                          // the pending lease has to be durable before the command runs at all.
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::failed(255, "ssh: killed"),
    );

    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "farm-start".to_string(),
        observed: None,
        cancel_copy: None,
        copied_bytes: std::cell::Cell::new(0),
        at_probe: None,
    };
    let receipt = prepare(
        &mut probing,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let at_start = probing
        .observed
        .expect("farm-start must have executed with a readable run record");
    let snapshot: RunRecord =
        serde_json::from_str(&at_start).expect("the durable record must be valid JSON mid-run");
    let farm = snapshot
        .resources
        .farm
        .expect("the pending lease must be durable before farm start runs");
    assert_eq!(farm.holder, format!("qaren-{run_id}"));
    assert_eq!(farm.slot, 1);
    assert_eq!(farm.remote_serial, "emulator-5554");
    assert_eq!(farm.adb_port, 5555);
    let record = RunRecord::load(&repo, &run_id).unwrap();
    assert!(
        record.resources.farm.is_some(),
        "the failed start must leave the lease recorded for cleanup"
    );
}

#[test]
fn simulator_allocation_is_recorded_before_create() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let run_id = format!(
        "ios-simulator-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));

    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "simctl-create".to_string(),
        observed: None,
        cancel_copy: None,
        copied_bytes: std::cell::Cell::new(0),
        at_probe: None,
    };
    let receipt = prepare(&mut probing, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let at_create = probing
        .observed
        .expect("simctl-create must have executed with a readable run record");
    let snapshot: RunRecord =
        serde_json::from_str(&at_create).expect("the durable record must be valid JSON mid-run");
    let pending = snapshot
        .resources
        .ios_simulator
        .expect("the pending allocation must be durable before simctl create runs");
    assert_eq!(pending.name, format!("qaren-{run_id}"));
    assert_eq!(pending.udid, "", "no udid exists before create returns");
    let record = RunRecord::load(&repo, &run_id).unwrap();
    let sim = record
        .resources
        .ios_simulator
        .as_ref()
        .expect("pending allocation must survive the failed create");
    assert_eq!(sim.udid, "", "no udid may be invented for a failed create");
}

#[test]
fn candidate_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    // Provenance recheck before publication: HEAD moved during the build.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "d".repeat(40))));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "simctl-install"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
    assert!(
        receipt
            .failure
            .as_ref()
            .unwrap()
            .next_action
            .contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
}

#[test]
fn android_dry_run_plans_adb_connect_and_state_check() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            true,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert!(
        receipt
            .planned_commands
            .iter()
            .any(|c| c.contains("connect 127.0.0.1:<adb_port>")),
        "the plan must include the adb connect step: {:?}",
        receipt.planned_commands
    );
    assert!(
        receipt
            .planned_commands
            .iter()
            .any(|c| c.contains("-s 127.0.0.1:<adb_port> get-state")),
        "the planned state check must stay pinned to the leased serial: {:?}",
        receipt.planned_commands
    );
}

#[test]
fn candidate_dirty_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    // Provenance recheck: HEAD unchanged, but the worktree went dirty.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/App.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn candidate_dirty_content_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation_porcelain(&mut mock, &repo, IOS_TOOLS, " M test-app/App.tsx\0");
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    // Provenance recheck: still dirty, but a different set of modifications.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/Other.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::CandidateDrifted);
    assert!(
        failure.detail.contains("worktree contents changed"),
        "detail: {}",
        failure.detail
    );
}

// The full mock script of a prepare that reaches the readiness recheck, with
// the validation-time and recheck-time porcelain outputs as the variables
// under test.
fn script_prepare_to_recheck(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    porcelain_at_validation: &str,
    porcelain_at_recheck: &str,
) {
    script_prepare_to_prepublish(mock, repo, porcelain_at_validation, porcelain_at_recheck);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    common::script_ios_after_publish(
        mock,
        CmdOutput::success(""),
        |m| m.expect_run("simctl install", CmdOutput::success("")),
        common::script_ios_launch,
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    mock.expect_run("simctl spawn", CmdOutput::success(common::APP_RUNNING));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain_at_recheck));
}

// Through the build and the provenance recheck that runs under the lock before publication.
fn script_prepare_to_prepublish(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    porcelain_at_validation: &str,
    porcelain_at_recheck: &str,
) {
    script_validation_porcelain(mock, repo, IOS_TOOLS, porcelain_at_validation);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_finite_ios_build_only(mock, "expo run:ios");
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain_at_recheck));
}

// Regression for the external-worktree self-drift bug: prepare writes
// .qaren/runs/<run-id>/ into the candidate worktree after the cleanliness
// snapshot, so on a clean external project that does not gitignore .qaren
// the recheck used to see "?? .qaren/" and false-trigger CANDIDATE_DRIFTED.
#[test]
fn qaren_state_created_during_build_is_not_candidate_drift() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .qaren/\0");
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "qaren's own state dir must not count as drift: {:?}",
        receipt.failure
    );
}

#[test]
fn preexisting_qaren_state_does_not_mark_the_candidate_dirty() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(
        &mut mock,
        &repo,
        "?? .qaren/\0",
        "?? .qaren/runs/some-run/run.json\0",
    );
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    let candidate = receipt.candidate.unwrap();
    assert!(
        !candidate.git_dirty,
        "leftover qaren state from an earlier run is not candidate dirt"
    );
}

#[test]
fn untracked_file_outside_qaren_state_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_prepublish(&mut mock, &repo, "", "?? .qaren/\0?? stray.txt\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted,
        "an untracked file outside .qaren is real drift even next to qaren state"
    );
}

#[test]
fn tracked_modification_alongside_qaren_state_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_prepublish(&mut mock, &repo, "", "?? .qaren/\0 M test-app/App.tsx\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted,
        "a tracked modification is real drift even next to qaren state"
    );
}

#[test]
fn dry_run_plans_without_allocating() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, true, None));
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert_eq!(mock.remaining(), 0);
    assert!(!receipt.planned_commands.is_empty());
    assert!(receipt
        .planned_commands
        .iter()
        .any(|c| c.contains("expo run:ios")));
    assert!(
        !repo.join(".qaren").exists(),
        "dry-run must not create run records"
    );
}

#[test]
fn ios_reuse_dry_run_lists_each_launch_step_once_in_execution_order() {
    use qaren::adapters::{ios, metro};
    use qaren::buildplan::{
        save_json, state_path, ArtifactKind, BuildDecision, NativeCacheState, CACHE_SCHEMA,
    };
    use qaren::exec::CmdSpec;

    let repo = common::temp_repo();
    let project = repo.join("test-app");
    let yaml = ios_scenario_yaml(8791);
    let scenario = common::scenario_from(&yaml);
    let scenario_path = write_scenario(&repo, &yaml);
    let artifact = repo.join("cached.app");
    std::fs::create_dir_all(&artifact).unwrap();
    std::fs::write(artifact.join("binary"), b"cached app").unwrap();
    let files = "test-app/package.json\0";
    let mut fp_runner = qaren::exec::MockRunner::new();
    fp_runner.expect_run("ls-files", CmdOutput::success(files));
    common::script_xcode(&mut fp_runner);
    let fp = qaren::fingerprint::compute(&mut fp_runner, &repo, &project, "ios").unwrap();
    assert!(fp.complete);
    let artifact = common::seed_store(
        &scenario_path.parent().unwrap().join(".native-store"),
        "ios",
        &fp.value,
        &artifact,
        ArtifactKind::AppBundle,
    )
    .path;
    let cache = NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: Default::default(),
        platform: "ios".to_string(),
        app_id: scenario.candidate.app_id.clone(),
        worktree_root: repo.clone(),
        fingerprint: fp.value,
        built_at: "2026-10-05T00:00:00Z".to_string(),
        candidate_sha: "b".repeat(40),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["ios".to_string()],
        artifact: None,
    };
    save_json(
        &state_path(&repo, "ios", &scenario.candidate.app_id),
        &cache,
    )
    .unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(files));
    common::script_xcode(&mut mock);
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, true, None));
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert_eq!(
        receipt.build.as_ref().unwrap().decision,
        BuildDecision::Reuse
    );
    assert_eq!(mock.remaining(), 0);

    let ios_spec = scenario.ios.as_ref().unwrap();
    let mut expected = vec![
        CmdSpec::new(
            "pnpm-install",
            "pnpm",
            &["install", "--frozen-lockfile"],
            scenario.deadlines.install_deps_seconds,
        ),
        ios::create_spec(
            &ios::sim_name(&receipt.run_id),
            &ios_spec.device_type,
            &ios_spec.runtime,
        ),
        ios::bootstatus_spec("<udid>", scenario.deadlines.device_boot_seconds),
        metro::start_spec(&project, 8791),
        ios::install_app_spec("<udid>", &artifact),
        metro::request_probe_spec(8791),
        metro::manifest_spec(8791, "ios"),
    ];
    expected.extend(ios::lane_read_specs("<udid>"));
    expected.extend(ios::devmenu_defaults_specs("<udid>", &cache.app_id));
    expected.extend([
        ios::launch_spec("<udid>", &cache.app_id, 8791),
        ios::app_container_spec("<udid>", &cache.app_id),
        ios::launchctl_list_spec("<udid>"),
    ]);
    assert_eq!(
        receipt.planned_commands,
        expected.iter().map(CmdSpec::rendered).collect::<Vec<_>>()
    );
}

#[test]
fn dry_run_plans_generated_native_regeneration_before_every_build_route() {
    use qaren::buildplan::{save_json, state_path, BuildDecision, NativeCacheState, CACHE_SCHEMA};
    use qaren::scenario::{AndroidUsbSpec, IosWorkspaceBuild, Platform};
    for route in ["ios", "ios-workspace", "android-farm", "android-usb"] {
        for incomplete in [false, true] {
            for generated in [false, true] {
                let repo = common::temp_repo();
                let project = repo.join("test-app");
                let scenario_yaml = if route.starts_with("ios") {
                    ios_scenario_yaml(8791)
                } else {
                    common::android_scenario_yaml(8792)
                };
                let mut scenario = common::scenario_from(&scenario_yaml);
                scenario.deps.registry_auth_env = vec!["PRIVATE_REGISTRY_TOKEN".into()];
                let platform = if scenario.platform == Platform::Ios {
                    "ios"
                } else {
                    "android"
                };
                std::fs::create_dir_all(project.join(platform)).unwrap();
                let mut files = "test-app/package.json\0".to_string();
                if incomplete {
                    std::fs::write(project.join("app.config.js"), "module.exports = {};\n")
                        .unwrap();
                    files.push_str("test-app/app.config.js\0");
                }
                if !generated {
                    std::fs::write(project.join(platform).join("native-input"), "native").unwrap();
                    files.push_str(&format!("test-app/{platform}/native-input\0"));
                }
                if route == "ios-workspace" {
                    let workspace = project.join("ios/App.xcworkspace");
                    std::fs::create_dir_all(&workspace).unwrap();
                    std::fs::write(workspace.join("contents.xcworkspacedata"), "<Workspace/>")
                        .unwrap();
                    scenario.build.ios_workspace = Some(IosWorkspaceBuild {
                        workspace: "ios/App.xcworkspace".to_string(),
                        scheme: "App".to_string(),
                    });
                } else if route == "android-usb" {
                    scenario.android = None;
                    scenario.android_usb = Some(AndroidUsbSpec {
                        serial: "test-usb-device".to_string(),
                        adb_server_port: Some(15037),
                    });
                }
                let yaml = serde_yaml::to_string(&scenario).unwrap();
                let scenario_path = write_scenario(&repo, &yaml);
                let mut fp_runner = qaren::exec::MockRunner::new();
                fp_runner.expect_run("ls-files", CmdOutput::success(&files));
                if incomplete && platform == "ios" {
                    common::script_expo_fingerprint_unresolvable(&mut fp_runner);
                } else if platform == "ios" {
                    common::script_xcode(&mut fp_runner);
                }
                let fp = qaren::fingerprint::compute(&mut fp_runner, &repo, &project, platform)
                    .unwrap()
                    .with_ios_workspace(scenario.build.ios_workspace.as_ref());
                let cache = NativeCacheState {
                    schema: CACHE_SCHEMA.to_string(),
                    fingerprint_parts: Default::default(),
                    platform: platform.to_string(),
                    app_id: scenario.candidate.app_id.clone(),
                    worktree_root: repo.clone(),
                    fingerprint: if incomplete {
                        fp.value
                    } else {
                        "rnfp1:old".to_string()
                    },
                    built_at: "2026-10-05T00:00:00Z".to_string(),
                    candidate_sha: "b".repeat(40),
                    lockfile_sha256: "c".repeat(64),
                    generated_native_dirs: vec![platform.to_string()],
                    artifact: None,
                };
                save_json(
                    &state_path(&repo, platform, &scenario.candidate.app_id),
                    &cache,
                )
                .unwrap();
                let mut mock = MockRunner::new();
                let usb_tools = ["git", "pnpm", "node", "lsof", "curl", "ps", "java"];
                script_validation(
                    &mut mock,
                    &repo,
                    if platform == "ios" {
                        IOS_TOOLS
                    } else if route == "android-usb" {
                        &usb_tools
                    } else {
                        ANDROID_TOOLS
                    },
                );
                if route == "ios" {
                    mock.expect_run(
                        "expo run:ios --help",
                        CmdOutput::success(common::IOS_BUILD_HELP),
                    );
                }
                mock.expect_run("lsof", free_port());
                if platform == "android" {
                    mock.expect_run("lsof", free_port());
                }
                mock.expect_run("ls-files", CmdOutput::success(&files));
                if incomplete && platform == "ios" {
                    common::script_expo_fingerprint_unresolvable(&mut mock);
                } else if platform == "ios" {
                    common::script_xcode(&mut mock);
                }
                let sdk = (platform == "android").then(|| android_sdk(&repo));
                let receipt = prepare(
                    &mut mock,
                    &prepare_args(
                        &scenario_path,
                        true,
                        sdk.map(|path| path.to_string_lossy().into_owned()),
                    ),
                );
                assert_eq!(
                    receipt.result,
                    ReceiptResult::Planned,
                    "{route}: {:?}",
                    receipt.failure
                );
                assert_eq!(mock.remaining(), 0);
                let plan = receipt.build.unwrap();
                assert_eq!(
                    plan.decision,
                    if generated {
                        BuildDecision::Clean
                    } else {
                        BuildDecision::Incremental
                    }
                );
                assert_eq!(plan.regenerate_native_dir, generated);
                assert!(!receipt
                    .planned_commands
                    .join("\n")
                    .contains("PRIVATE_REGISTRY_TOKEN"));
                let prebuild = format!("pnpm exec expo prebuild --platform {platform} --clean");
                let regeneration: Vec<_> = receipt
                    .planned_commands
                    .iter()
                    .enumerate()
                    .filter(|(_, command)| **command == prebuild)
                    .collect();
                assert_eq!(
                    regeneration.len(),
                    usize::from(generated),
                    "{route}: {:?}",
                    receipt.planned_commands
                );
                if generated {
                    let compile = receipt
                        .planned_commands
                        .iter()
                        .position(|command| {
                            if route == "ios-workspace" {
                                command.starts_with("xcrun xcodebuild ")
                            } else {
                                command.starts_with(&format!("pnpm exec expo run:{platform} "))
                            }
                        })
                        .unwrap();
                    assert!(regeneration[0].0 < compile);
                }
                assert!(!mock.calls.iter().any(|spec| spec.label == "expo-prebuild"));
                assert!(!repo.join(".locks").exists());
            }
        }
    }
}

#[test]
fn revision_pin_mismatch_fails_validation() {
    let repo = common::temp_repo();
    let yaml =
        ios_scenario_yaml(8791).replace("revision: HEAD", &format!("revision: {}", "d".repeat(40)));
    let scenario_path = write_scenario(&repo, &yaml);

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateRevisionMismatch
    );
}

#[test]
fn a_build_that_outlives_the_window_is_still_stopped_and_releases_the_lock() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 30\n",
            ios_scenario_yaml(8791)
        ),
    );
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    mock.expect_spawn_piped("expo run:ios", 5000, "", None);
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    // Teardown after the window expired: inventory, TERM, KILL, then proven absence.
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n5000 5000 S\n"));
    mock.expect_run("ps -p 5000 -o lstart=", CmdOutput::success(LSTART));
    mock.expect_run("ps -p 5000 -o stat=", CmdOutput::success("S"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -TERM -- -5000", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill -KILL -- -5000", CmdOutput::success(""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    let args = prepare_args(&scenario_path, false, None);

    let receipt = prepare(&mut mock, &args);

    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::BuildFailed, "{failure:?}");
    assert_eq!(
        failure.build_recovery().unwrap().reason,
        qaren::failure::RecoveryReason::BuildBudgetExhausted
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.build_process().is_none(), "build stopped");
    assert!(record.resources.build_lock.is_none());
    assert!(!args.lock_root.join("native-build-ios").exists());
}

#[test]
fn build_budget_expiry_after_build_releases_lock_without_publication() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    mock.expect_spawn_piped("expo run:ios", 5000, "", Some(0));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.advance_on = Some(("ps -A".into(), 2_400_000));
    let args = prepare_args(&scenario_path, false, None);
    let receipt = prepare(&mut mock, &args);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.unwrap();
    assert_eq!(failure.code, FailureCode::BuildFailed);
    assert_eq!(
        failure.build_recovery().unwrap().reason,
        qaren::failure::RecoveryReason::BuildBudgetExhausted
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.build_lock.is_none());
    assert!(!args.lock_root.join("native-build-ios").exists());
    assert!(!qaren::buildplan::state_path(
        &record.candidate.repo_root,
        "ios",
        &record.candidate.app_id
    )
    .exists());
    let plan = record.build.unwrap();
    assert!(plan.artifact.is_none());
    assert!(!qaren::buildplan::store_dir(
        &args.native_cache_root,
        "ios",
        &record.candidate.app_id,
        &plan.fingerprint
    )
    .join("artifact.json")
    .exists());
    assert!(!mock.calls.iter().any(|call| call.label == "ios-app-info"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn build_process_death_fails_with_log_evidence() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run("simctl bootstatus", CmdOutput::success(""));
    mock.build_log = Some("CommandError: xcodebuild exited with error code 65\n".into());
    mock.expect_spawn_piped("expo run:ios", 5000, "", Some(65));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(!receipt.cleanup.contains_key("metro"));
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::BuildFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "cleanup must be the next action"
    );
    assert!(
        failure
            .evidence
            .iter()
            .any(|e| e.contains("xcodebuild exited with error code 65")),
        "the receipt must carry build log evidence: {:?}",
        failure.evidence
    );
    assert_eq!(mock.remaining(), 0, "the liveness probe must have run");
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(record.resources.build_lock.is_none());
    assert!(!prepare_args(&scenario_path, false, None)
        .lock_root
        .join("native-build-ios")
        .exists());
    assert!(
        record.resources.metro.is_none(),
        "Metro never starts before the build is published"
    );
    assert!(
        record.resources.ios_simulator.is_some(),
        "sim must stay recorded for cleanup"
    );
}

#[test]
fn recording_a_build_retires_run_output_and_publishes_to_the_machine_store_without_pruning() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deps:\n  registry_auth_env: [PRIVATE_REGISTRY_TOKEN]\n",
            ios_scenario_yaml(8797)
        ),
    );
    let retained_caches = ["test-app/ios/Pods/cached", "DerivedData/cached"];
    for cache in retained_caches {
        let path = repo.join(cache);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"retained cache").unwrap();
    }

    let products = repo
        .join("test-app")
        .join("ios")
        .join("build")
        .join("Build")
        .join("Products")
        .join("Debug-iphonesimulator");
    std::fs::create_dir_all(products.join("testapp.app")).unwrap();
    std::fs::write(products.join("testapp.app").join("binary"), b"native bits").unwrap();

    let store_root = scenario_path.parent().unwrap().join(".native-store");
    let older = repo.join("older.app");
    std::fs::create_dir_all(&older).unwrap();
    std::fs::write(older.join("binary"), b"old bits").unwrap();
    let older = common::seed_store(
        &store_root,
        "ios",
        &format!("rnfp1:{}", "a".repeat(64)),
        &older,
        qaren::buildplan::ArtifactKind::AppBundle,
    );

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    // The ios/ dir is generated (untracked), so a clean build regenerates it.
    mock.expect_spawn_piped("expo prebuild", 5000, "", Some(0));
    mock.expect_run("ps", CmdOutput::success(LSTART));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    script_ios_prepublish(&mut mock, "", |m| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    });
    common::script_ios_after_publish(
        &mut mock,
        CmdOutput::success(""),
        |m| m.expect_run("simctl install", CmdOutput::success("")),
        common::script_ios_launch,
    );
    script_ios_readiness(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: format!(
            "ios-simulator-{}",
            qaren::timefmt::compact_utc(1_770_000_000_000)
        ),
        probe_label: "simctl-install".into(),
        observed: None,
        cancel_copy: None,
        copied_bytes: std::cell::Cell::new(0),
        at_probe: Some(Box::new(|run_dir| {
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            let artifact = record.build.unwrap().artifact.unwrap();
            assert_eq!(
                qaren::buildplan::hash_artifact(&artifact.path).unwrap(),
                artifact.sha256
            );
        })),
    };
    let receipt = prepare(&mut probing, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );

    let state = match qaren::buildplan::load_state(&repo, "ios", "com.rndevagent.testapp") {
        qaren::buildplan::StateStatus::Loaded(state) => state,
        other => panic!("expected recorded cache state, got {other:?}"),
    };
    let cached = &common::stored_record(&store_root, "ios", &state.fingerprint)
        .unwrap()
        .artifact;
    assert!(cached.path.starts_with(&store_root));
    assert!(cached.path.exists(), "the new artifact must survive");
    let reported = receipt.build.as_ref().unwrap().artifact.as_ref().unwrap();
    assert_eq!(reported.path, cached.path);
    assert_eq!(reported.sha256, cached.sha256);
    let installed_record: RunRecord =
        serde_json::from_str(probing.observed.as_ref().unwrap()).unwrap();
    assert!(installed_record.resources.build_process().is_none());
    let installed = installed_record.build.unwrap().artifact.unwrap();
    assert_eq!(cached.sha256, installed.sha256);
    assert_eq!(
        cached.sha256,
        qaren::buildplan::hash_artifact(&cached.path).unwrap()
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.build.unwrap().artifact.as_ref(), Some(cached));
    let install = probing
        .inner
        .calls
        .iter()
        .find(|c| c.label == "simctl-install")
        .unwrap();
    assert_eq!(installed.path, std::path::Path::new(&install.args[3]));
    assert!(
        !RunRecord::run_dir(&repo, &receipt.run_id)
            .join("ios-build")
            .exists(),
        "the run-owned output must retire after its verified cache copy is published"
    );
    assert_ne!(
        cached.sha256,
        qaren::buildplan::hash_artifact(&products.join("testapp.app")).unwrap()
    );
    assert_eq!(
        qaren::buildplan::hash_artifact(&older.path).unwrap(),
        older.sha256,
        "another fingerprint's stored build is never pruned"
    );
    assert_eq!(probing.inner.remaining(), 0);
    let prebuilds: Vec<_> = probing
        .inner
        .calls
        .iter()
        .filter(|spec| spec.label == "expo-prebuild")
        .collect();
    common::assert_registry_specs(&probing.inner.calls);
    assert_eq!(prebuilds.len(), 1);
    assert_eq!(prebuilds[0].program, "/bin/bash");
    assert_eq!(
        prebuilds[0].args[5..],
        [
            "pnpm",
            "exec",
            "expo",
            "prebuild",
            "--platform",
            "ios",
            "--clean"
        ]
    );
    for cache in retained_caches {
        assert_eq!(std::fs::read(repo.join(cache)).unwrap(), b"retained cache");
    }
}

#[test]
fn recording_a_build_retains_source_on_cache_or_evidence_publication_failure() {
    for fault in ["copy", "hash", "cache_save", "record_save"] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        match fault {
            // A source altered after verification is refused at install, never installed.
            "hash" | "record_save" => {
                script_prepare_to_prepublish(&mut mock, &repo, "", "");
                mock.expect_run("ls-files", CmdOutput::success(""));
                common::script_xcode(&mut mock);
                if fault == "hash" {
                    common::script_ios_app_verification(&mut mock);
                }
            }
            _ => {
                script_prepare_to_recheck(&mut mock, &repo, "", "");
                mock.expect_run("ls-files", CmdOutput::success(""));
                common::script_xcode(&mut mock);
            }
        }
        let mut probing = RecordProbeRunner {
            inner: mock,
            repo: repo.clone(),
            run_id: format!(
                "ios-simulator-{}",
                qaren::timefmt::compact_utc(1_770_000_000_000)
            ),
            // The provenance recheck under the lock, after verification and before publication.
            probe_label: "git-head#2".into(),
            observed: None,
            cancel_copy: None,
            copied_bytes: std::cell::Cell::new(0),
            at_probe: Some(Box::new(move |run_dir| {
                let repo = run_dir.parent().unwrap();
                let cache = qaren::buildplan::cache_dir(repo);
                std::fs::create_dir_all(&cache).unwrap();
                match fault {
                    "copy" => {
                        std::fs::write(repo.join(".native-store"), b"not a directory").unwrap()
                    }
                    "hash" => std::fs::write(
                        run_dir.join("ios-build/testapp.app/binary"),
                        b"changed after verification",
                    )
                    .unwrap(),
                    "cache_save" => std::fs::create_dir(qaren::buildplan::state_path(
                        repo,
                        "ios",
                        "com.rndevagent.testapp",
                    ))
                    .unwrap(),
                    "record_save" => std::fs::create_dir(
                        run_dir.join(format!(".run.json.tmp.{}", std::process::id())),
                    )
                    .unwrap(),
                    _ => unreachable!(),
                }
            })),
        };
        let receipt = prepare(&mut probing, &prepare_args(&scenario, false, None));
        assert_eq!(
            receipt.result,
            if matches!(fault, "hash" | "record_save") {
                ReceiptResult::Failed
            } else {
                ReceiptResult::Ready
            },
            "{fault}"
        );
        assert!(
            !probing
                .inner
                .calls
                .iter()
                .any(|c| c.label == "simctl-install")
                || !matches!(fault, "hash" | "record_save"),
            "{fault}"
        );
        let source = RunRecord::run_dir(&repo, &receipt.run_id).join("ios-build/testapp.app");
        assert!(
            source.is_dir(),
            "{fault}: source must survive failed publication"
        );
        assert_eq!(
            receipt
                .build
                .as_ref()
                .unwrap()
                .artifact
                .as_ref()
                .unwrap()
                .path,
            source,
            "{fault}"
        );
        let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
        assert_eq!(
            record.build.unwrap().artifact.unwrap().path,
            source,
            "{fault}"
        );
        let outcome = match fault {
            "copy" | "hash" => "artifact_cache",
            "cache_save" => "native_cache_state",
            "record_save" => "ios_build_output",
            _ => unreachable!(),
        };
        assert!(receipt.outcomes.contains_key(outcome), "{fault}");
        assert_eq!(probing.inner.remaining(), 0, "{fault}");
    }
}

#[test]
fn recording_a_build_does_not_retire_symlinked_paths() {
    for target in ["run", "output", "app"] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        // A symlinked app bundle is retained but refused at install.
        if target == "app" {
            script_prepare_to_prepublish(&mut mock, &repo, "", "");
        } else {
            script_prepare_to_recheck(&mut mock, &repo, "", "");
        }
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut probing = RecordProbeRunner {
            inner: mock,
            repo: repo.clone(),
            run_id: format!(
                "ios-simulator-{}",
                qaren::timefmt::compact_utc(1_770_000_000_000)
            ),
            probe_label: "git-head#2".into(),
            observed: None,
            cancel_copy: None,
            copied_bytes: std::cell::Cell::new(0),
            at_probe: Some(Box::new(move |run_dir| {
                let path = match target {
                    "run" => run_dir.to_path_buf(),
                    "output" => run_dir.join("ios-build"),
                    "app" => run_dir.join("ios-build/testapp.app"),
                    _ => unreachable!(),
                };
                let elsewhere = run_dir.parent().unwrap().join("not-run-owned");
                std::fs::rename(&path, &elsewhere).unwrap();
                std::os::unix::fs::symlink(&elsewhere, &path).unwrap();
            })),
        };
        let receipt = prepare(&mut probing, &prepare_args(&scenario, false, None));
        if target == "app" {
            assert_eq!(
                receipt.failure.as_ref().map(|f| f.code),
                Some(FailureCode::ArtifactInstallFailed)
            );
            assert!(!probing
                .inner
                .calls
                .iter()
                .any(|c| c.label == "simctl-install"));
        } else {
            assert_eq!(receipt.result, ReceiptResult::Ready, "{target}");
        }
        let run_dir = RunRecord::run_dir(&repo, &receipt.run_id);
        let source = run_dir.join("ios-build/testapp.app");
        assert!(
            source.join("binary").is_file(),
            "{target}: must not delete through a symlink"
        );
        let link = match target {
            "run" => run_dir,
            "output" => run_dir.join("ios-build"),
            "app" => source,
            _ => unreachable!(),
        };
        assert!(
            std::fs::symlink_metadata(link).unwrap().is_symlink(),
            "{target}"
        );
        assert!(repo.join("not-run-owned").is_dir(), "{target}");
        assert_eq!(probing.inner.remaining(), 0, "{target}");
    }
}

#[test]
fn unproven_or_unpersisted_build_group_absence_retains_run_output() {
    for fault in ["unknown_group", "retirement_save"] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run("lsof", free_port());
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("qaren prepare"));
        common::script_ios_deps(&mut mock);
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        mock.expect_run("simctl create", CmdOutput::success(UDID));
        mock.expect_run("simctl bootstatus", CmdOutput::success(""));
        mock.expect_spawn_piped("expo run:ios", 5000, "", Some(0));
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("qaren-build"));
        mock.expect_run(
            "ps -A",
            if fault == "unknown_group" {
                CmdOutput::failed(1, "inventory unavailable")
            } else {
                CmdOutput::success("1 1 S\n")
            },
        );
        let mut probing = RecordProbeRunner {
            inner: mock,
            repo: repo.clone(),
            run_id: format!(
                "ios-simulator-{}",
                qaren::timefmt::compact_utc(1_770_000_000_000)
            ),
            probe_label: "ps-groups".into(),
            observed: None,
            cancel_copy: None,
            copied_bytes: std::cell::Cell::new(0),
            at_probe: Some(Box::new(move |run_dir| {
                if fault == "retirement_save" {
                    std::fs::create_dir(
                        run_dir.join(format!(".run.json.tmp.{}", std::process::id())),
                    )
                    .unwrap();
                }
            })),
        };
        let receipt = prepare(&mut probing, &prepare_args(&scenario, false, None));
        assert_eq!(receipt.result, ReceiptResult::Failed, "{fault}");
        assert_eq!(
            receipt.outcomes["build_lock_release"],
            "retained: the build group is not proven gone"
        );
        let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
        assert!(record.resources.build_process().is_some(), "{fault}");
        assert!(
            record.resources.build_lock.unwrap().lock_dir.is_dir(),
            "{fault}"
        );
        assert!(
            RunRecord::run_dir(&repo, &receipt.run_id)
                .join("ios-build/testapp.app/binary")
                .is_file(),
            "{fault}"
        );
        assert!(matches!(
            qaren::buildplan::load_state(&repo, "ios", "com.rndevagent.testapp"),
            qaren::buildplan::StateStatus::Missing
        ));
        assert!(!probing
            .inner
            .calls
            .iter()
            .any(|spec| spec.label == "simctl-install"));
        assert_eq!(probing.inner.remaining(), 0, "{fault}");
    }
}

#[test]
fn android_build_route_records_install_provenance_from_the_hashed_apk() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deps:\n  registry_auth_env: [PRIVATE_REGISTRY_TOKEN]\n",
            common::android_scenario_yaml(8792)
        ),
    );
    let sdk = android_sdk(&repo);
    let retained_caches = [
        "test-app/android/build/cached",
        "test-app/android/app/build/cached",
        "test-app/android/.gradle/cached",
        "gradle-cache/cached",
    ];
    for cache in retained_caches {
        let path = repo.join(cache);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"retained cache").unwrap();
    }
    let apk = repo
        .join("test-app")
        .join("android")
        .join("app")
        .join("build")
        .join("outputs")
        .join("apk")
        .join("debug")
        .join("app-debug.apk");
    std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
    std::fs::write(&apk, b"apk bits").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n",
        ),
    );
    mock.expect_run("lsof", free_port());
    let expected_holder = format!(
        "qaren-nuc-android-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run(
        "connect 127.0.0.1:5555",
        CmdOutput::success("connected to 127.0.0.1:5555\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    // The android/ dir is generated (untracked), so a clean build regenerates it.
    mock.expect_run("expo prebuild", CmdOutput::success(""));
    mock.expect_spawn(
        "expo run:android",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:android\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    let install = record
        .resources
        .app_install
        .as_ref()
        .expect("a ready build through the run's own adb server is install provenance");
    assert_eq!(install.app_id, "com.rndevagent.testapp");
    assert_eq!(install.serial, "127.0.0.1:5555");
    assert_eq!(install.server_port, 15037);
    assert_eq!(install.via, "expo-run-android");
    assert_eq!(
        install.artifact.sha256,
        qaren::candidate::sha256_hex(b"apk bits"),
        "the provenance hash is the hash of the artifact this run built and installed"
    );
    assert_eq!(install.artifact.kind, qaren::buildplan::ArtifactKind::Apk);
    assert!(!install.installed_at.is_empty());
    assert!(install.removal.is_none());
    let prebuilds: Vec<_> = mock
        .calls
        .iter()
        .filter(|spec| spec.label == "expo-prebuild")
        .collect();
    common::assert_registry_specs(&mock.calls);
    assert_eq!(prebuilds.len(), 1);
    assert_eq!(prebuilds[0].program, "pnpm");
    assert_eq!(
        prebuilds[0].args,
        [
            "exec",
            "expo",
            "prebuild",
            "--platform",
            "android",
            "--clean"
        ]
    );
    for cache in retained_caches {
        assert_eq!(std::fs::read(repo.join(cache)).unwrap(), b"retained cache");
    }
}

#[test]
fn recording_a_build_cancelled_mid_copy_preserves_previous_cache() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let run_id = format!(
        "ios-simulator-{}",
        qaren::timefmt::compact_utc(1_770_000_000_000)
    );
    let staged_binary = std::rc::Rc::new(std::cell::RefCell::new(std::path::PathBuf::new()));
    let copy_path = staged_binary.clone();
    let store_root = scenario.parent().unwrap().join(".native-store");
    let probe_store = store_root.clone();
    let previous = std::rc::Rc::new(std::cell::RefCell::new(std::path::PathBuf::new()));
    let previous_path = previous.clone();
    let saved_state = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let expected_state = saved_state.clone();
    let state_path = qaren::buildplan::state_path(&repo, "ios", "com.rndevagent.testapp");
    let mut mock = MockRunner::new();
    script_prepare_to_prepublish(&mut mock, &repo, "", "");
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "git-head#2".into(),
        observed: None,
        cancel_copy: Some(staged_binary),
        copied_bytes: std::cell::Cell::new(0),
        at_probe: Some(Box::new(move |run_dir| {
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            let fp = record.build.as_ref().unwrap().fingerprint.clone();
            let root = record.candidate.repo_root.clone();
            *copy_path.borrow_mut() =
                qaren::buildplan::store_dir(&probe_store, "ios", "com.rndevagent.testapp", &fp)
                    .join(".pending")
                    .join("testapp.app/binary");
            std::fs::write(
                run_dir.join("ios-build/testapp.app/binary"),
                vec![7u8; 2 * 1024 * 1024],
            )
            .unwrap();
            let old_source = root.join("previous.app");
            std::fs::create_dir(&old_source).unwrap();
            std::fs::write(old_source.join("binary"), b"previous build").unwrap();
            let store = qaren::buildplan::open_native_store_root(&probe_store, true)
                .unwrap()
                .unwrap();
            let bucket =
                qaren::buildplan::store_dir(&probe_store, "ios", "com.rndevagent.testapp", &fp);
            let entry = store
                .entry(bucket.strip_prefix(&probe_store).unwrap(), true)
                .unwrap()
                .unwrap();
            let old = entry
                .copy_app(
                    &qaren::exec::MockRunner::new(),
                    &old_source,
                    std::ffi::OsStr::new("previous"),
                    &qaren::buildplan::hash_artifact(&old_source).unwrap(),
                )
                .unwrap()
                .retain()
                .path;
            let state = qaren::buildplan::NativeCacheState {
                schema: qaren::buildplan::CACHE_SCHEMA.into(),
                fingerprint_parts: Default::default(),
                platform: "ios".into(),
                app_id: "com.rndevagent.testapp".into(),
                worktree_root: root.clone(),
                fingerprint: fp,
                built_at: "previous".into(),
                candidate_sha: record.candidate.git_sha,
                lockfile_sha256: String::new(),
                generated_native_dirs: Vec::new(),
                artifact: None,
            };
            let path = qaren::buildplan::state_path(&root, "ios", "com.rndevagent.testapp");
            qaren::buildplan::save_json(&path, &state).unwrap();
            *expected_state.borrow_mut() = std::fs::read(path).unwrap();
            *previous_path.borrow_mut() = old;
        })),
    };
    let receipt = prepare(&mut probing, &prepare_args(&scenario, false, None));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunCancelled
    );
    assert!(probing.copied_bytes.get() > 0 && probing.copied_bytes.get() < 2 * 1024 * 1024);
    assert_eq!(
        std::fs::read(previous.borrow().join("binary")).unwrap(),
        b"previous build"
    );
    assert_eq!(std::fs::read(&state_path).unwrap(), *saved_state.borrow());
    let staged = probing.cancel_copy.as_ref().unwrap().borrow();
    let staging_dir = staged.parent().unwrap().parent().unwrap();
    assert!(!staging_dir.exists());
    assert!(!staging_dir
        .parent()
        .unwrap()
        .join(qaren::buildplan::STORE_RECORD)
        .exists());
    assert!(!staging_dir.parent().unwrap().join(&run_id).exists());
    let record = RunRecord::load(&repo, &run_id).unwrap();
    assert!(record
        .build
        .unwrap()
        .artifact
        .unwrap()
        .path
        .starts_with(RunRecord::run_dir(&repo, &run_id)));
    assert_eq!(probing.inner.remaining(), 0);
}

#[test]
fn dry_run_reports_hash_only_parts_and_the_completeness_gate_without_its_reasons() {
    const CANARY: &str = "qaren-canary-private-pkg-5c1d";
    for (files, complete) in [
        ("test-app/package.json\0", true),
        ("test-app/package.json\0test-app/app.json\0", false),
    ] {
        let repo = common::temp_repo();
        let project = repo.join("test-app");
        std::fs::write(
            project.join("app.json"),
            format!("{{\"expo\":{{\"icon\":\"./{CANARY}/icon.png\"}}}}"),
        )
        .unwrap();
        let yaml = ios_scenario_yaml(8791);
        let scenario_path = write_scenario(&repo, &yaml);
        let mut fp_runner = qaren::exec::MockRunner::new();
        fp_runner.expect_run("ls-files", CmdOutput::success(files));
        common::script_xcode(&mut fp_runner);
        let fp = qaren::fingerprint::compute(&mut fp_runner, &repo, &project, "ios").unwrap();
        assert_eq!(fp.complete, complete);
        assert_eq!(
            fp.incompleteness
                .iter()
                .any(|reason| reason.contains(CANARY)),
            !complete,
            "the canary must reach the withheld reasons"
        );

        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run(
            "expo run:ios --help",
            CmdOutput::success(common::IOS_BUILD_HELP),
        );
        mock.expect_run("lsof", free_port());
        mock.expect_run("ls-files", CmdOutput::success(files));
        common::script_xcode(&mut mock);
        let receipt = prepare(&mut mock, &prepare_args(&scenario_path, true, None));

        assert_eq!(receipt.result, ReceiptResult::Planned);
        assert_eq!(mock.remaining(), 0);
        assert_eq!(
            receipt.build.as_ref().unwrap().fingerprint,
            fp.value,
            "the dry run plans with the same fingerprint the gate computes"
        );
        assert_eq!(
            receipt
                .outcomes
                .get("fingerprint_complete")
                .map(String::as_str),
            Some(complete.to_string().as_str())
        );
        let parts = fp
            .parts
            .iter()
            .map(|(part, hash)| format!("{part}={hash}"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(receipt.outcomes.get("fingerprint_parts"), Some(&parts));
        let json = serde_json::to_string(&receipt).unwrap();
        assert!(!json.contains(CANARY), "{json}");
    }
}

#[test]
fn dry_run_records_static_expo_fallback_without_forbidding_reuse() {
    const CANARY: &str = "qaren-private-expo-failure-7f28";
    let repo = common::temp_repo();
    std::fs::write(
        repo.join("test-app/package.json"),
        r#"{"dependencies":{"expo":"56.0.23"}}"#,
    )
    .unwrap();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success("test-app/package.json\0"));
    mock.advance_on = Some(("require.resolve".to_string(), 243));
    mock.expect_run("require.resolve", CmdOutput::failed(1, CANARY));
    common::script_xcode(&mut mock);
    let receipt = prepare(&mut mock, &prepare_args(&scenario, true, None));
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        receipt
            .outcomes
            .get("fingerprint_complete")
            .map(String::as_str),
        Some("true")
    );
    assert_eq!(
        receipt
            .outcomes
            .get("expo_fingerprint_ms")
            .map(String::as_str),
        Some("243")
    );
    assert_eq!(
        receipt
            .outcomes
            .get("expo_fingerprint_unavailable")
            .map(String::as_str),
        Some("@expo/fingerprint does not resolve through the app's expo install (exit 1)")
    );
    assert!(!serde_json::to_string(&receipt).unwrap().contains(CANARY));
}

#[test]
fn dry_run_total_timing_includes_the_fingerprint_computation() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    mock.advance_on = Some(("ls-files".to_string(), 4_434));
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success("test-app/package.json\0"));
    common::script_xcode(&mut mock);
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, true, None));

    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.timings_ms.get("total"), Some(&4_434));
}

#[test]
fn prepare_keeps_scenario_deadlines_when_app_config_disagrees() {
    let conflicting = "appId: com.rndevagent.testapp\ndevClientScheme: rndatest\ndeadlines:\n  install_deps_seconds: 30\n  build_seconds: 31\n  device_boot_seconds: 32\n";
    let explicit = format!(
        "{}deadlines:\n  build_seconds: 5400\n",
        ios_scenario_yaml(8791)
    );
    for (yaml, deps, build, boot) in [
        (explicit, 900, 5400, 420),
        (ios_scenario_yaml(8791), 900, 2400, 420),
    ] {
        let repo = common::temp_repo();
        let config_dir = repo.join("test-app/.qaren");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.yaml"), conflicting).unwrap();
        let scenario = write_scenario(&repo, &yaml);
        let mut mock = MockRunner::new();
        script_ios_prepare(&mut mock, &repo, CmdOutput::success(""));
        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));
        assert_eq!(
            receipt.result,
            ReceiptResult::Ready,
            "{}",
            receipt.to_json()
        );
        assert_eq!(mock.remaining(), 0);
        let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
        assert_eq!(record.scenario.deadlines.install_deps_seconds, deps);
        assert_eq!(record.scenario.deadlines.build_seconds, build);
        assert_eq!(record.scenario.deadlines.device_boot_seconds, boot);
        let timeout = |label: &str| {
            mock.calls
                .iter()
                .find(|call| call.label == label)
                .unwrap()
                .timeout_seconds
        };
        assert_eq!(timeout("pnpm-install"), deps);
        assert_eq!(timeout("expo-run-ios"), build);
        assert_eq!(timeout("simctl-bootstatus"), boot);
        assert_eq!(
            std::fs::read_to_string(config_dir.join("config.yaml")).unwrap(),
            conflicting
        );
    }
}

const BORROWED: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";

fn borrowed_inventory(state: &str) -> String {
    serde_json::json!({"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-26-4": [{
        "udid": BORROWED,
        "name": "qa-lane",
        "state": state,
        "isAvailable": true,
        "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    }]}})
    .to_string()
}

fn borrowed_args(scenario_path: &std::path::Path, boot_device: bool) -> PrepareArgs {
    let mut args = prepare_args(scenario_path, false, None);
    args.device = Some(BORROWED.to_string());
    args.boot_device = boot_device;
    args.new_device = false;
    args
}

fn clear_admission() -> CmdOutput {
    CmdOutput::success(
        &serde_json::json!({"v":1,"platform":"ios","deviceId":BORROWED,"status":"clear"})
            .to_string(),
    )
}

fn script_borrowed_until_lease(mock: &mut MockRunner, repo: &std::path::Path, state: &str) {
    script_validation(mock, repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory(state)),
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n")); // self command
}

// Everything a borrowed prepare runs up to (not including) the explicit boot stage.
fn script_borrowed_until_boot(mock: &mut MockRunner, repo: &std::path::Path, state: &str) {
    script_borrowed_until_lease(mock, repo, state);
    mock.expect_run("lsof", free_port()); // Metro port, checked under the lease
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory(state)),
    );
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        clear_admission(),
    );
    common::script_ios_deps(mock);
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        clear_admission(),
    );
}

fn script_borrowed_after_boot(mock: &mut MockRunner, before_install: &str) {
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    script_borrowed_after_plan(mock, before_install);
}

fn script_borrowed_after_plan(mock: &mut MockRunner, before_install: &str) {
    let empty = |m: &mut MockRunner| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    };
    script_borrowed_build(mock);
    mock.expect_run("simctl list devices -j", CmdOutput::success(before_install));
    mock.expect_run("simctl install", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    common::script_devmenu_defaults(mock, CmdOutput::success(""));
    common::script_ios_launch(mock);
    script_ios_readiness(mock);
    empty(mock);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
}

fn script_borrowed_build(mock: &mut MockRunner) {
    common::script_finite_ios_build_only(mock, "expo run:ios");
    script_ios_prepublish(mock, "", |m| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    });
    common::script_ios_app_verification(mock);
    common::script_ios_metro_spawn(mock);
}

fn replace_borrowed_lease_on(mock: &mut MockRunner, repo: &std::path::Path, command: &'static str) {
    let lock = repo.join(".locks").join(qaren::lease::lock_name(
        qaren::scenario::Platform::Ios,
        BORROWED,
    ));
    mock.observe = Some(Box::new(move |spec| {
        if spec.rendered().contains(command) {
            let mut holder = qaren::buildplan::read_holder(&lock).unwrap();
            holder.run_id = "replacement-run".to_string();
            holder.holder = "replacement-holder".to_string();
            qaren::buildplan::save_json(&lock.join("holder.json"), &holder).unwrap();
        }
    }));
}

// Every device effect happens while the durable record names this run's lease and the borrowed target.
fn observe_borrowed_custody(mock: &mut MockRunner, runs_root: &std::path::Path) {
    let runs_root = runs_root.to_path_buf();
    mock.observe = Some(Box::new(move |spec: &qaren::exec::CmdSpec| {
        if !matches!(
            spec.label.as_str(),
            "fresh-install-admission"
                | "pnpm-install"
                | "simctl-bootstatus"
                | "simctl-install"
                | "simctl-launch"
        ) {
            return;
        }
        let run = std::fs::read_dir(&runs_root)
            .unwrap()
            .filter_map(Result::ok)
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("ios-simulator-")
            })
            .expect("run directory claimed before any effect");
        let record = RunRecord::load(&runs_root, &run.file_name().to_string_lossy()).unwrap();
        assert!(record.resources.device_borrowed, "{}", spec.label);
        assert_eq!(
            record.resources.ios_simulator.as_ref().unwrap().udid,
            BORROWED
        );
        let lease = record.resources.lease.as_ref().expect("lease recorded");
        let holder = qaren::buildplan::read_holder(&lease.lock_dir).expect("lease held");
        assert_eq!(holder.run_id, record.run_id);
        assert_eq!(holder.holder, lease.holder);
        assert_eq!(
            lease.lock_dir.file_name().unwrap().to_string_lossy(),
            qaren::lease::lock_name(qaren::scenario::Platform::Ios, BORROWED)
        );
    }));
}

fn labels(mock: &MockRunner) -> Vec<String> {
    mock.calls.iter().map(|c| c.label.clone()).collect()
}

fn script_cap_fallback_tail(mock: &mut MockRunner) {
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));
}

fn assert_cap_fallback(repo: &std::path::Path, receipt: &qaren::receipt::Receipt, reason: &str) {
    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{}",
        receipt.to_json()
    );
    let outcome = &receipt.outcomes["device_pool"];
    assert!(
        outcome.starts_with("fresh: the QaReN simulator pool is at ios.max_devices 1 and "),
        "{outcome}"
    );
    assert!(outcome.contains(reason), "{outcome}");
    let record = RunRecord::load(repo, &receipt.run_id).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().name,
        format!("qaren-{}", receipt.run_id)
    );
    assert!(record.resources.lease.is_none());
    assert!(!record.resources.device_borrowed);
    assert!(record.resources.pool_create_lock.is_none());
}

fn assert_no_simulator_power(mock: &MockRunner) {
    for call in &mock.calls {
        let rendered = call.rendered();
        for verb in [
            "create",
            "boot ",
            "bootstatus",
            "shutdown",
            "delete",
            "erase",
        ] {
            assert!(!rendered.contains(&format!("simctl {verb}")), "{rendered}");
        }
    }
}

fn assert_borrowed_status_and_cleanup(repo: &std::path::Path, run_id: &str) {
    let record = RunRecord::load(repo, run_id).unwrap();
    let lock = record.resources.lease.as_ref().unwrap().lock_dir.clone();
    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    let receipt = qaren::commands::status::status(&mut mock, repo, run_id);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);

    mock.expect_run("ps", CmdOutput::failed(1, "")); // prepare owner exited
    common::script_ios_metro_cleanup(&mut mock);
    let receipt = qaren::commands::cleanup::cleanup(&mut mock, repo, run_id);
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert!(!lock.exists());
    assert_eq!(RunRecord::load(repo, run_id).unwrap().phase, Phase::Cleaned);
    assert_no_simulator_power(&mock);
    assert_eq!(mock.remaining(), 0);
}

fn assert_no_borrowed_effects(mock: &MockRunner, repo: &std::path::Path) {
    assert!(!labels(mock).iter().any(|l| matches!(
        l.as_str(),
        "pnpm-install" | "fresh-install-admission" | "expo-run-ios" | "simctl-install"
    )));
    assert_no_simulator_power(mock);
    assert!(!repo
        .join(".locks")
        .join(qaren::lease::lock_name(
            qaren::scenario::Platform::Ios,
            BORROWED
        ))
        .exists());
    assert!(!std::fs::read_dir(repo)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("ios-simulator-")));
}

#[test]
fn borrowed_booted_simulator_is_prepared_under_the_lease_without_creating_or_powering_it() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_boot(&mut mock, &repo, "Booted");
    script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));
    observe_borrowed_custody(&mut mock, &repo);

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_no_simulator_power(&mock);
    let device = receipt.device.as_ref().unwrap();
    assert_eq!(device.ios_udid.as_deref(), Some(BORROWED));
    assert_eq!(device.ios_name.as_deref(), Some("qa-lane"));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    assert!(record.resources.device_borrowed);
    assert_eq!(
        serde_json::to_value(&record).unwrap()["resources"]["borrowed_ios_stop"],
        serde_json::Value::Null,
        "prepare never arms a simulator stop"
    );
    let lease = record.resources.lease.as_ref().unwrap();
    assert_eq!(
        qaren::buildplan::read_holder(&lease.lock_dir)
            .unwrap()
            .run_id,
        receipt.run_id,
        "Ready retains the device lease for later cleanup"
    );
    for label in ["simctl-install", "simctl-launch"] {
        let call = mock.calls.iter().find(|c| c.label == label).unwrap();
        assert!(call.args.contains(&BORROWED.to_string()), "{label}");
    }
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-ios")
        .unwrap();
    let device_pos = build.args.iter().position(|a| a == "--device").unwrap();
    assert_eq!(build.args[device_pos + 1], "generic");
    assert_eq!(
        labels(&mock)
            .iter()
            .filter(|l| *l == "fresh-install-admission")
            .count(),
        2
    );
    assert_borrowed_status_and_cleanup(&repo, &receipt.run_id);
}

#[test]
fn borrowed_shutdown_simulator_without_boot_permission_refuses_before_any_custody() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Shutdown")),
    );

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert_eq!(mock.remaining(), 0);
    assert_no_borrowed_effects(&mock, &repo);
}

#[test]
fn borrowed_shutdown_simulator_with_boot_permission_boots_it_once_under_the_lease() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_boot(&mut mock, &repo, "Shutdown");
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Shutdown")),
    );
    mock.expect_run(
        &format!("simctl bootstatus {BORROWED} -b"),
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));
    observe_borrowed_custody(&mut mock, &repo);

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, true));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let position = |label: &str| labels(&mock).iter().position(|l| l == label).unwrap();
    assert!(position("pnpm-install") < position("simctl-bootstatus"));
    assert!(position("simctl-bootstatus") < position("expo-run-ios"));
    assert_eq!(
        labels(&mock)
            .iter()
            .filter(|l| *l == "simctl-bootstatus")
            .count(),
        1
    );
    assert!(!labels(&mock).iter().any(|l| l == "simctl-create"));
    assert_borrowed_status_and_cleanup(&repo, &receipt.run_id);
}

#[test]
fn borrowed_booted_simulator_with_boot_permission_only_reproves_it_booted() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_boot(&mut mock, &repo, "Booted");
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, true));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_no_simulator_power(&mock);
}

#[test]
fn borrowed_selection_refuses_any_target_it_cannot_prove_exactly() {
    let booted = borrowed_inventory("Booted");
    for output in [
        CmdOutput::failed(1, "unavailable"),
        CmdOutput::success("not json"),
        CmdOutput::success("{}"),
        CmdOutput::success(&booted.replace(BORROWED, &BORROWED.to_lowercase())),
        CmdOutput::success(&booted.replace(BORROWED, "AAAABBBB-1111-2222-3333-444455556666")),
        CmdOutput::success(&booted.replace("Booted", "Booting")),
        CmdOutput::success(&booted.replace("iOS-26-4", "iOS-26-5")),
        CmdOutput::success(&booted.replace("iPhone-17-Pro", "iPhone-17")),
        CmdOutput::success(&booted.replace("\"isAvailable\":true", "\"isAvailable\":false")),
        CmdOutput::success(
            &booted.replace("]}}", &format!(",{}]}}}}", &booted[52..booted.len() - 3])),
        ),
        CmdOutput {
            stderr: "incomplete".into(),
            ..CmdOutput::success(&booted)
        },
        CmdOutput::success(&format!("{booted}{}", " ".repeat(1024 * 1024))),
    ] {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run("simctl list devices -j", output.clone());

        let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, true));

        assert_eq!(
            receipt.result,
            ReceiptResult::Refused,
            "{:?}",
            output.stdout.get(..80)
        );
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::DeviceUnavailable
        );
        assert_eq!(mock.remaining(), 0);
        assert_no_borrowed_effects(&mock, &repo);
    }
}

#[test]
fn borrowed_selector_refuses_android_and_cooperative_scenarios_before_any_command() {
    let cooperative = ios_scenario_yaml(8791)
        .replace("metro:\n  port: 8791\n", "build:\n  owner: qaren\n")
        .replace("  dev_client_scheme: rndatest\n", "");
    common::scenario_from(&cooperative);
    for (yaml, code) in [
        (
            common::android_scenario_yaml(8792),
            FailureCode::PlatformUnsupported,
        ),
        (cooperative, FailureCode::ScenarioInvalid),
    ] {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &yaml);
        let mut mock = MockRunner::new();
        let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));
        let failure = receipt.failure.expect("selector refused");
        assert_eq!(failure.code, code, "{failure:?}");
        assert!(mock.calls.is_empty(), "{:?}", labels(&mock));
        assert_no_borrowed_effects(&mock, &repo);
    }
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut args = prepare_args(&scenario_path, false, None);
    args.boot_device = true;
    let mut mock = MockRunner::new();
    let receipt = prepare(&mut mock, &args);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert!(mock.calls.is_empty());
}

#[test]
fn borrowed_prepare_without_a_proven_process_birth_refuses_before_the_lease() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::OwnershipUnproven
    );
    assert_eq!(mock.remaining(), 0);
    assert_no_borrowed_effects(&mock, &repo);
}

fn plant_borrowed_holder(repo: &std::path::Path) -> qaren::lease::Lease {
    let identity = common::identity(4242, "Wed Aug 12 15:00:00 2026");
    let held = qaren::lease::acquire(
        &mut qaren::exec::MockRunner::new(),
        &repo.join(".locks"),
        qaren::scenario::Platform::Ios,
        BORROWED,
        "check-earlier",
        Some(identity.clone()),
    )
    .unwrap();
    let mut record = common::base_record(
        repo,
        &ios_scenario_yaml(8791),
        "check-earlier",
        Phase::Walking,
    );
    record.prepare = Some(identity);
    record.resources.lease = Some(held.clone());
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
        udid: BORROWED.to_string(),
        name: "qa-lane".to_string(),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".to_string(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4".to_string(),
    });
    record.save(repo).unwrap();
    held
}

#[test]
fn borrowed_prepare_never_takes_a_simulator_leased_by_a_live_run() {
    let repo = common::temp_repo();
    let held = plant_borrowed_holder(&repo);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_lease(&mut mock, &repo, "Booted");
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.failure.unwrap().code, FailureCode::DeviceBusy);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        qaren::buildplan::read_holder(&held.lock_dir)
            .unwrap()
            .run_id,
        "check-earlier"
    );
    assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
    assert_no_simulator_power(&mock);
    assert!(!std::fs::read_dir(&repo)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with("ios-simulator-")));
}

#[test]
fn borrowed_prepare_reclaims_a_dead_holder_through_its_own_cleanup_and_keeps_the_simulator() {
    let repo = common::temp_repo();
    let held = plant_borrowed_holder(&repo);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_lease(&mut mock, &repo, "Booted");
    mock.expect_run("ps", CmdOutput::success("")); // holder gone
    mock.expect_run("ps", CmdOutput::success("")); // its cleanup re-proves the owner gone
    mock.expect_run("lsof", free_port());
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Shutdown")),
    );

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    let failure = receipt
        .failure
        .as_ref()
        .expect("state changed under recovery");
    assert_eq!(failure.code, FailureCode::DeviceUnavailable, "{failure:?}");
    assert_eq!(mock.remaining(), 0);
    assert_no_simulator_power(&mock);
    let earlier = RunRecord::load(&repo, "check-earlier").unwrap();
    assert_eq!(earlier.phase, Phase::Cleaned);
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert_eq!(
        qaren::buildplan::read_holder(&held.lock_dir)
            .unwrap()
            .run_id,
        receipt.run_id,
        "the new run holds the lease and retains it for cleanup"
    );
    assert!(receipt.next_action.contains("qaren cleanup"));
    assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
}

#[test]
fn borrowed_prepare_reaches_ready_after_dead_holder_recovery_and_cleanup_keeps_simulator() {
    let repo = common::temp_repo();
    plant_borrowed_holder(&repo);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_lease(&mut mock, &repo, "Booted");
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        clear_admission(),
    );
    common::script_ios_deps(&mut mock);
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        clear_admission(),
    );
    script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));
    observe_borrowed_custody(&mut mock, &repo);

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(
        RunRecord::load(&repo, "check-earlier").unwrap().phase,
        Phase::Cleaned
    );
    assert_eq!(mock.remaining(), 0);
    assert_no_simulator_power(&mock);
    assert_borrowed_status_and_cleanup(&repo, &receipt.run_id);
}

#[test]
fn borrowed_target_or_lease_changed_during_build_blocks_install_and_ready() {
    for change in ["shutdown", "runtime", "lease"] {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_borrowed_until_boot(&mut mock, &repo, "Booted");
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        script_borrowed_build(&mut mock);
        if change == "lease" {
            replace_borrowed_lease_on(&mut mock, &repo, "ps -A");
        } else {
            let inventory = if change == "shutdown" {
                borrowed_inventory("Shutdown")
            } else {
                borrowed_inventory("Booted").replace("iOS-26-4", "iOS-26-5")
            };
            mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
        }
        common::script_ios_metro_cleanup(&mut mock);

        let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::DeviceUnavailable
        );
        assert_eq!(mock.remaining(), 0);
        assert!(!labels(&mock).iter().any(|l| matches!(
            l.as_str(),
            "simctl-install" | "simctl-launch" | "simctl-bootstatus"
        )));
        let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
        assert_eq!(record.phase, Phase::Failed);
        let lease = record.resources.lease.as_ref().unwrap();
        if change == "lease" {
            assert_eq!(
                qaren::buildplan::read_holder(&lease.lock_dir)
                    .unwrap()
                    .run_id,
                "replacement-run"
            );
        }
        let status = qaren::commands::status::status(&mut mock, &repo, &receipt.run_id);
        assert_eq!(status.result, ReceiptResult::Refused);
        assert_no_simulator_power(&mock);
    }
}

#[test]
fn borrowed_lease_replaced_between_install_attempts_blocks_retry_launch_and_ready() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_borrowed_until_boot(&mut mock, &repo, "Booted");
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    script_borrowed_build(&mut mock);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run(
        "simctl install",
        CmdOutput::failed(
            1,
            "An error was encountered processing the command (domain=IXErrorDomain, code=2):\nFailed to create promise.",
        ),
    );
    replace_borrowed_lease_on(&mut mock, &repo, "simctl install");
    common::script_ios_metro_cleanup(&mut mock);

    let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));

    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{}",
        receipt.to_json()
    );
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        labels(&mock)
            .iter()
            .filter(|l| *l == "simctl-install")
            .count(),
        1
    );
    assert!(!labels(&mock)
        .iter()
        .any(|l| matches!(l.as_str(), "simctl-devmenu-defaults" | "simctl-launch")));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert_eq!(
        qaren::buildplan::read_holder(&record.resources.lease.as_ref().unwrap().lock_dir)
            .unwrap()
            .run_id,
        "replacement-run"
    );
    assert_no_simulator_power(&mock);
}

#[test]
fn borrowed_dry_run_plans_the_exact_target_without_creating_leasing_or_recording() {
    for (state, boot) in [("Booted", false), ("Shutdown", true)] {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&borrowed_inventory(state)),
        );
        mock.expect_run(
            "expo run:ios --help",
            CmdOutput::success(common::IOS_BUILD_HELP),
        );
        mock.expect_run("lsof", free_port());
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut args = borrowed_args(&scenario_path, boot);
        args.dry_run = true;

        let receipt = prepare(&mut mock, &args);

        assert_eq!(
            receipt.result,
            ReceiptResult::Planned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0);
        assert_no_borrowed_effects(&mock, &repo);
        assert_eq!(
            receipt.device.as_ref().unwrap().ios_udid.as_deref(),
            Some(BORROWED)
        );
        let planned = receipt.planned_commands.join("\n");
        assert!(!planned.contains("simctl create"), "{planned}");
        assert!(!planned.contains("<udid>"), "{planned}");
        assert!(
            planned.contains(&format!("simctl install {BORROWED}")),
            "{planned}"
        );
        assert_eq!(
            planned.contains(&format!("simctl bootstatus {BORROWED} -b")),
            boot,
            "{planned}"
        );
    }
}

#[test]
fn fresh_admission_prepare_preserves_cause_specific_recovery_and_retains_the_lease() {
    for foreign in [true, false] {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_borrowed_until_lease(&mut mock, &repo, "Booted");
        mock.expect_run("lsof", free_port());
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&borrowed_inventory("Booted")),
        );
        mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput {
            exit_code: Some(4),
            ..CmdOutput::success(
                &serde_json::json!({"v":1,"platform":"ios","deviceId":BORROWED,
                    "status":if foreign { "busy" } else { "unknown" },
                    "evidence":{"reason":if foreign { "driver_on_selected_device" } else { "scan_unavailable" },"pid":812}})
                    .to_string(),
            )
        },
    );

        let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, true));

        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            if foreign {
                FailureCode::DeviceBusy
            } else {
                FailureCode::FreshInstallAdmissionUnknown
            }
        );
        assert_eq!(mock.remaining(), 0);
        assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
        assert_no_simulator_power(&mock);
        let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
        assert_eq!(record.phase, Phase::Failed);
        assert_eq!(
            qaren::buildplan::read_holder(&record.resources.lease.as_ref().unwrap().lock_dir)
                .unwrap()
                .run_id,
            receipt.run_id
        );
        assert!(receipt.next_action.contains(if foreign {
            "wait for the foreign process owner"
        } else {
            "qaren doctor"
        }));
        let recovery = receipt.failure.as_ref().unwrap().build_recovery().unwrap();
        assert!(recovery.own_cleanup_required);
        assert_eq!(
            recovery.own_run_id.as_deref(),
            Some(receipt.run_id.as_str())
        );
        assert_eq!(
            recovery.action,
            if foreign {
                qaren::failure::RecoveryAction::WaitForOwner
            } else {
                qaren::failure::RecoveryAction::RestoreProcessObservation
            }
        );
    }
}

#[test]
fn unsafe_native_root_fails_normal_prepare_and_read_only_dry_run() {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    for dry_run in [false, true] {
        let repo = common::temp_repo();
        let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
        let args = prepare_args(&scenario, dry_run, None);
        std::fs::DirBuilder::new()
            .mode(0o755)
            .create(&args.native_cache_root)
            .unwrap();
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        if dry_run {
            mock.expect_run(
                "expo run:ios --help",
                CmdOutput::success(common::IOS_BUILD_HELP),
            );
            mock.expect_run("lsof", free_port());
        } else {
            mock.expect_run("lsof", free_port());
            mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
            mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
            common::script_ios_deps(&mut mock);
        }
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let receipt = prepare(&mut mock, &args);
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::PrereqMissing
        );
        assert!(!receipt.failure.as_ref().unwrap().code.is_refusal());
        assert!(receipt.build.is_none());
        assert_eq!(mock.remaining(), 0);
        assert!(!mock.calls.iter().any(|c| c.label == "simctl-create"));
        assert_eq!(
            std::fs::metadata(&args.native_cache_root)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        if dry_run {
            assert!(!repo.join(".qaren").exists());
        }
    }
}

const MEMBER_2: &str = "9F0E8C1A-0000-4000-8000-00000000000B";
const POOL_NAME: &str = "qaren-pool-earlier";
const IOS_TYPE: &str = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const IOS_RUNTIME: &str = "com.apple.CoreSimulator.SimRuntime.iOS-26-4";

fn pool_args(scenario_path: &std::path::Path) -> PrepareArgs {
    let mut args = prepare_args(scenario_path, false, None);
    args.new_device = false;
    args
}

fn plant_member(repo: &std::path::Path, udid: &str) {
    qaren::pool::write(
        &repo.join(".pool"),
        &qaren::pool::PoolMember {
            schema: qaren::pool::POOL_SCHEMA.to_string(),
            udid: udid.to_string(),
            name: POOL_NAME.to_string(),
            device_type: IOS_TYPE.to_string(),
            runtime: IOS_RUNTIME.to_string(),
            created_by_run: "earlier".to_string(),
            created_at: "2026-10-22T00:00:00Z".to_string(),
        },
    )
    .unwrap();
}

fn pool_inventory(sims: &[(&str, &str, &str)]) -> String {
    let devices: Vec<_> = sims
        .iter()
        .map(|(udid, name, state)| {
            serde_json::json!({
                "udid": udid, "name": name, "state": state, "isAvailable": true,
                "deviceTypeIdentifier": IOS_TYPE,
            })
        })
        .collect();
    serde_json::json!({"devices": {IOS_RUNTIME: devices}}).to_string()
}

fn member_inventory(state: &str) -> CmdOutput {
    CmdOutput::success(&pool_inventory(&[(BORROWED, POOL_NAME, state)]))
}

fn admission_for(udid: &str, status: &str) -> CmdOutput {
    CmdOutput {
        exit_code: Some(if status == "clear" { 0 } else { 4 }),
        ..CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":udid,"status":status})
                .to_string(),
        )
    }
}

fn plant_pool_holder(repo: &std::path::Path, udid: &str, phase: Phase) -> qaren::lease::Lease {
    let identity = common::identity(4242, "Wed Aug 12 15:00:00 2026");
    let held = qaren::lease::acquire(
        &mut qaren::exec::MockRunner::new(),
        &repo.join(".locks"),
        qaren::scenario::Platform::Ios,
        udid,
        "check-earlier",
        Some(identity.clone()),
    )
    .unwrap();
    let mut record = common::base_record(repo, &ios_scenario_yaml(8791), "check-earlier", phase);
    record.prepare = Some(identity);
    record.resources.lease = Some(held.clone());
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
        udid: udid.to_string(),
        name: POOL_NAME.to_string(),
        device_type: IOS_TYPE.to_string(),
        runtime: IOS_RUNTIME.to_string(),
    });
    record.save(repo).unwrap();
    held
}

fn script_app_presence(mock: &mut MockRunner, installed: bool) {
    mock.expect_run(
        &format!("simctl listapps {BORROWED}"),
        CmdOutput::success(include_str!("fixtures/installed-apps.plist")),
    );
    mock.expect_run(
        "plutil -convert json -o -",
        CmdOutput::success(if installed {
            r#"{"com.rndevagent.testapp":{"CFBundleIdentifier":"com.rndevagent.testapp"}}"#
        } else {
            "{}"
        }),
    );
}

fn no_run_dir(repo: &std::path::Path) -> bool {
    !std::fs::read_dir(repo)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("ios-simulator-")
        })
}

fn pool_lease_dir(repo: &std::path::Path, udid: &str) -> std::path::PathBuf {
    repo.join(".locks").join(qaren::lease::lock_name(
        qaren::scenario::Platform::Ios,
        udid,
    ))
}

// Cleanup of a pool run: strict admission, shutdown with readback, the simulator kept and the lease released.
fn assert_pool_cleanup_keeps_member(repo: &std::path::Path, run_id: &str) {
    let lock = pool_lease_dir(repo, BORROWED);
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, "")); // prepare owner exited
    common::script_ios_metro_cleanup(&mut mock);
    mock.expect_run(
        &format!("fresh-install-preflight.js --platform ios --device {BORROWED}"),
        clear_admission(),
    );
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    mock.expect_run(
        &format!("simctl shutdown {BORROWED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    let receipt = qaren::commands::cleanup::cleanup_with_runtime(
        &mut mock,
        repo,
        run_id,
        None,
        Some((
            std::path::Path::new("/usr/local/bin/node"),
            std::path::Path::new("/runtime"),
        )),
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{}",
        receipt.to_json()
    );
    assert_eq!(receipt.cleanup["simulator"], "removed", "shut down");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.rendered().contains("simctl delete")));
    assert!(!lock.exists());
    assert!(qaren::pool::record_path(&repo.join(".pool"), BORROWED).exists());
}

#[test]
fn pool_reuses_a_free_member_under_the_lease_and_resets_the_app() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown")); // under the lease
    mock.expect_run("lsof", free_port());
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("fresh-install-preflight.js", clear_admission());
    common::script_ios_deps(&mut mock);
    mock.expect_run("fresh-install-preflight.js", clear_admission());
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run(
        &format!("simctl bootstatus {BORROWED} -b"),
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    script_app_presence(&mut mock, true);
    mock.expect_run(
        &format!("simctl uninstall {BORROWED} com.rndevagent.testapp"),
        CmdOutput::success(""),
    );
    script_app_presence(&mut mock, false);
    mock.expect_run(
        &format!("simctl keychain {BORROWED} reset"),
        CmdOutput::success(""),
    );
    script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "simctl-create"));
    let position = |label: &str| labels(&mock).iter().position(|l| l == label).unwrap();
    assert!(position("simctl-bootstatus") < position("simctl-uninstall"));
    assert!(position("simctl-uninstall") < position("simctl-keychain-reset"));
    assert!(position("simctl-keychain-reset") < position("simctl-install"));
    assert_eq!(
        receipt.outcomes["device_pool"],
        format!("reused {BORROWED}")
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.device_borrowed);
    assert_eq!(
        record.resources.borrowed_ios_stop(),
        qaren::runrecord::BorrowedIosStop::Pending
    );
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().udid,
        BORROWED
    );
    assert!(record.resources.fresh_install.is_some());
    assert_eq!(
        qaren::buildplan::read_holder(&pool_lease_dir(&repo, BORROWED))
            .unwrap()
            .run_id,
        receipt.run_id
    );
    assert_pool_cleanup_keeps_member(&repo, &receipt.run_id);
}

#[test]
fn pool_creates_a_member_under_the_creation_lock_below_cap() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run(
        "simctl create",
        CmdOutput::success(&format!("{BORROWED}\n")),
    );
    mock.expect_run(
        &format!("simctl bootstatus {BORROWED} -b"),
        CmdOutput::success("Boot status: finished\n"),
    );
    script_borrowed_after_plan(&mut mock, &borrowed_inventory("Booted"));

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    let create = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-create")
        .unwrap();
    let name = format!("qaren-pool-{}", receipt.run_id);
    assert!(create.args.contains(&name), "{:?}", create.args);
    assert_eq!(
        receipt.outcomes["device_pool"],
        format!("created {BORROWED}")
    );
    let members = qaren::pool::load_all(&repo.join(".pool")).unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].udid, BORROWED);
    assert_eq!(members[0].name, name);
    assert_eq!(members[0].created_by_run, receipt.run_id);
    assert!(
        !repo.join(".pool").join("create-ios").exists(),
        "creation lock released"
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.pool_create_lock.is_none());
    assert!(record.resources.device_borrowed);
    assert_eq!(
        record.resources.borrowed_ios_stop(),
        qaren::runrecord::BorrowedIosStop::Pending
    );
    assert!(
        record.resources.fresh_install.is_none(),
        "a new member is not reset"
    );
    assert_eq!(
        qaren::buildplan::read_holder(&pool_lease_dir(&repo, BORROWED))
            .unwrap()
            .run_id,
        receipt.run_id
    );
    assert_pool_cleanup_keeps_member(&repo, &receipt.run_id);
}

#[test]
fn pool_never_claims_a_simulator_without_a_record_and_prunes_absent_records() {
    let repo = common::temp_repo();
    plant_member(&repo, MEMBER_2);
    let foreign = [
        (
            "AAAABBBB-1111-2222-3333-444455556666",
            "qaren-pool-x",
            "Shutdown",
        ),
        (
            "CCCCDDDD-1111-2222-3333-444455556666",
            "Company",
            "Shutdown",
        ),
    ];
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&pool_inventory(&foreign)),
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    // The pruned pool is empty, so the recount under the creation lock reads no inventory.
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        !qaren::pool::record_path(&repo.join(".pool"), MEMBER_2).exists(),
        "a record whose simulator is proven absent is pruned"
    );
    for (udid, _, _) in foreign {
        for call in &mock.calls {
            assert!(!call.args.iter().any(|a| a == udid), "{}", call.rendered());
        }
        assert!(!pool_lease_dir(&repo, udid).exists());
    }
}

#[test]
fn pool_skips_a_member_whose_name_changed_and_counts_it_at_the_cap() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&pool_inventory(&[(BORROWED, "renamed", "Shutdown")])),
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    script_cap_fallback_tail(&mut mock);

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(mock.remaining(), 0);
    assert_cap_fallback(
        &repo,
        &receipt,
        &format!("no member matches the scenario's device type and runtime: {BORROWED}"),
    );
    assert!(!pool_lease_dir(&repo, BORROWED).exists());
    assert!(qaren::pool::record_path(&repo.join(".pool"), BORROWED).exists());
}

#[test]
fn pool_at_cap_falls_back_to_a_temporary_simulator_past_a_live_held_member() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let held = plant_pool_holder(&repo, BORROWED, Phase::Walking);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
    mock.expect_run("ps", CmdOutput::success("S\n"));
    script_cap_fallback_tail(&mut mock);

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(mock.remaining(), 0);
    assert_cap_fallback(&repo, &receipt, BORROWED);
    assert_eq!(
        qaren::buildplan::read_holder(&held.lock_dir)
            .unwrap()
            .run_id,
        "check-earlier"
    );
}

#[test]
fn pool_takes_the_next_member_when_the_first_is_leased_live() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    plant_member(&repo, MEMBER_2);
    let held = plant_pool_holder(&repo, BORROWED, Phase::Walking);
    let both = CmdOutput::success(&pool_inventory(&[
        (BORROWED, POOL_NAME, "Shutdown"),
        (MEMBER_2, POOL_NAME, "Shutdown"),
    ]));
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", both.clone());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("simctl list devices -j", both.clone()); // member 2 under the lease
    mock.expect_run("lsof", free_port());
    mock.expect_run("simctl list devices -j", both);
    mock.expect_run(
        "fresh-install-preflight.js",
        admission_for(MEMBER_2, "busy"),
    );

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().udid,
        MEMBER_2
    );
    assert_eq!(
        qaren::buildplan::read_holder(&pool_lease_dir(&repo, MEMBER_2))
            .unwrap()
            .run_id,
        receipt.run_id
    );
    assert_eq!(
        qaren::buildplan::read_holder(&held.lock_dir)
            .unwrap()
            .run_id,
        "check-earlier"
    );
    assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
}

#[test]
fn pool_treats_a_dead_ready_holder_as_occupied() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let held = plant_pool_holder(&repo, BORROWED, Phase::Ready);
    let before = std::fs::read(RunRecord::path(&repo, "check-earlier")).unwrap();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("ps", CmdOutput::success("")); // the ready run's prepare exited
    script_cap_fallback_tail(&mut mock);

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(mock.remaining(), 0);
    assert_cap_fallback(&repo, &receipt, "qaren cleanup check-earlier");
    assert_eq!(
        std::fs::read(RunRecord::path(&repo, "check-earlier")).unwrap(),
        before,
        "the ready run is untouched"
    );
    assert_eq!(
        qaren::buildplan::read_holder(&held.lock_dir)
            .unwrap()
            .run_id,
        "check-earlier"
    );
}

#[test]
fn pool_recount_under_the_creation_lock_falls_back_when_a_parallel_prepare_filled_the_cap() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));
    let parallel = repo.clone();
    let mut enrolled = false;
    mock.observe = Some(Box::new(move |spec| {
        if !enrolled && spec.label == "lsof-port" {
            enrolled = true;
            plant_member(&parallel, BORROWED);
        }
    }));

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(mock.remaining(), 0);
    assert_cap_fallback(&repo, &receipt, "no matching member is free");
    assert!(
        !repo.join(".pool").join("create-ios").exists(),
        "creation lock released"
    );
    assert!(!pool_lease_dir(&repo, BORROWED).exists());
    assert!(qaren::pool::record_path(&repo.join(".pool"), BORROWED).exists());
}

#[test]
fn pool_reclaims_a_dead_failed_holder_through_its_cleanup() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    plant_pool_holder(&repo, BORROWED, Phase::Failed);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("ps", CmdOutput::success("")); // holder gone
    mock.expect_run("ps", CmdOutput::success("")); // its cleanup re-proves the owner gone
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("lsof", free_port());
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run(
        "fresh-install-preflight.js",
        admission_for(BORROWED, "busy"),
    );

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.outcomes["recovered_run"], "check-earlier");
    assert_eq!(
        RunRecord::load(&repo, "check-earlier").unwrap().phase,
        Phase::Cleaned
    );
    assert_eq!(
        qaren::buildplan::read_holder(&pool_lease_dir(&repo, BORROWED))
            .unwrap()
            .run_id,
        receipt.run_id
    );
}

#[test]
fn pool_skips_a_booted_member_with_no_holder() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    script_cap_fallback_tail(&mut mock);

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(mock.remaining(), 0);
    assert_cap_fallback(
        &repo,
        &receipt,
        &format!("xcrun simctl shutdown {BORROWED}"),
    );
    assert!(!pool_lease_dir(&repo, BORROWED).exists(), "lease released");
    assert!(!mock.calls.iter().any(|c| {
        let rendered = c.rendered();
        rendered.contains(BORROWED)
            && ["boot", "shutdown", "delete", "erase"]
                .iter()
                .any(|v| rendered.contains(v))
    }));
}

#[test]
fn pool_creation_lock_held_refuses() {
    let repo = common::temp_repo();
    let holder = qaren::buildplan::LockHolder {
        holder: "qaren-other-creator".to_string(),
        run_id: "other-creator".to_string(),
        identity: None,
        at: "2026-10-22T00:00:00Z".to_string(),
        home: None,
        qaren_home: None,
        group: None,
    };
    assert!(matches!(
        qaren::buildplan::claim_lock(
            &mut MockRunner::new(),
            &repo.join(".pool"),
            "create-ios",
            &holder,
            qaren::buildplan::LockPolicy::Strict,
        ),
        qaren::buildplan::LockOutcome::Claimed { .. }
    ));
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{}",
        receipt.to_json()
    );
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.detail.to_string().contains("other-creator"));
    assert!(
        failure.detail.contains("`qaren cleanup other-creator`"),
        "{:?}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "simctl-create"));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.pool_create_lock.is_none());
    assert_eq!(
        qaren::buildplan::read_holder(&repo.join(".pool").join("create-ios"))
            .unwrap()
            .run_id,
        "other-creator"
    );
}

#[test]
fn new_flag_keeps_the_temporary_path_and_never_reads_the_pool() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));
    let mut args = pool_args(&scenario_path);
    args.new_device = true;

    let receipt = prepare(&mut mock, &args);

    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.outcomes["device_pool"], "fresh");
    assert!(!labels(&mock).iter().any(|l| l == "simctl-list"));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().name,
        format!("qaren-{}", receipt.run_id)
    );
    assert!(record.resources.lease.is_none());
    assert!(!record.resources.device_borrowed);
    assert!(!pool_lease_dir(&repo, BORROWED).exists());
}

#[test]
fn pool_falls_back_to_a_temporary_simulator_when_this_process_identity_is_unproven() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    mock.expect_run("ps", CmdOutput::failed(1, "operation not permitted"));
    mock.expect_run("ps", CmdOutput::failed(1, "operation not permitted"));
    mock.expect_run("lsof", free_port());
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));

    let receipt = prepare(&mut mock, &pool_args(&scenario_path));

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{}",
        receipt.to_json()
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt.outcomes["device_pool"].starts_with("fresh: "));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().name,
        format!("qaren-{}", receipt.run_id)
    );
    assert!(record.resources.lease.is_none());
    assert!(!record.resources.device_borrowed);
    assert!(!pool_lease_dir(&repo, BORROWED).exists());
}

#[test]
fn new_flag_refuses_android_and_an_explicit_device() {
    let repo = common::temp_repo();
    let android = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let mut mock = MockRunner::new();
    let mut args = prepare_args(&android, false, None);
    args.new_device = true;
    let receipt = prepare(&mut mock, &args);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::PlatformUnsupported
    );
    let ios = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut args = borrowed_args(&ios, false);
    args.new_device = true;
    let receipt = prepare(&mut mock, &args);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(mock.calls.is_empty());
}

fn ios_runtimes(entries: &[(&str, &str)]) -> CmdOutput {
    let runtimes: Vec<_> = entries
        .iter()
        .map(|(name, identifier)| {
            serde_json::json!({"name": name, "identifier": identifier, "platform": "iOS", "isAvailable": true})
        })
        .collect();
    CmdOutput::success(&serde_json::json!({ "runtimes": runtimes }).to_string())
}

fn script_pool_dry_run_tail(mock: &mut MockRunner) {
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
}

#[test]
fn pool_resolves_a_short_runtime_to_its_installed_identifier() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let yaml = ios_scenario_yaml(8791).replace(IOS_RUNTIME, "iOS26.4");
    let scenario_path = write_scenario(&repo, &yaml);
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list runtimes --json",
        ios_runtimes(&[
            ("iOS 26.4", IOS_RUNTIME),
            ("iOS 26.5", "com.apple.CoreSimulator.SimRuntime.iOS-26-5"),
        ]),
    );
    mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
    script_pool_dry_run_tail(&mut mock);
    let mut args = pool_args(&scenario_path);
    args.dry_run = true;

    let receipt = prepare(&mut mock, &args);

    assert_eq!(
        receipt.result,
        ReceiptResult::Planned,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        receipt.outcomes["device_pool"],
        format!("would reuse {BORROWED}")
    );
}

#[test]
fn pool_falls_back_to_a_temporary_simulator_when_a_short_form_does_not_resolve() {
    for runtimes in [
        ios_runtimes(&[]),
        ios_runtimes(&[
            ("iOS 26.4", IOS_RUNTIME),
            ("iOS 26.4", "com.apple.CoreSimulator.SimRuntime.iOS-26-4-1"),
        ]),
    ] {
        let repo = common::temp_repo();
        plant_member(&repo, BORROWED);
        let yaml = ios_scenario_yaml(8791).replace(IOS_RUNTIME, "iOS26.4");
        let scenario_path = write_scenario(&repo, &yaml);
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run("simctl list runtimes --json", runtimes);
        script_pool_dry_run_tail(&mut mock);
        let mut args = pool_args(&scenario_path);
        args.dry_run = true;

        let receipt = prepare(&mut mock, &args);

        assert_eq!(
            receipt.result,
            ReceiptResult::Planned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0);
        assert!(receipt.outcomes["device_pool"].starts_with("fresh: "));
        let planned = receipt.planned_commands.join("\n");
        assert!(
            planned.contains(&format!("simctl create qaren-{} ", receipt.run_id)),
            "{planned}"
        );
        assert!(planned.contains("iOS26.4"), "{planned}");
    }
}

#[test]
fn pool_dry_run_reports_reclaiming_a_dead_holder_whose_run_never_reached_ready() {
    for (state, armed) in [("Shutdown", false), ("Booted", true), ("Booted", false)] {
        let repo = common::temp_repo();
        plant_member(&repo, BORROWED);
        plant_pool_holder(&repo, BORROWED, Phase::Failed);
        if armed {
            let mut record = RunRecord::load(&repo, "check-earlier").unwrap();
            record.resources.arm_borrowed_ios_stop().unwrap();
            record.save(&repo).unwrap();
        }
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run("simctl list devices -j", member_inventory(state));
        mock.expect_run(
            "expo run:ios --help",
            CmdOutput::success(common::IOS_BUILD_HELP),
        );
        mock.expect_run("lsof", free_port());
        mock.expect_run("ps", CmdOutput::success("")); // holder gone
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut args = pool_args(&scenario_path);
        args.dry_run = true;

        let receipt = prepare(&mut mock, &args);

        if state == "Booted" && !armed {
            assert_eq!(receipt.result, ReceiptResult::Planned);
            assert!(receipt.outcomes["device_pool"].starts_with("fresh: "));
            let planned = receipt.planned_commands.join("\n");
            assert!(
                planned.contains(&format!("simctl create qaren-{} ", receipt.run_id)),
                "{planned}"
            );
            continue;
        }
        assert_eq!(mock.remaining(), 0);
        assert_eq!(
            receipt.result,
            ReceiptResult::Planned,
            "{state}: {:?}",
            receipt.failure
        );
        assert_eq!(
            receipt.outcomes["device_pool"],
            format!(
                "would reuse {BORROWED} after reclaiming run check-earlier through its cleanup"
            )
        );
        let planned = receipt.planned_commands.join("\n");
        assert!(
            planned.contains(&format!("simctl bootstatus {BORROWED} -b")),
            "{planned}"
        );
        assert_eq!(
            RunRecord::load(&repo, "check-earlier").unwrap().phase,
            Phase::Failed
        );
    }
}

#[test]
fn pool_dry_run_names_the_member_or_the_creation_and_writes_nothing() {
    for with_member in [true, false] {
        let repo = common::temp_repo();
        if with_member {
            plant_member(&repo, BORROWED);
        }
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        if with_member {
            mock.expect_run("simctl list devices -j", member_inventory("Shutdown"));
        }
        mock.expect_run(
            "expo run:ios --help",
            CmdOutput::success(common::IOS_BUILD_HELP),
        );
        mock.expect_run("lsof", free_port());
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut args = pool_args(&scenario_path);
        args.dry_run = true;

        let receipt = prepare(&mut mock, &args);

        assert_eq!(
            receipt.result,
            ReceiptResult::Planned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0);
        assert!(no_run_dir(&repo));
        assert!(!pool_lease_dir(&repo, BORROWED).exists());
        let planned = receipt.planned_commands.join("\n");
        if with_member {
            assert_eq!(
                receipt.device.as_ref().unwrap().ios_udid.as_deref(),
                Some(BORROWED)
            );
            assert!(!planned.contains("simctl create"), "{planned}");
            for command in [
                format!("simctl bootstatus {BORROWED} -b"),
                format!("simctl uninstall {BORROWED} com.rndevagent.testapp"),
                format!("simctl keychain {BORROWED} reset"),
            ] {
                assert!(planned.contains(&command), "{planned}");
            }
            assert!(qaren::pool::record_path(&repo.join(".pool"), BORROWED).exists());
        } else {
            assert!(
                planned.contains(&format!("simctl create qaren-pool-{}", receipt.run_id)),
                "{planned}"
            );
        }
    }
}

#[test]
fn pool_dry_run_skips_a_booted_member_like_the_claim() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("simctl list devices -j", member_inventory("Booted"));
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    let mut args = pool_args(&scenario_path);
    args.dry_run = true;

    let receipt = prepare(&mut mock, &args);

    assert_eq!(
        receipt.result,
        ReceiptResult::Planned,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt.outcomes["device_pool"]
        .starts_with("fresh: the QaReN simulator pool is at ios.max_devices 1"));
    let planned = receipt.planned_commands.join("\n");
    assert!(
        planned.contains(&format!("simctl create qaren-{} ", receipt.run_id)),
        "{planned}"
    );
    assert!(no_run_dir(&repo));
}

#[test]
fn device_on_a_pool_member_keeps_borrowed_semantics() {
    let repo = common::temp_repo();
    plant_member(&repo, BORROWED);
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted")),
    );
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    let mut args = borrowed_args(&scenario_path, false);
    args.dry_run = true;

    let receipt = prepare(&mut mock, &args);

    assert_eq!(
        receipt.result,
        ReceiptResult::Planned,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let planned = receipt.planned_commands.join("\n");
    assert!(!planned.contains("simctl uninstall"), "{planned}");
    assert!(!planned.contains("simctl keychain"), "{planned}");
    assert!(!receipt.outcomes.contains_key("device_pool"));
}

const HOLDER_BIRTH: &str = "Wed Aug 12 10:00:00 2026";

// Another home's live run holds the iOS build lock: its build group 777 has already exited.
fn seed_build_holder(repo: &std::path::Path) -> std::path::PathBuf {
    let holder = qaren::buildplan::LockHolder {
        holder: "qaren-holder-run".to_string(),
        run_id: "holder-run".to_string(),
        identity: Some(common::identity(4242, HOLDER_BIRTH)),
        at: qaren::timefmt::iso8601_utc(1_770_000_000_000 - 600_000),
        home: Some(repo.join("other-home")),
        qaren_home: None,
        group: Some(777),
    };
    let root = repo.join(".locks");
    assert!(matches!(
        qaren::buildplan::claim_lock(
            &mut qaren::exec::MockRunner::new(),
            &root,
            "native-build-ios",
            &holder,
            qaren::buildplan::LockPolicy::Strict,
        ),
        qaren::buildplan::LockOutcome::Claimed { .. }
    ));
    root.join("native-build-ios")
}

// Validation through allocation of a fresh simulator, up to the build-lock claim.
fn script_ios_prepare_to_claim(mock: &mut MockRunner, repo: &std::path::Path) {
    script_validation(mock, repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    common::script_ios_deps(mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
}

// Each contended poll proves the holder alive and its recorded build group absent.
fn script_live_idle_holder_polls(mock: &mut MockRunner, polls: usize) {
    for _ in 0..polls {
        mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(HOLDER_BIRTH));
        mock.expect_run("ps -p 4242 -o stat=", CmdOutput::success("S"));
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    }
}

#[test]
fn a_contended_ios_build_waits_for_the_holder_then_builds_and_releases_before_install() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let lock = seed_build_holder(&repo);
    let empty = |m: &mut MockRunner| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    };
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    script_live_idle_holder_polls(&mut mock, 3);
    common::script_finite_ios_build_only(&mut mock, "expo run:ios");
    script_ios_prepublish(&mut mock, "", empty);
    common::script_ios_after_publish(
        &mut mock,
        CmdOutput::success(""),
        |m| m.expect_run("simctl install", CmdOutput::success("")),
        common::script_ios_launch,
    );
    script_ios_readiness(&mut mock);
    empty(&mut mock);
    // The holder finishes during the third poll.
    let released = lock.clone();
    let acquired_at = std::sync::Arc::new(std::sync::Mutex::new(None));
    let observed_acquisition = acquired_at.clone();
    let mut polls = 0;
    mock.observe = Some(Box::new(move |spec| {
        if spec.label == "ps-lstart" && spec.args.iter().any(|arg| arg == "5000") {
            *observed_acquisition.lock().unwrap() =
                Some(qaren::buildplan::read_holder(&released).unwrap().at);
        }
        if spec.label == "ps-groups" {
            polls += 1;
            if polls == 3 {
                std::fs::remove_dir_all(&released).unwrap();
            }
        }
    }));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.failure
    );
    assert_eq!(
        acquired_at.lock().unwrap().as_deref(),
        Some(qaren::timefmt::iso8601_utc(1_770_000_003_000).as_str())
    );
    assert_eq!(mock.remaining(), 0);
    let seen = receipt.build_lock.expect("the wait is recorded");
    assert_eq!(seen.holder.as_deref(), Some("holder-run"));
    assert_eq!(seen.waited_s, 3);
    assert_eq!(seen.holder_alive, Some(true));
    assert_eq!(seen.holder_build_process, Some(false));
    assert_eq!(seen.hold_s, Some(602));
    assert_eq!(
        seen.observation,
        qaren::runrecord::LockObservation::Observed
    );
    assert!(!lock.exists(), "this run released its own claim");
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.build_lock.is_none());
    assert_eq!(
        record.build_lock.unwrap().holder.as_deref(),
        Some("holder-run")
    );
}

#[test]
fn holder_probes_stop_at_the_shared_build_deadline() {
    let repo = common::temp_repo();
    let scenario = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 32\n",
            ios_scenario_yaml(8791)
        ),
    );
    let lock = seed_build_holder(&repo);
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    script_live_idle_holder_polls(&mut mock, 10);
    mock.expect_run("ps -p 4242 -o lstart=", CmdOutput::success(HOLDER_BIRTH));
    mock.expect_run("ps -p 4242 -o stat=", CmdOutput::success("S"));
    mock.advance_on = Some(("-p 4242".into(), 1000));

    let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));

    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildContended
    );
    assert_eq!(receipt.build_lock.unwrap().waited_s, 32);
    let probes: Vec<_> = mock
        .calls
        .iter()
        .filter(|call| call.args.iter().any(|arg| arg == "4242"))
        .collect();
    assert_eq!(probes.len(), 22);
    assert_eq!(probes[20].timeout_seconds, 2);
    assert_eq!(probes[21].timeout_seconds, 1);
    assert_eq!(
        mock.calls
            .iter()
            .filter(|call| call.label == "ps-groups")
            .count(),
        10
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(
        qaren::buildplan::read_holder(&lock).unwrap().run_id,
        "holder-run"
    );
}

#[test]
fn a_contended_ios_build_refuses_after_its_budget_naming_the_holder_and_next_step() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 150\n",
            ios_scenario_yaml(8791)
        ),
    );
    let lock = seed_build_holder(&repo);
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    script_live_idle_holder_polls(&mut mock, 150);

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::BuildContended);
    assert_eq!(failure.phase, "build_lock_wait");
    let next = "BUILD_CONTENDED: native-build-ios is held by run holder-run (alive: yes; no build process for 2 min); waited 150 s of the budget. Next: wait for that run or re-run once later; if the holder is dead, run its qaren cleanup from its home (its resources only).";
    // The owned simulator's cleanup never overwrites the holder advice.
    assert_eq!(failure.next_action.to_string(), next);
    assert_eq!(receipt.next_action, next);
    let recovery = receipt.recovery.as_ref().unwrap();
    assert_eq!(
        recovery.reason,
        qaren::failure::RecoveryReason::BudgetExhausted
    );
    assert_eq!(
        recovery.action,
        qaren::failure::RecoveryAction::WaitForHolder
    );
    assert_eq!(recovery.next_rung, Some(1));
    assert!(recovery.own_cleanup_required);
    assert_eq!(
        recovery.own_run_id.as_deref(),
        Some(receipt.run_id.as_str())
    );
    assert_eq!(recovery.ladder.len(), 5);
    let seen = receipt.build_lock.as_ref().unwrap();
    assert_eq!(seen.waited_s, 150);
    assert_eq!(seen.no_build_observed_s, 149);
    assert_eq!(seen.hold_s, Some(749));
    assert!(receipt.outcomes["build_lock"].starts_with("holder_idle_after_build"));
    assert!(!labels(&mock).iter().any(|l| l == "expo-run-ios"));
    // A live holder is never taken.
    assert_eq!(
        qaren::buildplan::read_holder(&lock).unwrap().run_id,
        "holder-run"
    );
    let json = receipt.to_json();
    for private in ["other-home", ".locks", "qaren-holder-run", "4242"] {
        assert!(!json.contains(private), "{private} leaked: {json}");
    }
}

#[test]
fn a_cancel_while_waiting_for_the_build_lock_never_takes_it() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let lock = seed_build_holder(&repo);
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    script_live_idle_holder_polls(&mut mock, 2);
    mock.cancel_at_ms = Some((1_770_000_002_000, "received SIGINT".into()));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::RunCancelled);
    assert_eq!(failure.phase, "build_lock_wait");
    let recovery = failure.build_recovery().unwrap();
    assert_eq!(
        recovery.reason,
        qaren::failure::RecoveryReason::RunCancelled
    );
    // The run still owns its simulator, so its own cleanup is the next rung.
    assert!(recovery.own_cleanup_required);
    assert_eq!(receipt.build_lock.as_ref().unwrap().waited_s, 2);
    assert!(!labels(&mock).iter().any(|l| l == "expo-run-ios"));
    assert_eq!(
        qaren::buildplan::read_holder(&lock).unwrap().run_id,
        "holder-run"
    );
}

#[test]
fn a_new_holder_during_the_wait_restarts_the_no_build_observation() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deadlines:\n  build_seconds: 30\n",
            ios_scenario_yaml(8791)
        ),
    );
    let lock = seed_build_holder(&repo);
    let mut mock = MockRunner::new();
    script_ios_prepare_to_claim(&mut mock, &repo);
    script_live_idle_holder_polls(&mut mock, 30);
    // During the tenth poll the first holder finishes and a second run claims the lock.
    let swapped = lock.clone();
    let mut polls = 0;
    mock.observe = Some(Box::new(move |spec| {
        if spec.label == "ps-groups" {
            polls += 1;
            if polls == 10 {
                let mut next = qaren::buildplan::read_holder(&swapped).unwrap();
                next.holder = "qaren-second-run".into();
                next.run_id = "second-run".into();
                qaren::buildplan::save_json(&swapped.join("holder.json"), &next).unwrap();
            }
        }
    }));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::BuildContended);
    assert!(
        failure
            .next_action
            .contains("held by run second-run (alive: yes; no build process for 19 s)"),
        "{}",
        failure.next_action
    );
    let seen = receipt.build_lock.as_ref().unwrap();
    assert_eq!(seen.holder.as_deref(), Some("second-run"));
    assert_eq!(seen.no_build_observed_s, 19);
    assert_eq!(seen.waited_s, 30);
}

#[test]
fn an_ios_build_claim_without_its_own_process_identity_refuses_before_claiming() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    common::script_ios_deps(&mut mock);
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(mock.remaining(), 0);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::PrereqMissing, "{failure:?}");
    assert_eq!(
        failure.build_recovery().unwrap().reason,
        qaren::failure::RecoveryReason::IdentityUnavailable
    );
    assert!(!repo.join(".locks/native-build-ios").exists());
}

#[test]
fn an_unresolved_build_lock_release_stops_before_install_and_keeps_the_lock() {
    let repo = common::temp_repo();
    let scenario = write_scenario(&repo, &ios_scenario_yaml(8791));
    let mut mock = MockRunner::new();
    script_prepare_to_prepublish(&mut mock, &repo, "", "");
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    let lock = repo.join(".locks/native-build-ios");
    let unreadable = lock.clone();
    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: format!(
            "ios-simulator-{}",
            qaren::timefmt::compact_utc(1_770_000_000_000)
        ),
        probe_label: "git-head#2".into(),
        observed: None,
        cancel_copy: None,
        copied_bytes: std::cell::Cell::new(0),
        at_probe: Some(Box::new(move |_| {
            std::fs::write(unreadable.join("holder.json"), "{").unwrap();
        })),
    };

    let receipt = prepare(&mut probing, &prepare_args(&scenario, false, None));

    assert_eq!(probing.inner.remaining(), 0);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(
        failure.code,
        FailureCode::RunRecordUpdateFailed,
        "{failure:?}"
    );
    assert_eq!(failure.phase, "build_lock");
    assert_eq!(
        failure.build_recovery().unwrap().reason,
        qaren::failure::RecoveryReason::OwnershipUnresolved
    );
    assert_eq!(
        receipt.outcomes["build_lock_release"],
        "retained: lock release was refused or unresolved"
    );
    assert!(lock.exists());
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(record.resources.build_lock.is_some(), "never reported free");
    assert!(!probing
        .inner
        .calls
        .iter()
        .any(|c| c.label == "simctl-install"));
}

#[test]
fn build_probe_timeouts_prioritize_expiry_over_candidate_drift() {
    use qaren::failure::RecoveryReason;
    for elapsed_ms in [1000, 30_000] {
        let repo = common::temp_repo();
        let scenario = write_scenario(
            &repo,
            &format!(
                "{}deadlines:\n  build_seconds: 30\n",
                ios_scenario_yaml(8791)
            ),
        );
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, IOS_TOOLS);
        mock.expect_run("lsof", free_port());
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("qaren prepare"));
        common::script_ios_deps(&mut mock);
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        mock.expect_run("simctl create", CmdOutput::success(UDID));
        mock.expect_run("simctl bootstatus", CmdOutput::success("finished"));
        common::script_finite_ios_build_only(&mut mock, "expo run:ios");
        mock.expect_run("git", CmdOutput::success(&"b".repeat(40)));
        mock.expect_run(
            "git",
            CmdOutput {
                timed_out: true,
                duration_ms: elapsed_ms,
                ..Default::default()
            },
        );
        mock.advance_on = Some(("status --porcelain".into(), elapsed_ms));
        let receipt = prepare(&mut mock, &prepare_args(&scenario, false, None));
        let failure = receipt.failure.unwrap();
        if elapsed_ms == 30_000 {
            assert_eq!(failure.code, FailureCode::BuildFailed);
            assert_eq!(failure.phase, "build");
            assert_eq!(
                failure.build_recovery().unwrap().reason,
                RecoveryReason::BuildBudgetExhausted
            );
        } else {
            assert_eq!(failure.code, FailureCode::CandidateDrifted);
            assert_eq!(
                failure.build_recovery().unwrap().reason,
                RecoveryReason::CandidateDrifted
            );
        }
        assert_eq!(mock.remaining(), 0);
        assert!(!repo.join(".locks/native-build-ios").exists());
        assert!(!mock.calls.iter().any(|spec| spec.label == "simctl-install"));
    }
}

#[test]
fn borrowed_prepare_reprobes_identity_before_and_after_dependencies() {
    for retry_phase in 0..2 {
        let repo = common::temp_repo();
        let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8791));
        let mut mock = MockRunner::new();
        script_borrowed_until_lease(&mut mock, &repo, "Booted");
        mock.expect_run("lsof", free_port());
        mock.expect_run(
            "simctl list devices -j",
            CmdOutput::success(&borrowed_inventory("Booted")),
        );
        for phase in 0..2 {
            if retry_phase == phase {
                let mut unknown = admission_for(BORROWED, "unknown");
                let mut value: serde_json::Value = serde_json::from_str(&unknown.stdout).unwrap();
                value["evidence"] =
                    serde_json::json!({"reason":"executable_identity_unproven","pid":812});
                unknown.stdout = value.to_string();
                mock.expect_run("fresh-install-preflight.js", unknown);
            }
            mock.expect_run("fresh-install-preflight.js", clear_admission());
            if phase == 0 {
                common::script_ios_deps(&mut mock);
            }
        }
        script_borrowed_after_boot(&mut mock, &borrowed_inventory("Booted"));
        observe_borrowed_custody(&mut mock, &repo);
        let receipt = prepare(&mut mock, &borrowed_args(&scenario_path, false));
        assert_eq!(
            receipt.result,
            ReceiptResult::Ready,
            "{}",
            receipt.to_json()
        );
        assert_eq!(mock.remaining(), 0);
        let key = if retry_phase == 0 {
            "admission_before_deps"
        } else {
            "admission_before_mutation"
        };
        let summary: serde_json::Value = serde_json::from_str(&receipt.outcomes[key]).unwrap();
        assert_eq!(summary["attempts"], 2);
        assert_eq!(summary["elapsedMs"], 500);
        assert_eq!(summary["terminalReason"], "clear");
        assert_eq!(
            labels(&mock)
                .iter()
                .filter(|s| *s == "fresh-install-admission")
                .count(),
            3
        );
        assert_no_simulator_power(&mock);
    }
}
