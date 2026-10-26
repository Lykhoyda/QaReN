mod common;

use qaren::buildplan::{ArtifactKind, CachedArtifact};
use qaren::commands::cleanup::{cleanup, cleanup_with};
use qaren::exec::{CmdOutput, CmdSpec, MockRunner, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{
    AdbServerResource, AppInstallResource, AppRemoval, FarmResource, IosSimResource, Phase,
    RunRecord, TunnelResource, UsbDeviceResource,
};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";
const FOREIGN_LSTART: &str = "Thu Aug 13 09:00:00 2026";
const APP: &str = "com.rndevagent.testapp";
const SERIAL: &str = "127.0.0.1:5555";
const APK_SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const APK_PATH: &str = "/data/app/~~AbC-12==/com.rndevagent.testapp-XyZ_34==/base.apk";
const CONFIRM: &str = "androidrun1/emulator-5554/com.rndevagent.testapp";
const FARM_OURS: &str = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-androidrun1 claimed_at=x state=device\n";
const FARM_FREE: &str =
    "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n";

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn exit1_silent() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn install_provenance(repo: &std::path::Path) -> AppInstallResource {
    AppInstallResource {
        app_id: APP.to_string(),
        serial: SERIAL.to_string(),
        server_port: 15037,
        artifact: CachedArtifact {
            path: repo.join("cache").join("app-debug.apk"),
            sha256: APK_SHA.to_string(),
            kind: ArtifactKind::Apk,
        },
        via: "adb-install".to_string(),
        installed_at: "2026-08-12T16:02:00Z".to_string(),
        removal: None,
    }
}

fn owned_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::android_scenario_yaml(8792),
        "androidrun1",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun1".to_string(),
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
    record.resources.adb_local_serial = Some(SERIAL.to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    record.resources.adb_server = Some(AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15037,
        log: repo.join("adb-server.log"),
    });
    record.resources.app_install = Some(install_provenance(repo));
    record
}

// The ownership recheck at the destructive boundary: live farm tuple, tunnel
// and adb server birth identities, then the device answering on the owned path.
fn expect_ownership_proof(mock: &mut MockRunner) {
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(FARM_OURS));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // adb server
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run(
        &format!("-s {SERIAL} get-state"),
        CmdOutput::success("device\n"),
    );
}

fn expect_installed_matching(mock: &mut MockRunner) {
    mock.expect_run(
        &format!("-s {SERIAL} shell pm path {APP}"),
        CmdOutput::success(&format!("package:{APK_PATH}\n")),
    );
    mock.expect_run(
        &format!("-s {SERIAL} shell sha256sum {APK_PATH}"),
        CmdOutput::success(&format!("{APK_SHA}  {APK_PATH}\n")),
    );
}

fn expect_absence_probes(mock: &mut MockRunner) {
    mock.expect_run(&format!("-s {SERIAL} shell pm path {APP}"), exit1_silent());
    mock.expect_run(
        &format!("-s {SERIAL} shell pm list packages {APP}"),
        CmdOutput::success(""),
    );
}

// Existing teardown for a record whose connection, server and tunnel are alive
// and whose lease is ours (mirrors android_cleanup_stops_only_own_lease).
fn expect_teardown_alive(mock: &mut MockRunner) {
    expect_local_teardown_alive(mock);
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(FARM_OURS));
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );
}

fn expect_local_teardown_alive(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run(
        &format!("disconnect {SERIAL}"),
        CmdOutput::success(&format!("disconnected {SERIAL}\n")),
    );
    for (pgid, port_owner) in [(7100, "7100"), (7000, "7000")] {
        mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
        mock.expect_run("ps", CmdOutput::success("S\n"));
        mock.expect_run("lsof", CmdOutput::success(&format!("{pgid}\n")));
        mock.expect_run("ps", CmdOutput::success(&format!("{port_owner}\n")));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill", CmdOutput::success(""));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill", CmdOutput::success(""));
        mock.expect_run("ps", CmdOutput::failed(1, ""));
        mock.expect_run("lsof", free_port());
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    }
}

// Everything already gone: a repeat cleanup finds only absence.
fn expect_teardown_dead(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::failed(1, "")); // connection: server dead
    mock.expect_run("ps", CmdOutput::failed(1, "")); // server group
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("ps", CmdOutput::failed(1, "")); // tunnel group
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(FARM_FREE));
}

fn index_of(calls: &[CmdSpec], hint: &str) -> Option<usize> {
    calls.iter().position(|c| c.rendered().contains(hint))
}

fn touches_package(calls: &[CmdSpec]) -> bool {
    calls.iter().any(|c| {
        let rendered = c.rendered();
        rendered.contains("uninstall") || rendered.contains("pm ") || rendered.contains("sha256sum")
    })
}

#[test]
fn confirmed_removal_uninstalls_exact_package_before_disconnect_and_lease_release() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    expect_absence_probes(&mut mock);
    expect_teardown_alive(&mut mock);

    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?} failure: {:?}",
        receipt.cleanup,
        receipt.failure
    );
    assert_eq!(receipt.cleanup.get("app_install").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(mock.remaining(), 0);

    let uninstall = mock
        .calls
        .iter()
        .find(|c| c.label == "adb-uninstall")
        .expect("an uninstall command must run");
    assert_eq!(uninstall.program, repo.join("adb").to_string_lossy());
    assert_eq!(uninstall.args, vec!["-s", SERIAL, "uninstall", APP]);
    assert!(
        uninstall.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15037".to_string()
        )),
        "the uninstall must route through the run's private adb server"
    );

    let calls = &mock.calls;
    let farm_status = index_of(calls, "android-farm status").unwrap();
    let get_state = index_of(calls, "get-state").unwrap();
    let hash = index_of(calls, "sha256sum").unwrap();
    let uninstall_at = index_of(calls, " uninstall ").unwrap();
    let path_after = calls
        .iter()
        .rposition(|c| c.label == "adb-pm-path")
        .unwrap();
    let list_after = index_of(calls, "pm list packages").unwrap();
    let disconnect = index_of(calls, "disconnect").unwrap();
    let farm_stop = index_of(calls, "android-farm stop").unwrap();
    assert!(farm_status < get_state && get_state < hash && hash < uninstall_at);
    assert!(uninstall_at < path_after && uninstall_at < list_after);
    assert!(
        path_after < disconnect && list_after < disconnect && disconnect < farm_stop,
        "absence must be proven on the live owned connection before it is torn down"
    );

    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    assert_eq!(reloaded.phase, Phase::Cleaned);
    let removal = reloaded
        .resources
        .app_install
        .as_ref()
        .unwrap()
        .removal
        .as_ref()
        .expect("the removal must be durable in the run record");
    assert_eq!(removal.outcome, "removed");
    assert_eq!(removal.installed_sha256, APK_SHA);
    assert!(!removal.at.is_empty());
    assert!(removal.pm_path_after.contains("exit=1"));
    assert!(removal.package_list_after.contains("exit=0"));
    for key in [
        "app_removal_at",
        "app_removal_pm_path",
        "app_removal_package_list",
        "app_installed_sha256",
    ] {
        assert!(
            receipt.outcomes.contains_key(key),
            "receipt must carry {key}: {:?}",
            receipt.outcomes
        );
    }
}

#[test]
fn cli_typo_then_confirmed_removal_and_repeat_preserve_the_removal_proof() {
    let repo = common::temp_repo();
    // The binary resolves run records under $HOME/.qaren/runs; point HOME at
    // the temp tree so the record it reads is the one this test wrote.
    let home = repo.join("home");
    let runs_root = home.join(".qaren").join("runs");
    owned_record(&repo).save(&runs_root).unwrap();
    let record_path = RunRecord::path(&runs_root, "androidrun1");
    let before = std::fs::read(&record_path).unwrap();
    let args = [
        "cleanup",
        "androidrun1",
        "--json",
        "--remove-app",
        "--confirm-remove-app",
        "androidrun1/emulator-5554/com.wrong.app",
    ];
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_qaren"))
        .current_dir(&repo)
        .env("HOME", &home)
        .args(args)
        .output()
        .unwrap();
    let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert_eq!(refused["result"], "refused");
    assert_eq!(refused["failure"]["code"], "APP_REMOVAL_NOT_CONFIRMED");
    assert_eq!(refused["commands_executed"], 0); // Refused before any command runs.
    assert_eq!(std::fs::read(&record_path).unwrap(), before);

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    expect_absence_probes(&mut mock);
    expect_teardown_alive(&mut mock);
    let removed = cleanup_with(&mut mock, &runs_root, "androidrun1", Some(CONFIRM));
    assert_eq!(removed.result, ReceiptResult::Cleaned);
    assert_eq!(removed.cleanup["app_install"], "removed");
    assert_eq!(mock.remaining(), 0);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(
        saved["resources"]["app_install"]["removal"]["outcome"],
        "removed"
    );

    let mut repeat_mock = MockRunner::new();
    expect_teardown_dead(&mut repeat_mock);
    let repeated = cleanup_with(&mut repeat_mock, &runs_root, "androidrun1", Some(CONFIRM));
    assert_eq!(repeated.result, ReceiptResult::Cleaned);
    assert_eq!(repeated.cleanup["app_install"], "absent");
    assert!(!touches_package(&repeat_mock.calls));
    assert_eq!(repeat_mock.remaining(), 0);
    let after_repeat: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    assert_eq!(
        after_repeat["resources"]["app_install"]["removal"],
        saved["resources"]["app_install"]["removal"]
    );

    println!(
        "REMOVAL_JOURNEY_EVIDENCE={}",
        serde_json::json!({
            "scope": "Real CLI typo refusal; removal and repeat execute cleanup_with using MockRunner. No device or farm allocation.",
            "cli": { "args": args, "exit": output.status.code(), "receipt": refused,
                "stderr": String::from_utf8_lossy(&output.stderr), "run_record_unchanged": true },
            "removal": { "receipt": removed, "commands": mock.calls, "persisted_run_record": saved },
            "repeat": { "receipt": repeated, "commands": repeat_mock.calls,
                "persisted_removal": after_repeat["resources"]["app_install"]["removal"] }
        })
    );
    std::fs::remove_dir_all(repo).unwrap();
}

#[test]
fn repeat_after_proven_removal_never_readdresses_the_device() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    record.resources.app_install.as_mut().unwrap().removal = Some(AppRemoval {
        at: "2026-09-05T10:00:00Z".to_string(),
        outcome: qaren::redact::OutputText::from_output("removed"),
        installed_sha256: APK_SHA.to_string(),
        uninstall: qaren::redact::OutputText::from_output("exit=0 Success"),
        pm_path_after: qaren::redact::OutputText::from_output("exit=1"),
        package_list_after: qaren::redact::OutputText::from_output("exit=0"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_teardown_dead(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("app_install").unwrap(), "absent");
    assert_eq!(
        receipt.outcomes.get("app_removal_at").unwrap(),
        "2026-09-05T10:00:00Z",
        "a prior proof is reported as prior, not as a fresh probe"
    );
    assert!(!touches_package(&mock.calls));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn repeat_after_failed_removal_refuses_the_now_unowned_device() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    record.resources.app_install.as_mut().unwrap().removal = Some(AppRemoval {
        at: "2026-09-05T10:00:00Z".to_string(),
        outcome: qaren::redact::OutputText::from_output(
            "unresolved: package still present after uninstall",
        ),
        installed_sha256: APK_SHA.to_string(),
        uninstall: qaren::redact::OutputText::from_output("exit=1 Failure"),
        pm_path_after: qaren::redact::OutputText::from_output(&format!(
            "exit=0 package:{APK_PATH}"
        )),
        package_list_after: qaren::redact::OutputText::from_output(&format!(
            "exit=0 package:{APP}"
        )),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_teardown_dead(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("app_install")
        .unwrap()
        .starts_with("refused"));
    assert!(!touches_package(&mock.calls));
    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    let removal = reloaded.resources.app_install.unwrap().removal.unwrap();
    assert!(
        removal.outcome.starts_with("unresolved"),
        "historical unknown must not be upgraded: {}",
        removal.outcome
    );
    assert_ne!(reloaded.phase, Phase::Cleaned);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn interrupted_unresolved_removal_is_preserved_even_while_resources_are_owned() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    let prior = AppRemoval {
        at: "2026-09-05T10:00:00Z".to_string(),
        outcome: qaren::redact::OutputText::from_output(
            "unresolved: absence could not be proven: device offline",
        ),
        installed_sha256: APK_SHA.to_string(),
        uninstall: qaren::redact::OutputText::from_output(
            "exit=none timed_out=true stdout=\"\" stderr=\"\"",
        ),
        pm_path_after: qaren::redact::OutputText::from_output(
            "exit=1 stdout=\"\" stderr=\"device offline\"",
        ),
        package_list_after: qaren::redact::OutputText::from_output(
            "exit=1 stdout=\"\" stderr=\"device offline\"",
        ),
    };
    record.resources.app_install.as_mut().unwrap().removal = Some(prior.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(!touches_package(&mock.calls));
    assert!(!mock.calls.iter().any(|c| c.label == "adb-get-state"));
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
    assert_eq!(
        serde_json::to_value(reloaded.resources.app_install.unwrap().removal.unwrap()).unwrap(),
        serde_json::to_value(&prior).unwrap()
    );
    for (key, value) in [
        ("app_removal_at", prior.at.as_str()),
        ("app_removal_outcome", prior.outcome.as_str()),
        ("app_installed_sha256", prior.installed_sha256.as_str()),
        ("app_removal_uninstall", prior.uninstall.as_str()),
        ("app_removal_pm_path", prior.pm_path_after.as_str()),
        (
            "app_removal_package_list",
            prior.package_list_after.as_str(),
        ),
    ] {
        assert_eq!(receipt.outcomes.get(key).unwrap(), value);
    }
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn unsuccessful_removal_after_legacy_cleanup_clears_cleaned_phase() {
    for farm_status in [
        CmdOutput::success(FARM_FREE),
        CmdOutput::failed(1, "farm unreachable"),
    ] {
        let repo = common::temp_repo();
        owned_record(&repo).save(&repo).unwrap();
        let mut legacy = MockRunner::new();
        expect_teardown_alive(&mut legacy);
        assert_eq!(
            cleanup(&mut legacy, &repo, "androidrun1").result,
            ReceiptResult::Cleaned
        );
        assert_eq!(
            RunRecord::load(&repo, "androidrun1").unwrap().phase,
            Phase::Cleaned
        );
        assert_eq!(legacy.remaining(), 0);

        let expected = if farm_status.ok() {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        };
        let mut mock = MockRunner::new();
        mock.expect_run("~/bin/android-farm status", farm_status);
        expect_teardown_dead(&mut mock);
        let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
        assert_eq!(receipt.result, expected);
        assert_eq!(receipt.phase, "failed");
        assert_eq!(
            RunRecord::load(&repo, "androidrun1").unwrap().phase,
            Phase::Failed
        );
        assert!(!touches_package(&mock.calls));
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn legacy_cleanup_without_opt_in_never_touches_the_package() {
    let repo = common::temp_repo();
    let run_dir = RunRecord::run_dir(&repo, "androidrun1");
    std::fs::create_dir_all(&run_dir).unwrap();
    let vendor_key = run_dir.join("nuc-adbkey");
    std::fs::write(&vendor_key, "FAKEKEY").unwrap();
    let mut record = owned_record(&repo);
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_teardown_alive(&mut mock);
    let receipt = cleanup(&mut mock, &repo, "androidrun1");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert!(
        !receipt.cleanup.contains_key("app_install"),
        "legacy cleanup must not claim anything about the app: {:?}",
        receipt.cleanup
    );
    assert!(!touches_package(&mock.calls));
    assert!(!vendor_key.exists());
    assert_eq!(mock.remaining(), 0);
    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    assert!(reloaded.resources.app_install.unwrap().removal.is_none());
}

#[test]
fn mismatched_confirmation_refuses_everything_before_any_command() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    for bad in [
        "androidrun1/emulator-5556/com.rndevagent.testapp",
        "androidrun1/emulator-5554/com.other.app",
        "androidrun9/emulator-5554/com.rndevagent.testapp",
        "androidrun1/emulator-5554",
        "",
    ] {
        let mut mock = MockRunner::new();
        let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(bad));
        assert_eq!(receipt.result, ReceiptResult::Refused, "{bad:?}");
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::AppRemovalNotConfirmed,
            "{bad:?}"
        );
        assert!(mock.calls.is_empty(), "{bad:?} must not run anything");
    }
    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    assert_eq!(reloaded.phase, Phase::Ready);
    assert!(
        reloaded.history.is_empty(),
        "a refused request mutates nothing"
    );
}

#[test]
fn removal_is_refused_for_ios_and_usb_routes_before_any_command() {
    let repo = common::temp_repo();
    let mut ios = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "iosrun1",
        Phase::Ready,
    );
    ios.resources.ios_simulator = Some(IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: "qaren-iosrun1".to_string(),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    ios.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = cleanup_with(
        &mut mock,
        &repo,
        "iosrun1",
        Some("iosrun1/AAAA-1111/com.rndevagent.testapp"),
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::AppRemovalNotConfirmed
    );
    assert!(mock.calls.is_empty());

    let mut usb = owned_record(&repo);
    usb.run_id = "usbrun1".to_string();
    usb.resources.farm = None;
    usb.resources.tunnel = None;
    usb.resources.usb_device = Some(UsbDeviceResource {
        serial: "R5CT123ABC".to_string(),
        lock_dir: repo.join("locks").join("usb-R5CT123ABC"),
        holder: "qaren-usbrun1".to_string(),
    });
    usb.resources.adb_local_serial = Some("R5CT123ABC".to_string());
    usb.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = cleanup_with(
        &mut mock,
        &repo,
        "usbrun1",
        Some("usbrun1/R5CT123ABC/com.rndevagent.testapp"),
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::AppRemovalNotConfirmed
    );
    assert!(mock.calls.is_empty(), "USB devices are outside this slice");
}

#[test]
fn missing_install_provenance_refuses_removal_while_resources_still_clean_up() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    record.resources.app_install = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(
        receipt.result,
        ReceiptResult::Refused,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::OwnershipUnproven
    );
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        "refused: no successful installation is recorded for this run; a legacy record cannot prove which package it owns"
    );
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert!(!touches_package(&mock.calls));
    assert_eq!(mock.remaining(), 0);
    assert_ne!(
        RunRecord::load(&repo, "androidrun1").unwrap().phase,
        Phase::Cleaned
    );
}

#[test]
fn provenance_bound_to_another_server_or_serial_is_refused_without_commands() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    record.resources.app_install.as_mut().unwrap().server_port = 15038;
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert!(receipt
        .cleanup
        .get("app_install")
        .unwrap()
        .starts_with("refused"));
    assert!(!touches_package(&mock.calls));
    assert_eq!(receipt.result, ReceiptResult::Refused);
}

#[test]
fn foreign_lease_refuses_removal_with_no_device_command() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=someone-else claimed_at=x state=device\n"),
    );
    // Resource teardown: connection/server/tunnel are ours and alive; the farm
    // leg independently refuses the foreign lease.
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run(
        &format!("disconnect {SERIAL}"),
        CmdOutput::success(&format!("disconnected {SERIAL}\n")),
    );
    for (pgid, port_owner) in [(7100, "7100"), (7000, "7000")] {
        mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
        mock.expect_run("ps", CmdOutput::success("S\n"));
        mock.expect_run("lsof", CmdOutput::success(&format!("{pgid}\n")));
        mock.expect_run("ps", CmdOutput::success(&format!("{port_owner}\n")));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill", CmdOutput::success(""));
        mock.expect_run("lstart=", CmdOutput::success(LSTART));
        mock.expect_run("stat=", CmdOutput::success("S"));
        mock.expect_run("/bin/kill", CmdOutput::success(""));
        mock.expect_run("ps", CmdOutput::failed(1, ""));
        mock.expect_run("lsof", free_port());
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    }
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=someone-else claimed_at=x state=device\n"),
    );
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("app_install")
        .unwrap()
        .contains("someone-else"));
    assert!(
        !mock.calls.iter().any(|c| c.label == "adb-get-state") && !touches_package(&mock.calls),
        "a foreign lease means the device is never addressed"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn slot_identity_drift_refuses_removal() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // Same holder, different emulator behind the slot.
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10_Pro serial=emulator-5554 adb_port=5555 lease=qaren-androidrun1 claimed_at=x state=device\n"),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert!(receipt
        .cleanup
        .get("app_install")
        .unwrap()
        .starts_with("refused"));
    assert!(!touches_package(&mock.calls));
    assert_eq!(receipt.result, ReceiptResult::Refused);
}

#[test]
fn foreign_adb_server_identity_refuses_removal() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(FARM_OURS));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel ok
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{FOREIGN_LSTART}\n")));
    // Teardown leaves the foreign server untouched and unresolved.
    mock.expect_run("ps", CmdOutput::success(&format!("{FOREIGN_LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success(&format!("{FOREIGN_LSTART}\n")));
    mock.expect_run("lsof", free_port());
    // tunnel alive -> killed
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(FARM_OURS));
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert!(receipt
        .cleanup
        .get("app_install")
        .unwrap()
        .starts_with("refused"));
    assert!(
        !mock.calls.iter().any(|c| c.label == "adb-get-state") && !touches_package(&mock.calls),
        "without the run's own server there is no owned path to the device"
    );
    assert!(receipt.cleanup["adb_server"].starts_with("unresolved"));
    assert_eq!(receipt.cleanup["tunnel"], "removed");
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.label == "kill-group" && c.args.last().is_some_and(|arg| arg == "-7100")));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn installed_apk_hash_mismatch_refuses_removal() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} shell pm path {APP}"),
        CmdOutput::success(&format!("package:{APK_PATH}\n")),
    );
    mock.expect_run(
        "sha256sum",
        CmdOutput::success(&format!("{}  {APK_PATH}\n", "f".repeat(64))),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        &format!(
            "refused: installed base.apk sha256 {} does not match this run's installed artifact {APK_SHA}",
            "f".repeat(64)
        )
    );
    assert!(!mock.calls.iter().any(|c| c.label == "adb-uninstall"));
    assert!(
        RunRecord::load(&repo, "androidrun1")
            .unwrap()
            .resources
            .app_install
            .unwrap()
            .removal
            .is_none(),
        "a refusal before the device is addressed records no removal attempt"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn installed_apk_hash_read_failure_is_unresolved_not_removed() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} shell pm path {APP}"),
        CmdOutput::success(&format!("package:{APK_PATH}\n")),
    );
    mock.expect_run(
        "sha256sum",
        CmdOutput::failed(1, "sha256sum: /data/app/base.apk: Permission denied"),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CleanupIncomplete
    );
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        "unresolved: installed APK hash could not be read: exit=1 sha256sum: /data/app/base.apk: Permission denied"
    );
    assert!(!mock.calls.iter().any(|c| c.label == "adb-uninstall"));
    assert_ne!(
        RunRecord::load(&repo, "androidrun1").unwrap().phase,
        Phase::Cleaned
    );
}

#[test]
fn partial_installed_path_errors_never_authorize_hashing_or_uninstall() {
    for (exit_code, stderr, timed_out) in [
        (Some(1), "error: device offline", false),
        (Some(1), "", false),
        (Some(0), "error: device offline", false),
        (Some(0), " \n", false),
        (None, "", false),
        (Some(0), "", true),
    ] {
        let repo = common::temp_repo();
        owned_record(&repo).save(&repo).unwrap();
        let mut mock = MockRunner::new();
        expect_ownership_proof(&mut mock);
        mock.expect_run(
            &format!("-s {SERIAL} shell pm path {APP}"),
            CmdOutput {
                exit_code,
                stdout: format!("package:{APK_PATH}\n"),
                stderr: stderr.to_string(),
                timed_out,
                ..Default::default()
            },
        );
        expect_teardown_alive(&mut mock);
        let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert!(receipt
            .cleanup
            .get("app_install")
            .unwrap()
            .starts_with("unresolved: pm path:"));
        assert!(!mock
            .calls
            .iter()
            .any(|c| c.label == "adb-sha256sum" || c.label == "adb-uninstall"));
        assert!(RunRecord::load(&repo, "androidrun1")
            .unwrap()
            .resources
            .app_install
            .unwrap()
            .removal
            .is_none());
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn split_or_unexpected_apk_paths_refuse_removal() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    for pm_path in [
        format!("package:{APK_PATH}\npackage:/data/app/~~AbC==/com.rndevagent.testapp-XyZ==/split_config.arm64_v8a.apk\n"),
        "package:/system/priv-app/Foo/base.apk\n".to_string(),
        "package:/data/app/../../system/base.apk\n".to_string(),
        "package:/data/app/x/base.apk; rm -rf /\n".to_string(),
    ] {
        let mut mock = MockRunner::new();
        expect_ownership_proof(&mut mock);
        mock.expect_run(
            &format!("-s {SERIAL} shell pm path {APP}"),
            CmdOutput::success(&pm_path),
        );
        expect_teardown_alive(&mut mock);
        let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
        assert!(
            receipt
                .cleanup
                .get("app_install")
                .unwrap()
                .starts_with("refused"),
            "{pm_path:?}: {:?}",
            receipt.cleanup
        );
        assert!(
            !mock
                .calls
                .iter()
                .any(|c| c.label == "adb-sha256sum" || c.label == "adb-uninstall"),
            "{pm_path:?}: neither a hash read nor an uninstall may target an unexpected path"
        );
        // The refused leg keeps the lease untouched only via the app leg; the
        // resource legs still release what is independently proven ours.
        assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
        // Re-arm the record for the next case: farm_lease removed does not
        // clear the recorded farm resource, but the phase is not Cleaned.
        assert_ne!(
            RunRecord::load(&repo, "androidrun1").unwrap().phase,
            Phase::Cleaned
        );
    }
}

#[test]
fn uninstall_failure_leaves_a_durable_unresolved_outcome_and_still_cleans_resources() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput {
            exit_code: Some(1),
            stdout: "Failure [DELETE_FAILED_INTERNAL_ERROR]\n".to_string(),
            ..Default::default()
        },
    );
    mock.expect_run(
        &format!("-s {SERIAL} shell pm path {APP}"),
        CmdOutput::success(&format!("package:{APK_PATH}\n")),
    );
    mock.expect_run(
        &format!("-s {SERIAL} shell pm list packages {APP}"),
        CmdOutput::success(&format!("package:{APP}\n")),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        "unresolved: package still present after uninstall"
    );
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("adb_server").unwrap(), "removed");
    let reloaded = RunRecord::load(&repo, "androidrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
    let removal = reloaded.resources.app_install.unwrap().removal.unwrap();
    assert_eq!(
        removal.outcome,
        "unresolved: package still present after uninstall"
    );
    assert_eq!(
        removal.uninstall,
        "exit=1 timed_out=false stdout=\"Failure [DELETE_FAILED_INTERNAL_ERROR]\\n\" stderr=\"\""
    );
    assert!(removal.pm_path_after.contains("package:"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn package_still_present_after_a_reported_success_is_unresolved() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    mock.expect_run(&format!("-s {SERIAL} shell pm path {APP}"), exit1_silent());
    // The exact package list still names it: the pm path silence proves nothing.
    mock.expect_run(
        &format!("-s {SERIAL} shell pm list packages {APP}"),
        CmdOutput::success(&format!("package:{APP}.dev\npackage:{APP}\n")),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        "unresolved: package still present after uninstall"
    );
}

#[test]
fn absence_probe_transport_errors_are_unknown_not_absent() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    mock.expect_run(
        &format!("-s {SERIAL} shell pm path {APP}"),
        CmdOutput::failed(1, "error: device offline"),
    );
    mock.expect_run(
        &format!("-s {SERIAL} shell pm list packages {APP}"),
        CmdOutput::failed(1, "error: device offline"),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.cleanup.get("app_install").unwrap(),
        "unresolved: absence could not be proven: pm list packages: exit=1 error: device offline"
    );
    let removal = RunRecord::load(&repo, "androidrun1")
        .unwrap()
        .resources
        .app_install
        .unwrap()
        .removal
        .unwrap();
    assert_eq!(
        removal.pm_path_after,
        "exit=1 timed_out=false stdout=\"\" stderr=\"error: device offline\""
    );
    assert_ne!(removal.outcome, "removed");
}

#[test]
fn absence_probe_stderr_never_proves_absence_before_or_after_uninstall() {
    for after_uninstall in [false, true] {
        for probe in ["path", "list"] {
            for stderr in ["error: device offline", " \t\n"] {
                let repo = common::temp_repo();
                owned_record(&repo).save(&repo).unwrap();
                let mut mock = MockRunner::new();
                expect_ownership_proof(&mut mock);
                if after_uninstall {
                    expect_installed_matching(&mut mock);
                    mock.expect_run(
                        &format!("-s {SERIAL} uninstall {APP}"),
                        CmdOutput::success("Success\n"),
                    );
                }
                let mut path = exit1_silent();
                let mut list = CmdOutput::success("");
                if probe == "path" {
                    path.stderr = stderr.to_string();
                } else {
                    list.stderr = stderr.to_string();
                }
                mock.expect_run(&format!("-s {SERIAL} shell pm path {APP}"), path);
                mock.expect_run(&format!("-s {SERIAL} shell pm list packages {APP}"), list);
                expect_teardown_alive(&mut mock);

                let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
                assert_eq!(receipt.result, ReceiptResult::Failed, "{receipt:?}");
                assert!(receipt.cleanup["app_install"].starts_with("unresolved:"));
                let saved = RunRecord::load(&repo, "androidrun1").unwrap();
                assert_ne!(saved.phase, Phase::Cleaned);
                let removal = saved.resources.app_install.unwrap().removal;
                if after_uninstall {
                    assert!(removal.unwrap().outcome.starts_with("unresolved:"));
                } else {
                    assert!(removal.is_none());
                    assert!(!mock.calls.iter().any(|c| c.label == "adb-uninstall"));
                }
                assert_eq!(mock.remaining(), 0);
            }
        }
    }
}

#[test]
fn removal_save_failure_retains_lease_but_cleans_owned_local_resources() {
    let repo = common::temp_repo();
    let mut record = owned_record(&repo);
    let vendor_key = RunRecord::run_dir(&repo, "androidrun1").join("adbkey");
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();
    std::fs::write(&vendor_key, "owned key").unwrap();
    let blocked_save = RunRecord::run_dir(&repo, "androidrun1")
        .join(format!(".run.json.tmp.{}", std::process::id()));
    std::fs::create_dir(&blocked_save).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    expect_absence_probes(&mut mock);
    expect_local_teardown_alive(&mut mock);

    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Refused, "{receipt:?}");
    assert!(receipt.cleanup["app_install"].starts_with("unresolved:"));
    assert!(receipt.cleanup["app_install"].contains("could not be persisted"));
    assert!(receipt.cleanup["farm_lease"].starts_with("refused:"));
    assert!(receipt.cleanup["farm_lease"].contains("removal evidence"));
    for resource in ["adb_connection", "adb_server", "tunnel", "adb_vendor_key"] {
        assert_eq!(receipt.cleanup[resource], "removed");
    }
    assert!(!vendor_key.exists());
    assert_eq!(receipt.outcomes["app_removal_outcome"], "removed");
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::RunRecordUpdateFailed
    );
    let saved = RunRecord::load(&repo, "androidrun1").unwrap();
    assert_ne!(saved.phase, Phase::Cleaned);
    assert!(saved.resources.app_install.unwrap().removal.is_none());
    assert!(!mock
        .calls
        .iter()
        .any(|c| c.rendered().contains("android-farm stop")));
    let probes_done = index_of(&mock.calls, "pm list packages").unwrap();
    let disconnect = index_of(&mock.calls, "disconnect").unwrap();
    assert!(probes_done < disconnect);
    assert_eq!(mock.remaining(), 0);
    std::fs::remove_dir(blocked_save).unwrap();
}

#[test]
fn removal_evidence_preserves_complete_streams_in_record_and_receipt() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();
    let outputs: Vec<CmdOutput> = (0..3)
        .map(|i| CmdOutput {
            exit_code: Some(i + 1),
            stdout: format!(" \n{i}:{}\nstdout end \t\n", "out ü ".repeat(100)),
            stderr: format!(" \t{i}:{}\nstderr end \n", "err λ ".repeat(100)),
            timed_out: i == 0,
            ..Default::default()
        })
        .collect();
    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    for (command, output) in [
        (format!("-s {SERIAL} uninstall {APP}"), &outputs[0]),
        (format!("-s {SERIAL} shell pm path {APP}"), &outputs[1]),
        (
            format!("-s {SERIAL} shell pm list packages {APP}"),
            &outputs[2],
        ),
    ] {
        mock.expect_run(&command, output.clone());
    }
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let removal = RunRecord::load(&repo, "androidrun1")
        .unwrap()
        .resources
        .app_install
        .unwrap()
        .removal
        .unwrap();
    for ((key, persisted), output) in [
        ("app_removal_uninstall", &removal.uninstall),
        ("app_removal_pm_path", &removal.pm_path_after),
        ("app_removal_package_list", &removal.package_list_after),
    ]
    .into_iter()
    .zip(&outputs)
    {
        let expected = format!(
            "exit={} timed_out={} stdout={:?} stderr={:?}",
            output.exit_code.unwrap(),
            output.timed_out,
            output.stdout,
            output.stderr
        );
        assert_eq!(persisted, &expected);
        assert_eq!(receipt.outcomes.get(key).unwrap(), &expected);
    }
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn sibling_package_in_list_does_not_hide_absence() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    mock.expect_run(
        &format!("-s {SERIAL} uninstall {APP}"),
        CmdOutput::success("Success\n"),
    );
    mock.expect_run(&format!("-s {SERIAL} shell pm path {APP}"), exit1_silent());
    mock.expect_run(
        &format!("-s {SERIAL} shell pm list packages {APP}"),
        CmdOutput::success(&format!("package:{APP}.dev\n")),
    );
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("app_install").unwrap(), "removed");
}

#[test]
fn removal_evidence_redacts_dotenv_output_before_saving_the_record() {
    let repo = common::temp_repo();
    owned_record(&repo).save(&repo).unwrap();
    let mut mock = MockRunner::new();
    expect_ownership_proof(&mut mock);
    expect_installed_matching(&mut mock);
    for command in [
        format!("-s {SERIAL} uninstall {APP}"),
        format!("-s {SERIAL} shell pm path {APP}"),
        format!("-s {SERIAL} shell pm list packages {APP}"),
    ] {
        mock.expect_run(
            &command,
            CmdOutput {
                exit_code: Some(1),
                stdout: "diagnostic TYPESAFE_API_KEY=synthetic-removal-key end".into(),
                ..Default::default()
            },
        );
    }
    expect_teardown_alive(&mut mock);
    let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let record = std::fs::read_to_string(repo.join("androidrun1/run.json")).unwrap();
    assert!(!record.contains("synthetic-removal-key"));
    assert!(record.contains("diagnostic TYPESAFE_API_KEY=<redacted> end"));
    assert!(!receipt.to_json().contains("synthetic-removal-key"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn uninstall_probe_evidence_withholds_a_key_split_across_streams() {
    let body: Vec<String> = (0..8).map(|n| format!("FAKEKEYBODY{n}")).collect();
    for header in ["-----BEGIN PRIVATE KEY-----\n", "<redacted private key>\n"] {
        let repo = common::temp_repo();
        owned_record(&repo).save(&repo).unwrap();
        let mut mock = MockRunner::new();
        expect_ownership_proof(&mut mock);
        expect_installed_matching(&mut mock);
        mock.expect_run(
            &format!("-s {SERIAL} uninstall {APP}"),
            CmdOutput {
                exit_code: Some(1),
                stdout: body.join("\n") + "\n",
                stderr: header.to_string(),
                ..Default::default()
            },
        );
        mock.expect_run(
            &format!("-s {SERIAL} shell pm path {APP}"),
            CmdOutput::success(&format!("package:{APK_PATH}\n")),
        );
        mock.expect_run(
            &format!("-s {SERIAL} shell pm list packages {APP}"),
            CmdOutput::success(&format!("package:{APP}\n")),
        );
        expect_teardown_alive(&mut mock);
        let receipt = cleanup_with(&mut mock, &repo, "androidrun1", Some(CONFIRM));
        assert_eq!(receipt.result, ReceiptResult::Failed);
        let record = std::fs::read_to_string(repo.join("androidrun1/run.json")).unwrap();
        for evidence in [&record, &receipt.to_json()] {
            assert!(!evidence.contains("FAKEKEYBODY"), "{evidence}");
        }
        let removal = RunRecord::load(&repo, "androidrun1")
            .unwrap()
            .resources
            .app_install
            .unwrap()
            .removal
            .unwrap();
        assert_eq!(
            removal.uninstall,
            qaren::redact::PRIVATE_KEY_WITHHELD,
            "{header}"
        );
        assert_eq!(mock.remaining(), 0);
    }
}
