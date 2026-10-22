mod common;

use qaren::commands::status::status;
use qaren::exec::Spawned;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{
    FarmResource, IosSimResource, MetroResource, Phase, RunRecord, TunnelResource,
};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn ios_ready_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record =
        common::base_record(repo, &common::ios_scenario_yaml(8791), run_id, Phase::Ready);
    record.resources.ios_simulator = Some(IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: format!("qaren-{run_id}"),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.metro = Some(MetroResource {
        port: 8791,
        endpoint: "http://127.0.0.1:8791".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record
}

#[test]
fn ready_run_with_all_probes_passing_reports_ready() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run1").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"qaren-run1","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/path/to/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run1");
    assert_eq!(receipt.result, ReceiptResult::Ready);
    assert_eq!(receipt.outcomes.get("metro_responding").unwrap(), "pass");
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ready_run_with_dead_metro_reports_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run2").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"qaren-run2","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run("simctl get_app_container", CmdOutput::success("/path\n"));
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run2");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("metro_port_owned").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("metro_responding").unwrap(),
        "inconclusive"
    );
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert!(receipt.next_action.contains("cleanup"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn foreign_simulator_gates_app_probes_and_reports_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run3").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"foreign-sim","state":"Booted"}]}}"#,
        ),
    );

    let receipt = status(&mut mock, &repo, "run3");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("simulator_booted").unwrap(), "fail");
    assert_eq!(receipt.outcomes.get("app_probes").unwrap(), "inconclusive");
    assert_eq!(
        mock.remaining(),
        0,
        "app probes must not run against a foreign simulator"
    );
}

#[test]
fn cleaned_run_reports_cleaned_without_probes() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run4",
        Phase::Cleaned,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run4");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(mock.calls.is_empty());
}

#[test]
fn failed_run_echoes_recorded_failure() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run5",
        Phase::Failed,
    );
    record.failure = Some(qaren::failure::Failure::new(
        "build",
        FailureCode::BuildFailed,
        "xcodebuild exploded",
        "qaren cleanup run5 --json",
    ));
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run5");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed
    );
}

#[test]
fn interrupted_prepare_is_failed_with_interrupted_code() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run6",
        Phase::Building,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, "")); // prepare pid dead
    let receipt = status(&mut mock, &repo, "run6");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::Interrupted
    );
}

#[test]
fn live_prepare_reports_working() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run7",
        Phase::Building,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    let receipt = status(&mut mock, &repo, "run7");
    assert_eq!(receipt.result, ReceiptResult::Working);
    assert!(!receipt.outcomes.contains_key("substage"));
}

#[test]
fn live_building_status_names_the_substage_in_flight() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run7b",
        Phase::Building,
    );
    record.substage = Some("metro_ready".to_string());
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    let receipt = status(&mut mock, &repo, "run7b");
    assert_eq!(receipt.result, ReceiptResult::Working);
    assert_eq!(receipt.phase, "building");
    assert_eq!(receipt.outcomes["substage"], "metro_ready");
}

#[test]
fn android_unreachable_farm_reports_unknown() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "run8",
        Phase::Ready,
    );
    record.resources.metro = Some(MetroResource {
        port: 8792,
        endpoint: "http://127.0.0.1:8792".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-run8".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: Some(common::identity(7000, LSTART)),
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.adb_local_serial = Some("127.0.0.1:5555".to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("ssh", CmdOutput::failed(255, "ssh: timed out"));

    let receipt = status(&mut mock, &repo, "run8");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.outcomes.get("farm_lease_held").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "adb must not be addressed when the lease is unproven"
    );
}

fn android_ready_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::android_scenario_yaml(8792),
        run_id,
        Phase::Ready,
    );
    record.resources.metro = Some(MetroResource {
        port: 8792,
        endpoint: "http://127.0.0.1:8792".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: format!("qaren-{run_id}"),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: Some(common::identity(7000, LSTART)),
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.adb_local_serial = Some("127.0.0.1:5555".to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    record.resources.adb_server = Some(qaren::runrecord::AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15037,
        log: repo.join("adb-server.log"),
    });
    record.resources.adb_vendor_key = Some(repo.join("nuc-adbkey"));
    record
}

#[test]
fn android_ready_run_with_all_probes_passing_reports_ready() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run9").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-run9 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // adb server identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie

    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );

    let receipt = status(&mut mock, &repo, "run9");
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "outcomes: {:?}",
        receipt.outcomes
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_dead_tunnel_gates_adb_probes() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run10").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-run10 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::failed(1, "")); // tunnel dead

    let receipt = status(&mut mock, &repo, "run10");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("tunnel_alive").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "no adb command may run over a dead tunnel"
    );
}

#[test]
fn probe_infrastructure_errors_report_unknown_not_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run11").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // lsof spawn failure -> exit_code None -> port probe inconclusive
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: None,
            stderr: "spawn lsof: not found".to_string(),
            ..Default::default()
        },
    );
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"qaren-run11","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run("simctl get_app_container", CmdOutput::success("/path\n"));
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run11");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.outcomes.get("metro_port_owned").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        receipt.outcomes.get("metro_responding").unwrap(),
        "inconclusive"
    );
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_serial_port_mismatch_blocks_adb_probes() {
    let repo = common::temp_repo();
    let mut record = android_ready_record(&repo, "run12");
    // Record drift: farm says 5557 but the serial/tunnel still say 5555.
    record.resources.farm.as_mut().unwrap().adb_port = 5557;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5557 lease=qaren-run12 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie

    let receipt = status(&mut mock, &repo, "run12");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("adb_serial_recorded").unwrap(), "fail");
    assert_eq!(
        mock.remaining(),
        0,
        "no adb command may run on record drift"
    );
}

#[test]
fn farm_identity_drift_fails_lease_probe_despite_matching_holder() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run13").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    // Holder matches, but the slot was restarted with a different emulator:
    // serial and AVD drifted. The old tunnel may now reach a different device.
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5555 lease=qaren-run13 claimed_at=x state=device\n"),
    );

    let receipt = status(&mut mock, &repo, "run13");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("farm_lease_held").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "device probes must not run through a drifted slot"
    );
}

#[test]
fn failed_run_preserves_recorded_next_action() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run14",
        Phase::Failed,
    );
    // A pre-allocation failure records a fix-and-retry action; nothing is
    // owned, so status must not redirect automation to cleanup.
    record.failure = Some(qaren::failure::Failure::new(
        "deps",
        FailureCode::DepsInstallFailed,
        "pnpm install --frozen-lockfile: exit=1",
        "fix the dependency install in the candidate project, then re-run prepare",
    ));
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run14");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.next_action,
        "fix the dependency install in the candidate project, then re-run prepare"
    );
}

#[test]
fn status_of_missing_run_is_unknown() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "ghost");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUnavailable
    );
}

fn borrowed_walking_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        "schema: qaren/1\nname: check\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: 8792\nandroid_emulator:\n  serial: emulator-5554\n  avd: Pixel_9_API_37\n",
        "borrowed",
        Phase::Walking,
    );
    record.resources.android_emulator = Some(qaren::runrecord::BorrowedEmulatorResource {
        serial: "emulator-5554".to_string(),
        avd: "Pixel_9_API_37".to_string(),
        server_port: 5147,
        api_level: 37,
        abi: "x86_64".to_string(),
    });
    record.resources.adb_path = Some(repo.join("sdk/platform-tools/adb"));
    record.resources.adb_local_serial = Some("emulator-5554".to_string());
    record
}

#[test]
fn android_borrowed_status_probes_through_the_borrowed_server() {
    let repo = common::temp_repo();
    borrowed_walking_record(&repo).save(&repo).unwrap();
    let mut mock = MockRunner::new();
    mock.adb_servers.push((5147, 41));
    mock.expect_run(
        "adb version",
        CmdOutput::success("Android Debug Bridge version 1.0.41\n"),
    );
    mock.expect_run("-s emulator-5554 get-state", CmdOutput::success("device\n"));
    mock.expect_run(
        "-s emulator-5554 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run("-s emulator-5554 shell pidof", CmdOutput::success("4242\n"));

    let receipt = status(&mut mock, &repo, "borrowed");

    for probe in [
        "adb_server_alive",
        "device_online",
        "app_installed",
        "app_running",
    ] {
        assert_eq!(
            receipt.outcomes[probe], "pass",
            "{probe}: {:?}",
            receipt.outcomes
        );
    }
    assert!(!receipt.outcomes.contains_key("farm_recorded"));
    assert!(mock
        .calls
        .iter()
        .all(|c| !c.rendered().contains("android-farm")));
    for call in mock.calls.iter().filter(|c| c.label != "adb-version") {
        assert!(call.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:5147".to_string()
        )));
    }
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_borrowed_status_never_starts_or_restarts_the_adb_server() {
    for server in [None, Some(40)] {
        let repo = common::temp_repo();
        borrowed_walking_record(&repo).save(&repo).unwrap();
        let mut mock = MockRunner::new();
        if let Some(version) = server {
            mock.adb_servers.push((5147, version));
            mock.expect_run(
                "adb version",
                CmdOutput::success("Android Debug Bridge version 1.0.41\n"),
            );
        }

        let receipt = status(&mut mock, &repo, "borrowed");

        assert_eq!(receipt.outcomes["device_probes"], "inconclusive");
        assert!(!receipt.outcomes.contains_key("farm_recorded"));
        assert!(mock.calls.iter().all(|c| c.label == "adb-version"));
        assert_eq!(mock.remaining(), 0);
    }
}

const BORROWED: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";

fn borrowed_ready_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record = ios_ready_record(repo, run_id);
    record.resources.device_borrowed = true;
    record.resources.ios_simulator = Some(IosSimResource {
        udid: BORROWED.to_string(),
        name: "qa-lane".to_string(),
        device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro".to_string(),
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-4".to_string(),
    });
    record.resources.lease = Some(
        qaren::lease::acquire(
            &mut MockRunner::new(),
            &repo.join(".locks"),
            qaren::scenario::Platform::Ios,
            BORROWED,
            run_id,
            Some(common::identity(999, "Wed Aug 12 15:00:00 2026")),
        )
        .unwrap(),
    );
    record
}

fn borrowed_inventory(state: &str, runtime: &str) -> String {
    serde_json::json!({"devices": {format!("com.apple.CoreSimulator.SimRuntime.{runtime}"): [{
        "udid": BORROWED,
        "name": "renamed-by-the-lane-owner",
        "state": state,
        "isAvailable": true,
        "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
    }]}})
    .to_string()
}

fn script_owned_metro(mock: &mut MockRunner) {
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
}

#[test]
fn borrowed_ready_run_reports_ready_only_while_it_holds_the_lease_and_exact_target() {
    let repo = common::temp_repo();
    let record = borrowed_ready_record(&repo, "borrowed1");
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    script_owned_metro(&mut mock);
    mock.expect_run(
        "simctl list devices -j",
        CmdOutput::success(&borrowed_inventory("Booted", "iOS-26-4")),
    );
    mock.expect_run(
        &format!("simctl get_app_container {BORROWED}"),
        CmdOutput::success("/path/to/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    let receipt = status(&mut mock, &repo, "borrowed1");
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.outcomes
    );
    assert_eq!(receipt.outcomes["device_lease_held"], "pass");
    assert_eq!(mock.remaining(), 0);

    for inventory in [
        borrowed_inventory("Shutdown", "iOS-26-4"),
        borrowed_inventory("Booted", "iOS-26-5"),
        "not json".to_string(),
    ] {
        let mut mock = MockRunner::new();
        script_owned_metro(&mut mock);
        mock.expect_run("simctl list devices -j", CmdOutput::success(&inventory));
        let receipt = status(&mut mock, &repo, "borrowed1");
        assert_ne!(receipt.result, ReceiptResult::Ready, "{inventory}");
        assert_eq!(receipt.outcomes["app_probes"], "inconclusive");
        assert_eq!(mock.remaining(), 0);
    }

    // Custody moved on: the lease now names another run, so a visible app is not Ready.
    let lease = record.resources.lease.as_ref().unwrap();
    assert_eq!(
        qaren::lease::release(lease),
        qaren::buildplan::ReleaseOutcome::Removed
    );
    qaren::lease::acquire(
        &mut MockRunner::new(),
        &repo.join(".locks"),
        qaren::scenario::Platform::Ios,
        BORROWED,
        "check-later",
        Some(common::identity(1234, "Thu Aug 13 09:00:00 2026")),
    )
    .unwrap();
    let mut mock = MockRunner::new();
    script_owned_metro(&mut mock);
    let receipt = status(&mut mock, &repo, "borrowed1");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes["device_lease_held"], "fail");
    assert_eq!(receipt.outcomes["app_probes"], "inconclusive");
    assert_eq!(mock.remaining(), 0);
    assert!(!mock.calls.iter().any(|c| c.rendered().contains("simctl")));
}
