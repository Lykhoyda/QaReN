mod common;

use qaren::buildplan::{
    self, ArtifactKind, BuildDecision, CachedArtifact, NativeCacheState, CACHE_SCHEMA,
    PREWARM_SCHEMA,
};
use qaren::commands::prepare::{prepare, PrepareArgs};
use qaren::commands::prewarm::{prewarm, PrewarmArgs};
use qaren::commands::{cleanup, status};
use qaren::exec::{CmdOutput, MockRunner, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{AdbServerResource, MetroResource, Phase, RunRecord, UsbDeviceResource};
use qaren::scenario::Scenario;
use std::path::{Path, PathBuf};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";
const USB_SERIAL: &str = "R5CT123ABC";

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn usb_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: usb-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nandroid_usb:\n  serial: {USB_SERIAL}\n  adb_server_port: 15039\n"
    )
}

fn write_scenario(repo: &Path, yaml: &str) -> PathBuf {
    let path = repo.join("scenario.yaml");
    std::fs::write(&path, yaml).unwrap();
    path
}

fn args(repo: &Path, scenario_path: &Path, android_home: Option<String>) -> PrepareArgs {
    PrepareArgs {
        scenario_path: scenario_path.to_path_buf(),
        dry_run: false,
        android_home,
        lock_root: repo.join(".locks"),
        native_cache_root: repo.join(".native-store"),
        runs_root: repo.to_path_buf(),
    }
}

fn android_sdk(repo: &Path) -> PathBuf {
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();
    sdk
}

const USB_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "java"];

fn script_validation(mock: &mut MockRunner, repo: &Path, tools: &[&str]) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    for tool in tools {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
}

#[test]
fn usb_prepare_happy_path_claims_device_and_pins_serial() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &usb_scenario_yaml(8794));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, USB_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("adb usb server\n"));
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run(
        &format!("-s {USB_SERIAL} get-state"),
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
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        &format!("-s {USB_SERIAL} shell pm path"),
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        &format!("-s {USB_SERIAL} shell pidof"),
        CmdOutput::success("12345\n"),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &args(
            &repo,
            &scenario_path,
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

    let build = receipt.build.as_ref().expect("build plan in receipt");
    assert_eq!(build.decision, BuildDecision::Clean);
    assert!(build.fingerprint.starts_with("rnfp1:"));

    let device = receipt.device.unwrap();
    assert_eq!(device.usb_serial.as_deref(), Some(USB_SERIAL));
    assert_eq!(
        device.usb_lock_holder.as_deref(),
        Some(format!("qaren-{}", receipt.run_id).as_str())
    );

    // The exclusive claim is held after ready; only cleanup releases it.
    let lock_dir = repo.join(".locks").join(format!("usb-{USB_SERIAL}"));
    let holder = buildplan::read_holder(&lock_dir).expect("device claim held");
    assert_eq!(holder.holder, format!("qaren-{}", receipt.run_id));

    // The build serialization lock is released once the run is ready.
    assert!(!repo.join(".locks").join("native-build-android").exists());

    // Every adb invocation is pinned to the explicit USB serial and routed
    // through the run-scoped one-device server.
    let server = mock
        .calls
        .iter()
        .find(|c| c.label == "adb-usb-server")
        .unwrap();
    let one_device = server
        .args
        .iter()
        .position(|a| a == "--one-device")
        .unwrap();
    assert_eq!(server.args[one_device + 1], USB_SERIAL);
    for call in mock
        .calls
        .iter()
        .filter(|c| c.program.ends_with("/adb") && c.label != "adb-usb-server")
    {
        assert_eq!(call.args.first().map(String::as_str), Some("-s"));
        assert_eq!(call.args.get(1).map(String::as_str), Some(USB_SERIAL));
        assert!(call.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15039".to_string()
        )));
    }
    let build_call = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-android")
        .unwrap();
    assert!(build_call
        .env
        .contains(&("ANDROID_SERIAL".to_string(), USB_SERIAL.to_string())));

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    assert_eq!(
        record.resources.usb_device.as_ref().unwrap().serial,
        USB_SERIAL
    );
    assert!(
        record.resources.farm.is_none(),
        "no farm resources on the USB path"
    );
    assert!(record.resources.tunnel.is_none());
    assert!(record.resources.adb_vendor_key.is_none());

    for key in [
        "validate",
        "deps",
        "plan",
        "allocate",
        "build_and_ready",
        "verify",
        "total",
    ] {
        assert!(
            receipt.timings_ms.contains_key(key),
            "missing phase timing {key}: {:?}",
            receipt.timings_ms
        );
    }
}

#[test]
fn usb_prepare_refuses_contended_device_and_cleanup_stays_ownership_safe() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &usb_scenario_yaml(8794));
    let sdk = android_sdk(&repo);

    // Another claimant already holds the device.
    let lock_dir = repo.join(".locks").join(format!("usb-{USB_SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    std::fs::write(
        lock_dir.join("holder.json"),
        serde_json::json!({
            "holder": "qaren-other-run",
            "run_id": "other-run",
            "at": "2026-08-13T00:00:00Z"
        })
        .to_string(),
    )
    .unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, USB_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &args(
            &repo,
            &scenario_path,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceClaimContended);
    assert!(
        failure.detail.contains("qaren-other-run"),
        "{}",
        failure.detail
    );
    assert_eq!(
        mock.remaining(),
        0,
        "no adb activity may follow a contended claim"
    );
    assert!(
        !mock.calls.iter().any(|c| c.label.starts_with("adb")),
        "the contended device must never be addressed"
    );

    // The foreign claim survives untouched.
    let holder = buildplan::read_holder(&lock_dir).unwrap();
    assert_eq!(holder.holder, "qaren-other-run");

    // Cleanup after the refused run: the foreign device claim proves this run
    // never owned the device (absent), while this run's own build lock is
    // released — interruption leaves nothing dangling.
    let mut cleanup_mock = MockRunner::new();
    let receipt = cleanup::cleanup(&mut cleanup_mock, &repo, &receipt.run_id);
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("usb_device_claim").unwrap(), "absent");
    assert_eq!(receipt.cleanup.get("build_lock").unwrap(), "removed");
    let holder = buildplan::read_holder(&lock_dir).unwrap();
    assert_eq!(
        holder.holder, "qaren-other-run",
        "the foreign claim must survive cleanup"
    );
}

#[test]
fn usb_prepare_refuses_when_device_is_unauthorized() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &usb_scenario_yaml(8794));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, USB_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("adb usb server\n"));
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run(
        &format!("-s {USB_SERIAL} get-state"),
        CmdOutput::failed(1, "error: device unauthorized"),
    );

    let receipt = prepare(
        &mut mock,
        &args(
            &repo,
            &scenario_path,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert!(failure.next_action.contains("cleanup"));
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(
        record.resources.usb_device.is_some(),
        "the claim must stay recorded for cleanup"
    );
}

fn ios_reuse_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: ios-simulator\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: {port}\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n"
    )
}

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";

#[test]
fn missing_workspace_prepare_refuses_before_create_or_dependency_install() {
    for dry_run in [false, true] {
        let repo = common::temp_repo();
        let yaml = format!("{}build:\n  ios_workspace:\n    workspace: ios/Missing.xcworkspace\n    scheme: Native Debug\n", ios_reuse_scenario_yaml(8791));
        let path = write_scenario(&repo, &yaml);
        let mut options = args(&repo, &path, None);
        options.dry_run = dry_run;
        let mut mock = MockRunner::new();
        script_validation(&mut mock, &repo, &[]);
        let receipt = prepare(&mut mock, &options);
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::IosBuildCapabilityUnavailable
        );
        assert_eq!(mock.remaining(), 0);
        assert!(mock.calls.iter().all(|c| c.program == "git"));
        assert!(!options.lock_root.exists());
        assert!(!repo.join(&receipt.run_id).exists());
    }
}

#[test]
fn workspace_dry_run_reports_xcode_only_when_the_bound_cache_cannot_be_reused() {
    let repo = common::temp_repo();
    for workspace in ["ios/First.xcworkspace", "ios/Second.xcworkspace"] {
        common::write_ios_workspace(&repo.join("test-app"), workspace);
    }
    let app_dir = repo.join("cached/testapp.app");
    common::write_ios_app(&app_dir);
    let mut initial_fingerprint = None;
    for (index, (workspace, scheme, reuse)) in [
        ("ios/First.xcworkspace", "Native Debug", false),
        ("ios/First.xcworkspace", "Native Debug", true),
        ("ios/First.xcworkspace", "Other Debug", false),
        ("ios/Second.xcworkspace", "Native Debug", false),
    ]
    .into_iter()
    .enumerate()
    {
        let yaml = format!(
            "{}build:\n  ios_workspace:\n    workspace: {workspace}\n    scheme: {scheme}\n",
            ios_reuse_scenario_yaml(8791)
        );
        let path = write_scenario(&repo, &yaml);
        let mut options = args(&repo, &path, None);
        options.dry_run = true;
        options.runs_root = repo.join("runs");
        let mut mock = MockRunner::new();
        script_validation(
            &mut mock,
            &repo,
            &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"],
        );
        mock.expect_run("lsof", free_port());
        mock.expect_run("ls-files", CmdOutput::success(common::IOS_NATIVE_FILES));
        common::script_xcode(&mut mock);

        let receipt = prepare(&mut mock, &options);

        assert_eq!(
            receipt.result,
            ReceiptResult::Planned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(mock.remaining(), 0);
        assert!(mock.calls.iter().all(|c| matches!(
            c.label.as_str(),
            "git-toplevel"
                | "git-head"
                | "git-dirty"
                | "which"
                | "lsof-port"
                | "git-ls-files"
                | "xcode-version"
        )));
        assert!(mock.spawned_logs.is_empty());
        assert!(!options.lock_root.exists());
        assert!(!options.runs_root.exists());
        let plan = receipt.build.unwrap();
        assert_eq!(plan.decision == BuildDecision::Reuse, reuse);
        let builds: Vec<_> = receipt
            .planned_commands
            .iter()
            .filter(|c| c.contains("xcodebuild"))
            .collect();
        assert_eq!(builds.len(), usize::from(!reuse));
        assert!(!receipt
            .planned_commands
            .iter()
            .any(|c| c.contains("expo run:ios")));
        if let Some(build) = builds.first() {
            assert!(build.contains(workspace));
            assert!(build.contains(&format!("-scheme {scheme}")));
            assert!(!build.contains("CONFIGURATION_BUILD_DIR"));
        }
        if index == 0 {
            initial_fingerprint = Some(plan.fingerprint.clone());
            common::seed_store(
                &options.native_cache_root,
                "ios",
                &plan.fingerprint,
                &app_dir,
                ArtifactKind::AppBundle,
            );
            buildplan::save_json(
                &buildplan::state_path(&repo, "ios", "com.rndevagent.testapp"),
                &NativeCacheState {
                    schema: CACHE_SCHEMA.into(),
                    fingerprint_parts: Default::default(),
                    platform: "ios".into(),
                    app_id: "com.rndevagent.testapp".into(),
                    worktree_root: repo.clone(),
                    fingerprint: plan.fingerprint,
                    built_at: "2026-08-13T00:00:00Z".into(),
                    candidate_sha: "b".repeat(40),
                    lockfile_sha256: "c".repeat(64),
                    generated_native_dirs: vec![],
                    artifact: None,
                },
            )
            .unwrap();
        } else {
            assert_eq!(
                Some(&plan.fingerprint) == initial_fingerprint.as_ref(),
                reuse
            );
        }
    }
}

#[test]
fn ios_reuse_path_installs_cached_client_and_never_compiles() {
    assert_ios_prepare_reuses_cached_client(false);
}

#[test]
fn workspace_prepare_reuses_its_bound_cached_client_without_expo_capability() {
    assert_ios_prepare_reuses_cached_client(true);
}

fn assert_ios_prepare_reuses_cached_client(workspace: bool) {
    let repo = common::temp_repo();
    let mut yaml = ios_reuse_scenario_yaml(8791);
    if workspace {
        common::write_ios_workspace(&repo.join("test-app"), "ios/Native.xcworkspace");
        yaml.push_str("build:\n  ios_workspace:\n    workspace: ios/Native.xcworkspace\n    scheme: Native Debug\n");
    }
    let scenario = common::scenario_from(&yaml);
    let scenario_path = write_scenario(&repo, &yaml);

    // A previous build's verified dev client and cache state.
    let app_dir = repo.join("cached").join("testapp.app");
    common::write_ios_app(&app_dir);
    // The fingerprint the plan phase will compute for this repo.
    let mut fp_mock = MockRunner::new();
    fp_mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut fp_mock);
    let fp = qaren::fingerprint::compute(&mut fp_mock, &repo, &repo.join("test-app"), "ios")
        .unwrap()
        .with_ios_workspace(scenario.build.ios_workspace.as_ref());
    let app_dir = common::seed_store(
        &repo.join(".native-store"),
        "ios",
        &fp.value,
        &app_dir,
        ArtifactKind::AppBundle,
    )
    .path;
    let state = NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: Default::default(),
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: repo.clone(),
        fingerprint: fp.value.clone(),
        built_at: "2026-08-13T00:00:00Z".to_string(),
        candidate_sha: "a".repeat(40),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["ios".to_string()],
        artifact: None,
    };
    buildplan::save_json(
        &buildplan::state_path(&repo, "ios", "com.rndevagent.testapp"),
        &state,
    )
    .unwrap();

    let ios_tools = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ios_tools);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    if workspace {
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    } else {
        common::script_ios_deps(&mut mock);
    }
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    common::script_ios_app_verification(&mut mock);
    mock.expect_spawn(
        "expo start",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo start\n"));
    mock.expect_run("simctl install", CmdOutput::success(""));
    // wait_metro_responding
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    common::script_devmenu_defaults(&mut mock, CmdOutput::success(""));
    mock.expect_run(
        "simctl launch --terminate-running-process",
        CmdOutput::success(""),
    );
    // wait_ready
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

    let receipt = prepare(&mut mock, &args(&repo, &scenario_path, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);

    let build = receipt.build.as_ref().unwrap();
    assert_eq!(build.decision, BuildDecision::Reuse);
    assert_eq!(build.artifact.as_ref().unwrap().path, app_dir);
    // The sha delta is explicit evidence: the binary came from candidate
    // aaaa..., the JS comes from candidate bbbb... via Metro.
    assert!(build
        .evidence
        .iter()
        .any(|e| e.contains(&"a".repeat(40)) && e.contains(&"b".repeat(40))));

    assert!(
        !mock.calls.iter().any(|c| matches!(
            c.label.as_str(),
            "expo-run-ios" | "expo-prebuild" | "xcodebuild-ios"
        )),
        "reuse must never compile"
    );
    let install = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-install")
        .unwrap();
    assert_eq!(install.args[3], app_dir.to_string_lossy());
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
    // The cold manifest is answered once before the dev client asks for it.
    let position = |label: &str| mock.calls.iter().position(|c| c.label == label).unwrap();
    assert!(position("metro-manifest") < position("simctl-launch"));
    let manifest = &mock.calls[position("metro-manifest")];
    assert!(manifest.args.contains(&"expo-platform: ios".to_string()));
    assert_eq!(manifest.args.last().unwrap(), "http://127.0.0.1:8791/");
    for key in [
        "build_and_ready",
        "install_cached",
        "metro_ready",
        "app_launch",
        "ready_probes",
    ] {
        assert!(
            receipt.timings_ms.contains_key(key),
            "missing reuse phase timing {key}: {:?}",
            receipt.timings_ms
        );
    }
}

#[test]
fn tampered_stored_artifact_is_refused_for_reuse_and_left_in_place() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_reuse_scenario_yaml(8791));
    let mut options = args(&repo, &scenario_path, None);
    options.dry_run = true;
    let app_dir = repo.join("cached").join("testapp.app");
    common::write_ios_app(&app_dir);
    let mut fp_mock = MockRunner::new();
    fp_mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut fp_mock);
    let fp =
        qaren::fingerprint::compute(&mut fp_mock, &repo, &repo.join("test-app"), "ios").unwrap();
    let stored = common::seed_store(
        &options.native_cache_root,
        "ios",
        &fp.value,
        &app_dir,
        ArtifactKind::AppBundle,
    );
    std::fs::write(stored.path.join("binary"), b"swapped bits").unwrap();
    let record = stored
        .path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(buildplan::STORE_RECORD);
    let recorded = std::fs::read(&record).unwrap();
    let state = NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: Default::default(),
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: repo.clone(),
        fingerprint: fp.value.clone(),
        built_at: "2026-08-13T00:00:00Z".to_string(),
        candidate_sha: "a".repeat(40),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["ios".to_string()],
        artifact: None,
    };
    buildplan::save_json(
        &buildplan::state_path(&repo, "ios", "com.rndevagent.testapp"),
        &state,
    )
    .unwrap();
    let mut mock = MockRunner::new();
    script_validation(
        &mut mock,
        &repo,
        &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"],
    );
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));
    common::script_xcode(&mut mock);

    let receipt = prepare(&mut mock, &options);

    assert_eq!(
        receipt.result,
        ReceiptResult::Planned,
        "{:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let plan = receipt.build.unwrap();
    assert_eq!(plan.decision, BuildDecision::Incremental, "{}", plan.reason);
    assert!(plan.reason.contains("stale"), "{}", plan.reason);
    assert!(plan.artifact.is_none());
    assert_eq!(std::fs::read(&record).unwrap(), recorded);
    assert_eq!(
        std::fs::read(stored.path.join("binary")).unwrap(),
        b"swapped bits"
    );
}

#[test]
fn prewarm_preserves_the_scenario_launch_scheme_refusal_before_any_command() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &ios_reuse_scenario_yaml(8791).replace("  dev_client_scheme: rndatest\n", ""),
    );
    let mut mock = MockRunner::new();
    let receipt = prewarm(&mut mock, &PrewarmArgs { scenario_path });
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DevClientSchemeRequired
    );
    assert!(mock.calls.is_empty());
}

#[test]
fn prewarm_records_lockfile_binding_and_no_secrets() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deps:\n  registry_auth_env: [PRIVATE_REGISTRY_TOKEN]\n",
            ios_reuse_scenario_yaml(8791)
        ),
    );

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("pnpm fetch", CmdOutput::success(""));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));

    let receipt = prewarm(
        &mut mock,
        &PrewarmArgs {
            scenario_path: scenario_path.clone(),
        },
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Prewarmed,
        "{:?}",
        receipt.failure
    );
    let install = mock
        .calls
        .iter()
        .find(|c| c.label == "pnpm-install")
        .unwrap();
    assert!(install.env.contains(&("CI".to_string(), "1".to_string())));

    assert_eq!(install.registry_auth_env, ["PRIVATE_REGISTRY_TOKEN"]);
    for spec in &mock.calls {
        if spec.label != "pnpm-install" {
            assert!(spec.registry_auth_env.is_empty(), "{}", spec.label);
        }
    }
    let record_path = buildplan::prewarm_path(&repo);
    let raw = std::fs::read_to_string(&record_path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["schema"], PREWARM_SCHEMA);
    let expected_lockfile = qaren::candidate::sha256_hex(b"lockfileVersion: 9\n");
    assert_eq!(value["lockfile_sha256"], expected_lockfile.as_str());
    // Nothing beyond identity + hash + timestamp is persisted.
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        vec![
            "at",
            "lockfile_sha256",
            "project_root",
            "schema",
            "worktree_root"
        ]
    );
}

// qaren's own .qaren/ state (from earlier runs, or written mid-run) must not
// read as drift, whether it changes between the snapshots or exists on only
// one side of the comparison.
#[test]
fn prewarm_ignores_qaren_state_in_the_drift_comparison() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_reuse_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success("?? .qaren/\0"));
    mock.expect_run("pnpm fetch", CmdOutput::success(""));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? .qaren/native-cache/state.json\0"),
    );

    let receipt = prewarm(
        &mut mock,
        &PrewarmArgs {
            scenario_path: scenario_path.clone(),
        },
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Prewarmed,
        "{:?}",
        receipt.failure
    );
}

#[test]
fn prewarm_still_fails_on_drift_outside_qaren_state() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_reuse_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("pnpm fetch", CmdOutput::success(""));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success("?? .qaren/\0?? stray.txt\0"));

    let receipt = prewarm(
        &mut mock,
        &PrewarmArgs {
            scenario_path: scenario_path.clone(),
        },
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn prewarm_accepts_an_existing_handoff_integration_baseline() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        "schema: qaren/1\nname: coop-prewarm\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n",
    );
    std::fs::write(
        repo.join("test-app").join("package.json"),
        r#"{"scripts":{"ios":"node .qaren/integration/rn-session-adapter.cjs ios","android":"node .qaren/integration/rn-session-adapter.cjs android"}}"#,
    )
    .unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success(
            " M test-app/package.json\0?? test-app/.qaren/integration/rn-session-adapter.cjs\0",
        ),
    );
    mock.expect_run("show HEAD:test-app/package.json", CmdOutput::success("{}"));
    common::script_tracked_file_identity(&mut mock, "test-app/package.json", "100644");
    mock.expect_run("pnpm fetch", CmdOutput::success(""));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success(
            " M test-app/package.json\0?? test-app/.qaren/integration/rn-session-adapter.cjs\0",
        ),
    );
    mock.expect_run("show HEAD:test-app/package.json", CmdOutput::success("{}"));
    common::script_tracked_file_identity(&mut mock, "test-app/package.json", "100644");

    let receipt = prewarm(&mut mock, &PrewarmArgs { scenario_path });

    assert_eq!(
        receipt.result,
        ReceiptResult::Prewarmed,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let status_calls: Vec<_> = mock
        .calls
        .iter()
        .filter(|call| call.label == "git-dirty")
        .collect();
    assert_eq!(status_calls.len(), 2);
    assert!(status_calls
        .iter()
        .all(|call| call.args.iter().any(|arg| arg == "--untracked-files=all")));
}

fn require_prewarm_yaml(port: u16) -> String {
    format!(
        "{}deps:\n  policy: require-prewarm\n",
        ios_reuse_scenario_yaml(port)
    )
}

#[test]
fn require_prewarm_without_record_is_a_structured_refusal() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &require_prewarm_yaml(8791));

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &args(&repo, &scenario_path, None));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DepsNotPrewarmed);
    assert!(failure.next_action.contains("prewarm"));
    assert_eq!(mock.remaining(), 0, "no install may be attempted");
    assert!(!repo.join(".qaren").join("runs").exists());
}

#[test]
fn require_prewarm_with_matching_record_installs_offline() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &require_prewarm_yaml(8791));
    let record = qaren::buildplan::DepsPrewarm {
        schema: PREWARM_SCHEMA.to_string(),
        worktree_root: repo.clone(),
        project_root: repo.join("test-app"),
        lockfile_sha256: qaren::candidate::sha256_hex(b"lockfileVersion: 9\n"),
        at: "2026-08-13T00:00:00Z".to_string(),
    };
    buildplan::save_json(&buildplan::prewarm_path(&repo), &record).unwrap();

    let ios_tools = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ios_tools);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run(
        "pnpm install --frozen-lockfile --offline",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "expo run:ios --help",
        CmdOutput::success(common::IOS_BUILD_HELP),
    );
    // End the walk deterministically at the fingerprint step.
    mock.expect_run("ls-files", CmdOutput::failed(128, "boom"));

    let receipt = prepare(&mut mock, &args(&repo, &scenario_path, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let install = mock
        .calls
        .iter()
        .find(|c| c.label == "pnpm-install")
        .unwrap();
    assert!(
        install.args.contains(&"--offline".to_string()),
        "a prewarmed install must be offline: {:?}",
        install.args
    );
}

#[test]
fn explicit_worktree_must_be_a_git_toplevel() {
    let repo = common::temp_repo();
    let worktree = repo.join("external");
    std::fs::create_dir_all(worktree.join("app")).unwrap();
    std::fs::write(worktree.join("app").join("package.json"), "{}").unwrap();
    std::fs::write(
        worktree.join("app").join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();
    let canonical = worktree.canonicalize().unwrap();

    let yaml = format!(
        "schema: qaren/1\nname: external\nplatform: ios\ncandidate:\n  project_root: app\n  app_id: com.example.app\n  revision: HEAD\n  dev_client_scheme: example\n  worktree: {}\nmetro:\n  port: 8791\nios:\n  device_type: iPhone-17-Pro\n  runtime: iOS-26-4\n",
        worktree.display()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();
    scenario.validate().unwrap();

    // The enclosing toplevel is a parent, not the named worktree: refuse.
    let mut mock = MockRunner::new();
    mock.expect_run(
        "git",
        CmdOutput::success(&format!("{}\n", canonical.parent().unwrap().display())),
    );
    let err = qaren::candidate::resolve(&mut mock, &scenario, &repo).unwrap_err();
    assert_eq!(err.code, FailureCode::CandidatePathInvalid);
    assert!(err.detail.contains("not a git toplevel"), "{}", err.detail);

    // The named worktree is its own toplevel: the candidate binds to it.
    let mut mock = MockRunner::new();
    mock.expect_run(
        "git",
        CmdOutput::success(&format!("{}\n", canonical.display())),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    let cand = qaren::candidate::resolve(&mut mock, &scenario, &repo).unwrap();
    assert_eq!(cand.repo_root, canonical);
    assert!(cand.project_root.ends_with("app"));
    // The scenario dir's own repo is never consulted for an explicit worktree.
    assert!(mock
        .calls
        .iter()
        .all(|c| !c.rendered().contains(&repo.display().to_string())
            || c.rendered().contains("external")));
}

fn usb_base_record(repo: &Path, run_id: &str, phase: Phase) -> RunRecord {
    let yaml = usb_scenario_yaml(8794);
    common::base_record(repo, &yaml, run_id, phase)
}

#[test]
fn usb_status_probes_claim_server_and_app() {
    let repo = common::temp_repo();
    let run_id = "usb-android-20260813t120000z";
    let mut record = usb_base_record(&repo, run_id, Phase::Ready);
    let lock_root = repo.join(".locks");
    let holder_name = format!("qaren-{run_id}");
    let mut claim_mock = MockRunner::new();
    assert!(matches!(
        buildplan::claim_lock(
            &mut claim_mock,
            &lock_root,
            &format!("usb-{USB_SERIAL}"),
            &buildplan::LockHolder {
                holder: holder_name.clone(),
                run_id: run_id.to_string(),
                identity: None,
                at: "2026-08-13T00:00:00Z".to_string(),
            },
            buildplan::LockPolicy::Strict,
        ),
        buildplan::LockOutcome::Claimed { .. }
    ));
    record.resources.usb_device = Some(UsbDeviceResource {
        serial: USB_SERIAL.to_string(),
        lock_dir: buildplan::lock_dir(&lock_root, &format!("usb-{USB_SERIAL}")),
        holder: holder_name,
    });
    record.resources.adb_path = Some(repo.join("fake-sdk/platform-tools/adb"));
    record.resources.adb_local_serial = Some(USB_SERIAL.to_string());
    record.resources.adb_server = Some(AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15039,
        log: repo.join("server.log"),
    });
    record.resources.metro = Some(MetroResource {
        port: 8794,
        endpoint: "http://127.0.0.1:8794".to_string(),
        spawned: Spawned {
            pid: 6000,
            pgid: 6000,
        },
        identity: Some(common::identity(6000, LSTART)),
        log: repo.join("metro.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // metro probes
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    // adb server identity
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    // device + app probes
    mock.expect_run(
        &format!("-s {USB_SERIAL} get-state"),
        CmdOutput::success("device\n"),
    );
    mock.expect_run(
        &format!("-s {USB_SERIAL} shell pm path"),
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        &format!("-s {USB_SERIAL} shell pidof"),
        CmdOutput::success("12345\n"),
    );

    let receipt = status::status(&mut mock, &repo, run_id);
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "{:?}",
        receipt.outcomes
    );
    assert_eq!(receipt.outcomes.get("usb_lock_held").unwrap(), "pass");
    assert_eq!(receipt.outcomes.get("adb_server_alive").unwrap(), "pass");
    assert_eq!(receipt.outcomes.get("device_online").unwrap(), "pass");
    assert!(
        receipt.build.is_some(),
        "the build decision must surface in status"
    );
}

#[test]
fn usb_status_with_foreign_claim_never_addresses_the_device() {
    let repo = common::temp_repo();
    let run_id = "usb-android-20260813t120001z";
    let mut record = usb_base_record(&repo, run_id, Phase::Ready);
    let lock_root = repo.join(".locks");
    let lock_dir = buildplan::lock_dir(&lock_root, &format!("usb-{USB_SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    std::fs::write(
        lock_dir.join("holder.json"),
        serde_json::json!({
            "holder": "qaren-other",
            "run_id": "other",
            "at": "2026-08-13T00:00:00Z"
        })
        .to_string(),
    )
    .unwrap();
    record.resources.usb_device = Some(UsbDeviceResource {
        serial: USB_SERIAL.to_string(),
        lock_dir,
        holder: format!("qaren-{run_id}"),
    });
    record.resources.adb_path = Some(repo.join("fake-sdk/platform-tools/adb"));
    record.resources.adb_local_serial = Some(USB_SERIAL.to_string());
    record.resources.metro = Some(MetroResource {
        port: 8794,
        endpoint: "http://127.0.0.1:8794".to_string(),
        spawned: Spawned {
            pid: 6000,
            pgid: 6000,
        },
        identity: Some(common::identity(6000, LSTART)),
        log: repo.join("metro.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    // No adb expectations: the device must never be addressed.

    let receipt = status::status(&mut mock, &repo, run_id);
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("usb_lock_held").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        !mock.calls.iter().any(|c| c.program.ends_with("/adb")),
        "no adb command may run without a proven claim"
    );
}

#[test]
fn scenario_rejects_ambiguous_or_illegal_usb_configs() {
    let cases = [
        // emulator serial forms belong to the farm path
        (
            "android_usb:\n  serial: emulator-5554\n  adb_server_port: 15039\n",
            "physical USB device",
        ),
        // privileged adb server ports are rejected
        (
            "android_usb:\n  serial: SOMESERIAL01\n  adb_server_port: 80\n",
            ">= 1024",
        ),
        // both adapters at once is ambiguous
        (
            "android:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\nandroid_usb:\n  serial: R5CT123ABC\n  adb_server_port: 15039\n",
            "exactly one",
        ),
    ];
    for (section, expected) in cases {
        let yaml = format!(
            "schema: qaren/1\nname: usb-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: 8794\n{section}"
        );
        let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();
        let err = scenario.validate().unwrap_err();
        assert!(
            err.detail.contains(expected),
            "expected {expected:?} in {}",
            err.detail
        );
    }
    let colon_serial = "schema: qaren/1\nname: usb-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: 8794\nandroid_usb:\n  serial: \"127.0.0.1:5555\"\n  adb_server_port: 15039\n";
    let scenario: Scenario = serde_yaml::from_str(colon_serial).unwrap();
    let err = scenario.validate().unwrap_err();
    // The colon form fails the serial grammar itself.
    assert!(err.detail.contains("USB device serial"), "{}", err.detail);
}

// The build/metro process group drives adb with this run's server socket and
// serial, so an unresolvable group must hold the exclusive device claim just
// like a surviving reverse mapping or adb server does.
#[test]
fn usb_claim_is_retained_while_the_build_process_group_is_unresolved() {
    let repo = common::temp_repo();
    let scenario_yaml = usb_scenario_yaml(8795);
    std::fs::write(repo.join("scenario.yaml"), &scenario_yaml).unwrap();

    let lock_dir = repo.join(".locks").join(format!("usb-{USB_SERIAL}"));
    std::fs::create_dir_all(&lock_dir).unwrap();
    buildplan::save_json(
        &lock_dir.join("holder.json"),
        &buildplan::LockHolder {
            holder: "qaren-usbrun1".to_string(),
            run_id: "usbrun1".to_string(),
            identity: None,
            at: "2026-08-12T16:00:00Z".to_string(),
        },
    )
    .unwrap();

    let mut record = common::base_record(&repo, &scenario_yaml, "usbrun1", Phase::Ready);
    record.resources.metro = Some(MetroResource {
        port: 8795,
        endpoint: "http://127.0.0.1:8795".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record.resources.usb_device = Some(UsbDeviceResource {
        serial: USB_SERIAL.to_string(),
        lock_dir: lock_dir.clone(),
        holder: "qaren-usbrun1".to_string(),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // metro group: leader alive+matching, port owned by the group -> TERM,
    // KILL, and the leader is still alive afterwards.
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lstart=", CmdOutput::success(LSTART));
    mock.expect_run("stat=", CmdOutput::success("S"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = cleanup::cleanup(&mut mock, &repo, "usbrun1");
    assert_eq!(mock.remaining(), 0);
    assert!(
        receipt
            .cleanup
            .get("metro")
            .unwrap()
            .starts_with("unresolved"),
        "{:?}",
        receipt.cleanup
    );
    assert!(
        receipt
            .cleanup
            .get("usb_device_claim")
            .unwrap()
            .starts_with("refused"),
        "the claim must be retained while the build group can still reach the device: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let holder = buildplan::read_holder(&lock_dir).unwrap();
    assert_eq!(holder.run_id, "usbrun1", "the claim must survive");
    assert_eq!(
        RunRecord::load(&repo, "usbrun1").unwrap().phase,
        Phase::Ready,
        "an unreleased claim is not a cleaned run"
    );
}

// A registry auth failure lands verbatim in a durable, agent-consumed receipt
// unless prepare redacts it the way prewarm already does.
#[test]
fn deps_install_failure_detail_never_carries_registry_credentials() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &ios_reuse_scenario_yaml(8796));

    let ios_tools = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ios_tools);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren prepare\n"));
    mock.expect_run(
        "pnpm install --frozen-lockfile",
        CmdOutput::failed(
            1,
            "ERR_PNPM_FETCH_401 GET https://ci:hunter2@registry.example.com/pkg\n//registry.example.com/:_authToken=npm_abcdefghijklmnopqrstuvwx123456789012\n",
        ),
    );

    let receipt = prepare(&mut mock, &args(&repo, &scenario_path, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DepsInstallFailed);
    assert!(!failure.detail.contains("hunter2"), "{}", failure.detail);
    assert!(
        !failure
            .detail
            .contains("npm_abcdefghijklmnopqrstuvwx123456789012"),
        "{}",
        failure.detail
    );
    assert!(
        failure.detail.contains("ERR_PNPM_FETCH_401"),
        "the diagnostic itself must survive: {}",
        failure.detail
    );

    // The durable record carries the same redacted detail, not the raw output.
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    let recorded = record.failure.as_ref().unwrap();
    assert!(!recorded.detail.contains("hunter2"), "{}", recorded.detail);
}

fn android_reuse_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: nuc-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\n  dev_client_scheme: rndatest\nmetro:\n  port: {port}\nandroid:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\n"
    )
}

#[test]
fn android_reuse_path_records_install_provenance_after_a_successful_adb_install() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &android_reuse_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let apk = repo.join("cached").join("app-debug.apk");
    std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
    std::fs::write(&apk, b"apk bits").unwrap();
    let artifact_sha = buildplan::hash_artifact(&apk).unwrap();
    let mut fp_mock = MockRunner::new();
    fp_mock.expect_run("ls-files", CmdOutput::success(""));
    let fp = qaren::fingerprint::compute(&mut fp_mock, &repo, &repo.join("test-app"), "android")
        .unwrap();
    let state = NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        fingerprint_parts: Default::default(),
        platform: "android".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: repo.clone(),
        fingerprint: fp.value.clone(),
        built_at: "2026-08-13T00:00:00Z".to_string(),
        candidate_sha: "a".repeat(40),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["android".to_string()],
        artifact: Some(CachedArtifact {
            path: apk.clone(),
            sha256: artifact_sha.clone(),
            kind: ArtifactKind::Apk,
        }),
    };
    buildplan::save_json(
        &buildplan::state_path(&repo, "android", "com.rndevagent.testapp"),
        &state,
    )
    .unwrap();

    let android_tools = &["git", "pnpm", "node", "lsof", "curl", "ps", "ssh", "java"];
    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, android_tools);
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
    mock.expect_run(
        "-s 127.0.0.1:5555 install -r -d",
        CmdOutput::success("Performing Streamed Install\nSuccess\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 reverse tcp:8792 tcp:8792",
        CmdOutput::success(""),
    );
    mock.expect_spawn(
        "expo start",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo start\n"));
    // wait_metro_responding
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("qaren-request-probe", CmdOutput::success(""));
    mock.expect_run("expo-platform", CmdOutput::success(""));
    mock.expect_run("am start", CmdOutput::success("Starting: Intent\n"));
    // wait_ready
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
        &args(
            &repo,
            &scenario_path,
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
    assert_eq!(
        receipt.build.as_ref().unwrap().decision,
        BuildDecision::Reuse
    );

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    let install = record.resources.app_install.as_ref().unwrap();
    assert_eq!(install.via, "adb-install");
    assert_eq!(install.serial, "127.0.0.1:5555");
    assert_eq!(install.server_port, 15037);
    assert_eq!(install.artifact.path, apk);
    assert_eq!(install.artifact.sha256, artifact_sha);
    assert!(install.removal.is_none());
}

#[test]
fn configured_registry_auth_does_not_extend_prewarm_fetch() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(
        &repo,
        &format!(
            "{}deps:\n  registry_auth_env: [PRIVATE_REGISTRY_TOKEN]\n",
            ios_reuse_scenario_yaml(8791)
        ),
    );
    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run(
        "pnpm fetch",
        CmdOutput::failed(1, "synthetic registry refusal"),
    );
    let receipt = prewarm(&mut mock, &PrewarmArgs { scenario_path });
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DepsInstallFailed
    );
    assert_eq!(mock.remaining(), 0);
    assert!(mock
        .calls
        .iter()
        .all(|spec| spec.registry_auth_env.is_empty()));
    assert!(!mock.calls.iter().any(|spec| spec.label == "pnpm-install"));
}
