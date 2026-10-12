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
        runs_root: scenario_path.parent().unwrap().to_path_buf(),
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
    let empty = |m: &mut MockRunner| {
        m.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(m);
    };
    script_ios_prepare_fingerprints(mock, repo, defaults, empty, empty);
}

fn script_ios_prepare_fingerprints(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    defaults: CmdOutput,
    plan: impl FnOnce(&mut MockRunner),
    recheck: impl FnOnce(&mut MockRunner),
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
    common::script_finite_ios_build_defaults(mock, "expo run:ios", defaults);
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
    // Provenance recheck immediately before ready: unchanged sha, still clean.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    recheck(mock);
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
        fingerprint("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    let failure = receipt.failure.expect("drift must fail prepare");
    assert_eq!(failure.code, FailureCode::CandidateDrifted, "{failure:?}");
    assert!(failure
        .detail
        .contains("native inputs changed during preparation"));
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
        if spec.label == self.probe_label {
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
    common::script_finite_ios_build(&mut mock);
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
    // Provenance recheck: HEAD moved during the build.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "d".repeat(40))));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
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
    common::script_finite_ios_build(&mut mock);
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
    // Provenance recheck: HEAD unchanged, but the worktree went dirty.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/App.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
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
    common::script_finite_ios_build(&mut mock);
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
    // Provenance recheck: still dirty, but a different set of modifications.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/Other.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
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
    common::script_finite_ios_build(mock);
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
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .qaren/\0?? stray.txt\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
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
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .qaren/\0 M test-app/App.tsx\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
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
        hash_artifact, save_json, state_path, ArtifactKind, BuildDecision, CachedArtifact,
        NativeCacheState, CACHE_SCHEMA,
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
        artifact: Some(CachedArtifact {
            path: artifact.clone(),
            sha256: hash_artifact(&artifact).unwrap(),
            kind: ArtifactKind::AppBundle,
        }),
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
        ios::install_app_spec("<udid>", &artifact),
        metro::start_spec(&project, 8791),
        metro::manifest_spec(8791, "ios"),
    ];
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
    assert!(
        record.resources.ios_simulator.is_some(),
        "sim must stay recorded for cleanup"
    );
}

#[test]
fn recording_a_build_retires_run_output_and_prunes_only_older_artifacts_for_the_same_app() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_scenario_yaml(8797));
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

    let artifacts = qaren::buildplan::cache_dir(&repo)
        .join("artifacts")
        .join("ios");
    let stale = artifacts.join(format!("com.rndevagent.testapp-{}", "a".repeat(16)));
    let other_app = artifacts.join(format!("com.other.app-{}", "b".repeat(16)));
    let not_a_fp_key = artifacts.join("com.rndevagent.testapp-scratch");
    for dir in [&stale, &other_app, &not_a_fp_key] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("old.app"), b"old bits").unwrap();
    }

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
    common::script_finite_ios_build(&mut mock);
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
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
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
    let cached = state.artifact.as_ref().unwrap();
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
    assert!(
        !stale.exists(),
        "an older fingerprint's artifact must be pruned"
    );
    assert!(
        other_app.exists(),
        "another app's artifact must never be pruned"
    );
    assert!(
        not_a_fp_key.exists(),
        "a directory that is not a fingerprint artifact must never be pruned"
    );
    assert_eq!(probing.inner.remaining(), 0);
    let prebuilds: Vec<_> = probing
        .inner
        .calls
        .iter()
        .filter(|spec| spec.label == "expo-prebuild")
        .collect();
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
        script_prepare_to_recheck(&mut mock, &repo, "", "");
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut probing = RecordProbeRunner {
            inner: mock,
            repo: repo.clone(),
            run_id: format!(
                "ios-simulator-{}",
                qaren::timefmt::compact_utc(1_770_000_000_000)
            ),
            probe_label: "simctl-launchctl".into(),
            observed: None,
            cancel_copy: None,
            copied_bytes: std::cell::Cell::new(0),
            at_probe: Some(Box::new(move |run_dir| {
                let repo = run_dir.parent().unwrap();
                let cache = qaren::buildplan::cache_dir(repo);
                std::fs::create_dir_all(&cache).unwrap();
                match fault {
                    "copy" => std::fs::write(cache.join("artifacts"), b"not a directory").unwrap(),
                    "hash" => std::fs::write(
                        run_dir.join("ios-build/testapp.app/binary"),
                        b"changed after install",
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
            if fault == "record_save" {
                ReceiptResult::Failed
            } else {
                ReceiptResult::Ready
            },
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
        script_prepare_to_recheck(&mut mock, &repo, "", "");
        mock.expect_run("ls-files", CmdOutput::success(""));
        common::script_xcode(&mut mock);
        let mut probing = RecordProbeRunner {
            inner: mock,
            repo: repo.clone(),
            run_id: format!(
                "ios-simulator-{}",
                qaren::timefmt::compact_utc(1_770_000_000_000)
            ),
            probe_label: "simctl-launchctl".into(),
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
        assert_eq!(receipt.result, ReceiptResult::Ready, "{target}");
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
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
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
    let artifacts = qaren::buildplan::cache_dir(&repo).join("artifacts/ios");
    let stale = artifacts.join(format!("com.rndevagent.testapp-{}", "a".repeat(16)));
    std::fs::create_dir_all(&stale).unwrap();
    std::fs::write(stale.join("old.app"), b"pruning canary").unwrap();
    let previous = std::rc::Rc::new(std::cell::RefCell::new(std::path::PathBuf::new()));
    let previous_path = previous.clone();
    let saved_state = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let expected_state = saved_state.clone();
    let state_path = qaren::buildplan::state_path(&repo, "ios", "com.rndevagent.testapp");
    let mut mock = MockRunner::new();
    script_prepare_to_recheck(&mut mock, &repo, "", "");
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "simctl-launchctl".into(),
        observed: None,
        cancel_copy: Some(staged_binary),
        copied_bytes: std::cell::Cell::new(0),
        at_probe: Some(Box::new(move |run_dir| {
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            let fp = record.build.as_ref().unwrap().fingerprint.clone();
            let key: String = fp
                .chars()
                .filter(|c| c.is_ascii_hexdigit())
                .take(16)
                .collect();
            let root = record.candidate.repo_root.clone();
            *copy_path.borrow_mut() = qaren::buildplan::cache_dir(&root)
                .join("artifacts/ios")
                .join(format!("com.rndevagent.testapp-{key}"))
                .join(format!(".staging-{}", record.run_id))
                .join("testapp.app/binary");
            std::fs::write(
                run_dir.join("ios-build/testapp.app/binary"),
                vec![7u8; 2 * 1024 * 1024],
            )
            .unwrap();
            let old = copy_path
                .borrow()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .join("testapp.app");
            std::fs::create_dir_all(&old).unwrap();
            std::fs::write(old.join("binary"), b"previous build").unwrap();
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
                artifact: Some(qaren::buildplan::CachedArtifact {
                    sha256: qaren::buildplan::hash_artifact(&old).unwrap(),
                    path: old.clone(),
                    kind: qaren::buildplan::ArtifactKind::AppBundle,
                }),
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
    assert_eq!(
        std::fs::read(stale.join("old.app")).unwrap(),
        b"pruning canary"
    );
    let staged = probing.cancel_copy.as_ref().unwrap().borrow();
    let staging_dir = staged.parent().unwrap().parent().unwrap();
    assert!(!staging_dir.exists());
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
